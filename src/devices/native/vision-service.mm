#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <xpc/xpc.h>
#include <unistd.h>
#include <stdexcept>
#include <string>
#include "native-service.h"
#ifndef LOOM_NATIVE_SERVICE_ONLY
#include "vision-surface.h"
#endif

namespace {
void require(bool ok, const std::string &error) { if (!ok) throw std::runtime_error(error); }
uint64_t integer(xpc_object_t message, const char *key) {
  auto value = xpc_dictionary_get_value(message, key);
  require(value && xpc_get_type(value) == XPC_TYPE_UINT64, "Missing/invalid sequence");
  return xpc_uint64_get_value(value);
}
uint32_t dimension(xpc_object_t message, const char *key, const std::string &label) {
  const auto value = integer(message, key);
  require(value > 0 && value <= 8192, "Invalid " + label + " input/output dimensions");
  return (uint32_t)value;
}
}

// Python calls on its main thread. Its CFRunLoop services the main dispatch
// queue, preserving provider thread affinity across requests. This is the model
// worker process, NEVER Electron's main thread. One connection owns the session.
// The loop is shared by every session kind (T1818b): the provider decides what a
// frame means, never who may submit one or when a result may be reused.
extern "C" int loom_native_serve(const char *name, const char *secret, const LoomNativeProvider *provider) {
  @autoreleasepool {
    if (![NSThread isMainThread] || !name || !secret || !*name || !*secret || !provider) return 1;
    const LoomNativeProvider p = *provider;
    const std::string L(p.label);
    void *session = p.create(p.context);
    if (!session) { fprintf(stderr, "%s_INIT_FAILED %s\n", p.marker, p.error()); return 1; }
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
            require(given && token == given, "Unauthorized " + L + " request");
            require(!owner || owner == peer, L + " session already owned");
            owner = peer;
            require(!finished, L + " session finished");
            require(integer(message, "sequence") == sequence, "Out-of-order " + L + " request");
            const char *op = xpc_dictionary_get_string(message, "op");
            require(op != nullptr, "Missing " + L + " operation");
            const bool packed = strcmp(op, "infer-packed") == 0;
            if (packed || (strcmp(op, "infer") == 0 && p.infer)) {
              require(!held, "Release outstanding " + L + " result first");
              auto capability = xpc_dictionary_get_value(message, "surface");
              require(capability != nullptr, "Missing input surface capability");
              input = IOSurfaceLookupFromXPCObject(capability);
              require(input != nullptr, "Invalid input surface capability");
              auto result = static_cast<IOSurfaceRef>(packed
                ? p.infer_packed(session, input, dimension(message, "inputWidth", L), dimension(message, "inputHeight", L),
                    dimension(message, "outputWidth", L), dimension(message, "outputHeight", L))
                : p.infer(session, input));
              require(result != nullptr, p.error());
              held = true;
              auto shared = IOSurfaceCreateXPCObject(result);
              // If export fails, retain the lease: only release or disconnect
              // can retire it. Never overwrite a possibly published result.
              require(shared != nil, "Cannot export " + L + " result capability");
              xpc_dictionary_set_value(reply, "surface", shared);
              xpc_dictionary_set_uint64(reply, "inputSurfaceId", IOSurfaceGetID(input));
              xpc_dictionary_set_uint64(reply, "resultSurfaceId", IOSurfaceGetID(result));
              const double coverage = p.coverage(session);
              require(coverage >= 0 && coverage <= 1, "Invalid " + L + " coverage");
              xpc_dictionary_set_double(reply, "coverage", coverage);
            } else if (strcmp(op, "release") == 0) {
              require(held, "No " + L + " result to release");
              const int status = p.release(session);
              require(status == 0, p.error());
              held = false;
              xpc_dictionary_set_uint64(reply, "released", sequence + 1);
            } else if (strcmp(op, "reset") == 0) {
              const int status = p.reset(session);
              require(status == 0, p.error());
            } else if (strcmp(op, "finish") == 0) {
              require(!held, "Release " + L + " result before finish");
              finished = true;
            } else throw std::runtime_error("Unknown " + L + " operation");
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
    bool cleaned = !held || p.release(session) == 0;
    cleaned = p.destroy(session) == 0 && cleaned;
    fprintf(stderr, "%s_SERVICE_EXIT pid=%d released=%llu finished=%d heldAtDisconnect=%d\n",
      p.marker, getpid(), sequence, finished, held);
    return finished && cleaned ? 0 : 1;
  }
}

#ifndef LOOM_NATIVE_SERVICE_ONLY
// Built with LOOM_NATIVE_SERVICE_ONLY, this file is the serve loop alone, so the
// depth library (depth-service.mm) links it without linking Apple Vision.
extern "C" int loom_vision_serve(const char *name, const char *secret) {
  static const LoomNativeProvider vision = { "Vision", "VISION", [](const void *) { return loom_vision_create(); }, nullptr,
    loom_vision_infer, loom_vision_infer_packed, loom_vision_coverage, loom_vision_release, loom_vision_reset,
    loom_vision_destroy, loom_vision_error };
  return loom_native_serve(name, secret, &vision);
}
#endif
