// CPU-only test fixture. Never imported by the application or production addon.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <cstring>

NAPI_MODULE_INIT() {
  @autoreleasepool {
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @4, (id)kIOSurfaceHeight: @4,
      (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @((uint32_t)0x42475241) });
    if (!surface) { napi_throw_error(env, nullptr, "Cannot create test IOSurface"); return nullptr; }
    if (IOSurfaceLock(surface, 0, nullptr) != kIOReturnSuccess) {
      CFRelease(surface); napi_throw_error(env, nullptr, "Cannot lock test IOSurface"); return nullptr;
    }
    void *pixels = IOSurfaceGetBaseAddress(surface);
    if (pixels) std::memset(pixels, 255, IOSurfaceGetAllocSize(surface));
    const auto unlocked = IOSurfaceUnlock(surface, 0, nullptr);
    if (!pixels || unlocked != kIOReturnSuccess) {
      CFRelease(surface); napi_throw_error(env, nullptr, "Invalid test IOSurface storage"); return nullptr;
    }
    napi_value handle;
    if (napi_create_buffer_copy(env, sizeof(surface), &surface, nullptr, &handle) != napi_ok ||
        napi_add_finalizer(env, handle, surface,
          [](napi_env, void *data, void *) { CFRelease(data); }, nullptr, nullptr) != napi_ok) {
      CFRelease(surface); napi_throw_error(env, nullptr, "Cannot retain test IOSurface handle"); return nullptr;
    }
    if (napi_set_named_property(env, exports, "handle", handle) != napi_ok) {
      napi_throw_error(env, nullptr, "Cannot export test IOSurface handle"); return nullptr;
    }
    return exports;
  }
}
