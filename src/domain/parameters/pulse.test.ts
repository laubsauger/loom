import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { ParameterSchema, PulseParameter } from "../types/parameters.ts";
import {
  PULSE_NODE_TOKEN,
  createPulseWatcher,
  isPulseArmed,
  pulseCommandInput,
  pulseParametersOf,
} from "./pulse.ts";

const RESET: PulseParameter = {
  type: "pulse",
  label: "Reset",
  fires: "runtime.resetFeedback",
  input: { nodeIds: [PULSE_NODE_TOKEN], scoped: true },
};

const SCHEMA: ParameterSchema = {
  decay: { type: "number", label: "Decay", default: 0.9 },
  resetPulse: RESET,
};

const registry = {
  get: (type: string) => (type === "feedback" ? { parameters: SCHEMA } : undefined),
};

function node(expression: string | null): GraphNode {
  return {
    id: "n1",
    type: "feedback",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters:
      expression === null
        ? {}
        : {
            resetPulse: {
              mode: "expression",
              bindings: { expression: { kind: "expression", source: expression } },
            },
          },
  };
}

function graphWith(n: GraphNode): GraphDocument {
  return { revision: 1, nodes: { [n.id]: n }, edges: {}, groups: {} };
}

function frameAt(frameIndex: number): FrameEvaluationInput {
  return {
    timeSeconds: frameIndex / 60,
    deltaSeconds: 1 / 60,
    frameIndex,
    mode: "realtime",
    randomSeed: 1,
  };
}

describe("pulse command input (§V123)", () => {
  it("substitutes the firing node id, inside arrays as well as at the top level", () => {
    expect(pulseCommandInput(RESET, "node-7")).toEqual({ nodeIds: ["node-7"], scoped: true });
  });

  it("is a copy, so two nodes firing the same manifest pulse cannot share a payload", () => {
    const first = pulseCommandInput(RESET, "a");
    const second = pulseCommandInput(RESET, "b");
    expect(first["nodeIds"]).not.toBe(second["nodeIds"]);
    expect(second).toEqual({ nodeIds: ["b"], scoped: true });
  });

  it("finds the pulses a schema declares and nothing else", () => {
    expect(pulseParametersOf(SCHEMA).map((entry) => entry.key)).toEqual(["resetPulse"]);
  });
});

describe("armed (§V125)", () => {
  it("reads an expression result as armed when it is non-zero", () => {
    expect(isPulseArmed(1)).toBe(true);
    expect(isPulseArmed(-0.5)).toBe(true);
    expect(isPulseArmed(0)).toBe(false);
    expect(isPulseArmed(true)).toBe(true);
    expect(isPulseArmed(false)).toBe(false);
  });

  it("is never armed by a value the document could hold", () => {
    // §V124 caps a stored pulse at `false`; nothing else should read as a trigger.
    expect(isPulseArmed(null)).toBe(false);
    expect(isPulseArmed("1")).toBe(false);
  });
});

describe("the watcher fires on the rising edge, not the level (§V125)", () => {
  /**
   * The distinction this suite exists for: `frame > 2` is true forever once it is true.
   * Level-triggering it would clear the feedback buffer on EVERY frame after the third —
   * a loop that never accumulates, driven by an expression that reads perfectly correct.
   */
  it("fires once when a latching expression becomes true, and never again", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame - 2"));

    expect(watcher.step(graph, frameAt(0))).toEqual([]); // first sighting: record, do not fire
    expect(watcher.step(graph, frameAt(1))).toEqual([]);
    expect(watcher.step(graph, frameAt(2))).toEqual([]); // frame - 2 === 0, still disarmed
    expect(watcher.step(graph, frameAt(3)).map((fire) => fire.key)).toEqual(["resetPulse"]);
    expect(watcher.step(graph, frameAt(4))).toEqual([]);
    expect(watcher.step(graph, frameAt(5))).toEqual([]);
  });

  it("fires again once the expression has fallen back to zero", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame % 2"));

    watcher.step(graph, frameAt(0)); // 0 — disarmed, first sighting
    expect(watcher.step(graph, frameAt(1))).toHaveLength(1);
    expect(watcher.step(graph, frameAt(2))).toHaveLength(0);
    expect(watcher.step(graph, frameAt(3))).toHaveLength(1);
  });

  it("does not fire on the first frame of a project whose expression is already true", () => {
    // §V124's "would wipe your work every open", reached by the other road: opening a
    // document must never trigger a reset just because its condition happens to hold.
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("1"));
    expect(watcher.step(graph, frameAt(0))).toEqual([]);
    expect(watcher.step(graph, frameAt(1))).toEqual([]);
  });

  it("ignores a pulse nobody is driving — a click is not the watcher's business", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node(null));
    expect(watcher.step(graph, frameAt(0))).toEqual([]);
    expect(watcher.step(graph, frameAt(1))).toEqual([]);
  });

  it("reports the node and the definition, so the caller needs no second lookup", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame - 1"));
    watcher.step(graph, frameAt(1)); // frame - 1 === 0: disarmed, and the first sighting
    const [fire] = watcher.step(graph, frameAt(2));
    expect(fire?.nodeId).toBe("n1");
    expect(fire?.definition.fires).toBe("runtime.resetFeedback");
  });

  it("forgets its armed levels on reset, so a reload cannot inherit an edge", () => {
    const watcher = createPulseWatcher(registry);
    const graph = graphWith(node("frame % 2"));
    watcher.step(graph, frameAt(0));
    expect(watcher.step(graph, frameAt(1))).toHaveLength(1);
    watcher.reset();
    // First sighting again: the level is recorded, nothing fires.
    expect(watcher.step(graph, frameAt(3))).toHaveLength(0);
  });
});

describe("a DRIVEN pulse fires through the channel resolver (T628, T593's class)", () => {
  const drivenNode = (): GraphNode => ({
    id: "n1",
    type: "feedback",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {
      resetPulse: {
        mode: "driven",
        bindings: {
          driven: { kind: "driven", channel: "lfo1" },
          static: { kind: "static", value: 0 },
        },
      },
    },
  } as never);

  it("fires on the channel's rising edge WITH the resolver, and never without it (§V461)", () => {
    // The channel: 0 on even frames, 1 on odd — an LFO wired to the reset.
    const channels = (name: string, context: { frame: FrameEvaluationInput }) =>
      name === "lfo1" ? context.frame.frameIndex % 2 : undefined;

    const wired = createPulseWatcher(registry);
    const graph = graphWith(drivenNode());
    expect(wired.step(graph, frameAt(0), channels as never)).toEqual([]); // first sighting
    expect(wired.step(graph, frameAt(1), channels as never)).toHaveLength(1);
    expect(wired.step(graph, frameAt(2), channels as never)).toHaveLength(0);
    expect(wired.step(graph, frameAt(3), channels as never)).toHaveLength(1);

    // WITHOUT the resolver the driven parameter reads its retained static forever —
    // the silent never-fires this parameter ended. Both worlds pinned: remove the
    // resolver plumbing and the wired half above is what catches it.
    const unwired = createPulseWatcher(registry);
    for (let index = 0; index < 4; index += 1) {
      expect(unwired.step(graph, frameAt(index))).toEqual([]);
    }
  });
});
