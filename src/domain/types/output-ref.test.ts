import { describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_PORT, formatOutputRef, parseOutputRef } from "./ids.ts";

/**
 * Port-scoped output identity (§V59). Four structurally identical copies of this shape had
 * appeared independently before it was lifted here; these tests pin the canonical form.
 */
describe("OutputRef", () => {
  it("round-trips through its serialized form", () => {
    const ref = { nodeId: "blur1", portId: "out" };
    expect(parseOutputRef(formatOutputRef(ref))).toEqual(ref);
  });

  /** A node id may not contain a slash, but a port id is free to — split on the FIRST. */
  it("splits on the first slash so a port id may contain one", () => {
    expect(parseOutputRef("node/a/b")).toEqual({ nodeId: "node", portId: "a/b" });
  });

  it("refuses malformed refs rather than inventing a half of one", () => {
    expect(parseOutputRef("noslash")).toBeNull();
    expect(parseOutputRef("/leading")).toBeNull();
    expect(parseOutputRef("trailing/")).toBeNull();
  });

  it("names the well-known single-output port", () => {
    expect(DEFAULT_OUTPUT_PORT).toBe("out");
  });
});
