import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { lfoNode } from "@nodes/definitions/values.ts";
import { decimalsFor, formatNumber, normalizeValue } from "@ui/controls/drag-math.ts";
import type { NumericSpec } from "@ui/controls/types.ts";

/**
 * B80 — A PARAMETER THAT DECLARES ONLY A RANGE MUST NOT BECOME AN INTEGER CONTROL.
 *
 * ## The bug
 *
 * `lfo.frequency` was declared `{ min: 0, max: 100, unit: "hz" }` with no `step` and no
 * `precision`. `stepFor` derives a step of 1/100 of the declared range when the author
 * gives none — a good default for a drag, and for THIS range it is exactly `1`. That one
 * number is then reused for three different jobs: the drag granularity, the DISPLAY
 * decimals (`decimalsFor` -> `0`), and the QUANTISATION grid (`quantize`). So E7's 0.25 Hz
 * oscillator showed `0` in the inspector, and — the half that destroys work — clicking the
 * field and clicking away committed that `0` back into the document through `commitText`,
 * flattening the sine to a straight line. Measured in the running app, not inferred.
 *
 * ## Why this gate and not a fixed manifest
 *
 * Fixing `lfo.frequency` alone fixes one node. The reusable mistake is writing a plausible
 * range and letting a derived step decide, silently, that the parameter is discrete — and
 * nothing anywhere says which parameters are continuous. So the rule is stated instead:
 *
 *   an integer parameter SAYS SO (`step: 1` or `precision: 0`);
 *   a parameter that says nothing is continuous, and must be able to show a fraction.
 *
 * Measured when this was written: 35 of 195 numeric parameters in the catalogue display
 * zero decimals, and 34 of them DECLARE it (`count`, `cols`, `rows`, `seed`, `substeps`,
 * `frames`, `harmonics` — all genuinely discrete). Exactly one reached it by derivation,
 * and that one was the bug. The SPEC's "every fractional parameter in the app is affected"
 * is therefore an overstatement, corrected here by counting.
 *
 * ## What it does not prove
 *
 * Nothing here renders anything (§V339). It is a statement about manifests and the control
 * kit's maths, not evidence that any field is legible on screen. It also cannot catch the
 * opposite error — a parameter that declares `step: 1` and is really continuous — because
 * a declaration is exactly what this file agrees to trust.
 */

const declares = (spec: NumericSpec): boolean =>
  spec.step !== undefined || spec.precision !== undefined;

describe("B80 — a continuous parameter can show a fraction", () => {
  it("gives the LFO's frequency back its decimals, in both directions", () => {
    const frequency = lfoNode.parameters?.["frequency"];
    expect(frequency?.type).toBe("number");
    const spec = frequency as NumericSpec;

    // The symptom, verbatim: E7 stores 0.25 Hz and the inspector printed "0".
    expect(formatNumber(0.25, spec)).toBe("0.25");
    // The half that destroyed the document: the field's own commit path quantised it away.
    expect(normalizeValue(0.25, spec)).toBe(0.25);
    // And the sub-tenth frequencies the other examples actually use (E3/E13 0.05, E8 0.1).
    expect(formatNumber(0.05, spec)).toBe("0.05");
    expect(normalizeValue(0.05, spec)).toBe(0.05);
  });

  it("refuses a DERIVED integer grid anywhere in the catalogue", () => {
    const accidents: string[] = [];
    for (const definition of allNodeDefinitions) {
      for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
        if (parameter.type !== "number") continue;
        const spec = parameter as NumericSpec;
        if (declares(spec)) continue;
        if (decimalsFor(spec) > 0) continue;
        accidents.push(
          `${definition.type}.${key} (min ${String(spec.min)}, max ${String(spec.max)}) — ` +
            `no step and no precision, so the derived step is ${String(spec.max)}/100 and the ` +
            `field shows 0 decimals: 0.25 renders as "${formatNumber(0.25, spec)}" and commits ` +
            `as ${String(normalizeValue(0.25, spec))}. Declare step: 1 if it is discrete, or a ` +
            `real step if it is not.`,
        );
      }
    }
    expect(accidents).toEqual([]);
  });
});
