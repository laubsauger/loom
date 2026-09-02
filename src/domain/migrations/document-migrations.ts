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

/** Nodes of a raw document, or an empty object when the shape is not what we expect. */
function rawNodes(document: RawDocument): Record<string, Record<string, unknown>> {
  const graph = document["graph"];
  if (typeof graph !== "object" || graph === null) return {};
  const nodes = (graph as Record<string, unknown>)["nodes"];
  if (typeof nodes !== "object" || nodes === null) return {};
  return nodes as Record<string, Record<string, unknown>>;
}

/**
 * 1 → 2: `ui.preview` was the PIN and is now the SWITCH (T353, §V297).
 *
 * The field kept its name and changed its meaning, which is the one shape a migration
 * genuinely has to exist for. Read literally, an old document says the wrong thing in
 * BOTH directions:
 *
 *  - `preview: true` meant "pinned — keep previewing when scrolled off". Read as the
 *    switch it means "on", which is the default anyway, so the pin would be silently lost.
 *  - `preview: false` meant "not pinned", which is also the default. Read as the switch it
 *    means OFF — so every node the user ever pinned and unpinned would load with its
 *    preview disabled, showing a dark slot for a choice nobody made. That is the failure
 *    that would actually be reported, and it is why this cannot be left to "the new
 *    default is fine".
 *
 * So: the truth moves to `previewPinned`, and the switch is left ABSENT, which is on. No
 * document written before today has an opinion about the switch, and this refuses to
 * invent one.
 */
const previewPinBecomesSwitch: DocumentMigration = {
  from: 1,
  to: 2,
  description: "Node preview flag split: the old pin became `previewPinned`, and `preview` is now the on/off switch.",
  migrate(document) {
    for (const node of Object.values(rawNodes(document))) {
      const ui = node["ui"];
      if (typeof ui !== "object" || ui === null) continue;
      const flags = ui as Record<string, unknown>;
      if (!("preview" in flags)) continue;
      if (flags["preview"] === true) flags["previewPinned"] = true;
      delete flags["preview"];
    }
    return document;
  },
};

function rawEdges(document: RawDocument): Record<string, Record<string, unknown>> {
  const graph = document["graph"];
  if (typeof graph !== "object" || graph === null) return {};
  const edges = (graph as Record<string, unknown>)["edges"];
  if (typeof edges !== "object" || edges === null) return {};
  return edges as Record<string, Record<string, unknown>>;
}

/**
 * 2 → 3 (T350, §V285): feedback loops stop being WIRED. A feedback node's `in` edge
 * becomes a `source` parameter naming the source node, and the edge is deleted —
 * `edges` is a DAG from here on, and the loop the user sees is the dashed reference.
 *
 * The name written is the node's effective name (its label, or the auto-number the
 * name derivation assigns) — the same currency driven channels and op() use (§V129).
 * The compiler synthesizes the identical edge back at compile time, so a converted
 * document's PLAN is byte-identical to the wired one's; the equivalence test pins it.
 */
const feedbackLoopBecomesReference: DocumentMigration = {
  from: 2,
  to: 3,
  description: "Feedback takes its source by NAME: the wired in-edge becomes the `source` parameter.",
  migrate(document) {
    const nodes = rawNodes(document);
    const edges = rawEdges(document);
    for (const [edgeId, edge] of Object.entries(edges)) {
      const target = edge["target"] as { nodeId?: string; portId?: string } | undefined;
      if (target?.portId !== "in") continue;
      const targetNode = nodes[target.nodeId ?? ""];
      if (targetNode?.["type"] !== "feedback") continue;
      const source = edge["source"] as { nodeId?: string } | undefined;
      const sourceNode = nodes[source?.nodeId ?? ""];
      if (sourceNode === undefined) continue;
      const name = effectiveName(nodes, source?.nodeId ?? "");
      if (name === undefined) continue;
      const parameters = (targetNode["parameters"] ?? {}) as Record<string, unknown>;
      parameters["source"] = name;
      targetNode["parameters"] = parameters;
      delete edges[edgeId];
    }
    return document;
  },
};

/**
 * The source node's NAME — its label, or one this migration ASSIGNS. Names are labels
 * and nothing else (`nodeNames` in names.ts): an unlabeled node has NO name, so a
 * reference to a derived-but-unwritten name would dangle at compile. Assigning the
 * label makes the name real, the way creating the node in the editor would have.
 */
function effectiveName(
  nodes: Record<string, Record<string, unknown>>,
  nodeId: string,
): string | undefined {
  const node = nodes[nodeId];
  if (node === undefined) return undefined;
  const label = node["label"];
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  const type = node["type"];
  if (typeof type !== "string") return undefined;
  const taken = new Set(
    Object.values(nodes)
      .map((entry) => entry["label"])
      .filter((value): value is string => typeof value === "string"),
  );
  for (let index = 1; ; index += 1) {
    const candidate = `${type}${index}`;
    if (!taken.has(candidate)) {
      node["label"] = candidate;
      return candidate;
    }
  }
}

export const DOCUMENT_MIGRATIONS: readonly DocumentMigration[] = [
  previewPinBecomesSwitch,
  feedbackLoopBecomesReference,
];

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
      message: `This project was saved by a newer version of Loom (schema ${fromVersion}, this build writes ${targetVersion}).`,
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
