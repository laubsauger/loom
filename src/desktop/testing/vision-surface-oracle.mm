// Test-only image decoding and CPU readback. Not linked into the provider build.
#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#include <cmath>
#include <algorithm>
#include <stdint.h>
#include "../../devices/native/vision-surface.h"

extern "C" void *oracle_input(const char *path, bool blank) {
  @autoreleasepool {
    CIImage *image = blank ? [[CIImage imageWithColor:[CIColor colorWithRed:0.5 green:0.5 blue:0.5]] imageByCroppingToRect:CGRectMake(0,0,1280,720)]
      : [CIImage imageWithContentsOfURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]]];
    if (!image) return nullptr;
    CVPixelBufferRef buffer = nullptr;
    NSDictionary *attrs = @{(id)kCVPixelBufferIOSurfacePropertiesKey: @{}, (id)kCVPixelBufferMetalCompatibilityKey: @YES};
    if (CVPixelBufferCreate(kCFAllocatorDefault, image.extent.size.width, image.extent.size.height,
      kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attrs, &buffer) != kCVReturnSuccess) return nullptr;
    CIContext *context = [CIContext contextWithMTLDevice:MTLCreateSystemDefaultDevice()];
    [context render:image toCVPixelBuffer:buffer];
    IOSurfaceRef surface = CVPixelBufferGetIOSurface(buffer);
    if (surface) CFRetain(surface);
    CVPixelBufferRelease(buffer);
    return surface;
  }
}
extern "C" void oracle_release_input(void *surface) { CFRelease(surface); }
extern "C" void *oracle_unsupported_input() {
  return IOSurfaceCreate((__bridge CFDictionaryRef)@{
    (id)kIOSurfaceWidth: @64, (id)kIOSurfaceHeight: @64,
    (id)kIOSurfaceBytesPerElement: @8, (id)kIOSurfaceBytesPerRow: @512,
    (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_64RGBAHalf)
  });
}
struct OracleStats { uint32_t width, height; double maxError; uint64_t foreground; };
static int verify(void *session, void *result, OracleStats *stats, bool expanded) {
  auto mask = static_cast<CVPixelBufferRef>(loom_vision_test_mask(session));
  auto surface = static_cast<IOSurfaceRef>(result);
  if (!mask || !surface || !stats || IOSurfaceGetPixelFormat(surface) != kCVPixelFormatType_64RGBAHalf) return -1;
  const size_t mw = CVPixelBufferGetWidth(mask), mh = CVPixelBufferGetHeight(mask);
  const size_t w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface);
  if (!expanded && (w != mw || h != mh)) return -1;
  size_t bandW = mw, bandH = mh;
  if (expanded) {
    const double aspect = double(w) / h;
    if (aspect > double(mw) / mh) bandH = std::max(size_t(1), size_t(std::round(mw / aspect)));
    else if (aspect < double(mw) / mh) bandW = std::max(size_t(1), size_t(std::round(mh * aspect)));
  }
  const size_t offX = (mw - bandW) / 2, offY = (mh - bandH) / 2;
  if (CVPixelBufferLockBaseAddress(mask, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return -1;
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) {
    CVPixelBufferUnlockBaseAddress(mask, kCVPixelBufferLock_ReadOnly); return -1;
  }
  *stats = {(uint32_t)w, (uint32_t)h, 0, 0};
  bool valid = true;
  for (size_t y = 0; y < h; y++) {
    const size_t sy = offY + std::min(bandH - 1, size_t(std::floor(double(y) / h * bandH)));
    auto reference = static_cast<uint8_t *>(CVPixelBufferGetBaseAddress(mask)) + sy * CVPixelBufferGetBytesPerRow(mask);
    auto pixels = reinterpret_cast<__fp16 *>(static_cast<uint8_t *>(IOSurfaceGetBaseAddress(surface)) + y * IOSurfaceGetBytesPerRow(surface));
    for (size_t x = 0; x < w; x++) {
      const size_t sx = offX + std::min(bandW - 1, size_t(std::floor(double(x) / w * bandW)));
      const double expected = double(reference[sx]) / 255.0;
      if (reference[sx] >= 128) stats->foreground++;
      for (size_t c = 0; c < 4; c++) {
        const double actual = pixels[x * 4 + c];
        const double error = std::abs(actual - (c == 3 ? 1.0 : expected));
        if (!std::isfinite(actual) || actual < 0 || actual > 1 || error > 0.00025) valid = false;
        stats->maxError = std::max(stats->maxError, error);
      }
    }
  }
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, nullptr);
  CVPixelBufferUnlockBaseAddress(mask, kCVPixelBufferLock_ReadOnly);
  return valid ? 0 : -1;
}
extern "C" int oracle_verify(void *session, void *result, OracleStats *stats) { return verify(session, result, stats, false); }
extern "C" int oracle_verify_expanded(void *session, void *result, OracleStats *stats) { return verify(session, result, stats, true); }

// Independent CPU packing oracle for the Metal unpacker. This is NEVER linked
// into the provider/service; the real app packs its existing buffer on WebGPU.
extern "C" void *oracle_pack_input(void *input) {
  auto source = static_cast<IOSurfaceRef>(input);
  const size_t w = IOSurfaceGetWidth(source), h = IOSurfaceGetHeight(source), ph = (h * 4 + 2) / 3;
  auto packed = IOSurfaceCreate((__bridge CFDictionaryRef)@{
    (id)kIOSurfaceWidth: @(w), (id)kIOSurfaceHeight: @(ph), (id)kIOSurfaceBytesPerElement: @4,
    (id)kIOSurfaceBytesPerRow: @(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, w * 4)),
    (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA)
  });
  if (!packed) return nullptr;
  if (IOSurfaceLock(source, kIOSurfaceLockReadOnly, nullptr) != kIOReturnSuccess) { CFRelease(packed); return nullptr; }
  if (IOSurfaceLock(packed, 0, nullptr) != kIOReturnSuccess) {
    IOSurfaceUnlock(source, kIOSurfaceLockReadOnly, nullptr); CFRelease(packed); return nullptr;
  }
  const size_t channels[] = {2, 1, 0, 3};
  for (size_t pixel = 0; pixel < w * ph; pixel++) {
    auto dest = static_cast<uint8_t *>(IOSurfaceGetBaseAddress(packed)) + pixel / w * IOSurfaceGetBytesPerRow(packed) + pixel % w * 4;
    dest[3] = 255;
    for (size_t c = 0; c < 3; c++) {
      const size_t index = pixel * 3 + c, p = index / 4;
      auto src = static_cast<uint8_t *>(IOSurfaceGetBaseAddress(source)) + p / w * IOSurfaceGetBytesPerRow(source) + p % w * 4;
      dest[channels[c]] = index < w * h * 4 ? src[channels[index % 4]] : 0;
    }
  }
  IOSurfaceUnlock(packed, 0, nullptr); IOSurfaceUnlock(source, kIOSurfaceLockReadOnly, nullptr);
  return packed;
}
extern "C" uint32_t oracle_width(void *surface) { return IOSurfaceGetWidth(static_cast<IOSurfaceRef>(surface)); }
extern "C" uint32_t oracle_height(void *surface) { return IOSurfaceGetHeight(static_cast<IOSurfaceRef>(surface)); }
