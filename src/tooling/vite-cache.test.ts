import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import config from "../../vite.config.ts";
import { ESLint } from "eslint";

it("T1314: dependency prebundles belong to the worktree, not shared node_modules", () => {
  expect(config.cacheDir).toBe(fileURLToPath(new URL("../../.vite", import.meta.url)));
});

it("T1321: lint ignores worktree-local prebundles but still checks application source", async () => {
  const lint = new ESLint();
  expect(await lint.isPathIgnored(fileURLToPath(new URL("../../.vite/deps/vgpu.js", import.meta.url))))
    .toBe(true);
  expect(await lint.isPathIgnored(fileURLToPath(new URL("../app/app.tsx", import.meta.url))))
    .toBe(false);
});
