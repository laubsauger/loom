import { describe, expect, it } from "vitest";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import {
  ShaderDiagnosticCode,
  diagnosticsToMarkers,
  formatDiagnosticLocation,
  internalCompileDiagnostic,
  lineStartOffsets,
  messageRange,
  partitionDiagnostics,
  toRuntimeDiagnostic,
  toRuntimeDiagnostics,
} from "./shader-diagnostics.ts";
import type { ShaderCompilationMessage } from "./compile-types.ts";

const CONTEXT = { nodeId: "node-1", file: "custom.wgsl" } as const;

function message(partial: Partial<ShaderCompilationMessage>): ShaderCompilationMessage {
  return { type: "error", message: "unresolved identifier", lineNum: 1, linePos: 1, ...partial };
}

describe("V27 — a compilation message becomes a positioned diagnostic", () => {
  it("carries severity, a stable code, the node and the source position", () => {
    const diagnostic = toRuntimeDiagnostic(
      message({ type: "error", message: "no matching overload", lineNum: 7, linePos: 12 }),
      CONTEXT,
    );
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.code).toBe(ShaderDiagnosticCode.error);
    expect(diagnostic.nodeId).toBe("node-1");
    expect(diagnostic.message).toBe("no matching overload");
    expect(diagnostic.source).toEqual({ file: "custom.wgsl", line: 7, column: 12 });
  });

  it("keeps WebGPU's 1-based line and column as reported, without shifting them", () => {
    // The diagnostic is a user-facing artifact: line 7 in the message must read as line 7
    // in the problems tab. The 0-based conversion belongs to the editor, not here.
    const diagnostic = toRuntimeDiagnostic(message({ lineNum: 7, linePos: 12 }), CONTEXT);
    expect(diagnostic.source?.line).toBe(7);
    expect(diagnostic.source?.column).toBe(12);
  });

  it("drops an unknown position rather than reporting it as line 0 or line 1", () => {
    // WebGPU uses 0 for "no position". Forwarding it points at a phantom line; bumping
    // it to 1 points at the wrong real line. Both are worse than saying nothing.
    const diagnostic = toRuntimeDiagnostic(message({ lineNum: 0, linePos: 0 }), CONTEXT);
    expect(diagnostic.source).toEqual({ file: "custom.wgsl" });
    expect(formatDiagnosticLocation(diagnostic)).toBeNull();
  });

  it("falls back to the node id when no file name is supplied", () => {
    const diagnostic = toRuntimeDiagnostic(message({}), { nodeId: "node-9" });
    expect(diagnostic.source?.file).toBe("node-9");
  });

  it("formats a location for the problems tab", () => {
    expect(formatDiagnosticLocation(toRuntimeDiagnostic(message({ lineNum: 3, linePos: 5 }), CONTEXT)))
      .toBe("3:5");
    expect(formatDiagnosticLocation(toRuntimeDiagnostic(message({ lineNum: 3, linePos: 0 }), CONTEXT)))
      .toBe("3");
  });
});

describe("V27 — warnings are separated from errors", () => {
  it("splits a mixed batch into three lists", () => {
    const diagnostics = toRuntimeDiagnostics(
      [
        message({ type: "error", message: "e1" }),
        message({ type: "warning", message: "w1" }),
        message({ type: "info", message: "i1" }),
        message({ type: "warning", message: "w2" }),
      ],
      CONTEXT,
    );
    const { errors, warnings, info } = partitionDiagnostics(diagnostics);

    expect(errors.map((d) => d.message)).toEqual(["e1"]);
    expect(warnings.map((d) => d.message)).toEqual(["w1", "w2"]);
    expect(info.map((d) => d.message)).toEqual(["i1"]);
    // Distinct codes, so a consumer that only has the code can still tell them apart.
    expect(errors[0]?.code).toBe(ShaderDiagnosticCode.error);
    expect(warnings[0]?.code).toBe(ShaderDiagnosticCode.warning);
    expect(info[0]?.code).toBe(ShaderDiagnosticCode.info);
  });
});

describe("V27 — line and column map to editor offsets", () => {
  // Line starts: line 1 at offset 0, line 2 at 9, line 3 at 18.
  const SOURCE = "fn main(\n  x: f32\n) -> f32 {\n  return x;\n}";

  it("computes line start offsets", () => {
    expect(lineStartOffsets(SOURCE).slice(0, 3)).toEqual([0, 9, 18]);
  });

  it("puts line 1 column 1 at offset 0 — the off-by-one guard", () => {
    // 1-based (1,1) is offset 0, not offset 1 and not offset 2. Every shader-editor
    // off-by-one is one of those two, and this is the assertion that catches them.
    expect(messageRange(SOURCE, message({ lineNum: 1, linePos: 1 })).from).toBe(0);
  });

  it("converts an interior position exactly once", () => {
    // Line 2 starts at 9; column 3 is two characters in.
    expect(messageRange(SOURCE, message({ lineNum: 2, linePos: 3 })).from).toBe(11);
    expect(SOURCE[11]).toBe("x");
  });

  it("uses the reported UTF-16 offset when the implementation gives one", () => {
    const range = messageRange(SOURCE, message({ lineNum: 2, linePos: 3, offset: 11, length: 1 }));
    expect(range).toEqual({ from: 11, to: 12 });
  });

  it("clamps a position past the end of a shrinking document instead of throwing", () => {
    // A message can outlive the edit that produced it — the user deleted lines while the
    // compile was in flight.
    const range = messageRange("fn f() {}", message({ lineNum: 400, linePos: 900 }));
    expect(range.from).toBeGreaterThanOrEqual(0);
    expect(range.to).toBeLessThanOrEqual("fn f() {}".length);
  });

  it("sends a positionless message to the top of the file", () => {
    expect(messageRange(SOURCE, message({ lineNum: 0, linePos: 0 })).from).toBe(0);
  });

  it("never produces a zero-width range, which would underline nothing", () => {
    const range = messageRange(SOURCE, message({ lineNum: 2, linePos: 3 }));
    expect(range.to).toBeGreaterThan(range.from);
  });

  it("round-trips a diagnostic back to the same range the message had", () => {
    const original = message({ lineNum: 2, linePos: 3, type: "warning" });
    const diagnostic = toRuntimeDiagnostic(original, CONTEXT);
    const [marker] = diagnosticsToMarkers(SOURCE, [diagnostic]);
    expect(marker).toBeDefined();
    expect(marker?.from).toBe(messageRange(SOURCE, original).from);
    expect(marker?.severity).toBe("warning");
  });
});

describe("a compile call that threw", () => {
  it("becomes an error with its own code and no phantom position", () => {
    const diagnostic: RuntimeDiagnostic = internalCompileDiagnostic(
      new Error("device lost"),
      CONTEXT,
    );
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.code).toBe(ShaderDiagnosticCode.internal);
    expect(diagnostic.message).toContain("device lost");
    expect(diagnostic.source).toEqual({ file: "custom.wgsl" });
  });
});
