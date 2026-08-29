import { describe, expect, it } from "vitest";
import { normalizeShaderSource, shaderSignature } from "./shader-signature.ts";
import type { ShaderCompileRequest } from "./compile-types.ts";

const BASE: ShaderCompileRequest = {
  nodeId: "node-1",
  source: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }",
  entryPoints: ["fs"],
  targetSignature: "rgba16float:1",
  constants: { amount: 0.5 },
  bindingLayout: [
    { group: 0, binding: 0, kind: "sampler" },
    { group: 0, binding: 1, kind: "texture" },
  ],
};

function withSource(source: string): ShaderCompileRequest {
  return { ...BASE, source };
}

describe("normalizeShaderSource", () => {
  it("ignores line endings, trailing whitespace and surrounding blank lines", () => {
    expect(normalizeShaderSource("\r\nfn f() {}  \r\n\r\n")).toBe("fn f() {}");
    expect(normalizeShaderSource("fn f() {}\t\n")).toBe("fn f() {}");
  });

  it("keeps everything that can change the compiled program", () => {
    // Leading indentation is not whitespace noise once it is inside the text: dropping
    // it would make two genuinely different documents share a key.
    expect(normalizeShaderSource("fn a() {}\n  fn b() {}")).toBe("fn a() {}\n  fn b() {}");
    // Comments are NOT stripped — see the note in shader-signature.ts.
    expect(normalizeShaderSource("// note\nfn f() {}")).toContain("// note");
  });
});

describe("shaderSignature — the cache key (doc §9.3)", () => {
  it("is equal for text that differs only in whitespace normalisation", () => {
    expect(shaderSignature(withSource(`${BASE.source}   \n\n`))).toBe(shaderSignature(BASE));
    expect(shaderSignature(withSource(BASE.source.replace(/\n/g, "\r\n")))).toBe(
      shaderSignature(BASE),
    );
  });

  it("differs when the shader text differs", () => {
    expect(shaderSignature(withSource("fn other() {}"))).not.toBe(shaderSignature(BASE));
  });

  it("differs when the binding layout changes", () => {
    // The same WGSL against a different pipeline layout is a different program. Missing
    // this is how a cache silently serves a program bound to resources that moved.
    const rebound: ShaderCompileRequest = {
      ...BASE,
      bindingLayout: [
        { group: 0, binding: 0, kind: "sampler" },
        { group: 0, binding: 2, kind: "texture" },
      ],
    };
    expect(shaderSignature(rebound)).not.toBe(shaderSignature(BASE));

    const retyped: ShaderCompileRequest = {
      ...BASE,
      bindingLayout: [
        { group: 0, binding: 0, kind: "sampler" },
        { group: 0, binding: 1, kind: "storage" },
      ],
    };
    expect(shaderSignature(retyped)).not.toBe(shaderSignature(BASE));
  });

  it("treats the binding layout as a set, not a sequence", () => {
    const reordered: ShaderCompileRequest = {
      ...BASE,
      bindingLayout: [...BASE.bindingLayout].reverse(),
    };
    expect(shaderSignature(reordered)).toBe(shaderSignature(BASE));
  });

  it("differs when entry points, target signature or constants change", () => {
    expect(shaderSignature({ ...BASE, entryPoints: ["main"] })).not.toBe(shaderSignature(BASE));
    expect(shaderSignature({ ...BASE, targetSignature: "rgba8unorm:1" })).not.toBe(
      shaderSignature(BASE),
    );
    expect(shaderSignature({ ...BASE, constants: { amount: 0.75 } })).not.toBe(
      shaderSignature(BASE),
    );
  });

  it("does not depend on which node asked", () => {
    // Two nodes with the same shader share one compile.
    expect(shaderSignature({ ...BASE, nodeId: "node-2" })).toBe(shaderSignature(BASE));
  });
});
