#include <node_api.h>
#import <IOSurface/IOSurface.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include <cstring>
#include <stdexcept>
#include <string>
#include <memory>

static NSMutableDictionary<NSString *, SyphonMetalServer *> *servers;
static id<MTLDevice> publisherDevice;
static id<MTLCommandQueue> publisherQueue;
static uint64_t publisherQueuesCreated = 0;

struct Inspection {
  IOSurfaceRef surface = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  unsigned char samples[16] = {};
  std::string error;
  SyphonMetalServer *server = nil;
  id<MTLDevice> device = nil;
  id<MTLCommandQueue> queue = nil;
  ~Inspection() { if (surface) CFRelease(surface); }
};

// Native-owned GPU copy, followed by four pixel reads solely as correctness oracle.
// Worker wait never blocks Electron's main thread; caller holds the paint lease.
static void execute(napi_env, void *data) {
  auto job = static_cast<Inspection *>(data);
  @autoreleasepool {
    try {
      id<MTLDevice> device = job->device ?: MTLCreateSystemDefaultDevice();
      if (!device) throw std::runtime_error("No native Metal device");
      const size_t width = IOSurfaceGetWidth(job->surface), height = IOSurfaceGetHeight(job->surface);
      auto descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
      descriptor.storageMode = MTLStorageModeShared;
      id<MTLTexture> source = [device newTextureWithDescriptor:descriptor iosurface:job->surface plane:0];
      if (job->server) {
        id<MTLCommandBuffer> command = [job->queue commandBuffer];
        if (!source || !command) throw std::runtime_error("Cannot import Syphon source texture");
        [job->server publishFrameTexture:source onCommandBuffer:command imageRegion:NSMakeRect(0,0,width,height) flipped:NO];
        [command commit]; [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted)
          throw std::runtime_error(command.error ? command.error.localizedDescription.UTF8String : "Syphon GPU publication failed");
        return;
      }
#ifdef LOOM_EXPORT_ORACLE
      descriptor.storageMode = MTLStorageModePrivate;
      id<MTLTexture> owned = [device newTextureWithDescriptor:descriptor];
      id<MTLBuffer> oracle = [device newBufferWithLength:1024 options:MTLResourceStorageModeShared];
      id<MTLCommandQueue> queue = [device newCommandQueue];
      id<MTLCommandBuffer> command = [queue commandBuffer];
      if (!source || !owned || !oracle || !command) throw std::runtime_error("Cannot allocate native GPU inspection resources");
      id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
      if (!blit) throw std::runtime_error("Cannot create native GPU blit encoder");
      [blit copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)
        sourceSize:MTLSizeMake(1920,1080,1) toTexture:owned destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
      for (int i = 0; i < 4; i++) {
        [blit copyFromTexture:owned sourceSlice:0 sourceLevel:0
          sourceOrigin:MTLOriginMake(i % 2 ? 1700 : 100, i < 2 ? 100 : 900, 0)
          sourceSize:MTLSizeMake(1,1,1) toBuffer:oracle destinationOffset:i*256
          destinationBytesPerRow:256 destinationBytesPerImage:256];
      }
      [blit endEncoding]; [command commit]; [command waitUntilCompleted];
      if (command.status != MTLCommandBufferStatusCompleted)
        throw std::runtime_error(command.error ? command.error.localizedDescription.UTF8String : "Native GPU copy failed");
      auto bytes = static_cast<unsigned char *>(oracle.contents);
      for (int i = 0; i < 4; i++) {
        auto pixel = bytes + i*256;
        job->samples[i*4] = pixel[2]; job->samples[i*4+1] = pixel[1];
        job->samples[i*4+2] = pixel[0]; job->samples[i*4+3] = pixel[3];
      }
#else
      throw std::runtime_error("Native publication requires a named Syphon server");
#endif
    } catch (const std::exception &error) { job->error = error.what(); }
  }
}

static void complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Inspection> job(static_cast<Inspection *>(data));
  if (status != napi_ok && job->error.empty()) job->error = "Native inspection cancelled";
  napi_value result;
  if (job->error.empty() && napi_create_buffer_copy(env, sizeof(job->samples), job->samples, nullptr, &result) != napi_ok)
    job->error = "Cannot return native GPU samples";
  if (job->error.empty()) napi_resolve_deferred(env, job->deferred, result);
  else {
    napi_value message;
    napi_create_string_utf8(env, job->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &result);
    napi_reject_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work);
}

static napi_value inspect(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2, length = 0;
    napi_value args[2];
    void *bytes = nullptr;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok ||
#ifdef LOOM_EXPORT_ORACLE
        (argc != 1 && argc != 2) ||
#else
        argc != 2 ||
#endif
        napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(IOSurfaceRef))
      throw std::runtime_error("Expected local IOSurfaceRef buffer");
    IOSurfaceRef surface;
    memcpy(&surface, bytes, sizeof(surface));
    if (!surface || IOSurfaceGetWidth(surface) == 0 || IOSurfaceGetHeight(surface) == 0 ||
        IOSurfaceGetWidth(surface) > 16384 || IOSurfaceGetHeight(surface) > 16384 ||
        (argc == 1 && (IOSurfaceGetWidth(surface) != 1920 || IOSurfaceGetHeight(surface) != 1080)) ||
        IOSurfaceGetPixelFormat(surface) != 'BGRA' || IOSurfaceGetBytesPerElement(surface) != 4 ||
        IOSurfaceGetPlaneCount(surface) != 0 || IOSurfaceGetBytesPerRow(surface) < IOSurfaceGetWidth(surface) * 4)
      throw std::runtime_error("Unexpected native export layout; requires BGRA8 and supported dimensions");
    auto job = std::make_unique<Inspection>();
    job->surface = (IOSurfaceRef)CFRetain(surface);
    if (argc == 2) {
      char name[129]; size_t size = 0;
      if (napi_get_value_string_utf8(env, args[1], nullptr, 0, &size) != napi_ok || size == 0 || size > 128 ||
          napi_get_value_string_utf8(env, args[1], name, sizeof(name), &size) != napi_ok)
        throw std::runtime_error("Invalid Syphon publisher name");
      NSString *key = [NSString stringWithUTF8String:name];
      if (!key) throw std::runtime_error("Invalid UTF8 publisher name");
      if (!servers) servers = [NSMutableDictionary new];
      if (!publisherDevice) publisherDevice = MTLCreateSystemDefaultDevice();
      if (!publisherDevice) throw std::runtime_error("No Syphon Metal device");
      if (!publisherQueue) {
        publisherQueue = [publisherDevice newCommandQueue];
        if (!publisherQueue) throw std::runtime_error("Cannot create Syphon Metal queue");
        publisherQueuesCreated++;
      }
      SyphonMetalServer *server = servers[key];
      if (!server) {
        server = [[SyphonMetalServer alloc] initWithName:key device:publisherDevice options:nil];
        if (!server) throw std::runtime_error("Cannot start Syphon publisher");
        servers[key] = server;
      }
      job->server = server; job->device = publisherDevice; job->queue = publisherQueue;
    }
    napi_value promise, name;
    if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
        napi_create_string_utf8(env, "native-metal-export", NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_async_work(env, nullptr, name, execute, complete, job.get(), &job->work) != napi_ok)
      throw std::runtime_error("Cannot create native GPU worker");
    if (napi_queue_async_work(env, job->work) != napi_ok) {
      napi_delete_async_work(env, job->work);
      throw std::runtime_error("Cannot queue native GPU worker");
    }
    job.release();
    return promise;
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
#ifdef LOOM_EXPORT_ORACLE
    {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
    {"publish", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, [](napi_env env, napi_callback_info info) -> napi_value {
      size_t argc = 1, size = 0; napi_value arg; char name[129];
      if (napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr) != napi_ok || argc != 1 ||
          napi_get_value_string_utf8(env, arg, nullptr, 0, &size) != napi_ok || size == 0 || size > 128 ||
          napi_get_value_string_utf8(env, arg, name, sizeof(name), &size) != napi_ok) {
        napi_throw_error(env, nullptr, "Invalid publisher name"); return nullptr;
      }
      NSString *key = [NSString stringWithUTF8String:name];
      if (!key) { napi_throw_error(env, nullptr, "Invalid UTF8 publisher name"); return nullptr; }
      [servers[key] stop]; [servers removeObjectForKey:key];
      if (servers.count == 0) { publisherQueue = nil; publisherDevice = nil; }
      napi_value result; napi_get_undefined(env, &result); return result;
    }, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stats", nullptr, [](napi_env env, napi_callback_info) -> napi_value {
      napi_value result, count, queues;
      napi_create_object(env, &result);
      napi_create_uint32(env, (uint32_t)servers.count, &count);
      napi_create_double(env, (double)publisherQueuesCreated, &queues);
      napi_set_named_property(env, result, "publishers", count);
      napi_set_named_property(env, result, "queuesCreated", queues);
      return result;
    }, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
