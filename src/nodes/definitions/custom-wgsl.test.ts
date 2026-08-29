import { describe, expect, it } from "vitest";

import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { customWgslNode } from "./custom-wgsl.ts";
import { CUSTOM_WGSL_DEFAULT_SOURCE } from "../shaders/custom-wgsl-default.wgsl.ts";

/** CustomWGSL — user-authored fragment effect (T15). */

// The v1 contract, §I of SPEC.md, copied here independently of the shader module so a
// change to either one shows up as a failing equality rather than a tautology.
const CONTRACT_SOURCE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
struct Params { time: f32, amount: f32, };
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;

function contextFor(overrides: Partial<NodeCompileContext> = {}): NodeCompileContext {
  return {
    nodeId: "n1",
    outputs: { out: { portId: "out", resourceId: "target-1" } },
    inputs: { input: [{ portId: "input", resourceId: "scene", sampler: "linear" }] },
    sampler: "sampler:linear",
    parameters: { [SHADER_SOURCE_PARAMETER]: CUSTOM_WGSL_DEFAULT_SOURCE },
    ...overrides,
  };
}

describe("CustomWGSL node (T15)", () => {
  it("registers cleanly in a real registry with no manifest diagnostics", () => {
    expect(validateNodeDefinition(customWgslNode)).toEqual([]);
    const registry = createNodeRegistry([customWgslNode]);
    expect(registry.get("customWgsl")).toBe(customWgslNode);
  });

  it("has one rgba input, one rgba output, resolution and format inherited from input", () => {
    const rgba = { kind: "texture2d", sample: "float", channels: 4 };
    expect(customWgslNode.inputs).toEqual([{ id: "input", label: "Input", type: rgba }]);
    expect(customWgslNode.outputs).toEqual([{ id: "out", label: "Out", type: rgba }]);
    expect(customWgslNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
    expect(customWgslNode.formatPolicy).toEqual({ kind: "inherit", input: "input" });
  });

  it(`exposes its shader under the established "${SHADER_SOURCE_PARAMETER}" parameter name`, () => {
    expect(SHADER_SOURCE_PARAMETER).toBe("source");
    const parameter = customWgslNode.parameters[SHADER_SOURCE_PARAMETER];
    expect(parameter).toBeDefined();
    expect(parameter?.type).toBe("string");
    // compileTime: editing the shader changes structure and must force a rebuild (§V5).
    expect(parameter?.compileTime).toBe(true);
  });

  it("defaults to the v1 custom WGSL contract verbatim (§I)", () => {
    expect(CUSTOM_WGSL_DEFAULT_SOURCE).toBe(CONTRACT_SOURCE);
    const parameter = customWgslNode.parameters[SHADER_SOURCE_PARAMETER];
    expect(parameter?.type === "string" ? parameter.default : undefined).toBe(CONTRACT_SOURCE);
  });

  it("compiles the current source into a plan-shaped pass bound to its connected input", () => {
    const compiled = customWgslNode.compile(contextFor());
    const plan: LogicalExecutionPlan = {
      passes: compiled.passes,
      resources: [
        { kind: "target", id: "target-1", size: [64, 64], format: "rgba8unorm" },
        { kind: "target", id: "scene", size: [64, 64], format: "rgba8unorm" },
        { kind: "sampler", id: "linear", filter: "linear" },
      ],
      diagnostics: [],
    };
    const read = readExecutionPlan(plan);
    expect(read.ok).toBe(true);

    const pass = read.passes[0];
    expect(pass?.kind).toBe("effect");
    if (pass?.kind === "effect") {
      expect(pass.shader).toBe(CUSTOM_WGSL_DEFAULT_SOURCE);
      expect(pass.target).toBe("target-1");
      expect(pass.textures).toEqual([{ binding: "inputTexture", resourceId: "scene" }]);
      expect(pass.samplers).toEqual([{ binding: "inputSampler", resourceId: "linear" }]);
    }
  });

  it("uses an edited source verbatim rather than falling back to the default", () => {
    const edited = `// edited\n${CUSTOM_WGSL_DEFAULT_SOURCE}`;
    const compiled = customWgslNode.compile(
      contextFor({ parameters: { [SHADER_SOURCE_PARAMETER]: edited } }),
    );
    const pass = compiled.passes[0] as { shader?: unknown };
    expect(pass.shader).toBe(edited);
  });

  it("reports a diagnostic instead of a malformed pass when its input is not connected", () => {
    const compiled = customWgslNode.compile(contextFor({ inputs: {} }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });
});
