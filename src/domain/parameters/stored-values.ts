import type { ParameterValue } from "../types/parameters.ts";
import type { ResolvedParameters } from "./resolve.ts";

/**
 * The effective parameter page in STORED space (T307, §V56, §V61, B8, T187).
 *
 * `ResolvedParameters` carries two shapes of the same numbers and the difference is a
 * colour space. `values` is the EVALUATION shape: a `color` declared `space: "display"`
 * has been decoded to linear, because that is what a shader wants and the decode belongs
 * in the one read path rather than in twenty in-shader curves. `entries[].value` is what
 * the DOCUMENT holds and what a control edits — still display-encoded, so a colour picker
 * does not appear to drift its own number every round trip.
 *
 * A caller that is going to RE-RESOLVE these numbers needs the second shape. Component
 * flattening writes a published page back onto internal `GraphNode.parameters` and feeds
 * it to `parent.<key>` drivers; component navigation publishes it into the lexical scope
 * a child's own resolution reads. Both of those resolve again, and a value that arrives
 * already decoded is decoded twice.
 *
 * ## Why this is a shared function and not four lines in two files
 *
 * It WAS four lines in two files, and one of them was wrong for weeks (T187): the compiler
 * took `entries[].value` and the editor's scope took `values`, so a picked mid-grey (0.5)
 * reached the shader at 0.0376 instead of 0.2140 — less than a fifth of the light asked
 * for. That is B8's exact shape: two copies of one decision, drifting, with the wrong one
 * invisible because a colour that is only too dark reads as an art-direction choice.
 *
 * §V61 says there is ONE parameter read path. This is the corollary: there is one way to
 * ask that path for the un-decoded page, so a third caller cannot invent a third answer.
 */
export function storedValues(resolved: ResolvedParameters): Record<string, ParameterValue> {
  const values: Record<string, ParameterValue> = {};
  for (const entry of resolved.entries) values[entry.key] = entry.value;
  return values;
}
