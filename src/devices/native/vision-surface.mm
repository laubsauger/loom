#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#include <stdexcept>
#include <string>
#include <memory>
#include <thread>
#include <cmath>
#include <algorithm>
#include "vision-surface.h"

namespace {
thread_local std::string failure;
struct Session {
  const std::thread::id owner = std::this_thread::get_id();
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLComputePipelineState> pack;
  id<MTLComputePipelineState> unpack;
  id<MTLBuffer> count;
  VNGeneratePersonSegmentationRequest *request;
  IOSurfaceRef output = nullptr;
  CVPixelBufferRef mask = nullptr;
  ~Session() {
    if (output) CFRelease(output);
    if (mask) CFRelease(mask);
  }
};
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
VNGeneratePersonSegmentationRequest *newRequest() {
  auto request = [[VNGeneratePersonSegmentationRequest alloc] init];
  request.revision = VNGeneratePersonSegmentationRequestRevision1;
  request.qualityLevel = VNGeneratePersonSegmentationRequestQualityLevelBalanced;
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8;
  return request;
}
Session &session(void *value) {
  require(value != nullptr, "Missing Vision session");
  auto &s = *static_cast<Session *>(value);
  require(s.owner == std::this_thread::get_id(), "Vision session belongs to another thread");
  return s;
}
void clearResult(Session &s) {
  if (s.output) { CFRelease(s.output); s.output = nullptr; }
  if (s.mask) { CFRelease(s.mask); s.mask = nullptr; }
}
}

extern "C" const char *loom_vision_error() { return failure.c_str(); }

extern "C" void *loom_vision_create() {
  @autoreleasepool {
    try {
      failure.clear();
      auto s = std::make_unique<Session>();
      s->device = MTLCreateSystemDefaultDevice();
      require(s->device != nil, "Vision surface provider requires Metal");
      s->queue = [s->device newCommandQueue];
      NSError *error = nil;
      NSString *source = @"#include <metal_stdlib>\nusing namespace metal;\n"
        "float channel(texture2d<float, access::read> src, uint index) {"
        "uint pixel=index/3; return src.read(uint2(pixel%src.get_width(),pixel/src.get_width()))[index%3];}"
        "kernel void unpack(texture2d<float,access::read> src [[texture(0)]],"
        "texture2d<float,access::write> out [[texture(1)]],uint2 p [[thread_position_in_grid]]) {"
        "if(p.x>=out.get_width()||p.y>=out.get_height())return;uint i=(p.y*out.get_width()+p.x)*4;"
        "out.write(float4(channel(src,i),channel(src,i+1),channel(src,i+2),channel(src,i+3)),p);}"
        "kernel void pack(texture2d<float, access::read> mask [[texture(0)]],"
        "texture2d<half, access::write> out [[texture(1)]],constant uint4 &band [[buffer(0)]],"
        "device atomic_uint &count [[buffer(1)]], uint2 p [[thread_position_in_grid]],uint local [[thread_index_in_threadgroup]]) {"
        "threadgroup atomic_uint hits;if(local==0)atomic_store_explicit(&hits,0,memory_order_relaxed);"
        "threadgroup_barrier(mem_flags::mem_threadgroup);"
        "if(p.x<out.get_width() && p.y<out.get_height()) {"
        "uint2 q=band.zw+p*band.xy/uint2(out.get_width(),out.get_height());"
        "float value=mask.read(q).r;half v=half(value);out.write(half4(v,v,v,1),p);"
        "if(value>0.5)atomic_fetch_add_explicit(&hits,1,memory_order_relaxed);}"
        "threadgroup_barrier(mem_flags::mem_threadgroup);"
        "if(local==0)atomic_fetch_add_explicit(&count,atomic_load_explicit(&hits,memory_order_relaxed),memory_order_relaxed);}";
      id<MTLLibrary> library = [s->device newLibraryWithSource:source options:nil error:&error];
      require(library != nil, error ? error.localizedDescription.UTF8String : "Cannot compile mask packing shader");
      s->pack = [s->device newComputePipelineStateWithFunction:[library newFunctionWithName:@"pack"] error:&error];
      s->unpack = [s->device newComputePipelineStateWithFunction:[library newFunctionWithName:@"unpack"] error:&error];
      s->count = [s->device newBufferWithLength:sizeof(uint32_t) options:MTLResourceStorageModeShared];
      require(s->pack != nil && s->unpack != nil && s->queue != nil && s->count != nil, "Cannot initialize mask packing pipeline");
      s->request = newRequest();
      return s.release();
    } catch (const std::exception &error) { failure = error.what(); return nullptr; }
  }
}

static void *infer(void *value, void *input, uint32_t outputWidth, uint32_t outputHeight) {
  @autoreleasepool {
    CVPixelBufferRef buffer = nullptr;
    bool preparing = false;
    try {
      failure.clear();
      auto &s = session(value);
      require(s.output == nullptr, "Release the outstanding Vision result before inference");
      require(input != nullptr, "Missing input IOSurface");
      auto source = static_cast<IOSurfaceRef>(input);
      require(IOSurfaceGetPixelFormat(source) == kCVPixelFormatType_32BGRA && IOSurfaceGetPlaneCount(source) == 0,
        "Vision input must be non-planar BGRA8");
      const size_t width = IOSurfaceGetWidth(source), height = IOSurfaceGetHeight(source);
      require(width > 0 && height > 0 && width <= 8192 && height <= 8192, "Unsupported Vision input dimensions");
      require(CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, source, nullptr, &buffer) == kCVReturnSuccess,
        "Cannot wrap input IOSurface as CVPixelBuffer");
      auto handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:buffer options:@{}];
      NSError *error = nil;
      const bool performed = [handler performRequests:@[s.request] error:&error];
      require(performed, error ? error.localizedDescription.UTF8String : "Vision inference failed");
      CVPixelBufferRelease(buffer); buffer = nullptr;
      CVPixelBufferRef mask = s.request.results.firstObject.pixelBuffer;
      require(mask != nullptr && CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8,
        "Vision returned no supported person mask");
      IOSurfaceRef maskSurface = CVPixelBufferGetIOSurface(mask);
      require(maskSurface != nullptr, "Vision mask has no IOSurface; CPU upload is not permitted on this path");
      const size_t w = CVPixelBufferGetWidth(mask), h = CVPixelBufferGetHeight(mask);
      require(w > 0 && h > 0 && w <= 8192 && h <= 8192, "Invalid Vision mask dimensions");
      preparing = true;
      s.mask = CVPixelBufferRetain(mask);
      const size_t ow = outputWidth ? outputWidth : w, oh = outputHeight ? outputHeight : h;
      uint32_t band[4] = {(uint32_t)w, (uint32_t)h, 0, 0};
      if (outputWidth) {
        const double aspect = double(ow) / oh;
        if (aspect > double(w) / h) band[1] = std::max(1u, (uint32_t)std::round(w / aspect));
        else if (aspect < double(w) / h) band[0] = std::max(1u, (uint32_t)std::round(h * aspect));
        band[2] = (w - band[0]) / 2; band[3] = (h - band[1]) / 2;
      }
      s.output = IOSurfaceCreate((__bridge CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(ow), (id)kIOSurfaceHeight: @(oh),
        (id)kIOSurfaceBytesPerElement: @8,
        (id)kIOSurfaceBytesPerRow: @(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, ow * 8)),
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_64RGBAHalf)
      });
      require(s.output != nullptr, "Cannot allocate Vision result IOSurface");
      auto readDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR8Unorm width:w height:h mipmapped:NO];
      readDesc.usage = MTLTextureUsageShaderRead;
      auto writeDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA16Float width:ow height:oh mipmapped:NO];
      writeDesc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
      id<MTLTexture> read = [s.device newTextureWithDescriptor:readDesc iosurface:maskSurface plane:0];
      id<MTLTexture> write = [s.device newTextureWithDescriptor:writeDesc iosurface:s.output plane:0];
      require(read != nil && write != nil, "Cannot bind Vision mask/result as Metal textures");
      auto commands = [s.queue commandBuffer];
      auto encoder = [commands computeCommandEncoder];
      require(commands != nil && encoder != nil, "Cannot encode Vision mask packing");
      // Four-byte telemetry scalar only; image data never enters CPU memory.
      *static_cast<uint32_t *>(s.count.contents) = 0;
      [encoder setComputePipelineState:s.pack]; [encoder setTexture:read atIndex:0]; [encoder setTexture:write atIndex:1];
      [encoder setBytes:band length:sizeof(band) atIndex:0]; [encoder setBuffer:s.count offset:0 atIndex:1];
      [encoder dispatchThreads:MTLSizeMake(ow, oh, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
      [encoder endEncoding]; [commands commit]; [commands waitUntilCompleted];
      require(commands.status == MTLCommandBufferStatusCompleted, "Vision mask packing GPU command failed");
      return s.output;
    } catch (const std::exception &error) {
      if (buffer) CVPixelBufferRelease(buffer);
      if (preparing) clearResult(session(value));
      failure = error.what(); return nullptr;
    }
  }
}

extern "C" void *loom_vision_infer(void *value, void *input) { return infer(value, input, 0, 0); }
extern "C" double loom_vision_coverage(void *value) {
  try {
    auto &s = session(value); require(s.output != nullptr, "No Vision result for coverage");
    return double(*static_cast<uint32_t *>(s.count.contents)) / (IOSurfaceGetWidth(s.output) * IOSurfaceGetHeight(s.output));
  } catch (const std::exception &error) { failure = error.what(); return -1; }
}
extern "C" void *loom_vision_infer_packed(void *value, void *input, uint32_t width, uint32_t height,
                                         uint32_t outputWidth, uint32_t outputHeight) {
  @autoreleasepool {
    IOSurfaceRef decoded = nullptr;
    try {
      failure.clear(); auto &s = session(value);
      require(!s.output, "Release the outstanding Vision result before inference");
      require(input && width && height && outputWidth && outputHeight && width <= 8192 && height <= 8192 &&
        outputWidth <= 8192 && outputHeight <= 8192, "Invalid packed Vision dimensions");
      auto source = static_cast<IOSurfaceRef>(input);
      require(IOSurfaceGetWidth(source) == width && IOSurfaceGetHeight(source) == (height * 4 + 2) / 3 &&
        IOSurfaceGetPixelFormat(source) == kCVPixelFormatType_32BGRA && !IOSurfaceGetPlaneCount(source), "Invalid packed Vision surface");
      decoded = IOSurfaceCreate((__bridge CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height), (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfaceBytesPerRow: @(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, width * 4)),
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA)
      });
      require(decoded, "Cannot allocate unpacked Vision input");
      auto readDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:width height:IOSurfaceGetHeight(source) mipmapped:NO]; readDesc.usage = MTLTextureUsageShaderRead;
      auto writeDesc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:width height:height mipmapped:NO]; writeDesc.usage = MTLTextureUsageShaderWrite;
      auto read = [s.device newTextureWithDescriptor:readDesc iosurface:source plane:0];
      auto write = [s.device newTextureWithDescriptor:writeDesc iosurface:decoded plane:0];
      require(read && write, "Cannot bind packed Vision surfaces");
      auto commands = [s.queue commandBuffer]; auto encoder = [commands computeCommandEncoder];
      require(commands && encoder, "Cannot encode Vision input unpacking");
      [encoder setComputePipelineState:s.unpack]; [encoder setTexture:read atIndex:0]; [encoder setTexture:write atIndex:1];
      [encoder dispatchThreads:MTLSizeMake(width, height, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
      [encoder endEncoding]; [commands commit]; [commands waitUntilCompleted];
      require(commands.status == MTLCommandBufferStatusCompleted, "Vision input unpacking GPU command failed");
      void *result = infer(value, decoded, outputWidth, outputHeight);
      CFRelease(decoded); return result;
    } catch (const std::exception &error) {
      if (decoded) CFRelease(decoded);
      failure = error.what(); return nullptr;
    }
  }
}

extern "C" int loom_vision_release(void *value) {
  try {
    failure.clear(); auto &s = session(value);
    require(s.output != nullptr, "No Vision result to release");
    clearResult(s); return 0;
  } catch (const std::exception &error) { failure = error.what(); return -1; }
}
extern "C" int loom_vision_reset(void *value) {
  @autoreleasepool {
    try {
      failure.clear(); auto &s = session(value);
      require(s.output == nullptr, "Release Vision result before temporal reset");
      s.request = newRequest(); return 0;
    } catch (const std::exception &error) { failure = error.what(); return -1; }
  }
}
extern "C" int loom_vision_destroy(void *value) {
  try {
    failure.clear(); auto &s = session(value);
    require(s.output == nullptr, "Release Vision result before destruction");
    delete &s; return 0;
  } catch (const std::exception &error) { failure = error.what(); return -1; }
}
#ifdef LOOM_VISION_TEST_ORACLE
extern "C" void *loom_vision_test_mask(void *value) { return session(value).mask; }
#endif
