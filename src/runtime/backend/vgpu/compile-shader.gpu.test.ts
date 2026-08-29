import { describe, expect, it } from "vitest";

import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T195 on a REAL device: standalone WGSL validation with line/column-mapped
 * diagnostics (§V27) — no plan, no target, no render. This is what lets the shader
 * editor mark the exact broken spot while the author types.
 */

describe("compileShader on Dawn (T195, §V27)", () => {
  it("maps a real error to its line and column, and passes valid source", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});

      const bad = await backend.compileShader(
        `@fragment fn fs() -> @location(0) vec4f {\n  return bad_ident;\n}`,
        { label: "editor.wgsl" },
      );
      expect(bad.validated).toBe(true);
      expect(bad.ok).toBe(false);
      const error = bad.diagnostics.find((d) => d.severity === "error");
      expect(error?.message).toContain("bad_ident");
      // §V27: the editor can put the squiggle exactly here.
      expect(error?.source?.line).toBe(2);
      expect(error?.source?.column).toBeGreaterThan(0);
      expect(error?.source?.file).toBe("editor.wgsl");

      const good = await backend.compileShader(
        "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }",
      );
      expect(good.validated).toBe(true);
      expect(good.ok).toBe(true);
      expect(good.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      // Validation must not disturb the render path: compile and render afterwards.
      expect(backend.status.halted).toBe(false);
    } finally {
      backend.dispose();
    }
  });
});
