import { describe, expect, it } from "vitest";

import type { NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { compileGraph } from "../../compiler/index.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { outputNode } from "./output.ts";
import { isSinkNode, SINK_TAG } from "./sink.ts";
import { solidNode } from "./solid.ts";
import {
  OUTPUT_DISPLAY_ENCODE_WGSL,
  OUTPUT_PASSTHROUGH_WGSL,
} from "../shaders/output-passthrough.wgsl.ts";

/** Output — viewer sink (T15). */

function contextFor(overrides: Partial<NodeCompileContext> = {}): NodeCompileContext {
  return {
    nodeId: "n1",
    outputs: {},
    inputs: { input: [{ portId: "input", resourceId: "scene", sampler: "linear" }] },
    sampler: "sampler:linear",
    parameters: {},
    target: "canvas-output",
    format: "rgba16float",
    space: "linear",
    // T375: the display transform is a project commitment the sink reads. Default "none"
    // here so the pass-shape tests below stay about pass shape.
    colorPolicy: { workingSpace: "linear", displayTransform: "none" },
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

  /**
   * T375/B47 (§V56, §V70a). The sink is where the display transform lives, and until
   * T375 it lived nowhere: the viewer showed raw linear light (measured 55 for a
   * display-0.5 grey) while the preview tile and the exported PNG showed 127. These two
   * cases are the whole of the node's colour behaviour, and they are asserted here
   * because a shader chosen by a policy nobody reads is exactly how B47 happened.
   */
  it("applies the project display transform, and only when the project asks for one", () => {
    const encoded = outputNode.compile(
      contextFor({ colorPolicy: { workingSpace: "linear", displayTransform: "srgb" } }),
    );
    expect((encoded.passes[0] as { shader: string }).shader).toBe(OUTPUT_DISPLAY_ENCODE_WGSL);

    const raw = outputNode.compile(
      contextFor({ colorPolicy: { workingSpace: "linear", displayTransform: "none" } }),
    );
    expect((raw.passes[0] as { shader: string }).shader).toBe(OUTPUT_PASSTHROUGH_WGSL);
  });

  it("leaves a data target and an -srgb target alone — the transform would be applied twice", () => {
    const srgbPolicy = { workingSpace: "linear", displayTransform: "srgb" } as const;
    // `data` is not a colour (§V56).
    const data = outputNode.compile(contextFor({ colorPolicy: srgbPolicy, space: "data" }));
    expect((data.passes[0] as { shader: string }).shader).toBe(OUTPUT_PASSTHROUGH_WGSL);
    // An -srgb target's hardware already encodes on write; doing it in the shader too
    // would store the transform twice.
    const srgb = outputNode.compile(
      contextFor({ colorPolicy: srgbPolicy, format: "rgba8unorm-srgb" }),
    );
    expect((srgb.passes[0] as { shader: string }).shader).toBe(OUTPUT_PASSTHROUGH_WGSL);
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
 * B6 / T165 — the Output node targets the PROJECT surface.
 *
 * Through the real compiler rather than against the manifest fields, because the defect
 * was never visible in the manifest: `outputNode` simply declared no policy, and
 * `resolveNodeResolution` / `resolveNodeFormat` fall through to the primary input when
 * neither an override nor a policy is present. The graph below is E5's shape in miniature
 * — an oversized source feeding a 1280x720 project — and it is the plan's SINK TARGET, not
 * the node's manifest, that has to come out at the project's size and format.
 */
describe("output targets the project surface, not its input (B6/T165)", () => {
  const settings: ProjectSettings = {
    outputResolution: { width: 1280, height: 720 },
    workingFormat: "rgba8unorm",
    randomSeed: 1,
    previewLongEdge: 192,
    previewFps: 20,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
  };

  const capabilities: BackendCapabilities = {
    tier: "B",
    features: [],
    formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
    timestampQuery: false,
    limits: { maxTextureDimension2D: 8192 },
  };

  /** A generator pinned well away from the project, so "followed the input" is unmistakable. */
  function graphWith(override?: {
    resolution?: GraphNode["resolution"];
    format?: GraphNode["format"];
  }): GraphDocument {
    const out: GraphNode = {
      id: "out",
      type: "output",
      definitionVersion: 1,
      position: { x: 200, y: 0 },
      parameters: {},
      ...(override?.resolution === undefined ? {} : { resolution: override.resolution }),
      ...(override?.format === undefined ? {} : { format: override.format }),
    };
    return {
      revision: 1,
      nodes: {
        source: {
          id: "source",
          type: "solid",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {},
          resolution: { mode: "fixed", width: 2048, height: 2048 },
          format: { mode: "fixed", format: "rgba16float" },
        },
        out,
      },
      edges: {
        e1: {
          id: "e1",
          source: { nodeId: "source", portId: "out" },
          target: { nodeId: "out", portId: "input" },
        },
      },
      groups: {},
    };
  }

  const compile = (graph: GraphDocument) =>
    compileGraph({
      graph,
      settings,
      registry: createNodeRegistry([outputNode, solidNode]).view(),
      capabilities,
    });

  /** The sink has no output ports, so its target lives under the reserved `$target` id. */
  function sinkTarget(plan: ReturnType<typeof compile>) {
    const binding = plan.outputs.find((entry) => entry.nodeId === "out");
    if (binding === undefined) throw new Error("the Output node materialized no target");
    return binding;
  }

  it("sizes and formats its target from the project even when its input differs", () => {
    const plan = compile(graphWith());
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    // The input really is the other thing, so this is not passing by coincidence.
    const source = plan.outputs.find((entry) => entry.nodeId === "source");
    expect(source?.size).toEqual([2048, 2048]);
    expect(source?.format).toBe("rgba16float");

    expect(sinkTarget(plan).size).toEqual([1280, 720]);
    expect(sinkTarget(plan).format).toBe("rgba8unorm");
  });

  /** §V50/§V51: a policy is the DEFAULT. The user may still pin the presented surface. */
  it("still lets a per-instance override win over the project default", () => {
    const plan = compile(
      graphWith({
        resolution: { mode: "fixed", width: 960, height: 540 },
        format: { mode: "fixed", format: "rgba16float" },
      }),
    );
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(sinkTarget(plan).size).toEqual([960, 540]);
    expect(sinkTarget(plan).format).toBe("rgba16float");
  });

  /** An override of `auto` is "no opinion", and must fall back to the policy, not the input. */
  it("treats an auto override as no override at all", () => {
    const plan = compile(graphWith({ resolution: { mode: "auto" }, format: { mode: "auto" } }));
    expect(sinkTarget(plan).size).toEqual([1280, 720]);
    expect(sinkTarget(plan).format).toBe("rgba8unorm");
  });

  it("declares the policy on the manifest so the popup and the compiler read one source", () => {
    expect(outputNode.resolutionPolicy).toEqual({ kind: "project" });
    expect(outputNode.formatPolicy).toEqual({ kind: "project" });
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
