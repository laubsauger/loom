#pragma once
#include <stdint.h>

// One model session kind behind the shared XPC serve loop (vision-service.mm).
// The loop owns tokens, ordering and leases; the provider owns pixels. Every
// call happens on the serving thread, so the provider's thread affinity holds.
extern "C" {
struct LoomNativeProvider {
  const char *label;   // "Vision", "Depth": prefixes every refusal the client reads
  const char *marker;  // "VISION", "DEPTH": prefixes the worker's stderr lifecycle lines
  void *(*create)(const void *context);
  const void *context;
  void *(*infer)(void *session, void *input); // nullptr: this kind serves only packed input
  void *(*infer_packed)(void *session, void *input, uint32_t input_width, uint32_t input_height,
    uint32_t output_width, uint32_t output_height);
  double (*coverage)(void *session);
  int (*release)(void *session);
  int (*reset)(void *session);
  int (*destroy)(void *session);
  const char *(*error)();
};
int loom_native_serve(const char *name, const char *secret, const LoomNativeProvider *provider);
}
