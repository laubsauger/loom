import type { ProjectDocument } from "../types/graph.ts";
import { projectDocumentSchema } from "../types/schemas.ts";

/**
 * THE project serializer (T43 groundwork, T101): manual save to `.loom.json` and
 * autosave snapshots MUST both go through these two functions, so a snapshot is the
 * same document a save would have written — one serializer, §V10 applies to both.
 *
 * Serialization is deterministic: object keys are emitted sorted, so the same document
 * always produces byte-identical text (doc §19.1) and snapshot dedup can compare
 * strings cheaply. Runtime state never appears here because it never enters the
 * document store in the first place (§V16).
 */

export function serializeProjectDocument(document: ProjectDocument): string {
  return JSON.stringify(sortKeysDeep(document), null, 2);
}

export type ParseProjectResult =
  | { ok: true; document: ProjectDocument }
  | { ok: false; reason: string };

export function parseProjectDocument(text: string): ParseProjectResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const result = projectDocumentSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "document" : issue.path.join(".");
    return { ok: false, reason: `${path}: ${issue?.message ?? "invalid document"}` };
  }
  return { ok: true, document: result.data as ProjectDocument };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
