// Test-only native image/reference adapter. Never linked with vision-client.node.
#include <node_api.h>
#import <IOSurface/IOSurface.h>
#include <stdexcept>
#include <vector>
#include "../../devices/native/vision-surface.h"
extern "C" void *oracle_input(const char *, bool);
extern "C" void oracle_release_input(void *);
struct OracleStats { uint32_t width, height; double maxError; uint64_t foreground; };
extern "C" int oracle_verify(void *, void *, OracleStats *);
extern "C" int oracle_verify_expanded(void *, void *, OracleStats *);
extern "C" void *oracle_pack_input(void *);
extern "C" uint32_t oracle_width(void *);
extern "C" uint32_t oracle_height(void *);
void *reference;
void check(napi_status s) { if (s != napi_ok) throw std::runtime_error("Vision fixture N-API failure"); }
void require(bool b, const char *e) { if (!b) throw std::runtime_error(e); }
void *pointer(napi_env env, napi_value v) {
  void *data, *result; size_t size;
  check(napi_get_buffer_info(env, v, &data, &size)); require(size == sizeof(result), "Invalid fixture pointer");
  memcpy(&result, data, size); return result;
}
napi_value operation(napi_env env, napi_callback_info info) {
  try {
    napi_value args[3]; size_t count = 3; void *data;
    check(napi_get_cb_info(env, info, &count, args, nullptr, &data));
    const char *op = static_cast<const char *>(data);
    napi_value result; check(napi_get_undefined(env, &result));
    if (strcmp(op, "input") == 0) {
      require(count == 2, "Expected image and blank flag");
      size_t size; check(napi_get_value_string_utf8(env, args[0], nullptr, 0, &size));
      std::vector<char> path(size + 1); check(napi_get_value_string_utf8(env, args[0], path.data(), path.size(), &size));
      bool blank; check(napi_get_value_bool(env, args[1], &blank));
      void *input = oracle_input(path.data(), blank); require(input, "Cannot decode fixture image");
      if (!reference) reference = loom_vision_create();
      require(reference, "Cannot create reference model");
      if (blank) require(loom_vision_reset(reference) == 0, "Cannot reset reference");
      // Evaluate before async inference; verification after resolution only reads
      // the reference mask. Fixture work must not count toward the heartbeat.
      require(loom_vision_infer(reference, input), "Reference inference failed");
      check(napi_create_buffer_copy(env, sizeof(input), &input, nullptr, &result));
    } else if (strcmp(op, "pack") == 0) {
      require(count == 1, "Expected input handle");
      void *input = pointer(env, args[0]);
      void *packed = oracle_pack_input(input); require(packed, "Cannot pack input");
      check(napi_create_object(env, &result));
      napi_value handle, width, height;
      check(napi_create_buffer_copy(env, sizeof(packed), &packed, nullptr, &handle));
      check(napi_create_uint32(env, oracle_width(input), &width));
      check(napi_create_uint32(env, oracle_height(input), &height));
      check(napi_set_named_property(env, result, "handle", handle));
      check(napi_set_named_property(env, result, "width", width));
      check(napi_set_named_property(env, result, "height", height));
    } else if (strcmp(op, "releasePacked") == 0) {
      require(count == 1, "Expected packed input handle");
      oracle_release_input(pointer(env, args[0]));
    } else if (strcmp(op, "verify") == 0 || strcmp(op, "verifyExpanded") == 0) {
      require(count == 1, "Expected output handle");
      OracleStats stats;
      const int verified = strcmp(op, "verifyExpanded") == 0
        ? oracle_verify_expanded(reference, pointer(env, args[0]), &stats)
        : oracle_verify(reference, pointer(env, args[0]), &stats);
      require(verified == 0, "Async Vision pixels differ from reference");
      check(napi_create_double(env, double(stats.foreground) / (stats.width * stats.height), &result));
    } else if (strcmp(op, "release") == 0) {
      require(count == 1, "Expected input handle");
      oracle_release_input(pointer(env, args[0]));
      require(loom_vision_release(reference) == 0, "Reference release failed");
    } else throw std::runtime_error("Unknown fixture operation");
    return result;
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"input", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"input"},
    {"verify", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"verify"},
    {"verifyExpanded", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"verifyExpanded"},
    {"pack", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"pack"},
    {"releasePacked", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"releasePacked"},
    {"release", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"release"}
  };
  check(napi_define_properties(env, exports, 6, methods)); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
