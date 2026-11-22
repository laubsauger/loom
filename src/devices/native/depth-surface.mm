#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#include <stdexcept>
#include <string>
#include <memory>
#include <thread>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <vector>
#include "depth-surface.h"

// T1818b: Depth Pro 2 on Core ML, the provider behind the shared XPC serve loop.
// Built with -mmacosx-version-min=15.0 (MLState, functionName): the build is
// skipped on older systems and the probe says why. Pixels stay on the GPU: the
// packed capture is unpacked into Core ML's input planes, and the model's output
// backing is expanded into the result, by Metal kernels on IOSurfaces.
namespace {
thread_local std::string failure;
const char *const FUNCTIONS[] = {"res_640x360", "res_854x480", "res_896x512", "res_1138x640", "res_1280x720"};
struct Session {
  const std::thread::id owner = std::this_thread::get_id();
  uint32_t width = 0, height = 0;
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLComputePipelineState> planes;
  id<MTLComputePipelineState> expand;
  id<MTLBuffer> table;
  id<MTLBuffer> count;
  id<MTLBuffer> columns;
  id<MTLBuffer> rows;
  uint32_t columnsFor = 0, rowsFor = 0;
  MLModel *model;
  MLState *state;
  MLMultiArray *inverseArray;
  id<MLFeatureProvider> features;
  MLPredictionOptions *options;
  id<MTLTexture> frameTexture;
  id<MTLTexture> inverseTexture;
  CVPixelBufferRef frame = nullptr, inverse = nullptr;
  IOSurfaceRef output = nullptr;
  ~Session() {
    if (output) CFRelease(output);
    if (frame) CFRelease(frame);
    if (inverse) CFRelease(inverse);
  }
};
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
void require(bool ok, const std::string &message) { if (!ok) throw std::runtime_error(message); }
std::string described(NSError *error, const char *fallback) {
  return error ? std::string(fallback) + ": " + error.localizedDescription.UTF8String : std::string(fallback);
}
Session &session(void *value) {
  require(value != nullptr, "Missing Depth session");
  auto &s = *static_cast<Session *>(value);
  require(s.owner == std::this_thread::get_id(), "Depth session belongs to another thread");
  return s;
}
CVPixelBufferRef halfPlane(size_t width, size_t height) {
  CVPixelBufferRef buffer = nullptr;
  NSDictionary *attributes = @{(id)kCVPixelBufferIOSurfacePropertiesKey: @{}, (id)kCVPixelBufferMetalCompatibilityKey: @YES};
  require(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_OneComponent16Half,
    (__bridge CFDictionaryRef)attributes, &buffer) == kCVReturnSuccess && buffer, "Cannot allocate Depth model plane");
  return buffer;
}
id<MTLTexture> planeTexture(id<MTLDevice> device, CVPixelBufferRef buffer, MTLTextureUsage usage) {
  auto descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR16Float
    width:CVPixelBufferGetWidth(buffer) height:CVPixelBufferGetHeight(buffer) mipmapped:NO];
  descriptor.usage = usage;
  return [device newTextureWithDescriptor:descriptor iosurface:CVPixelBufferGetIOSurface(buffer) plane:0];
}
bool shaped(MLFeatureDescription *feature, NSArray<NSNumber *> *shape) {
  return feature && feature.type == MLFeatureTypeMultiArray &&
    feature.multiArrayConstraint.dataType == MLMultiArrayDataTypeFloat16 && [feature.multiArrayConstraint.shape isEqualToArray:shape];
}
// The browser path's occOf + depthPro2ToInverse sampling (src/runtime/models/depth-runner.ts),
// in the same double arithmetic, so a source texel index never differs by a rounding.
std::vector<uint32_t> nearest(uint32_t output, uint32_t input, double occupied) {
#pragma clang fp contract(off)
  std::vector<uint32_t> indices(output);
  for (uint32_t i = 0; i < output; i++) {
    const double u = ((i + 0.5) / output - 0.5) * occupied + 0.5;
    indices[i] = (uint32_t)std::min<double>(input - 1, std::max<double>(0, std::floor(u * input)));
  }
  return indices;
}
void sampling(Session &s, uint32_t outputWidth, uint32_t outputHeight) {
  if (s.columnsFor == outputWidth && s.rowsFor == outputHeight) return;
  const double aspect = double(outputWidth) / std::max<double>(outputHeight, 1), box = double(s.width) / s.height;
  const double occX = aspect >= box ? 1 : aspect / box, occY = aspect >= box ? box / aspect : 1;
  const auto columns = nearest(outputWidth, s.width, occX), rows = nearest(outputHeight, s.height, occY);
  s.columns = [s.device newBufferWithBytes:columns.data() length:columns.size() * 4 options:MTLResourceStorageModeShared];
  s.rows = [s.device newBufferWithBytes:rows.data() length:rows.size() * 4 options:MTLResourceStorageModeShared];
  require(s.columns != nil && s.rows != nil, "Cannot allocate Depth sampling tables");
  s.columnsFor = outputWidth; s.rowsFor = outputHeight;
}
void finish(id<MTLCommandBuffer> commands, const char *message) {
  [commands commit]; [commands waitUntilCompleted];
  require(commands.status == MTLCommandBufferStatusCompleted, message);
}
}

extern "C" const char *loom_depth_error() { return failure.c_str(); }

extern "C" void *loom_depth_create(const char *compiledPath, const char *functionName) {
  @autoreleasepool {
    try {
      failure.clear();
      require(compiledPath && compiledPath[0] == '/' && functionName, "Depth model requires an absolute compiled model path");
      const auto known = std::find_if(std::begin(FUNCTIONS), std::end(FUNCTIONS),
        [&](const char *name) { return strcmp(name, functionName) == 0; });
      require(known != std::end(FUNCTIONS), "Unknown Depth Pro 2 function");
      auto s = std::make_unique<Session>();
      require(sscanf(functionName, "res_%ux%u", &s->width, &s->height) == 2, "Unreadable Depth Pro 2 function size");
      const uint32_t W = s->width, H = s->height;
      auto configuration = [MLModelConfiguration new];
      // Measured fastest for Depth Pro 2 (T1818b); the Neural Engine refuses functionName.
      configuration.computeUnits = MLComputeUnitsCPUAndGPU;
      configuration.functionName = @(functionName);
      NSError *error = nil;
      s->model = [MLModel modelWithContentsOfURL:[NSURL fileURLWithPath:@(compiledPath) isDirectory:YES]
        configuration:configuration error:&error];
      require(s->model != nil, described(error, "Cannot load the compiled Depth Pro 2 model"));
      auto description = s->model.modelDescription;
      require(shaped(description.inputDescriptionsByName[@"frame"], @[@1, @3, @(H), @(W)]) &&
        shaped(description.outputDescriptionsByName[@"inverse_depth"], @[@1, @(H), @(W)]),
        "Depth Pro 2 model does not declare float16 frame (1,3,H,W) and inverse_depth (1,H,W)");
      require(description.stateDescriptionsByName.count > 0, "Depth Pro 2 model has no stream state");
      s->state = [s->model newState];
      s->device = MTLCreateSystemDefaultDevice();
      require(s->device != nil, "Depth surface provider requires Metal");
      s->queue = [s->device newCommandQueue];
      NSString *source = @"#include <metal_stdlib>\nusing namespace metal;\n"
        "float channel(texture2d<float, access::read> src, uint index) {"
        "uint pixel=index/3; return src.read(uint2(pixel%src.get_width(),pixel/src.get_width()))[index%3];}"
        "kernel void planes(texture2d<float,access::read> src [[texture(0)]],texture2d<half,access::write> out [[texture(1)]],"
        "constant half *table [[buffer(0)]],constant uint2 &size [[buffer(1)]],uint2 p [[thread_position_in_grid]]) {"
        "if(p.x>=size.x||p.y>=size.y)return;uint i=(p.y*size.x+p.x)*4;"
        "for(uint c=0;c<3;c++){uint byte=min(uint(rint(channel(src,i+c)*255.0)),255u);"
        "out.write(half4(table[byte]),uint2(p.x,p.y+c*size.y));}}"
        "kernel void expand(texture2d<half,access::read> inverse [[texture(0)]],texture2d<half,access::write> out [[texture(1)]],"
        "constant uint *columns [[buffer(0)]],constant uint *rows [[buffer(1)]],device atomic_uint &count [[buffer(2)]],"
        "uint2 p [[thread_position_in_grid]],uint local [[thread_index_in_threadgroup]]) {"
        "threadgroup atomic_uint hits;if(local==0)atomic_store_explicit(&hits,0,memory_order_relaxed);"
        "threadgroup_barrier(mem_flags::mem_threadgroup);"
        "if(p.x<out.get_width()&&p.y<out.get_height()){half v=inverse.read(uint2(columns[p.x],rows[p.y])).r;"
        "if(!isfinite(v)||!(v>0.0h))v=0.0h;out.write(half4(v,0.0h,0.0h,1.0h),p);"
        "if(v>0.0h)atomic_fetch_add_explicit(&hits,1,memory_order_relaxed);}"
        "threadgroup_barrier(mem_flags::mem_threadgroup);"
        "if(local==0)atomic_fetch_add_explicit(&count,atomic_load_explicit(&hits,memory_order_relaxed),memory_order_relaxed);}";
      // Safe math: fast math may assume finite values and fold the sky/NaN guard away.
      auto options = [MTLCompileOptions new];
      options.mathMode = MTLMathModeSafe;
      id<MTLLibrary> library = [s->device newLibraryWithSource:source options:options error:&error];
      require(library != nil, described(error, "Cannot compile Depth packing shaders"));
      s->planes = [s->device newComputePipelineStateWithFunction:[library newFunctionWithName:@"planes"] error:&error];
      s->expand = [s->device newComputePipelineStateWithFunction:[library newFunctionWithName:@"expand"] error:&error];
      // bytes/255 as float16, rounded once from the exact quotient, not via float32.
      _Float16 table[256];
      for (int byte = 0; byte < 256; byte++) table[byte] = (_Float16)(byte / 255.0);
      s->table = [s->device newBufferWithBytes:table length:sizeof(table) options:MTLResourceStorageModeShared];
      s->count = [s->device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
      require(s->planes != nil && s->expand != nil && s->queue != nil && s->table != nil && s->count != nil,
        "Cannot initialize Depth packing pipeline");
      // Core ML reads its input from, and writes its output into, IOSurfaces the kernels address.
      s->frame = halfPlane(W, 3 * H);
      s->inverse = halfPlane(W, H);
      auto frameArray = [[MLMultiArray alloc] initWithPixelBuffer:s->frame shape:@[@1, @3, @(H), @(W)]];
      s->inverseArray = [[MLMultiArray alloc] initWithPixelBuffer:s->inverse shape:@[@1, @(H), @(W)]];
      s->features = [[MLDictionaryFeatureProvider alloc] initWithDictionary:@{
        @"frame": [MLFeatureValue featureValueWithMultiArray:frameArray]} error:&error];
      require(frameArray != nil && s->inverseArray != nil && s->features != nil, described(error, "Cannot bind Depth model planes"));
      s->options = [MLPredictionOptions new];
      s->options.outputBackings = @{@"inverse_depth": s->inverseArray};
      s->frameTexture = planeTexture(s->device, s->frame, MTLTextureUsageShaderWrite);
      s->inverseTexture = planeTexture(s->device, s->inverse, MTLTextureUsageShaderRead);
      require(s->frameTexture != nil && s->inverseTexture != nil, "Cannot bind Depth model planes as Metal textures");
      return s.release();
    } catch (const std::exception &error) { failure = error.what(); return nullptr; }
  }
}

extern "C" void *loom_depth_infer_packed(void *value, void *input, uint32_t width, uint32_t height,
                                        uint32_t outputWidth, uint32_t outputHeight) {
  @autoreleasepool {
    bool preparing = false;
    try {
      failure.clear(); auto &s = session(value);
      require(!s.output, "Release the outstanding Depth result before inference");
      require(input && outputWidth && outputHeight && outputWidth <= 8192 && outputHeight <= 8192, "Invalid packed Depth dimensions");
      require(width == s.width && height == s.height, "Depth input must be the model function's own size");
      auto source = static_cast<IOSurfaceRef>(input);
      require(IOSurfaceGetWidth(source) == width && IOSurfaceGetHeight(source) == (height * 4 + 2) / 3 &&
        IOSurfaceGetPixelFormat(source) == kCVPixelFormatType_32BGRA && !IOSurfaceGetPlaneCount(source), "Invalid packed Depth surface");
      auto readDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:width height:IOSurfaceGetHeight(source) mipmapped:NO]; readDesc.usage = MTLTextureUsageShaderRead;
      auto read = [s.device newTextureWithDescriptor:readDesc iosurface:source plane:0];
      require(read != nil, "Cannot bind packed Depth input");
      auto commands = [s.queue commandBuffer]; auto encoder = [commands computeCommandEncoder];
      require(commands && encoder, "Cannot encode Depth input unpacking");
      const uint32_t size[2] = {width, height};
      [encoder setComputePipelineState:s.planes]; [encoder setTexture:read atIndex:0]; [encoder setTexture:s.frameTexture atIndex:1];
      [encoder setBuffer:s.table offset:0 atIndex:0]; [encoder setBytes:size length:sizeof(size) atIndex:1];
      [encoder dispatchThreads:MTLSizeMake(width, height, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
      [encoder endEncoding];
      finish(commands, "Depth input unpacking GPU command failed");
      NSError *error = nil;
      id<MLFeatureProvider> prediction = [s.model predictionFromFeatures:s.features usingState:s.state options:s.options error:&error];
      require(prediction != nil, described(error, "Depth Pro 2 inference failed"));
      // A copy into some other array would leave the expansion reading a stale plane.
      require([prediction featureValueForName:@"inverse_depth"].multiArrayValue.pixelBuffer == s.inverse,
        "Core ML did not write inverse_depth into its GPU backing");
      sampling(s, outputWidth, outputHeight);
      preparing = true;
      s.output = IOSurfaceCreate((__bridge CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(outputWidth), (id)kIOSurfaceHeight: @(outputHeight),
        (id)kIOSurfaceBytesPerElement: @8,
        (id)kIOSurfaceBytesPerRow: @(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, outputWidth * 8)),
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_64RGBAHalf)
      });
      require(s.output != nullptr, "Cannot allocate Depth result IOSurface");
      auto writeDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float
        width:outputWidth height:outputHeight mipmapped:NO];
      writeDesc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
      id<MTLTexture> write = [s.device newTextureWithDescriptor:writeDesc iosurface:s.output plane:0];
      require(write != nil, "Cannot bind Depth result as a Metal texture");
      commands = [s.queue commandBuffer]; encoder = [commands computeCommandEncoder];
      require(commands && encoder, "Cannot encode Depth result expansion");
      // Four-byte telemetry scalar only; image data never enters CPU memory.
      *static_cast<uint32_t *>(s.count.contents) = 0;
      [encoder setComputePipelineState:s.expand]; [encoder setTexture:s.inverseTexture atIndex:0]; [encoder setTexture:write atIndex:1];
      [encoder setBuffer:s.columns offset:0 atIndex:0]; [encoder setBuffer:s.rows offset:0 atIndex:1];
      [encoder setBuffer:s.count offset:0 atIndex:2];
      [encoder dispatchThreads:MTLSizeMake(outputWidth, outputHeight, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
      [encoder endEncoding];
      finish(commands, "Depth result expansion GPU command failed");
      return s.output;
    } catch (const std::exception &error) {
      if (preparing) { auto &s = session(value); if (s.output) { CFRelease(s.output); s.output = nullptr; } }
      failure = error.what(); return nullptr;
    }
  }
}

extern "C" double loom_depth_coverage(void *value) {
  try {
    auto &s = session(value); require(s.output != nullptr, "No Depth result for coverage");
    return double(*static_cast<uint32_t *>(s.count.contents)) / (double(IOSurfaceGetWidth(s.output)) * IOSurfaceGetHeight(s.output));
  } catch (const std::exception &error) { failure = error.what(); return -1; }
}
extern "C" int loom_depth_release(void *value) {
  try {
    failure.clear(); auto &s = session(value);
    require(s.output != nullptr, "No Depth result to release");
    CFRelease(s.output); s.output = nullptr; return 0;
  } catch (const std::exception &error) { failure = error.what(); return -1; }
}
extern "C" int loom_depth_reset(void *value) {
  @autoreleasepool {
    try {
      failure.clear(); auto &s = session(value);
      require(s.output == nullptr, "Release Depth result before temporal reset");
      s.state = [s.model newState]; return 0;
    } catch (const std::exception &error) { failure = error.what(); return -1; }
  }
}
extern "C" int loom_depth_destroy(void *value) {
  try {
    failure.clear(); auto &s = session(value);
    require(s.output == nullptr, "Release Depth result before destruction");
    delete &s; return 0;
  } catch (const std::exception &error) { failure = error.what(); return -1; }
}
