import { describe, expect, it } from "vitest";

import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { solidNode } from "./solid.ts";
import { SOLID_FRAGMENT_WGSL } from "../shaders/solid.wgsl.ts";

/** Solid — colour generator (T15). */

function contextFor(overrides: Partial<NodeCompileContext> = {}): NodeCompileContext {
  return {
    nodeId: "n1",
    outputs: { out: { portId: "out", resourceId: "target-1" } },
    inputs: {},
    sampler: "sampler:linear",
    parameters: { color: [0.2, 0.4, 0.6, 1] },
    ...overrides,
  };
}

describe("Solid node (T15)", () => {
  it("registers cleanly in a real registry with no manifest diagnostics", () => {
    expect(validateNodeDefinition(solidNode)).toEqual([]);
    const registry = createNodeRegistry([solidNode]);
    expect(registry.get("solid")).toBe(solidNode);
  });

  it("has no inputs and one rgba texture output", () => {
    expect(solidNode.inputs).toEqual([]);
    expect(solidNode.outputs).toEqual([
      { id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 4 } },
    ]);
  });

  it("declares a display-space colour parameter and a project resolution/format policy", () => {
    expect(solidNode.parameters["color"]).toMatchObject({ type: "color", space: "display" });
    expect(solidNode.resolutionPolicy).toEqual({ kind: "project" });
    expect(solidNode.formatPolicy).toEqual({ kind: "project" });
  });

  it("round-trips the colour parameter's default through the manifest", () => {
    const parameter = solidNode.parameters["color"];
    expect(parameter?.type === "color" ? parameter.default : undefined).toEqual([0, 0, 0, 1]);
  });

  it("compiles to a plan-shaped pass driven by the colour parameter", () => {
    const compiled = solidNode.compile(contextFor());
    const plan: LogicalExecutionPlan = {
      passes: compiled.passes,
      resources: [{ kind: "target", id: "target-1", size: [64, 64], format: "rgba8unorm" }],
      diagnostics: [],
    };
    const read = readExecutionPlan(plan);
    expect(read.ok).toBe(true);
    expect(read.passes).toHaveLength(1);

    const pass = read.passes[0];
    expect(pass?.kind).toBe("effect");
    if (pass?.kind === "effect") {
      expect(pass.shader).toBe(SOLID_FRAGMENT_WGSL);
      expect(pass.target).toBe("target-1");
      expect(pass.uniformBinding).toBe("params");
      expect(pass.uniforms).toEqual({ color: [0.2, 0.4, 0.6, 1] });
    }
  });

  it("round-trips a colour change into the uniform value without changing the shader (§V5)", () => {
    const before = solidNode.compile(contextFor());
    const after = solidNode.compile(contextFor({ parameters: { color: [1, 0, 0, 1] } }));

    const beforePass = before.passes[0] as { shader?: unknown; uniforms?: { color?: unknown } };
    const afterPass = after.passes[0] as { shader?: unknown; uniforms?: { color?: unknown } };

    expect(afterPass.uniforms?.color).toEqual([1, 0, 0, 1]);
    expect(afterPass.shader).toBe(beforePass.shader);
  });

  it("reports a diagnostic instead of a malformed pass when the compiler assigned no target", () => {
    const compiled = solidNode.compile(contextFor({ outputs: {} }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });
});
