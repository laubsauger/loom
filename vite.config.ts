import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * T705 follow-up: the commit the DEV SERVER started from, stamped into the bundle and
 * logged at boot. Exists because a whole debugging round was spent unable to answer
 * "is the fix even in the page you are looking at" — with several agents landing fixes
 * while dev servers and browser tabs stay open across them, the page has to say which
 * tree it came from. Read at config load, so it names the server's baseline; a stale
 * stamp after many HMR patches still tells you when the server last restarted.
 */
const buildCommit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const alias = (segment: string) => fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react()],
  /**
   * §B151/T760: the inference worker (`use-model-inference.ts`) is a `new Worker(new
   * URL(...), { type: "module" })` that pulls onnxruntime-web, so its bundle code-splits.
   * Vite's default `worker.format` is "iife", and rollup refuses IIFE for a splitting
   * build — `pnpm build` failed outright for 7 commits while lint, typecheck and 5912
   * tests stayed green, because the test runner transforms workers instead of bundling
   * them and never exercises this path (§V753).
   */
  worker: {
    format: "es",
  },
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
    },
  },
});
