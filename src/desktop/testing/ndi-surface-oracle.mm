#include <cstddef>
#include <Processing.NDI.Lib.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#include <array>
#include <cstring>
#include <stdexcept>

namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
struct Surface {
  IOSurfaceRef value;
  ~Surface() { if (value) CFRelease(value); }
};
struct Context {
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  id<MTLCommandQueue> queue = [device newCommandQueue];
  Context() { require(device && queue, "NDI GPU oracle requires Metal"); }
};
}

// Test-only synchronous oracle, not a production receive-thread implementation.
// One explicit CPU row copy into an owned IOSurface. On Apple Silicon the Metal
// texture shares that allocation; decoder memory is never leased to Chromium.
void validateNdiGpuSurface(const NDIlib_video_frame_v2_t& frame) {
  @autoreleasepool {
    static Context context;
    const size_t width = frame.xres, height = frame.yres;
    require(width == 1920 && height == 1080 && frame.p_data, "Unexpected NDI GPU oracle frame");
    Surface surface{IOSurfaceCreate((__bridge CFDictionaryRef)@{
      (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
      (id)kIOSurfaceBytesPerElement: @4,
      (id)kIOSurfacePixelFormat: @((uint32_t)0x42475241),
    })};
    require(surface.value, "NDI GPU oracle surface allocation failed");
    require(IOSurfaceLock(surface.value, 0, nullptr) == kIOReturnSuccess, "NDI GPU oracle surface lock failed");
    auto* target = static_cast<uint8_t*>(IOSurfaceGetBaseAddress(surface.value));
    const size_t targetStride = IOSurfaceGetBytesPerRow(surface.value);
    if (!target || targetStride < width * 4) {
      IOSurfaceUnlock(surface.value, 0, nullptr);
      throw std::runtime_error("NDI GPU oracle invalid surface storage");
    }
    for (size_t y = 0; y < height; y++) {
      auto* row = target + y * targetStride;
      std::memcpy(row, frame.p_data + y * frame.line_stride_in_bytes, width * 4);
      // X is explicitly unused in BGRX; the imported BGRA surface must be opaque.
      if (frame.FourCC == NDIlib_FourCC_video_type_BGRX)
        for (size_t x = 0; x < width; x++) row[x * 4 + 3] = 255;
    }
    require(IOSurfaceUnlock(surface.value, 0, nullptr) == kIOReturnSuccess, "NDI GPU oracle surface unlock failed");
    auto* descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:width height:height mipmapped:NO];
    descriptor.storageMode = MTLStorageModeShared;
    id<MTLTexture> texture = [context.device newTextureWithDescriptor:descriptor iosurface:surface.value plane:0];
    require(texture != nil, "NDI GPU oracle could not bind IOSurface to Metal");
    std::array<MTLOrigin, 66> points;
    for (size_t bit = 0; bit < 32; bit++) {
      points[bit * 2] = MTLOriginMake((2 * bit + 1) * width / 64, height / 8, 0);
      points[bit * 2 + 1] = MTLOriginMake((2 * bit + 1) * width / 64, 3 * height / 8, 0);
    }
    points[64] = MTLOriginMake(width / 4, 3 * height / 4, 0);
    points[65] = MTLOriginMake(3 * width / 4, 3 * height / 4, 0);
    id<MTLBuffer> readback = [context.device newBufferWithLength:points.size() * 256 options:MTLResourceStorageModeShared];
    id<MTLCommandBuffer> command = [context.queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
    require(readback && command && blit, "NDI GPU oracle command allocation failed");
    for (size_t index = 0; index < points.size(); index++)
      [blit copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:points[index]
        sourceSize:MTLSizeMake(1, 1, 1) toBuffer:readback destinationOffset:index * 256
        destinationBytesPerRow:256 destinationBytesPerImage:256];
    [blit endEncoding]; [command commit]; [command waitUntilCompleted];
    require(command.status == MTLCommandBufferStatusCompleted, "NDI GPU oracle blit failed");
    const auto* actual = static_cast<const uint8_t*>(readback.contents);
    for (size_t index = 0; index < points.size(); index++) {
      const auto point = points[index];
      const auto* expected = frame.p_data + point.y * frame.line_stride_in_bytes + point.x * 4;
      require(std::memcmp(actual + index * 256, expected, 3) == 0, "NDI GPU surface changed decoded RGB bytes");
      const uint8_t alpha = frame.FourCC == NDIlib_FourCC_video_type_BGRX ? 255 : expected[3];
      require(actual[index * 256 + 3] == alpha, "NDI GPU surface changed alpha");
    }
    // Surface and texture outlive the completed GPU read; no decoder pointer is retained.
  }
}
