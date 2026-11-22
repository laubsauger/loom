import { classifyEdit, structuralParameterKeys } from "@compiler/index.ts";
import type { GraphEdit, RecompileDecision, RecompileWork } from "@compiler/index.ts";
import { isComponentNodeType } from "@domain/components/component-type.ts";
import { effectiveParameterSchema, resolveStored } from "@domain/parameters/resolve.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import { PRESETS_NODE_TYPE } from "@domain/presets/bank.ts";
import { CUE_LIST_NODE_TYPE } from "@domain/presets/cue-list.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * What changed between two document revisions, as the compiler's own edit vocabulary
 * (T308, B26, §V5).
 *
 * `classifyEdit` has existed, been exported and been unit-tested since T31 with NO
 * PRODUCTION CALLER: every document revision re-ran the whole compiler and every one of
 * them reached `backend.compile`. Measured, before this landed: five value-only parameter
 * edits produced five `compileGraph` calls, five `backend.compile` calls and ZERO
 * `updateUniforms`. §V5's uniform-only path was not merely unenforced — for a static edit
 * it did not exist, because the only way a new value reached the GPU was by rebuilding
 * the plan. This module is the missing input to the classifier.
 *
 * ## Why a document DIFF and not the patch's operations
 *
 * The patch knows what it did, but it is not the only thing that changes a document: undo
 * and redo replay inverses, and an agent's patch arrives by the same door as a human's.
 * Classifying the RESULT covers all of them with one rule. It is also cheap in exactly
 * the way that matters — the store applies patches through immer, so an untouched node
 * keeps its object identity and the diff is a walk of reference comparisons, not a deep
 * equality check.
 *
 * ## A LOAD is not an edit (T519, B106)
 *
 * A project load is the one revision this diff must NOT be asked about, and the header
 * above said so for months while the code went on diffing anyway: "a project load
 * replaces everything" was written down and never enforced. Two documents that share
 * node NAMES share node IDS — `noise1`, `ramp1`, `out` is what everyone gets, and `out`
 * is in every shipped example — so a node whose parameters happen to coincide diffs as
 * unchanged and keeps its cached texture, its temporal history and its compiled pass.
 * The picture that comes back is the PREVIOUS PROJECT'S.
 *
 * The correction is not more unique ids. Uniqueness would paper over the defect, break
 * the id stability other things rely on, and leave the bug live for the next two
 * documents that still collide. What was missing is DOCUMENT IDENTITY: this classifies
 * two revisions OF A DOCUMENT, and two revisions of DIFFERENT documents are not a diff
 * at all. So the input is a `DocumentRevision` — an identity paired with a graph — and a
 * revision that crosses an identity boundary is a full rebuild regardless of what the
 * contents happen to be. It is a TYPE change on purpose: a caller cannot forget to say
 * which document it is talking about, which is the only way this stays fixed.
 *
 * ## Conservative in one direction only
 *
 * `classifyEdit`'s own rule, inherited here: when this cannot prove an edit is cheap it
 * asks for MORE work, never less. Every unrecognised difference — a field nobody has
 * classified, a node type change, a document shape this build has not seen — comes out as
 * `topology`, which recompiles. The failure mode of guessing "cheap" is a stale picture
 * that no further editing repairs; the failure mode of guessing "expensive" is the
 * behaviour that shipped for the last four months.
 *
 * And the answer is CHECKED rather than trusted: the caller hands the decision to a push
 * that asserts `isUniformOnlyChange` against the real plans and refuses if they disagree
 * (`animate-parameters.ts`), so a wrong classification here costs a recompile, not a
 * wrong frame.
 */

/** Weakest to strongest. The combined decision is the strongest edit in the batch. */
const WORK_ORDER: readonly RecompileWork[] = [
  "editor-only",
  "preview-plan",
  "uniform-update",
  "recompile-shader",
  "recompile-region",
  "repropagate",
];

function strongest(a: RecompileDecision, b: RecompileDecision): RecompileDecision {
  return WORK_ORDER.indexOf(b.work) > WORK_ORDER.indexOf(a.work) ? b : a;
}

/**
 * Work that may skip `backend.compile`.
 *
 * Deliberately a WHITELIST. A new `RecompileWork` member is expensive by default, which
 * is the safe direction: someone adding a kind has to come here and say it is cheap,
 * rather than discovering months later that it was treated as cheap because nobody did.
 */
const VALUES_ONLY: ReadonlySet<RecompileWork> = new Set<RecompileWork>([
  "editor-only",
  "uniform-update",
]);

export function isValuesOnly(decision: RecompileDecision): boolean {
  return VALUES_ONLY.has(decision.work);
}

/**
 * How each field of a node is classified when it differs.
 *
 * Keyed by `keyof GraphNode`, so adding a field to the document TYPE stops this file
 * compiling until someone has decided what editing it costs. That is the whole point:
 * the alternative is a new field that silently falls through to "nothing changed", which
 * is the exact shape of bug this module exists to stop being possible.
 */
type FieldClass =
  | "layout"
  | "parameters"
  | "ui"
  | "resolution"
  | "format"
  /** Not provably cheap. Recompiles. */
  | "structural";

const NODE_FIELDS: Record<keyof GraphNode, FieldClass> = {
  // Identity and shape: a node whose type or definition version changed is a different
  // node to the compiler.
  id: "structural",
  type: "structural",
  definitionVersion: "structural",
  // §V190 — layout is presentation. Moving or resizing a node costs the GPU nothing.
  position: "layout",
  size: "layout",
  parameters: "parameters",
  // §V128/§V129: a node NAME is an identifier that expressions reference by name, so a
  // rename can change what another node's parameter resolves to. Not cheap.
  label: "structural",
  resolution: "resolution",
  format: "format",
  channelMask: "structural",
  state: "structural",
  ui: "ui",
};

/** Keys whose values differ between two records, by reference. */
function changedKeys(
  previous: Readonly<Record<string, unknown>> = {},
  next: Readonly<Record<string, unknown>> = {},
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => previous[key] !== next[key]).sort();
}

function editsForNode(previous: GraphNode, next: GraphNode): GraphEdit[] {
  const edits: GraphEdit[] = [];
  for (const key of Object.keys(NODE_FIELDS) as Array<keyof GraphNode>) {
    if (previous[key] === next[key]) continue;
    switch (NODE_FIELDS[key]) {
      case "layout":
        edits.push({ kind: "nodePosition" });
        break;
      case "parameters":
        edits.push({
          kind: "parameter",
          nodeId: next.id,
          parameters: changedKeys(previous.parameters, next.parameters),
        });
        break;
      case "ui":
        edits.push({
          kind: "nodeUi",
          nodeId: next.id,
          fields: changedKeys(previous.ui, next.ui),
        });
        break;
      case "resolution":
        edits.push({ kind: "nodeResolution", nodeId: next.id });
        break;
      case "format":
        edits.push({ kind: "nodeFormat", nodeId: next.id });
        break;
      case "structural":
        edits.push({ kind: "topology", nodeIds: [next.id] });
        break;
    }
  }
  return edits;
}

/**
 * Every edit between two revisions.
 *
 * `groups` and `viewport` are absent on purpose, and it is checked rather than assumed:
 * nothing in `src/compiler/` reads either, so a group rename or a camera move is
 * `editor-only` — which is also §V142 restated at this layer.
 */
/** Two edge records describe one connection: the same ends and order, whatever their route. */
function sameConnection(a: GraphEdge | undefined, b: GraphEdge | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.source.nodeId === b.source.nodeId &&
    a.source.portId === b.source.portId &&
    a.target.nodeId === b.target.nodeId &&
    a.target.portId === b.target.portId &&
    a.order === b.order
  );
}

export function graphEdits(previous: GraphDocument, next: GraphDocument): GraphEdit[] {
  if (previous === next) return [];

  const previousIds = Object.keys(previous.nodes);
  const nextIds = Object.keys(next.nodes);
  const added = nextIds.filter((id) => previous.nodes[id] === undefined);
  const removed = previousIds.filter((id) => next.nodes[id] === undefined);
  if (added.length > 0 || removed.length > 0) {
    return [{ kind: "topology", nodeIds: [...added, ...removed].sort() as NodeId[] }];
  }

  const edits: GraphEdit[] = [];

  // Connectivity. Reference-equal means the patch did not touch the edge map at all,
  // which is the common case for a value edit under immer.
  if (previous.edges !== next.edges) {
    const previousEdges = Object.keys(previous.edges).sort();
    const nextEdges = Object.keys(next.edges).sort();
    const rewired =
      previousEdges.length !== nextEdges.length ||
      previousEdges.some((id, index) => id !== nextEdges[index]) ||
      // §V131/T225: an edge can be REORDERED without appearing or disappearing, and
      // variadic order is the operation (layer order in a composite). Reference equality
      // catches that where a key comparison would not.
      //
      // T1821b (§V1040): a wire re-routed through a tie is a new object and the SAME
      // connection, so it is compared by what compiles — its ends and its order — and a
      // tie added, moved or removed is editor-only work, never a recompile or a reset.
      nextEdges.some((id) => !sameConnection(previous.edges[id], next.edges[id]));
    if (rewired) edits.push({ kind: "topology", nodeIds: nextIds.sort() as NodeId[] });
  }

  for (const nodeId of nextIds) {
    const before = previous.nodes[nodeId];
    const after = next.nodes[nodeId];
    if (before === undefined || after === undefined || before === after) continue;
    edits.push(...editsForNode(before, after));
  }

  return edits;
}

const NOTHING_CHANGED: RecompileDecision = {
  work: "editor-only",
  reason: "The document did not change.",
  nodes: [],
  resetFeedback: false,
};

/**
 * One revision, and the DOCUMENT it is a revision of (T519, B106).
 *
 * The identity is opaque and only ever compared for equality. It is minted where a
 * document is established — `createAppRuntime`, which is the only thing that opens a
 * project — so "a load establishes a new identity" is a property of the constructor
 * rather than a rule someone has to remember at each load site (§V437).
 */
export interface DocumentRevision {
  readonly identity: string;
  readonly graph: GraphDocument;
}

/**
 * Crossing a document boundary: rebuild everything, and say why.
 *
 * The STRONGEST work there is, with both clearing flags set. Not "topology": topology
 * means the shape of THIS document moved and the region downstream of the moved nodes
 * must be rebuilt, which still permits everything outside that region to be reused —
 * and reuse is precisely what must not happen here. Nothing carried from the previous
 * document is valid for this one, whatever its ids say (§V22, §V21).
 *
 * `nodes` is every node in the incoming document rather than a diff, for the same
 * reason: there is nothing to diff against.
 */
function documentReplaced(next: GraphDocument): RecompileDecision {
  return {
    work: "repropagate",
    reason:
      "A different document is open. A load is a discontinuity, not an edit: nothing from " +
      "the previous document may be reused, however its node ids compare (T519, B106).",
    nodes: Object.keys(next.nodes).sort() as NodeId[],
    resetFeedback: true,
    documentBoundary: true,
  };
}

/**
 * The one decision for a whole revision: the most expensive edit in it.
 *
 * A patch is atomic and can carry many operations (§V32), so a batch that moves a node
 * AND rewires it costs what the rewire costs. Taking the maximum is the only combination
 * that cannot under-report — and that MAXIMUM RULE is why the document check is a guard
 * ahead of the diff rather than another edit folded into it: a load has no cheapest
 * member to be the maximum of.
 */
export function classifyGraphChange(
  previous: DocumentRevision,
  next: DocumentRevision,
  registry: NodeRegistryView,
): RecompileDecision {
  // FIRST, and before anything looks at a node id.
  if (previous.identity !== next.identity) return documentReplaced(next.graph);
  const edits = graphEdits(previous.graph, next.graph);
  if (edits.length === 0) return NOTHING_CHANGED;
  const context = { graph: next.graph, registry };
  return edits
    .map((edit) => classifyEdit(edit, context))
    .reduce(strongest, classifyEdit(edits[0] as GraphEdit, context));
}

/**
 * T1652b — A VALUES-ONLY REVISION, defined ONCE. Every reader that asks "did only a value
 * move" asks `classifyRevision`; there is no second copy of this rule in a hook or a pane.
 *
 * ## Why it exists
 *
 * A slider moved by a hand (the Controls tab, the inspector, a phone, MIDI) is a document
 * revision like any other, and every revision re-rendered the composition root and re-ran
 * some twenty whole-document passes behind it: the structural compile, the requirement
 * diagnostics, the reference lines, every pane. Measured on a 152-node document: 57 to
 * 66 ms on the main thread per write, linear in the document and not in what changed. A
 * revision of this kind is not an event for the root (`revision-watch.ts`): its values
 * take the compiler's values lane (`rebaseOnValues`) and the surfaces that show a value
 * hear it themselves.
 *
 * ## What it IS
 *
 * Between two revisions of one document, EVERYTHING is the same object except, on one or
 * more nodes, stored parameters where:
 *
 *  - a STATIC literal moved: a number, a boolean, or a tuple of numbers of the same
 *    length (a vector, a colour), bare or as the `static` binding of a slot;
 *  - the slot's MODE and every other binding are the same objects;
 *  - the key is one no definition calls STRUCTURAL (`structuralParameterKeys`: declared
 *    `compileTime`, or read by a parameter resolution policy);
 *  - the node's EFFECTIVE SCHEMA is the same schema before and after (`parametersFor`:
 *    the same object, or one built anew that says the same), and every `inactiveWhen` of
 *    that schema answers the same before and after;
 *  - no HOST service reads the node's values off the root's document (`hostServed`).
 *
 * and, beside those, a bank or a cue list recording a recall it just made (`current`,
 * `standby`, `morphs`): the picture's values in that revision are the targets' numbers,
 * the record is which preset the holder shows as current and which fades it started. That
 * is what lets a recall of thirty values be ONE values pass.
 *
 * ## What it is NOT (each sends the revision down the structural road, by name)
 *
 *  - a node added, removed, renamed, moved or resized; a wire; a group; the viewport;
 *  - a UI field (preview, bypass, pin), a resolution, a format, a channel mask;
 *  - a parameter stored for the first time, or one removed (the key set moved);
 *  - a MODE change, an expression's source, a bind, a map, a driven channel;
 *  - a STRING of any kind: an enum, a name another node is read by, a file, a caption, a
 *    board, shader or preset text. And a ramp's stops or any other structured value;
 *  - a key the definitions call structural (a Light's kind, a count that sizes a buffer);
 *  - a value the node's own SCHEMA follows (`parametersFor`: a control's stored default,
 *    a grid's rows) or that changes what APPLIES (`inactiveWhen`);
 *  - any parameter of a node a host service reads (`hostServed`: a movie, a camera, a
 *    Text, an audio track, a mesh, a model, a Syphon or NDI session, a window, OSC, the
 *    laser), of a node whose runtime requirements are chosen by a value (`requires` as a
 *    function), of a component instance (flattening writes its values onto the
 *    internals), or of a type this build does not have.
 *
 * Conservative in one direction, like the classifier above: every doubt is `structure`,
 * which costs what every revision cost before this existed. `reason` says which rule
 * refused, so a write that should have been cheap and was not can be found (the
 * performance panel counts them).
 *
 * It answers about the DOCUMENT. Whether the compiled plan can follow without a structural
 * compile is the lane's own question, asked against the plan under §V936's verifier, and
 * a refusal there escalates the same way.
 */
export type RevisionKind =
  | {
      readonly kind: "values";
      /** The nodes a value moved on, sorted by id. */
      readonly written: readonly NodeId[];
    }
  | {
      readonly kind: "structure";
      /** The first rule the revision failed, naming the node and key where there is one. */
      readonly reason: string;
    };

/**
 * How a top-level field of the document is read when it differs. Keyed by
 * `keyof GraphDocument`, so a field added to the type stops this file compiling until
 * someone says whether a values-only revision may move it.
 */
const DOCUMENT_FIELDS: Record<keyof GraphDocument, "revision" | "nodes" | "structure"> = {
  revision: "revision",
  nodes: "nodes",
  edges: "structure",
  groups: "structure",
  viewport: "structure",
  // T1821b: the canvas redraws for a moved tie; the compiler never reads one (`graphEdits`).
  ties: "structure",
};

/**
 * What a bank and a cue list write about THEMSELVES when they recall: which preset or cue
 * is current, which stands by, the fades started. `classify-revision.test.ts` holds the
 * bank's two keys against `bankOf`'s own view.
 */
export const RECALL_RECORD_KEYS: Readonly<Record<string, readonly string[]>> = {
  [PRESETS_NODE_TYPE]: ["current", "morphs"],
  [CUE_LIST_NODE_TYPE]: ["current", "standby"],
};

/**
 * THE NODES A HOST SERVICE READS, and why their values are the composition root's business.
 *
 * The root hands its document to the services that stand behind a node outside the plan: a
 * movie element, a camera, the text raster, an audio track, a mesh file, a model, a
 * Syphon or NDI session, a perform window, the OSC and laser doors (`useMediaSources`,
 * `useAudioInput`, `useMeshSources`, `useNativeInputs`, …). They read stored numbers from
 * that document — a movie's speed, a text's size and colour, a mesh's frame — and they
 * hear a change by the root rendering. So a value written on one of these nodes stays a
 * revision the root renders for, exactly as before.
 *
 * (An expression on such a node that reads a control is not a write on it: the service
 * resolves it at its own tick through the live channels, as it always did.)
 *
 * By declaration where there is one — the two shelves that are nothing else (`input`,
 * `output`), and every definition that says it has a side effect, needs something of the
 * machine, listens on a port, is measured from a readback or is a sink — and by name for
 * the few with a CPU source or a model behind them and no such trait.
 * `classify-revision.test.ts` holds the names against the node types the host services'
 * own sources mention.
 */
const HOST_SHELVES: ReadonlySet<string> = new Set(["input", "output"]);
export const HOST_SERVED_TYPES: ReadonlySet<string> = new Set(["text", "meshFileIn", "matte", "personMask", "depth", "pose", "analyze"]);

/** Why this node type's values are read by a host service, or null when none reads them. */
export function hostServed(definition: NodeDefinition): string | null {
  const read = "is served by the host, which reads its values off the root's document";
  if (HOST_SHELVES.has(definition.category) || HOST_SERVED_TYPES.has(definition.type)) return `${read}.`;
  if (definition.sideEffect !== undefined) return `${read} (a side effect).`;
  if (definition.requires !== undefined) return `${read} (a runtime requirement).`;
  if (definition.listensOn !== undefined) return `${read} (a listener).`;
  if (definition.measuredChannel === true) return `${read} (a measured channel).`;
  if (definition.sink === true) return `${read} (a sink).`;
  return null;
}

const structural = (reason: string): RevisionKind => ({ kind: "structure", reason });

/** A number, a boolean, or a tuple of numbers: the only literals a values-only revision moves. */
function isMovable(value: unknown): value is number | boolean | readonly number[] {
  if (typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "number");
}

function sameShape(before: number | boolean | readonly number[], after: number | boolean | readonly number[]): boolean {
  if (typeof before !== "object") return typeof before === typeof after;
  return typeof after === "object" && before.length === after.length;
}

/** Why one stored parameter's change is not a static literal moving, or null when it is one. */
function notAMovedLiteral(before: unknown, after: unknown): string | null {
  let from: unknown = before;
  let to: unknown = after;
  if (isParameterSlot(before) !== isParameterSlot(after)) return "went between a bare value and a slot";
  if (isParameterSlot(before) && isParameterSlot(after)) {
    if (before.mode !== after.mode) return `changed mode (${before.mode} to ${after.mode})`;
    const bindingsBefore = before.bindings as Readonly<Record<string, unknown>>;
    const bindingsAfter = after.bindings as Readonly<Record<string, unknown>>;
    for (const kind of new Set([...Object.keys(bindingsBefore), ...Object.keys(bindingsAfter)])) {
      if (kind !== "static" && bindingsBefore[kind] !== bindingsAfter[kind]) return `changed its ${kind} binding`;
    }
    const staticBefore = before.bindings.static;
    const staticAfter = after.bindings.static;
    if (staticBefore?.kind !== "static" || staticAfter?.kind !== "static") return "gained or lost its static binding";
    from = staticBefore.value;
    to = staticAfter.value;
  }
  if (!isMovable(from) || !isMovable(to)) return "holds something other than a number, a boolean or a tuple of numbers";
  if (!sameShape(from, to)) return "changed the shape of its value";
  return null;
}

/**
 * Whether two effective schemas are the same schema. Most definitions hand back the same
 * object for the same stored parameters; one that builds its schema per call (a point
 * kernel reflecting its `struct Params`) hands back an equal one, and that is compared
 * field by field. A FUNCTION that is not the same object is never called equal: two
 * closures cannot be proven to answer alike, and a doubt is `structure`.
 */
function sameSchema(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || depth > 6) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const keys = Object.keys(left);
  const others = Object.keys(right);
  if (keys.length !== others.length) return false;
  // Key ORDER is part of a schema: it is the order the inspector and the diagnostics read in.
  return keys.every((key, index) => others[index] === key && sameSchema(left[key], right[key], depth + 1));
}

/** The `inactiveWhen` answers of a node's schema, in key order; null when the schema has none. */
function appliesOf(node: GraphNode, definition: NodeDefinition, schema: ReturnType<typeof effectiveParameterSchema>): string | null {
  const keys = Object.keys(schema).filter((key) => schema[key]?.inactiveWhen !== undefined);
  if (keys.length === 0) return null;
  const values = resolveStored(node, definition).values;
  return keys.map((key) => `${key}:${schema[key]?.inactiveWhen?.(values) ?? ""}`).join("\u0000");
}

/** Why one node's change is not values-only, or null when it is. */
function nodeMovedMoreThanValues(before: GraphNode, after: GraphNode, registry: NodeRegistryView): string | null {
  const named = `Node "${after.label ?? after.id}"`;
  for (const field of Object.keys(NODE_FIELDS) as Array<keyof GraphNode>) {
    if (field !== "parameters" && before[field] !== after[field]) return `${named} changed its ${field}.`;
  }
  const keysAfter = Object.keys(after.parameters);
  if (Object.keys(before.parameters).length !== keysAfter.length || keysAfter.some((key) => !(key in before.parameters))) {
    return `${named} stores a different set of parameters.`;
  }
  const definition = registry.get(after.type);
  if (definition === undefined) return `${named} is of a type this build does not have.`;
  if (isComponentNodeType(after.type)) return `${named} is a component instance: flattening writes its values onto its internals.`;
  if (typeof definition.requires === "function") return `${named} chooses its runtime requirements from its values.`;
  const host = hostServed(definition);
  if (host !== null) return `${named} ${host}`;

  const record = RECALL_RECORD_KEYS[after.type] ?? [];
  const moved: string[] = [];
  for (const key of keysAfter) {
    if (before.parameters[key] === after.parameters[key]) continue;
    if (record.includes(key)) continue;
    const refusal = notAMovedLiteral(before.parameters[key], after.parameters[key]);
    if (refusal !== null) return `${named} parameter "${key}" ${refusal}.`;
    moved.push(key);
  }
  if (moved.length === 0) return null;

  const schema = effectiveParameterSchema(definition, after.parameters);
  if (!sameSchema(schema, effectiveParameterSchema(definition, before.parameters))) {
    return `${named} has a schema that follows the value written (parametersFor).`;
  }
  const structuralKeys = structuralParameterKeys(definition, after.parameters);
  for (const key of moved) {
    if (structuralKeys.has(key.split(".")[0] as string)) {
      return `${named} parameter "${key}" is structural (compileTime or a resolution policy input).`;
    }
  }
  if (appliesOf(before, definition, schema) !== appliesOf(after, definition, schema)) {
    return `${named} changed which of its parameters apply (inactiveWhen).`;
  }
  return null;
}

/** What kind of revision `next` is of `previous`: only values moved, or anything else. */
export function classifyRevision(previous: GraphDocument, next: GraphDocument, registry: NodeRegistryView): RevisionKind {
  if (previous === next) return structural("The document did not move.");
  for (const field of Object.keys(DOCUMENT_FIELDS) as Array<keyof GraphDocument>) {
    if (DOCUMENT_FIELDS[field] === "structure" && previous[field] !== next[field]) return structural(`The document's ${field} changed.`);
  }
  if (previous.nodes === next.nodes) return structural("No node changed.");
  const ids = Object.keys(next.nodes) as NodeId[];
  if (ids.length !== Object.keys(previous.nodes).length) return structural("A node was added or removed.");
  const written: NodeId[] = [];
  for (const id of ids) {
    const before = previous.nodes[id];
    const after = next.nodes[id];
    if (before === undefined || after === undefined) return structural("A node was added or removed.");
    if (before === after) continue;
    const refusal = nodeMovedMoreThanValues(before, after, registry);
    if (refusal !== null) return structural(refusal);
    written.push(id);
  }
  if (written.length === 0) return structural("No node changed.");
  return { kind: "values", written: written.sort() };
}
