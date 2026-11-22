#include "native-service.h"
#include "depth-surface.h"

namespace { struct Model { const char *compiled, *function; }; }

// T1818b: the Depth Pro 2 worker entry. The same serve loop as Person Mask
// (vision-service.mm, built with LOOM_NATIVE_SERVICE_ONLY), so tokens, ordering
// and leases are one implementation and vision-client.mm drives both kinds.
extern "C" int loom_depth_serve(const char *name, const char *secret, const char *compiled, const char *function) {
  const Model model{compiled, function};
  const LoomNativeProvider depth = { "Depth", "DEPTH", [](const void *context) {
      auto m = static_cast<const Model *>(context); return loom_depth_create(m->compiled, m->function);
    }, &model, nullptr, loom_depth_infer_packed, loom_depth_coverage, loom_depth_release, loom_depth_reset,
    loom_depth_destroy, loom_depth_error };
  return loom_native_serve(name, secret, &depth);
}
