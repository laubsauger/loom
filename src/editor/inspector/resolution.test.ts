import { describe, expect, it } from "vitest";
import { RESOLUTION_SCALE_PRESETS } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import {
  RESOLUTION_MODE_AUTO,
  RESOLUTION_MODE_CUSTOM,
  RESOLUTION_MODE_OPTIONS,
  formatDiagnosticsFor,
  formatModeKey,
  formatModeOptions,
  formatSourceLabel,
  overrideForFormatMode,
  overrideForResolutionMode,
  resolutionModeKey,
  resolutionSourceLabel,
  resolvedCommonFor,
} from "./resolution.ts";
import type { InputResolution } from "./resolution.ts";

/**
 * The Common section's promise (T73, §V50, §V51): show the size and format the node
 * will ACTUALLY produce, not the mode that was selected. A user who picks "1/2" is
 * asking about pixels.
 *
 * T1064 CHANGED WHO ANSWERS. This module used to compute the pixels itself, and the
 * tests below used to check that arithmetic against hand-worked cases — which is a
 * perfectly good suite for a function that must not exist. The compiler resolves size and
 * format; the panel reads its answer; the only thing derived here is the source LABEL.
 * So what is asserted now is (a) that the plan's numbers are what comes out, unmodified,
 * (b) that a node with no row says so instead of inventing one, and (c) the labels and
 * the select round-trips, which were always this module's real work.
 */

const inputs: readonly InputResolution[] = [
  { portId: "source", label: "Source", size: { width: 800, height: 600 }, format: "rgba16float" },
  { portId: "mask", label: "Mask", size: { width: 256, height: 256 }, format: "rgba8unorm" },
];

const NODE = "node-1" as NodeId;

const ask = (over: Partial<Parameters<typeof resolvedCommonFor>[0]> = {}) =>
  resolvedCommonFor({
    nodeId: NODE,
    planned: { size: [800, 600], format: "rgba16float" },
    resolution: undefined,
    format: undefined,
    resolutionPolicy: undefined,
    formatPolicy: undefined,
    inputs,
    diagnostics: undefined,
    ...over,
  });

describe("T1064 — the panel reports the plan, and reports nothing when there is no plan", () => {
  /**
   * THE DEFECT, AS THE USER MET IT. The project cap is 4096, the node asks for 4000, and
   * the device can only allocate 2048 — so the compiler resolves 2048 and that is the
   * texture that exists. The old mirror ran the ladder against the PROJECT cap alone and
   * printed 4000: a size no node on that device has ever had.
   *
   * The fixture is 4000 UNDER the 4096 project cap on purpose (§V854): a size over BOTH
   * caps would come out at 2048 either way and the test would pass on the bug.
   */
  it("shows the size the compiler resolved, not the size the override asked for", () => {
    const resolved = ask({
      planned: { size: [2048, 2048], format: "rgba16float" },
      resolution: { mode: "fixed", width: 4000, height: 4000 },
    });
    expect(resolved?.size).toMatchObject({ width: 2048, height: 2048 });
  });

  /**
   * THE OTHER HALF OF THE SAME DEFECT. `withSupport` flipped a boolean while returning
   * the ORIGINAL format, so the panel read "r32float (unsupported)" over a node the plan
   * had already moved to `rgba16float`. Reading the plan makes that unrepresentable: the
   * only format the panel can name is the one the node renders into.
   */
  it("shows the format the plan carries, which is already past the fallback", () => {
    const resolved = ask({
      planned: { size: [800, 600], format: "rgba16float" },
      format: { mode: "fixed", format: "r32float" },
    });
    expect(resolved?.format.format).toBe("rgba16float");
    expect(resolved?.format.source).toBe("fixed");
  });

  /**
   * The state the mirror could not reach. A pruned node, a node inside a component, a
   * document that has not compiled: there is no texture, so there is no size. The mirror
   * always had arithmetic to fall back on and so always printed a number.
   */
  it("returns null when the plan has no row for the node", () => {
    expect(ask({ planned: undefined })).toBeNull();
  });

  /**
   * `clamped` is READ, not re-derived. The compiler already decided the size was over the
   * limit in force and said so by nodeId; computing it again here is how the two halves
   * of this panel disagreed in the first place.
   */
  it("takes `clamped` from the compiler's own diagnostic, for this node only", () => {
    const clamped: RuntimeDiagnostic = {
      severity: "warning",
      code: "compiler/resolution-clamped",
      message: "clamped",
      nodeId: NODE,
    };
    expect(ask({ diagnostics: [clamped] })?.size.clamped).toBe(true);
    expect(ask({ diagnostics: [] })?.size.clamped).toBe(false);
    expect(
      ask({ diagnostics: [{ ...clamped, nodeId: "node-2" as NodeId }] })?.size.clamped,
    ).toBe(false);
  });
});

describe("§V50 — the source label says which level decided, and computes nothing", () => {
  it("names the definition's policy when there is no override", () => {
    expect(resolutionSourceLabel(undefined, { kind: "project" }, inputs)).toBe("node default · project");
    expect(resolutionSourceLabel(undefined, { kind: "fixed", width: 1, height: 1 }, inputs)).toBe(
      "node default · fixed",
    );
    expect(resolutionSourceLabel(undefined, { kind: "inherit", input: "source" }, inputs)).toBe(
      "node default · from Source",
    );
  });

  it("treats {mode:'auto'} exactly like an absent override", () => {
    const policy = { kind: "fixed", width: 640, height: 480 } as const;
    expect(resolutionSourceLabel({ mode: "auto" }, policy, inputs)).toBe(
      resolutionSourceLabel(undefined, policy, inputs),
    );
  });

  it("names the input an override reads from, by its human label", () => {
    expect(resolutionSourceLabel({ mode: "input", input: "mask" }, undefined, inputs)).toBe("from Mask");
    expect(resolutionSourceLabel({ mode: "project" }, undefined, inputs)).toBe("project");
    expect(resolutionSourceLabel({ mode: "fixed", width: 8, height: 8 }, undefined, inputs)).toBe("custom");
  });

  it("uses the TD preset's own name for a scale factor that has one", () => {
    for (const preset of RESOLUTION_SCALE_PRESETS) {
      expect(resolutionSourceLabel({ mode: "scale", factor: preset.factor }, undefined, inputs)).toContain(
        preset.label,
      );
    }
  });

  /**
   * An input with no reported size is not "connected to nothing" — it is "the compiler
   * has not told us". Saying `unresolved` is the honest reading, and it is the one case
   * where the label carries information the numbers beside it cannot.
   */
  it("says the input is unresolved when the plan reported no size for it", () => {
    const dangling: readonly InputResolution[] = [{ portId: "source", label: "Source" }];
    expect(resolutionSourceLabel({ mode: "input" }, undefined, dangling)).toBe("input unresolved");
    expect(formatSourceLabel({ mode: "input" }, undefined, dangling)).toBe("input unresolved");
  });
});

describe("mode ↔ select value", () => {
  it("round-trips every option the select offers", () => {
    for (const option of RESOLUTION_MODE_OPTIONS) {
      const override = overrideForResolutionMode(option.value, { width: 100, height: 50 });
      expect(resolutionModeKey(override ?? undefined)).toBe(option.value);
    }
  });

  it("expresses Auto by CLEARING the override, never by writing {mode:'auto'}", () => {
    // §V50: absent means "follow the definition's policy", including if it changes later.
    expect(overrideForResolutionMode(RESOLUTION_MODE_AUTO, { width: 1, height: 1 })).toBeNull();
    expect(resolutionModeKey(undefined)).toBe(RESOLUTION_MODE_AUTO);
  });

  it("seeds Custom with the size the node already has, so choosing it moves nothing", () => {
    expect(overrideForResolutionMode(RESOLUTION_MODE_CUSTOM, { width: 400, height: 300 })).toEqual({
      mode: "fixed",
      width: 400,
      height: 300,
    });
  });

  it("carries the chosen input port into input and scale modes", () => {
    expect(overrideForResolutionMode("input", { width: 1, height: 1 }, "mask")).toEqual({
      mode: "input",
      input: "mask",
    });
    expect(overrideForResolutionMode("scale:1/4", { width: 1, height: 1 }, "mask")).toEqual({
      mode: "scale",
      factor: 0.25,
      input: "mask",
    });
  });

  it("shows a non-preset scale factor as Custom rather than inventing an option", () => {
    expect(resolutionModeKey({ mode: "scale", factor: 0.37 })).toBe(RESOLUTION_MODE_CUSTOM);
  });
});

describe("§V51 — the format chooser, and the one claim it still makes about support", () => {
  it("names the level that decided the format", () => {
    expect(formatSourceLabel(undefined, { kind: "project" }, inputs)).toBe("node default · project");
    expect(formatSourceLabel(undefined, { kind: "inherit", input: "source" }, inputs)).toBe(
      "node default · from Source",
    );
    expect(formatSourceLabel({ mode: "input", input: "mask" }, undefined, inputs)).toBe("from Mask");
    expect(formatSourceLabel({ mode: "fixed", format: "r32float" }, undefined, inputs)).toBe("fixed");
  });

  /**
   * The chooser is the ONE place a capability report still decides anything: an entry the
   * device cannot allocate is marked before it is picked. What it no longer does is judge
   * the format a node ALREADY HAS — that came out of the plan, past every fallback.
   */
  it("never offers depth as a colour output, and marks unsupported options", () => {
    const options = formatModeOptions(["rgba8unorm"]);
    expect(options.map((option) => option.value)).not.toContain("depth24plus");
    expect(options.find((option) => option.value === "rgba16float")?.label).toContain("unsupported");
  });

  it("clears the override with null for Auto", () => {
    expect(overrideForFormatMode("auto")).toBeNull();
    expect(formatModeKey(undefined)).toBe("auto");
    expect(formatModeKey({ mode: "fixed", format: "rgba16float" })).toBe("rgba16float");
    expect(overrideForFormatMode("rgba16float")).toEqual({ mode: "fixed", format: "rgba16float" });
    // A format that is not selectable (depth, or junk) is refused, not written.
    expect(overrideForFormatMode("depth24plus")).toBeNull();
  });
});

describe("surfacing the compiler's format diagnostics, not re-deriving them", () => {
  const nodeId = "node-1" as NodeId;
  const diagnostics: RuntimeDiagnostic[] = [
    {
      severity: "warning",
      code: "node.format.unsupported",
      message: "r32float is not supported on this device; falling back to rgba16float.",
      nodeId,
      suggestion: "Pick rgba16float explicitly to make the fallback visible in the document.",
    },
    { severity: "error", code: "shader.compile", message: "unrelated", nodeId },
    {
      severity: "warning",
      code: "node.format.unsupported",
      message: "another node's problem",
      nodeId: "node-2" as NodeId,
    },
    { severity: "info", code: "node.format.note", message: "informational", nodeId },
  ];

  it("finds only this node's format problems", () => {
    const found = formatDiagnosticsFor(nodeId, diagnostics);
    expect(found).toHaveLength(1);
    // The fallback the compiler chose is carried through verbatim — the UI never
    // recomputes it, so the two can never disagree (§V51).
    expect(found[0]?.message).toContain("falling back to rgba16float");
  });

  it("is empty when the compiler has not reported anything", () => {
    expect(formatDiagnosticsFor(nodeId, undefined)).toEqual([]);
    expect(formatDiagnosticsFor(nodeId, [])).toEqual([]);
  });
});

/**
 * TD "Fit Resolution" and "Limit Resolution" (§V50). What each does to the pixels is the
 * compiler's business and is asserted in `compiler/resolution.test.ts`; what is left here
 * is that both survive the round trip through the select and seed their box.
 */
describe("fit and limit resolution modes", () => {
  it("round-trips both modes through the select key", () => {
    expect(resolutionModeKey({ mode: "fit", width: 512, height: 512 })).toBe("fit");
    expect(resolutionModeKey({ mode: "limit", width: 512, height: 512 })).toBe("limit");
  });

  it("seeds the box from the current size so switching mode does not move the node", () => {
    const fit = overrideForResolutionMode("fit", { width: 640, height: 360 }, "in");
    expect(fit).toEqual({ mode: "fit", width: 640, height: 360, input: "in" });
  });

  it("offers both in the mode list, after the scale presets", () => {
    const values = RESOLUTION_MODE_OPTIONS.map((o) => o.value);
    expect(values).toContain("fit");
    expect(values).toContain("limit");
    expect(values.indexOf("fit")).toBeGreaterThan(values.indexOf("scale:1/2"));
  });
});
