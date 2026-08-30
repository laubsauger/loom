import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { compileGraph } from "../../compiler/index.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { constantNode, lfoNode, lfoValue, timerNode } from "./values.ts";

const valueSettings: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const valueCapabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/**
 * T238-T240 (§V143): value sources are pure functions of parameters and the frame — the
 * SAME frame always yields the SAME number, on any machine, offline or live.
 */

const frameAt = (timeSeconds: number, randomSeed = 7): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed,
});

describe("lfoValue (T238)", () => {
  it("oscillates the declared shapes with amplitude and offset applied", () => {
    const base = { frequency: 1, amplitude: 2, offset: 10, phase: 0 };
    // Sine: t=0.25 is the crest of a 1Hz cycle.
    expect(lfoValue({ ...base, shape: "sine" }, frameAt(0.25))).toBeCloseTo(12, 10);
    expect(lfoValue({ ...base, shape: "sine" }, frameAt(0.75))).toBeCloseTo(8, 10);
    // Square: first half high, second half low.
    expect(lfoValue({ ...base, shape: "square" }, frameAt(0.1))).toBe(12);
    expect(lfoValue({ ...base, shape: "square" }, frameAt(0.6))).toBe(8);
    // Saw: ramps -1 → 1 across the cycle.
    expect(lfoValue({ ...base, shape: "saw" }, frameAt(0.5))).toBeCloseTo(10, 10);
    // Triangle: crest at the quarter cycle.
    expect(lfoValue({ ...base, shape: "triangle" }, frameAt(0.25))).toBeCloseTo(12, 10);
  });

  it("applies frequency and phase as cycles", () => {
    // 4Hz at t=1/16 is a quarter cycle — the sine crest.
    expect(lfoValue({ shape: "sine", frequency: 4, amplitude: 1, offset: 0, phase: 0 }, frameAt(1 / 16))).toBeCloseTo(1, 10);
    // A phase of 0.25 shifts the crest to t=0.
    expect(lfoValue({ shape: "sine", frequency: 1, amplitude: 1, offset: 0, phase: 0.25 }, frameAt(0))).toBeCloseTo(1, 10);
  });

  it("holds one deterministic noise value per cycle, keyed by the project seed (§V45)", () => {
    const params = { shape: "noise", frequency: 2, amplitude: 1, offset: 0, phase: 0 };
    const a = lfoValue(params, frameAt(0.1));
    const withinSameCycle = lfoValue(params, frameAt(0.2));
    const nextCycle = lfoValue(params, frameAt(0.6));
    expect(withinSameCycle).toBe(a); // sample & hold: constant inside the cycle
    expect(nextCycle).not.toBe(a);
    // Same frame, same seed, same number — replay-identical. A different seed differs.
    expect(lfoValue(params, frameAt(0.1))).toBe(a);
    expect(lfoValue(params, frameAt(0.1, 8))).not.toBe(a);
    expect(Math.abs(a)).toBeLessThanOrEqual(1);
  });
});

describe("constant and timer (T239, T240)", () => {
  it("constant returns its value, whatever the clock says", () => {
    expect(constantNode.valueChannel?.({ value: 42 }, frameAt(123))).toBe(42);
  });

  it("timer ramps after its delay, scaled by speed, never negative", () => {
    const channel = timerNode.valueChannel;
    expect(channel?.({ speed: 2, delay: 1 }, frameAt(0.5))).toBe(0);
    expect(channel?.({ speed: 2, delay: 1 }, frameAt(3))).toBe(4);
  });

  /**
   * This test used to assert `outputs` was EMPTY, and that is how B31 survived: the suite
   * was defending the missing port as if it were the design. "The number is the output"
   * is true of §V143's compile side — no passes, no resources, nothing on the GPU — and
   * says nothing about whether the number can be WIRED. Both halves are asserted
   * separately now, so neither can stand in for the other again.
   */
  it("emits no passes and takes no inputs — the number IS the output (§V143)", () => {
    for (const definition of [lfoNode, constantNode, timerNode]) {
      expect(definition.inputs, definition.type).toEqual([]);
      expect(definition.compile({} as never), definition.type).toEqual({ passes: [] });
    }
  });
});

/**
 * T325 (§V237): the trio can be WIRED, not merely addressed.
 *
 * Being reachable by NAME (`driven → lfo1`) and being reachable from an EDGE are two
 * different things, and these nodes shipped with only the first. The tests below are
 * therefore about the graph, not about the numbers — `lfoValue` was always correct, and
 * every one of its unit tests stayed green while no chain in the running app could be
 * built from it.
 */
describe("value sources are wirable (T325, §V237)", () => {
  const registry = createNodeRegistry(allNodeDefinitions).view();

  function graphOf(
    nodes: Array<{ id: string; type: string; parameters?: Record<string, unknown> }>,
    edges: Array<[string, string, string, string]>,
  ): GraphDocument {
    const edgeRecord: Record<string, unknown> = {};
    edges.forEach(([sn, sp, tn, tp], index) => {
      edgeRecord[`e${index}`] = {
        id: `e${index}`,
        source: { nodeId: sn, portId: sp },
        target: { nodeId: tn, portId: tp },
      };
    });
    return {
      revision: 1,
      groups: {},
      edges: edgeRecord,
      nodes: Object.fromEntries(
        nodes.map((entry) => [
          entry.id,
          {
            id: entry.id,
            type: entry.type,
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            label: entry.id,
            parameters: entry.parameters ?? {},
          },
        ]),
      ),
    } as unknown as GraphDocument;
  }

  const sessionFrame = (timeSeconds: number): FrameEvaluationInput => ({
    timeSeconds,
    deltaSeconds: 1 / 60,
    frameIndex: Math.round(timeSeconds * 60),
    mode: "realtime",
    randomSeed: 7,
  });

  it("each declares a value output port", () => {
    // The whole bug, as a shape. A value edge needs somewhere to land, and these three
    // declared no ports at all — so the ONLY wirable source in the catalogue was Mouse.
    for (const definition of [lfoNode, constantNode, timerNode]) {
      expect(definition.outputs.map((port) => port.id), definition.type).toEqual(["out"]);
      expect(definition.outputs[0]?.type, definition.type).toEqual({ kind: "value" });
    }
  });

  it("carries a MOVING number from an LFO through a Lag, in the real session", () => {
    // The claim B31 says the app could not make: a value chain producing a changing
    // number. Asserted by driving thirty real frames and watching the far end move —
    // not by inspecting a port, because a port that exists and a chain that carries are
    // exactly the two things this bug proved are different.
    const graph = graphOf(
      [
        { id: "lfo1", type: "lfo", parameters: { shape: "sine", frequency: 1 } },
        { id: "lag1", type: "valueLag" },
      ],
      [["lfo1", "out", "lag1", "in"]],
    );
    const session = createValueGraphSession(registry);

    const seen: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      const result = session.evaluate(graph, sessionFrame(frame / 60));
      const lagged = result.byName.get("lag1")?.["value"];
      expect(lagged, `frame ${frame}`).toBeTypeOf("number");
      seen.push(lagged as number);
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.1);
  });

  it("lands the single channel on the name every downstream stage already reads", () => {
    // §V180's degenerate case, through the graph rather than through the resolver. The
    // evaluator wraps a `valueChannel` node's number as `{ value }`, and Math's operand
    // falls back to a `value` channel — so a Constant wired into Math is arithmetic on a
    // named knob with nothing configured. If the bag arrived under any other name, this
    // would quietly read the parameter default instead and still produce a number.
    const graph = graphOf(
      [
        { id: "const1", type: "constant", parameters: { value: 4 } },
        { id: "const2", type: "constant", parameters: { value: 10 } },
        { id: "math1", type: "valueMath", parameters: { operation: "add", operand: 999 } },
      ],
      [
        ["const1", "out", "math1", "a"],
        ["const2", "out", "math1", "b"],
      ],
    );
    const result = createValueGraphSession(registry).evaluate(graph, sessionFrame(0));
    expect(result.byName.get("math1")?.["value"]).toBe(14);
  });

  it("allocates no GPU resource for a value output (§V179)", () => {
    // The risk this change introduces: three nodes that had no ports now have one, and a
    // port is what the compiler walks to decide what to allocate. A value port must stay
    // invisible to it — a Timer that quietly took a full-resolution target would be a
    // texture per knob.
    const plan = compileGraph({
      graph: graphOf([{ id: "timer1", type: "timer" }], []),
      settings: valueSettings,
      registry,
      capabilities: valueCapabilities,
    });
    expect(plan.resources.filter((resource) => resource.kind !== "sampler")).toEqual([]);
    expect(plan.outputs.some((output) => output.nodeId === "timer1")).toBe(false);
  });
});
