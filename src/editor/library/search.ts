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

/**
 * The five fields any catalogue entry offers a search (T846).
 *
 * `key` is the entry's machine name — a node's `type`, an example's file stem. It is
 * scored beside the title because people search for both: "blur" is a type, "Gaussian
 * Blur" is a title, and a catalogue that only indexed one of them would miss half the
 * queries put to it.
 */
export interface SearchableEntry {
  readonly title: string;
  readonly key: string;
  // Explicitly `| undefined` under `exactOptionalPropertyTypes`: a definition whose
  // `tags` is present-and-undefined has to be assignable, or every caller needs a spread.
  readonly tags?: readonly string[] | undefined;
  readonly category: string;
  readonly description?: string | undefined;
}

/**
 * THE relevance tiers — one ladder, and the only one (T846, §V748).
 *
 * Extracted from `matchScore` when the example library needed the same ranking over a
 * different record type. §V748's rule for an extraction is identity at the incumbent's
 * parameters: this is the node ladder verbatim, with `type` renamed to `key`, and
 * `search.test.ts` is the pin — it was not touched when this moved, so it still asserts
 * the node library's ranking on the same fixtures and would redden on any drift.
 *
 * A second ladder would have been the drift §V487 describes: two scoring policies that
 * agree until someone tunes one of them.
 */
export function entryScore(entry: SearchableEntry, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 0;

  const title = entry.title.toLowerCase();
  const key = entry.key.toLowerCase();

  if (title === needle || key === needle) return EXACT;
  if (title.startsWith(needle) || key.startsWith(needle)) return PREFIX;
  if (wordPrefixHit(title, needle) || wordPrefixHit(key, needle)) return WORD_PREFIX;
  if (title.includes(needle) || key.includes(needle)) return SUBSTRING;
  if ((entry.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))) return TAG;
  if (entry.category.toLowerCase().includes(needle)) return CATEGORY;
  if ((entry.description ?? "").toLowerCase().includes(needle)) return DESCRIPTION;
  return null;
}

/** Relevance of one definition for a query, or null when it does not match at all. */
export function matchScore(definition: NodeDefinition, query: string): number | null {
  return entryScore(
    {
      title: definition.title,
      key: definition.type,
      tags: definition.tags,
      category: definition.category,
      description: definition.description,
    },
    query,
  );
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

/**
 * THE category list — derived from the manifest, and the only derivation of it (T732).
 *
 * Two surfaces filter by category: the library pane's "all categories ▾" dropdown and
 * the node browser's tab strip. Both call this. Neither hand-lists the categories and
 * neither re-derives them, because §V487 is precisely a value with two derivations that
 * agree until one of them is edited — this project spent an afternoon today on two
 * hand-maintained orbit branches that had drifted apart exactly that way.
 *
 * §T675's rule, applied: a NEW category becomes impossible to forget rather than
 * something someone has to remember. Adding a node with `category: "physics"` puts a
 * "physics" tab in the browser and a "physics" row in the dropdown with no other edit,
 * and there is no second list that can be left behind.
 *
 * Sorted, so the two surfaces present the same order as well as the same members —
 * "same set, different order" is a drift a set comparison would not catch.
 *
 * Generic since T846: the example library's category filter is a THIRD surface asking
 * the same question of a different record, and §V754 says a new reason to do X becomes a
 * new input to the existing policy rather than a new policy. Node callers are unchanged.
 */
export function categoriesOf(items: readonly { readonly category: string }[]): string[] {
  return [...new Set(items.map((item) => item.category))].sort();
}

export interface CategoryBucket {
  category: string;
  definitions: readonly NodeDefinition[];
}

export interface Grouped<T> {
  category: string;
  items: readonly T[];
}

/**
 * THE grouping — categories alphabetical, members in list order, and the only one.
 *
 * Generic since T846/§T863, for the same reason `entryScore` is: the example pane groups
 * its rows exactly as the node pane groups its own, and a second implementation is a
 * second set of ordering rules to keep in step. `groupByCategory` below is the node
 * library's name for it, kept so no node caller changes (§V748).
 *
 * Members keep the LIST order they arrived in, which means a ranked search stays ranked
 * inside each bucket — grouping re-shelves the results, it does not re-sort them.
 */
export function groupEntries<T extends { readonly category: string }>(
  items: readonly T[],
): Grouped<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const bucket = buckets.get(item.category);
    if (bucket === undefined) buckets.set(item.category, [item]);
    else bucket.push(item);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, members]) => ({ category, items: members }));
}

/** Groups a result list by category, categories alphabetical, members in list order. */
export function groupByCategory(definitions: readonly NodeDefinition[]): CategoryBucket[] {
  return groupEntries(definitions).map(({ category, items }) => ({
    category,
    definitions: items,
  }));
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
