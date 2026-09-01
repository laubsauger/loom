import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";
import { CINDER_ASPECT, CINDER_TTL } from "./shaders/cinder.wgsl.ts";

/**
 * T741 — E41's claims, cross-frame BY CONSTRUCTION (§V681, §V712, §V717).
 *
 * The example's whole sentence is the owner's: "a moving subject sheds motes and a
 * still one sheds none." That is a statement about BEHAVIOUR OVER TIME, which is
 * precisely the class the look baseline cannot see — §V717 measured it sampling frames
 * 60–180 and missing a 10× late collapse, and §V712 measured it reading identically
 * with every element mis-owned. So nothing here is a still: every assertion compares
 * frames, or a run against a mutated run.
 *
 * The measurements read the MOTES LAYER alone (the render retargeted straight to the
 * output, the dim source underlay and bloom dropped), so a bright pixel IS a mote and
 * the counts mean population, not grading.
 */

function e41() {
  const file = listExamples().find((entry) => entry.fileName === "E41-Cinder.loom.json");
  if (file === undefined) throw new Error("E41-Cinder.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

interface Frame {
  readonly w: number;
  readonly h: number;
  readonly d: Uint8Array | Uint8ClampedArray;
}

/** The motes layer alone: rewire the output straight to the render. */
function soloMotes(graph: GraphDocument): void {
  const edges = graph.edges as Record<string, unknown>;
  delete edges["e-lay-out"];
  edges["e-shot-out"] = {
    id: "e-shot-out",
    source: { nodeId: "shot", portId: "out" },
    target: { nodeId: "out", portId: "input" },
  };
}

/** Pin the subject: zero the path LFOs' amplitude, so the orb PARKS mid-frame. */
function stillSubject(graph: GraphDocument): void {
  for (const id of ["pathx", "pathy"]) {
    const node = graph.nodes[id];
    if (node === undefined) throw new Error(`E41 has no \`${id}\``);
    (node.parameters as Record<string, unknown>)["amplitude"] = 0;
  }
}

async function shoot(
  mutate: (graph: GraphDocument) => void,
  capture: ReadonlyArray<number>,
): Promise<Frame[]> {
  const { document } = e41();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
  return result.frames.map((frame) => {
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
    return { w: image.width, h: image.height, d: image.data };
  });
}

const luma = (frame: Frame, pixel: number): number =>
  0.2126 * (frame.d[pixel * 4] ?? 0) + 0.7152 * (frame.d[pixel * 4 + 1] ?? 0) + 0.0722 * (frame.d[pixel * 4 + 2] ?? 0);

const MOTE_THRESHOLD = 22;

function motePixels(frame: Frame): number[] {
  const found: number[] = [];
  for (let pixel = 0; pixel < frame.w * frame.h; pixel += 1) {
    if (luma(frame, pixel) > MOTE_THRESHOLD) found.push(pixel);
  }
  return found;
}

/** The orb's analytic screen position at t seconds — the LFO formula from the domain
 *  (offset + amplitude·sin(2π(f·t + phase))), through the uv→pixel mapping. */
function orbAt(t: number, w: number, h: number): { x: number; y: number } {
  const cx = 0.5 + 0.33 * Math.sin(2 * Math.PI * (0.29 * t + 0));
  const cy = 0.5 + 0.3 * Math.sin(2 * Math.PI * (0.203 * t + 0.25));
  // circle's uv (0..1, v from the TOP — texture space) straight to pixels.
  return { x: cx * w, y: cy * h };
}

describe("E41 Cinder — a moving subject sheds motes; a still one sheds none", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * THE SENTENCE AS NUMBERS, both halves in one test so they share every constant.
   *
   * Moving: the population GROWS from early to steady state (frame 12 versus 132 —
   * more than a TTL apart, so the late reading is behaviour, not opening transient,
   * §V717) and the steady cloud is a real population. Still: the same graph with the
   * path LFOs' amplitude at zero has shed its warm-up transient (anything born off the
   * cache filling in dies within one TTL = 96 frames at 60 fps) and holds ZERO motes
   * at frame 132 — not few, none: nothing moves, so nothing clears the threshold.
   */
  it(
    "grows a population while the orb travels, and decays to exactly none when it parks",
    async () => {
      const [early, steady] = await shoot(soloMotes, [12, 132]);
      const earlyCount = motePixels(early!).length;
      const steadyCount = motePixels(steady!).length;
      expect(steadyCount).toBeGreaterThan(800); // a real cloud, not a speckle
      expect(steadyCount).toBeGreaterThan(earlyCount * 1.5); // it GREW

      const [parked] = await shoot(
        (graph) => {
          soloMotes(graph);
          stillSubject(graph);
        },
        [132],
      );
      expect(motePixels(parked!).length).toBe(0);
    },
    300_000,
  );

  /**
   * THE MOTES ARE WHERE THE MOTION IS. Every bright pixel must sit near the orb's
   * RECENT path — the analytic LFO positions over the last TTL, computed from the
   * domain's own formula (§V683's discipline: the reference is the sine, not the
   * kernel). The far half of the frame, which the orb has not visited within a
   * lifetime, must hold essentially nothing.
   */
  it(
    "sheds motes along the orb's analytic path and nowhere else",
    async () => {
      const frame = (await shoot(soloMotes, [132]))[0]!;
      const pixels = motePixels(frame);
      expect(pixels.length).toBeGreaterThan(800);

      const t = 132 / 60;
      const trail = Array.from({ length: 12 }, (_, i) => orbAt(t - (i * CINDER_TTL) / 11, frame.w, frame.h));
      // Motes drift upward after birth, so the acceptance radius carries the orb's own
      // size (0.085 uv ≈ 61px), the birth jitter, and a lifetime of drift (~0.35 world
      // ≈ 0.175 of frame height plus curl wander).
      const NEAR = 260;
      let near = 0;
      for (const pixel of pixels) {
        const x = pixel % frame.w;
        const y = Math.floor(pixel / frame.w);
        const inRange = trail.some((p) => Math.hypot(x - p.x, y - p.y) < NEAR);
        if (inRange) near += 1;
      }
      expect(near / pixels.length).toBeGreaterThan(0.9);

      // The control: a disc far from everything the orb did within a lifetime.
      let far = 0;
      for (const pixel of pixels) {
        const x = pixel % frame.w;
        const y = Math.floor(pixel / frame.w);
        const distant = trail.every((p) => Math.hypot(x - p.x, y - p.y) > 420);
        if (distant) far += 1;
      }
      expect(far / pixels.length).toBeLessThan(0.02);
    },
    300_000,
  );

  /**
   * THE MOTES WEAR THE VIDEO'S COLOUR — the packed field's rgb half, sampled live
   * under each mote. The understudy's orb is WARM (fill [1, 0.82, 0.5]); over a grey
   * bed a population born on it must read red-over-blue in aggregate. Swap the pack's
   * colour channels (the §V712-shaped wiring fault) and this inverts while every
   * count above stays green.
   */
  it(
    "colours the motes from the source under them — warm orb, warm cloud",
    async () => {
      const balance = async (mutate: (graph: GraphDocument) => void): Promise<number> => {
        const frame = (await shoot(mutate, [132]))[0]!;
        const pixels = motePixels(frame);
        expect(pixels.length).toBeGreaterThan(400);
        let red = 0;
        let blue = 1;
        for (const pixel of pixels) {
          red += frame.d[pixel * 4] ?? 0;
          blue += frame.d[pixel * 4 + 2] ?? 0;
        }
        return red / blue;
      };
      const shipped = await balance(soloMotes);
      // The §V712 mutation, applied ON PURPOSE: swap the pack's red and blue sources
      // and the same population wears the wrong colours — the counts above all stay
      // green, the look baseline reads the same to four decimals, and only this
      // comparison moves. The shipped balance must beat its own colour-swapped twin.
      const swapped = await balance((graph) => {
        soloMotes(graph);
        const pack = graph.nodes["pack"];
        if (pack === undefined) throw new Error("E41 has no `pack`");
        (pack.parameters as Record<string, unknown>)["outr"] = "in1b";
        (pack.parameters as Record<string, unknown>)["outb"] = "in1r";
      });
      expect(shipped).toBeGreaterThan(1.03); // warm in absolute terms
      expect(shipped).toBeGreaterThan(swapped * 1.05); // and warmer than its mis-wired twin
    },
    300_000,
  );

  /** The display mapping the kernel and the draw share: field x times ASPECT lands the
   *  same screen column. Wrong, every mote sits squeezed into the centre — asserted by
   *  the trail test above reaching columns beyond ±(w/2)·(1/ASPECT)·... kept here as a
   *  constant sanity so a future edit to either side trips SOMETHING loudly. */
  it("keeps the kernel's aspect constant equal to the frame's", () => {
    const { document } = e41();
    const { width, height } = document.settings.outputResolution;
    expect(width / height).toBeCloseTo(CINDER_ASPECT, 5);
  });
});
