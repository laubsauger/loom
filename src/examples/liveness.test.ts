import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { EXAMPLES_DIR } from "./catalogue.ts";
import { EXAMPLE_DOCUMENTS } from "./documents.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T521 — AN EXAMPLE MUST MOVE, AND YOU MUST BE ABLE TO SEE IT.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why this exists
 *
 * T402 already said every example animates, and `concepts.test.ts` says so per example in
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
 *  3. FIRST FRAME. Frame 0 is not black. A gallery thumbnail is frame 0, and E8 shipped a
 *     completely black one because its history ring had nothing archived yet.
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
const PROBE_RESOLUTION = { width: 192, height: 108 } as const;

/**
 * Frames 60 and 180 — one second in, three seconds in. Both LATE (past any warm-up) and two
 * seconds apart, which is long enough that even the slowest shipped drift registers.
 */
const CAPTURE = [0, 60, 180] as const;
const LAST_CAPTURE = 180;

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
 *   E13 Prism                   0.19303   1.0000   1.0000   <- re-measured, see below
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
 *
 * And what the six T518 reworked ones measured BEFORE the rework: motion 0.00000 for E1,
 * E4, E5, E6 and E11; range 0.123 for E5 and 0.255 for E8; f0max 0.0000 for E8.
 *
 * TWO ROWS MOVED IN T511/T565, and only one of them because anything changed. E9's rework
 * from a ballistic spray to a fire front took it from 0.02347 to 0.13639 and opened both
 * its range and its first frame to 1.0. E13's 0.14107 was simply STALE — its row now reads
 * 0.19303, and that is what HEAD measured too, before T565 touched the file. A table of
 * measurements is documentation and rots like any other (§V421); this one is not asserted
 * against, so nothing was red while it drifted. Worth knowing when reading a row as
 * evidence.
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
 * FIRST_FRAME_FLOOR is 0.02: "something is visible", not "the frame is bright". Every
 * example that renders anything at all on frame 0 measures at least 0.34.
 */
const LIVENESS_FLOOR = 0.002;
const CONTRAST_FLOOR = 0.3;
const FIRST_FRAME_FLOOR = 0.02;

interface Exemption {
  /** Which properties this example is excused from, each with its own reason. */
  readonly liveness?: string;
  readonly contrast?: string;
  readonly firstFrame?: string;
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
  "E24-Audio-Reaction-Diffusion.loom.json": {
    firstFrame:
      "A Gray-Scott simulation starts from a CLEARED state: the feedback pair's alpha is " +
      "the seeded-start flag, so frame 0 is by construction the moment before any chemistry " +
      "exists. The picture arrives within a few frames. Worth knowing rather than worth " +
      "hiding, because a gallery thumbnail is frame 0 — filed for the E24 track (T518).",
    evidence: "opens on a black frame",
  },
};

const lin = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

interface Reading {
  /** Mean |Δ| of linear luma between the two late frames. */
  readonly motion: number;
  /** p999 − p001 of the last frame's linear luma. */
  readonly range: number;
  /** The brightest linear luma anywhere in frame 0. */
  readonly firstFrameMax: number;
}

/**
 * ONE measurement path, and `animate: true` is written into it rather than passed to it.
 *
 * The colour space comes from the PLAN, never from an assumption: the Output node applies
 * the display transform, so its target already holds encoded bytes, and claiming "linear"
 * here re-encodes them — which reads a stop and a half too pale and quietly moves every
 * threshold in this file.
 */
async function measure(
  graph: GraphDocument,
  settings: ProjectSettings,
  outputNodeId: string,
): Promise<Reading> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...settings, outputResolution: { ...PROBE_RESOLUTION } },
    frames: LAST_CAPTURE + 1,
    capture: [...CAPTURE],
    outputNodeId,
    fps: 60,
    animate: true,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`render reported: ${errors.map((d) => d.message).join("; ")}`);
  }
  const space = result.plan.outputs.find((o) => o.nodeId === outputNodeId)?.space ?? "linear";
  const lumaOf = (index: number): Float64Array => {
    const frame = result.frames[index];
    if (frame === undefined) throw new Error(`no captured frame at index ${index}`);
    const image = toRgba8(
      {
        width: frame.width,
        height: frame.height,
        format: frame.format,
        bytes: frame.bytes,
        rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
      },
      { space },
    );
    const out = new Float64Array(image.data.length / 4);
    for (let at = 0, pixel = 0; at < image.data.length; at += 4, pixel += 1) {
      out[pixel] =
        0.2126 * lin(image.data[at] ?? 0) +
        0.7152 * lin(image.data[at + 1] ?? 0) +
        0.0722 * lin(image.data[at + 2] ?? 0);
    }
    return out;
  };

  const first = lumaOf(0);
  const early = lumaOf(1);
  const late = lumaOf(2);

  let sum = 0;
  for (let pixel = 0; pixel < late.length; pixel += 1) {
    sum += Math.abs((late[pixel] ?? 0) - (early[pixel] ?? 0));
  }
  const sorted = Float64Array.from(late).sort();
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  let firstFrameMax = 0;
  for (const value of first) if (value > firstFrameMax) firstFrameMax = value;

  return {
    motion: sum / Math.max(1, late.length),
    range: at(0.999) - at(0.001),
    firstFrameMax,
  };
}

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
    // And its first frame was black, which is the separate property (§V346).
    expect(slitScan.firstFrameMax).toBeLessThan(FIRST_FRAME_FLOOR);
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
      `${entry.document.name} moves, reads, and opens on something`,
      async () => {
        const probe = await probeDawn();
        if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
        if (entry.outputNodeId === undefined) throw new Error("no output node");

        const reading = await measure(
          entry.document.graph,
          entry.document.settings,
          entry.outputNodeId,
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
          "firstFrame",
          reading.firstFrameMax,
          FIRST_FRAME_FLOOR,
          declared?.firstFrame,
          `${entry.document.name} opens on a black frame (brightest pixel ` +
            `${reading.firstFrameMax.toFixed(4)}), and frame 0 is what the gallery shows.`,
        );
      },
      240_000,
    );
  }
});

/** `E4 Bloom` → `E4-Bloom.loom.json`, the same derivation `buildProjectFile` uses. */
function exampleFileNameOf(name: string): string {
  return `${name.replace(/\s+/g, "-")}.loom.json`;
}

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
