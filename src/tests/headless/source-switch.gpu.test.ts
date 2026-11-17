import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph, flattenComponents } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import { presetBankNode, presetSession } from "../../domain/presets/test-support.ts";
import type { BackendCapabilities, FrameInputs } from "../../domain/types/backend.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { outputResourceIdOf } from "./render-harness.ts";

/**
 * T1770b — THE PICTURE ON THE FRAME A SOURCE IS SWITCHED. The owner's case through the real
 * stack: two source rigs (component instances) wired into one bus (a Value Switch, one wire
 * an input as §V14 has it, into a Lag), a White Solid whose
 * red follows the bus, and a bank that chooses the live rig. The bank is pressed between
 * two frames of ONE running session — the real `preset.recall` on the real bus, then the
 * real flattener, value graph, compiler, backend and Dawn — and every frame is read back.
 *
 * What a performer must never see is asserted from pixels: the output going BLACK on the
 * switch frame, or JUMPING to the new source. The frame is instead byte-identical to the
 * same picture with red held at the bus's one eased step, which is neither source's value.
 * Each expected picture is a render of the same graph with red static, so no colour
 * arithmetic is restated here (§V147). `source-switch.test.ts` holds the value half and the
 * cost claim.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const FPS = 60;
const DT = 1 / FPS;
const KEYS = 0.25;
const TAKE = 0.75;
const BUS_LAG = 0.2;

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 8,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string, ui?: GraphNode["ui"]): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }), ...(ui === undefined ? {} : { ui }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

function rig(componentId: string, level: number): GraphComponentDefinition {
  return {
    componentId,
    version: 1,
    name: componentId,
    graph: {
      revision: 1,
      groups: {},
      nodes: {
        src: node("src", "valueExpression", { expressions: `level = ${level}` }, "expr_src"),
        out: node("out", "componentOutValue", {}, "score"),
      },
      edges: { a: edge("a", ["src", "out"], ["out", "in"]) },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  } as never;
}

/** Keys live, the take off; White Solid → Custom WGSL (red = `red`) → Output. */
function document(red: StoredParameter): GraphDocument {
  return {
    revision: 0,
    groups: {},
    nodes: {
      keys: node("keys", componentNodeType("keysrig", 1), {}, "keysrig_live"),
      take: node("take", componentNodeType("takerig", 1), {}, "takerig_recorded", { bypassed: true }),
      pick: node("pick", "valueSwitch", { index: 0 }, "switch_source"),
      bus: node("bus", "valueLag", { lag: BUS_LAG }, "lag_bus"),
      source: presetBankNode("source", "presets_source", "", [
        { name: "keys", values: {}, on: { keysrig_live: true, takerig_recorded: false } },
        { name: "take", values: {}, on: { keysrig_live: false, takerig_recorded: true } },
      ]),
      solid: node("solid", "solid", { color: [1, 1, 1, 1] }),
      fx: node("fx", "customWgsl", { amount: 1, tint: [1, 1, 1, 1], "tint.r": red }, "fx1"),
      out: node("out", "output", {}),
    },
    edges: {
      e0: edge("e0", ["keys", "score"], ["pick", "in1"]),
      e1: edge("e1", ["take", "score"], ["pick", "in2"]),
      e4: edge("e4", ["pick", "out"], ["bus", "in"]),
      e2: edge("e2", ["solid", "out"], ["fx", "input"]),
      e3: edge("e3", ["fx", "out"], ["out", "input"]),
    },
  } as never;
}

/**
 * One running show. `frames(n)` steps n frames and returns the last one's output bytes;
 * `press` recalls a preset between two of them. Every frame: flatten the document as it now
 * stands, evaluate the value graph (ONE session, so the bus keeps its state across the
 * press), compile with its channels, install, render, read back.
 */
async function show(red: StoredParameter) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  system.components.register(rig("keysrig", KEYS));
  system.components.register(rig("takerig", TAKE));
  const run = presetSession(document(red), system.nodes);
  const values = createValueGraphSession(system.nodes);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  await backend.initialize({});
  let frameIndex = 0;
  const frame = async (): Promise<Buffer> => {
    const input = { timeSeconds: frameIndex * DT, deltaSeconds: DT, frameIndex, mode: "realtime" as const, randomSeed: 1, absTimeSeconds: frameIndex * DT };
    frameIndex += 1;
    const graph = run.graph();
    const components = system.components.view();
    const flattened = flattenComponents({ graph, registry: system.nodes, components });
    const evaluated = values.evaluate(flattened.graph, input, { flattening: flattened });
    const plan = compileGraph({
      graph,
      settings,
      registry: system.nodes,
      capabilities: CAPABILITIES,
      components,
      flattened,
      resolution: { frame: input, channels: evaluated.resolver },
    });
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const inputs: FrameInputs = { frame: input, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [8, 8] };
    backend.render(await backend.compile(plan), inputs);
    return Buffer.from((await backend.readOutput(outputResourceIdOf(plan, "out"))).bytes);
  };
  return {
    async frames(count: number): Promise<Buffer> {
      let last = await frame();
      for (let index = 1; index < count; index += 1) last = await frame();
      return last;
    },
    press: (name: string) => run.recall("source", name),
    dispose: () => backend.dispose(),
  };
}

/** The picture with red held at `value`: what a frame whose bus reads `value` must equal. */
async function held(value: number): Promise<Buffer> {
  const stage = await show(value);
  try {
    return await stage.frames(1);
  } finally {
    stage.dispose();
  }
}

describe("T1770b — the output on the frame a bank switches the live source", () => {
  it("is one eased step from the old source: not black, not the new source, and it settles there", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const step = KEYS + (TAKE - KEYS) * (1 - Math.exp(-DT / BUS_LAG));
    const [onKeys, onStep, onTake, black] = await Promise.all([held(KEYS), held(step), held(TAKE), held(0)]);
    // The four reference pictures are four different pictures, or the equalities below say nothing.
    expect(new Set([onKeys, onStep, onTake, black].map((each) => each.toString("hex"))).size).toBe(4);

    const stage = await show(expressionSlot("op('lag_bus').chan.level", 0));
    try {
      // On the keys: the picture is the keys' level, read through the bus.
      expect(Buffer.compare(await stage.frames(10), onKeys)).toBe(0);

      await stage.press("take");

      // THE SWITCH FRAME.
      const switched = await stage.frames(1);
      expect(Buffer.compare(switched, onStep)).toBe(0);
      expect(Buffer.compare(switched, black)).not.toBe(0);
      expect(Buffer.compare(switched, onTake)).not.toBe(0);

      // Ten bus time constants later the picture is the take's.
      expect(Buffer.compare(await stage.frames(Math.ceil((10 * BUS_LAG) / DT)), onTake)).toBe(0);
    } finally {
      stage.dispose();
    }
  }, 180_000);
});
