import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { isParameterSlot } from "../parameters/slots.ts";
import { sourceReferenceTokens, sourceReferencesOf } from "./source-references.ts";

/**
 * Node names as identifiers (T221/T222, §V127-§V129).
 *
 * TD's `op('noise1')` only resolves because a name is unique within its network. Our
 * `label` used to be a decoration; these functions make it the NAME: unique per graph,
 * auto-numbered on create (`noise1`, `noise2`), auto-suffixed on a rename collision
 * rather than rejected — the user's intent is the word, the number is bookkeeping
 * (§V129). A node without a label (legacy documents) simply is not addressable by name
 * until it is renamed; nothing breaks, nothing is retro-named.
 *
 * §V128 lives in `rewriteNodeNameReferences`: a rename must rewrite every reference
 * naming that node IN THE SAME PATCH, or renaming silently breaks the reference. The
 * reference syntax (`op('name')`) enters the expression grammar later — but the strings
 * it will live in are stored TODAY (expression binding sources, §V71), so the rewrite
 * is defined now and rename is graph-wide from day one, never a node-local field edit.
 */

/** The node's name, when it has one. Only labels compete for uniqueness. */
export function nodeName(node: GraphNode): string | undefined {
  return node.label;
}

/**
 * The numbering base a node type creates under: the last dotted segment of the type,
 * lowercased, stripped to word characters — `core.noise` names `noise1`, `noise2`.
 */
export function nameBaseFor(type: string): string {
  const segment = type.split(".").at(-1) ?? type;
  const base = segment.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return base.length > 0 ? base : "node";
}

/** name → node id, for every named node. Later duplicates (legacy documents) lose. */
export function nodeNames(graph: GraphDocument): Map<string, NodeId> {
  const names = new Map<string, NodeId>();
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const label = graph.nodes[nodeId]?.label;
    if (label !== undefined && !names.has(label)) names.set(label, nodeId);
  }
  return names;
}

export function nodeByName(graph: GraphDocument, name: string): NodeId | undefined {
  return nodeNames(graph).get(name);
}

/**
 * A free name for a NEW node: always numbered, TD-style (`noise1` even when alone), so
 * creation order reads off the canvas and a bare `noise` stays available as a deliberate
 * rename rather than an accident of being first.
 */
export function uniqueNodeName(graph: GraphDocument, base: string): string {
  const taken = new Set(nodeNames(graph).keys());
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `${base}${ordinal}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The name a RENAME resolves to (§V129): the requested name itself when free, else the
 * word with the next free number appended. `excludeNodeId` is the node being renamed —
 * renaming a node to the name it already has is a no-op, not a collision with itself.
 */
export function resolveRename(graph: GraphDocument, requested: string, excludeNodeId: NodeId): string {
  const taken = nodeNames(graph);
  const holder = taken.get(requested);
  if (holder === undefined || holder === excludeNodeId) return requested;
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${requested}${ordinal}`;
    const candidateHolder = taken.get(candidate);
    if (candidateHolder === undefined || candidateHolder === excludeNodeId) return candidate;
  }
}

/** Matches `op('name')` / `op("name")`, the coming reference syntax, name captured. */
const referencePattern = (name: string): RegExp =>
  new RegExp(String.raw`op\(\s*(['"])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\1\s*\)`, "g");

/**
 * §V128: rewrites every stored reference to `oldName` into one to `newName`, across the
 * whole graph, in place on the (draft) document. References live in expression binding
 * sources; the count returned is how many SOURCES changed — the caller reports it so a
 * rename that silently touched twelve expressions is visible in the patch result.
 */
export function rewriteNodeNameReferences(
  graph: GraphDocument,
  oldName: string,
  newName: string,
): number {
  if (oldName === newName) return 0;
  let rewritten = 0;
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    for (const clause of REFERENCE_CLAUSES) rewritten += clause(node, oldName, newName);
  }
  return rewritten;
}

/**
 * How many stored references name `name` — what a CLEAR of the label would strand.
 *
 * B88: this used to scan expressions ALONE while the rewrite above handled four kinds,
 * so clearing a label reported zero stranded references while driven, source and list
 * references all pointed at the vanished name. Count and rewrite now share ONE clause
 * list, and each clause is a single walker asked either question — so a fifth reference
 * kind cannot teach the rename and forget the count, which is §V316's clause-per-kind
 * applied to the PAIR rather than to each copy.
 */
export function countNodeNameReferences(graph: GraphDocument, name: string): number {
  let count = 0;
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    for (const clause of REFERENCE_CLAUSES) count += clause(node, name, null);
  }
  return count;
}

/*
 * §V128 says "every stored reference", and §V316 says an invariant stated over a
 * CATEGORY but implemented over one MEMBER narrows silently — which is exactly what
 * happened here twice (B40: rename scanned only expressions; B88: the COUNT still did,
 * years of clauses later). One clause PER REFERENCE KIND, and one FUNCTION per clause
 * answering both questions — `rename === null` counts, a string rewrites — so the two
 * surfaces cannot drift apart again: they are the same walk.
 */
type ReferenceClause = (node: GraphNode, name: string, rename: string | null) => number;

/** Kind 1: `op('name')` inside expression payloads (the original clause). */
const expressionClause: ReferenceClause = (node, name, rename) => {
  const pattern = referencePattern(name);
  let touched = 0;
  for (const key of Object.keys(node.parameters).sort()) {
    const stored = node.parameters[key];
    if (stored === undefined || !isParameterSlot(stored)) continue;
    const binding = stored.bindings.expression;
    if (binding?.kind !== "expression") continue;
    pattern.lastIndex = 0;
    if (!pattern.test(binding.source)) continue;
    if (rename !== null) {
      const source = binding.source.replace(referencePattern(name), (_match, quote: string) => `op(${quote}${rename}${quote})`);
      node.parameters[key] = {
        ...stored,
        bindings: { ...stored.bindings, expression: { kind: "expression", source } },
      };
    }
    touched += 1;
  }
  return touched;
};

/** Kind 2 (B40): `driven` channels — `name` or `name:channel`, the part before the colon. */
const drivenChannelClause: ReferenceClause = (node, name, rename) => {
  let touched = 0;
  for (const key of Object.keys(node.parameters).sort()) {
    const stored = node.parameters[key];
    if (stored === undefined || !isParameterSlot(stored)) continue;
    const binding = stored.bindings.driven;
    if (binding?.kind !== "driven") continue;
    const colon = binding.channel.indexOf(":");
    const head = colon < 0 ? binding.channel : binding.channel.slice(0, colon);
    if (head !== name) continue;
    if (rename !== null) {
      const channel = colon < 0 ? rename : `${rename}${binding.channel.slice(colon)}`;
      node.parameters[key] = {
        ...stored,
        bindings: { ...stored.bindings, driven: { kind: "driven", channel } },
      };
    }
    touched += 1;
  }
  return touched;
};

/**
 * Kind 3 (T350) and kind 4 (T447): source-reference parameters holding a bare name, or
 * a LIST of names. The list clause is token-wise — only whole names matching the target
 * move, separators and order preserved — because list order is draw/light order and a
 * rename must not reshuffle the scene.
 */
const sourceReferenceClause: ReferenceClause = (node, name, rename) => {
  let touched = 0;
  for (const spec of sourceReferencesOf(node.type)) {
    const stored = node.parameters[spec.parameter];
    if (typeof stored !== "string") continue;
    if (spec.list === true) {
      if (!sourceReferenceTokens(spec, node.parameters).includes(name)) continue;
      if (rename !== null) {
        node.parameters[spec.parameter] = stored
          .split(/([\s,]+)/)
          .map((piece) => (piece === name ? rename : piece))
          .join("");
      }
      touched += 1;
    } else if (stored.trim() === name) {
      if (rename !== null) node.parameters[spec.parameter] = rename;
      touched += 1;
    }
  }
  return touched;
};

const REFERENCE_CLAUSES: readonly ReferenceClause[] = [
  expressionClause,
  drivenChannelClause,
  sourceReferenceClause,
];

/**
 * A free name derived from a TAKEN one (B41/B44): trailing digits strip to the word,
 * and the next free number appends — `over1` renames to `over2`, not to `over12`.
 *
 * One helper because the collision loop existed in three copies (flatten, the detached
 * component copy, paste) with identical semantics — the V320 class shape arriving in
 * the FIX. `taken` is a predicate so each caller folds its own reserved sets in.
 */
export function renumberedName(label: string, taken: (candidate: string) => boolean): string {
  const stripped = label.replace(/[0-9]+$/, "");
  const base = stripped.length > 0 ? stripped : label;
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `${base}${ordinal}`;
    if (!taken(candidate)) return candidate;
  }
}
