/**
 * Node types whose SOURCE is a NAME, not a wire (T350, §V285).
 *
 * Feedback names the node it records instead of taking a wired back-edge, so `edges`
 * stays a DAG and the loop the user sees is a dashed reference, not a cycle. The
 * compiler synthesizes the exact edge the wired shape would have had — one code path,
 * no second semantics.
 *
 * WHY A TABLE, when `NodeDefinition.sourceReference` declares the same fact: the
 * document-side consumers — the dependency walk, liveness, the rename rewrite — run
 * where the catalogue must not be imported (a value import of the definitions index
 * would pull every node into the domain layer). The definition stays the declaration
 * of record; this table is its domain-side projection, and `index.test.ts` pins the
 * two to each other in both directions so they cannot drift.
 */
export interface SourceReferenceSpec {
  /** The parameter carrying the source node's NAME (§V129 — names are identifiers). */
  readonly parameter: string;
  /** The input port the synthesized edge feeds. */
  readonly input: string;
}

export const SOURCE_REFERENCE_PARAMETERS: Readonly<Record<string, SourceReferenceSpec>> = {
  feedback: { parameter: "source", input: "in" },
};

export function sourceReferenceOf(nodeType: string): SourceReferenceSpec | undefined {
  return SOURCE_REFERENCE_PARAMETERS[nodeType];
}

/** The stored name, when the node's type takes one and something is written there. */
export function sourceReferenceName(
  nodeType: string,
  parameters: Readonly<Record<string, unknown>>,
): string | undefined {
  const spec = sourceReferenceOf(nodeType);
  if (spec === undefined) return undefined;
  const stored = parameters[spec.parameter];
  // A plain string only: the reference contract stores the bare name, and a slot here
  // would mean someone tried to animate an identity.
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}
