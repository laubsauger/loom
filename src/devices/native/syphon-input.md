# Syphon input addon (T1341)

Electron **main process only**. `syphon-input.mm` uses the pinned official Syphon
framework; no renderer Node API, MCP dependency, CPU pixel transport or global
installation. Compile with the same N-API include directory and Syphon framework
link/rpath flags as the desktop native-output addon, plus Foundation, IOSurface
and Metal. The source is Objective-C++17 with ARC.

## API

```ts
list(): { id: string; name: string; app: string }[];
open(exactUUID: string): string;
acquire(session: string): Promise<null | {
  handle: Buffer; width: number; height: number;
  sequence: number; leaseId: string;
}>;
release(leaseId: string): void;
close(session: string): void;
```

Validation failures throw synchronously; GPU/acquisition completion failures reject
the promise. Use `await` inside `try/catch`. Session/lease IDs are opaque monotonic
tokens within the addon environment. They are never server names or persisted
project IDs. `open` selects the exact discovery UUID; unavailable/duplicate UUIDs
fail. A retired source fails even if the SDK temporarily leaves `isValid` true.

Only tested, packed, non-planar BGRA8 IOSurfaces are accepted. `null` means the
connected source has no new frame. Successful acquire GPU-copies the retained
source texture to a newly owned IOSurface and waits for that GPU copy on a native
worker before returning. There is exactly one busy acquisition **or** issued lease
per session; overlapping acquires fail. Release permits the next acquire. No
automatic dropping of an issued lease, source substitution or format conversion.

Pass `handle` directly as Electron `textureInfo.handle.ioSurface` **in this same
main process**, with pixelFormat `bgra` and the reported dimensions. It contains
the process-local IOSurfaceRef representation, not transferable pointer ownership.
Keep the lease until Electron's `allReferencesReleased` callback; only then call
`release`. A send/receive promise resolving is not that release boundary.

Closing retires the session immediately. It rejects late acquisition completion
and stops its client after pending GPU work drains. Already returned leases remain
valid until explicitly released, even after close. Duplicate release/close is an
explicit diagnostic, not a silent catch. Normal desktop shutdown must retire all
Electron imports and release their leases before destroying the native environment.

The owned copy protects the returned frame from later publisher writes. A retained
Syphon source image does **not** provide a producer-write lock: this implementation
does not claim a coherent snapshot if an independent producer overwrites during
the copy. GPU-loss recovery, Electron import consumption and graph integration
remain separate gates. A stuck native GPU wait stays busy; there is no timeout
which falsely makes the resource reusable.

## Verified native lifecycle test

`experiments/native-texture-bridge/syphon-input-fixture.mm` is a test-only publisher
and CPU sample oracle; it is not part of production ingestion. Compile it with the
same native flags to a separate `.node` file. Then run:

```sh
.cache/electron-v45.0.0-alpha.5/runtime/Electron.app/Contents/MacOS/Electron \
  experiments/native-texture-bridge/syphon-input.test.cjs \
  .cache/syphon-71351d4b484cd2d1917867f7846a5cdca724552d/syphon-input.node \
  .cache/syphon-71351d4b484cd2d1917867f7846a5cdca724552d/syphon-input-fixture.node
```

Those ignored binaries were built on 2026-09-10 against the framework documented
in `experiments/native-texture-bridge/syphon-build.md`; rebuilding uses explicit
paths and does not install anything. The Electron45alpha5 native suite passed
three consecutive runs with 20 checks each: exact UUID lookup, invalid IDs,
1280×720 pixels, subsequent 1920×1080 resize, copy isolation after producer update,
sequence progression, no-new-frame null, overlap rejection, lease retention after
close, duplicate release, closed-session refusal, close during acquisition and
source retirement.

The retirement regression was reproduced before fixing it: the official directory
no longer contained the UUID, but `acquire` still returned no-frame because the
SDK client remained valid. The addon now requires both connection validity and
continued discovery of that exact UUID. The test's overall watchdog remains a
failure, not an accepted recovery path.
