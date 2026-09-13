// Standalone correctness client. Blocking IPC and CPU readback are test-only;
// neither belongs on Electron's main thread or in the production provider.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <xpc/xpc.h>
#include <unistd.h>
#include <stdexcept>
#include <string>
#include "../../devices/native/vision-surface.h"

extern "C" void *oracle_input(const char *, bool);
extern "C" void oracle_release_input(void *);
extern "C" void *oracle_unsupported_input();
struct OracleStats { uint32_t width, height; double maxError; uint64_t foreground; };
extern "C" int oracle_verify(void *, void *, OracleStats *);

void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
xpc_connection_t connect(const char *name) {
  auto peer = xpc_connection_create_mach_service(name, nullptr, 0);
  xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_ERROR) xpc_connection_cancel(peer);
  });
  xpc_connection_activate(peer);
  return peer;
}
xpc_object_t request(xpc_connection_t peer, const char *token, const char *op,
                     uint64_t sequence, IOSurfaceRef input = nullptr, bool malformed = false) {
  auto message = xpc_dictionary_create(nullptr, nullptr, 0);
  xpc_dictionary_set_string(message, "token", token);
  xpc_dictionary_set_string(message, "op", op);
  xpc_dictionary_set_uint64(message, "sequence", sequence);
  if (input) xpc_dictionary_set_value(message, "surface", IOSurfaceCreateXPCObject(input));
  if (malformed) xpc_dictionary_set_string(message, "surface", "not-an-iosurface");
  auto ready = dispatch_semaphore_create(0);
  __block xpc_object_t response = nil;
  xpc_connection_send_message_with_reply(peer, message, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(xpc_object_t reply) {
    response = reply; dispatch_semaphore_signal(ready);
  });
  require(dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC)) == 0, "Vision IPC timeout");
  require(response && xpc_get_type(response) == XPC_TYPE_DICTIONARY, "Vision IPC disconnected");
  const auto pid = xpc_dictionary_get_uint64(response, "producerPid");
  require(pid != (uint64_t)getpid() && pid == (uint64_t)xpc_connection_get_pid(peer) &&
    xpc_connection_get_euid(peer) == geteuid(), "Vision peer identity mismatch");
  if (const char *error = xpc_dictionary_get_string(response, "error")) throw std::runtime_error(error);
  require(xpc_dictionary_get_uint64(response, "sequence") == sequence, "Vision reply sequence mismatch");
  return response;
}
void refused(xpc_connection_t peer, const char *token, const char *op, uint64_t sequence,
             const char *reason, IOSurfaceRef input = nullptr, bool malformed = false) {
  try { request(peer, token, op, sequence, input, malformed); }
  catch (const std::exception &error) {
    require(std::string(error.what()).find(reason) != std::string::npos, error.what()); return;
  }
  throw std::runtime_error(std::string("Expected refusal: ") + reason);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 5 || (strcmp(argv[4], "round-trip") && strcmp(argv[4], "disconnect-held"))) return 2;
    auto peer = connect(argv[1]);
    void *reference = nullptr;
    IOSurfaceRef input = nullptr, output = nullptr;
    bool localHeld = false;
    try {
      refused(peer, "invalid-token", "reset", 0, "Unauthorized");
      request(peer, argv[2], "reset", 0);
      auto other = connect(argv[1]);
      refused(other, argv[2], "reset", 0, "already owned");
      xpc_connection_cancel(other);
      refused(peer, argv[2], "unknown", 0, "Unknown");
      refused(peer, argv[2], "infer", 0, "Missing input");
      refused(peer, argv[2], "infer", 0, "Invalid input", nullptr, true);
      input = static_cast<IOSurfaceRef>(oracle_unsupported_input());
      require(input != nullptr, "Cannot create unsupported control");
      refused(peer, argv[2], "infer", 0, "BGRA8", input);
      oracle_release_input(input); input = nullptr;
      reference = loom_vision_create();
      require(reference != nullptr, loom_vision_error());
      for (uint64_t sequence = 0; sequence < 3; sequence++) {
        const bool blank = sequence == 2;
        if (blank) {
          request(peer, argv[2], "reset", sequence);
          const int status = loom_vision_reset(reference);
          require(status == 0, loom_vision_error());
        }
        input = static_cast<IOSurfaceRef>(oracle_input(argv[3], blank));
        require(input != nullptr, "Cannot decode input control");
        auto reply = request(peer, argv[2], "infer", sequence, input);
        require(xpc_dictionary_get_uint64(reply, "inputSurfaceId") == IOSurfaceGetID(input), "Input surface was replaced across IPC");
        auto capability = xpc_dictionary_get_value(reply, "surface");
        require(capability != nullptr, "Missing result capability");
        output = IOSurfaceLookupFromXPCObject(capability);
        require(output && xpc_dictionary_get_uint64(reply, "resultSurfaceId") == IOSurfaceGetID(output), "Result surface was replaced across IPC");
        // A separate local Vision request is the oracle for the transported mask.
        // It sees the same inputs and temporal resets as the Python session.
        require(loom_vision_infer(reference, input) != nullptr, "Reference inference failed");
        localHeld = true;
        OracleStats stats;
        require(oracle_verify(reference, output, &stats) == 0, "Transported pixels differ from Vision reference");
        const double coverage = double(stats.foreground) / (stats.width * stats.height);
        require(blank ? coverage < 0.01 : coverage > 0.01, "Person/empty control failed");
        refused(peer, argv[2], "infer", sequence, "outstanding", input);
        refused(peer, argv[2], "reset", sequence, "Release");
        refused(peer, argv[2], "finish", sequence, "Release");
        refused(peer, argv[2], "release", sequence + 1, "Out-of-order");
        require(oracle_verify(reference, output, &stats) == 0, "Refused request damaged held result");
        printf("VISION_TRANSPORT_FRAME sequence=%llu producer=%llu input=%u output=%u size=%ux%u coverage=%.8f maxError=%.9f\n",
          sequence, xpc_dictionary_get_uint64(reply, "producerPid"), IOSurfaceGetID(input), IOSurfaceGetID(output),
          stats.width, stats.height, coverage, stats.maxError);
        if (strcmp(argv[4], "disconnect-held") == 0) {
          // Consumer vanishes without sending a release ACK. The worker must
          // terminally dispose, never reuse the outstanding result or restart.
          CFRelease(output); output = nullptr;
          oracle_release_input(input); input = nullptr;
          require(loom_vision_release(reference) == 0, "Reference release failed"); localHeld = false;
          require(loom_vision_destroy(reference) == 0, "Reference destruction failed"); reference = nullptr;
          xpc_connection_cancel(peer);
          printf("LOOM_VISION_DISCONNECT_PASS consumer=%d\n", getpid());
          return 0;
        }
        // Oracle has finished reading. Drop the local result before acknowledging.
        CFRelease(output); output = nullptr;
        auto released = request(peer, argv[2], "release", sequence);
        require(xpc_dictionary_get_uint64(released, "released") == sequence + 1, "Missing result release acknowledgment");
        refused(peer, argv[2], "release", sequence + 1, "No Vision result");
        require(loom_vision_release(reference) == 0, "Reference release failed"); localHeld = false;
        oracle_release_input(input); input = nullptr;
      }
      request(peer, argv[2], "finish", 3);
      require(loom_vision_destroy(reference) == 0, "Reference destruction failed"); reference = nullptr;
      xpc_connection_cancel(peer);
      printf("LOOM_VISION_TRANSPORT_PASS consumer=%d frames=3\n", getpid());
      return 0;
    } catch (const std::exception &error) {
      fprintf(stderr, "VISION_TRANSPORT_FAILED %s\n", error.what());
      if (output) CFRelease(output);
      if (input) oracle_release_input(input);
      if (localHeld) loom_vision_release(reference);
      if (reference) loom_vision_destroy(reference);
      xpc_connection_cancel(peer);
      return 1;
    }
  }
}
