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
    test: {
      name: "browser",
      environment: "jsdom",
      include: ["src/**/*.test.tsx"],
    },
  },
]);
