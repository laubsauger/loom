import { describe, expect, it } from "vitest";

import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { colorSpaceForFormat, resolveColorSpace } from "./color-space.ts";

/**
 * Colour-space propagation (doc §16.2), including the T149 regression: the inherited
 * space comes from the port the format precedence NAMED, never from whichever connected
 * input happens to sort first in edge order.
 */

describe("colorSpaceForFormat", () => {
  it("maps formats to their implied spaces", () => {
    expect(colorSpaceForFormat("rgba8unorm-srgb")).toBe("encoded");
    expect(colorSpaceForFormat("r32float")).toBe("data");
    expect(colorSpaceForFormat("rgba16float")).toBe("linear");
    expect(colorSpaceForFormat("rgba8unorm")).toBe("linear");
  });
});

describe("resolveColorSpace", () => {
  it("T149: inherits from the NAMED port, not the first connected input", () => {
    const outcome = resolveColorSpace({
      nodeId: "n1",
      nodeType: "over",
      // Edge order puts the encoded input first; the format policy names "in2".
      inputs: [
        { portId: "in1", space: "encoded" },
        { portId: "in2", space: "linear" },
      ],
      resolved: "linear",
      inherited: true,
      inheritPort: "in2",
    });
    expect(outcome.space).toBe("linear");

    const reversed = resolveColorSpace({
      nodeId: "n1",
      nodeType: "over",
      inputs: [
        { portId: "in1", space: "encoded" },
        { portId: "in2", space: "linear" },
      ],
      resolved: "linear",
      inherited: true,
      inheritPort: "in1",
    });
    expect(reversed.space).toBe("encoded");
  });

  it("falls back to the resolved-format space when the named port is unbound", () => {
    const outcome = resolveColorSpace({
      nodeId: "n1",
      nodeType: "level",
      inputs: [],
      resolved: "linear",
      inherited: true,
      inheritPort: "input",
    });
    expect(outcome.space).toBe("linear");
  });

  it("warns on mixed colour spaces without converting anything (§V13)", () => {
    const outcome = resolveColorSpace({
      nodeId: "n1",
      nodeType: "over",
      inputs: [
        { portId: "in1", space: "linear" },
        { portId: "in2", space: "encoded" },
      ],
      resolved: "linear",
      inherited: false,
    });
    const warning = outcome.diagnostics.find(
      (d) => d.code === CompilerDiagnosticCode.colorSpaceMismatch,
    );
    expect(warning?.severity).toBe("warning");
    expect(outcome.space).toBe("linear");
  });

  it("exempts data inputs from the mismatch check", () => {
    const outcome = resolveColorSpace({
      nodeId: "n1",
      nodeType: "mask",
      inputs: [
        { portId: "input", space: "linear" },
        { portId: "mask", space: "data" },
      ],
      resolved: "linear",
      inherited: false,
    });
    expect(outcome.diagnostics).toEqual([]);
  });
});
