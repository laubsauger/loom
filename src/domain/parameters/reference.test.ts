import { describe, expect, it } from "vitest";

import { parseExpression } from "../expressions/index.ts";
import { parameterReference, parseParameterReference } from "./reference.ts";

/**
 * §V148's first half: the format we EMIT is the format the grammar READS.
 *
 * A "copy reference" that yields a plausible-looking string the evaluator rejects is the
 * whole feature failing silently, so the emitted form is checked against the real parser
 * rather than against a second regex that would only ever agree with itself.
 */
describe("parameter references round-trip (§V148)", () => {
  it("emits a form the expression grammar parses as a node reference", () => {
    const text = parameterReference("noise1", "period");
    const parsed = parseExpression(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ast).toEqual({ kind: "opRef", name: "noise1", path: ["par", "period"] });
  });

  it("reads its own output back to the same node and key", () => {
    expect(parseParameterReference(parameterReference("blur2", "radius"))).toEqual({
      nodeName: "blur2",
      parameterKey: "radius",
    });
  });

  it("tolerates the whitespace a paste from a text field brings with it", () => {
    expect(parseParameterReference("  op('a').par.b \n")).toEqual({
      nodeName: "a",
      parameterKey: "b",
    });
  });

  it("refuses text that is not a bare reference", () => {
    // Each of these is a legitimate string somewhere else, and treating any of them as a
    // reference would write something the user did not ask for.
    expect(parseParameterReference("2 + 2")).toBeNull();
    expect(parseParameterReference("op('a').par.b * 2")).toBeNull();
    expect(parseParameterReference("op('a').par")).toBeNull();
    expect(parseParameterReference("op('a').par.b.c")).toBeNull();
    expect(parseParameterReference("hello")).toBeNull();
    expect(parseParameterReference("")).toBeNull();
  });

  it("matches the form rename rewrites, so a reference survives being renamed", () => {
    // §V128 rewrites `op('name')`; a reference written any other way would silently
    // break the first time the user renamed the node it points at.
    expect(parameterReference("noise1", "period")).toContain("op('noise1')");
  });
});
