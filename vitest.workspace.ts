import { defineWorkspace } from "vitest/config";

/**
 * Splits the suite into two projects (§C test, track D harness, T7/T8/T64 sibling task):
 *
 *  - "headless": node environment. Domain/compiler/runtime/node-definition logic,
 *    `vgpu/mock` tests, and (later) Dawn headless-render tests (T47/T69) — none
 *    of these touch the DOM. This is what `pnpm test:headless` runs.
 *  - "browser": jsdom environment, for `.test.tsx` component/hook tests.
 *
 * Both extend vitest.config.ts, so the path aliases stay in one place.
 * A file can still force its own environment with a top-of-file
 * `// @vitest-environment jsdom` docblock — Vitest applies that after a
 * project's default, so it keeps working in either project.
 */
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "headless",
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  },
  {
    extends: "./vitest.config.ts",
    // jsdom tests must resolve the BROWSER build of dependencies. Without this, Vitest
    // uses node/SSR conditions and react-resizable-panels ships its SSR build: layout
    // effects never run, panels never register, and setLayout throws "Invalid 0 panel
    // layout". Any DOM-measuring dependency has the same failure mode.
    resolve: { conditions: ["browser", "import", "module", "default"] },
    ssr: { resolve: { conditions: ["browser", "import", "module", "default"] } },
    test: {
      name: "browser",
      environment: "jsdom",
      /*
       * T781 — AN EXPLICIT, MEASURED BUDGET, replacing vitest's generic 5000 ms default.
       *
       * These tests mount the whole App under jsdom. Measured on an IDLE machine the
       * slowest single test takes 3894 ms, so the inherited default left 22% headroom —
       * that is not a budget anyone chose, it is a default that happened to fit.
       *
       * Under load this project creates itself, wall time inflates ~3.3x (measured: file
       * times 38.1 s -> 119.2 s, 14.5 s -> 48.6 s at load 40). 24 of 245 tests cross 5000 ms
       * at that factor, so a DIFFERENT arbitrary handful failed each run — animate-sinks,
       * then node-view, then composition-wiring, then a fourth set here. That is the
       * signature of one global budget, not of per-test bugs, and every worker paid a
       * control run to prove the red was not theirs (§V491's attribution tax, §V713).
       *
       * 20 s is ~5x the idle worst case — above the measured contention factor with room
       * to spare, and still an order of magnitude below anything a human would call a hang.
       *
       * This buys back NO slowdown signal, because there was none to lose: nothing in the
       * suite asserts on duration, so the old budget only ever fired under contention and
       * reported it as someone's regression. Catching a genuine slowdown needs a gate that
       * MEASURES duration; a timeout is a hang detector.
       */
      testTimeout: 20_000,
      hookTimeout: 20_000,
      // T592: fills jsdom's URL.revokeObjectURL and Range-geometry gaps, so the suite
      // stops exiting 1 on "0 failed" (§V469 — the report and the exit code disagreed).
      setupFiles: ["src/tests/jsdom-setup.ts"],
      include: ["src/**/*.test.tsx"],
    },
  },
]);
