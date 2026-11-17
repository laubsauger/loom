import { describe, expect, it } from "vitest";

import { flattenComponents } from "@compiler/index.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { componentNodeType, createComponentSystem } from "@domain/components/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { parsePresetBank } from "./bank.ts";
import { presetBankNode, presetSession } from "./test-support.ts";

/**
 * T1770b — ONE SOURCE LIVE AT A TIME, CHOSEN BY A PRESET. The owner's case, literally: two
 * music-source rigs (component instances, each a source feeding its own smoothing) wired
 * into ONE bus, and a bank whose presets each hold the whole `on` row. The performer
 * presses one preset and the show goes from one source to the other.
 *
 * THE BUS is a Value Switch into a Lag, and that is the shape a real document can hold: an
 * input takes ONE wire (§V14; two wires into the Lag are `compiler/port-occupied`), and
 * §V457 wants exclusivity from a switch. A source that is off is not a branch of the
 * switch (§V503), so with one source live the switch has one branch and passes it whatever
 * its index says: the choice is made by which rig is on, and the index is never touched.
 *
 * Why each claim matters on stage:
 *  - the bus on the switch frame is ONE EASED STEP from the old source toward the new one.
 *    A frame with both sources (a merge) or neither (silence, and every reader stepping to
 *    its stored value) is the visible glitch this feature exists to make impossible;
 *  - the rig that is off is not evaluated AT ALL. A switch that only hid its output would
 *    leave four rigs' cost in a show that uses one;
 *  - the press is one revision, one undo, one audit entry, like a Layer's switch;
 *  - the rig that comes back starts on its input, not on where it stood when it left.
 *
 * Real bus, real `preset.recall`, real flattener, real value graph. The picture half is
 * `src/tests/headless/source-switch.gpu.test.ts`.
 */

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string, ui?: GraphNode["ui"]): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label, ...(ui === undefined ? {} : { ui }) }) as never;

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** A source rig: a level, its own half-second smoothing, one value output `score`. */
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
        smooth: node("smooth", "valueLag", { lag: 0.5 }, "lag_inner"),
        out: node("out", "componentOutValue", {}, "score"),
      },
      edges: { a: edge("a", ["src", "out"], ["smooth", "in"]), b: edge("b", ["smooth", "out"], ["out", "in"]) },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  } as never;
}

const KEYS = 0.25;
const TAKE = 0.75;
const BUS_LAG = 0.2;
const DT = 1 / 60;

function document(withBusEdges = true): GraphDocument {
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
    },
    edges: {
      ...(withBusEdges ? { e0: edge("e0", ["keys", "score"], ["pick", "in1"]), e1: edge("e1", ["take", "score"], ["pick", "in2"]) } : {}),
      e2: edge("e2", ["pick", "out"], ["bus", "in"]),
    },
  } as never;
}

/** The show: the bus, the catalogue, and one value graph session fed a frame at a time. */
function show(graph = document()) {
  /** How often each rig's SOURCE was evaluated, by the level it publishes. */
  const cooked = new Map<string, number>();
  const counting = allNodeDefinitions.map((definition): NodeDefinition => {
    if (definition.type !== "valueExpression" || definition.valueEvaluate === undefined) return definition;
    const evaluate = definition.valueEvaluate;
    return {
      ...definition,
      valueEvaluate: (context) => {
        const key = String(context.values["expressions"]);
        cooked.set(key, (cooked.get(key) ?? 0) + 1);
        return evaluate(context);
      },
    };
  });
  const system = createComponentSystem(createNodeRegistry(counting).view());
  system.components.register(rig("keysrig", KEYS));
  system.components.register(rig("takerig", TAKE));
  const run = presetSession(graph, system.nodes);
  const values = createValueGraphSession(system.nodes);
  let frameIndex = 0;
  let flatIds: string[] = [];
  const frame = () => {
    const input: FrameEvaluationInput = { timeSeconds: frameIndex * DT, deltaSeconds: DT, frameIndex, mode: "realtime", randomSeed: 1 };
    frameIndex += 1;
    const flattened = flattenComponents({ graph: run.graph(), registry: system.nodes, components: system.components.view() });
    flatIds = Object.keys(flattened.graph.nodes).sort();
    return values.evaluate(flattened.graph, input, { flattening: flattened });
  };
  return {
    run,
    frame,
    frames(count: number) {
      let last = frame();
      for (let index = 1; index < count; index += 1) last = frame();
      return last;
    },
    flatIds: () => flatIds,
    cooked: (level: number) => cooked.get(`level = ${level}`) ?? 0,
  };
}

describe("a bank chooses the one live source (T1770b)", () => {
  it("the switch frame is one eased step on the bus, and the rig that is off is never evaluated", async () => {
    const stage = show();

    // Thirty frames on the keys: the bus sits exactly on them, and the take does not exist.
    const before = stage.frames(30);
    expect(before.byId.get("bus")).toEqual({ level: KEYS });
    expect(stage.flatIds()).toEqual(["bus", "keys/out", "keys/smooth", "keys/src", "pick", "source", "take"]);
    expect(stage.cooked(KEYS)).toBe(30);
    expect(stage.cooked(TAKE)).toBe(0);

    const revision = stage.run.store.view.getRevision();
    const audit = stage.run.store.view.getAudit().length;
    await stage.run.recall("source", "take");

    // One press: one revision, one audit entry, both flags.
    expect(stage.run.store.view.getRevision()).toBe(revision + 1);
    expect(stage.run.store.view.getAudit().slice(audit).map((entry) => [entry.command, entry.status])).toEqual([["preset.recall", "applied"]]);
    expect(stage.run.graph().nodes["keys"]?.ui?.bypassed).toBe(true);
    expect(stage.run.graph().nodes["take"]?.ui?.bypassed).toBe(false);

    // THE SWITCH FRAME. The take's own smoothing starts ON its input (a clean start, no
    // trajectory left over), and the bus eases one frame from the keys toward it: not the
    // take's value (a step), not the keys' (nothing switched), not absent (no source).
    const switched = stage.frame();
    expect(switched.byId.get("take/smooth")).toEqual({ level: TAKE });
    const step = KEYS + (TAKE - KEYS) * (1 - Math.exp(-DT / BUS_LAG));
    expect(switched.byId.get("bus")).toEqual({ level: step });
    expect(step).toBeCloseTo(0.28997779268533835, 15);
    expect(switched.diagnostics).toEqual([]);
    expect(stage.flatIds()).toEqual(["bus", "keys", "pick", "source", "take/out", "take/smooth", "take/src"]);

    // And the cost follows the choice: thirty more frames evaluate the take and never the keys.
    stage.frames(29);
    expect(stage.cooked(KEYS)).toBe(30);
    expect(stage.cooked(TAKE)).toBe(30);
  });

  it("one undo takes the press back: both sources return to what they were", async () => {
    const stage = show();
    stage.frames(2);
    await stage.run.recall("source", "take");
    await stage.run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(stage.run.graph().nodes["keys"]?.ui?.bypassed === true).toBe(false);
    expect(stage.run.graph().nodes["take"]?.ui?.bypassed === true).toBe(true);
    expect(stage.frame().byId.get("bus")).toEqual({ level: KEYS });
  });

  it("the rig that comes back starts on its input, and the bus eases back from where it was", async () => {
    const stage = show();
    stage.frames(30);
    await stage.run.recall("source", "take");
    const away = stage.frames(30).byId.get("bus")?.["level"] as number;
    await stage.run.recall("source", "keys");
    const back = stage.frame();
    expect(back.byId.get("keys/smooth")).toEqual({ level: KEYS });
    expect(back.byId.get("bus")).toEqual({ level: away + (KEYS - away) * (1 - Math.exp(-DT / BUS_LAG)) });
  });

  it("the bus is fed by the wires: with them cut, the same press moves nothing on it", async () => {
    const stage = show(document(false));
    stage.frames(30);
    await stage.run.recall("source", "take");
    const switched = stage.frame();
    // The take is live and publishing; only the wire carries it to the bus.
    expect(switched.byId.get("take/smooth")).toEqual({ level: TAKE });
    expect(switched.byId.has("bus")).toBe(false);
  });
});

/**
 * T1771b — STORE CAPTURES A SWITCH ONLY WHERE A TARGET ASKS FOR IT. The performer sets the
 * rigs by hand and presses Store, and the bank holds that choice; but a bank that names
 * whole nodes has always stored their parameters and nothing else, and must go on doing so.
 */
describe("Store captures on/off for the targets that ask (`name.@on`)", () => {
  const withBank = (targets: string, extra: Record<string, GraphNode> = {}): GraphDocument => {
    const graph = document();
    return { ...graph, nodes: { ...graph.nodes, ...extra, source: presetBankNode("source", "presets_source", targets, []) } } as never;
  };
  const stored = (stage: ReturnType<typeof show>, name: string) => {
    const bank = parsePresetBank(stage.run.graph().nodes["source"]?.parameters["presets"]);
    return bank.ok ? bank.bank.presets.find((each) => each.name === name) : undefined;
  };
  const store = (stage: ReturnType<typeof show>, name: string) => stage.run.bus.execute("preset.store", { nodeId: "source", name }, contextFor(alice));
  const setOn = (stage: ReturnType<typeof show>, nodeId: string, on: boolean) =>
    stage.run.bus.execute("graph.applyPatch", { baseRevision: stage.run.store.view.getRevision(), operations: [{ op: "setNodeUi", nodeId, ui: { bypassed: !on } }] }, contextFor(alice));

  it("stores the switches as they stand, and a recall puts them back", async () => {
    const stage = show(withBank("keysrig_live.@on takerig_recorded.@on"));
    expect((await store(stage, "keys")).status).toBe("applied");
    expect(stored(stage, "keys")).toEqual({ name: "keys", values: {}, on: { keysrig_live: true, takerig_recorded: false } });

    // The performer switches by hand, stores the other choice, and goes back to the first.
    await setOn(stage, "keys", false);
    await setOn(stage, "take", true);
    await store(stage, "take");
    expect(stored(stage, "take")?.on).toEqual({ keysrig_live: false, takerig_recorded: true });
    await stage.run.recall("source", "keys");
    expect(stage.run.graph().nodes["keys"]?.ui?.bypassed).toBe(false);
    expect(stage.run.graph().nodes["take"]?.ui?.bypassed).toBe(true);
  });

  it("a whole-node target stores parameters and no switch, as it always has", async () => {
    const stage = show(withBank("lag_bus"));
    await setOn(stage, "bus", false);
    await store(stage, "look");
    const preset = stored(stage, "look");
    expect(preset?.values).toEqual({ lag_bus: { lag: BUS_LAG, releaseRatio: 1 } });
    expect(preset?.on).toBeUndefined();
  });

  it("a Toggle's own `on` parameter and its switch are two targets, spelled apart", async () => {
    const toggle = node("tog", "toggle", { channel: "strobe", on: true }, "toggle_strobe", { bypassed: true });
    const stage = show(withBank("toggle_strobe.on toggle_strobe.@on", { tog: toggle }));
    await store(stage, "both");
    // `.on` is the parameter (true); `.@on` is the node's switch (it is bypassed: off).
    expect(stored(stage, "both")).toEqual({ name: "both", values: { toggle_strobe: { on: true } }, on: { toggle_strobe: false } });
  });
});

/**
 * T1771b — A PRESET THAT SWITCHES ONLY PART OF WHAT ITS BANK SWITCHES. Recalled after
 * another, it can leave two sources live, which is the state the selector exists to make
 * impossible. It is said at the recall, naming what was left, and the recall still applies.
 */
describe("a recall says when its preset leaves part of the bank's choice as it was", () => {
  const partial = (): GraphDocument => {
    const graph = document();
    return {
      ...graph,
      nodes: {
        ...graph.nodes,
        source: presetBankNode("source", "presets_source", "lag_bus", [
          { name: "keys", values: {}, on: { keysrig_live: true, takerig_recorded: false } },
          { name: "take", values: {}, on: { takerig_recorded: true } },
          { name: "slow", values: { lag_bus: { lag: 2 } } },
        ]),
      },
    } as never;
  };
  const recall = (stage: ReturnType<typeof show>, name: string) => stage.run.bus.execute("preset.recall", { nodeId: "source", name }, contextFor(alice));
  const remarks = (result: { diagnostics: readonly { severity: string; code: string }[] }): string[] =>
    result.diagnostics.filter((each) => each.severity !== "info").map((each) => each.code);

  it("the partial preset is applied and named; the whole one and a plain value preset say nothing", async () => {
    const stage = show(partial());
    const take = await recall(stage, "take");
    expect(take.status).toBe("applied");
    expect(remarks(take)).toEqual(["preset.on.partial"]);
    expect(take.diagnostics.find((each) => each.code === "preset.on.partial")?.message).toContain('leaves "keysrig_live" as it is');
    // What the remark is about: both sources are now on, and the bus merges nothing but says so.
    expect(stage.run.graph().nodes["keys"]?.ui?.bypassed === true).toBe(false);
    expect(stage.run.graph().nodes["take"]?.ui?.bypassed).toBe(false);

    expect(remarks(await recall(stage, "keys"))).toEqual([]);
    expect(remarks(await recall(stage, "slow"))).toEqual([]);
  });
});
