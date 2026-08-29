import { describe, expect, it } from "vitest";

import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { outputNode } from "./output.ts";
import { isSinkNode, SINK_TAG } from "./sink.ts";
import { solidNode } from "./solid.ts";
import { OUTPUT_PASSTHROUGH_WGSL } from "../shaders/output-passthrough.wgsl.ts";

/** Output — viewer sink (T15). */

function contextFor(overrides: Partial<NodeCompileContext> = {}): NodeCompileContext {
  return {
    nodeId: "n1",
    outputs: {},
    inputs: { input: [{ portId: "input", resourceId: "scene", sampler: "linear" }] },
    sampler: "sampler:linear",
    parameters: {},
    target: "canvas-output",
    ...overrides,
  };
}

describe("Output node (T15)", () => {
  it("registers cleanly in a real registry with no manifest diagnostics", () => {
    expect(validateNodeDefinition(outputNode)).toEqual([]);
    const registry = createNodeRegistry([outputNode]);
    expect(registry.get("output")).toBe(outputNode);
  });

  it("has one rgba input and no outputs", () => {
    const rgba = { kind: "texture2d", sample: "float", channels: 4 };
    expect(outputNode.inputs).toEqual([{ id: "input", label: "Input", type: rgba }]);
    expect(outputNode.outputs).toEqual([]);
  });

  it("is discoverable as an active sink via an explicit flag, not by inferring from empty outputs", () => {
    expect(outputNode.tags).toContain(SINK_TAG);
    expect(isSinkNode(outputNode)).toBe(true);
    // solidNode has outputs, so it is unambiguously not a sink either way — the real
    // point of this contrast is that "no outputs" alone must never be read as "sink".
    expect(isSinkNode(solidNode)).toBe(false);
  });

  it("compiles to a passthrough pass into its assigned render target", () => {
    const compiled = outputNode.compile(contextFor());
    const plan: LogicalExecutionPlan = {
      passes: compiled.passes,
      resources: [
        { kind: "target", id: "canvas-output", size: [64, 64], format: "rgba8unorm" },
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
      expect(pass.shader).toBe(OUTPUT_PASSTHROUGH_WGSL);
      expect(pass.target).toBe("canvas-output");
      expect(pass.textures).toEqual([{ binding: "inputTexture", resourceId: "scene" }]);
      expect(pass.samplers).toEqual([{ binding: "inputSampler", resourceId: "linear" }]);
    }
  });

  it("reports a diagnostic instead of a malformed pass when it has no assigned render target", () => {
    const compiled = outputNode.compile(contextFor({ target: undefined }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });

  it("reports a diagnostic instead of a malformed pass when its input is not connected", () => {
    const compiled = outputNode.compile(contextFor({ inputs: {} }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.missingResource");
  });
});

/**
 * Regression: the compiler's active-sink trace reads `definition.sink === true` and
 * nothing else (§V25). This node previously declared sink-ness only through a tag,
 * which meant the compiler pruned it — and pruning the Output node means the whole
 * graph renders nothing. A tag is documentation; the field is the contract.
 */
describe("output node is a declared sink", () => {
  it("sets the first-class sink field, not only the tag", () => {
    expect(outputNode.sink).toBe(true);
  });

  it("survives an active-sink trace that reads only the field", () => {
    const isDeclaredSink = (d: { sink?: boolean }) => d.sink === true;
    expect(isDeclaredSink(outputNode)).toBe(true);
  });
});
