# Independent Syphon receiver oracle (T1340)

`syphon-receiver.mm` is a separate native process using the official Metal client.
It discovers one exact server name, rejects duplicate matches, waits for at least
three fresh-frame observations, reads five pixel samples through a GPU blit, and
emits one JSON result. Samples are RGBA byte values at normalized inset corners
(0.1/0.9 in each axis) and the center, with exact integer coordinates included.
The dimensions come from each received texture; 1280×720 and 1920×1080 need no
separate configuration. Only BGRA8Unorm is accepted; unsupported formats fail.

Compile after [building Syphon](syphon-build.md), substituting the returned
framework parent directory:

```sh
clang++ -std=c++17 -fobjc-arc -fblocks \
  src/desktop/testing/syphon-receiver.mm \
  -F /absolute/framework-parent -framework Syphon \
  -framework Foundation -framework Metal \
  -Wl,-rpath,/absolute/framework-parent -o /absolute/syphon-receiver

/absolute/syphon-receiver EXACT_SERVER_NAME 3 15000
```

No DYLD environment variable or global installation is required. The argument
timeout includes discovery and receiving; a separate two-second watchdog margin
catches a stuck native GPU wait. Normal success and ordinary failure stop the
client after submitted GPU work completes. The watchdog exits 1 and explicitly
reports `gpuDrained:false` instead of claiming a cleanup it could not prove.

`ok:true` proves three fresh-frame observations and successful sampled readbacks,
**not correct image content or three distinct pixel values**. The caller must
compare samples with the expected asymmetric graph pattern to prove color and
orientation. Syphon frames can update while a consumer reads; this oracle does
not establish lossless frame delivery or coherent snapshots under publisher
overwrite. Keep producer cadence, frame identity and lifetime stress tests as
separate gates.

Compiled with the pinned arm64 framework and Xcode 26.6. Missing-source (500 ms)
and empty-name checks exit 1 with JSON diagnostics; live peer validation is
reported by the integration track, not assumed from compilation.
