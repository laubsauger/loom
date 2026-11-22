// Test-only image adapter for depth-smoke.mjs (T1818b). Never linked with the
// service or vision-client.node: it is the renderer's side of the packed input
// transport, and a CPU reader for result surfaces, so the smoke can check them.
#include <node_api.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace {
void check(napi_status s) { if (s != napi_ok) throw std::runtime_error("Depth fixture N-API failure"); }
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
IOSurfaceRef pointer(napi_env env, napi_value value) {
  void *data; size_t size; IOSurfaceRef surface;
  check(napi_get_buffer_info(env, value, &data, &size)); require(size == sizeof(surface), "Invalid fixture handle");
  memcpy(&surface, data, size); require(surface != nullptr, "Missing fixture surface"); return surface;
}
uint32_t integer(napi_env env, napi_value value) { uint32_t v; check(napi_get_value_uint32(env, value, &v)); return v; }
// Exactly NATIVE_INPUT_PACK_WGSL: transport pixel (x, y) carries model-input bytes
// [(y·W + x)·3, +3) of the RGBA stream in its R, G, B; alpha is opaque.
napi_value packed(napi_env env, napi_value *args) {
  void *data; size_t size; check(napi_get_buffer_info(env, args[0], &data, &size));
  const uint32_t width = integer(env, args[1]), height = integer(env, args[2]);
  require(width && height && size == size_t(width) * height * 4, "Fixture RGBA length does not match its size");
  const uint32_t rows = (height * 4 + 2) / 3;
  IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
    (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(rows), (id)kIOSurfaceBytesPerElement: @4,
    (id)kIOSurfaceBytesPerRow: @(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, width * 4)),
    (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA) });
  require(surface != nullptr, "Cannot allocate fixture input");
  require(IOSurfaceLock(surface, 0, nullptr) == kIOReturnSuccess, "Cannot lock fixture input");
  auto base = static_cast<uint8_t *>(IOSurfaceGetBaseAddress(surface));
  const size_t stride = IOSurfaceGetBytesPerRow(surface), total = size_t(width) * height * 4;
  auto bytes = static_cast<const uint8_t *>(data);
  for (uint32_t y = 0; y < rows; y++) for (uint32_t x = 0; x < width; x++) {
    const size_t index = (size_t(y) * width + x) * 3;
    uint8_t channel[3];
    for (int k = 0; k < 3; k++) channel[k] = index + k < total ? bytes[index + k] : 0;
    uint8_t *pixel = base + y * stride + x * 4;
    pixel[0] = channel[2]; pixel[1] = channel[1]; pixel[2] = channel[0]; pixel[3] = 255;
  }
  IOSurfaceUnlock(surface, 0, nullptr);
  napi_value handle; check(napi_create_buffer_copy(env, sizeof(surface), &surface, nullptr, &handle));
  return handle;
}
// R as float32, and whether every pixel is exactly (R, 0, 0, 1).
napi_value read(napi_env env, napi_value *args) {
  IOSurfaceRef surface = pointer(env, args[0]);
  require(IOSurfaceGetPixelFormat(surface) == kCVPixelFormatType_64RGBAHalf, "Result is not RGBA16F");
  const size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface);
  require(IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) == kIOReturnSuccess, "Cannot lock result");
  auto base = static_cast<const uint8_t *>(IOSurfaceGetBaseAddress(surface));
  const size_t stride = IOSurfaceGetBytesPerRow(surface);
  void *values; napi_value array, buffer;
  check(napi_create_arraybuffer(env, width * height * 4, &values, &buffer));
  bool exact = true;
  for (size_t y = 0; y < height; y++) {
    auto row = reinterpret_cast<const _Float16 *>(base + y * stride);
    for (size_t x = 0; x < width; x++) {
      static_cast<float *>(values)[y * width + x] = float(row[x * 4]);
      exact = exact && row[x * 4 + 1] == 0 && row[x * 4 + 2] == 0 && row[x * 4 + 3] == 1;
    }
  }
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
  check(napi_create_typedarray(env, napi_float32_array, width * height, buffer, 0, &array));
  napi_value result, w, h, channels;
  check(napi_create_object(env, &result));
  check(napi_create_uint32(env, uint32_t(width), &w)); check(napi_create_uint32(env, uint32_t(height), &h));
  check(napi_get_boolean(env, exact, &channels));
  check(napi_set_named_property(env, result, "width", w)); check(napi_set_named_property(env, result, "height", h));
  check(napi_set_named_property(env, result, "values", array)); check(napi_set_named_property(env, result, "channelsExact", channels));
  return result;
}
napi_value call(napi_env env, napi_callback_info info) {
  try {
    napi_value args[3]; size_t count = 3; void *data;
    check(napi_get_cb_info(env, info, &count, args, nullptr, &data));
    const char *op = static_cast<const char *>(data);
    if (strcmp(op, "packed") == 0) { require(count == 3, "packed(rgba, width, height)"); return packed(env, args); }
    if (strcmp(op, "read") == 0) { require(count == 1, "read(handle)"); return read(env, args); }
    require(count == 1, "release(handle)");
    CFRelease(pointer(env, args[0]));
    napi_value undefined; check(napi_get_undefined(env, &undefined)); return undefined;
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"packed", nullptr, call, nullptr, nullptr, nullptr, napi_default, (void *)"packed"},
    {"read", nullptr, call, nullptr, nullptr, nullptr, napi_default, (void *)"read"},
    {"release", nullptr, call, nullptr, nullptr, nullptr, napi_default, (void *)"release"},
  };
  check(napi_define_properties(env, exports, 3, methods)); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
