#pragma once
#include <stdint.h>

// Process-local ABI for a Python/native worker. Input is borrowed only during
// infer; output remains provider-owned until release. Never serialize pointers.
// Call from the creating thread only. Finish producer GPU writes before infer;
// finish all consumer GPU reads before release. This ABI does not invent fences.
extern "C" {
void *loom_vision_create();
void *loom_vision_infer(void *session, void *input_surface);
// Opaque RGB transport of RGBA bytes; input is already letterboxed. Result is
// unletterboxed/nearest-expanded to the graph output size entirely on Metal.
void *loom_vision_infer_packed(void *session, void *input_surface, uint32_t input_width,
  uint32_t input_height, uint32_t output_width, uint32_t output_height);
double loom_vision_coverage(void *session);
int loom_vision_release(void *session);
int loom_vision_reset(void *session);
int loom_vision_destroy(void *session);
const char *loom_vision_error();
#ifdef LOOM_VISION_TEST_ORACLE
void *loom_vision_test_mask(void *session);
#endif
}
