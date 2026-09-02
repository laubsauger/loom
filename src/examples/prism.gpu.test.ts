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

/* T929: the lamp rests left, the fan exits right — measured bbox x 1035..1919. */
const COLUMN = 1400;
const FAN_THRESHOLD = 10;

/* T918: the environment draws as the BACKDROP in the shipped picture. The optics claims
 * below are about the BEAMS, so every solo helper also hides the backdrop — the same
 * against-black measurement they were derived on — while the environment's own gate
 * (further down) measures the backdrop deliberately. */
const soloBackdropOff = (graph: GraphDocument): void => {
  param(graph, "shot", "showEnvironment", false);
};

/** The prism alone, no beams, no bloom — the mask every geometry claim is measured on. */
/* T928: the body TILTS with the pointer (form1 reads follow1 through value1/value2).
   Geometry gates measure the NEUTRAL tilt — 0.227 on both slots is yaw = nod = 0 by the
   kernel's own rest offsets — so where-things-land claims stay claims about the optics,
   not about where the swivel happened to be. The tilt has its own gate below. */
const lockTilt = (graph: GraphDocument): void => {
  // T937: the tilt is a named param pair now, shared by mesh AND trace — lock BOTH.
  for (const id of ["form", "optics"]) {
    param(graph, id, "tiltYaw", 0);
    param(graph, id, "tiltNod", 0);
  }
};

const soloCore = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "core1");
  muteBloom(graph);
  soloBackdropOff(graph);
  soloHard(graph, "core");
};

const soloPrism = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "solid1");
  muteBloom(graph);
  soloBackdropOff(graph);
};
/* T917: the shipped beams are SOFT and ADDITIVE — light, whose 61 overlapping skirts
 * saturate any threshold. The claims in this file are about WHERE Snell puts the rays, so
 * the solo clones measure the same geometry as hard opaque ribbons, exactly as every span
 * and mask below was derived. The light's own claims live in scene-soft-beam.gpu.test. */
const soloHard = (graph: GraphDocument, id: string): void => {
  param(graph, id, "soft", 0);
  param(graph, id, "blend", "opaque");
};
const soloFan = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "fan1");
  muteBloom(graph);
  soloBackdropOff(graph);
  soloHard(graph, "fan");
};
const soloShaft = (graph: GraphDocument): void => {
  param(graph, "shot", "scenes", "shaft1");
  muteBloom(graph);
  soloBackdropOff(graph);
  soloHard(graph, "shaft");
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
      // T940 re-measured: at env 0.7 (the dark room) the interior mask thins to 17.7k —
      // still 8x the ring's floor; the RATIO claims below are the physics.
      expect(ringCount).toBeGreaterThan(2000);
      expect(bodyCount).toBeGreaterThan(15000);

      const ring = ringDelta / ringCount;
      const body = bodyDelta / bodyCount;
      expect(ring / body).toBeGreaterThan(4);

      // And the picture the ratio is about: the outline reads, the body is dark. T940
      // dimmed the room (env 3.2 -> 0.7): the rim now measures 24.9 display against the
      // body's sub-20 — dimmer than the bright-room 30+, but still the brightest thing
      // on the silhouette, which is the claim (§V751: both numbers moved together).
      expect(ringLuma / ringCount).toBeGreaterThan(22);
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
   * face. Computed: 10.91° of fan at θ1 = 37.2° (value1 0.4 on T915b's 6°–84° axis)
   * against 5.98° at θ1 = 62.2° (value1 0.72), a ratio of 1.82. Measured on the picture at this commit: 108px against
   * 46px at column 240, a ratio of 2.35 — larger than the angular ratio because the
   * fan's exit point also swings, which is the same physics arriving twice.
   *
   * RED-VERIFIED: mute the aim (hold value1 at one value for both renders) and the ratio
   * is 1.00 by construction. The floor of 1.5 sits between that and the shipped 2.35.
   */
  it(
    "spreads the spectrum WIDER at the shallower aim — the fan is Snell's law, not a drawing",
    async () => {
      /* T929 aims: (px 0, py 0.05) is θ1 = 35.8°, close to the critical regime (wide);
         (0, 0.7) is θ1 = 45.8°, the far end of the lamp's θ band on this face (narrow).
         The lamp's reachable incidence range on ONE face is ~35°–46° — narrower than the
         old abstract slider's 37°–62° — so the analytic ratio here is 1.46 (was 1.82).
         Measured on screen: 1.20 exactly (projection compresses the angular ratio); the
         floor sits below it with the red-verified 1.00 of a muted aim underneath (§V751). */
      const wide = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 0.0237);
        param(graph, "optics", "value3", 0);
      });
      const narrow = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 0.332);
        param(graph, "optics", "value3", 0);
      });

      const wideSpan = fanRun(wide, COLUMN, FAN_THRESHOLD).span;
      const narrowSpan = fanRun(narrow, COLUMN, FAN_THRESHOLD).span;
      // Both aims must actually put a fan on that column — a span of nothing is not narrow.
      // T913 re-measured at the PHYSICAL Δn (0.085 → 0.03, dense flint): 33px against 18px,
      // ratio 1.83 — now within a hair of the DERIVED angular ratio 1.82, where the old
      // exaggerated spread read 2.35 (§V751: 108/46 then, 33/18 now). The physics gate got
      // SHARPER by getting real.
      expect(narrowSpan).toBeGreaterThan(12);
      expect(wideSpan / narrowSpan).toBeGreaterThan(1.12);
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
        param(graph, "optics", "value1", 0.142);
        param(graph, "optics", "value3", 0);
      });
      const flat = await shoot((graph) => {
        soloFan(graph);
        param(graph, "optics", "value1", 0.142);
        param(graph, "optics", "value3", 0);
        param(graph, "optics", "value2", 0);
      });
      const spread = fanRun(dispersing, COLUMN, FAN_THRESHOLD).span;
      /* T941: at zero dispersion every band's ray is IDENTICAL, so the wedge segments
         have zero width — the fan is not merely narrow, it can vanish below the pixel
         at this column. No pixels IS the collapse. */
      let collapsed = 0;
      try {
        collapsed = fanRun(flat, COLUMN, FAN_THRESHOLD).span;
      } catch {
        collapsed = 0;
      }
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
        param(graph, "optics", "value1", 0.142);
        param(graph, "optics", "value3", 0);
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
      const prism = await shoot((graph) => {
        soloPrism(graph);
        lockTilt(graph);
      });
      const shaft = await shoot((graph) => {
        soloShaft(graph);
        lockTilt(graph);
        param(graph, "optics", "value1", 0.142);
        param(graph, "optics", "value3", 0);
      });
      const core = await shoot((graph) => {
        soloCore(graph);
        lockTilt(graph);
        param(graph, "optics", "value1", 0.142);
        param(graph, "optics", "value3", 0);
      });
      const fan = await shoot((graph) => {
        soloFan(graph);
        lockTilt(graph);
        param(graph, "optics", "value1", 0.142);
        param(graph, "optics", "value3", 0);
      });

      const glass = maskAbove(prism, 1);
      const near = dilate(glass, prism.w, prism.h, 3);
      const deep = erode(glass, prism.w, prism.h, 8);
      const shaftMask = maskAbove(shaft, 12);
      const coreMask = maskAbove(core, 12);
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
      /* ... and since T718, the beam CONTINUES THROUGH IT — carried since T941b by the
         CORE draw (the in-glass wedge segments, role 0.5): the glass interior must hold
         a real population of core pixels, or the kernel stopped emitting the interior
         path and the picture went back to the disconnected pre-T718 look while every
         other assertion here still passed. The FAN keeps the no-burial claim: it starts
         ON the exit face and leaves. */
      expect(overlap(coreMask, deep)).toBeGreaterThan(300);
      /* T758 loosened this from exactly 0: the beams live INSIDE the glass body's z
         now, so the fan's ROOT — the exit point, which is ON the face by the trace's
         own connectivity gates — projects a few pixels into the 8px erosion under the
         perspective camera. Measured at the swap: 3 pixels; T920's 9 marched slices
         rooting on the ROUNDED face measure 48 (§V751 — more roots, same face-adjacent
         rooting). The red-verified real burial (circumradius 0.76 → 0.95) measured 209,
         so the floor keeps a 2x margin below the failure it discriminates. */
      expect(overlap(fanMask, deep)).toBeLessThan(100);

      /**
       * And the fan's rays CONVERGE on the glass rather than merely missing it. The span
       * grows linearly with distance from the exit face, so extrapolating the span to
       * zero across two columns gives the exit point without the taper's sub-pixel first
       * millimetre ever having to render. Measured at this commit: (510, 265), inside the
       * mask; at circumradius 0.45 it falls outside.
       */
      const a = fanRun(fan, 1200, FAN_THRESHOLD);
      const b = fanRun(fan, 1700, FAN_THRESHOLD);
      const slope = (b.span - a.span) / (1700 - 1200);
      // T929: the glass is to the LEFT of both columns now — the fan WIDENS with x. A
      // non-positive slope would make the extrapolation below meaningless.
      expect(slope).toBeGreaterThan(0);
      const apexX = 1200 - a.span / slope;
      const midA = (a.lo + a.hi) / 2;
      const midB = (b.lo + b.hi) / 2;
      const apexY = midA + ((midB - midA) / (1700 - 1200)) * (apexX - 1200);
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
   * THE SWIVEL IS REAL ON SCREEN (T928): the body's silhouette at one tilt extreme is a
   * genuinely different set of pixels from the other — not a lighting flicker. The
   * differential is on solo renders of the prism alone with everything else muted, so
   * nothing but form1's rotation can move the mask.
   */
  it(
    "tilts the body's silhouette with the tilt slots (T928)",
    async () => {
      const left = await shoot((graph) => {
        soloPrism(graph);
        param(graph, "form", "tiltYaw", -0.15);
      });
      const right = await shoot((graph) => {
        soloPrism(graph);
        param(graph, "form", "tiltYaw", 0.3);
      });
      const a = maskAbove(left, 4);
      const b = maskAbove(right, 4);
      let differs = 0;
      let present = 0;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] === 1 || b[i] === 1) present += 1;
        if (a[i] !== b[i]) differs += 1;
      }
      // Both are a prism-sized body, and a real fraction of the union moved.
      expect(present).toBeGreaterThan(5000);
      expect(differs / present).toBeGreaterThan(0.08);
    },
    240_000,
  );

  /**
   * THE POINTER MOVES THE AIM, AND WHERE IT STOPS THE AIM STAYS (T915b, §V624).
   *
   * T857's version of this gate asserted the aim came BACK a few seconds after the
   * cursor stopped — and that hand-back is exactly the "reset after a time" the owner
   * rejected twice. The gate now asserts the OPPOSITE second half, on the app's own
   * pointer path (§V182/T661):
   *
   *   MOVING — the fan must land somewhere the parked picture never puts it;
   *   PARKED — five more seconds with the cursor exactly where it stopped, and the fan
   *            has not moved a further pixel beyond the lag's own settling.
   *
   * Nothing is pinned: both aim axes ride the pointer, which is the whole T915b claim.
   */
  it(
    "answers a MOVING pointer, and STAYS where the pointer stops",
    async () => {
      const { document } = e13();
      const run = async (
        frames: number,
        pointer: (frameIndex: number) => { x: number; y: number; buttons: number },
      ): Promise<{ mid: number; span: number }> => {
        const graph = structuredClone(document.graph) as GraphDocument;
        soloFan(graph);
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
      /* T929: both runs keep the lamp at px 0 (level-left) where the fan reads at
         COLUMN; the sweep slides the strike down the face (py 0.3 -> 0.6). */
      const parked = () => ({ x: 0, y: 0.142, buttons: 0 });
      /* A second of travel: an ordinary aiming move. It STOPS at frame 60 and stays. */
      const sweep = (index: number) => ({ x: 0, y: 0.142 + 0.142 * Math.min(1, index / 60), buttons: 0 });

      /* 130 frames: the move ends at 60 and the 0.18s lag settles over the next 70 —
         comparing a just-stopped frame against a long-idle one would measure the lag's
         own tail (10px at frame 70), not a hand-back. */
      const stillMoving = await run(130, sweep);
      const parkedShort = await run(130, parked);
      // The pointer has the aim: the entry walked up the face and the fan's whole run
      // moved with it — two renders differing ONLY in the cursor.
      expect(Math.abs(stillMoving.mid - parkedShort.mid)).toBeGreaterThan(40);

      const longIdle = await run(360, sweep);
      // THE T915b GATE: five more seconds parked where it stopped, and the aim has NOT
      // been handed back to anything — the fan sits where frame 70 left it, within the
      // lag's last hair of settling. The T857 build measured a 150px+ return here.
      expect(Math.abs(longIdle.mid - stillMoving.mid)).toBeLessThan(6);
      expect(Math.abs(longIdle.span - stillMoving.span)).toBeLessThan(6);
      // ... and it is still nowhere near the parked picture: held ≠ drifted home.
      const parkedLong = await run(360, parked);
      expect(Math.abs(longIdle.mid - parkedLong.mid)).toBeGreaterThan(40);
    },
    600_000,
  );

  /**
   * AND IT CAN MISS THE GLASS — the state the owner named ("we cant test all the extremes
   * or even miss the glass triangle") and the one the additive aim could not express at
   * all, because the entry point was pinned ON the face by construction.
   *
   * T929: the top of the Y travel carries the beam clear off the body — the lamp still
   * shines, the glass just isn't in the way. The claim is not merely
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
        toY: number,
      ): Promise<{ count: number; frame: Frame }> => {
        const graph = structuredClone(document.graph) as GraphDocument;
        solo(graph);
        lockTilt(graph);
        const result = await renderHeadless({
          host: nodeGpuHost(),
          graph,
          settings: document.settings,
          frames: 70,
          capture: [69],
          animate: true,
          outputNodeId: "out",
          // px 0 holds the lamp level-left while y slides the aim off the glass.
          pointer: (index) => ({ x: 0, y: 0.142 + (toY - 0.142) * Math.min(1, index / 60), buttons: 0 }),
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

      // y 0.142 strikes the left face near its middle; y 0.98 carries the beam past the
      // base-left vertex — a real miss on the marched body.
      const fanOn = await lit(soloFan, 0.142);
      const fanApex = await lit(soloFan, 0.98);
      expect(fanOn.count).toBeGreaterThan(5000);
      // Zero-length beams draw zero AREA (T680), so the fan is not dim — it is absent.
      expect(fanApex.count).toBe(0);

      // The shaft is still crossing the frame — a missed beam is a beam GOING BY, not
      // nothing — and it goes PAST the body rather than through it. That second half is
      // the exact inversion of the T718 claim above, on the same instrument: a hit puts
      // more than 300 shaft-group pixels inside an 8px erosion of the glass (the drawn
      // internal segment), and a miss must put NONE inside even a 3px erosion.
      const glassOn = await lit(soloPrism, 0.142);
      const glassApex = await lit(soloPrism, 0.98);
      const shaftApex = await lit(soloShaft, 0.98);
      const overlap = (a: Uint8Array, b: Uint8Array): number => {
        let n = 0;
        for (let pixel = 0; pixel < a.length; pixel += 1) if (a[pixel] === 1 && b[pixel] === 1) n += 1;
        return n;
      };
      // Measured: shaft pixels past the apex still cross the frame, none inside the body.
      for (const [shaft, glass] of [[shaftApex, glassApex]] as const) {
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
      expect(glassOn.count).toBeGreaterThan(2000);
      const wholeApex = await lit(muteBloom, 0.98);
      const bodyMask = maskAbove(glassOn.frame, 12);
      expect(overlap(maskAbove(wholeApex.frame, 12), bodyMask)).toBe(glassOn.count);
    },
    600_000,
  );
});
