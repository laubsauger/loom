import { describe, expect, it } from "vitest";
import { listExamples } from "../catalogue.ts";
import { requireExample } from "../runner.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * E52 Presence — the document half of T1029's claims. The mask's own behaviour is
 * gated where it can actually run: the door against real Apple Vision
 * (vision-host.test.ts), the pump to exact bytes (use-vision-bridge.test.ts). What
 * lives HERE is the wiring the example exists to demonstrate — and the wiring is
 * exactly what a plausible-looking document can get wrong silently.
 */
describe("E52 Presence", () => {
  const file = listExamples().find((entry) => entry.fileName === "E52-Presence.loom.json");
  if (file === undefined) throw new Error("E52-Presence.loom.json is not shipped");
  const { plan, document } = requireExample(file);

  it("compiles clean, with the personMask's two-pass seam shape and a float mask resource", () => {
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const ids = plan.passes.map((pass) => pass.id);
    expect(ids.some((id) => id.includes("mask:preprocess"))).toBe(true);
    expect(ids.some((id) => id.includes("mask:result"))).toBe(true);
    // The mask is a MEASUREMENT: float, single channel, external (CPU-fed) — the
    // Matte node's reasoning inherited, and the property a plausible rgba8 copy of
    // this document would silently lose.
    const external = plan.resources.find(
      (resource) => resource.kind === "externalTexture" && resource.id.includes("mask"),
    );
    expect(external).toBeDefined();
    expect((external as { format?: string }).format).toBe("r32float");
  });

  it("the key multiplies the SOURCE by ITS OWN mask — same switch, never a stale branch", () => {
    // Both of key1's inputs trace to src1's output family: the picture being keyed and
    // the picture the mask was cut FROM are the same switch. Wiring the mask to the
    // understudy while keying the webcam (or vice versa) compiles fine and cuts the
    // wrong person — §V655's crossed-pair family, pinned here like E47 pins its carve.
    const key = plan.passes.find(
      (pass): pass is EffectPassDescriptor => pass.kind === "effect" && pass.nodeId === "key",
    );
    expect(key).toBeDefined();
    const bound = key?.textures?.map((texture) => texture.resourceId) ?? [];
    expect(bound).toContain("target:src:out");
    expect(bound.some((id) => id.includes("mask"))).toBe(true);
  });

  it("the mask sees the switched source through the preprocess — the mirror follows the flip", () => {
    const preprocess = plan.passes.find(
      (pass): pass is DispatchPassDescriptor =>
        pass.kind === "dispatch" && pass.id.includes("mask:preprocess"),
    );
    expect(
      preprocess?.textures?.some((texture) => texture.resourceId === "target:src:out"),
    ).toBe(true);
  });

  it("coverage drives the wash's LIGHT: §V856's scalar is wired, not just published", () => {
    /* The saturation slot is an EXPRESSION over mask1's coverage channel. The channel
       itself exists only in a live session (the seam publishes it; headless has no
       pump), so a render-diff on the cut edge cannot run here — what CAN be pinned is
       that the document actually spends the scalar: delete this slot and the example's
       whole "the room knows" claim silently becomes decoration. */
    const wash = document.graph.nodes["wash"];
    const slot = wash?.parameters["brightness"] as
      | { mode?: string; bindings?: { expression?: { source?: string } } }
      | undefined;
    expect(slot?.mode).toBe("expression");
    expect(slot?.bindings?.expression?.source).toContain("mask1");
    expect(slot?.bindings?.expression?.source).toContain("coverage");
  });

  it("ships on the deterministic understudy — a webcam cannot gate headlessly (§T715)", () => {
    const src = document.graph.nodes["src"];
    expect((src?.parameters["index"] as { value?: unknown } | number | undefined)).toBeDefined();
    const stored = src?.parameters["index"];
    const value = typeof stored === "number" ? stored : (stored as { value?: unknown })?.value;
    expect(value ?? 0).toBe(0);
  });
});
