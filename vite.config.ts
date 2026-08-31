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
