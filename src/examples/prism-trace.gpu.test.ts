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

function traceGraph(values: { value1: number; value2: number; value4: number }): GraphDocument {
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
            value3: 0,
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

async function runTrace(values: { value1: number; value2: number; value4: number }): Promise<Segment[]> {
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
const bandN = (t: number, dispersion: number): number => N_RED + dispersion * t;
const bandIndex = (t: number): number => 4 + Math.round(t * (CAPACITY - 5));

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

  it("entering near the apex shortens the internal path — the geometry follows the beam", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const low = await runTrace({ value1: 0.5, value2: 0.085, value4: 0 });
    const high = await runTrace({ value1: 0.5, value2: 0.085, value4: 0.5 });
    // Same angle, entry slid toward the apex where the faces converge: the internal
    // segment must SHORTEN, and everything stays connected (§V683's "move the beam
    // and everything downstream follows").
    expect(length(high[2]!)).toBeLessThan(length(low[2]!) * 0.8);
    expect(length(high[2]!)).toBeGreaterThan(0.02);
    const centralHigh = high[bandIndex(0.5)]!;
    expect(centralHigh.origin[0]).toBeCloseTo(high[2]!.tip[0], 4);
    expect(centralHigh.origin[1]).toBeCloseTo(high[2]!.tip[1], 4);
  }, 240_000);
});
