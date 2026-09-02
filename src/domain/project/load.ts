import type { GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { AssetReference, GraphDocument, ProjectDocument } from "../types/graph.ts";
import type { NodeId, PortId } from "../types/ids.ts";
import { componentLibrarySchema } from "../components/schemas.ts";
import {
  migrateGraphNodes,
  type AppliedMigration,
  type DocumentMigration,
  type NodeDefinitionSource,
  type NodeMigrationChange,
} from "../migrations/index.ts";
import type { UnknownParameter } from "./forward-compat.ts";
import { checkMemoryBudget, clampNodeResolutions, clampSettings } from "./limits.ts";
import { detachComponentLibrary } from "./project-file.ts";
import { parseProjectDocument } from "./serialize.ts";
import { isParameterSlot, upgradeDrivenSlot } from "../parameters/slots.ts";

/**
 * Opening a `.loom.json` (T43).
 *
 * `parseProjectDocument` already did the parts that need nothing but the text: JSON,
 * schema migrations, the forward-compat parse. This layer adds everything that needs to
 * know what this build actually HAS — the node registry and the component catalogue — and
 * everything that must happen before the graph is allowed near a device:
 *
 *   1. component definitions are registered, which IS the load-time recursion check (§V83);
 *   2. nodes whose `definitionVersion` is stale run their definition's own migration (§V10);
 *   3. nodes of a type this build does not have become PLACEHOLDERS that keep every byte
 *      they were saved with (§V10) — deleting them would silently destroy the user's work
 *      and the edges around them;
 *   4. resource caps are applied to settings and to per-node overrides (§V24, §V50).
 *
 * It never throws. Opening a file the user chose is exactly where a thrown parse error
 * turns into a blank screen with no explanation, so every failure is a `reason` plus
 * diagnostics.
 */

/** A node whose type this build does not have. Kept whole; rendered as a placeholder. */
export interface UnknownNodePlaceholder {
  nodeId: NodeId;
  type: string;
  definitionVersion: number;
  /** What to show on the node body. */
  label: string;
  /**
   * Port stubs recovered from the edges that touch this node, so the graph still draws
   * the connections it had. Ports nothing connects to cannot be recovered — the manifest
   * that declared them is not installed — and that is exactly why the node is a
   * placeholder rather than something the compiler is allowed to run.
   */
  inputs: readonly PortId[];
  outputs: readonly PortId[];
  /** Parameter keys carried through, in sorted order. Values are preserved untouched. */
  parameterKeys: readonly string[];
}

/** Just enough of `ComponentRegistry` to install a definition; registering runs §V83. */
export interface ComponentInstaller {
  register(definition: GraphComponentDefinition): void;
}

export interface LoadProjectOptions {
  /** The node catalogue. Without it, nothing can be migrated and every type is unknown. */
  nodes?: NodeDefinitionSource;
  /** The component catalogue the file's library is installed into. */
  components?: ComponentInstaller;
  migrations?: readonly DocumentMigration[];
  targetVersion?: number;
  /**
   * Whether an asset's `source` can still be reached in this session. The default treats a
   * session-scoped object URL as gone, because it always is after a reload.
   */
  resolveAsset?: (asset: AssetReference) => boolean;
}

export interface LoadProjectSuccess {
  ok: true;
  document: ProjectDocument;
  /** Component definitions found in the file, in the order they were registered. */
  components: readonly GraphComponentDefinition[];
  migrations: readonly AppliedMigration[];
  nodeMigrations: readonly NodeMigrationChange[];
  placeholders: readonly UnknownNodePlaceholder[];
  unknownParameters: readonly UnknownParameter[];
  assetsToRelink: readonly AssetReference[];
  /** The file was written by a later build than this one (§V68). */
  newerThanApp: boolean;
  /**
   * The loaded document differs from the file: something migrated or something was
   * clamped. The app should mark the project dirty rather than let the difference sit
   * only in memory.
   */
  changed: boolean;
  diagnostics: RuntimeDiagnostic[];
}

export interface LoadProjectFailure {
  ok: false;
  reason: string;
  diagnostics: RuntimeDiagnostic[];
}

export type LoadProjectResult = LoadProjectSuccess | LoadProjectFailure;

export function loadProject(text: string, options: LoadProjectOptions = {}): LoadProjectResult {
  const parsed = parseProjectDocument(text, {
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion }),
  });
  if (!parsed.ok) return { ok: false, reason: parsed.reason, diagnostics: parsed.diagnostics };

  const diagnostics: RuntimeDiagnostic[] = [...parsed.diagnostics];
  const detached = detachComponentLibrary(parsed.document);
  let document = detached.document;

  const components = installComponents(detached.raw, options.components, diagnostics);

  const nodeMigration =
    options.nodes === undefined
      ? { graph: document.graph, changes: [] as readonly NodeMigrationChange[], diagnostics: [] }
      : migrateGraphNodes(document.graph, options.nodes);
  diagnostics.push(...nodeMigration.diagnostics);
  document = { ...document, graph: nodeMigration.graph };

  // §T897: `driven` mode is retired — a channel read is an expression term now
  // (`op('name').chan.low`). Documents in the wild still hold driven slots; they are
  // upgraded here, value-identically, and never written back. Parse forever, emit never.
  const drivenUpgrade = upgradeDrivenSlots(document.graph);
  if (drivenUpgrade.upgraded > 0) document = { ...document, graph: drivenUpgrade.graph };

  const placeholders = findPlaceholders(document.graph, options.nodes);
  for (const placeholder of placeholders) {
    diagnostics.push({
      severity: "warning",
      code: "project.node.unknownType",
      message: `This build has no node type "${placeholder.type}"; it is shown as a placeholder.`,
      nodeId: placeholder.nodeId,
      suggestion:
        "Everything it was saved with is kept and written back on save; install the node that provides this type to restore it (§V10).",
    });
  }

  // §V24 last: the caps that follow are checked against limits that have themselves just
  // been brought into range, and against a graph that has finished migrating.
  const settings = clampSettings(document.settings);
  diagnostics.push(...settings.diagnostics);
  const graph = clampNodeResolutions(document.graph, settings.settings.limits);
  diagnostics.push(...graph.diagnostics);
  document = { ...document, settings: settings.settings, graph: graph.graph };

  const budget = checkMemoryBudget(document);
  if (budget !== null) diagnostics.push(budget);

  const assetsToRelink = findUnresolvedAssets(document.assets, options.resolveAsset);
  for (const asset of assetsToRelink) {
    diagnostics.push({
      severity: "warning",
      code: "project.asset.unresolved",
      message: `The asset "${asset.name}" is not available in this session.`,
      suggestion: "Relink it to a file on disk; the project keeps its identity until you do (§C save).",
    });
  }

  return {
    ok: true,
    document,
    components,
    migrations: parsed.migrations,
    nodeMigrations: nodeMigration.changes,
    placeholders,
    unknownParameters: parsed.unknownParameters,
    assetsToRelink,
    newerThanApp: parsed.newerThanApp,
    changed:
      parsed.migrations.length > 0 ||
      nodeMigration.changes.length > 0 ||
      drivenUpgrade.upgraded > 0 ||
      settings.clamped ||
      graph.clamped,
    diagnostics,
  };
}

/**
 * Installs the file's component library.
 *
 * Registration is the §V83 load-time check, not a separate pass: `register` refuses a
 * definition that closes a recursion loop, direct or indirect. A definition that is
 * refused is REPORTED and skipped — the rest of the project still opens, and the
 * instances that pointed at it become unknown-type placeholders by the same rule as any
 * other missing type, which is precisely the outcome §V10 asks for.
 */
function installComponents(
  raw: unknown,
  installer: ComponentInstaller | undefined,
  diagnostics: RuntimeDiagnostic[],
): readonly GraphComponentDefinition[] {
  if (raw === undefined) return [];
  const parsed = componentLibrarySchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.push({
      severity: "error",
      code: "project.components.invalid",
      message: `The project's component library could not be read: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      suggestion: "Component instances in this project will open as placeholders.",
    });
    return [];
  }

  const installed: GraphComponentDefinition[] = [];
  for (const definition of parsed.data.components as GraphComponentDefinition[]) {
    if (installer === undefined) {
      installed.push(definition);
      continue;
    }
    try {
      installer.register(definition);
      installed.push(definition);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "project.components.rejected",
        message: `Component "${definition.name}" (v${definition.version}) was not installed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  return installed;
}

function findPlaceholders(
  graph: GraphDocument,
  nodes: NodeDefinitionSource | undefined,
): UnknownNodePlaceholder[] {
  if (nodes === undefined) return [];
  const placeholders: UnknownNodePlaceholder[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined || nodes.get(node.type) !== undefined) continue;
    const ports = portsFromEdges(graph, nodeId);
    placeholders.push({
      nodeId,
      type: node.type,
      definitionVersion: node.definitionVersion,
      label: node.label ?? node.type,
      inputs: ports.inputs,
      outputs: ports.outputs,
      parameterKeys: Object.keys(node.parameters).sort(),
    });
  }
  return placeholders;
}

function portsFromEdges(
  graph: GraphDocument,
  nodeId: NodeId,
): { inputs: PortId[]; outputs: PortId[] } {
  const inputs = new Set<PortId>();
  const outputs = new Set<PortId>();
  for (const edge of Object.values(graph.edges)) {
    if (edge.target.nodeId === nodeId) inputs.add(edge.target.portId);
    if (edge.source.nodeId === nodeId) outputs.add(edge.source.portId);
  }
  return { inputs: [...inputs].sort(), outputs: [...outputs].sort() };
}

/**
 * Assets whose source cannot be reached, so the app can offer the relink flow (§C save).
 *
 * The default answer is structural, not speculative: a `objectUrl` source names a session
 * that has ended by definition, and a `fileHandle` needs a permission grant this layer
 * cannot ask for. Anything with a durable source is assumed reachable until whoever can
 * actually check says otherwise via `resolveAsset`.
 */
function findUnresolvedAssets(
  assets: readonly AssetReference[],
  resolveAsset: ((asset: AssetReference) => boolean) | undefined,
): AssetReference[] {
  const resolved = resolveAsset ?? ((asset: AssetReference) => asset.source.kind !== "objectUrl");
  return assets.filter((asset) => !resolved(asset));
}

/** §T897: every driven slot in the graph, upgraded to its expression form. Pure. */
function upgradeDrivenSlots(graph: GraphDocument): { graph: GraphDocument; upgraded: number } {
  let upgraded = 0;
  const nodes: GraphDocument["nodes"] = {};
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    let touched = false;
    const parameters = { ...node.parameters };
    for (const [key, stored] of Object.entries(parameters)) {
      if (!isParameterSlot(stored)) continue;
      const result = upgradeDrivenSlot(stored);
      if (result.changed) {
        parameters[key] = result.slot;
        touched = true;
        upgraded += 1;
      }
    }
    nodes[nodeId] = touched ? { ...node, parameters } : node;
  }
  return { graph: upgraded > 0 ? { ...graph, nodes } : graph, upgraded };
}
