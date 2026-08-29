/**
 * Proves the three eslint-enforced invariants (T7/§V3, T8/§V11, T64/§V44) actually
 * fire — a lint rule nobody tests is a lint rule that can silently stop working.
 *
 * Each case lints a small in-memory snippet with the ESLint Node API against the
 * real `eslint.config.js`, using `lintText`'s `filePath` option to simulate where
 * the file "lives" without needing it to exist on disk.
 */
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const eslintConfigPath = fileURLToPath(new URL("../../../eslint.config.js", import.meta.url));

/** Lints `code` as if it lived at `relativePath` (relative to the repo root). */
async function lint(code: string, relativePath: string) {
  const eslint = new ESLint({ overrideConfigFile: eslintConfigPath, cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${relativePath}` });
  if (!result) throw new Error("expected exactly one lint result");
  return result;
}

function ruleIdsOf(messages: { ruleId: string | null }[]): (string | null)[] {
  return messages.map((message) => message.ruleId);
}

describe("§V3 — vgpu import restricted to src/runtime/backend/vgpu/**", () => {
  const importsVgpu = 'import { init } from "vgpu";\nexport function use() { return init; }\n';
  const importsVgpuMock = 'import { frame } from "vgpu/mock";\nexport function use() { return frame; }\n';

  it("errors when vgpu is imported from a node definition", async () => {
    const result = await lint(importsVgpu, "src/nodes/definitions/solid.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("errors when vgpu is imported from elsewhere in src/ (e.g. the compiler)", async () => {
    const result = await lint(importsVgpu, "src/compiler/plan.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("errors on a vgpu subpath import (vgpu/mock), not just the bare specifier", async () => {
    const result = await lint(importsVgpuMock, "src/compiler/plan.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("does NOT error when vgpu is imported from the backend adapter itself", async () => {
    const result = await lint(importsVgpu, "src/runtime/backend/vgpu/adapter.ts");
    expect(ruleIdsOf(result.messages)).not.toContain("no-restricted-imports");
    expect(result.errorCount).toBe(0);
  });
});

describe("§V11 — src/nodes/definitions/** must run headless", () => {
  const importsReact = 'import { useState } from "react";\nexport function use() { return useState; }\n';
  const importsXyflow = 'import { Handle } from "@xyflow/react";\nexport function use() { return Handle; }\n';
  const importsUiAlias = 'import { theme } from "@ui/tokens.ts";\nexport function use() { return theme; }\n';

  it("errors when react is imported from a node definition", async () => {
    const result = await lint(importsReact, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("errors when @xyflow/react is imported from a node definition", async () => {
    const result = await lint(importsXyflow, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("errors when src/ui is imported (via alias) from a node definition", async () => {
    const result = await lint(importsUiAlias, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("does NOT error when react is imported outside src/nodes/definitions/**", async () => {
    const result = await lint(importsReact, "src/editor/graph-canvas/canvas.tsx");
    expect(ruleIdsOf(result.messages)).not.toContain("no-restricted-imports");
    expect(result.errorCount).toBe(0);
  });

  it("still enforces §V3 for node definitions (combined rule doesn't drop it)", async () => {
    const importsVgpu = 'import { init } from "vgpu";\nexport function use() { return init; }\n';
    const result = await lint(importsVgpu, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });
});

describe("§V44 — no wall-clock reads in src/nodes/**", () => {
  const usesPerformanceNow = "export function tick() { return performance.now(); }\n";
  const usesDateNow = "export function tick() { return Date.now(); }\n";
  const usesNewDate = "export function tick() { return new Date().getTime(); }\n";
  const usesRaf = "export function tick(cb: FrameRequestCallback) { return requestAnimationFrame(cb); }\n";

  it("errors on performance.now() inside a node definition", async () => {
    const result = await lint(usesPerformanceNow, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("errors on Date.now() inside a node definition", async () => {
    const result = await lint(usesDateNow, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("errors on new Date() inside src/nodes/** (not just definitions/)", async () => {
    const result = await lint(usesNewDate, "src/nodes/registry/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("errors on requestAnimationFrame() inside a node definition", async () => {
    const result = await lint(usesRaf, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("does NOT error on performance.now() outside src/nodes/** (e.g. the live clock transport)", async () => {
    const result = await lint(usesPerformanceNow, "src/domain/transport/live-clock.ts");
    expect(ruleIdsOf(result.messages)).not.toContain("no-restricted-syntax");
    expect(result.errorCount).toBe(0);
  });
});

/**
 * Bypass probes. A review confirmed the original selectors could be walked around;
 * these assert the holes are closed. Each case previously passed lint.
 */
describe("guardrail bypasses are closed", () => {
  it("§V3 — dynamic import of vgpu is caught", async () => {
    const { messages } = await lint(`const m = await import("vgpu");\nvoid m;\n`, "src/compiler/sneaky.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("§V3 — an unlisted vgpu subpath is caught", async () => {
    const { messages } = await lint(`import x from "vgpu/webgpu";\nvoid x;\n`, "src/compiler/sneaky.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("§V3 — the adapter itself still imports vgpu freely", async () => {
    const { messages } = await lint(
      `import { effect } from "vgpu";\nvoid effect;\n`,
      "src/runtime/backend/vgpu/ok.ts",
    );
    expect(messages).toEqual([]);
  });

  it("§V44 — performance.now() via a global object is caught", async () => {
    const { messages: viaWindow } = await lint(`export const t = window.performance.now();\n`, "src/nodes/definitions/a.ts");
    const { messages: viaGlobal } = await lint(`export const t = globalThis.performance.now();\n`, "src/nodes/definitions/b.ts");
    expect(viaWindow.length).toBeGreaterThan(0);
    expect(viaGlobal.length).toBeGreaterThan(0);
  });

  it("§V44 — aliasing performance is caught at the alias", async () => {
    const { messages } = await lint(`const p = performance;\nexport const t = p.now();\n`, "src/nodes/definitions/c.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("§V44 — self.requestAnimationFrame and bare timers are caught", async () => {
    const { messages: raf } = await lint(`self.requestAnimationFrame(() => {});\n`, "src/nodes/definitions/d.ts");
    const { messages: timer } = await lint(`setInterval(() => {}, 16);\n`, "src/nodes/definitions/e.ts");
    expect(raf.length).toBeGreaterThan(0);
    expect(timer.length).toBeGreaterThan(0);
  });
});
