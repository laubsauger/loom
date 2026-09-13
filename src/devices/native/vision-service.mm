#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <xpc/xpc.h>
#include <unistd.h>
#include <stdexcept>
#include <string>
#include "vision-surface.h"

namespace {
void require(bool ok, const char *error) { if (!ok) throw std::runtime_error(error); }
uint64_t integer(xpc_object_t message, const char *key) {
  auto value = xpc_dictionary_get_value(message, key);
  require(value && xpc_get_type(value) == XPC_TYPE_UINT64, "Missing/invalid sequence");
  return xpc_uint64_get_value(value);
}
uint32_t dimension(xpc_object_t message, const char *key) {
  const auto value = integer(message, key);
  require(value > 0 && value <= 8192, "Invalid Vision input/output dimensions");
  return (uint32_t)value;
}
}

// Python calls on its main thread. Its CFRunLoop services the main dispatch
// queue, preserving provider thread affinity across requests. This is the model
// worker process, NEVER Electron's main thread. One connection owns the session.
extern "C" int loom_vision_serve(const char *name, const char *secret) {
  @autoreleasepool {
    if (![NSThread isMainThread] || !name || !secret || !*name || !*secret) return 1;
    void *session = loom_vision_create();
    if (!session) { fprintf(stderr, "VISION_INIT_FAILED %s\n", loom_vision_error()); return 1; }
    const std::string token(secret);
    __block xpc_connection_t owner = nil;
    __block uint64_t sequence = 0;
    __block bool held = false, finished = false;
    auto listener = xpc_connection_create_mach_service(name, dispatch_get_main_queue(), XPC_CONNECTION_MACH_SERVICE_LISTENER);
    xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
      if (xpc_get_type(event) != XPC_TYPE_CONNECTION) {
        CFRunLoopStop(CFRunLoopGetMain()); return;
      }
      xpc_connection_t peer = (xpc_connection_t)event;
      if (xpc_connection_get_euid(peer) != geteuid()) { xpc_connection_cancel(peer); return; }
      xpc_connection_set_target_queue(peer, dispatch_get_main_queue());
      xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
        @autoreleasepool {
          if (xpc_get_type(message) == XPC_TYPE_ERROR) {
            if (owner == peer) CFRunLoopStop(CFRunLoopGetMain());
            return;
          }
          if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) { xpc_connection_cancel(peer); return; }
          auto reply = xpc_dictionary_create_reply(message);
          if (!reply) { xpc_connection_cancel(peer); return; }
          IOSurfaceRef input = nullptr;
          try {
            const char *given = xpc_dictionary_get_string(message, "token");
            require(given && token == given, "Unauthorized Vision request");
            require(!owner || owner == peer, "Vision session already owned");
            owner = peer;
            require(!finished, "Vision session finished");
            require(integer(message, "sequence") == sequence, "Out-of-order Vision request");
            const char *op = xpc_dictionary_get_string(message, "op");
            require(op != nullptr, "Missing Vision operation");
            if (strcmp(op, "infer") == 0 || strcmp(op, "infer-packed") == 0) {
              require(!held, "Release outstanding Vision result first");
              auto capability = xpc_dictionary_get_value(message, "surface");
              require(capability != nullptr, "Missing input surface capability");
              input = IOSurfaceLookupFromXPCObject(capability);
              require(input != nullptr, "Invalid input surface capability");
              auto result = static_cast<IOSurfaceRef>(strcmp(op, "infer-packed") == 0
                ? loom_vision_infer_packed(session, input, dimension(message, "inputWidth"), dimension(message, "inputHeight"),
                    dimension(message, "outputWidth"), dimension(message, "outputHeight"))
                : loom_vision_infer(session, input));
              require(result != nullptr, loom_vision_error());
              held = true;
              auto shared = IOSurfaceCreateXPCObject(result);
              // If export fails, retain the lease: only release or disconnect
              // can retire it. Never overwrite a possibly published result.
              require(shared != nil, "Cannot export Vision result capability");
              xpc_dictionary_set_value(reply, "surface", shared);
              xpc_dictionary_set_uint64(reply, "inputSurfaceId", IOSurfaceGetID(input));
              xpc_dictionary_set_uint64(reply, "resultSurfaceId", IOSurfaceGetID(result));
              const double coverage = loom_vision_coverage(session);
              require(coverage >= 0 && coverage <= 1, "Invalid Vision coverage");
              xpc_dictionary_set_double(reply, "coverage", coverage);
            } else if (strcmp(op, "release") == 0) {
              require(held, "No Vision result to release");
              const int status = loom_vision_release(session);
              require(status == 0, loom_vision_error());
              held = false;
              xpc_dictionary_set_uint64(reply, "released", sequence + 1);
            } else if (strcmp(op, "reset") == 0) {
              const int status = loom_vision_reset(session);
              require(status == 0, loom_vision_error());
            } else if (strcmp(op, "finish") == 0) {
              require(!held, "Release Vision result before finish");
              finished = true;
            } else throw std::runtime_error("Unknown Vision operation");
            xpc_dictionary_set_uint64(reply, "sequence", sequence);
            if (strcmp(op, "release") == 0) sequence++;
          } catch (const std::exception &error) {
            xpc_dictionary_set_string(reply, "error", error.what());
          }
          if (input) CFRelease(input);
          xpc_dictionary_set_uint64(reply, "producerPid", getpid());
          xpc_connection_send_message(peer, reply);
        }
      });
      xpc_connection_activate(peer);
    });
    xpc_connection_activate(listener);
    CFRunLoopSourceContext context = {};
    auto keepAlive = CFRunLoopSourceCreate(kCFAllocatorDefault, 0, &context);
    CFRunLoopAddSource(CFRunLoopGetMain(), keepAlive, kCFRunLoopDefaultMode);
    CFRunLoopRun();
    CFRunLoopRemoveSource(CFRunLoopGetMain(), keepAlive, kCFRunLoopDefaultMode);
    CFRelease(keepAlive);
    xpc_connection_cancel(listener);
    if (owner) xpc_connection_cancel(owner);
    // Terminal disposal only. A disconnected consumer's retained IOSurface
    // references remain its own; this worker never reuses that storage.
    bool cleaned = !held || loom_vision_release(session) == 0;
    cleaned = loom_vision_destroy(session) == 0 && cleaned;
    fprintf(stderr, "VISION_SERVICE_EXIT pid=%d released=%llu finished=%d heldAtDisconnect=%d\n",
      getpid(), sequence, finished, held);
    return finished && cleaned ? 0 : 1;
  }
}
