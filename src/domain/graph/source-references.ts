/**
 * Node parameters whose value is a NAME (or a LIST of names) resolving to other nodes
 * (T350 for feedback; T447 generalized it for the scene family).
 *
 * Feedback names the node it records instead of taking a wired back-edge, so `edges`
 * stays a DAG. T447 extends the same mechanism to scene assembly — a Render names its
 * camera, lights and geometries; a Geometry names its material — on the owner's ruling
 * that many-object scenes are the NORMAL case and twenty wires converging on one node
 * is the shape that does not survive real use.
 *
 * THE COMPILER STILL WORKS ON EDGES: every reference is resolved into a SYNTHESIZED
 * edge before validation (compile.ts), so payload propagation, ordering and the whole
 * pass machinery never learn that names exist. References are the AUTHORING surface;
 * ports are the plumbing. Scene-reference inputs are declared as real (connect-refused)
 * ports on the definitions.
 *
 * LISTS, NOT PATTERNS, deliberately: a pattern (`geo*`) is a QUERY, not a reference —
 * a rename moves nodes silently in and out of its match set, which is the V320
 * silent-misbind class made into a feature. V128 requires that a rename rewrites every
 * stored reference; only explicit names can honour that. List order is DRAW/LIGHT
 * order — user-stated, deterministic.
 *
 * WHY A TABLE, when definitions also declare it: the document-side consumers — the
 * dependency walk, liveness, the rename rewrite — run where the catalogue must not be
 * imported. The definition stays the declaration of record; `index.test.ts` pins the
 * two to each other in both directions.
 */
export interface SourceReferenceSpec {
  /** The parameter carrying the name(s) (§V129 — names are identifiers). */
  readonly parameter: string;
  /** The input port the synthesized edge(s) feed. */
  readonly input: string;
  /** True: the parameter holds a whitespace/comma-separated LIST of names. */
  readonly list?: boolean;
}

export const SOURCE_REFERENCE_PARAMETERS: Readonly<Record<string, ReadonlyArray<SourceReferenceSpec>>> = {
  feedback: [{ parameter: "source", input: "in" }],
  geometry: [{ parameter: "material", input: "material" }],
  render: [
    { parameter: "scenes", input: "scenes", list: true },
    { parameter: "camera", input: "camera" },
    { parameter: "lights", input: "lights", list: true },
  ],
  // T457 (V387): the point renderers share the SAME camera-by-name model as Render —
  // one camera node can frame instances, a surface and a scene render at once.
  renderSurface: [{ parameter: "camera", input: "camera" }],
  renderInstances: [{ parameter: "camera", input: "camera" }],
};

export function sourceReferencesOf(nodeType: string): ReadonlyArray<SourceReferenceSpec> {
  return SOURCE_REFERENCE_PARAMETERS[nodeType] ?? [];
}

/** The spec whose synthesized edges land on `input`, when the type has one. */
export function sourceReferenceForInput(nodeType: string, input: string): SourceReferenceSpec | undefined {
  return sourceReferencesOf(nodeType).find((spec) => spec.input === input);
}

/**
 * The stored NAMES of one spec, in list order. A plain string only — a slot here would
 * mean someone tried to animate an identity — split on whitespace/commas for a list
 * spec, whole-and-trimmed for a single one. Empty when nothing is written.
 */
export function sourceReferenceTokens(
  spec: SourceReferenceSpec,
  parameters: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const stored = parameters[spec.parameter];
  if (typeof stored !== "string") return [];
  if (spec.list === true) {
    return stored.split(/[\s,]+/).filter((token) => token !== "");
  }
  const trimmed = stored.trim();
  return trimmed === "" ? [] : [trimmed];
}

/** Every referenced name across every spec of the type, deduplicated, in spec order. */
export function sourceReferenceNames(
  nodeType: string,
  parameters: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const names: string[] = [];
  for (const spec of sourceReferencesOf(nodeType)) {
    for (const token of sourceReferenceTokens(spec, parameters)) {
      if (!names.includes(token)) names.push(token);
    }
  }
  return names;
}

/**
 * The T350 shape, kept for feedback's single-name consumers (the loader migration and
 * liveness read it). Answers the FIRST single-name spec only.
 */
export function sourceReferenceOf(nodeType: string): SourceReferenceSpec | undefined {
  return sourceReferencesOf(nodeType).find((spec) => spec.list !== true);
}

/** The stored name of the type's single-name spec, when one is written (T350 shape). */
export function sourceReferenceName(
  nodeType: string,
  parameters: Readonly<Record<string, unknown>>,
): string | undefined {
  const spec = sourceReferenceOf(nodeType);
  if (spec === undefined) return undefined;
  return sourceReferenceTokens(spec, parameters)[0];
}
