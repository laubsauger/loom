import { defineConfig, devices } from "@playwright/test";

/**
 * Skeleton config for track P (wave 4, T48). Tests land under src/tests/e2e —
 * none exist yet, this just wires up the runner so `pnpm test:e2e` works
 * once they do.
 */
export default defineConfig({
  testDir: "./src/tests/e2e",
  /**
   * T460: a spec may import APP source to compare a model against the rendered DOM, and
   * `src/**` uses the `@domain`/`@editor` aliases throughout. The root `tsconfig.json` is
   * a solution file with no `compilerOptions`, so without this Playwright resolves none
   * of them and such a spec cannot load at all.
   */
  tsconfig: "./tsconfig.app.json",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
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
      // The pixel suite needs the headed lane's GPU; running it here would only ever
      // fail on "requestAdapter() resolved null". Everything else stays headless.
      testIgnore: /(presentation-pixels|example-parity|node-layering-pixels)\.spec\.ts$/,
    },
    {
      /*
       * T1086 (§V895) — the HEADED lane, and what it buys for what it costs.
       *
       * Headless Chromium on this machine exposes `navigator.gpu` but resolves NO
       * adapter; headed resolves a real `apple`/`metal-3` one (measured 2026-09-03, see
       * `src/tests/e2e/app.ts`). So this lane is the only place in the project that can
       * assert rendered pixels THROUGH THE APP — real canvas, real presentation blit,
       * real compositing — a layer the Dawn suites never touch (§V628).
       *
       * The cost is real and owned: `headless: false` opens an actual Chromium window,
       * so the lane needs a display session (a logged-in mac, not a bare CI runner) and
       * adds window-server startup to the run. CI does not run e2e at all today
       * (`.github/workflows/ci.yml`), so like the Dawn `*.gpu.test.ts` suites this lane
       * is a local gate: without a GPU it FAILS loudly on its premise test — it never
       * skips itself green.
       */
      name: "chromium-headed-gpu",
      /*
       * T1096: the headed lane runs against ITS OWN dev server, never a shared one.
       * `reuseExistingServer: true` on 5173 means a developer's live tab and the suite
       * share one vite process — the suite's runs ride the developer's HMR channel and
       * the developer's half-edited working tree hot-reloads into the suite's runs,
       * in both directions. The pixel gates drive the real UI (open an example, edit
       * the project resolution, seek), so they get a port nobody's browser is parked
       * on and a server that is always their own.
       */
      use: { ...devices["Desktop Chrome"], headless: false, baseURL: "http://localhost:5199" },
      testMatch: /(presentation-pixels|example-parity|node-layering-pixels)\.spec\.ts$/,
    },
  ],
  webServer: [
    {
      command: "pnpm dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm dev --port 5199 --strictPort",
      url: "http://localhost:5199",
      // Never reuse: whatever answers on 5199 is not guaranteed to be this tree, and
      // the headed lane's whole point is pixels from THIS working copy.
      reuseExistingServer: false,
    },
  ],
});
