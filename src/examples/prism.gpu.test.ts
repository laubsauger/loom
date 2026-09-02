import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * T710 — E13-PRISM'S THREE REASONS TO EXIST, ASSERTED FROM PIXELS (§V147).
 *
 * The rebuild's brief named exactly the things that would break QUIETLY, and each one
 * has the same failure shape: the picture stays plausible and stops being true.
 *
 *   1. THE RIM. The prism has no glass material and no refraction — the entire illusion
 *      is T632's `envFresnel` reaching 1 at grazing on a deliberately rounded edge
 *      (§V640). Flatten the geometry, drop the environment, or move the band off the
 *      equirect's horizon and you still get a triangle; you stop getting glass.
 *   2. THE DISPERSION TRACKING THE BEAM ANGLE. A spectrum drawn at a fixed spread is a
 *      picture of a prism. What makes it a working one is that the fan's width falls out
 *      of Snell's law at the aim the value graph hands in.
 *   3. THE BEAM ARRIVING WHERE THE GEOMETRY IS. The optics are solved in a kernel and
 *      the mesh is built in a different kernel; nothing but a shared constant makes them
 *      agree, and when they stop agreeing the beam floats or buries itself and every
 *      other assertion in this file still passes.
 *
 * §V655's family — a gate that shares the bug's blindness — is why none of these is a
 * numerical health check. Each was RED-VERIFIED against the specific corruption it is
 * for, and the measured before/after is recorded on the assertion.
 *
 * §V618/§V627: every measurement is on the FULL-resolution frame, display-encoded from
 * the plan's own output space. A deep-black document is exactly where a linear dump lies
 * most, and every threshold here is in display luma out of 255.
 */

function e13() {
  const file = listExamples().find((entry) => entry.fileName === "E13-Prism.loom.json");
  if (file === undefined) throw new Error("E13-Prism.loom.json is not shipped");
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

/**
 * The bloom, MUTED, for the measurements that are about geometry rather than glow.
 *
 * Level's window is pushed above every value in the frame, so `clip1` clamps the whole
 * thing to zero and `add` adds nothing — the real chain still runs, no pass is removed,
 * and nothing downstream has to know. A blur of 22px would otherwise smear a 2px rim
 * thread over the body it is being compared against, which would make the ring/interior
 * ratio below measure the blur rather than the Fresnel.
 */
function muteBloom(graph: GraphDocument): void {
  const cut = graph.nodes["cut"];
  if (cut === undefined) throw new Error("E13 has no `cut` node — the bloom chain moved");
  (cut.parameters as Record<string, unknown>)["blacklevel"] = 4;
  (cut.parameters as Record<string, unknown>)["whitelevel"] = 5;
}

function param(graph: GraphDocument, id: string, key: string, value: unknown): void {
  const node = graph.nodes[id];
  if (node === undefined) throw new Error(`E13 has no \`${id}\` node`);
  (node.parameters as Record<string, unknown>)[key] = value;
}

/** Frame 0, full resolution, display-encoded from the plan's own space (§V618). */
async function shoot(mutate: (graph: GraphDocument) => void): Promise<Frame> {
  const { document } = e13();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: 1,
    capture: [0],
    animate: true,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
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
}

const luma = (frame: Frame, pixel: number): number =>
  0.2126 * (frame.d[pixel * 4] ?? 0) + 0.7152 * (frame.d[pixel * 4 + 1] ?? 0) + 0.0722 * (frame.d[pixel * 4 + 2] ?? 0);

function maskAbove(frame: Frame, threshold: number): Uint8Array {
  const mask = new Uint8Array(frame.w * frame.h);
  for (let pixel = 0; pixel < mask.length; pixel += 1) mask[pixel] = luma(frame, pixel) > threshold ? 1 : 0;
  return mask;
}

/** Four-neighbour erosion, `radius` times. The 6px erosion is §V640's own split. */
function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let current = mask;
  for (let step = 0; step < radius; step += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const at = y * w + x;
        next[at] =
          current[at] === 1 && current[at - 1] === 1 && current[at + 1] === 1 && current[at - w] === 1 && current[at + w] === 1
            ? 1
            : 0;
      }
    }
    current = next;
  }
  return current;
}

function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let current = mask;
  for (let step = 0; step < radius; step += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const at = y * w + x;
        next[at] =
          current[at] === 1 || current[at - 1] === 1 || current[at + 1] === 1 || current[at - w] === 1 || current[at + w] === 1
            ? 1
            : 0;
      }
    }
    current = next;
  }
  return current;
}

/** The lit run of the fan at one screen column: its top, bottom and vertical span. */
function fanRun(frame: Frame, x: number, threshold: number): { lo: number; hi: number; span: number } {
  let lo = -1;
  let hi = -1;
  for (let y = 0; y < frame.h; y += 1) {
    if (luma(frame, y * frame.w + x) > threshold) {
      if (lo < 0) lo = y;
      hi = y;
    }
  }
  if (lo < 0) throw new Error(`no fan pixels at column ${x}`);
  return { lo, hi, span: hi - lo + 1 };
}

const COLUMN = 240;
const FAN_THRESHOLD = 10;

/** The prism alone, no beams, no bloom — the mask every geometry claim is measured on. */
const soloPrism = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "solid1");
  muteBloom(graph);
};
const soloFan = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "fan1");
  muteBloom(graph);
};
const soloShaft = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "shaft1");
  muteBloom(graph);
};

/* Dawn is REQUIRED, never skipped: a pixel claim that quietly does not run is §V461's
   reader-that-cannot-see, and this file is nothing but pixel claims. */
describe("E13 Prism — the picture", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * THE RIM, on §V640's own instrument and in §V640's own units.
   *
   * The invariant records two numbers per subject — mean |Δ| with the environment band
   * wired and unwired, split by a 6px erosion of the object's mask — and its whole point
   * is that the SPLIT is the reading: E33's lobed goo measured ring 45.8 / interior 25.9,
   * a 1.8× preference for the outline and therefore a rim; E33's flat emblem measured
   * ring 14.5 / interior 19.5, stronger in the BODY, and therefore fill wearing a rim's
   * name. So this asserts the split, not the brightness.
   *
   * Measured at 1280×720 on the commit this test landed at: ring mean |Δ| 43.06,
   * interior 4.21 — 10.2× harder on the outline. That is the highest ratio in the
   * catalogue, and the reason is geometric rather than lucky: §V640's limit says the
   * band-rim fails on a flat camera-facing surface, and a prism seen down its own axis is
   * ALL grazing edge and flat black cap.
   *
   * RED-VERIFIED: the failure this is for is the geometry losing its round-over — flatten
   * the cap edge and the sweep through grazing disappears with it. Growing the mesh's
   * circumradius from 0.76 to 0.95 while the optics stay put already drops the ratio to
   * 8.62; the floor of 4 is set well under the shipped 10.2 so ordinary drift does not
   * trip it, and well over the 1.8 that §V640 calls the weakest thing still worth the
   * word rim.
   */
  it(
    "lights the prism's OUTLINE and not its body — the environment lands 10x harder on the ring",
    async () => {
      const lit = await shoot(soloPrism);
      const dark = await shoot((graph) => {
        soloPrism(graph);
        param(graph, "shot", "environmentIntensity", 0);
      });

      const mask = maskAbove(lit, 1);
      const interior = erode(mask, lit.w, lit.h, 6);

      let ringDelta = 0;
      let ringCount = 0;
      let bodyDelta = 0;
      let bodyCount = 0;
      let ringLuma = 0;
      let bodyLuma = 0;
      for (let pixel = 0; pixel < mask.length; pixel += 1) {
        if (mask[pixel] !== 1) continue;
        const delta = Math.abs(luma(lit, pixel) - luma(dark, pixel));
        if (interior[pixel] === 1) {
          bodyDelta += delta;
          bodyLuma += luma(lit, pixel);
          bodyCount += 1;
        } else {
          ringDelta += delta;
          ringLuma += luma(lit, pixel);
          ringCount += 1;
        }
      }
      // A mask that collapsed would satisfy any ratio, so both populations are real first.
      expect(ringCount).toBeGreaterThan(2000);
      expect(bodyCount).toBeGreaterThan(20000);

      const ring = ringDelta / ringCount;
      const body = bodyDelta / bodyCount;
      expect(ring / body).toBeGreaterThan(4);

      // And the picture the ratio is about: the outline is bright, the body is not.
      expect(ringLuma / ringCount).toBeGreaterThan(30);
      expect(bodyLuma / bodyCount).toBeLessThan(20);
    },
    240_000,
  );

  /**
   * THE DISPERSION TRACKS THE BEAM ANGLE — the claim that separates a working prism from
   * a picture of one, and the reason this example was rebuilt rather than retouched.
   *
   * `optics1.value1` is the aim, normally driven by `swing1 → ease1`; the two clones
   * below pin it static at each end of the swing so the measurement does not depend on
   * where an LFO happens to be. The measure is the fan's vertical span at one screen
   * column, which is the thing a viewer actually sees widen.
   *
   * The direction of the effect is DERIVED, not assumed. The rebuild's brief said a more
   * oblique incoming beam spreads more; the arithmetic says the opposite, and the file
   * follows the arithmetic. Differentiating the prism's deviation at fixed θ1 gives
   * dδ/dn = (sin θ3 + cos θ3 · tan θ2) / cos θ4, and as θ1 grows, θ2 grows, θ3 = A − θ2
   * shrinks and θ4 with it — so angular dispersion FALLS as the beam lies down on the
   * entry face and RISES as the internal ray approaches the critical angle at the EXIT
   * face. Computed: 10.91° of fan at value1 = 1 (θ1 = 37°) against 5.98° at value1 = 0
   * (θ1 = 62°), a ratio of 1.82. Measured on the picture at this commit: 108px against
   * 46px at column 240, a ratio of 2.35 — larger than the angular ratio because the
   * fan's exit point also swings, which is the same physics arriving twice.
   *
   * RED-VERIFIED: mute the aim (hold value1 at one value for both renders) and the ratio
   * is 1.00 by construction. The floor of 1.5 sits between that and the shipped 2.35.
   */
  it(
    "spreads the spectrum WIDER at the shallower aim — the fan is Snell's law, not a drawing",
    async () => {
      const wide = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 1);
      });
      const narrow = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 0);
      });

      const wideSpan = fanRun(wide, COLUMN, FAN_THRESHOLD).span;
      const narrowSpan = fanRun(narrow, COLUMN, FAN_THRESHOLD).span;
      // Both aims must actually put a fan on that column — a span of nothing is not narrow.
      expect(narrowSpan).toBeGreaterThan(20);
      expect(wideSpan / narrowSpan).toBeGreaterThan(1.5);
    },
    240_000,
  );

  /**
   * THE CONTROL, and the one that proves the fan is DISPERSION rather than geometry.
   *
   * `optics1.value2` is the glass's dispersive power — the whole span of n across the
   * band, 0.085 as shipped. At zero every band refracts identically, so 61 rays leave
   * along one line: the spectrum is not merely desaturated, it CEASES TO BE A FAN. That
   * is a different failure from "the colours went wrong", and it is the one a reader
   * would mistake for a working prism if the fan were an authored spread.
   *
   * Measured at this commit: 108px of span with dispersion, 3px without — 2.8%.
   */
  it(
    "collapses the fan to a single ray when the glass stops dispersing",
    async () => {
      const dispersing = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 1);
      });
      const flat = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 1);
        param(graph, "optics", "value2", 0);
      });
      const spread = fanRun(dispersing, COLUMN, FAN_THRESHOLD).span;
      const collapsed = fanRun(flat, COLUMN, FAN_THRESHOLD).span;
      expect(collapsed / spread).toBeLessThan(0.25);
    },
    240_000,
  );

  /**
   * BLUE BENDS FURTHEST, which is the physics the ramp and the refractive index have to
   * agree about. `t` is BOTH the band's index and its hue — n = 1.50 + value2·t, colour =
   * `spectrum1` sampled at u = t — so a reversed n(λ) reverses the fan without changing
   * anything else about the picture, and every other assertion in this file still passes.
   *
   * The prism deviates toward its base, and the base is DOWN, so more deviation means
   * lower on the screen: red at the top of the fan, violet at the bottom. Measured at
   * this commit, in the top and bottom 15% of the run at column 240: top R 255 / B 14,
   * bottom R 128 / B 255.
   *
   * RED-VERIFIED by swapping `t` for `1 − t` in the kernel's index: top R 87 / B 255,
   * bottom R 255 / B 15 — both assertions below invert.
   */
  it(
    "puts red at the top of the fan and violet at the bottom — deviation ordered by wavelength",
    async () => {
      const fan = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 1);
      });
      const run = fanRun(fan, COLUMN, FAN_THRESHOLD);
      const band = Math.max(2, Math.round(run.span * 0.15));
      const slice = (lo: number, hi: number) => {
        let red = 0;
        let blue = 0;
        let count = 0;
        for (let y = lo; y <= hi; y += 1) {
          const at = y * fan.w + COLUMN;
          if (luma(fan, at) <= FAN_THRESHOLD) continue;
          red += fan.d[at * 4] ?? 0;
          blue += fan.d[at * 4 + 2] ?? 0;
          count += 1;
        }
        if (count === 0) throw new Error("empty slice");
        return { red: red / count, blue: blue / count };
      };
      const top = slice(run.lo, run.lo + band);
      const bottom = slice(run.hi - band, run.hi);
      expect(top.red).toBeGreaterThan(top.blue * 2);
      expect(bottom.blue).toBeGreaterThan(bottom.red * 1.5);
    },
    240_000,
  );

  /**
   * THE BEAM ARRIVES WHERE THE GLASS IS, and this is the assertion §V655 is about.
   *
   * `form1` builds the mesh and `optics1` solves the optics, and the ONLY thing making
   * them agree is that a rounded triangle's flat run sits at RC/2 from the axis for every
   * corner radius, so both read one constant. Nothing in the compiler checks it. Change
   * one and the picture stays completely plausible — a prism, a beam, a spectrum — while
   * the beam floats in space beside the glass or drives through the middle of it.
   *
   * So the claim is two-sided, because the two corruptions fail in OPPOSITE directions:
   * the shaft's tip must REACH the prism's mask, and no beam pixel may reach 8px INSIDE
   * it. Measured at this commit: tip 1px from the mask, 0 beam pixels in the erosion.
   *
   * RED-VERIFIED both ways, by moving the mesh and leaving the optics alone. Growing the
   * circumradius 0.76 → 0.95 puts 209 fan pixels inside the erosion (the beams get
   * buried); shrinking it 0.76 → 0.45 moves the shaft's tip 30px off the glass and drops
   * the fan's convergence point outside the mask entirely (the beams float).
   */
  it(
    "lands the shaft ON the glass and drives neither beam through it",
    async () => {
      // The aim is PINNED for all three renders: the shaft's entry point does not move
      // with it, but the fan's does, and a claim about where things land must not depend
      // on where an LFO happened to be at frame 0.
      const prism = await shoot(soloPrism);
      const shaft = await shoot((graph) => {
        soloShaft(graph);
        param(graph, "optics", "value1", 1);
      });
      const fan = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 1);
      });

      const glass = maskAbove(prism, 1);
      const near = dilate(glass, prism.w, prism.h, 3);
      const deep = erode(glass, prism.w, prism.h, 8);
      const shaftMask = maskAbove(shaft, 12);
      const fanMask = maskAbove(fan, 12);

      const overlap = (a: Uint8Array, b: Uint8Array): number => {
        let n = 0;
        for (let pixel = 0; pixel < a.length; pixel += 1) if (a[pixel] === 1 && b[pixel] === 1) n += 1;
        return n;
      };
      // Both draws have to be on screen at all before "where" means anything.
      expect(shaftMask.reduce((a, b) => a + b, 0)).toBeGreaterThan(500);
      expect(fanMask.reduce((a, b) => a + b, 0)).toBeGreaterThan(5000);

      // The shaft reaches the glass ...
      expect(overlap(shaftMask, near)).toBeGreaterThan(0);
      /* ... and since T718, CONTINUES THROUGH IT: the shaft draw now carries the traced
         internal segment, so the glass interior must hold a real population of its
         pixels — this half of the claim INVERTED when the trace landed, deliberately.
         "No shaft pixel inside the solid" was the gate for beams placed cosmetically
         against the body; the trace makes the interior path the feature the owner asked
         for by name, and an empty interior is now the failure (a kernel that stopped
         emitting slot 2 would render the old disconnected picture and pass every other
         assertion here). Measured at the T718 swap: 743 interior pixels. The geometry-
         agreement duty the old zero carried — mesh and optics reading one constant —
         lives on in prism-trace.gpu.test.ts's exact connectivity assertions (§V683).
         The FAN keeps the no-burial claim: it starts ON the exit face and leaves. */
      expect(overlap(shaftMask, deep)).toBeGreaterThan(300);
      /* T758 loosened this from exactly 0: the beams live INSIDE the glass body's z
         now, so the fan's ROOT — the exit point, which is ON the face by the trace's
         own connectivity gates — projects a few pixels into the 8px erosion under the
         perspective camera. Measured at the swap: 3 pixels. The claim keeps its
         discriminating power by two orders of magnitude: the red-verified real burial
         (circumradius 0.76 → 0.95) measured 209. */
      expect(overlap(fanMask, deep)).toBeLessThan(30);

      /**
       * And the fan's rays CONVERGE on the glass rather than merely missing it. The span
       * grows linearly with distance from the exit face, so extrapolating the span to
       * zero across two columns gives the exit point without the taper's sub-pixel first
       * millimetre ever having to render. Measured at this commit: (510, 265), inside the
       * mask; at circumradius 0.45 it falls outside.
       */
      const a = fanRun(fan, 200, FAN_THRESHOLD);
      const b = fanRun(fan, 420, FAN_THRESHOLD);
      const slope = (b.span - a.span) / (420 - 200);
      // The glass is to the RIGHT of both columns, so the fan NARROWS with increasing x:
      // a non-negative slope means the rays are parallel or diverging the wrong way, and
      // the extrapolation below would be meaningless rather than merely wrong.
      expect(slope).toBeLessThan(0);
      const apexX = 420 - b.span / slope;
      const midA = (a.lo + a.hi) / 2;
      const midB = (b.lo + b.hi) / 2;
      const apexY = midB + ((midB - midA) / (420 - 200)) * (apexX - 420);
      const x = Math.round(apexX);
      const y = Math.round(apexY);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(prism.w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(prism.h);
      expect(dilate(glass, prism.w, prism.h, 8)[y * prism.w + x]).toBe(1);
    },
    300_000,
  );

  /**
   * THE POINTER TAKES THE AIM WHILE IT MOVES, AND HANDS IT BACK (T857, §V624).
   *
   * The owner's report was that the mouse "gets overridden by the auto movement", and the
   * cause was one line: the kernel ADDED the pointer's share to a SQUARE lfo's aim, so the
   * hand was a small delta riding on a slam. It is a blend now — `mix(swing, hand, w)`
   * with `w = clamp(400·value4, 0, 1)` and `value4` the cursor's own speed squared through
   * `stir1 → urge1 → hold1` — so this gate has to be two-sided or it proves half of it:
   *
   *   MOVING  — the fan must go somewhere the swing's whole range cannot reach;
   *   IDLE    — a few seconds later, with the cursor still parked where it stopped, the
   *             fan must be back where the swing alone puts it, to the pixel.
   *
   * The second half is the one a naive "pointer wins" build would fail, and the first is
   * the one the old additive build failed. Both renders are compared against a PARKED
   * render of the SAME length, so `drift1`'s camera sway and the LFO phase are common mode
   * and the only difference in each pair is the cursor.
   *
   * The harness feeds the same pointer source the shaders read (§V182/T661), so this is
   * the app's own path. `value1` is pinned for every render: the swing must not be what
   * moves the fan here.
   */
  it(
    "answers a MOVING pointer, and gives the aim back when it stops",
    async () => {
      const { document } = e13();
      const run = async (
        frames: number,
        pointer: (frameIndex: number) => { x: number; y: number; buttons: number },
      ): Promise<{ mid: number; span: number }> => {
        const graph = structuredClone(document.graph) as GraphDocument;
        soloFan(graph);
        // The LFO is pinned so the ONLY difference within a pair is the pointer.
        param(graph, "optics", "value1", 0);
        const result = await renderHeadless({
          host: nodeGpuHost(),
          graph,
          settings: document.settings,
          frames,
          capture: [frames - 1],
          animate: true,
          outputNodeId: "out",
          pointer,
        });
        const frame = result.frames[0];
        if (frame === undefined) throw new Error("no frame captured");
        const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
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
        const run = fanRun({ w: image.width, h: image.height, d: image.data }, COLUMN, FAN_THRESHOLD);
        return { mid: (run.lo + run.hi) / 2, span: run.span };
      };
      const parked = () => ({ x: 0, y: 0, buttons: 0 });
      /* A second of travel from the middle of the frame to a fifth along it: 0.35 of the
         frame in a second, which is an ordinary aiming move and ten times the speed the
         authority needs. It STOPS at frame 60 and stays stopped. */
      const sweep = (index: number) => ({ x: 0.5 - 0.35 * Math.min(1, index / 60), y: 0.5, buttons: 0 });

      const stillMoving = await run(70, sweep);
      const parkedShort = await run(70, parked);
      // The hand has the aim: the fan is somewhere the swing's own range never puts it.
      // Measured at this commit, at column 240: the run's midpoint sits at y 123 with the
      // cursor moving and y 289.5 with it parked — a 166px swing, against the 86px the
      // additive build managed with the cursor HELD at the end of its travel.
      expect(Math.abs(stillMoving.mid - parkedShort.mid)).toBeGreaterThan(150);

      const longIdle = await run(360, sweep);
      const parkedLong = await run(360, parked);
      // Five seconds after the cursor stopped, the swing has it back. The envelope's
      // release is 0.6s, so this is eight time constants; measured residue, 2.5px of 166.
      expect(Math.abs(longIdle.mid - parkedLong.mid)).toBeLessThan(4);
      expect(Math.abs(longIdle.span - parkedLong.span)).toBeLessThan(4);
      // ... and it really came BACK: the fan is nowhere near where the hand had it, so
      // "within 4px of parked" is a journey rather than a picture that never moved.
      expect(Math.abs(longIdle.mid - stillMoving.mid)).toBeGreaterThan(150);
    },
    600_000,
  );

  /**
   * AND IT CAN MISS THE GLASS — the state the owner named ("we cant test all the extremes
   * or even miss the glass triangle") and the one the additive aim could not express at
   * all, because the entry point was pinned ON the face by construction.
   *
   * The pointer's reach runs to ±0.8 along a face whose half-length is 0.658, so the outer
   * ninth of the travel at each end puts the entry past a vertex. The claim is not merely
   * "the fan went away" — a black frame would satisfy that — so it is three-sided: the fan
   * is GONE, the shaft is still crossing the frame and is LONGER than a hit's (it carries
   * on instead of stopping at the face), and the glass still reads at full strength, which
   * is what says the picture is coherent rather than broken.
   */
  it(
    "aims the beam PAST the glass — the fan goes, the shaft carries on, the glass still reads",
    async () => {
      const { document } = e13();
      const lit = async (
        solo: (graph: GraphDocument) => void,
        toX: number,
      ): Promise<{ count: number; frame: Frame }> => {
        const graph = structuredClone(document.graph) as GraphDocument;
        solo(graph);
        param(graph, "optics", "value1", 0);
        const result = await renderHeadless({
          host: nodeGpuHost(),
          graph,
          settings: document.settings,
          frames: 70,
          capture: [69],
          animate: true,
          outputNodeId: "out",
          pointer: (index) => ({ x: 0.5 + (toX - 0.5) * Math.min(1, index / 60), y: 0.5, buttons: 0 }),
        });
        const frame = result.frames[0];
        if (frame === undefined) throw new Error("no frame captured");
        const space = result.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
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
        const shot: Frame = { w: image.width, h: image.height, d: image.data };
        const mask = maskAbove(shot, 12);
        return { count: mask.reduce((a, b) => a + b, 0), frame: shot };
      };

      // 0.5 is the middle of the travel: the entry sits at the face's own midpoint and
      // the beam is squarely on the glass. 0.02 aims past the APEX, 0.98 past the BASE.
      const fanOn = await lit(soloFan, 0.5);
      const fanApex = await lit(soloFan, 0.02);
      const fanBase = await lit(soloFan, 0.98);
      expect(fanOn.count).toBeGreaterThan(5000);
      // Zero-length beams draw zero AREA (T680), so the fan is not dim — it is absent.
      // Measured: 20,429 fan pixels on the glass, 0 past either vertex.
      expect(fanApex.count).toBe(0);
      expect(fanBase.count).toBe(0);

      // The shaft is still crossing the frame — a missed beam is a beam GOING BY, not
      // nothing — and it goes PAST the body rather than through it. That second half is
      // the exact inversion of the T718 claim above, on the same instrument: a hit puts
      // more than 300 shaft-group pixels inside an 8px erosion of the glass (the drawn
      // internal segment), and a miss must put NONE inside even a 3px erosion.
      const glassOn = await lit(soloPrism, 0.5);
      const glassApex = await lit(soloPrism, 0.02);
      const glassBase = await lit(soloPrism, 0.98);
      const shaftApex = await lit(soloShaft, 0.02);
      const shaftBase = await lit(soloShaft, 0.98);
      const overlap = (a: Uint8Array, b: Uint8Array): number => {
        let n = 0;
        for (let pixel = 0; pixel < a.length; pixel += 1) if (a[pixel] === 1 && b[pixel] === 1) n += 1;
        return n;
      };
      // Measured: 1,637 shaft pixels past the apex and 3,183 past the base (the apex miss
      // leaves the top of the frame), and 0 inside the body in either.
      for (const [shaft, glass] of [
        [shaftApex, glassApex],
        [shaftBase, glassBase],
      ] as const) {
        expect(shaft.count).toBeGreaterThan(1000);
        const body = erode(maskAbove(glass.frame, 1), glass.frame.w, glass.frame.h, 3);
        expect(overlap(maskAbove(shaft.frame, 12), body)).toBe(0);
      }

      /* AND THE GLASS STILL READS — judged on the frame the owner would be looking at,
         not on a solo render the beam never entered. `soloPrism` cannot fail this on its
         own (it draws no beams at all, so the aim cannot reach it, §V655), so the mask
         comes from the solo render and the LUMA is read out of the FULL missed frame:
         every draw present, the beam sailing past. Measured: 2,700 lit body pixels in
         all three of the solo, the on-glass and the missed frames. */
      expect(glassApex.count).toBe(glassOn.count);
      expect(glassBase.count).toBe(glassOn.count);
      expect(glassOn.count).toBeGreaterThan(2000);
      const wholeApex = await lit(muteBloom, 0.02);
      const bodyMask = maskAbove(glassOn.frame, 12);
      expect(overlap(maskAbove(wholeApex.frame, 12), bodyMask)).toBe(glassOn.count);
    },
    600_000,
  );
});
