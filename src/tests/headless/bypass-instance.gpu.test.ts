import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * B301 (§V1035) — A BYPASSED COMPONENT INSTANCE IS WIRES, IN THE PICTURE.
 *
 * One instance with a texture input and a value input, and its outputs declared the other
 * way round (value first, texture second), so nothing here passes by being first. Inside,
 * the texture is darkened and the value is clamped. Downstream, the picture's red follows
 * the value output and its other channels are the texture output.
 *
 * Bypassed, both outputs must pass their own input unchanged: the frame is byte-identical to
 * the same graph with the instance taken out and the two sources wired straight through.
 * Before the fix it could not be rendered at all — the texture consumer was handed the
 * value input's producer by the compiler, and the value consumer got no bag from the value
 * graph. `src/tests/integration/bypass-matrix.test.ts` holds every other cell.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 8,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string, ui?: GraphNode["ui"], y = 0): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y }, parameters, ...(label === undefined ? {} : { label }), ...(ui === undefined ? {} : { ui }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

const SOURCE_VALUE = 0.75;
const CLAMPED = 0.25;

/** Texture in, value in; value out FIRST, texture out second. Inside: darken, clamp. */
const grade: GraphComponentDefinition = {
  componentId: "grade",
  version: 1,
  name: "Grade",
  graph: {
    revision: 1,
    groups: {},
    nodes: {
      picIn: node("picIn", "componentIn", {}, "picture_in", undefined, 0),
      amountIn: node("amountIn", "componentInValue", {}, "amount_in", undefined, 100),
      dark: node("dark", "level", { brightness: 0.25 }, "level_dark"),
      clamp: node("clamp", "valueLimit", { minimum: 0, maximum: CLAMPED }, "limit_clamp"),
      amountOut: node("amountOut", "componentOutValue", {}, "amount_out", undefined, 0),
      picOut: node("picOut", "componentOut", {}, "picture_out", undefined, 100),
    },
    edges: {
      a: edge("a", ["picIn", "out"], ["dark", "input"]),
      b: edge("b", ["dark", "out"], ["picOut", "in"]),
      c: edge("c", ["amountIn", "out"], ["clamp", "in"]),
      d: edge("d", ["clamp", "out"], ["amountOut", "in"]),
    },
  },
  inputs: [],
  outputs: [],
  parameters: [],
} as never;

const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
system.components.register(grade);
const GRADE = componentNodeType("grade", 1);
const portsOf = (side: "inputs" | "outputs", kind: string): string => {
  const port = system.nodes.get(GRADE)?.[side].find((each) => each.type.kind === kind);
  if (port === undefined) throw new Error(`Grade has no ${kind} ${side}`);
  return port.id;
};

/** White Solid and a constant, through Grade (or straight past it), into red = the value, picture = the texture. */
function document(through: "instance" | "direct", ui?: GraphNode["ui"]): GraphDocument {
  const nodes: Record<string, GraphNode> = {
    solid: node("solid", "solid", { color: [1, 1, 1, 1] }),
    amount: node("amount", "constant", { value: SOURCE_VALUE }, "constant_amount"),
    reader: node("reader", "valueLimit", { minimum: -9, maximum: 9 }, "limit_reader"),
    fx: node("fx", "customWgsl", { amount: 1, tint: [1, 1, 1, 1], "tint.r": expressionSlot("op('limit_reader').chan.value", 0) }, "fx1"),
    out: node("out", "output", {}),
  };
  const edges =
    through === "direct"
      ? { e0: edge("e0", ["solid", "out"], ["fx", "input"]), e1: edge("e1", ["amount", "out"], ["reader", "in"]) }
      : {
          e0: edge("e0", ["solid", "out"], ["grade", portsOf("inputs", "texture2d")]),
          e1: edge("e1", ["amount", "out"], ["grade", portsOf("inputs", "value")]),
          e2: edge("e2", ["grade", portsOf("outputs", "texture2d")], ["fx", "input"]),
          e3: edge("e3", ["grade", portsOf("outputs", "value")], ["reader", "in"]),
        };
  if (through === "instance") nodes["grade"] = node("grade", GRADE, {}, "grade1", ui);
  return { revision: 1, groups: {}, nodes, edges: { ...edges, e9: edge("e9", ["fx", "out"], ["out", "input"]) } } as never;
}

async function render(graph: GraphDocument): Promise<Buffer> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph, settings, frames: 2, animate: true, components: system.components.view() });
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return Buffer.from(frame.bytes);
}

describe("B301 — a bypassed instance passes each input to the output of its kind", () => {
  it("renders byte-identical to the graph with the instance taken out, and not what the live instance renders", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const direct = await render(document("direct"));
    const live = await render(document("instance"));
    const bypassed = await render(document("instance", { bypassed: true }));
    // The instance does something: darker picture, clamped red.
    expect(Buffer.compare(live, direct)).not.toBe(0);
    // Bypassed it does nothing, on BOTH outputs.
    expect(Buffer.compare(bypassed, direct)).toBe(0);
  }, 120_000);
});
