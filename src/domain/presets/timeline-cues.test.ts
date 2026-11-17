import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { flattenComponents } from "../../compiler/flatten.ts";
import { componentNodeType, createComponentSystem } from "../components/index.ts";
import { hasAnimatedParameters } from "../channels/graph-channels.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { MORPH_CURVES, type MorphSpec, type Preset } from "./bank.ts";
import { serializeCueList, type Cue } from "./cue-list.ts";
import { easeMorph } from "./morph.ts";
import { buildMorphIndex } from "./morph-index.ts";
import { presetBankNode, presetSession } from "./test-support.ts";
import {
  applyTimelineStructure,
  buildTimelineStructure,
  DOCUMENT_STRUCTURE,
  planTimelineCues,
  timelineCuePosition,
  timelineCueWarnings,
} from "./timeline-cues.ts";
import { testRead } from "../parameters/test-support.ts";

/**
 * T1508b — A CUE LIST THAT FOLLOWS THE TIMELINE, as the resolver reads it: values that are
 * a pure function of the playhead, applied as drivers, never written.
 *
 * Every value is what `resolveParameters` hands a consumer at a frame, through the ONE
 * index (`buildMorphIndex`) the compile, the flattening and the Dawn harness all build —
 * so a claim here is the claim the picture rests on. The expected numbers are the fold
 * written out (`mix` exactly as the resolver blends), never a tolerance band.
 *
 * THE SHOW most tests run, at 30 fps (the design doc §2.5): a Level stored at 0.2; cue A at
 * 1.0 s goes to 0.8 over 1 s, linear; cue B at 2.5 s cuts to 0.4.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 30;
const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };
const CUT: MorphSpec = { seconds: 0, curve: "linear" };

/** The resolver's blend, verbatim (`resolve.ts`), so an expected value is the same double. */
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;

const node = (id: NodeId, type: string, label: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphNode;

const doc = (nodes: readonly GraphNode[]): GraphDocument => ({
  revision: 1,
  nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
  edges: {},
  groups: {},
});

const LOOKS: readonly Preset[] = [
  { name: "bright", values: { level1: { brightness: 0.8 } } },
  { name: "mid", values: { level1: { brightness: 0.4 } } },
  { name: "low", values: { level1: { brightness: 0.1 } } },
];

const SHOW: readonly Cue[] = [
  { name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 },
  { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 2.5 },
];

const list = (id: NodeId, label: string, cues: readonly Cue[], follow: "live" | "timeline" = "timeline"): GraphNode =>
  node(id, "cueList", label, { follow, cues: serializeCueList({ version: 1, cues }) });

function show(options: { brightness?: number; cues?: readonly Cue[]; follow?: "live" | "timeline"; extra?: readonly GraphNode[] } = {}): GraphDocument {
  return doc([
    node("grade", "level", "level1", { brightness: options.brightness ?? 0.2, contrast: 1 }),
    presetBankNode("looks", "looks", "level1", LOOKS),
    list("show", "show", options.cues ?? SHOW, options.follow ?? "timeline"),
    ...(options.extra ?? []),
  ]);
}

/** Frame `n` of a transport at 30 fps: `timeSeconds` divided, never accumulated, as both transports do. */
const frame = (n: number, extra: Partial<FrameEvaluationInput> = {}): FrameEvaluationInput => ({
  timeSeconds: n / FPS,
  deltaSeconds: 1 / FPS,
  frameIndex: n,
  mode: "offline",
  randomSeed: 0,
  fps: FPS,
  subframes: 1,
  ...extra,
});

/** What a consumer reads for `key` of `nodeId` at frame `n`. */
function valueAt(graph: GraphDocument, nodeId: NodeId, key: string, n: number, extra: Partial<FrameEvaluationInput> = {}): unknown {
  const target = graph.nodes[nodeId] as GraphNode;
  const morphs = buildMorphIndex({ document: graph, registry });
  return resolveParameters(target, registry.get(target.type), testRead({ frame: frame(n, extra), morphs })).values[key];
}
const brightness = (graph: GraphDocument, n: number, extra: Partial<FrameEvaluationInput> = {}): unknown => valueAt(graph, "grade", "brightness", n, extra);

describe("T1508b — the value at the playhead", () => {
  it("the design's example: stored until cue A, A's fade analytically, B's cut — 0.2 / 0.5 / 0.8 / 0.4 at frames 30 / 45 / 60 / 75", () => {
    const graph = show();
    expect(brightness(graph, 0)).toBe(0.2);
    expect(brightness(graph, 29)).toBe(0.2);
    expect(brightness(graph, 30)).toBe(0.2);
    expect(brightness(graph, 45)).toBe(0.5);
    expect(brightness(graph, 50)).toBe(mix(0.2, 0.8, 50 / FPS - 1));
    expect(brightness(graph, 60)).toBe(0.8);
    expect(brightness(graph, 74)).toBe(0.8);
    expect(brightness(graph, 75)).toBe(0.4);
    expect(brightness(graph, 900)).toBe(0.4);
    // Nothing was written: the document still stores 0.2.
    expect(graph.nodes["grade"]?.parameters["brightness"]).toBe(0.2);
  });

  it("a fade's progress is the curve's, for every curve", () => {
    for (const curve of MORPH_CURVES) {
      const graph = show({ cues: [{ name: "A", bank: "looks", preset: "bright", morph: { seconds: 1, curve }, at: 1 }] });
      for (const n of [33, 40, 51, 57]) {
        expect(brightness(graph, n), `${curve} @ ${String(n)}`).toBe(mix(0.2, 0.8, easeMorph(curve, n / FPS - 1)));
      }
    }
  });

  it("a cue arriving mid-fade continues from what is on screen, and the older fade is dropped once finished", () => {
    const graph = show({
      cues: [
        { name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 },
        { name: "B", bank: "looks", preset: "mid", morph: LINEAR_1S, at: 1.5 },
      ],
    });
    // Frame 45: B arrives with A half done — B starts from 0.5, the value on screen.
    expect(brightness(graph, 45)).toBe(mix(mix(0.2, 0.8, 0.5), 0.4, 0));
    expect(brightness(graph, 45)).toBe(0.5);
    // Frame 54: both moving, B folded over A.
    expect(brightness(graph, 54)).toBe(mix(mix(0.2, 0.8, 54 / FPS - 1), 0.4, 54 / FPS - 1.5));
    // Frame 60: A has finished, so the fold starts from A's end.
    expect(brightness(graph, 60)).toBe(mix(0.8, 0.4, 0.5));
    expect(brightness(graph, 75)).toBe(0.4);
  });

  it("a cue is reached exactly on its frame, decided by frame index — at 0.1 s and 7/30 s at 30 fps, 0.28 s and 1.12 s at 25", () => {
    const graph = show({
      cues: [
        { name: "A", bank: "looks", preset: "bright", morph: CUT, at: 0.1 },
        { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 7 / 30 },
      ],
    });
    expect(brightness(graph, 2)).toBe(0.2);
    expect(brightness(graph, 3)).toBe(0.8);
    expect(brightness(graph, 6)).toBe(0.8);
    expect(brightness(graph, 7)).toBe(0.4);
    // 0.28 × 25 is 7.000000000000001 and 1.12 × 25 is 28.000000000000004: a bare ceil of
    // `at × rate` would put each cue one frame late.
    const at25 = show({
      cues: [
        { name: "A", bank: "looks", preset: "bright", morph: CUT, at: 0.28 },
        { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 1.12 },
      ],
    });
    const f25 = (n: number) => brightness(at25, n, { timeSeconds: n / 25, fps: 25 });
    expect([f25(6), f25(7), f25(27), f25(28)]).toEqual([0.2, 0.8, 0.8, 0.4]);
  });

  it("where the list is — current and next — is reached by the same frame rule", () => {
    const shown = { version: 1 as const, cues: SHOW };
    expect(timelineCuePosition(shown, 29 / FPS, FPS)).toEqual({ current: null, next: "A" });
    expect(timelineCuePosition(shown, 30 / FPS, FPS)).toEqual({ current: "A", next: "B" });
    expect(timelineCuePosition(shown, 74 / FPS, FPS)).toEqual({ current: "A", next: "B" });
    expect(timelineCuePosition(shown, 75 / FPS, FPS)).toEqual({ current: "B", next: null });
    // An untimed cue is not on the timeline at all.
    expect(timelineCuePosition({ version: 1, cues: [{ name: "x", bank: "looks", preset: "low" }, ...SHOW] }, 0, FPS)).toEqual({ current: null, next: "A" });
  });

  it("the playhead is read off timeSeconds at the timeline rate — sub-frames included — not off a rebased frameIndex", () => {
    const graph = show();
    // An offline take at 2 sub-frames steps at 60 per second; frame 90 of it is 1.5 s.
    expect(brightness(graph, 90, { timeSeconds: 90 / 60, frameIndex: 90, fps: 30, subframes: 2 })).toBe(0.5);
    // A live clock after a rate change: frameIndex no longer equals time × rate.
    expect(brightness(graph, 45, { frameIndex: 9_000 })).toBe(0.5);
  });

  it("a key with no in-between cuts at its cue, through the same driver (a Flip's boolean)", () => {
    const graph = doc([
      node("flip", "flip", "flip1", { flipx: false }),
      presetBankNode("fx", "fx", "flip1", [{ name: "flipped", values: { flip1: { flipx: true } } }]),
      list("show", "show", [{ name: "1", bank: "fx", preset: "flipped", morph: LINEAR_1S, at: 1 }]),
    ]);
    expect(valueAt(graph, "flip", "flipx", 29)).toBe(false);
    expect(valueAt(graph, "flip", "flipx", 30)).toBe(true);
    expect(valueAt(graph, "flip", "flipx", 45)).toBe(true);
  });
});

describe("T1508b — what covers a key, and what does not", () => {
  it("a list in live mode contributes nothing — the legitimate case the timeline must not swallow", () => {
    const graph = show({ follow: "live" });
    const morphs = buildMorphIndex({ document: graph, registry });
    expect(morphs.keysOf("grade")).toBeUndefined();
    expect(morphs.stepsAt("grade", "brightness", frame(45))).toBeUndefined();
    expect(morphs.activeAt(frame(45))).toBe(false);
    expect(hasAnimatedParameters(graph)).toBe(false);
    expect(brightness(graph, 75)).toBe(0.2);
  });

  it("a following list animates the document, and every frame is active — the cut at 2.5 s renders even when nothing else moves", () => {
    const graph = show();
    const morphs = buildMorphIndex({ document: graph, registry });
    expect(hasAnimatedParameters(graph)).toBe(true);
    expect(morphs.keysOf("grade")).toEqual(new Set(["brightness"]));
    // Between A's end and B, nothing is fading — and the next frame is B's cut.
    expect(morphs.activeAt(frame(70))).toBe(true);
    expect(morphs.activeAt(frame(0))).toBe(true);
  });

  it("two following lists on one key run as one chain in time order (ties: list name), and each says so", () => {
    const graph = doc([
      node("grade", "level", "level1", { brightness: 0.2 }),
      presetBankNode("looks", "looks", "level1", LOOKS),
      list("la", "a", [
        { name: "1", bank: "looks", preset: "bright", morph: CUT, at: 1 },
        { name: "3", bank: "looks", preset: "low", morph: CUT, at: 3 },
      ]),
      list("lb", "b", [
        { name: "2", bank: "looks", preset: "mid", morph: CUT, at: 2 },
        { name: "3", bank: "looks", preset: "bright", morph: CUT, at: 3 },
      ]),
    ]);
    expect(brightness(graph, 45)).toBe(0.8);
    expect(brightness(graph, 60)).toBe(0.4);
    // Both at 3 s: list "a" first, so "b"'s cue is the later one and holds.
    expect(brightness(graph, 90)).toBe(0.8);
    const overlaps = planTimelineCues(graph, registry).warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.overlap");
    expect(overlaps.map((warning) => warning.list).sort()).toEqual(["la", "lb"]);
    for (const warning of overlaps) {
      expect(warning.diagnostic.message).toContain('"a" and "b"');
      expect(warning.diagnostic.message).toContain('"level1.brightness"');
    }
  });

  it("§T1537b: structural settings in a timed cue are no longer skipped — layer on/off, a picture swap, a compile-time blend are filed as structure, and the values still drive", () => {
    const graph = doc([
      node("layer", "layer", "layer1", { opacity: 0, picture: "", blend: "over" }),
      presetBankNode("stage", "stage", "layer1", [
        { name: "in", values: { layer1: { opacity: 1, picture: "other", blend: "add" } }, on: { layer1: false } },
      ]),
      list("show", "show", [{ name: "drop", bank: "stage", preset: "in", morph: CUT, at: 1 }]),
    ]);
    const plan = planTimelineCues(graph, registry);
    expect(plan.warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.structural")).toEqual([]);
    expect([...(plan.structure.get("layer")?.keys() ?? [])].sort()).toEqual(["\u0000on", "blend", "picture"]);
    // Opacity is a value: it applies as a driver. The structural keys are NOT drivers — the
    // resolver (and so the inspector) still reads what is stored; the compile reads the structure.
    expect(valueAt(graph, "layer", "opacity", 30)).toBe(1);
    expect(valueAt(graph, "layer", "picture", 30)).toBe("");
    expect(valueAt(graph, "layer", "blend", 30)).toBe("over");
    expect(buildMorphIndex({ document: graph, registry }).keysOf("layer")).toEqual(new Set(["opacity"]));
  });

  it("§T1544b: a structural key on a component INSTANCE whose definition cannot be read is still skipped, by name — there is no fan-out to follow", () => {
    // A look instance whose published "mode" is compile-time (it is a Layer's blend within).
    // The component-AWARE registry answers for its type, as the app's does.
    const instanceType = componentNodeType("stack" as Parameters<typeof componentNodeType>[0], 1);
    const blend = {
      type: "enum",
      label: "Mode",
      default: "over",
      options: [
        { value: "over", label: "Over" },
        { value: "add", label: "Add" },
      ],
      compileTime: true,
    };
    const graph = doc([
      node("inst", instanceType, "stack1", { mode: "over" }),
      presetBankNode("stage", "stage", "stack1", [{ name: "add", values: { stack1: { mode: "add" } } }]),
      list("show", "show", [{ name: "swap", bank: "stage", preset: "add", morph: CUT, at: 1 }]),
    ]);
    const componentAware = {
      ...registry,
      has: (type: string) => registry.has(type) || type === instanceType,
      get: (type: string) => registry.get(type) ?? (type === instanceType ? ({ type, parameters: { mode: blend } } as never) : undefined),
    } as typeof registry;
    const plan = planTimelineCues(graph, componentAware);
    const said = plan.warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.structural");
    expect(said).toHaveLength(1);
    expect(said[0]?.cue).toBe("swap");
    expect(said[0]?.diagnostic.message).toContain('"stack1.mode"');
    expect(said[0]?.diagnostic.message).toContain("inside a component");
    expect(plan.structure.size).toBe(0);
  });

  describe("§T1544b: a structural key on an instance follows its published fan-out, by flattening's rule", () => {
    /** A Layer inside a component, its compile-time Blend published as `mode` — the page itself says nothing about structure. */
    const stack = {
      componentId: "stack",
      version: 1,
      name: "Stack",
      graph: doc([
        node("solid", "solid", "solid", { color: [1, 0, 0, 1] }),
        node("layer", "layer", "layer", { opacity: 0.5, blend: "over", picture: "solid" }),
      ]),
      inputs: [{ externalId: "below", label: "Below", nodeId: "layer", portId: "below" }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "layer", portId: "out" }],
      parameters: [
        {
          key: "mode",
          definition: { type: "enum", label: "Mode", default: "over", options: [{ value: "over", label: "Over" }, { value: "add", label: "Add" }] },
          targets: [{ nodeId: "layer", key: "blend" }],
        },
        {
          key: "mix",
          definition: { type: "number", label: "Mix", default: 0.5, min: 0, max: 1, range: "bounded" },
          targets: [{ nodeId: "layer", key: "opacity" }],
        },
      ],
    } as unknown as GraphComponentDefinition;
    const system = createComponentSystem(registry, [stack]);
    const catalogue = system.components.view();
    const graph = doc([
      node("inst", componentNodeType("stack", 1), "stack1", { mode: "over", mix: 0.5 }),
      presetBankNode("stage", "stage", "stack1", [{ name: "add", values: { stack1: { mode: "add", mix: 1 } } }]),
      list("show", "show", [{ name: "swap", bank: "stage", preset: "add", morph: CUT, at: 1 }]),
    ]);

    it("planned as structure with no warning; the inner Layer's Blend is overridden in the flat graph from the cue frame on, and only there", () => {
      const plan = planTimelineCues(graph, system.nodes, catalogue);
      expect(plan.warnings.map((warning) => warning.diagnostic.code)).toEqual([]);
      expect([...(plan.structure.get("inst")?.keys() ?? [])]).toEqual(["mode"]);

      const flattened = flattenComponents({ graph, registry, components: catalogue });
      const innerId = Object.keys(flattened.graph.nodes).find((id) => flattened.graph.nodes[id]?.type === "layer") as NodeId;
      const structure = buildTimelineStructure({ document: graph, registry, components: catalogue, flattened });
      if (structure === null) throw new Error("no structure");
      expect(structure.crossings(FPS)).toEqual([30]);
      expect(structure.atFrame(29, FPS)).toBe(DOCUMENT_STRUCTURE);
      const cut = structure.atFrame(30, FPS);
      expect(cut.parameters.get(innerId)).toEqual({ blend: "add" });
      expect([...cut.parameters.keys()]).toEqual([innerId]);
      const compiled = applyTimelineStructure(flattened.graph, cut);
      expect(compiled.nodes[innerId]?.parameters["blend"]).toBe("add");
      // The value half still drives the non-structural target: Mix reaches the opacity as a driver.
      expect(buildMorphIndex({ document: graph, registry, components: catalogue, flattened }).keysOf(innerId)).toEqual(new Set(["opacity"]));
    });

    it("a cue setting the value the instance already holds switches nothing", () => {
      const same = doc([
        node("inst", componentNodeType("stack", 1), "stack1", { mode: "add", mix: 0.5 }),
        presetBankNode("stage", "stage", "stack1", [{ name: "add", values: { stack1: { mode: "add" } } }]),
        list("show", "show", [{ name: "swap", bank: "stage", preset: "add", morph: CUT, at: 1 }]),
      ]);
      const flattened = flattenComponents({ graph: same, registry, components: catalogue });
      const structure = buildTimelineStructure({ document: same, registry, components: catalogue, flattened });
      expect(structure?.atFrame(30, FPS)).toBe(DOCUMENT_STRUCTURE);
    });
  });

  it("a cue with no At is skipped with a warning naming it; the timed ones still play", () => {
    const graph = show({ cues: [...SHOW, { name: "C", bank: "looks", preset: "low" }] });
    const untimed = planTimelineCues(graph, registry).warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.untimed");
    expect(untimed.map((warning) => warning.cue)).toEqual(["C"]);
    expect(untimed[0]?.diagnostic.message).toContain('Cue "C" (show)');
    expect(brightness(graph, 900)).toBe(0.4);
  });
});

/**
 * §T1559b (2) — a following list fires a bank whose Morph is DRIVEN. Its timed cues read the
 * Morph stored, GO reads it live; the plan says so. What the compile then puts in the
 * Problems list, and the fade's stored seconds in the uniform the GPU reads, are
 * `compiler/timeline-cue-problems.test.ts`. Held here: the warning as the list's OWN surfaces
 * read it (`timelineCueWarnings`: the inspector section and `cue.list`).
 */
describe("§T1559b (2) — a driven Morph on a bank a following list fires", () => {
  const drivenMorph = {
    mode: "expression",
    bindings: { static: { kind: "static", value: 2 }, expression: { kind: "expression", source: "op('k1').chan.value" } },
  } as const;
  const stage = (follow: "live" | "timeline"): GraphDocument =>
    doc([
      node("grade", "level", "level1", { brightness: 0.2 }),
      presetBankNode("looks", "looks", "level1", LOOKS, { morph: drivenMorph, curve: "linear" }),
      list(
        "show",
        "show",
        [
          { name: "A", bank: "looks", preset: "bright", at: 1 },
          { name: "B", bank: "looks", preset: "mid", at: 4 },
        ],
        follow,
      ),
    ]);

  it("is one warning about the list (no cue), filed on the bank, and the fade is the stored 2 s", () => {
    const graph = stage("timeline");
    const said = timelineCueWarnings(graph, registry, "show");
    expect(said.map((warning) => [warning.list, warning.cue, warning.diagnostic.code, warning.diagnostic.nodeId])).toEqual([
      ["show", null, "cue.timeline.drivenMorph", "looks"],
    ]);
    expect(said[0]?.diagnostic.message).toContain('Cue list "show" follows the timeline and fires bank "looks", whose Morph is driven (expression)');
    expect(said[0]?.diagnostic.message).toContain("the stored value, 2 s");
    expect(brightness(graph, 45)).toBe(mix(0.2, 0.8, 0.25));
  });

  it("the same list switched to live says nothing: GO reads the driver", () => {
    const graph = stage("live");
    expect(timelineCueWarnings(graph, registry, "show")).toEqual([]);
    expect(planTimelineCues(graph, registry).warnings).toEqual([]);
  });
});

describe("T1508b — precedence: the timeline wins on what it covers (owner ruling 1)", () => {
  it("a fader on a covered key shows before the first cue and NOT once the list has it — and it stays stored", () => {
    const moved = show({ brightness: 0.6 });
    // Before cue A the key is not the timeline's: the fader is on screen.
    expect(brightness(moved, 15)).toBe(0.6);
    // From cue A's end on, the timeline holds it: the same values the un-moved show has.
    for (const n of [60, 70, 75, 120]) expect(brightness(moved, n)).toBe(brightness(show(), n));
    expect(moved.nodes["grade"]?.parameters["brightness"]).toBe(0.6);
  });

  it("switching back to live hands the key to the document at once: its stored value, untouched", () => {
    const live = show({ brightness: 0.6, follow: "live" });
    for (const n of [45, 60, 75]) expect(brightness(live, n)).toBe(0.6);
  });

  it("a live recall's fade shows before the first cue and is outranked after it; on an uncovered key it fades as usual", async () => {
    const graph = show({
      extra: [presetBankNode("desk", "desk", "level1", [{ name: "punch", values: { level1: { brightness: 0.9, contrast: 3 } } }])],
    });
    const session = presetSession(graph, registry);
    // Recalled live at absolute second 0.3, with a 2 s linear fade.
    session.at({ epoch: "live", absTimeSeconds: 0.3 });
    await session.recall("desk", "punch", { seconds: 2, curve: "linear" });
    const recalled = session.graph();
    const live = (n: number) => ({ absEpoch: "live", absTimeSeconds: n / FPS });
    // Before cue A: the recall's fade, from 0.2 towards 0.9.
    expect(brightness(recalled, 15, live(15))).toBe(mix(0.2, 0.9, (15 / FPS - 0.3) / 2));
    // From cue A on: the timeline's fold, which starts from the STORED slot (now 0.9).
    expect(brightness(recalled, 45, live(45))).toBe(mix(0.9, 0.8, 0.5));
    expect(brightness(recalled, 75, live(75))).toBe(0.4);
    // Contrast is no cue's: the recall fades it on the absolute clock, untouched.
    expect(valueAt(recalled, "grade", "contrast", 45, live(45))).toBe(mix(1, 3, (45 / FPS - 0.3) / 2));
  });
});

describe("T1508b — inside a component: a timed cue on a look's published knob reaches the Level within", () => {
  const look = {
    componentId: "look",
    version: 1,
    name: "Look",
    graph: doc([node("src", "solid", "src", { color: [1, 1, 1, 1] }), node("grade", "level", "grade", { brightness: 1 })]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
    parameters: [
      {
        key: "gain",
        definition: { type: "number", label: "Gain", default: 1, min: 0, max: 8, range: "floor" },
        targets: [{ nodeId: "grade", key: "brightness" }],
      },
    ],
  } as unknown as GraphComponentDefinition;

  it("flattened with the PLAIN node registry (as the Dawn harness does), the internal brightness folds on the playhead", () => {
    const system = createComponentSystem(registry, [look]);
    const graph = doc([
      node("city", componentNodeType("look", 1), "city", { gain: 0.2 }),
      presetBankNode("looks", "looks", "city", [{ name: "bright", values: { city: { gain: 0.8 } } }]),
      list("show", "show", [{ name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 }]),
    ]);
    const flattened = flattenComponents({ graph, registry, components: system.components.view() });
    const inner = Object.values(flattened.graph.nodes).find((each) => each?.type === "level") as GraphNode;
    const at = (n: number): unknown =>
      resolveParameters(inner, registry.get("level"), testRead({ frame: frame(n), morphs: flattened.morphs })).values["brightness"];
    expect(at(15)).toBe(0.2);
    expect(at(45)).toBe(0.5);
    expect(at(60)).toBe(0.8);
  });
});

describe("§T1537b — the timeline's STRUCTURE: piecewise constant, a pure function of the playhead", () => {
  /** A Layer stored OFF, showing "a"; a timed list turns it on at 1.0 s and swaps its picture to "b" at 2.0 s. */
  const STAGE: readonly Preset[] = [
    { name: "on", values: {}, on: { layer1: true } },
    { name: "swap", values: { layer1: { picture: "b" } } },
    { name: "off", values: {}, on: { layer1: false } },
  ];
  const stage = (cues: readonly Cue[], follow: "live" | "timeline" = "timeline", bypassed = true): GraphDocument => {
    const layer = node("layer", "layer", "layer1", { picture: "a", opacity: 1 });
    return doc([
      { ...layer, ui: { bypassed } } as GraphNode,
      presetBankNode("stage", "stage", "layer1", STAGE),
      list("show", "show", cues, follow),
    ]);
  };
  const CUES: readonly Cue[] = [
    { name: "in", bank: "stage", preset: "on", morph: CUT, at: 1 },
    { name: "b", bank: "stage", preset: "swap", morph: CUT, at: 2 },
  ];

  it("crossings are the cue frames; the structure is the document's before the first and constant between", () => {
    const structure = buildTimelineStructure({ document: stage(CUES), registry });
    if (structure === null) throw new Error("expected a structure");
    expect(structure.crossings(FPS)).toEqual([30, 60]);
    const before = structure.at(frame(29));
    expect(before).toBe(DOCUMENT_STRUCTURE);
    const on = structure.at(frame(30));
    expect(on.bypassed).toEqual(new Map([["layer", false]]));
    expect(on.parameters.size).toBe(0);
    // Piecewise constant: every frame of the segment is the SAME object, so a caller keyed on it compiles once.
    for (const n of [31, 45, 59]) expect(structure.at(frame(n))).toBe(on);
    const swapped = structure.at(frame(60));
    expect(swapped.bypassed).toEqual(new Map([["layer", false]]));
    expect(swapped.parameters.get("layer")).toEqual({ picture: "b" });
    expect(structure.at(frame(900))).toBe(swapped);
    expect(new Set([before.key, on.key, swapped.key]).size).toBe(3);
    // What comes next, and from which frame — what the live loop compiles and warms ahead.
    expect(structure.nextAfter(0, FPS)).toEqual({ frameIndex: 30, state: on });
    expect(structure.nextAfter(30, FPS)).toEqual({ frameIndex: 60, state: swapped });
    expect(structure.nextAfter(60, FPS)).toBeNull();
  });

  it("applying a structure writes nothing: the document stays as stored, the copy carries the overrides", () => {
    const graph = stage(CUES);
    const before = JSON.stringify(graph);
    const structure = buildTimelineStructure({ document: graph, registry });
    const compiled = applyTimelineStructure(graph, structure?.at(frame(60)) ?? DOCUMENT_STRUCTURE);
    expect(compiled.nodes["layer"]?.ui?.bypassed).toBe(false);
    expect(compiled.nodes["layer"]?.parameters["picture"]).toBe("b");
    expect(JSON.stringify(graph)).toBe(before);
    expect(applyTimelineStructure(graph, DOCUMENT_STRUCTURE)).toBe(graph);
  });

  it("a timed cue that switches a node that is not a Layer is refused by name, and its Layer switch still lands (T1770b)", () => {
    // A preset switches any node, live. The timeline cannot yet: a segment's structure is
    // applied to the flat graph, where an instance that is off was never inlined. So the cue
    // says so, naming the node, rather than filing a switch that would change nothing.
    const graph = doc([
      { ...node("layer", "layer", "layer1", { picture: "a", opacity: 1 }), ui: { bypassed: true } } as GraphNode,
      node("grade", "level", "level1", { brightness: 0.2 }),
      presetBankNode("stage", "stage", "", [{ name: "go", values: {}, on: { layer1: true, level1: false } }]),
      list("show", "show", [{ name: "in", bank: "stage", preset: "go", morph: CUT, at: 1 }]),
    ]);
    const plan = planTimelineCues(graph, registry);
    expect(plan.warnings.map((each) => [each.cue, each.diagnostic.code])).toEqual([["in", "cue.timeline.switch"]]);
    expect(plan.warnings[0]?.diagnostic.message).toContain('switches "level1" off');
    expect([...plan.structure.keys()]).toEqual(["layer"]);
    const structure = buildTimelineStructure({ document: graph, registry });
    expect(structure?.at(frame(30)).bypassed).toEqual(new Map([["layer", false]]));
  });

  it("a cue that sets what is already stored changes no structure — no crossing worth a compile", () => {
    // Stored ON; the cue turns it on: the segment after 1.0 s IS the document's structure.
    const structure = buildTimelineStructure({ document: stage(CUES.slice(0, 1), "timeline", false), registry });
    expect(structure?.at(frame(45))).toBe(DOCUMENT_STRUCTURE);
    expect(structure?.nextAfter(0, FPS)).toBeNull();
  });

  it("on and back off returns to the document's own structure object (one plan for both)", () => {
    const structure = buildTimelineStructure({
      document: stage([CUES[0] as Cue, { name: "out", bank: "stage", preset: "off", morph: CUT, at: 3 }]),
      registry,
    });
    expect(structure?.at(frame(45)).key).not.toBe("");
    expect(structure?.at(frame(90))).toBe(DOCUMENT_STRUCTURE);
  });

  it("reached by the value fold's frame rule (0.1 s at 30 fps is frame 3, 7/30 s is frame 7), and per rate", () => {
    const structure = buildTimelineStructure({
      document: stage([
        { name: "in", bank: "stage", preset: "on", morph: CUT, at: 0.1 },
        { name: "b", bank: "stage", preset: "swap", morph: CUT, at: 7 / 30 },
      ]),
      registry,
    });
    expect(structure?.crossings(30)).toEqual([3, 7]);
    expect(structure?.at(frame(2)).key).toBe("");
    expect(structure?.at(frame(3)).key).not.toBe("");
    expect(structure?.crossings(25)).toEqual([3, 6]);
  });

  it("a list switched back to live has no structure — the document's structure, at once", () => {
    expect(buildTimelineStructure({ document: stage(CUES, "live"), registry })).toBeNull();
  });
});
