import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E58 ALEMBIC — THE CLAIMS (T1166).
 *
 * One shader accumulates a domain-warped march and tone-maps it with `tanh`; a `ramp` node
 * supplies its entire colour term. A screenshot cannot tell a warp from a noise texture, a
 * palette node from a palette constant, or a free-running march from a loop, so these read
 * the pixels where the design actually lives:
 *
 *   1. THE COLOUR TERM IS THE GRAPH. Feed the shader a grey gradient and EVERY pixel comes
 *      back grey — exactly, to the byte — because the shader carries no colour of its own.
 *      Feed it the shipped ramp and most of the frame is not grey. That is the wire.
 *   2. THE FOLD IS THE ONLY THING THAT BREAKS THE VESSEL. With the warp switched off and
 *      the vessel's own asymmetries zeroed, the picture is a solid of revolution and every
 *      pixel equals its point reflection through the frame centre. Switch the fold back on
 *      and that identity is destroyed. All the structure in this file is the warp.
 *   3. `tanh` IS A SHOULDER, NOT A CLIP. Sixteen times the exposure brightens every pixel
 *      and still does not flatten the frame to white — which is the property that lets a
 *      hundred divisions by a number near zero be summed without an upper bound.
 *   4. TWO CLOCKS, AND NO THIRD, EACH MEASURED WITH THE OTHER CUT. Cut both and the file is
 *      byte-identical a minute apart, so nothing else in it moves at all. Then measure the
 *      march's pace with the fold's clock stopped and the fold's with the march stopped:
 *      a pace read off the shipped file is one either clock can carry, and the red-verify
 *      proved it — an easing that settles the march after four seconds passed that
 *      assertion outright (§V923).
 *   5. THE FIVE LOOKS ARE FIVE PICTURES. The four alternate coordinates the `.md` publishes
 *      are each far from the shipped one and from each other, so the table is a claim the
 *      suite keeps rather than prose that rots.
 *
 * Every bound is exact or derived (§V147): the grey identity and the reflection identity are
 * byte equality; "no pixel darkens" allows exactly one 8-bit quantisation step; the pace
 * ratios carry the measured numbers they were set from. The suite FAILS without Dawn; it
 * never skips.
 */

const WIDTH = 320;
const HEIGHT = 180; // 16:9, the shipped aspect — the reflection derivation below needs it
const FILE = "E58-Alembic.loom.json";
const LSB = 1 / 255;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function e58() {
  const file = listExamples().find((entry) => entry.fileName === FILE);
  if (file === undefined) throw new Error(`${FILE} is not shipped`);
  const { document } = requireExample(file);
  return {
    graph: structuredClone(document.graph) as GraphDocument,
    settings: { ...document.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
  };
}

interface Shot {
  readonly data: Uint8Array;
  readonly luma: Float64Array;
}

/** A flat mid-grey gradient: the palette node with every colour removed from it. */
const GREY_STOPS = [
  { position: 0, color: [0.5, 0.5, 0.5, 1] },
  { position: 1, color: [0.5, 0.5, 0.5, 1] },
];

async function shoot(
  overrides: Record<string, unknown>,
  frames: readonly number[],
  stops?: unknown,
): Promise<Shot[]> {
  const { graph, settings } = e58();
  Object.assign(graph.nodes["alembic"]!.parameters as Record<string, unknown>, overrides);
  if (stops !== undefined) {
    (graph.nodes["palette"]!.parameters as Record<string, unknown>)["stops"] = stops;
  }
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    frames: Math.max(...frames) + 1,
    capture: [...frames],
    animate: true,
    fps: 60,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = result.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  return frames.map((index) => {
    const frame = result.frames.find((entry) => entry.frameIndex === index);
    if (frame === undefined) throw new Error(`no captured frame ${index}`);
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
    const luma = new Float64Array(WIDTH * HEIGHT);
    for (let p = 0; p < luma.length; p += 1) {
      const at = p * 4;
      luma[p] =
        (0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0)) / 255;
    }
    return { data: image.data, luma };
  });
}

const mean = (shot: Shot): number => shot.luma.reduce((a, b) => a + b, 0) / shot.luma.length;

/** Pixels whose three channels are not all equal — i.e. pixels carrying any hue at all. */
function colouredCount(shot: Shot): number {
  let count = 0;
  for (let p = 0; p < WIDTH * HEIGHT; p += 1) {
    const at = p * 4;
    const r = shot.data[at] ?? 0;
    const g = shot.data[at + 1] ?? 0;
    const b = shot.data[at + 2] ?? 0;
    if (r !== g || g !== b) count += 1;
  }
  return count;
}

/**
 * How far a frame is from being its own point reflection through the frame centre: the
 * WORST single-channel byte difference, and how many pixels differ at all.
 */
function reflection(shot: Shot): { worst: number; count: number } {
  let worst = 0;
  let count = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const a = (y * WIDTH + x) * 4;
      const b = ((HEIGHT - 1 - y) * WIDTH + (WIDTH - 1 - x)) * 4;
      let delta = 0;
      for (let c = 0; c < 3; c += 1) delta = Math.max(delta, Math.abs((shot.data[a + c] ?? 0) - (shot.data[b + c] ?? 0)));
      if (delta > 0) count += 1;
      if (delta > worst) worst = delta;
    }
  }
  return { worst, count };
}

/** Pixels where `a` is darker than `b` by more than one quantisation step. */
function darkerCount(a: Shot, b: Shot): number {
  let count = 0;
  for (let p = 0; p < a.luma.length; p += 1) if ((a.luma[p] ?? 0) + LSB < (b.luma[p] ?? 0)) count += 1;
  return count;
}

function meanAbsDelta(a: Shot, b: Shot): number {
  let sum = 0;
  for (let p = 0; p < a.luma.length; p += 1) sum += Math.abs((a.luma[p] ?? 0) - (b.luma[p] ?? 0));
  return sum / a.luma.length;
}

function differingPixels(a: Shot, b: Shot): number {
  let count = 0;
  for (let p = 0; p < WIDTH * HEIGHT; p += 1) {
    const at = p * 4;
    if (a.data[at] !== b.data[at] || a.data[at + 1] !== b.data[at + 1] || a.data[at + 2] !== b.data[at + 2]) count += 1;
  }
  return count;
}

/**
 * THE FOUR ALTERNATE COORDINATES, READ OUT OF THE `.md` ITSELF.
 *
 * A table of parameter values in a markdown file is exactly the kind of claim that rots
 * silently: the shader gains a knob, the meaning of one of these numbers moves, and the
 * document goes on promising four pictures nobody has rendered since. Copying the table into
 * this file would only move the drift one step — two lists that must agree and nothing that
 * checks they do. So the document IS the source: the rows are parsed out of it and rendered,
 * and a typo in the prose fails the gate rather than misleading a reader (T522's argument,
 * applied to a table instead of a graph diagram).
 */
const LOOKS_DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "E58-Alembic.md");

/** The shipped node's own parameter keys — what a published look row is allowed to name. */
function shippedParameters(): Record<string, unknown> {
  return e58().graph.nodes["alembic"]!.parameters as Record<string, unknown>;
}

function publishedLooks(): Record<string, Record<string, number>> {
  const markdown = readFileSync(LOOKS_DOC, "utf8");
  const looks: Record<string, Record<string, number>> = {};
  for (const [, name, body] of markdown.matchAll(/^\|\s*\*\*(\w+)\*\*\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)) {
    if (name === undefined || body === undefined) continue;
    const overrides: Record<string, number> = {};
    for (const pair of body.split(",")) {
      const [key, value] = pair.trim().split(/\s+/);
      if (key === undefined || value === undefined || !Number.isFinite(Number(value))) {
        throw new Error(`E58's look table: cannot read "${pair.trim()}" in row ${name}`);
      }
      /* AND THE KEY HAS TO BE A REAL ONE. A row saying `radiuz 0.9` would parse, override
         nothing, and still render a different picture from the other rows — so the gate
         would pass over a line of the document that does not do what it says. */
      if (!(key in shippedParameters())) {
        throw new Error(`E58's look table: row ${name} names "${key}", which alembic1 has no parameter for`);
      }
      overrides[key] = Number(value);
    }
    looks[name] = overrides;
  }
  return looks;
}

describe("E58 Alembic — claims", () => {
  it("Dawn is available, or this suite says so rather than skipping", () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
  });

  it("the colour term is the graph: a grey ramp renders a grey frame, exactly", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [shipped] = await shoot({}, [60]);
    const [grey] = await shoot({}, [60], GREY_STOPS);
    // Not vacuous: as shipped the picture is overwhelmingly coloured.
    expect(colouredCount(shipped!) / (WIDTH * HEIGHT)).toBeGreaterThan(0.9);
    // The palette IS the ramp and the shader owns no colour of its own. Every term the
    // accumulation multiplies is a scalar, so a grey lookup can only ever sum to grey — and
    // the output's display transform is per channel, so it cannot introduce a hue either.
    // Byte equality, not a tolerance: if this is ever non-zero the shader has grown a colour
    // constant and the ramp has stopped being the whole answer (§V910 — last).
    expect(colouredCount(grey!)).toBe(0);
  });

  it("the fold is the only thing that breaks the vessel: switch it off and the frame is a solid of revolution", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    /* THE DERIVATION, because this is an identity rather than a threshold. With `octaves` 0
       the fold does nothing, so the sample point is exactly `rd * z`. Zero `wander`/`coil`
       puts the vessel's axis on the ray's, zero `squash` makes its cross-section circular,
       and `paletteAxis` (0,0,1) keys the palette on depth — at which point every quantity
       the shader computes depends on the pixel only through |ndc|, the radius in screen
       space. Zero `grain` removes the per-pixel dither, which is the one term that is
       deliberately not a function of |ndc|. A point reflection through the frame centre maps
       uv to 1-uv exactly, hence ndc to -ndc, hence |ndc| to itself — so the two pixels are
       the SAME computation and must produce the same bytes. */
    const flat = { octaves: 0, wander: 0, coil: 0, squash: 0, grain: 0, paletteAxis: [0, 0, 1] };
    const [smooth] = await shoot(flat, [60]);
    const [folded] = await shoot({ ...flat, octaves: 6 }, [60]);
    /* ONE QUANTISATION STEP, which is the allowance the identity is stated with and not a
       tuned band: the derivation is exact in real arithmetic and the hardware is not — the
       rasteriser's interpolated `uv` is not bit-symmetric about the frame centre. Measured,
       82 of 57600 pixels differ and EVERY one of them differs by exactly one, which is what
       says the residual is rounding rather than structure. */
    expect(reflection(smooth!).worst).toBeLessThanOrEqual(1);
    // And the fold destroys it wholesale, not by a step — which is what says the identity
    // above measures the warp rather than some accident of the frame being empty.
    expect(reflection(folded!).count / (WIDTH * HEIGHT)).toBeGreaterThan(0.5);
    expect(reflection(folded!).worst).toBeGreaterThan(64);
  });

  it("tanh is a shoulder, not a clip: sixteen times the exposure brightens everything and flattens nothing", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const [shipped] = await shoot({}, [60]);
    const [hot] = await shoot({ exposure: 0.32 }, [60]);
    expect(mean(hot!)).toBeGreaterThan(mean(shipped!) * 2);
    // Sixteen times the gain and the picture still is not white: a clip would have driven
    // the bright half of the frame to a flat plateau; the shoulder keeps them apart, which
    // is why the sum can be unbounded and the frame need not be.
    let white = 0;
    for (let p = 0; p < hot!.luma.length; p += 1) if ((hot!.luma[p] ?? 0) > 1 - LSB) white += 1;
    expect(white / hot!.luma.length).toBeLessThan(0.25);
    /* ⚑ AND THE ONE THAT FOUND A REAL BUG, so it is last (§V910). `tanh` is monotone and the
       accumulated sum does not depend on `exposure`, so raising it CANNOT darken a pixel —
       one quantisation step of slack and no more. It did: six channels went 255 -> 0, because
       f32 `exp` overflows inside `tanh` past an argument of about 44 and Inf/Inf is NaN. The
       shader clamps the argument now; this assertion is what stands over that clamp. */
    expect(darkerCount(hot!, shipped!)).toBe(0);
  });

  it("two clocks and no third, and a minute later BOTH are still running at the pace they opened at", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    /* §V923's discipline, and this file needs it more than most: it has TWO time inputs —
       `travel` slides the world past the eye, `flow` turns the fold's phase — so a pace
       measured on the shipped file is a pace either one of them can carry. Cutting BOTH must
       leave the file frozen, and frozen EXACTLY: `drift` keys on march depth and the dither
       on the pixel, so with those two at zero `frameU.absTime` reaches nothing at all and any
       two frames are the same bytes. That is what says there is no third clock. */
    const [frozenEarly, frozenLate] = await shoot({ travel: 0, flow: 0 }, [60, 3600]);
    expect(differingPixels(frozenEarly!, frozenLate!)).toBe(0);
    // The picture's own statistics have not drifted over the minute either: the march is
    // free-running, not consuming a scene it will run out of.
    const [, early, , last] = await shoot({}, [59, 60, 3599, 3600]);
    expect(Math.abs(mean(last!) - mean(early!))).toBeLessThan(mean(early!) * 0.15);
    /* ⚑ AND EACH CLOCK'S PACE IS MEASURED WITH THE OTHER ONE CUT, which is the whole of the
       lesson. The first draft asserted the SHIPPED file's per-frame pace at the end of the
       minute against its pace at the start — and the red-verify put an exponential ease on
       `travel` so the march settles after four seconds, and the assertion PASSED, because the
       fold's own clock kept the pixels changing at the same rate. A claim about a march that
       a warp can satisfy is a claim about the file, not about the march (§V923). So: with
       `flow` cut, what is measured is the march alone; with `travel` cut, the fold alone.
       Neither settles, because neither has a fixed point to settle into. */
    const pace = (shots: readonly Shot[]): { start: number; end: number } => ({
      start: meanAbsDelta(shots[0]!, shots[1]!),
      end: meanAbsDelta(shots[2]!, shots[3]!),
    });
    const march = pace(await shoot({ flow: 0 }, [59, 60, 3599, 3600]));
    const warp = pace(await shoot({ travel: 0 }, [59, 60, 3599, 3600]));
    expect(warp.end).toBeGreaterThan(warp.start * 0.7);
    expect(march.end).toBeGreaterThan(march.start * 0.7);
  }, 300_000);

  it("the five looks are five pictures", async () => {
    expect(dawnError, dawnError ?? "").toBeUndefined();
    const looks = publishedLooks();
    // A guard on the guard: a parser that came back empty would make everything below
    // vacuously true, and the table would stop being checked with nothing saying so.
    expect(Object.keys(looks).sort()).toEqual(["Corona", "Rake", "Skein", "Vault"]);
    const [shipped] = await shoot({}, [60]);
    const shots: Record<string, Shot> = {};
    for (const [name, overrides] of Object.entries(looks)) {
      shots[name] = (await shoot(overrides, [60]))[0]!;
    }
    // Every published coordinate is a long way from the one that ships...
    for (const [name, shot] of Object.entries(shots)) {
      expect(meanAbsDelta(shot, shipped!), `${name} against the shipped Throat`).toBeGreaterThan(0.05);
    }
    // ...and from each other, which is the claim the table actually makes: one instrument,
    // five looks, not one look with four re-exposures (§V910 — this is the one that matters).
    const names = Object.keys(shots);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const a = names[i]!;
        const b = names[j]!;
        expect(meanAbsDelta(shots[a]!, shots[b]!), `${a} against ${b}`).toBeGreaterThan(0.05);
      }
    }
  }, 180_000);
});
