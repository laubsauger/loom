import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { EXAMPLES_DIR } from "./catalogue.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { CARD_FRAME, PROBE_RESOLUTION, exampleFileNameOf, measure } from "./look-instrument.ts";
import { starterComponentsView } from "./component-files.ts";
import LOOK_BASELINES from "./look-baselines.json" with { type: "json" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T521 — AN EXAMPLE MUST MOVE, AND YOU MUST BE ABLE TO SEE IT.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why this exists
 *
 * T402 already said every example animates, and `concepts/*.test.ts` says so per example in
 * the only way a structural test can: by naming a parameter. That is §V147 exactly — a test
 * passes on a picture that never moves, because the parameter is set and the picture is
 * still. Six shipped examples were completely static and every suite in the tree was green
 * about it; the owner found three of them by eye and was annoyed about all three, and the
 * other three came out of a sweep. Leaving example #7 to the same discovery path is the
 * thing this file is here to stop.
 *
 * The deadness turned out to be MECHANICALLY DETECTABLE, which is the whole reason a gate
 * is possible: rendered on Dawn through the T513 harness, all six measured a mean absolute
 * frame-to-frame luma difference of EXACTLY 0.00000 — not "small", zero — while every live
 * example measured at least three orders of magnitude above that.
 *
 * ## The three properties, and why they are three
 *
 *  1. LIVENESS. The picture differs between two well-separated LATE frames. Late, because a
 *     warm-up transient is not motion: E1's feedback trail filled in over the first ninety
 *     frames and then never changed again, and a 0-versus-60 comparison would have called
 *     that alive.
 *  2. CONTRAST. The picture spans enough range to READ. E5 shipped with every pixel between
 *     0.00 and 0.12 — a frame that is technically a picture and visually a dark rectangle.
 *  3. THE CARD. The frame an example is REPRESENTED by is not black. E8 shipped a
 *     completely black one because its history ring had nothing archived yet.
 *
 *     T794 MOVED WHICH FRAME THAT IS, from 0 to `CARD_FRAME` (60, one second in), and the
 *     reason is that "a gallery thumbnail is frame 0" was a POLICY THIS REPO SET, not a
 *     fact about anything. There is no card image in the codebase at all — the example
 *     browser is text rows — so the card is whichever frame the instrument names, and
 *     frame 0 is the single worst candidate: it is the one frame at which a simulation has
 *     not started and a cache has nothing behind it. Held at frame 0, the rule pushed three
 *     examples into seeding or declaring, and would have made E32 Pasture trade a
 *     load-bearing claim ("turn the herd off and the frame stays empty forever", testable
 *     at every frame) for a thumbnail. Sourced one second in, every shipped example passes
 *     on its own merits and no declaration is needed by anyone.
 *
 *     FRAME 0 IS STILL MEASURED, and it is now answering the question it is actually good
 *     for: WHAT A USER SEES ON OPEN. That is a milder thing than the card — a live document
 *     starts at frame 0 and reaches the card frame in one second — so it is kept as a
 *     §V643 baseline row (`f0max`), which reddens on any drift in either direction, rather
 *     than as a floor. Warm starts that improve it (E9, E37, E41) are still worth having
 *     and none of them was made pointless; they are just no longer COMPULSORY.
 *
 * They are separate assertions because they fail separately and for different reasons, and
 * an example can be honestly exempt from one and not the others (§V346).
 *
 * ## §V453's shape: a deliberate still is legitimate; an ACCIDENTAL one is not
 *
 * A still poster is a real thing to want, and a gate that forbids it gets switched off. So
 * an example may DECLARE itself exempt from a property, with a reason — and the gate then
 * fails THREE ways rather than one (§V464):
 *
 *   (a) an example fails a property and has not declared itself,
 *   (b) an example declares an exemption it no longer needs — a STALE declaration (§V421),
 *   (c) an example declares an exemption that its own `.md` does not tell the reader about.
 *
 * (c) is the one that keeps this honest. A declaration that lives only in a test file is a
 * private arrangement between an author and a gate; the person browsing the gallery has to
 * be able to read why the thing they are looking at is holding still.
 *
 * ## THE MEASUREMENT CANNOT BE RUN WRONG (§V461, one level up in the tooling)
 *
 * `renderHeadless` takes an `animate` flag, and with it off the value graph never runs:
 * every driven parameter sits at its retained value and an example whose motion comes from
 * an LFO reads as perfectly dead. A gate built on that flag can condemn the entire
 * catalogue while the catalogue is fine.
 *
 * Two things stop it. `measure()` below hard-codes `animate: true` and takes no option to
 * do otherwise, so there is no mode to get wrong. And the first test in this file is a
 * FIXTURE whose only motion is a value chain: if the value graph ever stops running, that
 * fixture goes to zero and the HARNESS reddens on its own probe, before it has judged a
 * single shipped file.
 */

/** Small enough to render two dozen examples, large enough that structure survives. */
/**
 * THE THRESHOLDS, and every one is read off a measurement rather than chosen.
 *
 * Measured over the whole shipped catalogue at this resolution (motion = mean |Δ| in linear
 * luma between frames 60 and 180; range = p999 − p001 of frame 180; f0max = the brightest
 * pixel of frame 0):
 *
 *   example                     motion    range    f0max
 *   E1  Feedback-Echo           0.02993   0.5600   0.5600
 *   E2  Reaction-Diffusion      0.14719   0.8100   0.9344
 *   E3  Animated-Noise-Field    0.15148   0.7021   0.8714
 *   E4  Bloom                   0.05747   1.0000   1.0000
 *   E5  Kaleidoscope            0.22467   0.4685   0.4708
 *   E6  Displacement-Stack      0.28296   0.7293   0.7341
 *   E7  LFO-Dissolve            0.49997   0.3376   0.8388
 *   E8  Slit-Scan               0.11306   0.6484   0.3609
 *   E9  Ember                   0.13639   1.0000   1.0000   <- T511, was Particle-Fountain
 *   E10 Instanced-Torus         0.01845   0.3710   0.3710
 *   E11 Gradient-Remap          0.11181   0.4466   0.4705
 *   E12 Fluid                   0.00000   0.0869   0.3868   <- declared, pointer-driven
 *   E13 Prism                   0.00142   1.0000   1.0000   <- T940d: drift slower than the probe window; declared
 *   E16 Murmuration             0.05786   0.8003   0.3596
 *   E20 Gooeyball               0.01405   0.5957   0.6980
 *   E24 Audio-RD                0.03971   0.5074   0.0000   <- declared, seeds from black
 *   E25 Stage                   0.02939   0.8310   0.3395
 *   E26 Interference            0.02178   0.4800   0.6303
 *   E27 Relief                  0.03656   0.6698   0.4531
 *   E28 Sundial                 0.01319   0.8370   0.7391
 *   E29 Descent                 0.22431   0.9900   0.6037
 *   E30 Nave                    0.00570   0.5625   0.8170
 *   E31 Corona                  0.06584   1.0000   0.9962
 *   E33 Obol                    0.01191   0.7419   0.7621
 *
 * And what the six T518 reworked ones measured BEFORE the rework: motion 0.00000 for E1,
 * E4, E5, E6 and E11; range 0.123 for E5 and 0.255 for E8; f0max 0.0000 for E8.
 *
 * TWO ROWS MOVED IN T511/T565, and only one of them because anything changed. E9's rework
 * from a ballistic spray to a fire front took it from 0.02347 to 0.13639 and opened both
 * its range and its first frame to 1.0. E13's 0.14107 was simply STALE — its row now reads
 * 0.19303, and that is what HEAD measured too, before T565 touched the file. A table of
 * measurements is documentation and rots like any other (§V421); this one was not
 * asserted against, so nothing was red while it drifted.
 *
 * T584/T690 CLOSED THAT: the asserted copy now lives in `look-baselines.json`, checked
 * per example inside this gate's own measurement. READ THE JSON AS EVIDENCE, not this
 * table — what remains here is the historical snapshot the FLOORS below were derived
 * from, kept because the thresholds' provenance matters and frozen because §V643 gave
 * the live numbers a home that can actually go red.
 *
 * T734 IS A CLEAN DEMONSTRATION OF WHAT THIS GATE CANNOT SEE (§V678). E2's reported fault
 * was that its composition died over the first ten seconds — measured, tile CV fell 0.695
 * at frame 60 to 0.137 at frame 600 and stayed there for the next fifty. Rebuilding it
 * around an advection took frame-pair motion at frame 1800 from 0.018 to 0.19, a factor of
 * ten in the picture a viewer actually watches. This gate's motion row moved 0.12634 to
 * 0.13300 — five percent — because it measures frames 60 to 180, which is BEFORE the
 * collapse it was blind to. The baseline was never wrong; it was answering a different
 * question. The claim that sees this lives in `examples.gpu.test.ts`, at frame 900,
 * against a control with the mechanism removed.
 *
 * LIVENESS_FLOOR is 0.002. The gap it lives in is enormous and asymmetric: a genuinely
 * static plan reads EXACTLY zero (asserted below, so this is measured and not assumed),
 * and the slowest live example in the catalogue reads 0.00570 — nearly three times the
 * floor. §V461's question is whether a still picture could clear it, and the answer is
 * structural rather than statistical: two renders of a plan that reads no clock and holds
 * no state are the same bytes, so the difference is not "small", it is nothing.
 *
 * CONTRAST_FLOOR is 0.30, which fails both historical cases — E5's 0.123 and E8's 0.255 —
 * and clears every live example, the nearest being E7 at 0.3376. Percentiles rather than
 * min and max, because one stray bright texel is not contrast.
 *
 * CARD_FLOOR is 0.02: "something is visible", not "the frame is bright".
 *
 * T795 — AND THE SENTENCE THAT USED TO SIT HERE WAS FALSE, which is why it is being
 * replaced rather than edited. It read: *every example that renders anything at all on
 * frame 0 measures at least 0.34*. That was true when the floor was set, and the floor was
 * sized for the enormous empty gap it described — 0.02 against a population starting at
 * 0.34, seventeen times clear. Three examples then FILLED THAT GAP without anything going
 * red, because a floor cannot see a value that clears it: E24 Audio-RD 0.0000 (declared),
 * E32 Pasture 0.0344 (1.7× the floor) and E41 Cinder 0.0687 (3.4×). §V768 is exactly this
 * — a value sitting within a small multiple of a floor is a SUSPECT, not a pass — and
 * §V766 is the other half: the drift happened in PROSE NOBODY EDITED, so nothing could
 * have caught it. §T785 found all three by looking at frames.
 *
 * RE-DERIVED FROM THE CURRENT POPULATION, at the frame the floor now reads (§T794 moved it
 * to `CARD_FRAME`). Measured over all 37 shipped examples on Dawn at this resolution:
 *
 *   the quietest card is E43 Splice at 0.1651, then E12 Fluid 0.3103, E10 Instanced
 *   Torus 0.3710, and everything else above that, up to 1.0000 for eleven of them.
 *   Nothing is black. E24 — the only example ever declared out of this property — reads
 *   0.9048, and E32 Pasture, the survivor of the frame-0 cluster, reads 0.6838.
 *
 * So 0.02 is kept, and it is kept for the reason the original sentence gave rather than by
 * inheritance: the gap is real again. Eight times below the quietest shipped card is a
 * floor that detects a card which is BLACK, and it is honest to say that is all it detects
 * — a merely dim card would have to be under a fiftieth of the catalogue's brightest to
 * trip it, and §V768 says the way to catch THAT is to read a value against the population
 * and treat a small multiple as a suspect, which is what the table above is for.
 */
const LIVENESS_FLOOR = 0.002;
const CONTRAST_FLOOR = 0.3;
const CARD_FLOOR = 0.02;

interface Exemption {
  /** Which properties this example is excused from, each with its own reason. */
  readonly liveness?: string;
  readonly contrast?: string;
  readonly card?: string;
  /**
   * A phrase that must appear in the example's own `.md`. This is (c): the reader of the
   * gallery gets told, in prose, why the thing they are looking at behaves this way.
   */
  readonly evidence: string;
}

/**
 * §V453 for examples. Every entry is a DECISION, and the gate refuses both a missing one
 * and a stale one.
 */
const DECLARED: Readonly<Record<string, Exemption>> = {
  "E13-Prism.loom.json": {
    liveness:
      "T940d: the owner asked for BARELY-perceptible motion — body-drift LFOs at 0.013 " +
      "and 0.021 Hz (50-77s periods) and dust that crosses the frame in ~20 minutes. " +
      "The liveness probe compares frames 60 and 180, a 2-second window that " +
      "undersamples those periods by design of the LOOK, not absence of motion: the " +
      "same instrument measured 0.00142 here against 0.00639 at the pre-T940d 3x " +
      "faster drift — the motion is real and continuous, merely slower than the window.",
    evidence: "Watch 30 seconds: the body swivels, the lit dust churns, nothing is a still",
  },
  "E12-Fluid.loom.json": {
    liveness:
      "A fluid at rest IS at rest. Every force in this file comes from the pointer — the " +
      "stirring vortex reads `frameU.pointer` and the ink blob's centre is driven by the " +
      "Mouse node — so with no pointer there is nothing to advect and the solver correctly " +
      "converges to a still field. That is the example working, not failing; the motion is " +
      "the user's. §V363 is satisfied by the file being immediately PLAYABLE rather than by " +
      "it playing itself.",
    contrast:
      "Same cause. With no pointer the dye is never injected, so the frame holds the " +
      "initial field and nothing else. One touch and the range opens.",
    evidence: "Point at it and it stirs",
  },
  /*
   * T794 — E24's DECLARATION IS GONE, and deleting it is the point rather than a tidy-up.
   *
   * It read: "a Gray-Scott simulation starts from a CLEARED state ... worth knowing rather
   * than worth hiding, because a gallery thumbnail is frame 0". Every word of the physics
   * is still true and still written down in the example's own `.md`. What was NOT a
   * property of the example is the last clause: the card policy. E24 was never exempt from
   * "show your subject" — it was exempt from being judged at the one frame at which it
   * cannot have one, and the two look identical from inside a declaration.
   *
   * §V769 warned about exactly this shape — "a declaration is for a DELIBERATE choice, not
   * a way to retire a recurring defect" — and the recurrence proved the diagnosis: the same
   * reasoning was re-derived independently by E32 and E41, neither of which declared, and
   * both shipped the defect instead. At `CARD_FRAME` E24 measures 0.9048, which is a
   * colony on a plate: it passes on its own merits with nothing excused.
   */
};

const settingsFor = (width: number, height: number): ProjectSettings => ({
  outputResolution: { width, height },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 30,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
});

const nodeOf = (id: string, type: string, parameters: Record<string, unknown>, extra = {}) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...extra,
});

/**
 * checker → level → output. Reads no clock, holds no state: provably the same every frame.
 *
 * The checker's colours are MID-GREY, not the default black and white, and that is §V461
 * about this very file. The value-driven twin below scales `brightness`, and pure black
 * stays black under any scale while pure white clips at the display transform — so on the
 * default colours the canary measured EXACTLY ZERO with the value graph running perfectly.
 * A fixture that cannot show what it is asserting is a green test that checks nothing, and
 * this one nearly shipped as one.
 */
function stillFixture(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      c: nodeOf("c", "checker", {
        size: [8, 5],
        color1: [0.1, 0.1, 0.1, 1],
        color2: [0.5, 0.5, 0.5, 1],
      }),
      l: nodeOf("l", "level", { brightness: 1 }),
      o: nodeOf("o", "output", {}),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "c", portId: "out" }, target: { nodeId: "l", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "l", portId: "out" }, target: { nodeId: "o", portId: "input" } },
    },
  } as unknown as GraphDocument;
}

/**
 * T794/§V461 — A CARD THAT IS BLACK AT THE CARD FRAME, so the card floor is provably
 * capable of failing.
 *
 * This mattered more once the floor moved off frame 0. The historical E8 fixture asserted
 * against `CARD_FLOOR` above is black at frame ZERO — it is the record of what E8 shipped —
 * and a slit-scan fills in, so it would sail past a floor read a second later. A gate whose
 * only red-verify is at a frame it no longer reads is a gate nobody has checked.
 *
 * The same still fixture with the Level's brightness at 0: black at frame 0, black at
 * frame 60, black for ever, and no clock anywhere in it.
 */
function blackFixture(): GraphDocument {
  const still = stillFixture();
  return {
    ...still,
    nodes: { ...still.nodes, l: nodeOf("l", "level", { brightness: 0 }) },
  } as unknown as GraphDocument;
}

/**
 * The same graph, with an LFO on the Level's brightness — so the ONLY thing that moves is
 * the value graph. This is the `animate: true` canary.
 */
function valueDrivenFixture(): GraphDocument {
  const still = stillFixture();
  return {
    ...still,
    nodes: {
      ...still.nodes,
      lfo: nodeOf(
        "lfo",
        "lfo",
        { shape: "sine", frequency: 0.4, amplitude: 0.9, offset: 1, phase: 0 },
        { label: "lfo1" },
      ),
      l: nodeOf(
        "l",
        "level",
        { brightness: 1 },
        {
          parameters: {
            brightness: {
              mode: "driven",
              bindings: {
                static: { kind: "static", value: 1 },
                driven: { kind: "driven", channel: "lfo1" },
              },
            },
          },
        },
      ),
    },
  } as unknown as GraphDocument;
}

/** E5 as it shipped before T518: a `distance`-mode circle, which is red-only and dim. */
function historicalKaleidoscope(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      source: nodeOf("source", "circle", {
        mode: "distance",
        center: [0.32, 0.42],
        radius: [0.18, 0.11],
        softness: 0.05,
        fillcolor: [0.95, 0.4, 0.15, 1],
        bgcolor: [0.03, 0.05, 0.12, 1],
        aspectcorrect: true,
      }),
      fold: nodeOf("fold", "transform", {
        t: [0.12, 0],
        r: 30,
        s: [0.5, 0.5],
        p: [0, 0],
        xord: "srt",
        extend: "mirror",
        aspectcorrect: true,
      }),
      facets: nodeOf("facets", "tile", {
        repeat: [3, 3],
        offset: [0.15, 0.05],
        mirrorx: true,
        mirrory: true,
      }),
      out: nodeOf("out", "output", {}),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "source", portId: "out" }, target: { nodeId: "fold", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fold", portId: "out" }, target: { nodeId: "facets", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "facets", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as unknown as GraphDocument;
}

/** E8 as it shipped before T518: a noise field through the slit, which smears to a wash. */
function historicalSlitScan(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: {
      field: nodeOf("field", "noise", {
        type: "perlin4d",
        period: 0.5,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: false,
        aspectcorrect: true,
        seed: 9,
        s4d: 1,
        t4d: 0,
        speed: 0.8,
      }),
      gradient: nodeOf("gradient", "ramp", { type: "vertical" }, { definitionVersion: 2 }),
      scan: nodeOf("scan", "slitScan", { frames: 48, depth: 1 }),
      out: nodeOf("out", "output", {}),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "field", portId: "out" }, target: { nodeId: "scan", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "gradient", portId: "out" }, target: { nodeId: "scan", portId: "map" } },
      e3: { id: "e3", source: { nodeId: "scan", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as unknown as GraphDocument;
}

const fixtureSettings = settingsFor(PROBE_RESOLUTION.width, PROBE_RESOLUTION.height);

describe("T521 — the measurement can tell moving from still, before it judges anything", () => {
  it("reads EXACTLY zero on a plan that reads no clock and holds no state", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const reading = await measure(stillFixture(), fixtureSettings, "o");
    // Not "below the floor" — ZERO. Two encodes of the same pure function are the same
    // bytes, and saying so here is what makes LIVENESS_FLOOR a decision rather than a
    // guess about how much noise a static render produces.
    expect(reading.motion).toBe(0);
  }, 120_000);

  /**
   * THE `animate: true` CANARY, and the reason it comes before the catalogue.
   *
   * `renderHeadless` runs the value graph only when asked. With it off, every driven
   * parameter sits at its retained value and every LFO-driven example in the tree reads as
   * dead — a harness that would condemn the whole catalogue while the catalogue is fine.
   * This fixture's ONLY moving part is a value chain, so if that ever stops running the
   * failure lands HERE, on the probe, and names itself.
   */
  it("sees motion that exists only in the VALUE GRAPH", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const reading = await measure(valueDrivenFixture(), fixtureSettings, "o");
    expect(reading.motion).toBeGreaterThan(LIVENESS_FLOOR);
  }, 120_000);

  /**
   * §V461 — the fixture must be CAPABLE of failing, proven against the two pictures that
   * actually shipped. These are not invented near-misses; they are the graphs the owner
   * looked at and rejected, and the thresholds are set so that both of them redden.
   */
  it("fails the CONTRAST floor on E5 and E8 exactly as they shipped before T518", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const kaleidoscope = await measure(historicalKaleidoscope(), fixtureSettings, "out");
    expect(kaleidoscope.range).toBeLessThan(CONTRAST_FLOOR);

    const slitScan = await measure(historicalSlitScan(), fixtureSettings, "out");
    expect(slitScan.range).toBeLessThan(CONTRAST_FLOOR);
    // B160 retired the OTHER half of this control. E8's first frame USED to be black —
    // the ring held nothing on frame 0, so the slit read a never-written layer — and
    // this line asserted that blackness. B160 made an empty cache/slit read its own
    // write target instead (§V229's "never black" made true on frame 0), so the slit's
    // frame 0 is now its noise input, well above CARD_FLOOR. The blackness this asserted
    // no longer exists to assert; the CONTRAST floor above is the live half of E8's §V461
    // proof, and the black fixture below proves the card floor itself can still redden.
  }, 180_000);

  /**
   * §V461 for the property T794 moved: the CARD floor, read at `CARD_FRAME`, must be able
   * to redden. A frame-0-black example no longer trips it (that is the whole point), so the
   * proof has to be a picture that is black a second in as well.
   */
  it("fails the CARD floor on a graph that is black at the card frame", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const black = await measure(blackFixture(), fixtureSettings, "o");
    expect(black.cardMax).toBeLessThan(CARD_FLOOR);
    // ...and the LIVE catalogue's quietest card clears it by a wide margin, which is the
    // other half of §V461: a floor that everything fails is not a floor either.
    const quietest = await measure(stillFixture(), fixtureSettings, "o");
    expect(quietest.cardMax).toBeGreaterThan(CARD_FLOOR);
  }, 180_000);
});

describe("T521 — every shipped example moves, and you can see it", () => {
  const shipped = EXAMPLE_DOCUMENTS.map((document) => {
    const outputNodeId = Object.values(document.graph.nodes).find(
      (node) => node.type === "output",
    )?.id;
    return { document, outputNodeId, fileName: `${document.name.split(" ")[0] ?? ""}` };
  });

  /**
   * The declaration table is checked against the CATALOGUE, not trusted. A rename or a
   * retirement leaves an entry pointing at nothing, and an exemption for a file that no
   * longer exists is an exemption nobody will ever notice is wrong (§V421).
   */
  /**
   * T786 — NO SHIPPED EXAMPLE OPENS ON THE 4D LATTICE PLANE, which is §T535 closed as a
   * CLASS rather than as a list of instances (§B146's lesson, applied to a PARAMETER).
   *
   * `perlin4d` at `t4d: 0` sits on a lattice plane where the noise's amplitude collapses,
   * so frame 0 is systematically flatter than every frame after it — and frame 0 is the
   * gallery card. §T535 found that, measured it, and swept the catalogue. It swept the
   * INSTANCES. The understudy bed that E40 Wake introduced afterwards carried `t4d: 0`,
   * and it was copy-pasted forward into E41, E42, E43 and E44 — five examples, all of
   * them landing AFTER the sweep that was supposed to have ended this.
   *
   * Measured on E41's bed, which is the one where the bed IS the opening frame: amplitude
   * (sd of linear luma) at frame 0 was 0.04868 and climbed to 0.05878 by frame 60 — the
   * card was 21% flatter than the picture. Off the plane it opens at 0.05962 and HOLDS.
   *
   * A sweep is not a fix when the thing swept is a value someone will copy. This is
   * structural and costs no render, so the sixth copy cannot land.
   */
  it("puts no animated 4D noise on the lattice plane where its amplitude collapses", () => {
    const offenders: string[] = [];
    for (const document of EXAMPLE_DOCUMENTS) {
      for (const node of Object.values(document.graph.nodes)) {
        if (node.type !== "noise") continue;
        const parameters = node.parameters as Record<string, unknown>;
        const kind = parameters["type"];
        // Only 4D noise HAS a fourth axis, so only 4D noise can sit on its lattice plane.
        if (typeof kind !== "string" || !kind.endsWith("4d")) continue;
        // A still noise never leaves frame 0, so being on the plane costs it nothing:
        // what this catches is the frame that is unrepresentative of the ones AFTER it.
        // T794 moved the CARD off frame 0; this gate stays, because frame 0 is still the
        // frame a user opens on and a flat one is still a worse first second.
        if (parameters["speed"] === 0) continue;
        if (parameters["t4d"] !== 0) continue;
        offenders.push(`${document.name} / ${node.label ?? node.id}`);
      }
    }
    expect(
      offenders,
      `${offenders.length} animated 4D noise node(s) sit at t4d: 0, where amplitude ` +
        `collapses — frame 0 is what a user OPENS on and would be flatter than every ` +
        `frame after it (T535/T786). Use an off-lattice value such as 0.37.`,
    ).toEqual([]);
  });

  it("declares exemptions only for examples that exist", () => {
    const files = new Set(
      EXAMPLE_DOCUMENTS.map((document) => `${exampleFileNameOf(document.name)}`),
    );
    for (const fileName of Object.keys(DECLARED)) {
      expect(files.has(fileName), `${fileName} is declared but is not a shipped example`).toBe(
        true,
      );
    }
  });

  /**
   * (c) — THE DECLARATION LIVES IN THE TEXT THE READER SEES. A still that is only explained
   * to a test file is not explained. §V464's third failure mode, in the form this gate can
   * have one.
   */
  it("says in each declared example's own .md why it behaves that way", () => {
    for (const [fileName, exemption] of Object.entries(DECLARED)) {
      const prose = readFileSync(
        join(EXAMPLES_DIR, fileName.replace(/\.loom\.json$/, ".md")),
        "utf8",
      );
      expect(prose, `${fileName}.md does not tell the reader about its exemption`).toContain(
        exemption.evidence,
      );
    }
  });

  for (const entry of shipped) {
    const fileName = exampleFileNameOf(entry.document.name);
    it(
      `${entry.document.name} moves, reads, and has a card`,
      async () => {
        const probe = await probeDawn();
        if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
        if (entry.outputNodeId === undefined) throw new Error("no output node");

        const reading = await measure(
          entry.document.graph,
          entry.document.settings,
          entry.outputNodeId,
          await starterComponentsView(), // T956: E47 instances DepthPoints
        );
        const declared = DECLARED[fileName];

        // (a) undeclared and failing, and (b) declared and no longer failing — one pair of
        // assertions per property, so a stale declaration is as loud as a missing one.
        assertProperty(
          "liveness",
          reading.motion,
          LIVENESS_FLOOR,
          declared?.liveness,
          `${entry.document.name} rendered the same picture at frame 60 and frame 180 ` +
            `(mean |Δ| ${reading.motion.toFixed(5)}). Give it something that moves, or ` +
            `declare it a still in DECLARED with the reason.`,
        );
        assertProperty(
          "contrast",
          reading.range,
          CONTRAST_FLOOR,
          declared?.contrast,
          `${entry.document.name} spans only ${reading.range.toFixed(4)} of luma between ` +
            `its 0.1st and 99.9th percentiles — too little to read as a picture.`,
        );
        assertProperty(
          "card",
          reading.cardMax,
          CARD_FLOOR,
          declared?.card,
          `${entry.document.name}'s card frame is black (brightest pixel ` +
            `${reading.cardMax.toFixed(4)} at frame ${CARD_FRAME}). The card is sourced a ` +
            `second in, so this is not a warm-up: the example has no picture to show.`,
        );

        /**
         * §V643 (T690) — THE BASELINE, asserted. The md tables were documentation and a
         * catalogue-wide look drift was invisible by construction: E33 went stale NINE
         * HOURS after authoring while every gate stayed green (T689), because T632/T636
         * swapped its hand gain for physical terms and the round trip was approximately
         * true, not measured-true (§V642). This block is the reader that can see.
         *
         * The band is read off measurements, not chosen: benign cross-commit drift
         * measured ≤0.1% relative (E24 across a morning of engine work), the real event
         * measured ≥22% (E33 under T632+T636). Ten percent sits an order of magnitude
         * from both. The absolute floor covers near-zero baselines (E12's declared-still
         * 0.00000 motion, E24's declared-black 0.0000 f0max), where a relative band is
         * meaningless.
         *
         * A red here is a DECISION POINT, not a chore: if you changed how an example
         * looks on purpose, re-run measure-look-baselines.ts IN THE SAME COMMIT and
         * state the delta (§V642); if you did not, you just caught an accidental
         * catalogue-wide look change — do not update the file to make it quiet.
         */
        const baseline = (LOOK_BASELINES as Record<string, { motion: number; range: number; f0max: number }>)[fileName];
        expect(baseline, `${fileName} has no look baseline — run measure-look-baselines.ts and commit the entry`).toBeDefined();
        const drifted: string[] = [];
        const check = (metric: string, measured: number, recorded: number) => {
          const band = Math.max(0.1 * Math.abs(recorded), 0.003);
          if (Math.abs(measured - recorded) > band) {
            const pct = recorded === 0 ? "∞" : `${((measured / recorded - 1) * 100).toFixed(1)}%`;
            drifted.push(`${metric}: baseline ${recorded}, measured ${measured.toFixed(5)} (${pct})`);
          }
        };
        if (baseline !== undefined) {
          check("motion", reading.motion, baseline.motion);
          check("range", reading.range, baseline.range);
          check("f0max", reading.firstFrameMax, baseline.f0max);
        }
        expect(
          drifted,
          `${entry.document.name} no longer looks like its baseline — ${drifted.join("; ")}. ` +
            `Deliberate? Re-run measure-look-baselines.ts in this commit and state the delta ` +
            `(§V642/§V643). Not deliberate? You caught a look regression — do not update the file.`,
        ).toEqual([]);
      },
      240_000,
    );
  }
});

/**
 * One property, both directions. `reason` present means the example claims it cannot meet
 * the floor; if it now DOES meet it, the claim has rotted and the entry has to go.
 */
function assertProperty(
  property: string,
  measured: number,
  floor: number,
  reason: string | undefined,
  failure: string,
): void {
  if (reason === undefined) {
    expect(measured, failure).toBeGreaterThan(floor);
    return;
  }
  expect(
    measured,
    `${property} is declared exempt ("${reason.slice(0, 60)}...") but measures ` +
      `${measured.toFixed(5)}, which CLEARS the floor of ${String(floor)}. The declaration ` +
      `is stale — delete it (§V421).`,
  ).toBeLessThanOrEqual(floor);
}
