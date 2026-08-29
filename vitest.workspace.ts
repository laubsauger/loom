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
      include: ["src/**/*.test.tsx"],
    },
  },
]);
