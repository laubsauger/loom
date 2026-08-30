import { describe, expect, it } from "vitest";

import { graphPatchOperationSchema } from "./schemas.ts";
import type { GraphPatchOperation } from "./patch.ts";

/**
 * The zod union and the TypeScript union describe the SAME set of operations (T309).
 *
 * Two declarations of one thing, in two languages, neither of which can check the other:
 * the types vanish at runtime and zod is invisible to the compiler. Every operation added
 * so far has been added to both by remembering to, and the one time that failed nothing
 * went red — `setNodeSize` reached the document and not the boundary that guards it, and
 * the same had already happened to `reorderEdges` and to the whole group/viewport family
 * (T104, T225). A "must be updated with it" comment is not a mechanism.
 *
 * This is the mechanism, and it closes both directions:
 *
 *  - an operation added to the TYPE and not to the schema fails to COMPILE, because the
 *    record below is keyed by the union and would be missing a key;
 *  - an operation added to the SCHEMA and not to the type fails at RUNTIME here, because
 *    the two key sets are compared.
 *
 * The record is deliberately hand-written rather than derived. It is the one place where
 * "these are all the operations there are" is stated in a form the compiler enforces, and
 * deriving it from the schema would make it agree with the schema by construction — which
 * is exactly the check being made.
 */

const OPERATIONS: Record<GraphPatchOperation["op"], true> = {
  addNode: true,
  removeNodes: true,
  connect: true,
  disconnect: true,
  reorderEdges: true,
  setParameters: true,
  setShaderSource: true,
  moveNodes: true,
  setNodeSize: true,
  setNodeUi: true,
  setNodeLabel: true,
  setNodeResolution: true,
  setNodeFormat: true,
  addGroup: true,
  removeGroups: true,
  setGroup: true,
  setViewport: true,
};

function schemaOperations(): string[] {
  return graphPatchOperationSchema.options.map((member) => member.shape.op.value).sort();
}

describe("the patch-operation union has one definition (T309, §V66)", () => {
  it("validates exactly the operations the type declares", () => {
    expect(schemaOperations()).toEqual(Object.keys(OPERATIONS).sort());
  });

  it("has no duplicate discriminants", () => {
    // A copy-paste that leaves two members claiming the same `op` makes the second
    // unreachable, and a discriminated union will not complain about it.
    const ops = schemaOperations();
    expect(new Set(ops).size).toBe(ops.length);
  });

  it("accepts the operation that started this — a size is a document edit (T208)", () => {
    // Not a redundant case: `setNodeSize` was legal in the document and rejected at the
    // boundary, which is the exact divergence the two checks above now make impossible.
    const parsed = graphPatchOperationSchema.safeParse({
      op: "setNodeSize",
      nodeId: "n1",
      size: { width: 320, height: 240 },
    });
    expect(parsed.success).toBe(true);
  });
});
