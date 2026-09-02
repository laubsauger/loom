import { describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { prismTraceKernel } from "./shaders/prism-trace.wgsl.ts";
import { sd3 } from "./shaders/prism-geometry.ts";
import { PRISM_DUST_KERNEL } from "./documents/prism.ts";

/**
 * T718, gated per §V683: THE TRACE AGAINST THE DOMAIN, never against its own text.
 *
 * §V683's lesson (the lens-shift sign) is that a unit test happily pins whatever
 * convention its author chose — only the domain, or looking, can say the convention is
 * wrong. So every Snell assertion here is the SCALAR law read off optics, computed in
 * float64 from angles:
 *
 *   entry:      θr = asin(sin θi / n)
 *   exit face:  θ₂ = A − θr   (A = 60°, the equilateral prism identity)
 *   exit:       θe = asin(n · sin θ₂)      — TIR exactly when n · sin θ₂ > 1
 *
 * and the GPU's directions are measured FACE-RELATIVE (the frame Snell speaks in),
 * so no global rotation convention of the kernel's can satisfy the gate by accident.
 *
 * The acceptance criterion, from the owner: "move the beam and everything downstream
 * follows." The sweep below moves the entry ANGLE across the shipped range and the
 * entry POINT toward the apex, includes one TIR case that must leave through the BASE,
 * and asserts the fan opens WIDER at steep incidence (T710's measured 46 → 108px, here
 * as exit-angle spread).
 *
 * ## T929 — the LAMP: x orbits, y sweeps
 *
 * The owner: "i have no idea how to properly aim with our mouse controls". The two
 * abstract sliders are gone; the cursor is a TORCH now. `value3` (x) carries the lamp
 * around the prism on a 240° arc — every face, every incidence, by walking around it —
 * and `value1` (y) slides the aim across the body: 0 aims at the INCENTER (a ray at the
 * incenter meets each face near its middle — the rest strike), 1 carries the beam clear
 * off the glass. Every aim below is named as (px, py) and every Snell number is DERIVED
 * from the same mapping in float64 — aimOf() mirrors the kernel's constants, and each
 * gate first proves its sample lands where the comment says (face, θ1) before asserting
 * the GPU agrees. Nothing decays (T915b's property is unchanged).
 */

/* T920: the beam. 2 fixed slots + SLICES(9) x BANDS(61) x 3 legs. The CENTRE slice
 * (s = 4) is the exact ray every pre-T920 assertion measured — flat mid-face hits meet
 * the flat part of the SDF, so the scalar-Snell claims hold to the march tolerance. */
const SLICES = 9;
const BANDS = 61;
const CAPACITY = 2 + SLICES * BANDS * 3;
const CENTRE_BASE = 2 + 4 * BANDS * 3;
const interiorIndex = (t: number): number => CENTRE_BASE + Math.round(t * (BANDS - 1)) * 3;
const tirIndex = (t: number): number => interiorIndex(t) + 1;
/* T941: leg 2 is the WEDGE SEGMENT between band k and k+1 — its geometry is the
   MIDPOINT of the two bands' exit rays, so its analytic wavelength is the segment
   centre. The last band's slot is deliberately dead (no partner). */
const segIndex = (k: number): number => CENTRE_BASE + k * 3 + 2;
const segT = (k: number): number => (k + 0.5) / (BANDS - 1);
const RI = 0.38; // E13's PRISM_RC / 2, pinned as the same literal E13 interpolates
const NR: readonly [number, number] = [Math.sqrt(3) / 2, 0.5];
const NL: readonly [number, number] = [-Math.sqrt(3) / 2, 0.5];
const ND: readonly [number, number] = [0, -1];
const APEX = Math.PI / 3; // 60° between the refracting faces
const N_RED = 1.5;
/* T929 — the lamp's constants, pinned as literals exactly as RI is: a gate that derived
   them from the kernel text could not notice the kernel changing them. */
const LAMP_R = 3.3;
const ARC_A = 185;
const ARC_B = -175;
const OFF_MAX = 1.9;

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const registry = createNodeRegistry(allNodeDefinitions).view();

interface Values {
  /** T929: the pointer's Y — slides the aim across the body. */
  readonly value1: number;
  readonly value2: number;
  /** T929: the pointer's X — the lamp's place on the arc. */
  readonly value3?: number;
  /** T937: the body's pose — the trace runs in body space. Defaults 0 (neutral). */
  readonly tiltYaw?: number;
  readonly tiltNod?: number;
}

function traceGraph(values: Values): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label,
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("hue", "ramp", { type: "horizontal" }, "hue1"),
        node(
          "trace",
          "pointKernel",
          {
            capacity: CAPACITY,
            attributes: JSON.stringify([
              { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
              { name: "tip", type: "vec3f", default: [0, 0, 0] },
              { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
              { name: "role", type: "f32", default: [1] },
            ]),
            kernel: prismTraceKernel(RI.toFixed(3)),
            value1: values.value1,
            value2: values.value2,
            value3: values.value3 ?? 0,
            tiltYaw: values.tiltYaw ?? 0,
            tiltNod: values.tiltNod ?? 0,
          },
          "trace1",
        ),
        node("draw", "renderPoints", {}, "draw1"),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e0: { id: "e0", source: { nodeId: "hue", portId: "out" }, target: { nodeId: "trace", portId: "field" } },
      e1: { id: "e1", source: { nodeId: "trace", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

interface Segment {
  readonly origin: readonly [number, number];
  readonly tip: readonly [number, number];
  readonly origin3: readonly [number, number, number];
  readonly tip3: readonly [number, number, number];
}

async function runTrace(values: Values): Promise<Segment[]> {
  const plan = compileGraph({ graph: traceGraph(values), settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    const positions = new Float32Array(await backend.readBuffer("scratch:trace:position"));
    const tips = new Float32Array(await backend.readBuffer("scratch:trace:tip"));
    const segments: Segment[] = [];
    for (let index = 0; index < CAPACITY; index += 1) {
      const base = index * 4; // vec3f strides at 16 bytes
      segments.push({
        origin: [positions[base] ?? 0, positions[base + 1] ?? 0],
        tip: [tips[base] ?? 0, tips[base + 1] ?? 0],
        origin3: [positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0],
        tip3: [tips[base] ?? 0, tips[base + 1] ?? 0, tips[base + 2] ?? 0],
      });
    }
    return segments;
  } finally {
    backend.dispose();
  }
}

const direction = (s: Segment): [number, number] => {
  const dx = s.tip[0] - s.origin[0];
  const dy = s.tip[1] - s.origin[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
};
const dot = (a: readonly [number, number], b: readonly [number, number]): number => a[0] * b[0] + a[1] * b[1];
const length = (s: Segment): number => Math.hypot(s.tip[0] - s.origin[0], s.tip[1] - s.origin[1]);
/** Incidence/exit angle against a FACE normal — the frame Snell's law speaks in. */
const faceAngle = (d: readonly [number, number], n: readonly [number, number]): number =>
  Math.acos(Math.min(1, Math.abs(dot(d, n))));

interface Aim {
  readonly S: readonly [number, number];
  readonly d: readonly [number, number];
  /** The entry face's outward normal, or null for a clean miss of the sharp triangle. */
  readonly face: readonly [number, number] | null;
  readonly thetaI: number;
  readonly tau: number;
}
/** The kernel's lamp mapping, mirrored in float64 — the tests' single aim authority. */
const aimOf = (px: number, py: number): Aim => {
  const phi = ((ARC_A + (ARC_B - ARC_A) * px) * Math.PI) / 180;
  const S: [number, number] = [LAMP_R * Math.cos(phi), LAMP_R * Math.sin(phi)];
  const vx = -S[0] + (S[1] / LAMP_R) * py * OFF_MAX;
  const vy = -S[1] + (-S[0] / LAMP_R) * py * OFF_MAX;
  const l = Math.hypot(vx, vy);
  const d: [number, number] = [vx / l, vy / l];
  let best: { N: readonly [number, number]; t: number; p: [number, number] } | null = null;
  for (const N of [NR, NL, ND]) {
    const dn = d[0] * N[0] + d[1] * N[1];
    if (dn >= -1e-9) continue;
    const at = (RI - (S[0] * N[0] + S[1] * N[1])) / dn;
    if (at <= 0) continue;
    const pt: [number, number] = [S[0] + d[0] * at, S[1] + d[1] * at];
    const inside = [NR, NL, ND].every((M) => pt[0] * M[0] + pt[1] * M[1] <= RI + 1e-7);
    if (inside && (best === null || at < best.t)) best = { N, t: at, p: pt };
  }
  if (best === null) return { S, d, face: null, thetaI: Number.NaN, tau: Number.NaN };
  const N = best.N;
  const thetaI = Math.acos(Math.min(1, -(d[0] * N[0] + d[1] * N[1])));
  const tangent: [number, number] = [-N[1], N[0]];
  const tau = (best.p[0] - N[0] * RI) * tangent[0] + (best.p[1] - N[1] * RI) * tangent[1];
  return { S, d, face: N, thetaI, tau };
};
/** The entry point's coordinate ALONG a face, from that face's own midpoint. */
const tauOf = (point: readonly [number, number], N: readonly [number, number]): number =>
  (point[0] - N[0] * RI) * (-N[1]) + (point[1] - N[1] * RI) * N[0];
/** T913: the kernel's Cauchy curve, mirrored exactly — n(λ)=A+B/λ², λ 0.7µm → 0.4µm,
 * B derived so `dispersion` stays the total spread across the band. */
const bandN = (t: number, dispersion: number): number => {
  const lam = 0.7 + (0.4 - 0.7) * t;
  const invRed = 1 / (0.7 * 0.7);
  const k = 1 / (0.4 * 0.4) - invRed;
  return N_RED + (dispersion / k) * (1 / (lam * lam) - invRed);
};
const bandIndex = (t: number): number => interiorIndex(t) + 2;
/** Inside the cross-section: every face plane satisfied, with a hair of slack. */
const insideGlass = (point: readonly [number, number]): boolean =>
  [NR, NL, ND].every((n) => dot(point, n) <= RI - 1e-4);

describe("the prism is a traced ray (T718, §V683)", () => {
  it("entry and exit angles follow scalar Snell across the aim sweep, and the fan opens toward critical", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085; // E13's shipped dispersive power
    const spreads: number[] = [];
    /* Three lamp aims on the LEFT face (px 0 holds the lamp level-left; py slides the
       strike): θ1 = 39.7°, 44.3°, 45.8°. All clear of the violet TIR onset (34.5° at
       this power), and all with |τ| inside the SDF's FLAT run — (RI−BEVEL)·√3 = 0.578,
       shorter than the sharp face (T920's finding: the bevel shrinks the usable span). */
    for (const [px, py] of [
      [0, 0.142],
      [0, 0.284],
      [0, 0.332],
    ] as const) {
      const aim = aimOf(px, py);
      expect(aim.face).toEqual(NL); // the sample lands where the comment says
      const thetaI = aim.thetaI;
      const segments = await runTrace({ value1: py, value2: dispersion, value3: px });

      // THE INTERNAL SEGMENT: its refracted angle against the entry face is
      // asin(sin θi / n) — the first Snell, measured from geometry the GPU wrote.
      const internal = segments[interiorIndex(0.5)]!;
      expect(length(internal)).toBeGreaterThan(0.05);
      const nMid = bandN(0.5, dispersion);
      expect(faceAngle(direction(internal), NL)).toBeCloseTo(Math.asin(Math.sin(thetaI) / nMid), 3);

      // CONTINUITY — the owner's structural complaint. The shaft ENDS where the
      // internal segment BEGINS, which is where the incoming ray meets the face.
      const shaft = segments[0]!;
      expect(internal.origin[0]).toBeCloseTo(shaft.tip[0], 5);
      expect(internal.origin[1]).toBeCloseTo(shaft.tip[1], 5);
      // And the central SEGMENT's root sits at the midpoint of its two bands' interior
      // far ends — one connected path, entry to fan (T941's wedge semantics).
      const central = segments[segIndex(30)]!;
      const int30 = segments[interiorIndex(30 / 60)]!;
      const int31 = segments[CENTRE_BASE + 31 * 3]!;
      expect(central.origin[0]).toBeCloseTo((int30.tip[0] + int31.tip[0]) / 2, 3);
      expect(central.origin[1]).toBeCloseTo((int30.tip[1] + int31.tip[1]) / 2, 3);

      // EXIT SNELL, per segment wavelength, against the exit face (NR — the internal
      // ray from the left face crosses to the right one): θe = asin(n · sin(60° − θr)).
      for (const k of [0, 30, 59]) {
        const n = bandN(segT(k), dispersion);
        const thetaR = Math.asin(Math.sin(thetaI) / n);
        const theta2 = APEX - thetaR;
        expect(n * Math.sin(theta2)).toBeLessThan(1); // no TIR at these aims
        const thetaE = Math.asin(n * Math.sin(theta2));
        const band = segments[segIndex(k)]!;
        expect(length(band)).toBeGreaterThan(0.5);
        // Segment-midpoint geometry vs the centre-wavelength analytic: 7e-4 rad is the
        // instrument's honest floor (measured 5.4e-4 at the faceted swap).
        expect(Math.abs(faceAngle(direction(band), NR) - thetaE)).toBeLessThan(7e-4);
        // The segment leaves through the EXIT FACE: its root lies on dot(p, NR) = RI.
        expect(dot(band.origin, NR)).toBeCloseTo(RI, 3);
      }

      // No TIR at the central wavelength here, so the TIR leg is zero-length.
      expect(length(segments[tirIndex(0.5)]!)).toBeLessThan(1e-4);

      const spread =
        faceAngle(direction(segments[segIndex(59)]!), NR) - faceAngle(direction(segments[segIndex(0)]!), NR);
      spreads.push(spread);
    }
    // The fan NARROWS as θ1 climbs away from the critical regime — the same dδ/dn
    // physics as ever, asserted in the direction this sweep actually walks.
    expect(spreads[0]!).toBeGreaterThan(spreads[1]!);
    expect(spreads[1]!).toBeGreaterThan(spreads[2]!);
    // And the widest matches the analytic spread, not merely the trend.
    const thetaI = aimOf(0, 0.142).thetaI;
    const exitOf = (tt: number): number => {
      const n = bandN(tt, dispersion);
      return Math.asin(n * Math.sin(APEX - Math.asin(Math.sin(thetaI) / n)));
    };
    expect(spreads[0]!).toBeCloseTo(exitOf(segT(59)) - exitOf(segT(0)), 3);
  }, 240_000);

  it("total internal reflection leaves through the BASE, and Snell holds there too", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    /* (0.3, 0.2): θi ≈ 30.5° on the LEFT face, wide dispersive power — the violet end
       reaches n · sin(60° − θr) > 1 at the right face, reflects, and leaves through the
       base. The sample is a MEASURED compromise (§V751): higher strikes put the violet's
       first hit ON the apex arc, lower ones drive even red's interior into the base
       first; here the violet lands mid-base exactly (dot ND = 0.380) while red exits the
       right face just above its corner arc (dot NR measured 0.373 — the arc has begun to
       curl the face plane away, so red's origin is pinned by membership, not to the
       plane's third decimal). */
    const dispersion = 0.3;
    const aim = aimOf(0.2, 0.095);
    expect(aim.face).toEqual(NL);
    const thetaI = aim.thetaI;
    const segments = await runTrace({ value1: 0.095, value2: dispersion, value3: 0.2 });

    const nViolet = bandN(segT(59), dispersion);
    const thetaR = Math.asin(Math.sin(thetaI) / nViolet);
    const theta2 = APEX - thetaR;
    expect(nViolet * Math.sin(theta2)).toBeGreaterThan(1); // the domain says TIR

    const violet = segments[segIndex(59)]!;
    // Through the BASE: the origin lies on dot(p, ND) = RI, not on the exit face.
    expect(dot(violet.origin, ND)).toBeCloseTo(RI, 2);
    expect(dot(violet.origin, NR)).toBeLessThan(RI - 1e-3);
    expect(length(violet)).toBeGreaterThan(0.5);
    // Snell at the base: incidence after the mirror bounce is |60° − θ₂|, and the
    // emitted angle its refraction — the same scalar law, third application.
    const thetaBase = Math.abs(APEX - theta2);
    expect(nViolet * Math.sin(thetaBase)).toBeLessThan(1);
    expect(faceAngle(direction(violet), ND)).toBeCloseTo(Math.asin(nViolet * Math.sin(thetaBase)), 2);

    // The RED end still exits the right face in the same frame — one prism, two faces
    // in use at once, which no authored fan can express. Near the corner arc: membership
    // (ON the right side, NOT the base), not plane-exact (see the sample note above).
    const red = segments[segIndex(0)]!;
    expect(dot(red.origin, NR)).toBeGreaterThan(0.36);
    expect(dot(red.origin, ND)).toBeLessThan(RI - 0.02);
  }, 240_000);

  /**
   * T929 — Y SLIDES THE STRIKE ALONG THE FACE, and everything downstream follows. The
   * lamp mapping couples position and angle mildly (that is what a torch does); the
   * claims are the mapping's own: the strike walks MONOTONICALLY down the face as y
   * grows, the path stays connected end to end at every stop, and the interior segment
   * shortens as the strike approaches the vertex where two faces converge.
   */
  it("slides the strike along the face on y, connected at every stop", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085;
    const taus: number[] = [];
    const interiors: number[] = [];
    for (const py of [0, 0.19, 0.332]) {
      const aim = aimOf(0, py);
      expect(aim.face).toEqual(NL);
      const segments = await runTrace({ value1: py, value2: dispersion, value3: 0 });
      const entry = segments[0]!.tip;
      // The MARCHED entry lands where the mapping says, on the face plane, at its τ.
      expect(dot(entry, NL)).toBeCloseTo(RI, 3);
      expect(tauOf(entry, NL)).toBeCloseTo(aim.tau, 2);
      // Snell at that strike, from the mapped incidence.
      const internal = segments[interiorIndex(0.5)]!;
      expect(faceAngle(direction(internal), NL)).toBeCloseTo(
        Math.asin(Math.sin(aim.thetaI) / bandN(0.5, dispersion)),
        3,
      );
      // Connected: shaft tip = internal origin; internal tip = the central band's exit.
      expect(internal.origin[0]).toBeCloseTo(entry[0], 5);
      const central = segments[segIndex(30)]!;
      const int31 = segments[CENTRE_BASE + 31 * 3]!;
      expect(central.origin[0]).toBeCloseTo((internal.tip[0] + int31.tip[0]) / 2, 3);
      expect(central.origin[1]).toBeCloseTo((internal.tip[1] + int31.tip[1]) / 2, 3);
      taus.push(tauOf(entry, NL));
      interiors.push(length(internal));
    }
    // Monotone: the strike WALKS as y grows — the aiming model the owner asked for.
    expect(taus[0]!).toBeGreaterThan(taus[1]!);
    expect(taus[1]!).toBeGreaterThan(taus[2]!);
    // Toward the base-left vertex the faces converge and the crossing shortens.
    expect(interiors[2]!).toBeLessThan(interiors[0]!);
  }, 300_000);

  /**
   * THE TOP OF THE Y TRAVEL MISSES THE GLASS, and that is a STATE rather than a failure
   * ("we cant test all the extremes or even miss the glass triangle"). The miss is
   * asserted against the DOMAIN: fifty samples along the drawn shaft, none inside the
   * cross-section. A ray that sneaked in through any face would fail that even with a
   * zero fan.
   */
  it("misses the glass at the top of the y travel — the fan collapses and the shaft carries on", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085;
    for (const px of [0.067, 0.4]) {
      expect(aimOf(px, 0.98).face).toBeNull(); // the domain says: off the glass
      const segments = await runTrace({ value1: 0.98, value2: dispersion, value3: px });

      // Nothing refracts. Ghost, interior, TIR leg and all 61 bands are points.
      for (const index of [1, interiorIndex(0.5), tirIndex(0.5)]) expect(length(segments[index]!)).toBeLessThan(1e-4);
      for (const k of [0, 30, 59]) expect(length(segments[segIndex(k)]!)).toBeLessThan(1e-4);

      // The shaft goes THROUGH: the full MISS_LEN cast, off-frame to off-frame (T929).
      const shaft = segments[0]!;
      expect(length(shaft)).toBeCloseTo(7.0, 3);
      const d = direction(shaft);
      for (let step = 0; step <= 50; step += 1) {
        const s = (step / 50) * length(shaft);
        expect(insideGlass([shaft.origin[0] + d[0] * s, shaft.origin[1] + d[1] * s])).toBe(false);
      }
    }
  }, 300_000);

  /**
   * THE LAMP REACHES TIR AT THE SHIPPED DISPERSIVE POWER, in two regimes:
   *
   *   (0.05, 0.45), θ1 ≈ 30° — THE SPECTRUM SPLITS: red exits the right face; violet is
   *     past critical there, reflects, and leaves through the BASE. Two faces in one frame.
   *   (0.05, 0), θ1 = 23° — past critical for EVERY band: the whole spectrum reflects at
   *     the right face and leaves through the base together, every wavelength at EXACTLY
   *     θ1 (the equilateral one-bounce identity: the second incidence is θr for every n,
   *     so asin(n·sin θr) = θ1). A SHEET, not a fan.
   */
  it("reaches TIR on the lamp's range at E13's own dispersion", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085;
    const thetaR = (thetaI: number, n: number): number => Math.asin(Math.sin(thetaI) / n);
    const trapped = (thetaI: number, n: number): boolean => n * Math.sin(APEX - thetaR(thetaI, n)) > 1;

    // ---- the SPLIT ---------------------------------------------------------------
    const splitAim = aimOf(0.0333, 0.213);
    expect(splitAim.face).toEqual(NL);
    expect(trapped(splitAim.thetaI, bandN(segT(0), dispersion))).toBe(false); // red is not
    expect(trapped(splitAim.thetaI, bandN(segT(59), dispersion))).toBe(true); //  violet is
    const split = await runTrace({ value1: 0.213, value2: dispersion, value3: 0.0333 });

    const red = split[segIndex(0)]!;
    const nRed = bandN(segT(0), dispersion);
    expect(dot(red.origin, NR)).toBeCloseTo(RI, 3);
    // T937: the 3D march's f32 gradient normal costs ~1e-3 rad here, AMPLIFIED by the
    // steep exit (d asin/dx ≈ 4 at 74°) — 2 decimals is the claim the instrument affords.
    expect(faceAngle(direction(red), NR)).toBeCloseTo(
      Math.asin(nRed * Math.sin(APEX - thetaR(splitAim.thetaI, nRed))),
      2,
    );
    const violet = split[segIndex(59)]!;
    expect(dot(violet.origin, ND)).toBeCloseTo(RI, 2);
    expect(dot(violet.origin, NR)).toBeLessThan(RI - 1e-3);
    expect(length(violet)).toBeGreaterThan(0.5);
    expect(faceAngle(direction(violet), ND)).toBeCloseTo(splitAim.thetaI, 2);

    // ---- the ALL-TIR SHEET -------------------------------------------------------
    const baseAim = aimOf(0.0333, 0);
    expect(baseAim.face).toEqual(NL);
    const segments = await runTrace({ value1: 0, value2: dispersion, value3: 0.0333 });
    for (const k of [0, 30, 59]) {
      const n = bandN(segT(k), dispersion);
      expect(trapped(baseAim.thetaI, n)).toBe(true);
      const band = segments[segIndex(k)]!;
      expect(dot(band.origin, ND)).toBeCloseTo(RI, 2);
      expect(length(band)).toBeGreaterThan(0.5);
      expect(faceAngle(direction(band), ND)).toBeCloseTo(baseAim.thetaI, 2);
    }
    // The reflected leg inside the body is DRAWN, which is what makes TIR a path here.
    expect(length(segments[tirIndex(0.5)]!)).toBeGreaterThan(0.02);
  }, 300_000);

  /**
   * T928 — THE APERTURE MEETS THE FACET CREASE. On the round T920 bevel, slices met a
   * SWEEPING normal and fanned continuously (a caustic). Cut glass does the opposite,
   * and this gate pins the difference: a beam straddling the base's face/chamfer crease
   * (τ 0.605) SPLITS — each slice refracts parallel to its own facet, far apart between
   * facets, with NO intermediate rays. Mid-face stays parallel. Measured on the
   * INTERIOR legs, which exist at every facet (an exit near the crease can die by TIR
   * and silently thin an exit-side sample). Same kernel, no branch.
   */
  it("slices refract parallel per facet and SPLIT across the chamfer crease (T928)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const anglesAcrossSlices = async (px: number, py: number): Promise<number[]> => {
      const segments = await runTrace({ value1: py, value2: 0.03, value3: px });
      const angles: number[] = [];
      for (const s of [0, 4, 8]) {
        const seg = segments[2 + s * BANDS * 3 + 30 * 3]!;
        if (length(seg) < 1e-3) continue;
        const d = direction(seg);
        angles.push(Math.atan2(d[1], d[0]));
      }
      expect(angles.length).toBe(3);
      return angles.sort((a, b) => a - b);
    };

    expect(aimOf(0.6667, 0.142).tau).toBeCloseTo(-0.034, 2);
    const flat = await anglesAcrossSlices(0.6667, 0.142);
    expect(flat[2]! - flat[0]!).toBeLessThan(0.002);

    expect(aimOf(0.6, 0.009).tau).toBeCloseTo(0.605, 2);
    const crease = await anglesAcrossSlices(0.6, 0.009);
    const spread = crease[2]! - crease[0]!;
    expect(spread).toBeGreaterThan(0.04);
    // BIMODAL: the middle slice belongs to one facet's cluster, never in between —
    // a round bevel would put it mid-sweep, which is the look this cut replaced.
    expect(Math.min(crease[1]! - crease[0]!, crease[2]! - crease[1]!)).toBeLessThan(0.005);
  }, 300_000);

  /**
   * T920 — DISPERSION IS VISIBLE INSIDE THE GLASS: the per-band interior segments part
   * before any exit face, and their far-wall landings separate. Measured at the REST
   * aim — the frame every visitor sees first.
   */
  it("violet peels from red INSIDE the body — per-band interiors, drawn and divergent", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    expect(aimOf(0, 0).face).toEqual(NL); // the rest strike, θ1 = 35°
    const segments = await runTrace({ value1: 0, value2: 0.03, value3: 0 });
    // T941b: interiors are segments now — band 60 has no partner, so the violet END is
    // the last live segment (bands 59-60), the red end the first (bands 0-1).
    const red = segments[CENTRE_BASE + 0 * 3]!;
    const violet = segments[CENTRE_BASE + 59 * 3]!;
    expect(length(red)).toBeGreaterThan(0.05);
    expect(length(violet)).toBeGreaterThan(0.05);
    const dr = direction(red);
    const dv = direction(violet);
    const parted = Math.abs(Math.atan2(dr[1], dr[0]) - Math.atan2(dv[1], dv[0]));
    expect(parted).toBeGreaterThan(0.003);
    expect(parted).toBeLessThan(0.02);
    const landed = Math.hypot(red.tip[0] - violet.tip[0], red.tip[1] - violet.tip[1]);
    expect(landed).toBeGreaterThan(0.002);
  }, 300_000);

  /**
   * T937 — THE BEAM STAYS ON THE SWIVELED BODY: the owner's disconnect ("the ray doesn't
   * seem like it actually comes out of that surface"), measured. The trace runs in BODY
   * space against the same solid the mesh renders (prism-geometry.ts, one description),
   * so with the body yawed AND nodded the traced entry, far wall and exit root must all
   * still lie ON that rotated surface — |sd3| of the inverse-rotated point within the
   * march epsilon — and the entry must genuinely MOVE against the untilted trace (the
   * pose is real, not absorbed).
   */
  it("keeps entry and exit ON the body across a swivel (T937)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const yaw = 0.25;
    const nod = 0.1;
    const flat = await runTrace({ value1: 0.142, value2: 0.085, value3: 0 });
    const tilted = await runTrace({ value1: 0.142, value2: 0.085, value3: 0, tiltYaw: yaw, tiltNod: nod });

    // world -> body: undo nod (about X), then yaw (about Y) — the kernel's own inverse.
    const toBody = ([x, y, z]: readonly [number, number, number]): [number, number, number] => {
      const cn = Math.cos(-nod);
      const sn = Math.sin(-nod);
      const [y1, z1] = [y * cn - z * sn, y * sn + z * cn];
      const cy = Math.cos(-yaw);
      const sy = Math.sin(-yaw);
      return [x * cy + z1 * sy, y1, -x * sy + z1 * cy];
    };

    const entry = tilted[0]!.tip3;
    const wall = tilted[interiorIndex(0.5)]!.tip3;
    const root = tilted[bandIndex(0.5)]!.origin3;
    for (const point of [entry, wall, root]) {
      expect(Math.abs(sd3(...toBody(point)))).toBeLessThan(2e-3);
    }
    // The swivel is real: the entry moved by a visible amount, not a rounding
    // (measured 0.018 world at yaw 0.25 / nod 0.1 — much of the yaw hides in the
    // camera axis at this aim; the floor is an order above f32 march noise).
    const moved = Math.hypot(
      entry[0] - flat[0]!.tip3[0],
      entry[1] - flat[0]!.tip3[1],
      entry[2] - flat[0]!.tip3[2],
    );
    expect(moved).toBeGreaterThan(0.01);
  }, 300_000);

  /**
   * T940 — THE DUST CATCHES THE BEAM, and only the beam: motes near the traced shaft
   * glow an order of magnitude above the ambient floor, the cloud's median stays AT the
   * floor (a lit room would fail this), and moving the lamp moves WHICH motes glow —
   * the scatter belongs to the beam's own path, not to a hidden light.
   */
  it("lights the dust from the beam's own path (T940)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const DUST = 650;
    const tintsAt = async (px: number): Promise<Float32Array> => {
      const graph = traceGraph({ value1: 0.3, value2: 0.03, value3: px });
      const trace = (graph as { nodes: Record<string, { parameters: Record<string, unknown> }> }).nodes["trace"]!;
      trace.parameters["capacity"] = DUST;
      trace.parameters["kernel"] = PRISM_DUST_KERNEL;
      trace.parameters["attributes"] = JSON.stringify([
        { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
        { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
        { name: "size", type: "f32", default: [1] },
      ]);
      const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(plan);
        backend.render(compiled, {
          frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
        return new Float32Array(await backend.readBuffer("scratch:trace:tint"));
      } finally {
        backend.dispose();
      }
    };

    const reds = (tints: Float32Array): number[] => {
      const out: number[] = [];
      for (let i = 0; i < DUST; i += 1) out.push(tints[i * 4] ?? 0);
      return out.sort((a, b) => a - b);
    };
    const a = reds(await tintsAt(0));
    // Somebody glows: the brightest motes sit in the beam, an order above ambient …
    expect(a[DUST - 1]!).toBeGreaterThan(0.1);
    // … while the cloud's median is the ambient floor: the room itself is dark.
    expect(a[Math.floor(DUST / 2)]!).toBeLessThan(0.01);

    // Move the lamp a third of the arc: a real population still glows (WHICH motes glow
    // is the beam's business; that it moved is implied by the trace gates above).
    const b = reds(await tintsAt(0.33));
    expect(b[DUST - 1]!).toBeGreaterThan(0.1);
  }, 300_000);

  /**
   * T929 — NO TELEPORT: the owner's "the beam teleports at certain angles", written as
   * a sweep. The lamp walks a third of its arc in small steps; between adjacent steps
   * the marched ENTRY moves continuously (it crosses vertices smoothly — the body is
   * one closed boundary), and the centre band's EXIT origin moves continuously EXCEPT
   * where its exit face legitimately switches (TIR onset); each switch must coincide
   * with near-critical incidence computed from the mapping — a jump anywhere else is
   * the bug this gate exists to catch.
   */
  it("sweeps the lamp without teleporting (T929)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085;
    const STEPS = 24;
    const py = 0.142;
    let prevEntry: readonly [number, number] | null = null;
    let prevExit: readonly [number, number] | null = null;
    for (let i = 0; i <= STEPS; i += 1) {
      const px = 0.0 + (0.213 * i) / STEPS; // NL entries into the NL->NR vertex crossing
      const aim = aimOf(px, py);
      if (aim.face === null) continue;
      const segments = await runTrace({ value1: py, value2: dispersion, value3: px });
      const entry = segments[0]!.tip;
      const exit = segments[segIndex(30)]!;
      if (prevEntry !== null) {
        const step = Math.hypot(entry[0] - prevEntry[0], entry[1] - prevEntry[1]);
        expect(step).toBeLessThan(0.35); // continuous walk, no entry teleport
      }
      if (prevExit !== null && length(exit) > 1e-3) {
        const jump = Math.hypot(exit.origin[0] - prevExit[0], exit.origin[1] - prevExit[1]);
        if (jump > 0.35) {
          // The only licensed jump: the exit face switched because this step crossed
          // the critical angle. Prove it from the mapping, in float64.
          const n = bandN(0.5, dispersion);
          const margin = Math.abs(n * Math.sin(APEX - Math.asin(Math.sin(aim.thetaI) / n)) - 1);
          expect(margin).toBeLessThan(0.08);
        }
      }
      prevEntry = entry;
      if (length(exit) > 1e-3) prevExit = exit.origin;
    }
  }, 600_000);
});
