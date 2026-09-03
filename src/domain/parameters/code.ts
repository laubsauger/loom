import type { CodeParameter, ParameterSchema } from "../types/parameters.ts";

/**
 * T492: every parameter of a node that IS code, in declaration order.
 *
 * The one derivation every editing surface reads — the inspector's control, the code
 * pane's subject list, enlarge and pop-out. Nothing may keep its own roster of kernel
 * parameter names (§V437: a property delivered as a site list narrows silently); a
 * parameter becomes editable-as-code by DECLARING `type: "code"` in its manifest and
 * by no other act.
 */
export function codeParametersOf(
  schema: ParameterSchema,
): ReadonlyArray<{ readonly key: string; readonly definition: CodeParameter }> {
  return Object.entries(schema)
    .filter((entry): entry is [string, CodeParameter] => entry[1].type === "code")
    .map(([key, definition]) => ({ key, definition }));
}

/**
 * T1052 — THE CODE EDITOR SORTS LAST, AND THE SORT BELONGS TO THE MANIFEST.
 *
 * The owner: *"the derived values and all of this kind of stuff should be ABOVE the code
 * segments, so that you don't have to scroll past a bunch of code to be able to access any
 * of the derived or exposed parameters."* A `customWgsl` reflects its shader's `struct
 * Params` (T880) and a point kernel reflects its kernel's (T900), and both APPENDED those
 * controls after the text they were read from — so the knobs the reflection exists to give
 * you sat below a full-height editor.
 *
 * This is deliberately NOT a rule in the inspector's renderer. `parameter-groups.ts` is
 * right that `group` is the only grouping input and MANIFEST ORDER is the only ordering
 * one, and that is a good design: a node author who lists parameters in a deliberate order
 * gets that order. So the manifest says it instead, once, at the point where the schema is
 * built — `parameters:` for the declared block, the tail of `parametersFor` for a reflected
 * one — and every reader keeps reading plain manifest order.
 *
 * The partition is STABLE: everything that is not code keeps the sequence its author wrote,
 * everything that is keeps its own, and only the boundary between them moves.
 * `src/tests/guardrails/code-parameter-order.test.ts` derives the set of nodes declaring a
 * `code` parameter FROM THE REGISTRY — never from a list of the two we knew about (§V316) —
 * so node N+1 cannot reintroduce the scroll.
 */
export function codeParametersLast(schema: ParameterSchema): ParameterSchema {
  const entries = Object.entries(schema);
  const code = entries.filter(([, definition]) => definition.type === "code");
  if (code.length === 0 || code.length === entries.length) return schema;
  return Object.fromEntries([...entries.filter(([, definition]) => definition.type !== "code"), ...code]);
}
