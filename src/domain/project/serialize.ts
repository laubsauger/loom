import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { ProjectDocument } from "../types/graph.ts";
import type { AppliedMigration, DocumentMigration } from "../migrations/index.ts";
import { migrateProjectDocument } from "../migrations/index.ts";
import {
  classifyUnknownParameters,
  openProjectDocumentSchema,
  unknownParameterDiagnostics,
  type UnknownParameter,
} from "./forward-compat.ts";

/**
 * THE project serializer (T43, T91, T101): manual save to `.loom.json` and autosave
 * snapshots MUST both go through these two functions, so a snapshot is the same document
 * a save would have written — one serializer, §V10 applies to both.
 *
 * Serialization is deterministic: object keys are emitted sorted, so the same document
 * always produces byte-identical text (doc §19.1) and snapshot dedup can compare
 * strings cheaply. Runtime state never appears here because it never enters the
 * document store in the first place (§V16).
 *
 * `sortKeysDeep` walks whatever it is handed, so a field this build has never heard of
 * rides back out exactly as it came in. That, plus the passthrough parse below, is the
 * whole mechanism behind §V68: nothing is re-derived from a list of known fields, so
 * there is no list for a future field to be missing from.
 *
 * Parsing is a THREE-step pipeline and the order is load-bearing:
 *   JSON  →  migrate raw (schemaVersion ladder)  →  validate through the open schema.
 * Migrations run before validation because a v1 document is not expected to satisfy the
 * v2 schema — that is what the migration is for. Everything registry-dependent (node
 * `definitionVersion` migration, unknown-type placeholders, caps) sits one layer up, in
 * `load.ts`, because autosave has no registry and must still be able to restore.
 */

export function serializeProjectDocument(document: ProjectDocument): string {
  return JSON.stringify(sortKeysDeep(document), null, 2);
}

export interface ParseProjectSuccess {
  ok: true;
  document: ProjectDocument;
  /** Schema migrations that ran, in order. Empty for an already-current file. */
  migrations: readonly AppliedMigration[];
  /** The file was written by a later build than this one (§V68). */
  newerThanApp: boolean;
  /** Parameter values kept but not understood (§V69). Reported, never removed. */
  unknownParameters: readonly UnknownParameter[];
  diagnostics: RuntimeDiagnostic[];
}

export interface ParseProjectFailure {
  ok: false;
  reason: string;
  diagnostics: RuntimeDiagnostic[];
}

export type ParseProjectResult = ParseProjectSuccess | ParseProjectFailure;

export interface ParseProjectOptions {
  /** Overrides the built-in ladder; the migration tests inject synthetic steps. */
  migrations?: readonly DocumentMigration[];
  targetVersion?: number;
}

export function parseProjectDocument(text: string, options: ParseProjectOptions = {}): ParseProjectResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // A truncated or corrupt file is an ordinary outcome of "open a file", not an
    // exception: it gets a diagnostic like everything else (§V66's spirit at the file
    // boundary — malformed input is reported, never thrown).
    return failure(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "project.parse.invalidJson",
    );
  }

  const migrated = migrateProjectDocument(raw, options);
  if (!migrated.ok) return { ok: false, reason: migrated.reason, diagnostics: migrated.diagnostics };

  const result = openProjectDocumentSchema.safeParse(migrated.document);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? "document" : issue.path.join(".");
    const reason = `${path}: ${issue?.message ?? "invalid document"}`;
    return {
      ok: false,
      reason,
      diagnostics: [
        ...migrated.diagnostics,
        { severity: "error", code: "project.parse.invalidDocument", message: reason },
      ],
    };
  }

  // The cast is the price of §V68 and is deliberate. `parameters` is typed
  // `Record<string, ParameterValue>` in the live contract, and a document from a later
  // build may legitimately hold a value outside that union. Dropping it to satisfy the
  // type is exactly what §V68 forbids, so the unknown values ride along and are LISTED in
  // `unknownParameters` — the resolver (§V61) is the one place that reads them, and it is
  // told which ones it must not interpret.
  const document = result.data as unknown as ProjectDocument;
  const unknownParameters = classifyUnknownParameters(document.graph);

  return {
    ok: true,
    document,
    migrations: migrated.applied,
    newerThanApp: migrated.newerThanApp,
    unknownParameters,
    diagnostics: [...migrated.diagnostics, ...unknownParameterDiagnostics(unknownParameters)],
  };
}

function failure(reason: string, code: string): ParseProjectFailure {
  return { ok: false, reason, diagnostics: [{ severity: "error", code, message: reason }] };
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
