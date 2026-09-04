import { describe, expect, it } from "vitest";

import { flattenComponents } from "../compiler/flatten.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { listExamples, listStarterComponentFiles } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * ⚑ T1145 / §V903 / §T1139 — EVERY DRIVEN CHANNEL IN EVERY SHIPPED DOCUMENT MOVES.
 *
 * ## Why one derived gate rather than N fixes
 *
 * Three separate defects had shipped by §T1145, and every one of them ends at the same
 * observable — A PARAMETER WHOSE DRIVER NEVER CHANGES:
 *
 *   1. THE FROZEN CHANNEL (§T1139). `valueStep`'s index is `Math.floor(value / every)` and
 *      it maps over EVERY channel of the bag it is handed. Fed band energies, which live in
 *      [0, 1], against the usual `every: 4`, that is `floor(0.474 / 4) = 0` FOREVER — so
 *      `level`/`low`/`lowMid`/`highMid` are not constants somebody chose, they are
 *      STRUCTURALLY DEAD. The channel that works is `bar`, because it counts.
 *   2. CLAMP SATURATION (§V903). A draw range several clamp-widths wide makes the clamp the
 *      signal; E54 shipped `clag1:bar` at exactly 0.950000 for two thousand consecutive
 *      frames. `step-clamp-duty.test.ts` owns the DUTY CYCLE of that shape — a lane can be
 *      90 % pinned and still be the picture the author wanted (E45 cuts on purpose). What
 *      NOTHING owned until here is the terminal case: 100 % pinned, which is not a duty
 *      cycle at all but a constant.
 *   3. READOUT BLINDNESS (§T1144). The value panel shows four inert channels while the
 *      driven expression reads a fifth, which is HOW THE FIRST TWO SURVIVED NINE SESSIONS:
 *      the owner looked at a CORRECT lane, saw four flat numbers, and concluded something
 *      was wrong. It was — just not the thing the numbers were about.
 *
 * One assertion catches all three, and it is cheap: the value graph is scalars on the CPU
 * (§V183), so 2000 frames of every shipped document costs a couple of seconds and needs no
 * GPU at all. A NEW example cannot ship a dead lane past it.
 *
 * ## This is the THIRD question in `channel-integrity`'s family, and they are three
 *
 *   `reference-integrity`  — does `op('X')` name a node?          (§V890's first half)
 *   `channel-integrity`    — does X publish a channel K?          (§V890's second half)
 *   HERE                   — does K MOVE?
 *
 * §V890's shape exactly: "a reference has as many halves as it has DOTS, and a gate over
 * the first is silent about the rest". A driven parameter whose channel is a constant fails
 * the user in the same way one whose channel does not exist does — §V108 retains the static
 * and the document renders — so the third question needs asking out loud too.
 *
 * ## What is evaluated, and why it is the FLATTENED document
 *
 * The app runs the value graph on the flattened graph (`use-value-graph.ts`), and nothing
 * else is honest here. Component internals reference names that only exist once inlined —
 * the shipped `Kaleidoscope` component reads `driftx1` from its HOST's root graph, and
 * `AudioLevel`'s `probe` is fed across the component boundary — so a per-graph walk reports
 * both as unresolvable and MISSES the ten driven lanes inside `TimeGrid` entirely. Those
 * ten are not a hypothetical: they are the only place in the catalogue where a published
 * parameter (Churn) reaches its consumers through a channel, and E51 turns it up while the
 * component's own host demo leaves it at the default.
 *
 * ## The LIVE SEAMS are STIMULATED rather than exempted
 *
 * A pointer, a `personMask`'s coverage, an `analyze`'s reduction — none of them produce a
 * value in a headless walk, and a gate that skipped every lane fed by one would skip
 * exactly where §T1078 found three broken expressions in a week. So each is DRIVEN with a
 * varying stimulus instead, and the claim this file makes is the sharp one:
 *
 *   ⚑ GIVEN THAT ITS SOURCES MOVE, THE DRIVEN CHANNEL MOVES.
 *
 * which is precisely what "the lane is not structurally dead" means, and precisely what all
 * three defects above break. A lane that is nothing BUT a seam read (E52's `mask1:coverage`)
 * passes trivially and is meant to — its evidence is T1067's wiring, not this file.
 *
 * The stimulus can only answer for a node the registry says is NOT a value node, so it can
 * never shadow the value graph and manufacture motion for it. Names are unique per document
 * (§V129), so the partition is total.
 */

const HORIZON_FRAMES = 2000;

/**
 * A channel read written anywhere in a document's parameter slots, and WHERE it is read.
 * The regex is the same one `channel-integrity.test.ts` uses, so the two gates cannot
 * disagree about what counts as a reference.
 */
interface ChannelRead {
  readonly where: string;
  readonly name: string;
  readonly key: string;
}

function channelReads(graph: GraphDocument): ChannelRead[] {
  const found: ChannelRead[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    for (const [key, value] of Object.entries(node.parameters ?? {})) {
      const source = (value as { bindings?: { expression?: { source?: string } } })?.bindings?.expression
        ?.source;
      if (typeof source !== "string") continue;
      for (const match of source.matchAll(/op\(\s*'([^']+)'\s*\)\s*\.\s*chan\s*\.\s*([A-Za-z0-9_]+)/g)) {
        found.push({ where: `${nodeId}.${key}`, name: match[1] ?? "", key: match[2] ?? "" });
      }
    }
  }
  return found;
}

/**
 * The stimulus, and it is a FUNCTION OF THE FRAME so a lane that merely passes it through
 * cannot be told apart from one that does arithmetic on it — both move, which is all this
 * file claims. Bounded well inside [0, 1] because that is the range every seam in the
 * catalogue publishes (a coverage fraction, a luminance reduction), and an out-of-range
 * stimulus would make a legitimate clamp look like a defect.
 */
const stimulusAt = (frameIndex: number): number => 0.5 + 0.4 * Math.sin(frameIndex * 0.037);

interface Motion {
  /** Distinct values over the horizon. 1 is the failure: the channel is a constant. */
  readonly distinct: number;
  readonly minimum: number;
  readonly maximum: number;
  /** Frames on which the address resolved to nothing at all — the strongest deadness. */
  readonly unresolved: number;
}

/**
 * Run one flattened graph for the horizon and report how much each read channel moved.
 *
 * The session is held ACROSS frames deliberately: a Lag and a Step are stateful (§V181), so
 * a fresh session per frame would restart every trajectory and a lane that only moves
 * because it is smoothing would read as alive when it is not.
 */
function motionOf(
  graph: GraphDocument,
  registry: NodeRegistryView,
  randomSeed: number,
): Map<string, Motion> {
  const reads = channelReads(graph);
  const addresses = [...new Set(reads.map((read) => `${read.name}.${read.key}`))].map((key) => {
    const dot = key.lastIndexOf(".");
    return { key, name: key.slice(0, dot), channel: key.slice(dot + 1) };
  });

  /* The live seams: everything the registry does not call a value node. `channelIn` reads
     an analyze reduction by the analyzing node's own NAME, and the ladder resolves
     `mask1:coverage` by the publishing node's name too, so one partition answers both. */
  const seams = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    const definition = registry.get(node.type);
    const isValueNode = definition?.valueEvaluate !== undefined || definition?.valueChannel !== undefined;
    if (!isValueNode && node.label !== undefined) seams.add(node.label);
  }

  const session = createValueGraphSession(registry);
  const seen = new Map<string, Set<number>>();
  const unresolved = new Map<string, number>();
  for (const address of addresses) {
    seen.set(address.key, new Set());
    unresolved.set(address.key, 0);
  }

  for (let frameIndex = 0; frameIndex < HORIZON_FRAMES; frameIndex += 1) {
    const frame: FrameEvaluationInput = {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      /* §V45: an exact delta, so the sequence is a property of the document and not of how
         fast the machine ran it. The seed is the project's own, as `frameSequence` does. */
      mode: "offline",
      randomSeed,
    };
    const stimulus = (address: string): number | undefined => {
      const colon = address.indexOf(":");
      const name = colon < 0 ? address : address.slice(0, colon);
      return seams.has(name) ? stimulusAt(frameIndex) : undefined;
    };
    const evaluated = session.evaluate(graph, frame, {
      // §V182: the pointer the shaders read. Moving, for the same reason the seams move.
      pointer: {
        x: 0.5 + 0.3 * Math.sin(frameIndex * 0.021),
        y: 0.5 + 0.3 * Math.cos(frameIndex * 0.017),
        buttons: 0,
      },
      channels: stimulus,
    });
    /* The app's ladder, in the app's order (`app.tsx`: external channels, then the value
       graph). The order matters for nothing here — the two halves are disjoint by
       construction above — but stating it wrong would make this file a different program
       from the one it is testing. */
    const ladder = (address: string): ParameterValue | undefined =>
      stimulus(address) ?? evaluated.resolver(address, undefined as never);

    for (const address of addresses) {
      const direct = ladder(`${address.name}:${address.channel}`);
      // `.chan.value` also answers a node's single/bare channel — `node-references.ts`'s
      // fallback, and the shape `drivenSlot("name", …)` compiles to.
      const value = direct ?? (address.channel === "value" ? ladder(address.name) : undefined);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        unresolved.set(address.key, (unresolved.get(address.key) ?? 0) + 1);
        continue;
      }
      seen.get(address.key)?.add(value);
    }
  }

  const motion = new Map<string, Motion>();
  for (const address of addresses) {
    const values = [...(seen.get(address.key) ?? [])];
    motion.set(address.key, {
      distinct: values.length,
      minimum: values.length === 0 ? Number.NaN : Math.min(...values),
      maximum: values.length === 0 ? Number.NaN : Math.max(...values),
      unresolved: unresolved.get(address.key) ?? 0,
    });
  }
  return motion;
}

/**
 * ⚑ THE DECLARATION TABLE — every channel in the shipped set that a driven parameter reads
 * and that DOES NOT MOVE.
 *
 * A floor would be the wrong gate, exactly as it is in `step-clamp-duty.test.ts`: a feature
 * that ships OFF is a real thing to want, and §T809 made "optional" mean something by
 * proving the frame with the chain in it is the frame without it, byte for byte. What is
 * NOT allowed is nobody knowing which lanes those are — so the set is asserted WHOLE below.
 * A new pinned lane fails for being undeclared; a lane that comes alive fails for a stale
 * declaration (§V421); and either way somebody has to look.
 *
 * Every row here is a knob at its OFF position, and every one of them has a published
 * control or a documented reason that turns it on. There is no row for a lane that is dead
 * by accident, because the sweep that created this table found none.
 */
const DELIBERATELY_STILL: Record<string, string> = {
  /* §T809 — E27's optional audio, and "optional" is a GATE here rather than a promise:
     `kick1` is a multiply whose operand ships at 0, so the whole audioPattern → bias →
     envelope → gain chain reaches `lift1.value1` as EXACTLY 0. `relief-claims.gpu.test.ts`
     renders the file with the chain in the graph and compares BYTES against the pre-T809
     frames, and separately proves the drive is real above zero. Raise `kick1.operand`. */
  "E27-Relief.loom.json kick1.low": "T809: the optional audio ships at gain 0, byte-identity gated",
  /* §T809 again, the colour half: an `lfo` at `amplitude: 0` returns `offset + 0 * wave`,
     which is exactly its offset. Same identity claim, same test, same one number to turn. */
  "E27-Relief.loom.json cycle1.value": "T809: the optional colour rotation ships at amplitude 0",
  /* The TimeGrid starter component's own HOST DEMO, at the component's default `Churn: 0`.
     The two `lfo`s are not decoration — they are how the PUBLISHED `Columns`/`Rows` knobs
     reach their five consumers at all, since §T1017 means a published parameter cannot
     animate and a channel can. At Churn 0 they are constant by the knob's own description
     ("0 pins the wall at Columns x Rows"); E51 Chorus, the example that USES the component,
     turns it up and both channels move (measured: 3 and 2 distinct holds over 33 s, which
     is a 16 s and a 24 s sample-and-hold doing what they say).
     ⚠ These two rows are also §T1139's fourth instance: an `lfo` at amplitude 0 is a
     CONSTANT NODE spelled with the wrong operator, because there is no constant node. */
  "TimeGrid.loom.json churnx1.value": "TimeGrid ships Churn at its 0 default; E51 turns it up",
  "TimeGrid.loom.json churny1.value": "TimeGrid ships Churn at its 0 default; E51 turns it up",
};

interface Sweep {
  readonly fileName: string;
  readonly motion: Map<string, Motion>;
}

const SWEEP: Sweep[] = [...listExamples(), ...listStarterComponentFiles()].map((file) => {
  const { document, result } = requireExample(file);
  const registry = result.nodes;
  const components = result.components;
  if (registry === undefined || components === undefined) {
    throw new Error(`${file.fileName}: the runner returned no registry — nothing can be evaluated`);
  }
  const flattened = flattenComponents({ graph: document.graph, registry, components });
  return {
    fileName: file.fileName,
    motion: motionOf(flattened.graph, registry, document.settings.randomSeed),
  };
});

const stillIn = (sweep: Sweep): string[] =>
  [...sweep.motion]
    .filter(([, motion]) => motion.distinct <= 1)
    .map(([key]) => `${sweep.fileName} ${key}`);

describe("T1145 — every driven channel in every shipped document actually moves", () => {
  /**
   * The instrument reports "nothing found" for most of the catalogue, so it has to prove it
   * CAN find something (§V910's closing rule, and §T1068's own probes failed exactly this
   * way by walking 0 nodes). Two halves, and the second is the one that matters: a checker
   * that called everything frozen would pass the first.
   */
  it("can tell a frozen channel from a live one ON THE SAME NODE (§T1139's shape, built)", () => {
    const registry = requireExample(listExamples()[0] as never).result.nodes;
    if (registry === undefined) throw new Error("no registry");

    /* §T1139 exactly: a Step that counts BARS is handed a whole audio bag, so its index is
       `floor(low / 4) = 0` forever on the band energies and increments on `bar`. */
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        beat: {
          id: "beat" as never, type: "audioPattern", definitionVersion: 1,
          position: { x: 0, y: 0 }, parameters: { bpm: 112, amount: 1 }, label: "beat1",
        },
        step: {
          id: "step" as never, type: "valueStep", definitionVersion: 1,
          position: { x: 200, y: 0 }, parameters: { every: 4, minimum: 0, maximum: 1, seed: 5 },
          label: "step1",
        },
        sink: {
          id: "sink" as never, type: "level", definitionVersion: 1, position: { x: 400, y: 0 },
          parameters: {
            brightness: {
              mode: "expression",
              bindings: {
                static: { kind: "static", value: 1 },
                expression: { kind: "expression", source: "op('step1').chan.low" },
              },
            },
            contrast: {
              mode: "expression",
              bindings: {
                static: { kind: "static", value: 1 },
                expression: { kind: "expression", source: "op('step1').chan.bar" },
              },
            },
          },
          label: "sink1",
        },
      } as never,
      edges: {
        "v-beat-step": {
          id: "v-beat-step" as never,
          source: { nodeId: "beat" as never, portId: "out" as never },
          target: { nodeId: "step" as never, portId: "in" as never },
        },
      } as never,
      groups: {},
    };

    const motion = motionOf(graph, registry, 54);
    // The band energy never reaches `every`, so the step index is pinned — a CONSTANT.
    expect(motion.get("step1.low")?.distinct).toBe(1);
    // And the same node's `bar` counts, so the same step index genuinely increments. This
    // is the half that proves the checker discriminates rather than condemning everything.
    expect(motion.get("step1.bar")?.distinct).toBeGreaterThan(1);
  });

  /**
   * And the sweep has to have swept something. Both numbers are floors under what HEAD
   * measures (55 documents, 89 distinct driven channels), not equalities — this file is not
   * the place a new example gets registered.
   */
  it("sweeps a real inventory of documents and driven channels", () => {
    expect(SWEEP.length).toBeGreaterThan(40);
    const channels = SWEEP.reduce((count, sweep) => count + sweep.motion.size, 0);
    expect(channels).toBeGreaterThan(70);
  });

  /**
   * The declaration is exact in BOTH directions (§V421): an undeclared pinned lane is a
   * lane nobody measured, and a declared one that has come alive is a stale note that will
   * outlive whoever wrote it.
   */
  it("declares exactly the channels that hold still — no more, no fewer", () => {
    expect(SWEEP.flatMap(stillIn).sort()).toEqual(Object.keys(DELIBERATELY_STILL).sort());
  });

  /**
   * ⚑ THE LOAD-BEARING CLAIM, and it is LAST so nothing can return before it (§V910).
   *
   * Per example, because the failure is per example and a single flat list would name the
   * catalogue rather than the file somebody has to open.
   */
  it.each(SWEEP.map((sweep) => [sweep.fileName, sweep] as const))(
    "%s — every driven channel varies over the horizon",
    (fileName, sweep) => {
      const dead = [...sweep.motion]
        .filter(([key, motion]) => motion.distinct <= 1 && DELIBERATELY_STILL[`${fileName} ${key}`] === undefined)
        .map(([key, motion]) =>
          motion.unresolved === HORIZON_FRAMES
            ? `${key} never resolved to a number at all — the address is unreachable even with its seams driven`
            : `${key} held EXACTLY ${motion.minimum} for all ${HORIZON_FRAMES} frames`,
        );
      expect(
        dead,
        `${fileName}: a driven parameter is reading a channel that never changes, so the ` +
          `binding is decoration and §V108's retained static is the whole picture. The three ` +
          `ways this happens (§T1145): a valueStep whose input never reaches \`every\` is ` +
          `pinned at index 0 FOREVER (§T1139 — band energies are in [0,1] and \`every\` is ` +
          `usually 4, so only a COUNTING channel like \`bar\` can step); a clamp narrower ` +
          `than its draw range swallows the whole signal (§V903); or a gain, amplitude or ` +
          `published knob ships at zero. If the last one is deliberate, DECLARE it in ` +
          `DELIBERATELY_STILL above with the number that turns it on.`,
      ).toEqual([]);
    },
  );
});
