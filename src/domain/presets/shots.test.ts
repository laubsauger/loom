import { describe, expect, it } from "vitest";

import { flatDocument } from "@compiler/test-support.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSlot, ParameterValue, StoredParameter } from "../types/parameters.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { alice, contextFor } from "../commands/test-support.ts";
import { NO_FLATTENING, parameterReadOptions } from "../parameters/node-references.ts";
import { STORED_READ, resolveParameters } from "../parameters/resolve.ts";
import { liveClock } from "../transport/live-clock.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import { testNodeDefinitions } from "../../nodes/registry/test-nodes.ts";
import { levelNode } from "../../nodes/definitions/color.ts";
import { layerNode } from "../../nodes/definitions/layer.ts";
import { presetsNode } from "../../nodes/definitions/presets.ts";
import { serializePresetBank, type MorphSpec, type Preset } from "./bank.ts";
import { MAX_RECALL_DEPTH, planPresetRecall } from "./commands.ts";
import { parseMorphRecords, type MorphRecord } from "./morph.ts";
import { buildMorphIndex } from "./morph-index.ts";

/**
 * T1499b (§T1398b S4) — SHOTS, and the layer line S3 left for the bank: a preset recalls
 * other banks' presets, and switches layers, inside its ONE patch. Through the REAL bus.
 *
 * Each `describe` is one acceptance line of the design doc §12 (S4, and S3's last). A
 * shot exists so that a performer presses ONE thing and a whole moment changes together
 * and comes back together — so the tests count revisions, undo groups and audit entries,
 * read the document a consumer reads, and undo once. The refusals (a cycle, a nesting too
 * deep) are asserted as "nothing moved", not as "a function returned false": a shot that
 * half-applied before noticing its own loop would leave the show in a look nobody stored.
 */

const registry: NodeRegistryView = createNodeRegistry([...testNodeDefinitions, levelNode, layerNode, presetsNode]).view();

function node(id: NodeId, type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphNode {
  return { id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

/** A bank whose node id IS its name, so a test reads `stored("cityLooks", "current")`. */
function bank(name: string, presets: readonly Preset[], extra: Record<string, StoredParameter> = {}): GraphNode {
  return node(name, "presets", name, { targets: "", presets: serializePresetBank({ version: 1, presets }), current: "", ...extra });
}

const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };

interface Session {
  readonly bus: LoomBus;
  readonly store: GraphStore;
  /** Produces `count` frames at 60 fps on the absolute clock the bus reads. */
  frames(count?: number): FrameEvaluationInput;
  stored(nodeId: NodeId, key: string): StoredParameter | undefined;
  bypassed(nodeId: NodeId): boolean;
  /** What evaluation reads for a key at the latest frame — the one read path, morphs included. */
  shown(nodeId: NodeId, key: string): ParameterValue | undefined;
  records(bankId: NodeId): MorphRecord[];
  /** Every stored parameter and bypass flag of every node: "nothing moved" is equality on this. */
  snapshot(): string;
}

function session(nodes: GraphNode[]): Session {
  const initialGraph: GraphDocument = { revision: 0, nodes: Object.fromEntries(nodes.map((each) => [each.id, each])), edges: {}, groups: {} };
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-02T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store, registry });
  let nowMs = 0;
  const clock = liveClock({ fps: () => 60, now: () => nowMs, epoch: () => "session-1" });
  let last: FrameEvaluationInput | null = null;
  bus.attachFrameClock(() =>
    last?.absEpoch === undefined || last.absTimeSeconds === undefined ? undefined : { epoch: last.absEpoch, absTimeSeconds: last.absTimeSeconds },
  );
  const graph = (): GraphDocument => store.view.getGraph();
  return {
    bus,
    store,
    frames(count = 1) {
      for (let index = 0; index < count; index += 1) {
        nowMs += 1000 / 60;
        last = clock.next();
      }
      if (last === null) throw new Error("no frame has been produced");
      return last;
    },
    stored: (nodeId, key) => graph().nodes[nodeId]?.parameters[key],
    bypassed: (nodeId) => graph().nodes[nodeId]?.ui?.bypassed === true,
    shown(nodeId, key) {
      const target = graph().nodes[nodeId];
      if (target === undefined || last === null) throw new Error(`no node ${nodeId}, or no frame yet`);
      const morphs = buildMorphIndex({ document: graph(), registry });
      return resolveParameters(target, registry.get(target.type), parameterReadOptions({ graph: flatDocument(graph()), registry, frame: last, channels: undefined, flattening: { ...NO_FLATTENING, morphs } })).values[key];
    },
    records: (bankId) => parseMorphRecords(graph().nodes[bankId]?.parameters["morphs"]),
    snapshot: () => JSON.stringify(Object.values(graph().nodes).map((each) => [each.id, each.parameters, each.ui ?? null])),
  };
}

const recall = (run: Session, bankId: NodeId, name: string, morph?: MorphSpec) =>
  run.bus.execute("preset.recall", { nodeId: bankId, name, ...(morph === undefined ? {} : { morph }) }, contextFor(alice));

const warnings = (result: { diagnostics: readonly { severity: string; code: string }[] }): string[] =>
  result.diagnostics.filter((each) => each.severity !== "info").map((each) => each.code);

/**
 * The design doc's own example (§8.1), on nodes this registry knows: two looks' banks, a
 * shots bank whose "drop" sets a layer, switches two, and recalls a preset from each.
 */
function stage(drop: Partial<Preset> = {}): GraphNode[] {
  return [
    node("city", "level", "city", { brightness: 0.2, contrast: 1 }),
    node("grit", "level", "grit", { brightness: 0.1 }),
    node("l1", "layer", "layer1", { opacity: 0.25 }),
    node("l2", "layer", "layer2", { opacity: 1 }),
    bank("cityLooks", [
      { name: "calm", values: { city: { brightness: 0.2, contrast: 1 } } },
      { name: "riot", values: { city: { brightness: 0.8, contrast: 2 } } },
    ]),
    bank("fx", [{ name: "dirty", values: { grit: { brightness: 0.6 } } }]),
    bank("shots", [
      {
        name: "drop",
        values: { layer1: { opacity: 0.75 } },
        on: { layer2: false },
        recalls: [
          { bank: "cityLooks", preset: "riot" },
          { bank: "fx", preset: "dirty" },
        ],
        ...drop,
      },
    ]),
  ];
}

describe("a shot recalling two banks is ONE revision and ONE undo (S4)", () => {
  it("writes both banks' presets, its own values and its layers together, and one undo takes all of it back", async () => {
    const run = session(stage());
    const before = run.snapshot();
    const revision = run.store.view.getRevision();
    const auditBefore = run.store.view.getAudit().length;
    const undoBefore = run.store.view.getHistory(alice).undo.length;

    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("applied");
    // Nothing is "parsed but not applied" any more: a shot's recalls and on raise no warning.
    expect(warnings(result)).toEqual([]);
    expect(result.output).toEqual({
      ok: true,
      preset: "drop",
      applied: ["city.brightness", "city.contrast", "grit.brightness", "layer1.opacity", "layer2.on"],
      skipped: [],
      morph: null,
    });

    // The nested presets' values, from two banks…
    expect(run.stored("city", "brightness")).toBe(0.8);
    expect(run.stored("city", "contrast")).toBe(2);
    expect(run.stored("grit", "brightness")).toBe(0.6);
    // …the shot's own, and its layer switched off…
    expect(run.stored("l1", "opacity")).toBe(0.75);
    expect(run.bypassed("l2")).toBe(true);
    // …and every bank it recalled from shows what it now holds.
    expect(run.stored("shots", "current")).toBe("drop");
    expect(run.stored("cityLooks", "current")).toBe("riot");
    expect(run.stored("fx", "current")).toBe("dirty");

    expect(run.store.view.getRevision()).toBe(revision + 1);
    const audit = run.store.view.getAudit().slice(auditBefore);
    expect(audit.map((entry) => [entry.command, entry.status, entry.actor.id])).toEqual([["preset.recall", "applied", "alice"]]);
    const history = run.store.view.getHistory(alice).undo;
    expect(history).toHaveLength(undoBefore + 1);
    expect(history.at(-1)?.label).toBe('Recall "drop" (shots)');

    const undone = await run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    expect(run.bypassed("l2")).toBe(false);
    expect(run.stored("city", "brightness")).toBe(0.2);
    expect(run.stored("city", "contrast")).toBe(1);
    expect(run.stored("grit", "brightness")).toBe(0.1);
    expect(run.stored("l1", "opacity")).toBe(0.25);
    expect([run.stored("shots", "current"), run.stored("cityLooks", "current"), run.stored("fx", "current")]).toEqual(["", "", ""]);
    // Not one stored value or flag anywhere in the document is other than it was.
    expect(run.snapshot()).toBe(before);
  });

  it("skips a recall that names a bank or a preset that is gone, by name, and applies the rest (ruling 4)", async () => {
    const run = session(
      stage({
        recalls: [
          { bank: "gone", preset: "x" },
          { bank: "cityLooks", preset: "nope" },
          { bank: "city", preset: "x" },
          { bank: "fx", preset: "dirty" },
        ],
      }),
    );
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("applied");
    expect(result.output.skipped).toEqual(["gone.x", "cityLooks.nope", "city.x"]);
    expect(warnings(result)).toEqual(["preset.recalls.missing", "preset.recalls.unknown", "preset.recalls.type"]);
    const messages = result.diagnostics.map((each) => each.message).join("\n");
    expect(messages).toContain('no node is named "gone"');
    expect(messages).toContain('bank "cityLooks" has no preset "nope"');
    expect(messages).toContain('"city" is a level node, not a Presets bank');
    // The rest of the shot landed, and a bank nothing was written from keeps its `current`.
    expect(run.stored("grit", "brightness")).toBe(0.6);
    expect(run.stored("l1", "opacity")).toBe(0.75);
    expect(run.stored("city", "brightness")).toBe(0.2);
    expect(run.stored("cityLooks", "current")).toBe("");
    expect(run.stored("fx", "current")).toBe("dirty");
  });

  it("is refused when its recalls are gone and it holds nothing of its own", async () => {
    const run = session([bank("shots", [{ name: "drop", values: {}, recalls: [{ bank: "gone", preset: "x" }] }])]);
    const before = run.snapshot();
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((each) => each.code)).toEqual(["preset.recalls.missing", "preset.recall.nothing"]);
    expect(run.snapshot()).toBe(before);
  });
});

describe("a cycle between two banks is refused, naming both (S4)", () => {
  const looped = (): GraphNode[] => [
    node("city", "level", "city", { brightness: 0.2 }),
    bank("shots", [{ name: "drop", values: { city: { brightness: 0.9 } }, recalls: [{ bank: "cityLooks", preset: "riot" }] }]),
    bank("cityLooks", [{ name: "riot", values: { city: { contrast: 2 } }, recalls: [{ bank: "shots", preset: "drop" }] }]),
  ];

  it("changes nothing, and the refusal spells the circle and both banks", async () => {
    const run = session(looped());
    const before = run.snapshot();
    const revision = run.store.view.getRevision();
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ ok: false, preset: "drop", applied: [], skipped: [], morph: null });
    // The cycle is THE reason: not "nothing left to apply", which would send the user
    // looking for a deleted node.
    expect(result.diagnostics.map((each) => [each.severity, each.code])).toEqual([["error", "preset.recall.cycle"]]);
    const message = result.diagnostics[0]?.message ?? "";
    expect(message).toContain("shots.drop → cityLooks.riot → shots.drop");
    expect(message).toContain('Banks "shots" and "cityLooks" recall each other');
    expect(run.snapshot()).toBe(before);
    expect(run.store.view.getRevision()).toBe(revision);
  });

  it("is refused from the other bank too", async () => {
    const run = session(looped());
    const before = run.snapshot();
    const result = await recall(run, "cityLooks", "riot");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.message).toContain('Banks "cityLooks" and "shots" recall each other');
    expect(run.snapshot()).toBe(before);
  });

  it("is refused when the circle is further down than the recalled preset", async () => {
    const run = session([
      ...looped(),
      bank("cues", [{ name: "open", values: { city: { brightness: 0.5 } }, recalls: [{ bank: "shots", preset: "drop" }] }]),
    ]);
    const before = run.snapshot();
    const result = await recall(run, "cues", "open");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((each) => each.code)).toEqual(["preset.recall.cycle"]);
    // The two banks ON the circle are named; the one that merely leads into it is not blamed.
    expect(result.diagnostics[0]?.message).toContain('Banks "shots" and "cityLooks" recall each other');
    expect(run.snapshot()).toBe(before);
  });

  it("a preset that recalls itself is refused, naming its bank", async () => {
    const run = session([
      node("city", "level", "city", { brightness: 0.2 }),
      bank("shots", [{ name: "drop", values: { city: { brightness: 0.9 } }, recalls: [{ bank: "shots", preset: "drop" }] }]),
    ]);
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.message).toContain('Bank "shots" recalls itself');
    expect(run.stored("city", "brightness")).toBe(0.2);
  });

  it("the planner itself says so: no operations, nothing applied, `refused` — what the cue list's GO reads (§T1500b)", () => {
    const run = session(looped());
    const graph = run.store.view.getGraph();
    const shots = graph.nodes["shots"]!;
    const drop: Preset = { name: "drop", values: { city: { brightness: 0.9 } }, recalls: [{ bank: "cityLooks", preset: "riot" }] };
    const plan = planPresetRecall(graph, registry, shots, drop);
    // A caller that only knows "nothing applied means refuse" must refuse this too.
    expect(plan.refused).toBe(true);
    expect(plan.operations).toEqual([]);
    expect(plan.applied).toEqual([]);
    expect(plan.diagnostics.map((each) => [each.severity, each.code])).toEqual([["error", "preset.recall.cycle"]]);
    // And an ordinary preset is not refused.
    const plain = planPresetRecall(graph, registry, shots, { name: "plain", values: { city: { brightness: 0.9 } } });
    expect(plain.refused).toBe(false);
    expect(plain.applied).toEqual(["city.brightness"]);
  });

  it("the legitimate case the check could swallow: two presets of ONE bank on a chain end, and apply", async () => {
    // shots.drop → cityLooks.riot → shots.base: `shots` is met twice, but no preset is.
    const run = session([
      node("city", "level", "city", { brightness: 0.2, contrast: 1 }),
      bank("shots", [
        { name: "base", values: { city: { contrast: 3 } } },
        { name: "drop", values: {}, recalls: [{ bank: "cityLooks", preset: "riot" }] },
      ]),
      bank("cityLooks", [{ name: "riot", values: { city: { brightness: 0.8 } }, recalls: [{ bank: "shots", preset: "base" }] }]),
    ]);
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("applied");
    expect(warnings(result)).toEqual([]);
    expect(run.stored("city", "brightness")).toBe(0.8);
    expect(run.stored("city", "contrast")).toBe(3);
    // The recalled bank's `current` is the recalled preset, not the one a nested recall reached.
    expect(run.stored("shots", "current")).toBe("drop");
    expect(run.stored("cityLooks", "current")).toBe("riot");
  });

  it("the same preset reached down two branches is not a circle", async () => {
    const run = session([
      node("city", "level", "city", { brightness: 0.2 }),
      bank("looks", [{ name: "riot", values: { city: { brightness: 0.8 } } }]),
      bank("a", [{ name: "p", values: {}, recalls: [{ bank: "looks", preset: "riot" }] }]),
      bank("b", [{ name: "p", values: {}, recalls: [{ bank: "looks", preset: "riot" }] }]),
      bank("shots", [
        {
          name: "drop",
          values: {},
          recalls: [
            { bank: "a", preset: "p" },
            { bank: "b", preset: "p" },
          ],
        },
      ]),
    ]);
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("applied");
    expect(run.stored("city", "brightness")).toBe(0.8);
  });
});

/**
 * A chain of banks `b0 → b1 → … → b<hops>`, each preset setting its own Level and
 * recalling the next. `b0.p` is the recalled preset (depth 0); `b<n>` sits at depth n.
 */
function chain(hops: number): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (let depth = 0; depth <= hops; depth += 1) {
    nodes.push(node(`level${String(depth)}`, "level", `level${String(depth)}`, { brightness: 0 }));
    nodes.push(
      bank(`b${String(depth)}`, [
        {
          name: "p",
          values: { [`level${String(depth)}`]: { brightness: 0.5 } },
          ...(depth < hops ? { recalls: [{ bank: `b${String(depth + 1)}`, preset: "p" }] } : {}),
        },
      ]),
    );
  }
  return nodes;
}

describe("depth 4 nests, depth 5 is refused (S4, ruling 14)", () => {
  it("the limit is four", () => {
    // The ruling's number, pinned: the two cases below are built off the constant.
    expect(MAX_RECALL_DEPTH).toBe(4);
  });

  it("a chain four recalls deep applies down to the deepest bank", async () => {
    const run = session(chain(MAX_RECALL_DEPTH));
    const result = await recall(run, "b0", "p");
    expect(result.status).toBe("applied");
    expect(warnings(result)).toEqual([]);
    for (let depth = 0; depth <= MAX_RECALL_DEPTH; depth += 1) {
      expect(run.stored(`level${String(depth)}`, "brightness"), `depth ${String(depth)}`).toBe(0.5);
      expect(run.stored(`b${String(depth)}`, "current"), `depth ${String(depth)}`).toBe("p");
    }
  });

  it("a chain five recalls deep is refused, and nothing moves — not even the levels within the limit", async () => {
    const run = session(chain(MAX_RECALL_DEPTH + 1));
    const before = run.snapshot();
    const result = await recall(run, "b0", "p");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((each) => [each.severity, each.code])).toEqual([["error", "preset.recall.depth"]]);
    const message = result.diagnostics[0]?.message ?? "";
    expect(message).toContain("5 deep");
    expect(message).toContain("b0.p → b1.p → b2.p → b3.p → b4.p → b5.p");
    expect(message).toContain("the limit is 4");
    expect(run.snapshot()).toBe(before);
  });
});

describe("the shot's own value wins over a nested one (S4, ruling 14)", () => {
  it("per key: the shot's key lands, and the nested preset's other keys still do", async () => {
    const run = session(stage({ values: { city: { brightness: 0.5 }, layer1: { opacity: 0.75 } } }));
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("applied");
    // riot says 0.8; the shot says 0.5, and the shot is what was recalled.
    expect(run.stored("city", "brightness")).toBe(0.5);
    // riot's contrast is not the shot's business, so it lands.
    expect(run.stored("city", "contrast")).toBe(2);
    // One write per key: the losing value is not written and then overwritten.
    expect(result.output.applied.filter((name) => name === "city.brightness")).toHaveLength(1);
  });

  it("at every level: a nested preset's own value wins over what IT recalls", async () => {
    const run = session([
      node("city", "level", "city", { brightness: 0, contrast: 0 }),
      bank("deep", [{ name: "p", values: { city: { brightness: 0.1, contrast: 0.1 } } }]),
      bank("mid", [{ name: "p", values: { city: { contrast: 0.4 } }, recalls: [{ bank: "deep", preset: "p" }] }]),
      bank("shots", [{ name: "drop", values: {}, recalls: [{ bank: "mid", preset: "p" }] }]),
    ]);
    await recall(run, "shots", "drop");
    expect(run.stored("city", "brightness")).toBe(0.1);
    expect(run.stored("city", "contrast")).toBe(0.4);
  });

  it("between two recalls of one shot, the later one wins", async () => {
    const run = session([
      node("city", "level", "city", { brightness: 0 }),
      bank("first", [{ name: "p", values: { city: { brightness: 0.3 } } }]),
      bank("second", [{ name: "p", values: { city: { brightness: 0.7 } } }]),
      bank("shots", [
        {
          name: "drop",
          values: {},
          recalls: [
            { bank: "first", preset: "p" },
            { bank: "second", preset: "p" },
          ],
        },
      ]),
    ]);
    await recall(run, "shots", "drop");
    expect(run.stored("city", "brightness")).toBe(0.7);
    // `first` wrote nothing that survived, so it does not claim to be showing "p".
    expect(run.stored("first", "current")).toBe("");
    expect(run.stored("second", "current")).toBe("p");
  });

  it("the shot's own `on` wins over a nested preset's", async () => {
    const run = session([
      node("l1", "layer", "layer1"),
      bank("layers", [{ name: "allOn", values: {}, on: { layer1: true } }]),
      bank("shots", [{ name: "drop", values: {}, on: { layer1: false }, recalls: [{ bank: "layers", preset: "allOn" }] }]),
    ]);
    await recall(run, "shots", "drop");
    expect(run.bypassed("l1")).toBe(true);
  });

  it("the shot's compound takes the channel a nested preset stored per component (§V113)", async () => {
    const slot: ParameterSlot = { mode: "static", bindings: { static: { kind: "static", value: 0.9 } } };
    const run = session([
      node("solid", "test.solid", "solid1", { color: [0, 0, 0, 1] }),
      bank("looks", [{ name: "red", values: { solid1: { color: [0.2, 0.2, 0.2, 1], "color.r": slot } } }]),
      bank("shots", [{ name: "drop", values: { solid1: { color: [0, 1, 0, 1] } }, recalls: [{ bank: "looks", preset: "red" }] }]),
    ]);
    // Premise: recalled alone, the nested preset's per-component slot DOES land.
    await recall(run, "looks", "red");
    expect(run.stored("solid", "color.r")).toEqual(slot);
    await run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(run.stored("solid", "color.r")).toBeUndefined();

    await recall(run, "shots", "drop");
    expect(run.stored("solid", "color")).toEqual([0, 1, 0, 1]);
    // Had the nested `color.r` been written, red would read 0.9 under the shot's green.
    expect(run.stored("solid", "color.r")).toBeUndefined();
    expect(resolveParameters(run.store.view.getGraph().nodes["solid"]!, registry.get("test.solid"), STORED_READ).values["color"]).toEqual([0, 1, 0, 1]);
  });
});

describe("a morphing shot writes ONE record covering all of its keys (S4)", () => {
  it("the record sits in the shot's bank, holds every key from every bank, and the screen fades them together", async () => {
    const run = session(stage({ morph: LINEAR_1S }));
    run.frames(1);
    const result = await recall(run, "shots", "drop");
    expect(result.status).toBe("applied");
    expect(result.output.morph).toEqual(LINEAR_1S);

    // ONE record, in the bank that was recalled; the banks it reached hold none.
    const records = run.records("shots");
    expect(records).toHaveLength(1);
    expect(run.records("cityLooks")).toEqual([]);
    expect(run.records("fx")).toEqual([]);
    const [record] = records;
    expect(record?.preset).toBe("drop");
    expect(record?.from).toEqual({ city: { brightness: 0.2, contrast: 1 }, grit: { brightness: 0.1 }, layer1: { opacity: 0.25 } });
    expect(record?.to).toEqual({ city: { brightness: 0.8, contrast: 2 }, grit: { brightness: 0.6 }, layer1: { opacity: 0.75 } });

    // The end state committed at once (§5.2), and on/off is a cut (§5.3).
    expect(run.stored("city", "brightness")).toBe(0.8);
    expect(run.bypassed("l2")).toBe(true);

    // Thirty frames into a 1 s linear fade: every key, whichever bank held it, is halfway.
    run.frames(30);
    expect(run.shown("city", "brightness")).toBeCloseTo(0.5, 12);
    expect(run.shown("city", "contrast")).toBeCloseTo(1.5, 12);
    expect(run.shown("grit", "brightness")).toBeCloseTo(0.35, 12);
    expect(run.shown("l1", "opacity")).toBeCloseTo(0.5, 12);

    // One undo takes the record with the values: the screen cuts back.
    await run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(run.records("shots")).toEqual([]);
    expect(run.shown("city", "brightness")).toBe(0.2);
    expect(run.shown("grit", "brightness")).toBe(0.1);
  });

  it("the shot's morph carries the nested presets; a nested preset's own morph is not read", async () => {
    const nodes = stage();
    const run = session([
      ...nodes.filter((each) => each.id !== "fx"),
      bank("fx", [{ name: "dirty", values: { grit: { brightness: 0.6 } }, morph: { seconds: 8, curve: "in" } }]),
    ]);
    run.frames(1);
    // The shot has no morph and its bank's is 0: a cut, whatever `dirty` says about itself.
    const result = await recall(run, "shots", "drop");
    expect(result.output.morph).toBeNull();
    expect(run.records("shots")).toEqual([]);
    expect(run.records("fx")).toEqual([]);
    run.frames(1);
    expect(run.shown("grit", "brightness")).toBe(0.6);
  });
});

describe("a preset's `on` bypasses the layer as part of its one patch (S3's last line)", () => {
  const layered = (presets: readonly Preset[]): GraphNode[] => [
    node("l1", "layer", "layer1", { opacity: 1 }),
    { ...node("l2", "layer", "layer2", { opacity: 1 }), ui: { bypassed: true, collapsed: true } },
    node("city", "level", "city", { brightness: 0.2 }),
    bank("looks", presets),
  ];

  it("off and on land with the values in one revision, and one undo puts the layers back", async () => {
    const run = session(layered([{ name: "swap", values: { city: { brightness: 0.8 } }, on: { layer1: false, layer2: true } }]));
    const revision = run.store.view.getRevision();
    const result = await recall(run, "looks", "swap");
    expect(result.status).toBe("applied");
    expect(warnings(result)).toEqual([]);
    expect(result.output.applied).toEqual(["city.brightness", "layer1.on", "layer2.on"]);
    expect(run.store.view.getRevision()).toBe(revision + 1);
    expect(run.bypassed("l1")).toBe(true);
    expect(run.bypassed("l2")).toBe(false);
    // The flag is written, not the whole `ui`: what else the node's chrome held is kept.
    expect(run.store.view.getGraph().nodes["l2"]?.ui?.collapsed).toBe(true);
    expect(run.stored("city", "brightness")).toBe(0.8);

    await run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(run.bypassed("l1")).toBe(false);
    expect(run.bypassed("l2")).toBe(true);
    expect(run.stored("city", "brightness")).toBe(0.2);
  });

  it("a preset that ONLY switches layers is a recall, not 'nothing to apply'", async () => {
    const run = session(layered([{ name: "dark", values: {}, on: { layer1: false } }]));
    const result = await recall(run, "looks", "dark");
    expect(result.status).toBe("applied");
    expect(run.bypassed("l1")).toBe(true);
    expect(run.stored("looks", "current")).toBe("dark");
  });

  it("is idempotent: off twice leaves it off", async () => {
    const run = session(layered([{ name: "dark", values: {}, on: { layer1: false } }]));
    await recall(run, "looks", "dark");
    const again = await recall(run, "looks", "dark");
    expect(again.status).toBe("applied");
    expect(run.bypassed("l1")).toBe(true);
  });

  it("a layer that is gone is skipped by name, and the rest applies", async () => {
    const run = session(layered([{ name: "swap", values: {}, on: { layer1: false, layer9: true } }]));
    const result = await recall(run, "looks", "swap");
    expect(result.status).toBe("applied");
    expect(result.output.skipped).toEqual(["layer9.on"]);
    expect(warnings(result)).toEqual(["preset.on.missing"]);
    expect(result.diagnostics.map((each) => each.message).join("\n")).toContain('no node is named "layer9"');
    expect(run.bypassed("l1")).toBe(true);
  });

  it("a node that is not a Layer is switched too: off is its bypass, in the same patch (T1770b)", async () => {
    // The fence this replaced skipped `city` with `preset.on.notLayer`. On/off is one idea
    // with one flag (ruling 9), so a bank can switch a source or an effect as it does a Layer.
    const run = session(layered([{ name: "swap", values: {}, on: { city: false, layer1: false } }]));
    const revision = run.store.view.getRevision();
    const result = await recall(run, "looks", "swap");
    expect(result.status).toBe("applied");
    expect(result.output.skipped).toEqual([]);
    expect(warnings(result)).toEqual([]);
    expect(result.output.applied).toEqual(["city.on", "layer1.on"]);
    expect(run.store.view.getRevision()).toBe(revision + 1);
    expect(run.bypassed("city")).toBe(true);
    expect(run.bypassed("l1")).toBe(true);

    await run.bus.execute("graph.undo", {}, contextFor(alice));
    expect(run.bypassed("city")).toBe(false);
    expect(run.bypassed("l1")).toBe(false);
  });

  it("with only a missing layer to switch, the recall is refused", async () => {
    const run = session(layered([{ name: "swap", values: {}, on: { layer9: true } }]));
    const before = run.snapshot();
    const result = await recall(run, "looks", "swap");
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((each) => each.code)).toEqual(["preset.on.missing", "preset.recall.nothing"]);
    expect(run.snapshot()).toBe(before);
  });
});
