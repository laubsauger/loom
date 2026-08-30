import { describe, expect, it } from "vitest";
import type { GraphNode } from "../types/graph.ts";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { resolveParameters, srgbToLinear } from "./resolve.ts";
import { storedValues } from "./stored-values.ts";

/**
 * T307 / §V56 / B8 — the un-decoded page, from the one read path.
 *
 * This function exists because the four lines it replaces lived in two files and one of
 * them was wrong for weeks (T187). The tests below are therefore not about "does it copy
 * a record": they are about the PROPERTY that made the duplication dangerous — that
 * re-resolving a stored page is idempotent, and re-resolving an evaluation page is not.
 */

const registry = createTestRegistry().view();
const solid = registry.get("test.solid");

/** srgbToLinear(0.5): what a picked mid-grey is worth as light. */
const MID_GREY_LINEAR = srgbToLinear(0.5);

function node(parameters: GraphNode["parameters"]): GraphNode {
  return { id: "n1", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters };
}

describe("storedValues — the page a re-resolving caller needs (T307)", () => {
  it("keeps a display colour ENCODED, where `values` has already decoded it", () => {
    const resolved = resolveParameters(node({ color: [0.5, 0.5, 0.5, 1] }), solid);
    // The two shapes of the same number, and the whole reason both exist.
    expect(storedValues(resolved)["color"]).toEqual([0.5, 0.5, 0.5, 1]);
    expect((resolved.values["color"] as readonly number[])[0]).toBeCloseTo(MID_GREY_LINEAR, 12);
  });

  it("agrees with `values` on everything that is not a display colour", () => {
    // The colour is non-zero on purpose: black decodes to black, so a default-coloured
    // node would make the non-vacuity check below pass against a broken implementation.
    const resolved = resolveParameters(
      node({ amount: 0.25, label: "hi", color: [0.5, 0.5, 0.5, 1] }),
      solid,
    );
    const stored = storedValues(resolved);
    expect(stored["amount"]).toBe(resolved.values["amount"]);
    expect(stored["label"]).toBe(resolved.values["label"]);
    // NON-VACUITY: a test that only checked non-colour keys would pass on a function that
    // returned `values` verbatim — which is exactly the bug (T187). Colour must differ.
    expect(stored["color"]).not.toEqual(resolved.values["color"]);
  });

  it("is IDEMPOTENT under re-resolution, which `values` is not — the T187 property", () => {
    const first = resolveParameters(node({ color: [0.5, 0.5, 0.5, 1] }), solid);

    // What flattening and parent scope actually do: write the page back onto a node's
    // parameters and resolve again.
    const roundTripped = resolveParameters(node(storedValues(first)), solid);
    expect(storedValues(roundTripped)).toEqual(storedValues(first));
    expect((roundTripped.values["color"] as readonly number[])[0]).toBeCloseTo(MID_GREY_LINEAR, 12);

    // The same round trip through the evaluation page decodes a second time. 0.5 leaves
    // as 0.2140 and arrives at 0.0376 — under a fifth of the light asked for, and dark
    // enough to read as an art-direction choice rather than a bug (B8's lesson).
    const doubled = resolveParameters(node(first.values), solid);
    const wrong = (doubled.values["color"] as readonly number[])[0] ?? 0;
    expect(wrong).toBeCloseTo(srgbToLinear(MID_GREY_LINEAR), 12);
    expect(wrong).toBeLessThan(MID_GREY_LINEAR / 5);
  });

  it("carries every declared key, so a page cannot silently lose a parameter", () => {
    const resolved = resolveParameters(node({}), solid);
    expect(Object.keys(storedValues(resolved)).sort()).toEqual(
      Object.keys(solid?.parameters ?? {}).sort(),
    );
  });
});
