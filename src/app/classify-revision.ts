import { classifyEdit } from "@compiler/index.ts";
import type { GraphEdit, RecompileDecision, RecompileWork } from "@compiler/index.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
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
 * and redo replay inverses, a project load replaces everything, and an agent's patch
 * arrives by the same door as a human's. Classifying the RESULT covers all of them with
 * one rule. It is also cheap in exactly the way that matters — the store applies patches
 * through immer, so an untouched node keeps its object identity and the diff is a walk of
 * reference comparisons, not a deep equality check.
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
      nextEdges.some((id) => previous.edges[id] !== next.edges[id]);
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
  recreateTargets: false,
  resetFeedback: false,
};

/**
 * The one decision for a whole revision: the most expensive edit in it.
 *
 * A patch is atomic and can carry many operations (§V32), so a batch that moves a node
 * AND rewires it costs what the rewire costs. Taking the maximum is the only combination
 * that cannot under-report.
 */
export function classifyGraphChange(
  previous: GraphDocument,
  next: GraphDocument,
  registry: NodeRegistryView,
): RecompileDecision {
  const edits = graphEdits(previous, next);
  if (edits.length === 0) return NOTHING_CHANGED;
  const context = { graph: next, registry };
  return edits
    .map((edit) => classifyEdit(edit, context))
    .reduce(strongest, classifyEdit(edits[0] as GraphEdit, context));
}
