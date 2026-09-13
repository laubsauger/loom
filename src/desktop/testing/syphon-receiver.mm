// T1340: independent native receiver/readback oracle, not a production input node.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include <cstdlib>
#include <cstdio>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <algorithm>
#include <cmath>
#include <vector>
#include <sys/resource.h>

static long peakRssBytes() {
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage) != 0) throw std::runtime_error("Cannot inspect receiver memory");
  return usage.ru_maxrss; // macOS reports bytes, unlike Linux's KiB.
}

static void report(NSDictionary *value) {
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!json) { fprintf(stderr, "JSON serialization failed\n"); return; }
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    const bool animatedMode = argc > 2 && std::string(argv[2]) == "--animated-seconds";
    const bool durationMode = animatedMode || (argc > 2 && std::string(argv[2]) == "--seconds");
    if (argc < 2 || (durationMode ? argc != 5 : argc > 4)) {
      fprintf(stderr, "Usage: syphon-receiver EXACT_SERVER_NAME [FRAME_COUNT>=3] [TIMEOUT_MS]\n"
        "       syphon-receiver EXACT_SERVER_NAME --seconds DURATION_SECONDS TIMEOUT_MS\n"
        "       syphon-receiver EXACT_SERVER_NAME --animated-seconds DURATION_SECONDS TIMEOUT_MS\n");
      return 1;
    }
    SyphonMetalClient *client = nil;
    NSMutableArray *frames = [NSMutableArray array];
    NSMutableArray *discovered = [NSMutableArray array];
    NSDictionary *identity = nil;
    try {
      const std::string nameArg(argv[1]);
      if (nameArg.empty()) throw std::runtime_error("Sender name must not be empty");
      auto integer = [](const char *text, int minimum, int maximum) {
        char *end = nullptr;
        long value = strtol(text, &end, 10);
        if (!*text || *end || value < minimum || value > maximum)
          throw std::runtime_error("Invalid bounded integer argument");
        return (int)value;
      };
      const int seconds = durationMode ? integer(argv[3], 1, 600) : 0;
      const int count = durationMode ? 0 : argc > 2 ? integer(argv[2], 3, 1000) : 3;
      const int timeoutMs = durationMode ? integer(argv[4], seconds * 1000 + 1000, 620000)
        : argc > 3 ? integer(argv[3], 100, 120000) : 15000;
      NSUInteger frameCount = 0;
      uint32_t firstFrameId = 0, lastFrameId = 0;
      NSUInteger uniqueFrames = 0, repeatedFrames = 0, skippedFrames = 0;
      long initialPeakRss = 0;
      NSTimeInterval firstConsumed = 0, lastConsumed = 0;
      std::vector<double> intervals;
      NSString *name = [NSString stringWithUTF8String:argv[1]];
      if (!name) throw std::runtime_error("Sender name is not UTF-8");
      // Last-resort watchdog includes a stuck GPU wait. It cannot claim a drain.
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutMs + 2000) * NSEC_PER_MSEC),
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
          const char *message = "{\"ok\":false,\"error\":\"receiver watchdog expired\",\"gpuDrained\":false}\n";
          fputs(message, stderr); fflush(stderr); _Exit(1);
        });
      id<MTLDevice> device = MTLCreateSystemDefaultDevice();
      id<MTLCommandQueue> queue = [device newCommandQueue];
      if (!device || !queue) throw std::runtime_error("Metal unavailable");
      SyphonServerDirectory *directory = [SyphonServerDirectory sharedDirectory];
      const NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + timeoutMs / 1000.0;
      while (durationMode ? frameCount < 3 || lastConsumed - firstConsumed < seconds : frameCount < (NSUInteger)count) {
        @autoreleasepool {
          if (NSProcessInfo.processInfo.systemUptime >= deadline)
            throw std::runtime_error("Timed out discovering sender or receiving fresh frames");
          if (!client) {
            NSArray *matches = [directory serversMatchingName:name appName:nil];
            [discovered removeAllObjects];
            for (NSDictionary *server in directory.servers) {
              [discovered addObject:@{ @"name": server[SyphonServerDescriptionNameKey] ?: @"",
                @"uuid": server[SyphonServerDescriptionUUIDKey] ?: @"" }];
            }
            if (matches.count > 1) throw std::runtime_error("Exact sender name is ambiguous");
            if (matches.count == 1) {
              NSDictionary *server = matches[0];
              identity = @{ @"name": server[SyphonServerDescriptionNameKey] ?: @"",
                @"uuid": server[SyphonServerDescriptionUUIDKey] ?: @"",
                @"app": server[SyphonServerDescriptionAppNameKey] ?: @"" };
              client = [[SyphonMetalClient alloc] initWithServerDescription:server
                device:device options:nil newFrameHandler:nil];
              if (!client || !client.isValid) throw std::runtime_error("Syphon client initialization failed");
            }
          }
          if (client && !client.isValid) throw std::runtime_error("Selected sender disconnected");
          if (client.hasNewFrame) {
            id<MTLTexture> source = [client newFrameImage];
            if (!source || !source.width || !source.height) throw std::runtime_error("Missing frame texture");
            if (source.pixelFormat != MTLPixelFormatBGRA8Unorm)
              throw std::runtime_error("Receiver oracle requires BGRA8Unorm");
            const NSUInteger width = source.width, height = source.height;
            // Four inset corners plus center: valid at 720p, 1080p and other sizes.
            NSUInteger points[24][2] = {
              { width / 10, height / 10 }, { width * 9 / 10, height / 10 },
              { width / 10, height * 9 / 10 }, { width * 9 / 10, height * 9 / 10 },
              { width / 2, height / 2 }
            };
            const int sampleCount = animatedMode ? 24 : 5;
            if (animatedMode) {
              if (width < 24) throw std::runtime_error("Animated receiver requires at least 24 pixel columns");
              // Bit zero occupies the left vertical bar. Sample its center,
              // avoiding boundaries even when width is not divisible by 24.
              for (int i = 0; i < sampleCount; i++) {
                points[i][0] = width * (2 * i + 1) / 48;
                points[i][1] = height / 2;
              }
            }
            id<MTLBuffer> pixels = [device newBufferWithLength:sampleCount * 256 options:MTLResourceStorageModeShared];
            id<MTLCommandBuffer> command = [queue commandBuffer];
            id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
            if (!pixels || !command || !blit) throw std::runtime_error("Cannot allocate GPU readback");
            for (int i = 0; i < sampleCount; i++) {
              [blit copyFromTexture:source sourceSlice:0 sourceLevel:0
                sourceOrigin:MTLOriginMake(points[i][0], points[i][1], 0)
                sourceSize:MTLSizeMake(1, 1, 1) toBuffer:pixels destinationOffset:i * 256
                destinationBytesPerRow:256 destinationBytesPerImage:256];
            }
            [blit endEncoding]; [command commit]; [command waitUntilCompleted];
            if (command.status != MTLCommandBufferStatusCompleted)
              throw std::runtime_error(command.error ? command.error.localizedDescription.UTF8String : "GPU readback failed");
            if (durationMode) {
              const NSTimeInterval consumed = NSProcessInfo.processInfo.systemUptime;
              if (frameCount == 0) { firstConsumed = consumed; initialPeakRss = peakRssBytes(); }
              else {
                if (intervals.size() >= 200000) throw std::runtime_error("Receiver interval sample limit exceeded");
                intervals.push_back((consumed - lastConsumed) * 1000.0);
              }
              lastConsumed = consumed;
            }
            NSMutableArray *samples = [NSMutableArray array];
            uint32_t frameId = 0;
            for (int i = 0; i < sampleCount; i++) {
              auto bytes = (const unsigned char *)pixels.contents + i * 256;
              if (animatedMode) {
                if ((bytes[0] != 0 && bytes[0] != 255) || bytes[1] != bytes[0]
                    || bytes[2] != bytes[0] || bytes[3] != 255)
                  throw std::runtime_error("Animated receiver barcode must be exact black/white opaque RGBA");
                if (bytes[0] == 255) frameId |= uint32_t(1) << i;
              }
              [samples addObject:@{ @"x": @(points[i][0]), @"y": @(points[i][1]),
                @"rgba": @[@(bytes[2]), @(bytes[1]), @(bytes[0]), @(bytes[3])] }];
            }
            NSMutableDictionary *frame = [@{ @"index": @(frameCount), @"width": @(width),
              @"height": @(height), @"format": @"bgra8unorm", @"samples": samples } mutableCopy];
            if (animatedMode) {
              if (frameCount && frameId < lastFrameId)
                throw std::runtime_error("Animated receiver frame ID regressed or wrapped");
              if (!frameCount) { firstFrameId = frameId; uniqueFrames = 1; }
              else if (frameId == lastFrameId) repeatedFrames++;
              else { uniqueFrames++; skippedFrames += frameId - lastFrameId - 1; }
              lastFrameId = frameId;
              frame[@"frameId"] = @(frameId);
            }
            if (durationMode && frames.count) {
              if (![frame[@"width"] isEqual:frames[0][@"width"]] || ![frame[@"height"] isEqual:frames[0][@"height"]])
                throw std::runtime_error("Receiver fixture changed dimensions");
              if (!animatedMode && ![samples isEqual:frames[0][@"samples"]])
                throw std::runtime_error("Static receiver fixture changed sampled pixels");
            }
            if (durationMode && frames.count == 2) frames[1] = frame;
            else [frames addObject:frame];
            frameCount++;
          }
          [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
        }
      }
      // Each submitted command was completed above; stop only after that drain.
      [client stop];
      if (durationMode) {
        const double elapsed = lastConsumed - firstConsumed;
        std::sort(intervals.begin(), intervals.end());
        const auto percentile = [&](double fraction) { return intervals[(size_t)std::ceil(intervals.size() * fraction) - 1]; };
        // Cadence includes GPU readback on every frame (five static samples or
        // 24 animated stripes). It does not measure end-to-end latency.
        NSMutableDictionary *result = [@{ @"ok": @YES, @"gpuDrained": @YES, @"server": identity,
          @"frames": frames, @"frameCount": @(frameCount), @"elapsedSeconds": @(elapsed),
          @"receiveFps": @((frameCount - 1) / elapsed),
          @"peakRssStartBytes": @(initialPeakRss), @"peakRssEndBytes": @(peakRssBytes()),
          @"intervalP50Ms": @(percentile(0.50)), @"intervalP95Ms": @(percentile(0.95)) } mutableCopy];
        if (animatedMode) {
          [result addEntriesFromDictionary:@{ @"firstFrameId": @(firstFrameId), @"lastFrameId": @(lastFrameId),
            @"uniqueFrames": @(uniqueFrames), @"repeatedFrames": @(repeatedFrames),
            @"skippedFrames": @(skippedFrames), @"uniqueFps": @((uniqueFrames - 1) / elapsed) }];
        }
        report(result);
      } else {
        report(@{ @"ok": @YES, @"gpuDrained": @YES, @"server": identity,
          @"frames": frames, @"frameCount": @(frames.count) });
      }
      return 0;
    } catch (const std::exception &error) {
      [client stop];
      report(@{ @"ok": @NO, @"error": [NSString stringWithUTF8String:error.what()],
        @"frames": frames, @"discovered": discovered, @"gpuDrained": @YES });
      return 1;
    }
  }
}
