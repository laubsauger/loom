import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";
import type { AppliedMigration, DocumentMigration, RawDocument } from "./types.ts";

/**
 * The document-level migration ladder (T43, §V10).
 *
 * Empty at `schemaVersion: 1` — there is nothing before version 1 to come from. It is
 * wired up anyway, and exercised by tests with synthetic steps, because the moment the
 * first real step is needed there will already be `.loom.json` files in the wild: the
 * scaffolding has to exist BEFORE it is needed, not after.
 *
 * Adding a step: append `{ from: N, to: N + 1, description, migrate }` here and raise
 * `SCHEMA_VERSION`. The ladder is checked for integrity (no gap, no duplicate `from`, no
 * step that goes backwards) every time it runs, so a mistake surfaces as a refused load
 * with a named reason rather than as a document that is half in one version and half in
 * the next.
 */
export const DOCUMENT_MIGRATIONS: readonly DocumentMigration[] = [];

export interface MigrateDocumentOptions {
  migrations?: readonly DocumentMigration[];
  /** The version this build writes. Defaults to `SCHEMA_VERSION`. */
  targetVersion?: number;
}

export type MigrateDocumentResult =
  | {
      ok: true;
      document: RawDocument;
      fromVersion: number;
      applied: readonly AppliedMigration[];
      /**
       * The file was written by a LATER build than this one. Not an error: §V68 says such
       * a document loads and keeps what this build does not understand.
       */
      newerThanApp: boolean;
      diagnostics: RuntimeDiagnostic[];
    }
  | { ok: false; reason: string; diagnostics: RuntimeDiagnostic[] };

/**
 * Structural check on the ladder itself, independent of any document.
 *
 * Run separately by the migration test so a broken ladder is caught by the suite rather
 * than by the first user who opens an old file.
 */
export function validateMigrationLadder(
  migrations: readonly DocumentMigration[],
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to)) {
      diagnostics.push({
        severity: "error",
        code: "project.migration.malformed",
        message: `Migration "${migration.description}" has a non-integer version (${migration.from} → ${migration.to}).`,
      });
      continue;
    }
    if (migration.to <= migration.from) {
      diagnostics.push({
        severity: "error",
        code: "project.migration.backwards",
        message: `Migration "${migration.description}" does not move forwards (${migration.from} → ${migration.to}).`,
      });
    }
    if (seen.has(migration.from)) {
      diagnostics.push({
        severity: "error",
        code: "project.migration.duplicate",
        message: `Two migrations both start at schemaVersion ${migration.from}; the order they run in would be arbitrary.`,
      });
    }
    seen.add(migration.from);
  }
  return diagnostics;
}

/**
 * Walks a raw document from its own `schemaVersion` up to `targetVersion`.
 *
 * Nothing is adopted unless the WHOLE chain succeeds: the walk runs on a private deep
 * clone and the clone is only returned on success, so a missing step or a throwing step
 * leaves the caller with the original file and a reason, never with a document that had
 * two of three steps applied to it.
 */
export function migrateProjectDocument(
  raw: unknown,
  options: MigrateDocumentOptions = {},
): MigrateDocumentResult {
  const migrations = options.migrations ?? DOCUMENT_MIGRATIONS;
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const diagnostics: RuntimeDiagnostic[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("The file does not contain a project object.", "project.parse.notAnObject", diagnostics);
  }

  const source = raw as RawDocument;
  const fromVersion = source["schemaVersion"];
  if (typeof fromVersion !== "number" || !Number.isInteger(fromVersion) || fromVersion < 1) {
    return fail(
      "The file has no usable schemaVersion, so there is no way to know which migrations it needs.",
      "project.migration.noVersion",
      diagnostics,
    );
  }

  const ladderIssues = validateMigrationLadder(migrations);
  if (ladderIssues.length > 0) {
    diagnostics.push(...ladderIssues);
    return {
      ok: false,
      reason: `The migration ladder is broken: ${ladderIssues.map((issue) => issue.message).join(" ")}`,
      diagnostics,
    };
  }

  // §V68: a file from a newer build is loaded as-is and everything unrecognised is kept.
  // Downgrading it is not possible and refusing it would lose the user's work.
  if (fromVersion > targetVersion) {
    diagnostics.push({
      severity: "warning",
      code: "project.schema.newer",
      message: `This project was saved by a newer version of Shaderloom (schema ${fromVersion}, this build writes ${targetVersion}).`,
      suggestion: "Anything this build does not understand is kept as-is and written back on save (§V68).",
    });
    return {
      ok: true,
      document: structuredClone(source),
      fromVersion,
      applied: [],
      newerThanApp: true,
      diagnostics,
    };
  }

  let document = structuredClone(source);
  const applied: AppliedMigration[] = [];
  let at = fromVersion;
  while (at < targetVersion) {
    const step = migrations.find((migration) => migration.from === at);
    if (step === undefined) {
      return fail(
        `No migration from schemaVersion ${at} to ${at + 1}; this project cannot be upgraded to ${targetVersion} safely.`,
        "project.migration.missing",
        diagnostics,
      );
    }
    try {
      document = step.migrate(document);
    } catch (error) {
      return fail(
        `Migration ${step.from} → ${step.to} ("${step.description}") failed: ${describeError(error)}`,
        "project.migration.failed",
        diagnostics,
      );
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      return fail(
        `Migration ${step.from} → ${step.to} ("${step.description}") did not return a document object.`,
        "project.migration.failed",
        diagnostics,
      );
    }
    document["schemaVersion"] = step.to;
    applied.push({ from: step.from, to: step.to, description: step.description });
    at = step.to;
  }

  for (const step of applied) {
    diagnostics.push({
      severity: "info",
      code: "project.migration.applied",
      message: `Upgraded schema ${step.from} → ${step.to}: ${step.description}`,
    });
  }

  return { ok: true, document, fromVersion, applied, newerThanApp: false, diagnostics };
}

function fail(reason: string, code: string, diagnostics: RuntimeDiagnostic[]): MigrateDocumentResult {
  diagnostics.push({ severity: "error", code, message: reason });
  return { ok: false, reason, diagnostics };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
