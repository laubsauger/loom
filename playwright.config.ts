import { defineConfig, devices } from "@playwright/test";

/**
 * Skeleton config for track P (wave 4, T48). Tests land under src/tests/e2e —
 * none exist yet, this just wires up the runner so `pnpm test:e2e` works
 * once they do.
 */
/**
 * The specs that need a real WebGPU adapter, named ONCE (T1131).
 *
 * The two projects below split on this and nothing else: the GPU lane MATCHES it, the
 * default lane IGNORES it. It was written out twice, and the two copies drifted the moment
 * a spec was added to one of them — `mediapipe-matte` went into neither, so it ran in the
 * one project structurally unable to run it and failed on "no WebGPU adapter" for a whole
 * session while looking like a product bug. One regex, two readers, no way to add a spec to
 * half the split.
 *
 * B265: `wire-snap` is here though it reads no pixel. The "Output stale" notice exists only
 * once a plan has been installed on a device, so the page that jumped when a first
 * connection cleared it never jumped in the lane without an adapter.
 */
const NEEDS_A_REAL_ADAPTER =
  /(header-timeline|canvas-render|device-loss|presentation-pixels|still-pixels|example-parity|node-layering-pixels|mediapipe-matte|viewer-aspect|max-zoom-orbit-tile|pane-resize-hold|value-card-dom|wire-snap|preview-camera|canvas-paint|camera-fly|ten-bit-video|chroma-node|audio-input-gain|whip-out)\.spec\.ts$/;

export default defineConfig({
  testDir: "./src/tests/e2e",
  /**
   * T460: a spec may import APP source to compare a model against the rendered DOM, and
   * `src/**` uses the `@domain`/`@editor` aliases throughout. The root `tsconfig.json` is
   * a solution file with no `compilerOptions`, so without this Playwright resolves none
   * of them and such a spec cannot load at all.
   */
  tsconfig: "./tsconfig.app.json",
  /*
   * ONLY `*.spec.ts` is a Playwright file. The default pattern also takes `*.test.ts`,
   * and `perf/prune-traces.test.ts` is a VITEST file that lives under this directory
   * (T1277). Loading it throws "Vitest failed to access its internal state", and one file
   * that fails to load stops the whole run before a test starts: a bare `pnpm test:e2e`,
   * and `--project=chromium`, ran nothing and exited 1. A spec named by file never loaded
   * it, which is how it went unseen (found under T1616b, listing the lanes).
   */
  testMatch: /\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    // Exercise audio analysis and encoding without playing test tracks through speakers.
    launchOptions: { args: ["--mute-audio"] },
    baseURL: "http://localhost:5189",
    trace: "on-first-retry",
    /*
     * T469: nodes render at ~514x427 device px at the default zoom since the design
     * system landed, so two nodes plus a drag offset overflow the 1280x720 default —
     * measured: the connect target handle sat at y=883, outside the viewport, and every
     * mouse event aimed at it landed nowhere. The suite drags real pixels, so the
     * window must hold the furniture.
     */
    viewport: { width: 1920, height: 1200 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      /*
       * The pixel suite needs the GPU lane's adapter; running it here would only ever
       * fail on "requestAdapter() resolved null". With no `channel`, Playwright launches
       * `chrome-headless-shell` for a headless run, and that is the browser with no
       * adapter (T1616b, measured below).
       *
       * T1131: `mediapipe-matte` joined them. Its failure was never a bug or a flake —
       * "no WebGPU adapter — the delivered path cannot be gated" is this lane's structural
       * truth (§V895: `navigator.gpu` is present but `requestAdapter()` resolves null), so
       * the spec was simply in the one project that cannot run it.
       */
      testIgnore: NEEDS_A_REAL_ADAPTER,
    },
    {
      /*
       * T1086 (§V895) — the GPU lane: the only place in the project that can assert
       * rendered pixels THROUGH THE APP — real canvas, real presentation blit, real
       * compositing — a layer the Dawn suites never touch (§V628).
       *
       * T1616b: IT OPENS NO WINDOW. It was `chromium-headed-gpu` and ran `headless: false`,
       * on the belief that headless Chromium has no GPU. That was a true reading of ONE of
       * the two headless browsers Playwright ships, generalised to both (§V895's shape
       * again). Measured 2026-10-06, Playwright 1.62.1, Chromium 151.0.7922.34,
       * macOS/Metal, against an http://localhost origin:
       *
       *   - no `channel` (the project above): `chrome-headless-shell`, the OLD headless.
       *     `requestAdapter()` resolves null.
       *   - `channel: "chromium"`: the full Chrome for Testing binary, the one a headed run
       *     launches, in the NEW headless mode. `requestAdapter()` resolves
       *     `apple`/`metal-3` with `isFallbackAdapter` false, and chrome://gpu reports
       *     ANGLE Metal on the machine's own GPU. A canvas presenting (0.25, 0.5, 0.75, 1)
       *     screenshots as exactly [64,128,191,255], requestAnimationFrame is unthrottled,
       *     the page is visible and focused. macOS lists the process as background-only:
       *     no window, no Dock icon, the front application does not change.
       *
       * So `channel: "chromium"` is the whole mechanism. NO GPU FLAGS, on purpose:
       * `--use-angle=metal` and `--enable-gpu` changed nothing that was measured in this
       * mode, and `--enable-unsafe-webgpu` adds a SwiftShader fallback adapter. Measured
       * with the GPU taken away (`--disable-gpu`): without that flag `requestAdapter()`
       * resolves null, with it it resolves `google`/`swiftshader`, which presents nothing
       * to the glass and which the premise test in `presentation-pixels.spec.ts` (it fails
       * on a NULL adapter) would let through. (The old headless shell does get the real
       * adapter from either of the first two flags; `document-swap.spec.ts` and
       * `component-dive-previews.spec.ts` run that way inside the project above.)
       *
       * A window on request: `pnpm exec playwright test --project=chromium-gpu --headed`
       * (Playwright's own flag; it overrides `use.headless` and launches this same binary).
       * That opens Chromium on the desktop of whoever is logged in, under their cursor, so
       * it is for watching one spec and never for a gate run.
       *
       * CI does not run e2e at all today (`.github/workflows/ci.yml`), so like the Dawn
       * `*.gpu.test.ts` suites this lane is a local gate: without a GPU it FAILS loudly on
       * its premise test — it never skips itself green.
       */
      name: "chromium-gpu",
      /*
       * T1096: this lane runs against ITS OWN dev server, never a shared one.
       * `reuseExistingServer: true` on 5173 means a developer's live tab and the suite
       * share one vite process — the suite's runs ride the developer's HMR channel and
       * the developer's half-edited working tree hot-reloads into the suite's runs,
       * in both directions. The pixel gates drive the real UI (open an example, edit
       * the project resolution, seek), so they get a port nobody's browser is parked
       * on and a server that is always their own.
       */
      use: { ...devices["Desktop Chrome"], channel: "chromium", baseURL: "http://localhost:5199" },
      testMatch: NEEDS_A_REAL_ADAPTER,
    },
  ],
  webServer: [
    {
      command: "pnpm dev --port 5189 --strictPort",
      url: "http://localhost:5189",
      // A reused dev port can serve another repository. Both lanes own their server
      // so a passing test always describes this working copy.
      reuseExistingServer: false,
    },
    {
      command: "pnpm dev --port 5199 --strictPort",
      url: "http://localhost:5199",
      // Never reuse: whatever answers on 5199 is not guaranteed to be this tree, and
      // the GPU lane's whole point is pixels from THIS working copy.
      reuseExistingServer: false,
    },
  ],
});
