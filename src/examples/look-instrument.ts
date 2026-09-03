import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { nodeGpuHost } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";

/**
 * THE look instrument (T521, T690) — extracted from `liveness.test.ts` so the liveness
 * floors, the §V643 baselines and the baseline REGENERATOR all measure through one code
 * path. §V618 (the plan's own output space, never assumed) and §V627 (a fixed probe
 * resolution, because additive point density is resolution-dependent) are baked into
 * the instrument rather than remembered at each call site.
 */

export const PROBE_RESOLUTION = { width: 192, height: 108 } as const;

/**
 * Frames 60 and 180 — one second in, three seconds in. Both LATE (past any warm-up) and two
 * seconds apart, which is long enough that even the slowest shipped drift registers.
 */
export const CAPTURE = [0, 60, 180] as const;
export const LAST_CAPTURE = 180;

/**
 * T794 — THE FRAME THE CARD IS SOURCED FROM, and it is a POLICY rather than a law.
 *
 * "A gallery thumbnail is frame 0" was written down once, in E24's own declaration, and
 * then generalised into §V769 without anyone asking whether it had to be true. It does not:
 * there is no card image anywhere in this repo, so the card is whatever frame this file
 * names, and frame 0 is the single worst candidate — it is the one frame at which a
 * simulation has not started, a cache has nothing behind it, and a warm start is the only
 * remedy. Three examples were pushed into seeding or declaring by it, and one of them
 * (E32 Pasture) would have had to trade a load-bearing claim for a thumbnail.
 *
 * ONE SECOND IN. Already captured — it is the early half of the motion pair in both
 * windows — so the card costs no extra render. §T785's contact sheets read frames 0, 60 and
 * 180 side by side for the whole catalogue and found 60 and 180 both representative; 60 is
 * the earlier of the two, which keeps the card close to what a viewer sees on open.
 */
export const CARD_FRAME = 60;

/**
 * T776 — THE ARRANGED WINDOW, and it exists because §V760 says a fixture and the gate that
 * renders it are ONE INSTRUMENT.
 *
 * `audioPattern` now pulls its top end back for the last bar of every four, which is what
 * puts its bands on real music's spread (§T776). That bar starts 3 bars in — frame 415 at
 * bpm 104, frame 343 at bpm 126, across the nine examples that drive from it. The 181-frame
 * window above is 3.0 s, or 1.4 bars, so it renders ONLY full bars: lengthen the fixture
 * without lengthening the window and the gate observes exactly nothing new.
 *
 * Frame 440 is inside the quiet bar at EVERY bpm in the catalogue (the intersection is
 * 415.4..457.1), so one capture serves all nine.
 *
 * Only those nine pay for it. The other 28 examples — and the synthetic fixtures in
 * `liveness.test.ts`, which have no audio node at all — keep the 181-frame window and
 * measure exactly what they measured before, which was verified by regenerating every row:
 * 0 of 28 moved.
 */
export const ARRANGED_CAPTURE = [0, 60, 180, 440] as const;
export const ARRANGED_LAST_CAPTURE = 440;

const lin = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export interface Reading {
  /** Mean |Δ| of linear luma between the two late frames. */
  readonly motion: number;
  /** p999 − p001 of the last frame's linear luma. */
  readonly range: number;
  /**
   * The brightest linear luma anywhere in frame 0 — WHAT A USER MEETS ON OPEN, and since
   * T794 that is all it is. It stays a §V643 baseline row (`f0max`) so a regression to a
   * black opening still reddens as drift; it is no longer a FLOOR, because a document that
   * is dark for the first second while a simulation fills is a legitimate state and three
   * shipped examples were in it deliberately. What used to justify the floor — "frame 0 is
   * the gallery card" — was a POLICY, and T794 changed the policy rather than the files.
   */
  readonly firstFrameMax: number;
  /**
   * T794 — THE CARD. The brightest linear luma anywhere in `CARD_FRAME`, which is the
   * number that now carries "an example must show its subject".
   *
   * There is no thumbnail image in this codebase: the example browser
   * (`src/editor/library/example-library.tsx`) is text rows, and "the gallery card" is a
   * design contract asserted here and nowhere else. So the card is whichever frame this
   * instrument says it is, and choosing frame 0 was never forced — it was inherited from
   * E24's own note and never re-examined (§V769/§T786).
   */
  readonly cardMax: number;
  /** T1037 — p001 of the card frame's linear luma: where the picture's range STARTS.
   *  A blown-out card passes every max/span gate and fails only this one. */
  readonly cardFloor: number;
  /**
   * T776 — mean |Δ| linear luma between a FULL bar (frame 180) and the arrangement's QUIET
   * bar (frame 440). Present only for examples driven by `audioPattern`.
   *
   * A §V643 BASELINE, deliberately NOT a liveness floor. An example legitimately may not
   * respond to a phrase: E32 Pasture reads 0.048 and E43 Splice 0.048 because their pictures
   * are dominated by integrators whose time constants far outlast one bar, and that is a
   * fact about those examples rather than a fault. A floor would condemn them; a baseline
   * records what they do and fails when it CHANGES.
   */
  readonly phrase?: number;
}

/**
 * ONE measurement path, and `animate: true` is written into it rather than passed to it.
 *
 * The colour space comes from the PLAN, never from an assumption: the Output node applies
 * the display transform, so its target already holds encoded bytes, and claiming "linear"
 * here re-encodes them — which reads a stop and a half too pale and quietly moves every
 * threshold in this file.
 */
export async function measure(
  graph: GraphDocument,
  settings: ProjectSettings,
  outputNodeId: string,
  components?: import("../domain/components/index.ts").ComponentRegistryView,
): Promise<Reading> {
  /* T776/§V760: the window is a property of the FIXTURE the graph drives from, decided here
     so the liveness floors, the §V643 baselines and the regenerator cannot disagree about
     it — which is why this instrument was extracted in the first place. */
  const arranged = Object.values(graph.nodes).some((node) => node.type === "audioPattern");
  const capture = arranged ? ARRANGED_CAPTURE : CAPTURE;
  const lastCapture = arranged ? ARRANGED_LAST_CAPTURE : LAST_CAPTURE;
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...settings, outputResolution: { ...PROBE_RESOLUTION } },
    frames: lastCapture + 1,
    capture: [...capture],
    outputNodeId,
    fps: 60,
    animate: true,
    ...(components === undefined ? {} : { components }),
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
  /* Capture index 1 is frame 60 in BOTH windows — it is the card frame as well as the
     early half of the motion pair, so `cardMax` costs no extra render. */
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
  let cardMax = 0;
  for (const value of early) if (value > cardMax) cardMax = value;
  /* T1037 — the card's FLOOR (p001 of its linear luma). E52 and E53 shipped as
     near-white posters that PASSED motion, range and both max gates: a frame can vary
     every frame, span 0.5 of range, and still contain no darkness at all. `range` is a
     span; a span has no address. The floor says where the span STARTS, which is the
     half a blown-out card fails. Present only on rows measured since it existed, so no
     unscoped baseline sweep. */
  const cardSorted = Float64Array.from(early).sort();
  const cardFloor =
    cardSorted[Math.min(cardSorted.length - 1, Math.floor(0.001 * cardSorted.length))] ?? 0;

  /* Indices 0/1/2 are unchanged by the extra capture, so motion, range and f0max read the
     same frames they always did and no existing baseline moves. */
  let phrase: number | undefined;
  if (arranged) {
    const quiet = lumaOf(3);
    let phraseSum = 0;
    for (let pixel = 0; pixel < late.length; pixel += 1) {
      phraseSum += Math.abs((quiet[pixel] ?? 0) - (late[pixel] ?? 0));
    }
    phrase = phraseSum / Math.max(1, late.length);
  }

  return {
    motion: sum / Math.max(1, late.length),
    range: at(0.999) - at(0.001),
    firstFrameMax,
    cardMax,
    cardFloor,
    ...(phrase === undefined ? {} : { phrase }),
  };
}


/** `E4 Bloom` → `E4-Bloom.loom.json`, the same derivation `buildProjectFile` uses. */
export function exampleFileNameOf(name: string): string {
  return `${name.replace(/\s+/g, "-")}.loom.json`;
}
