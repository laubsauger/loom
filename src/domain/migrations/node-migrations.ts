import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterValue } from "../types/parameters.ts";

/**
 * Per-node parameter migration (T43, §V10).
 *
 * `definitionVersion` has been written into every saved node since the format existed and
 * has never been read. This is where it starts being read: on load, a node whose stored
 * version is behind its definition's is handed to that definition's own `migrate`, and
 * what changed is recorded so the user can be told what happened to their project rather
 * than discovering it later in the render.
 *
 * A definition that declares no `migrate` for a version it has moved past is REPORTED and
 * left alone. Bumping the version without transforming anything would record a migration
 * that never happened, and silently rewriting parameters the definition never claimed to
 * understand is exactly the "silently discard" §V10 forbids.
 */

/** Just enough of the node registry to look a definition up. `NodeRegistryView` satisfies it. */
export interface NodeDefinitionSource {
  get(type: string): NodeDefinition | undefined;
}

export interface NodeMigrationChange {
  nodeId: NodeId;
  type: string;
  fromVersion: number;
  toVersion: number;
  /** Parameter keys the migration introduced. */
  added: readonly string[];
  /** Parameter keys the migration dropped. */
  removed: readonly string[];
  /** Parameter keys whose value the migration rewrote. */
  changed: readonly string[];
}

export interface NodeMigrationOutcome {
  /** A new graph when anything migrated; the same object when nothing did. */
  graph: GraphDocument;
  changes: readonly NodeMigrationChange[];
  diagnostics: RuntimeDiagnostic[];
}

export function migrateGraphNodes(
  graph: GraphDocument,
  definitions: NodeDefinitionSource,
): NodeMigrationOutcome {
  const diagnostics: RuntimeDiagnostic[] = [];
  const changes: NodeMigrationChange[] = [];
  const nodes: Record<NodeId, GraphNode> = {};
  let touched = false;

  // Sorted so two actors loading the same file produce the same diagnostics in the same
  // order — the file is a shared artefact and its report should not depend on key order.
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    nodes[nodeId] = node;

    const definition = definitions.get(node.type);
    // Unknown type: not this lane's problem. The loader turns it into a placeholder that
    // keeps its serialized data (§V10); migrating parameters we have no manifest for
    // would be guessing.
    if (definition === undefined) continue;

    if (node.definitionVersion > definition.version) {
      diagnostics.push({
        severity: "warning",
        code: "project.node.newerVersion",
        message: `"${node.type}" was saved at definition version ${node.definitionVersion} but this build only has version ${definition.version}.`,
        nodeId,
        suggestion: "Its parameters are kept exactly as saved and written back unchanged (§V68).",
      });
      continue;
    }
    if (node.definitionVersion === definition.version) continue;

    if (definition.migrate === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "project.node.noMigration",
        message: `"${node.type}" moved from definition version ${node.definitionVersion} to ${definition.version} but declares no migration.`,
        nodeId,
        suggestion: "Check this node's parameters; nothing describes what changed (§V10).",
      });
      continue;
    }

    let migrated;
    try {
      migrated = definition.migrate(node.definitionVersion, node.parameters);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "project.node.migrationFailed",
        message: `Migrating "${node.type}" from version ${node.definitionVersion} to ${definition.version} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        nodeId,
        suggestion: "The node was left exactly as it was saved.",
      });
      continue;
    }

    if (migrated === null || typeof migrated !== "object" || typeof migrated.parameters !== "object") {
      diagnostics.push({
        severity: "error",
        code: "project.node.migrationFailed",
        message: `Migrating "${node.type}" returned no parameters; the node was left as saved.`,
        nodeId,
      });
      continue;
    }

    const before = node.parameters;
    const after = migrated.parameters as Record<string, ParameterValue>;
    const change = diffParameters(nodeId, node.type, node.definitionVersion, definition.version, before, after);
    nodes[nodeId] = { ...node, definitionVersion: definition.version, parameters: after };
    touched = true;
    changes.push(change);
    diagnostics.push({
      severity: "info",
      code: "project.node.migrated",
      message: `"${node.type}" migrated ${change.fromVersion} → ${change.toVersion}${describeChange(change)}.`,
      nodeId,
    });
    for (const extra of migrated.diagnostics ?? []) diagnostics.push({ ...extra, nodeId });
  }

  return { graph: touched ? { ...graph, nodes } : graph, changes, diagnostics };
}

function diffParameters(
  nodeId: NodeId,
  type: string,
  fromVersion: number,
  toVersion: number,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): NodeMigrationChange {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(after).sort()) {
    if (!(key in before)) added.push(key);
    else if (!sameValue(before[key], after[key])) changed.push(key);
  }
  for (const key of Object.keys(before).sort()) {
    if (!(key in after)) removed.push(key);
  }
  return { nodeId, type, fromVersion, toVersion, added, removed, changed };
}

/** Structural comparison; parameter values are plain JSON by construction (§V63). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeChange(change: NodeMigrationChange): string {
  const parts: string[] = [];
  if (change.added.length > 0) parts.push(`added ${change.added.join(", ")}`);
  if (change.removed.length > 0) parts.push(`removed ${change.removed.join(", ")}`);
  if (change.changed.length > 0) parts.push(`rewrote ${change.changed.join(", ")}`);
  return parts.length === 0 ? " (no parameter change)" : ` — ${parts.join("; ")}`;
}
