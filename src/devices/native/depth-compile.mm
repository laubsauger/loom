#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#include <cstdio>
#include "depth-surface.h"

// T1818b: compile a verified Depth Pro 2 package once into the native cache, then
// open every function exactly as the worker will (loom_depth_create), so a model
// that compiles but cannot run is refused here and Core ML's caches start warm.
// Usage: depth-compile /abs/model.mlpackage /abs/destination.mlmodelc
static const char *const FUNCTIONS[] = {"res_640x360", "res_854x480", "res_896x512", "res_1138x640", "res_1280x720"};
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') {
      fprintf(stderr, "Usage: depth-compile /absolute/model.mlpackage /absolute/destination.mlmodelc\n"); return 2;
    }
    NSURL *package = [NSURL fileURLWithPath:@(argv[1]) isDirectory:YES];
    NSURL *destination = [NSURL fileURLWithPath:@(argv[2]) isDirectory:YES];
    if ([NSFileManager.defaultManager fileExistsAtPath:destination.path]) {
      fprintf(stderr, "DEPTH_COMPILE_FAILED destination already exists\n"); return 1;
    }
    __block NSURL *compiled = nil;
    __block NSError *failure = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [MLModel compileModelAtURL:package completionHandler:^(NSURL *url, NSError *error) {
      compiled = url; failure = error; dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    if (!compiled) {
      fprintf(stderr, "DEPTH_COMPILE_FAILED %s\n", failure ? failure.localizedDescription.UTF8String : "no compiled model"); return 1;
    }
    NSError *error = nil;
    if (![NSFileManager.defaultManager moveItemAtURL:compiled toURL:destination error:&error]) {
      fprintf(stderr, "DEPTH_COMPILE_FAILED %s\n", error.localizedDescription.UTF8String); return 1;
    }
    for (const char *function : FUNCTIONS) {
      void *session = loom_depth_create(destination.path.UTF8String, function);
      if (!session) { fprintf(stderr, "DEPTH_COMPILE_FAILED %s: %s\n", function, loom_depth_error()); return 1; }
      if (loom_depth_destroy(session) != 0) { fprintf(stderr, "DEPTH_COMPILE_FAILED %s\n", loom_depth_error()); return 1; }
    }
    printf("{\"kind\":\"compiled\",\"functions\":[");
    for (size_t i = 0; i < sizeof(FUNCTIONS) / sizeof(*FUNCTIONS); i++) printf("%s\"%s\"", i ? "," : "", FUNCTIONS[i]);
    printf("]}\n");
    return 0;
  }
}
