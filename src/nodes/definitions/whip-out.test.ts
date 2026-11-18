import { describe, expect, it } from "vitest";
import { compileGraph, ownsSinkTarget, presentsPicture, SINK_TARGET_PORT } from "../../compiler/index.ts";
import type { ActiveSink } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { emissionRefusal } from "../../domain/render/side-effects.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { syphonOutNode } from "./syphon-out.ts";
import { WHIP_OUT_TYPE, whipOutNode } from "./whip-out.ts";

/**
 * §T1809b — WHIP Out through the real compiler. What the pump reads back is the plan: is
 * there a target to present into the stream's canvas, at what size, and does the viewer's
 * picture stay the Output's. The stream itself is gated end to end by
 * `src/tests/e2e/whip-out.spec.ts`.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 8192, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};
const registry = createNodeRegistry(allNodeDefinitions).view();
const node = (id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode => ({
  id, type, definitionVersion: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, parameters,
});

/** `a_whip` sorts BEFORE `out`: the case where "first sink by id" would pick the stream. */
function graph(parameters: GraphNode["parameters"] = {}): GraphDocument {
  return {
    revision: 1,
    nodes: { src: node("src", "checker"), a_whip: node("a_whip", WHIP_OUT_TYPE, parameters), out: node("out", "output") },
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "src", portId: "out" }, target: { nodeId: "a_whip", portId: "input" } },
    },
    groups: {},
  };
}
const publishing: ActiveSink[] = [{ nodeId: "a_whip", kind: "output" }];
const compile = (document: GraphDocument, sinks?: ActiveSink[]) =>
  compileGraph({ graph: document, settings, registry, capabilities, ...(sinks === undefined ? {} : { sinks }) });
const streamTarget = (plan: ReturnType<typeof compile>) =>
  plan.outputs.find((output) => output.nodeId === "a_whip" && output.portId === SINK_TARGET_PORT);

describe("WHIP Out is a display sink that emits (§T1809b)", () => {
  it("renders nothing until the pump names it, then exactly Width × Height whatever the project size", () => {
    // Not named: a headless compile, a take, a node that is off or unconfigured.
    const idle = compile(graph({ width: 640, height: 360 }));
    expect(streamTarget(idle)).toBeUndefined();
    expect(idle.passes.some((pass) => "nodeId" in pass && pass.nodeId === "a_whip")).toBe(false);

    const live = compile(graph({ width: 640, height: 360 }), publishing);
    expect(live.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    const target = streamTarget(live);
    const resource = live.resources.find((entry) => entry.id === target?.resourceId);
    // The encoded size is the node's, not the project's 1280 × 720.
    expect(resource !== undefined && "size" in resource ? resource.size : undefined).toEqual([640, 360]);
    expect(live.passes.filter((pass) => "nodeId" in pass && pass.nodeId === "a_whip")).toHaveLength(1);
  });

  it("is never the viewer's picture, even when its id sorts before the Output's", () => {
    const live = compile(graph(), publishing);
    const document = graph();
    const pictures = live.outputs.filter((output) => {
      const definition = registry.get(document.nodes[output.nodeId]?.type ?? "");
      return output.portId === SINK_TARGET_PORT && definition !== undefined && presentsPicture(definition);
    });
    expect(pictures.map((output) => output.nodeId)).toEqual(["out"]);
  });

  it("owns a target although it emits; an emitter that is not a display sink still draws nothing", () => {
    // The rule this node added to `ownsSinkTarget`, and the case it must not swallow:
    // Syphon Out emits too, declares no display role, and must keep getting no target.
    expect(ownsSinkTarget(whipOutNode)).toBe(true);
    expect(ownsSinkTarget(syphonOutNode)).toBe(false);
  });

  it("may send only in a live session: a take and a headless export are refused by name", () => {
    expect(emissionRefusal(whipOutNode, "live-session")).toBeNull();
    expect(emissionRefusal(whipOutNode, "blocked")).toContain("WHIP Out");
  });
});
