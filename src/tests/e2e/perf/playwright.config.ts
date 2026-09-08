import { defineConfig, devices } from "@playwright/test";

/**
 * The PROFILING lane (T1235). Opt-in and separate from `pnpm test:e2e` on purpose:
 *
 *   pnpm exec playwright test -c src/tests/e2e/perf/playwright.config.ts
 *
 * or, for the §V713-clean run the numbers in `docs/perf-profile-*.md` come from,
 * `src/tests/e2e/perf/run.sh`. The root config's default `testMatch` would pick up any
 * `*.spec.ts` in this directory, so the spec here is named `*.perf.ts` and ONLY this
 * config matches it. Headed, because the headless lane resolves no WebGPU adapter
 * (§V895) and a profile of a page that cannot render is a profile of the wrong thing.
 * One worker: two Chromiums on one GPU would each be the other's noise.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /\.perf\.ts$/,
  tsconfig: "../../../../tsconfig.app.json",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: Number(process.env["PERF_TIMEOUT_MS"] ?? 20 * 60 * 1000),
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: false,
    baseURL: "http://localhost:5211",
    viewport: { width: 1920, height: 1200 },
    trace: "off",
    video: "off",
  },
  webServer: {
    command: process.env["PERF_SERVER_COMMAND"] ?? "pnpm dev --port 5211 --strictPort",
    url: "http://localhost:5211",
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 120_000,
  },
});
