import { compareExamples } from "./example-catalogue.ts";
import type { ExampleProject } from "./example-catalogue.ts";
import { entryScore } from "./search.ts";

/**
 * Example library search and category filtering (T846).
 *
 * The mirror of `search.ts`, deliberately: same relevance ladder, same "filter then
 * rank" shape, same names one noun over. What it does NOT do is re-derive the ranking —
 * `entryScore` is the node library's own tiers, extracted rather than copied (§V748), so
 * the two catalogues cannot come to disagree about what "a good match" means.
 *
 * There is no port-drag half here and there should not be: a node answers "what can I
 * connect this to?", an example answers "which one is this?". The compatibility question
 * has no meaning for a document you are about to open.
 */

/**
 * The example's fields, mapped onto the searchable record.
 *
 * `key` is the file STEM, not the file name. `E44-Sounding.loom.json` word-splits to
 * `["e44","sounding","loom","json"]`, and those last two are real word-prefix hits — a
 * search for "js" or "loo" would rank every example equally, which is a search box that
 * has stopped answering. The stem carries only what the author named.
 *
 * No `tags`: nothing authors them for examples, and an always-empty field is a tier that
 * silently never fires.
 */
function entryFor(example: ExampleProject): Parameters<typeof entryScore>[0] {
  return {
    title: example.name,
    key: example.fileName.replace(/\.loom\.json$/, ""),
    category: example.category,
    description: example.description,
  };
}

/** Relevance of one example for a query, or null when it does not match at all. */
export function matchExampleScore(example: ExampleProject, query: string): number | null {
  return entryScore(entryFor(example), query);
}

/**
 * Ranked search.
 *
 * Ties break on the catalogue's own natural order rather than on the name, so a tied run
 * reads E9, E10, E11 — `localeCompare` would file E10 between E1 and E2, which is the
 * exact complaint that put the numeric collator in `example-catalogue.ts` (§V487: one
 * ordering, one derivation).
 */
export function searchExamples(
  examples: readonly ExampleProject[],
  query: string,
): ExampleProject[] {
  const scored: { example: ExampleProject; score: number }[] = [];
  for (const example of examples) {
    const score = matchExampleScore(example, query);
    if (score === null) continue;
    scored.push({ example, score });
  }
  scored.sort((a, b) => b.score - a.score || compareExamples(a.example, b.example));
  return scored.map((entry) => entry.example);
}

export interface ExampleFilter {
  query?: string;
  category?: string | null;
}

/** The list the pane renders: category first (a hard filter), then ranked text search. */
export function filterExamples(
  examples: readonly ExampleProject[],
  filter: ExampleFilter = {},
): ExampleProject[] {
  let pool = [...examples];

  if (filter.category !== undefined && filter.category !== null) {
    pool = pool.filter((example) => example.category === filter.category);
  }

  const query = filter.query ?? "";
  if (query.trim() === "") return pool.sort(compareExamples);
  return searchExamples(pool, query);
}
