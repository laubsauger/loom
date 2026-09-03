import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (segment: string) => fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": alias(""),
      "@domain": alias("domain"),
      "@compiler": alias("compiler"),
      "@runtime": alias("runtime"),
      "@editor": alias("editor"),
      "@nodes": alias("nodes"),
      "@ui": alias("ui"),
      "@agent": alias("agent"),
      "@devices": alias("devices"),
    },
  },
  test: {
    // This file is also the base every project in vitest.workspace.ts
    // extends from (`extends: "./vitest.config.ts"`) — that's where the
    // node-vs-jsdom ("headless" vs "browser") split actually happens, via
    // each project's own `include`. Deliberately NOT setting `include` here:
    // Vite/Vitest's config merge concatenates array fields rather than
    // letting a project override replace them, so an `include` set on this
    // base would leak into every project's `include` and defeat the split.
    // (Loaded standalone, with no workspace, Vitest falls back to its own
    // default include glob, which already covers both .test.ts and .test.tsx.)
    // A per-file `// @vitest-environment jsdom` docblock overrides the
    // environment below regardless of which project picks the file up.
    environment: "node",
    environmentMatchGlobs: [["src/**/*.test.tsx", "jsdom"]],
  },
});
