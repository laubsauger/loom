import { describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { prismTraceKernel } from "./shaders/prism-trace.wgsl.ts";

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
 * ## T857 — the two channels the pointer drives, and what they re-cut here
 *
 * `value4` used to be an entry-point offset and is now the pointer's AUTHORITY: the
 * kernel mixes the swing's aim with the pointer's by `clamp(400·value4, 0, 1)`, so
 * `value4: 0` is the swing's picture EXACTLY and the first two cases below are unmoved,
 * numbers and all. `value3` is the pointer's own aim, on a wider scale (84° → 6°) that
 * also walks the entry point along the face — and PAST it, which is the state the owner
 * asked for and the third and fourth cases now gate.
 *
 * That widening does not weaken a single Snell claim; it hands them more domain. The
 * old range could not reach total internal reflection at the shipped dispersive power at
 * all (the last case measures that both ways), and it could not reach an entry point
 * off the face, so "the beam misses" had no gate because it had no expression.
 */

const CAPACITY = 65; // shaft + ghost + internal + TIR leg + 61 bands
const RI = 0.38; // E13's PRISM_RC / 2, pinned as the same literal E13 interpolates
const NR: readonly [number, number] = [Math.sqrt(3) / 2, 0.5];
const NL: readonly [number, number] = [-Math.sqrt(3) / 2, 0.5];
const ND: readonly [number, number] = [0, -1];
const APEX = Math.PI / 3; // 60° between the refracting faces
const N_RED = 1.5;
const THETA_LO = (37 * Math.PI) / 180;
const THETA_HI = (62 * Math.PI) / 180;
/* T857 — the POINTER's own scale, and the reach that walks the entry point. Pinned here
   as the kernel's own literals, exactly as RI is: a gate that derived them from the
   kernel text could not notice the kernel changing them. */
const HAND_LO = (6 * Math.PI) / 180;
const HAND_HI = (84 * Math.PI) / 180;
const REACH = 1.6;
const ENTRY = -0.28;
/** An equilateral cross-section's half side, from the inradius the mesh shares. */
const HALF_FACE = RI * Math.sqrt(3);
/** The face tangent τ is measured along — positive toward the APEX. */
const TANGENT: readonly [number, number] = [-NR[1], NR[0]];

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
  readonly value1: number;
  readonly value2: number;
  /** T857: the pointer's aim, 0 → 84°, 1 → 6°, and the entry walk with it. */
  readonly value3?: number;
  /** T857: the pointer's authority, before the kernel's ×400 gain. */
  readonly value4: number;
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
            value4: values.value4,
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

const thetaOf = (aim: number): number => THETA_HI + (THETA_LO - THETA_HI) * aim;
/** T857 — the pointer's own scale, at full authority. */
const handThetaOf = (px: number): number => HAND_HI + (HAND_LO - HAND_HI) * px;
/** T857 — where on the face the pointer puts the entry, at full authority. */
const handTauOf = (px: number): number => REACH * (0.5 - px);
/** The entry point's coordinate ALONG the face, from the face's own midpoint. */
const tauOf = (point: readonly [number, number]): number =>
  (point[0] - NR[0] * RI) * TANGENT[0] + (point[1] - NR[1] * RI) * TANGENT[1];
/** T913: the kernel's Cauchy curve, mirrored exactly — n(λ)=A+B/λ², λ 0.7µm → 0.4µm,
 * B derived so `dispersion` stays the total spread across the band. */
const bandN = (t: number, dispersion: number): number => {
  const lam = 0.7 + (0.4 - 0.7) * t;
  const invRed = 1 / (0.7 * 0.7);
  const k = 1 / (0.4 * 0.4) - invRed;
  return N_RED + (dispersion / k) * (1 / (lam * lam) - invRed);
};
const bandIndex = (t: number): number => 4 + Math.round(t * (CAPACITY - 5));
/** Inside the cross-section: every face plane satisfied, with a hair of slack. */
const insideGlass = (point: readonly [number, number]): boolean =>
  [NR, NL, ND].every((n) => dot(point, n) <= RI - 1e-4);

describe("the prism is a traced ray (T718, §V683)", () => {
  it("entry and exit angles follow scalar Snell across the aim sweep, and the fan opens at steep incidence", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085; // E13's shipped dispersive power
    const spreads: number[] = [];
    for (const aim of [0, 0.5, 1]) {
      const segments = await runTrace({ value1: aim, value2: dispersion, value4: 0 });
      const thetaI = thetaOf(aim);

      // THE INTERNAL SEGMENT (slot 2): its refracted angle against the entry face is
      // asin(sin θi / n) — the first Snell, measured from geometry the GPU wrote.
      const internal = segments[2]!;
      expect(length(internal)).toBeGreaterThan(0.05);
      const nMid = bandN(0.5, dispersion);
      expect(faceAngle(direction(internal), NR)).toBeCloseTo(Math.asin(Math.sin(thetaI) / nMid), 3);

      // CONTINUITY — the owner's structural complaint. The shaft ENDS where the
      // internal segment BEGINS, which is where the incoming ray meets the face.
      const shaft = segments[0]!;
      expect(internal.origin[0]).toBeCloseTo(shaft.tip[0], 5);
      expect(internal.origin[1]).toBeCloseTo(shaft.tip[1], 5);
      // And the central band's exit sits at the internal segment's far end — one
      // connected path, entry to fan, at the shared wavelength.
      const central = segments[bandIndex(0.5)]!;
      expect(central.origin[0]).toBeCloseTo(internal.tip[0], 4);
      expect(central.origin[1]).toBeCloseTo(internal.tip[1], 4);

      // EXIT SNELL, per wavelength, against the exit face's own normal: the second
      // refraction is where dispersion is large (T710's finding), and each band's
      // angle must land on θe = asin(n · sin(60° − θr)) — the textbook, in float64.
      for (const t of [0, 0.5, 1]) {
        const n = bandN(t, dispersion);
        const thetaR = Math.asin(Math.sin(thetaI) / n);
        const theta2 = APEX - thetaR;
        expect(n * Math.sin(theta2)).toBeLessThan(1); // no TIR anywhere in the shipped range
        const thetaE = Math.asin(n * Math.sin(theta2));
        const band = segments[bandIndex(t)]!;
        expect(length(band)).toBeGreaterThan(0.5);
        expect(faceAngle(direction(band), NL)).toBeCloseTo(thetaE, 3);
        // The band leaves through the EXIT FACE: its origin lies on dot(p, NL) = RI.
        expect(dot(band.origin, NL)).toBeCloseTo(RI, 3);
      }

      // No TIR at the central wavelength here, so the TIR leg (slot 3) is zero-length.
      expect(length(segments[3]!)).toBeLessThan(1e-4);

      const spread =
        faceAngle(direction(segments[bandIndex(1)]!), NL) - faceAngle(direction(segments[bandIndex(0)]!), NL);
      spreads.push(spread);
    }
    // The fan WIDENS as the exit-face incidence climbs toward critical — T710's
    // 46 → 108px, asserted here as exit-angle spread growing monotonically with aim.
    expect(spreads[1]!).toBeGreaterThan(spreads[0]!);
    expect(spreads[2]!).toBeGreaterThan(spreads[1]!);
    // And it matches the analytic spread, not merely the trend.
    const analyticSpread = (aim: number): number => {
      const thetaI = thetaOf(aim);
      const exitOf = (t: number): number => {
        const n = bandN(t, dispersion);
        return Math.asin(n * Math.sin(APEX - Math.asin(Math.sin(thetaI) / n)));
      };
      return exitOf(1) - exitOf(0);
    };
    expect(spreads[2]!).toBeCloseTo(analyticSpread(1), 3);
  }, 240_000);

  it("total internal reflection leaves through the BASE, and Snell holds there too", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // aim 1 (θi = 37°) with a wide dispersive power: the violet end reaches
    // n · sin(60° − θr) > 1 — total internal reflection at the exit face. The band
    // must not vanish: it reflects, crosses the body, and leaves through the base.
    const dispersion = 0.3;
    const segments = await runTrace({ value1: 1, value2: dispersion, value4: 0 });
    const thetaI = thetaOf(1);

    const nViolet = bandN(1, dispersion);
    const thetaR = Math.asin(Math.sin(thetaI) / nViolet);
    const theta2 = APEX - thetaR;
    expect(nViolet * Math.sin(theta2)).toBeGreaterThan(1); // the domain says TIR

    const violet = segments[bandIndex(1)]!;
    // Through the BASE: the origin lies on dot(p, ND) = RI, not on the exit face.
    expect(dot(violet.origin, ND)).toBeCloseTo(RI, 3);
    expect(dot(violet.origin, NL)).toBeLessThan(RI - 1e-3);
    expect(length(violet)).toBeGreaterThan(0.5);
    // Snell at the base: the faces of an equilateral prism ALL meet at 60°, so the
    // incidence after a mirror bounce off the exit face is |60° − θ₂| against the
    // base normal, and the emitted angle must be its refraction — the same scalar
    // law, third application. (Getting this wrong the first time — 120°, the angle
    // between NORMALS — is §V683 in miniature: the GPU trace was right and the
    // test's own bookkeeping was the bug, caught because the assertion refused.)
    const thetaBase = Math.abs(APEX - theta2);
    expect(nViolet * Math.sin(thetaBase)).toBeLessThan(1);
    expect(faceAngle(direction(violet), ND)).toBeCloseTo(Math.asin(nViolet * Math.sin(thetaBase)), 3);

    // The RED end still exits the exit face in the same frame — one prism, two faces
    // in use at once, which no authored fan can express.
    const red = segments[bandIndex(0)]!;
    expect(dot(red.origin, NL)).toBeCloseTo(RI, 3);
  }, 240_000);

  /**
   * T857 — THE HAND WALKS THE ENTRY POINT UP THE FACE, and everything downstream
   * follows. This is the owner's own acceptance criterion for T718 ("at the very tippi
   * top it behaves different as at the bottom"), now driven by the control a viewer
   * actually has rather than by a test-only offset channel.
   *
   * Two claims that a plausible-looking picture would fail separately: the entry point
   * lands where the pointer's own arithmetic says it lands — ON the face plane, at
   * τ = 1.6·(0.5 − value3) along it — and the internal segment collapses as the faces
   * converge toward the apex, while the path stays CONNECTED end to end.
   *
   * Measured at this commit: τ 0 → 0.56 of a 0.658 half-face, and the internal segment
   * 0.678 → 0.091, a thirteenth of its length. The old value4-as-offset case measured
   * a fifth; the pointer reaches further up the face than the gate ever drove it.
   */
  it("walks the entry point to the apex on the pointer's own aim, and the path follows", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085;
    const nMid = bandN(0.5, dispersion);
    const at = async (px: number): Promise<Segment[]> =>
      runTrace({ value1: 0.5, value2: dispersion, value3: px, value4: 1 });

    // Mid-travel puts the entry at the face's own midpoint; a fifth of the way along
    // puts it 0.56 up a 0.658 half-face, a hair short of the apex.
    const middle = await at(0.5);
    const apex = await at(0.15);

    for (const [px, segments] of [
      [0.5, middle],
      [0.15, apex],
    ] as const) {
      const entry = segments[0]!.tip;
      // ON the entry face's plane, at the tangential coordinate the pointer names.
      expect(dot(entry, NR)).toBeCloseTo(RI, 4);
      expect(tauOf(entry)).toBeCloseTo(handTauOf(px), 3);
      // And Snell still governs the first refraction at that new entry.
      const internal = segments[2]!;
      expect(faceAngle(direction(internal), NR)).toBeCloseTo(
        Math.asin(Math.sin(handThetaOf(px)) / nMid),
        3,
      );
      // Connected: shaft tip = internal origin, internal tip = the central band's exit.
      expect(internal.origin[0]).toBeCloseTo(entry[0], 5);
      const central = segments[bandIndex(0.5)]!;
      expect(central.origin[0]).toBeCloseTo(internal.tip[0], 4);
      expect(central.origin[1]).toBeCloseTo(internal.tip[1], 4);
      expect(length(central)).toBeGreaterThan(0.5);
    }

    // The faces converge at the apex, so the crossing collapses — by far more than the
    // fifth the old offset channel could reach, and still a real segment.
    expect(length(apex[2]!)).toBeLessThan(length(middle[2]!) * 0.25);
    expect(length(apex[2]!)).toBeGreaterThan(0.02);

    // The swing, at ANY aim, never leaves E13's shipped entry — this is the half that
    // says the walk belongs to the pointer and not to the LFO (§V361: cut the edge and
    // this is what differs).
    for (const aim of [0, 1]) {
      const swing = await runTrace({ value1: aim, value2: dispersion, value3: 0.15, value4: 0 });
      expect(tauOf(swing[0]!.tip)).toBeCloseTo(ENTRY, 4);
    }
  }, 300_000);

  /**
   * T857 — PAST THE VERTEX THE BEAM MISSES THE GLASS, and that is a STATE rather than a
   * failure. The owner asked for it by name: "we cant test all the extremes or even miss
   * the glass triangle."
   *
   * The refracting face is a SEGMENT — half-length RI·√3 = 0.658 from its midpoint — and
   * the pointer's reach runs to ±0.8, so the outer ninth of the travel at each end puts
   * the entry off the face. What the kernel must then draw is a beam GOING BY: the shaft
   * carries straight on (2.10 + 2.60 long instead of 2.10) and every other slot collapses
   * to zero length, which the beam shader renders as zero area (T680).
   *
   * The miss is asserted against the DOMAIN and not against the kernel's own flag: fifty
   * samples along the drawn shaft, none of them inside the cross-section's three face
   * planes. A ray that sneaked in through the base would fail that even with a zero fan.
   *
   * RED-VERIFIED against the corruption it is for: deleting the `onFace` select on the
   * band slot puts the fan back — 61 segments of length 2.25 hanging off a face the ray
   * never touched, which is exactly the artefact the widening could have shipped.
   */
  it("misses the glass past either vertex — the fan collapses and the shaft carries on", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085;
    const at = async (px: number): Promise<Segment[]> =>
      runTrace({ value1: 0.5, value2: dispersion, value3: px, value4: 1 });

    // Just INSIDE the apex vertex: everything is alive, so the two cases below are a
    // boundary and not a blanket.
    const grazing = await at(0.1);
    expect(Math.abs(handTauOf(0.1))).toBeLessThan(HALF_FACE);
    expect(length(grazing[bandIndex(0.5)]!)).toBeGreaterThan(0.5);
    expect(length(grazing[2]!)).toBeGreaterThan(0.005);

    for (const px of [0.05, 0.95]) {
      const tau = handTauOf(px);
      expect(Math.abs(tau)).toBeGreaterThan(HALF_FACE); // the domain says: off the face
      const segments = await at(px);

      // Nothing refracts. Ghost, internal segment, TIR leg and all 61 bands are points.
      for (const index of [1, 2, 3]) expect(length(segments[index]!)).toBeLessThan(1e-4);
      for (const t of [0, 0.5, 1]) expect(length(segments[bandIndex(t)]!)).toBeLessThan(1e-4);

      // The shaft goes THROUGH instead of stopping: 2.10 behind the plane, 2.60 past it.
      const shaft = segments[0]!;
      expect(length(shaft)).toBeCloseTo(4.7, 3);
      // And it really does miss: no sample of the drawn segment is inside the glass.
      const d = direction(shaft);
      for (let step = 0; step <= 50; step += 1) {
        const s = (step / 50) * length(shaft);
        expect(insideGlass([shaft.origin[0] + d[0] * s, shaft.origin[1] + d[1] * s])).toBe(false);
      }
    }
  }, 300_000);

  /**
   * T857 — THE HAND REACHES TOTAL INTERNAL REFLECTION AT THE SHIPPED DISPERSIVE POWER,
   * which the swing's own range cannot do at any aim. Both numbers, per §V751: the
   * widening is measured by what it newly reaches, not asserted.
   *
   * The TIR case above buys its TIR with a dispersion of 0.3 — three and a half times
   * what E13 ships — because at 0.085 the violet end's onset sits at θ1 = 34.5°, below
   * the swing's floor of 37°. The pointer runs to 6°, so the whole spectrum crosses the
   * onset, and there are TWO regimes on the way, gated here in order:
   *
   *   px 0.68 (θ1 = 31.0°) — THE SPECTRUM SPLITS. The red end still exits the exit face
   *     at 74.4°; the violet end is past its critical angle there, reflects, and leaves
   *     through the BASE. Two faces in use in one frame, at the shipped dispersion.
   *   px 0.80 (θ1 = 21.6°) — the entry has walked low enough that the internal ray meets
   *     the BASE first, at APEX + θr = 73.8°, past critical for every band: the mirror is
   *     the base now and the exit is the left face.
   *
   * And the second regime carries a fact worth asserting because nothing could satisfy it
   * by accident: after a total internal reflection this cross-section hands every
   * wavelength back at EXACTLY θ1 — the second incidence is |inc − 60°| = θr for every n,
   * so `asin(n·sin θr) = θ1` identically. The fan does not widen there, it becomes a SHEET
   * of parallel rays separated by their exit points rather than their angles.
   */
  it("reaches TIR on the pointer's range at E13's own dispersion, where the swing cannot", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const dispersion = 0.085; // E13's shipped power, not a gate-only exaggeration
    const thetaR = (thetaI: number, n: number): number => Math.asin(Math.sin(thetaI) / n);
    /** Trapped at the EXIT FACE, where the internal ray meets it at APEX − θr. */
    const trapped = (thetaI: number, n: number): boolean =>
      n * Math.sin(APEX - thetaR(thetaI, n)) > 1;

    // The swing's whole range, at both ends and the middle: no band anywhere near TIR.
    for (const aim of [0, 0.5, 1]) {
      for (const t of [0, 0.5, 1]) expect(trapped(thetaOf(aim), bandN(t, dispersion))).toBe(false);
    }

    // ---- the SPLIT: red out the exit face, violet out the base, one frame -------------
    const splitPx = 0.68;
    const splitTheta = handThetaOf(splitPx);
    expect(Math.abs(handTauOf(splitPx))).toBeLessThan(HALF_FACE); // still on the glass
    expect(trapped(splitTheta, bandN(0, dispersion))).toBe(false); // red is not
    expect(trapped(splitTheta, bandN(1, dispersion))).toBe(true); //  violet is
    const split = await runTrace({ value1: 0.5, value2: dispersion, value3: splitPx, value4: 1 });

    const red = split[bandIndex(0)]!;
    const nRed = bandN(0, dispersion);
    expect(dot(red.origin, NL)).toBeCloseTo(RI, 3);
    expect(faceAngle(direction(red), NL)).toBeCloseTo(
      Math.asin(nRed * Math.sin(APEX - thetaR(splitTheta, nRed))),
      3,
    );

    const violet = split[bandIndex(1)]!;
    expect(dot(violet.origin, ND)).toBeCloseTo(RI, 3);
    expect(dot(violet.origin, NL)).toBeLessThan(RI - 1e-3);
    expect(length(violet)).toBeGreaterThan(0.5);
    // The base incidence after the mirror is |(APEX − θr) − APEX| = θr, so the exit angle
    // is asin(n·sin θr) — which is θ1 itself, the identity noted above.
    expect(faceAngle(direction(violet), ND)).toBeCloseTo(splitTheta, 3);

    // ---- the BASE-FIRST regime: the mirror is the base, the exit is the left face -----
    const basePx = 0.8;
    const baseTheta = handThetaOf(basePx);
    const segments = await runTrace({ value1: 0.5, value2: dispersion, value3: basePx, value4: 1 });
    for (const t of [0, 0.5, 1]) {
      const n = bandN(t, dispersion);
      // The domain: the internal ray meets the BASE at APEX + θr, past critical for all.
      expect(n * Math.sin(APEX + thetaR(baseTheta, n))).toBeGreaterThan(1);
      const band = segments[bandIndex(t)]!;
      expect(dot(band.origin, NL)).toBeCloseTo(RI, 3);
      expect(length(band)).toBeGreaterThan(0.5);
      // Every wavelength leaves at exactly θ1 — a sheet, not a fan.
      expect(faceAngle(direction(band), NL)).toBeCloseTo(baseTheta, 3);
    }
    // The reflected leg inside the body is DRAWN, which is what makes TIR a path here.
    expect(length(segments[3]!)).toBeGreaterThan(0.02);
  }, 300_000);
});
