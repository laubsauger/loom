import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { declaredStep } from "@ui/controls/drag-math.ts";

/**
 * T1047 — A PARAMETER THAT COUNTS DECLARES A STEP OF 1.
 *
 * The owner: "index fields everywhere should be an integer by default. At least by
 * default have the sensitivity integer — we can always set it to something else to get
 * the automatic blending, that's all neat and cool. But let's at least have the
 * precision for index fields by default be 1."
 *
 * Why it matters mechanically, and why it only became true recently: T989 split the one
 * `stepFor` into `declaredStep` (the author's constraint, the ONLY step allowed to snap)
 * and `dragStepFor` (the drag ergonomic, which must never reach the document). So before
 * T989 declaring a step here would have been the same lattice that was destroying values;
 * after it, a declared 1 is exactly and only "this parameter counts".
 *
 * Without it a drag lands on 0.37 of an input. The node floors it, so the readout and the
 * picture disagree about which input is selected — the parameter says one thing and the
 * render does another, which is the class of lie this project spends most of its gates on.
 *
 * DERIVED from the registry, never hand-listed (§V316, and §V855: a sweep over one axis
 * is not coverage of a second). `valueSwitch` has always declared it; `switch` and `cache`
 * did not, and nothing noticed.
 */

/** Keys whose value is a position in a sequence rather than a quantity of something. */
const COUNTING_KEYS = new Set(["index"]);

describe("T1047 — a parameter that counts declares a step of 1", () => {
  const counting = allNodeDefinitions.flatMap((definition) =>
    Object.entries(definition.parameters ?? {})
      .filter(([key, spec]) => COUNTING_KEYS.has(key) && (spec as { type?: string }).type === "number")
      .map(([key, spec]) => ({ type: definition.type, key, spec: spec as { step?: number } })),
  );

  it("finds the counting parameters at all", () => {
    // Non-vacuity (§V854): a filter that matches nothing passes every assertion below.
    expect(counting.length).toBeGreaterThanOrEqual(3);
  });

  it("every one of them declares step 1", () => {
    const offenders = counting
      .filter((entry) => declaredStep(entry.spec as never) !== 1)
      .map((entry) => `${entry.type}.${entry.key} declares ${String(entry.spec.step)}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
