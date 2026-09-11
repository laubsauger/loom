# Pinned Syphon build (T1339)

Run `node src/devices/native/syphon-build.mjs` on Apple Silicon with
Xcode available. Importing `ensureSyphonFramework()` from that module does not run
anything; calling it synchronously returns the built `.framework` path. The
function verifies the cached archive and reuses a content-verified framework for
the same pinned source, architecture, Xcode and SDK. Changed artifacts fail
explicitly. New builds discard disposable compiler intermediates; complete
frameworks, source, licenses, logs and manifests remain. The returned path is not
a packaged installation location. Desktop smoke/export profiles and native addon
temporary directories are removed after their processes finish, including failures.

Official main checked 2026-09-10:
[71351d4b484cd2d1917867f7846a5cdca724552d](https://github.com/Syphon/Syphon-Framework/commit/71351d4b484cd2d1917867f7846a5cdca724552d),
committed 2025-10-06. Archive SHA-256:
`9196aceb663bc87a3d9981fb993135cafb23a7df7a832d4cac5138925b6bbb1d`.
Acquisition uses the official codeload archive, not Git operations. Nothing is
installed globally, signed, registered as a driver, or downloaded from NDI.

Verified scripted build: Xcode 26.6 (17F113), macOS SDK 26.5, Release, arm64 only,
`CODE_SIGNING_ALLOWED=NO`. Build passed; architecture, Metal library and public
Metal client/server headers verified. Upstream deprecation warnings remain in
`xcodebuild.log`; they were not suppressed or patched away.

Concrete verified artifact (relative to repository root):

```text
.cache/syphon-71351d4b484cd2d1917867f7846a5cdca724552d/run-dQXsBm/build/Build/Products/Release/Syphon.framework
```

Public headers are `Headers/SyphonMetalServer.h`, `Headers/SyphonMetalClient.h`
and `Headers/Syphon.h` below that framework. Preserve the **whole framework**,
including `Resources/default.metallib`; the Metal server loads that bundled
library during initialization. Link native code using `-F <framework-parent>
-framework Syphon` and an explicit matching runtime search path for development.
Packaged app embedding/rpath/signing remains a separate release task.

## Publisher lifecycle

Minimal calls below are an integration sketch, not a passed peer-to-peer test:

```objc
#import <Syphon/Syphon.h>

// Create on the app's native main thread; keep Cocoa event delivery alive.
SyphonMetalServer *server = [[SyphonMetalServer alloc]
    initWithName:@"Loom Output" device:device options:nil];
if (!server) { /* surface an initialization error */ }

// In the owned serial GPU work path, after producer readiness is established:
id<MTLCommandBuffer> commands = [queue commandBuffer];
[server publishFrameTexture:texture
           onCommandBuffer:commands
               imageRegion:NSMakeRect(0, 0, texture.width, texture.height)
                   flipped:NO];
// Retain server, source texture AND its Electron/native lease until completion.
// Install completion accounting before commit; inspect commands.error/status.
[commands commit];

// At shutdown: stop submissions, drain completion accounting, then stop server.
[server stop];
```

The server starts immediately; `hasClients` reports attached receivers. One
server represents one named output. The implementation creates BGRA8 IOSurface
storage, directly blits matching non-flipped textures, otherwise renders a
conversion. It announces a new frame in a command-buffer completion handler.
This baseline is SDR8, not float-preserving transport.

**Do not follow the header's early-reuse wording literally.** The method only
encodes GPU work; another process must not overwrite the source before GPU
completion. Hold the incoming Electron frame lease through that completion.
`flipped:NO` preserves rows in the BGRA8 blit path and is the expected choice
for the Chromium/Metal surface path. Confirm with asymmetric corner pixels in
an independent receiver; framework build success alone proves no orientation,
latency, discovery or end-to-end delivery claim.

## License notices

The acquired root `License.txt` has **three BSD-style clauses**, including
non-endorsement. Some Metal source headers have two clauses. Preserve the root
terms and per-file notices rather than relabeling the entire framework as
two-clause BSD. The script copies the root license to `Syphon-License.txt` next
to the build and keeps the original source and header notices intact. Shipping
the framework requires carrying those notices in distribution materials.
