import { arePortsCompatible, describePortType } from "@domain/graph/port-compat.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { PortDefinition, PortType } from "@domain/types/ports.ts";

/**
 * Node library search and compatibility filtering (T39).
 *
 * Two questions, one module:
 *  1. "what is called blur?" — ranked text search over the manifest.
 *  2. "what can I connect this to?" — §V13 compatibility, and nothing looser.
 *
 * (2) delegates entirely to `arePortsCompatible`. It is not re-implemented, not
 * relaxed to "similar", and not widened to "same kind": offering a node the graph will
 * then refuse to connect is worse than offering nothing, and §V13's whole point is that
 * a near miss means a conversion node is missing, not that the check is too strict.
 */

export interface ScoredDefinition {
  definition: NodeDefinition;
  score: number;
}

const EXACT = 100;
const PREFIX = 80;
const WORD_PREFIX = 60;
const SUBSTRING = 40;
const TAG = 30;
const CATEGORY = 20;
const DESCRIPTION = 10;

function wordPrefixHit(haystack: string, needle: string): boolean {
  return haystack.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle));
}

/** Relevance of one definition for a query, or null when it does not match at all. */
export function matchScore(definition: NodeDefinition, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 0;

  const title = definition.title.toLowerCase();
  const type = definition.type.toLowerCase();

  if (title === needle || type === needle) return EXACT;
  if (title.startsWith(needle) || type.startsWith(needle)) return PREFIX;
  if (wordPrefixHit(title, needle) || wordPrefixHit(type, needle)) return WORD_PREFIX;
  if (title.includes(needle) || type.includes(needle)) return SUBSTRING;
  if ((definition.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))) return TAG;
  if (definition.category.toLowerCase().includes(needle)) return CATEGORY;
  if ((definition.description ?? "").toLowerCase().includes(needle)) return DESCRIPTION;
  return null;
}

/** Ranked search. Ties break on title so the list never reshuffles between renders. */
export function searchDefinitions(
  definitions: readonly NodeDefinition[],
  query: string,
): NodeDefinition[] {
  const scored: ScoredDefinition[] = [];
  for (const definition of definitions) {
    const score = matchScore(definition, query);
    if (score === null) continue;
    scored.push({ definition, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.definition.title.localeCompare(b.definition.title),
  );
  return scored.map((entry) => entry.definition);
}

/** The port the user is dragging from, and which end of an edge it is. */
export interface PortDragQuery {
  type: PortType;
  /** "output" — looking for a node to feed. "input" — looking for a node to feed it. */
  direction: "output" | "input";
}

export interface CompatibleMatch {
  definition: NodeDefinition;
  /** The port that would receive (or supply) the dragged edge. */
  port: PortDefinition;
}

/**
 * Nodes that can legally complete the dragged edge (§V13).
 *
 * Dragging from an output looks for a compatible INPUT; dragging from an input looks
 * for a compatible OUTPUT — and the compatibility call always runs source-to-target, in
 * that order, because that is the direction the connect operation will validate.
 */
export function compatibleDefinitions(
  definitions: readonly NodeDefinition[],
  drag: PortDragQuery,
): CompatibleMatch[] {
  const matches: CompatibleMatch[] = [];
  for (const definition of definitions) {
    const candidates = drag.direction === "output" ? definition.inputs : definition.outputs;
    const port = candidates.find((candidate) =>
      drag.direction === "output"
        ? arePortsCompatible(drag.type, candidate.type)
        : arePortsCompatible(candidate.type, drag.type),
    );
    if (port === undefined) continue;
    matches.push({ definition, port });
  }
  return matches;
}

export interface LibraryFilter {
  query?: string;
  category?: string | null;
  portDrag?: PortDragQuery | null;
}

/**
 * The list the pane renders: compatibility first (it is a hard constraint), then
 * category, then ranked text search.
 */
export function filterLibrary(
  definitions: readonly NodeDefinition[],
  filter: LibraryFilter = {},
): NodeDefinition[] {
  let pool = [...definitions];

  if (filter.portDrag !== undefined && filter.portDrag !== null) {
    pool = compatibleDefinitions(pool, filter.portDrag).map((match) => match.definition);
  }
  if (filter.category !== undefined && filter.category !== null) {
    pool = pool.filter((definition) => definition.category === filter.category);
  }

  const query = filter.query ?? "";
  if (query.trim() === "") {
    return pool.sort((a, b) => a.title.localeCompare(b.title));
  }
  return searchDefinitions(pool, query);
}

export interface CategoryBucket {
  category: string;
  definitions: readonly NodeDefinition[];
}

/** Groups a result list by category, categories alphabetical, members in list order. */
export function groupByCategory(definitions: readonly NodeDefinition[]): CategoryBucket[] {
  const buckets = new Map<string, NodeDefinition[]>();
  for (const definition of definitions) {
    const bucket = buckets.get(definition.category);
    if (bucket === undefined) buckets.set(definition.category, [definition]);
    else bucket.push(definition);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, members]) => ({ category, definitions: members }));
}

const TEXTURE_CHANNEL_LABEL: Readonly<Record<1 | 2 | 4, string>> = {
  1: "single-channel",
  2: "two-channel",
  4: "RGBA",
};

/**
 * Short, human label for a port type — for the drag banner, NOT for diagnostics (T167).
 *
 * `describePortType` (§V57) is deliberately diagnostic-shaped: it spells out sample
 * type, channel count and colour space so a mismatch message can say exactly which
 * property differs. That is the wrong string to hand someone mid-drag — they need "will
 * this connect", not a type signature to parse. Colour space is left out here on
 * purpose: `arePortsCompatible` already enforces an exact match, so the library only
 * ever offers ports that DO accept the drag, and no name in this list carries angle
 * brackets or generic syntax.
 */
export function friendlyPortLabel(type: PortType): string {
  switch (type.kind) {
    case "texture2d": {
      const prefix = type.channels === undefined ? "" : `${TEXTURE_CHANNEL_LABEL[type.channels]} `;
      return `${prefix}texture`;
    }
    case "buffer":
      return "buffer";
    case "scalar":
      return "number";
    case "vector":
      return `${type.size}D vector`;
    case "matrix":
      return `${type.columns}×${type.rows} matrix`;
    case "pointset":
      return "point set";
    case "material":
      return "material";
    case "scene":
      return "scene";
    case "camera":
      return "camera";
    case "light":
      return "light";
    case "projector":
      return "projector";
    case "transform3d":
      return "transform";
    case "event":
      return "event";
    case "audioFeatures":
      return "audio features";
    case "value":
      return "value";
    default: {
      // Exhaustiveness guard: a new PortType member must be handled explicitly.
      const never: never = type;
      void never;
      return "port";
    }
  }
}

/** Human-readable summary of a dragged port, for the "compatible with…" banner. */
export function describeDrag(drag: PortDragQuery): string {
  return friendlyPortLabel(drag.type);
}

/**
 * The precise, diagnostic-shaped form (§V57) — still reachable as a tooltip so someone
 * who DOES want the exact sample/channel/space signature is one hover away.
 */
export function describeDragPrecisely(drag: PortDragQuery): string {
  return describePortType(drag.type);
}
