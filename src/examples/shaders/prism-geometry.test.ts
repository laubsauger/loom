import { describe, expect, it } from "vitest";
import { PRISM_EDGE, PRISM_HALF, PRISM_RHO, PRISM_RI, meshPoint, sd2, sd3 } from "./prism-geometry.ts";

/**
 * T937 / §V818 — THE MESH AND THE TRACE ARE ONE SHAPE, gated rather than promised.
 *
 * The trace marches sd3; the mesh walks meshPoint. If either half changes without the
 * other — a deepened body, a different bevel, a re-profiled cap — every vertex stops
 * satisfying the other's equation and this file refuses. This is the gate the T920 bevel
 * story earned: "the trace didn't know about geometry the mesh had" must not recur with
 * a third dimension to hide in.
 */
describe("the prism's mesh lies ON the traced SDF (T937, §V818)", () => {
  it("every sampled mesh vertex satisfies |sd3| < 1e-6", () => {
    let worst = 0;
    for (let iu = 0; iu < 240; iu += 1) {
      for (let ia = 0; ia <= 45; ia += 1) {
        const a = ia / 45;
        const [x, y, z] = meshPoint(iu / 240, a);
        // The cap DISC (a near 0 or 1) is interior surface for the SDF only at its rim;
        // across the disc sd3 measures distance to the cap plane, which is 0 there too.
        const sd = sd3(x, y, z);
        worst = Math.max(worst, Math.abs(sd));
        expect(Math.abs(sd)).toBeLessThan(1e-6);
      }
    }
    expect(worst).toBeGreaterThanOrEqual(0); // keep `worst` observable under --reporter
  });

  it("the z = 0 slice of sd3 IS the 2D cross-section the T920 gates march", () => {
    // Anywhere away from the cap rounds, the extrusion's mid-slice must equal sd2 exactly
    // — this is what keeps the whole planar gate suite valid across the dimension lift.
    for (let i = 0; i < 500; i += 1) {
      const x = -1.2 + 2.4 * ((i * 79) % 500) / 500;
      const y = -1.2 + 2.4 * ((i * 131) % 500) / 500;
      const flat = sd2(x, y);
      if (flat > -PRISM_EDGE + 1e-9 && flat < 0.5) {
        expect(sd3(x, y, 0)).toBeCloseTo(flat, 12);
      }
    }
  });

  it("pins the shared numbers the two kernels template from", () => {
    expect(PRISM_RI).toBeCloseTo(0.38, 12);
    expect(PRISM_RHO).toBe(0.046);
    expect(PRISM_HALF).toBe(0.72);
    expect(PRISM_EDGE).toBe(0.12);
  });
});
