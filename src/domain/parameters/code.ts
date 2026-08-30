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
