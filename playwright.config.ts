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
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
