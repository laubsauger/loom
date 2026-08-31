import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

function e14() {
  const file = listExamples().find((entry) => entry.fileName === "E14-Self-Regulating-Bloom.loom.json");
  if (file === undefined) throw new Error("E14-Self-Regulating-Bloom.loom.json is not shipped");
  return requireExample(file);
}

/**
 * T408 — E14 REGULATES, ON DAWN, THROUGH THE SHIPPED FILE.
 *
 * The structural claims live in concepts.test.ts; this is the behavioural one, and it
 * only became possible with T655 (the harness analyze seam): before it, a document
 * that measures itself rendered FROZEN in every offline gate. The trajectory below is
 * the md's own opening numbers — alternating overshoot decaying toward a settled band
 * — asserted from pixels, not believed from the tuning notes.
 */

function f16(bits: number): number {
  const sign = bits >> 15 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * frac * Math.pow(2, -24);
  if (exp === 31) return frac === 0 ? sign * Infinity : NaN;
  return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
}

/** Mean linear luminance of a display-encoded rgba16float frame — what `meter1` sees. */
function meterOf(frame: { bytes: Uint8Array }): number {
  const half = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.length / 2);
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  let sum = 0;
  for (let i = 0; i < half.length; i += 4) {
    sum += 0.2126 * lin(f16(half[i] ?? 0)) + 0.7152 * lin(f16(half[i + 1] ?? 0)) + 0.0722 * lin(f16(half[i + 2] ?? 0));
  }
  return sum / (half.length / 4);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E14 — the loop settles with damped overshoot (T408, §V144)", () => {
  it("rings on open, decays, and holds the measured band", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { document } = e14();
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: document.graph,
      settings: document.settings,
      frames: 26,
      capture: [0, 1, 2, 3, 25],
      animate: true,
      outputNodeId: "out",
    });
    const [m0, m1, m2, m3, settled] = result.frames.map(meterOf) as [number, number, number, number, number];

    // Frame 0 is the fallback picture; the first correction OVERSHOOTS below it and
    // the next swings back above — the alternation is the one-frame delay (§V144)
    // wearing the loop gain, and a loop that fails to close renders these equal-ish
    // and monotone instead.
    expect(m1).toBeLessThan(m0);
    expect(m2).toBeGreaterThan(m1);
    expect(m3).toBeLessThan(m2);
    // Decay: the second swing is smaller than the first (the ratio IS the loop gain).
    expect(Math.abs(m2 - m1)).toBeLessThan(Math.abs(m1 - m0));

    // The settled band, measured at build time: ~0.203 at 1280×720 (the P-residual
    // above the 0.18 setpoint — a proportional controller leans on its error). Wide
    // enough for the sway's slow breathing, far too narrow for the unregulated swing.
    expect(settled).toBeGreaterThan(0.18);
    expect(settled).toBeLessThan(0.23);
  }, 240_000);

  /**
   * §V616/§B124, REPRODUCED ON PURPOSE — the wrap flips the sign. The shipped floor
   * (0.005) is gated structurally in concepts.test.ts; this is the picture of what
   * that floor is holding back. Lower the floor past zero and strengthen the tap to
   * where the shipped error can reach it, and the ramp wraps the background into its
   * white stops: the meter locks high and STAYS — a correct local loop gain and a
   * saturated white frame at the same time, which is exactly what the linearised
   * stability argument cannot see.
   */
  it("without the phase floor, the wrap runs away to white (§V616)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { document } = e14();
    const broken = structuredClone(document) as typeof document;
    const nodes = broken.graph.nodes as Record<string, { parameters: Record<string, unknown> }>;
    nodes["swirlclamp"]!.parameters["minimum"] = -0.4;
    nodes["swirl"]!.parameters["operand"] = 3;
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: broken.graph,
      settings: broken.settings,
      frames: 22,
      capture: [21],
      animate: true,
      outputNodeId: "out",
    });
    // The shipped file settles near 0.2 (the test above). The unfloored copy locks
    // bright — §V461 both ways: the gate can tell the guarded picture from the
    // runaway, so deleting the floor cannot pass as a tidy-up.
    expect(meterOf(result.frames[0]!)).toBeGreaterThan(0.6);
  }, 240_000);

  /**
   * THE RAILS HOLD AT THE STABILITY BOUNDARY (§V461 at the saturating case — at the
   * operating point the clamp passes deleted, and it is NOT exercised by the shipped
   * sway either: measured at the trough, the gain settles near 1.28, inside the
   * rails). Its load-bearing case is the knob the md invites the reader to turn:
   * `push` past the boundary makes the loop pulse, and the rails are what bound the
   * pulse. Same unstable K, rails on and off — the difference is the clamp, from
   * pixels, and it is what makes the instability survivable to look at.
   */
  it("the gain rails bound the pulse past the stability boundary", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const { document } = e14();
    const unstable = (rails: { minimum: number; maximum: number }) => {
      const copy = structuredClone(document) as typeof document;
      const nodes = copy.graph.nodes as Record<string, { parameters: Record<string, unknown> }>;
      nodes["push"]!.parameters["operand"] = 8;
      nodes["clampg"]!.parameters["minimum"] = rails.minimum;
      nodes["clampg"]!.parameters["maximum"] = rails.maximum;
      return renderHeadless({
        host: nodeGpuHost(),
        graph: copy.graph,
        settings: copy.settings,
        frames: 40,
        capture: [12, 13, 14, 15, 16, 17, 18, 19],
        animate: true,
        outputNodeId: "out",
      });
    };
    const [railed, open] = await Promise.all([
      unstable({ minimum: 0.8, maximum: 1.8 }),
      unstable({ minimum: 0.01, maximum: 12 }),
    ]);
    const swing = (frames: ReadonlyArray<{ bytes: Uint8Array }>) => {
      const meters = frames.map(meterOf);
      return Math.max(...meters) - Math.min(...meters);
    };
    // Both pulse — the instability is real either way…
    expect(swing(railed.frames)).toBeGreaterThan(0.05);
    // …but the shipped rails bound it to a fraction of the unrailed slam (measured
    // ≈0.3 against ≈0.67 peak-to-peak at build time).
    expect(swing(open.frames)).toBeGreaterThan(swing(railed.frames) * 1.5);
  }, 240_000);
});
