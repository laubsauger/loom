#pragma once
#include <stdint.h>

// Process-local ABI for the Depth Pro 2 Core ML worker (T1818b), the twin of
// vision-surface.h. Input is borrowed only during infer; output remains
// provider-owned until release. Never serialize pointers. Call from the creating
// thread only. Finish producer GPU writes before infer; finish all consumer GPU
// reads before release. This ABI does not invent fences.
extern "C" {
// `compiled_path` is a verified, locally compiled .mlmodelc; `function_name` one
// of its res_WxH functions. One stream state (MLState) per session.
void *loom_depth_create(const char *compiled_path, const char *function_name);
// Packed RGBA bytes (vision-surface.h's transport) ARE the model input: already
// letterboxed into the function's W×H and sRGB-encoded. The result is an RGBA16F
// IOSurface at the output size: R = the model's focal-normalised inverse_depth,
// exactly as returned, G = B = 0, A = 1, un-letterboxed with nearest sampling.
void *loom_depth_infer_packed(void *session, void *input_surface, uint32_t input_width,
  uint32_t input_height, uint32_t output_width, uint32_t output_height);
// Fraction of result pixels with R > 0.
double loom_depth_coverage(void *session);
int loom_depth_release(void *session);
// A new stream: the next frame starts from a fresh MLState, no temporal history.
int loom_depth_reset(void *session);
int loom_depth_destroy(void *session);
const char *loom_depth_error();
}
