import { describe, expect, it } from "vitest";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { example } from "./helpers.ts";

describe("E8 Slit Scan", () => {
  const { plan } = example("E8-Slit-Scan.loom.json");

  /**
   * T321's claim: per-pixel time needs the WHOLE history as one binding. If the scan
   * pass ever degrades to a fixed tap — one moment for every pixel — this example
   * still renders and stops being a slit-scan.
   */
  it("binds the ring as a whole-array texture, not a fixed tap", () => {
    const scan = plan.passes.find(
      (pass) => pass.kind === "effect" && pass.id.endsWith(":scan"),
    ) as EffectPassDescriptor;
    const history = scan.textures?.find((binding) => binding.binding === "history");
    expect(history?.array).toBe(true);
    expect(history?.tap).toBeUndefined();
  });

  /**
   * §V228 and the row's own words: 8 frames is a smear, the EFFECT wants depth. A
   * shallow ring here would demonstrate nothing the Cache does not.
   */
  it("carries real temporal depth", () => {
    const ring = plan.resources.find((resource) => resource.kind === "ring") as { frames: number };
    expect(ring.frames).toBe(48);
  });
});
