// T1340: independent native receiver/readback oracle, not a production input node.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include <cstdlib>
#include <cstdio>
#include <stdexcept>
#include <string>

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
    if (argc < 2 || argc > 4) {
      fprintf(stderr, "Usage: syphon-receiver EXACT_SERVER_NAME [FRAME_COUNT>=3] [TIMEOUT_MS]\n");
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
      const int count = argc > 2 ? integer(argv[2], 3, 1000) : 3;
      const int timeoutMs = argc > 3 ? integer(argv[3], 100, 120000) : 15000;
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
      while ((int)frames.count < count) {
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
          const NSUInteger points[5][2] = {
            { width / 10, height / 10 }, { width * 9 / 10, height / 10 },
            { width / 10, height * 9 / 10 }, { width * 9 / 10, height * 9 / 10 },
            { width / 2, height / 2 }
          };
          id<MTLBuffer> pixels = [device newBufferWithLength:5 * 256 options:MTLResourceStorageModeShared];
          id<MTLCommandBuffer> command = [queue commandBuffer];
          id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
          if (!pixels || !command || !blit) throw std::runtime_error("Cannot allocate GPU readback");
          for (int i = 0; i < 5; i++) {
            [blit copyFromTexture:source sourceSlice:0 sourceLevel:0
              sourceOrigin:MTLOriginMake(points[i][0], points[i][1], 0)
              sourceSize:MTLSizeMake(1, 1, 1) toBuffer:pixels destinationOffset:i * 256
              destinationBytesPerRow:256 destinationBytesPerImage:256];
          }
          [blit endEncoding]; [command commit]; [command waitUntilCompleted];
          if (command.status != MTLCommandBufferStatusCompleted)
            throw std::runtime_error(command.error ? command.error.localizedDescription.UTF8String : "GPU readback failed");
          NSMutableArray *samples = [NSMutableArray array];
          for (int i = 0; i < 5; i++) {
            auto bytes = (const unsigned char *)pixels.contents + i * 256;
            [samples addObject:@{ @"x": @(points[i][0]), @"y": @(points[i][1]),
              @"rgba": @[@(bytes[2]), @(bytes[1]), @(bytes[0]), @(bytes[3])] }];
          }
          [frames addObject:@{ @"index": @(frames.count), @"width": @(width),
            @"height": @(height), @"format": @"bgra8unorm", @"samples": samples }];
        }
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
      }
      // Each submitted command was completed above; stop only after that drain.
      [client stop];
      report(@{ @"ok": @YES, @"gpuDrained": @YES, @"server": identity,
        @"frames": frames, @"frameCount": @(frames.count) });
      return 0;
    } catch (const std::exception &error) {
      [client stop];
      report(@{ @"ok": @NO, @"error": [NSString stringWithUTF8String:error.what()],
        @"frames": frames, @"discovered": discovered, @"gpuDrained": @YES });
      return 1;
    }
  }
}
