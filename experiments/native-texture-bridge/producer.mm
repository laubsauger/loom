#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#include <xpc/xpc.h>
#include <stdexcept>
#include <string>
#include <unistd.h>

// One producer-owned surface. JS may reuse it only after Electron's GPU-aware
// allReferencesReleased callback. This is deliberately not a throughput test.
static IOSurfaceRef surface;
static id<MTLDevice> device;
static id<MTLCommandQueue> queue;
static id<MTLComputePipelineState> pipeline;
static id<MTLTexture> texture;

static IOSurfaceRef fail(const char *message) {
  throw std::runtime_error(message);
}

static IOSurfaceRef prepare(uint32_t format, uint32_t sequence) {
  @autoreleasepool {
    if (!device) {
      device = MTLCreateSystemDefaultDevice();
      queue = [device newCommandQueue];
      NSError *error = nil;
      NSString *source = @"#include <metal_stdlib>\nusing namespace metal;\n"
        "kernel void fill(texture2d<float, access::write> out [[texture(0)]],"
        "constant uint &seq [[buffer(0)]], constant uint &fmt [[buffer(1)]],"
        "uint2 p [[thread_position_in_grid]]) {"
        "if(p.x>=out.get_width() || p.y>=out.get_height()) return;"
        "float r = fmt == 0 ? float((p.x / 8 + seq) % 4) / 3.0 :"
        "(p.x < 16 ? -0.25 : p.x < 32 ? 0.125 : p.x < 48 ? 0.5 : 2.0);"
        "out.write(float4(r, float((p.y / 8 + seq) % 4)/3.0, float(seq%2), 1), p);}";
      id<MTLLibrary> library = [device newLibraryWithSource:source options:nil error:&error];
      if (!library) return fail(error.localizedDescription.UTF8String);
      pipeline = [device newComputePipelineStateWithFunction:[library newFunctionWithName:@"fill"] error:&error];
      if (!pipeline || !queue) return fail("Metal producer initialization failed");
    }
    if (surface) return fail("Cannot overwrite an outstanding surface");
    const size_t bytes = format == 0 ? 4 : 8;
    surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @64, (id)kIOSurfaceHeight: @64,
      (id)kIOSurfaceBytesPerElement: @(bytes),
      (id)kIOSurfaceBytesPerRow: @(64 * bytes),
      (id)kIOSurfacePixelFormat: @(format == 0 ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_64RGBAHalf)
    });
    if (!surface) return fail("IOSurface allocation failed");
    MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:
      format == 0 ? MTLPixelFormatBGRA8Unorm : MTLPixelFormatRGBA16Float
      width:64 height:64 mipmapped:NO];
    desc.usage = MTLTextureUsageShaderWrite | MTLTextureUsageShaderRead;
    texture = [device newTextureWithDescriptor:desc iosurface:surface plane:0];
    if (!texture) return fail("Metal IOSurface texture creation failed");
    id<MTLCommandBuffer> commands = [queue commandBuffer];
    id<MTLComputeCommandEncoder> encoder = [commands computeCommandEncoder];
    [encoder setComputePipelineState:pipeline];
    [encoder setTexture:texture atIndex:0];
    [encoder setBytes:&sequence length:sizeof(sequence) atIndex:0];
    [encoder setBytes:&format length:sizeof(format) atIndex:1];
    [encoder dispatchThreads:MTLSizeMake(64, 64, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
    [encoder endEncoding];
    [commands commit];
    [commands waitUntilCompleted];
    if (commands.status != MTLCommandBufferStatusCompleted)
      return fail("Metal producer command failed");
    return surface;
  }
}

static void dispose() {
  texture = nil;
  if (surface) { CFRelease(surface); surface = nullptr; }
}

static uint64_t integer(xpc_object_t message, const char *key) {
  xpc_object_t value = xpc_dictionary_get_value(message, key);
  if (!value || xpc_get_type(value) != XPC_TYPE_UINT64)
    throw std::runtime_error(std::string("Missing/invalid integer: ") + key);
  return xpc_uint64_get_value(value);
}

// ctypes loads this in the Python process. All peer events share one serial queue.
extern "C" void proof_serve(const char *name, const char *secret) {
  const std::string token(secret);
  dispatch_queue_t events = dispatch_queue_create("loom.proof.producer", DISPATCH_QUEUE_SERIAL);
  xpc_connection_t listener = xpc_connection_create_mach_service(name, events, XPC_CONNECTION_MACH_SERVICE_LISTENER);
  __block xpc_connection_t owner = nil;
  __block uint64_t next = 0;
  __block bool finished = false;
  xpc_connection_set_event_handler(listener, ^(xpc_object_t incoming) {
    if (xpc_get_type(incoming) != XPC_TYPE_CONNECTION) {
      fprintf(stderr, "PRODUCER_LISTENER_FAILED\n");
      exit(1);
    }
    xpc_connection_t peer = (xpc_connection_t)incoming;
    if (xpc_connection_get_euid(peer) != geteuid()) {
      xpc_connection_cancel(peer);
      return;
    }
    xpc_connection_set_target_queue(peer, events);
    xpc_connection_set_event_handler(peer, ^(xpc_object_t request) {
      @autoreleasepool {
        if (xpc_get_type(request) == XPC_TYPE_ERROR) {
          if (owner == peer) {
            // Destroy, never reuse, outstanding storage on consumer death.
            dispose();
            fprintf(stderr, "PRODUCER_EXIT pid=%d released=%llu finished=%d\n", getpid(), next, finished);
            exit(finished ? 0 : 1);
          }
          return;
        }
        if (xpc_get_type(request) != XPC_TYPE_DICTIONARY) {
          xpc_connection_cancel(peer);
          return;
        }
        xpc_object_t reply = xpc_dictionary_create_reply(request);
        if (!reply) { xpc_connection_cancel(peer); return; }
        try {
          const char *given = xpc_dictionary_get_string(request, "token");
          if (!given || token != given) throw std::runtime_error("Unauthorized producer request");
          if (owner && owner != peer) throw std::runtime_error("Producer already owned");
          owner = peer;
          if (finished) throw std::runtime_error("Producer already finished");
          const char *op = xpc_dictionary_get_string(request, "op");
          if (!op) throw std::runtime_error("Missing operation");
          const uint64_t sequence = integer(request, "sequence");
          if (sequence != next) throw std::runtime_error("Out-of-order frame");
          if (strcmp(op, "prepare") == 0) {
            const uint64_t format = integer(request, "format");
            if (next >= 24 || format != (next < 12 ? 0u : 1u)) throw std::runtime_error("Invalid format/frame");
            xpc_object_t shared = IOSurfaceCreateXPCObject(prepare((uint32_t)format, (uint32_t)next));
            if (!shared) throw std::runtime_error("Cannot export IOSurface XPC capability");
            xpc_dictionary_set_value(reply, "surface", shared);
          } else if (strcmp(op, "release") == 0) {
            if (!surface) throw std::runtime_error("No outstanding frame to release");
            dispose();
            next++;
          } else if (strcmp(op, "finish") == 0) {
            if (surface || next != 24) throw std::runtime_error("Unreleased or incomplete stream");
            finished = true;
          } else throw std::runtime_error("Unknown operation");
          xpc_dictionary_set_uint64(reply, "producerPid", getpid());
          xpc_dictionary_set_uint64(reply, "sequence", sequence);
          xpc_dictionary_set_uint64(reply, "released", next);
        } catch (const std::exception &error) {
          xpc_dictionary_set_string(reply, "error", error.what());
        }
        xpc_connection_send_message(peer, reply);
      }
    });
    xpc_connection_activate(peer);
  });
  xpc_connection_activate(listener);
  dispatch_main();
}
