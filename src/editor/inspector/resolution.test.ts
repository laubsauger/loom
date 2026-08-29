import { describe, expect, it } from "vitest";
import type { NodeFormatOverride, NodeResolutionOverride } from "@domain/types/graph.ts";
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
  overrideForFormatMode,
  overrideForResolutionMode,
  resolutionModeKey,
  resolveNodeFormat,
  resolveNodeSize,
} from "./resolution.ts";
import type { FormatContext, InputResolution, ResolutionContext } from "./resolution.ts";

/**
 * The Common section's promise (T73, §V50, §V51): show the size and format the node
 * will ACTUALLY produce, not the mode that was selected. A user who picks "1/2" is
 * asking about pixels.
 */

const inputs: readonly InputResolution[] = [
  { portId: "source", label: "Source", size: { width: 800, height: 600 }, format: "rgba16float" },
  { portId: "mask", label: "Mask", size: { width: 256, height: 256 }, format: "rgba8unorm" },
];

const context: ResolutionContext = { project: { width: 1920, height: 1080 }, inputs };

describe("§V50 — every resolution mode maps to the right pixel size", () => {
  it("follows the definition's policy when there is no override", () => {
    expect(resolveNodeSize(undefined, { kind: "project" }, context)).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(resolveNodeSize(undefined, { kind: "fixed", width: 512, height: 256 }, context)).toMatchObject(
      { width: 512, height: 256 },
    );
    expect(resolveNodeSize(undefined, { kind: "inherit", input: "source" }, context)).toMatchObject({
      width: 800,
      height: 600,
    });
    expect(
      resolveNodeSize(undefined, { kind: "scale", input: "source", factor: 0.5 }, context),
    ).toMatchObject({ width: 400, height: 300 });
  });

  it("treats {mode:'auto'} exactly like an absent override", () => {
    const policy = { kind: "fixed", width: 640, height: 480 } as const;
    expect(resolveNodeSize({ mode: "auto" }, policy, context)).toEqual(
      resolveNodeSize(undefined, policy, context),
    );
  });

  it("resolves each override mode", () => {
    const cases: Array<[NodeResolutionOverride, { width: number; height: number }]> = [
      [{ mode: "project" }, { width: 1920, height: 1080 }],
      [{ mode: "input" }, { width: 800, height: 600 }],
      [{ mode: "input", input: "mask" }, { width: 256, height: 256 }],
      [{ mode: "scale", factor: 0.5 }, { width: 400, height: 300 }],
      [{ mode: "scale", factor: 2 }, { width: 1600, height: 1200 }],
      [{ mode: "scale", factor: 0.125, input: "mask" }, { width: 32, height: 32 }],
      [{ mode: "fixed", width: 1024, height: 64 }, { width: 1024, height: 64 }],
    ];
    for (const [override, expected] of cases) {
      expect(resolveNodeSize(override, undefined, context)).toMatchObject(expected);
    }
  });

  it("covers every TD scale preset the spec fixes", () => {
    for (const preset of RESOLUTION_SCALE_PRESETS) {
      const size = resolveNodeSize({ mode: "scale", factor: preset.factor }, undefined, context);
      expect(size.width).toBe(Math.round(800 * preset.factor));
      expect(size.source).toContain(preset.label);
    }
  });

  it("never produces a zero or fractional dimension", () => {
    const tiny = resolveNodeSize({ mode: "scale", factor: 0.125 }, undefined, {
      project: { width: 4, height: 4 },
      inputs: [{ portId: "source", label: "Source", size: { width: 3, height: 3 } }],
    });
    expect(tiny.width).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(tiny.width)).toBe(true);
  });

  it("clamps to the project limit and says so (§V24)", () => {
    const clamped = resolveNodeSize({ mode: "scale", factor: 8 }, undefined, {
      ...context,
      maxResolution: 4096,
    });
    expect(clamped.width).toBe(4096);
    expect(clamped.clamped).toBe(true);
  });

  it("falls back to the project size and says the input is unresolved", () => {
    const disconnected = resolveNodeSize({ mode: "input" }, undefined, {
      project: { width: 1920, height: 1080 },
      inputs: [{ portId: "source", label: "Source" }],
    });
    expect(disconnected).toMatchObject({ width: 1920, height: 1080 });
    expect(disconnected.source).toContain("unresolved");
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

describe("§V51 — format resolution and support", () => {
  const formatContext: FormatContext = { projectFormat: "rgba8unorm", inputs };

  it("follows the definition's policy when there is no override", () => {
    expect(resolveNodeFormat(undefined, { kind: "project" }, formatContext).format).toBe("rgba8unorm");
    expect(
      resolveNodeFormat(undefined, { kind: "fixed", format: "r32float" }, formatContext).format,
    ).toBe("r32float");
    expect(
      resolveNodeFormat(undefined, { kind: "inherit", input: "source" }, formatContext).format,
    ).toBe("rgba16float");
  });

  it("resolves each override mode", () => {
    const cases: Array<[NodeFormatOverride, string]> = [
      [{ mode: "project" }, "rgba8unorm"],
      [{ mode: "input" }, "rgba16float"],
      [{ mode: "input", input: "mask" }, "rgba8unorm"],
      [{ mode: "fixed", format: "r32float" }, "r32float"],
    ];
    for (const [override, expected] of cases) {
      expect(resolveNodeFormat(override, undefined, formatContext).format).toBe(expected);
    }
  });

  it("flags a format the capability report does not list (§V12)", () => {
    const resolved = resolveNodeFormat({ mode: "fixed", format: "r32float" }, undefined, {
      ...formatContext,
      supported: ["rgba8unorm", "rgba16float"],
    });
    expect(resolved.supported).toBe(false);
  });

  it("does not claim anything about support before a capability report exists", () => {
    expect(resolveNodeFormat({ mode: "fixed", format: "r32float" }, undefined, formatContext).supported).toBe(
      true,
    );
  });

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
 * TD "Fit Resolution" and "Limit Resolution" (§V50). Both preserve aspect; the
 * difference is that fit always scales to the box, while limit only ever shrinks.
 */
describe("fit and limit resolution modes", () => {
  const ctx = (w: number, h: number) => ({
    project: { width: 1920, height: 1080 },
    inputs: [{ portId: "in", label: "Input", size: { width: w, height: h }, resolved: true }],
  });

  it("fit scales a large input down into the box, preserving aspect", () => {
    const size = resolveNodeSize({ mode: "fit", width: 512, height: 512 }, undefined, ctx(2000, 1000));
    expect(size.width).toBe(512);
    expect(size.height).toBe(256);
  });

  it("fit scales a SMALL input UP to the box — that is what distinguishes it from limit", () => {
    const size = resolveNodeSize({ mode: "fit", width: 800, height: 800 }, undefined, ctx(200, 100));
    expect(size.width).toBe(800);
    expect(size.height).toBe(400);
  });

  it("limit shrinks an oversized input", () => {
    const size = resolveNodeSize({ mode: "limit", width: 512, height: 512 }, undefined, ctx(2000, 1000));
    expect(size.width).toBe(512);
    expect(size.height).toBe(256);
  });

  it("limit leaves an input already inside the box untouched", () => {
    const size = resolveNodeSize({ mode: "limit", width: 800, height: 800 }, undefined, ctx(200, 100));
    expect(size.width).toBe(200);
    expect(size.height).toBe(100);
  });

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
