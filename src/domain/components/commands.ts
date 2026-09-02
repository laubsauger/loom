import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type {
  ComponentMigration,
  ExposedPort,
  GraphComponentDefinition,
} from "../types/components.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { ComponentId, NodeId, PortId, Revision } from "../types/ids.ts";
import type { ParameterDefinition, ParameterValue } from "../types/parameters.ts";
import type { GraphPatchResult } from "../types/patch.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch } from "../commands/apply-patch.ts";
import { renumberedName, rewriteNodeNameReferences } from "../graph/names.ts";
import { withBoundaryPorts } from "./boundary-ports.ts";
import { componentNodeType } from "./component-type.ts";
import { readComponentInstance, PARENT_BINDINGS_STATE_KEY } from "./instance.ts";
import { parseParentReference } from "./parent-scope.ts";
import {
  defaultPublishedValues,
  exposePort as withExposedPort,
  findPublishedParameter,
  publishParameter as withPublishedParameter,
  publishedParameterOperations,
  unexposePort as withoutExposedPort,
  unpublishParameter as withoutPublishedParameter,
  reorderPublishedParameter,
} from "./published-parameter.ts";
import { buildComponentFromSelection } from "./save-selection.ts";
import { availableUpgrade, planComponentUpgrade } from "./upgrade.ts";
import type { ComponentUpgradePlan } from "./upgrade.ts";
import { describeRecursion, wouldRecurse } from "./recursion.ts";
import type { ComponentRegistry } from "./registry.ts";

/**
 * Component commands (T129–T132, T136), registered by declaration merging like every
 * other feature module (§V29, §V39).
 *
 * Two kinds of command live here and the difference matters:
 *
 *  - GRAPH commands (instantiate, detach, upgrade, set a parent binding) mutate the
 *    document through `context.apply`, the sole mutation primitive, so they get atomicity,
 *    audit, undo grouping and dryRun from the store (§V32, §V34, §V36).
 *  - DEFINITION commands (expose a port, publish a parameter) edit the component
 *    catalogue. They still go through the bus — that is what §V29 is about — but the
 *    thing they change is the definition every linked instance points at (§V79), not the
 *    document.
 *
 * `host` is the component this bus is editing, or null for the root project graph. The
 * definition commands need it because publishing a parameter is something you do while
 * INSIDE a component; the recursion check needs it because "would this instantiation
 * close a loop?" is a question about where you are putting the instance (§V83).
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /** Turn the selection into a component and replace it with one instance (§V79). */
    "component.saveSelection": { input: SaveSelectionCommandInput; output: SaveSelectionOutput };
    /** Place a component: linked to its definition, or as an independent copy (§V79). */
    "component.instantiate": { input: InstantiateInput; output: InstantiateOutput };
    /** Explode a linked instance into its own nodes. The opt-out from §V79. */
    "component.detach": { input: { nodeId: NodeId }; output: DetachOutput };
    /** Surface an internal port on the component boundary (T131). */
    "component.exposePort": { input: ExposePortInput; output: ComponentEditOutput };
    "component.unexposePort": { input: UnexposePortInput; output: ComponentEditOutput };
    /** Promote internal parameters onto the component's parameter page (T132, §V80). */
    "component.publishParameter": { input: PublishParameterInput; output: ComponentEditOutput };
    "component.unpublishParameter": { input: { key: string }; output: ComponentEditOutput };
    /** Move a published parameter on the component's parameter page (T423, §V80). */
    "component.reorderParameter": { input: ReorderParameterInput; output: ComponentEditOutput };
    /** Turn a published knob: every internal target, one patch, one undo step (§V80). */
    "component.setPublishedParameter": {
      input: { key: string; value: ParameterValue };
      output: GraphPatchResult;
    };
    /** Bind an internal parameter to `parent.<key>` (§V81). */
    "component.setParentBinding": { input: SetParentBindingInput; output: ComponentEditOutput };
    /** Explicit, migrated version change for one instance (§V84, §V10). */
    "component.upgradeInstance": { input: UpgradeInstanceInput; output: UpgradeInstanceOutput };
  }

  interface QueryMap {
    "component.list": { input: Record<string, never>; output: ComponentSummary[] };
    "component.get": {
      input: { componentId: ComponentId; version?: number };
      output: GraphComponentDefinition | null;
    };
    /** Instances in this graph with a newer version available. Informational only (§V84). */
    "component.upgrades": { input: Record<string, never>; output: InstanceUpgradeSummary[] };
  }
}

export interface SaveSelectionCommandInput {
  nodeIds: readonly NodeId[];
  name: string;
  description?: string;
  /** Supply to overwrite a specific component; otherwise a fresh id is minted. */
  componentId?: ComponentId;
}

export interface SaveSelectionOutput {
  ok: boolean;
  componentId: ComponentId | null;
  version: number | null;
  instanceNodeId: NodeId | null;
  exposedInputs: readonly PortId[];
  exposedOutputs: readonly PortId[];
  diagnostics: RuntimeDiagnostic[];
}

export interface InstantiateInput {
  componentId: ComponentId;
  /** Omitted means the latest registered version. The instance still PINS it (§V84). */
  version?: number;
  position?: { x: number; y: number };
  /** `"linked"` (default) follows the definition; `"detached"` is an independent copy. */
  mode?: "linked" | "detached";
}

export interface InstantiateOutput {
  ok: boolean;
  /** The instance node, for a linked placement. */
  nodeId: NodeId | null;
  /** Every node created, which for a detached copy is the whole internal network. */
  nodeIds: readonly NodeId[];
  componentId: ComponentId;
  version: number | null;
  diagnostics: RuntimeDiagnostic[];
}

export interface DetachOutput {
  ok: boolean;
  nodeIds: readonly NodeId[];
  diagnostics: RuntimeDiagnostic[];
}

export interface ExposePortInput {
  direction: "input" | "output";
  nodeId: NodeId;
  portId: PortId;
  externalId?: PortId;
  label?: string;
}

export interface UnexposePortInput {
  direction: "input" | "output";
  externalId: PortId;
}

export interface PublishParameterInput {
  key: string;
  /** RE-AUTHORED, not copied: label, range and unit are chosen for this control (§V80). */
  definition: ParameterDefinition;
  targets: ReadonlyArray<{ nodeId: NodeId; key: string }>;
}

export interface ReorderParameterInput {
  key: string;
  /** Target position on the page, clamped into range. */
  toIndex: number;
}

export interface SetParentBindingInput {
  nodeId: NodeId;
  key: string;
  /** `"parent.blur"`, `"parent.parent.gain"`, or null to unbind. */
  reference: string | null;
}

export interface UpgradeInstanceInput {
  nodeId: NodeId;
  /** Omitted means the latest registered version. */
  toVersion?: number;
}

export interface UpgradeInstanceOutput {
  ok: boolean;
  plan: ComponentUpgradePlan | null;
  migrations: readonly ComponentMigration[];
  diagnostics: RuntimeDiagnostic[];
}

export interface ComponentEditOutput {
  ok: boolean;
  componentId: ComponentId | null;
  version: number | null;
  diagnostics: RuntimeDiagnostic[];
}

export interface ComponentSummary {
  componentId: ComponentId;
  version: number;
  name: string;
  description?: string;
  inputs: readonly PortId[];
  outputs: readonly PortId[];
  parameters: readonly string[];
  versions: readonly number[];
}

export interface InstanceUpgradeSummary {
  nodeId: NodeId;
  componentId: ComponentId;
  pinnedVersion: number;
  latestVersion: number;
}

export interface ComponentHost {
  componentId: ComponentId;
  version: number;
}

export interface ComponentCommandOptions {
  components: ComponentRegistry;
  /**
   * The component whose internal graph this bus edits, or null/undefined for the root
   * project graph. A session opened by `openComponentSession` sets it.
   */
  host?: ComponentHost | null;
  /** Mints component ids. Defaults to the store's id factory. */
  newComponentId?: () => ComponentId;
}

function info(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "info", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function error(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "error", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

const NOT_INSIDE = error(
  "component.notInsideComponent",
  "This command edits the component you are inside, and you are in the root graph.",
  "Enter a component first (T130); publishing and exposing are authoring acts done from inside.",
);

function editOutcome(
  revision: Revision,
  ok: boolean,
  host: ComponentHost | null,
  diagnostics: RuntimeDiagnostic[],
): CommandOutcome<ComponentEditOutput> {
  return {
    status: ok ? "applied" : "rejected",
    revision,
    diagnostics,
    output: {
      ok,
      componentId: host?.componentId ?? null,
      version: host?.version ?? null,
      diagnostics,
    },
  };
}

function patchRejection(revision: Revision, diagnostics: RuntimeDiagnostic[]): CommandOutcome<GraphPatchResult> {
  return {
    status: "rejected",
    revision,
    diagnostics,
    output: { status: "rejected", revision, appliedOperations: 0, diagnostics, createdIds: {} },
  };
}

/** Copies a component's internal network into `draft`, returning old id -> new id. */
function copyInternalGraph(
  draft: GraphDocument,
  internal: GraphDocument,
  origin: { x: number; y: number },
  ids: { node: () => string; edge: () => string },
): Record<NodeId, NodeId> {
  const nodeIds = Object.keys(internal.nodes).sort();
  let minX = Infinity;
  let minY = Infinity;
  for (const nodeId of nodeIds) {
    const node = internal.nodes[nodeId];
    if (node === undefined) continue;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }

  // B41: names taken BEFORE the copy lands. The copy carries the component's internal
  // labels verbatim, and a label the parent already holds would make every reference to
  // it ambiguous — `nodeNames` is first-wins, so the copy's own op()/driven/source
  // references would silently bind the parent's node (or an earlier copy's).
  const taken = new Set<string>();
  for (const existing of Object.values(draft.nodes)) {
    if (existing.label !== undefined) taken.add(existing.label);
  }

  const remap: Record<NodeId, NodeId> = {};
  for (const nodeId of nodeIds) {
    const node = internal.nodes[nodeId];
    if (node === undefined) continue;
    const newId = ids.node();
    remap[nodeId] = newId;
    // The whole node, not a patch-shaped subset: a detached copy that quietly lost a
    // bypass flag, a resolution override or a nested instance's overrides would not be
    // the same network the user was looking at a second ago.
    draft.nodes[newId] = {
      ...node,
      id: newId,
      position: {
        x: origin.x + (node.position.x - minX),
        y: origin.y + (node.position.y - minY),
      },
    };
  }

  // Rename colliding labels and rewrite the COPY's references to follow — scoped to the
  // copied nodes only, so a parent node's reference to its own `over1` never moves.
  const copyIds = Object.values(remap).sort();
  const copyLabels = new Set<string>();
  for (const id of copyIds) {
    const label = draft.nodes[id]?.label;
    if (label !== undefined) copyLabels.add(label);
  }
  const renames: Array<{ id: NodeId; oldName: string; newName: string }> = [];
  for (const id of copyIds) {
    const label = draft.nodes[id]?.label;
    if (label === undefined) continue;
    if (!taken.has(label)) {
      taken.add(label);
      continue;
    }
    const candidate = renumberedName(label, (name) => taken.has(name) || copyLabels.has(name));
    renames.push({ id, oldName: label, newName: candidate });
    taken.add(candidate);
    copyLabels.add(candidate);
  }
  if (renames.length > 0) {
    // The copies above spread the DEFINITION's nodes, so they still share its parameter
    // records; the rewrite mutates those records in place and would otherwise edit the
    // installed component. Give every copy its own record first.
    for (const id of copyIds) {
      const node = draft.nodes[id];
      if (node !== undefined) draft.nodes[id] = { ...node, parameters: { ...node.parameters } };
    }
    // The scope graph shares the copies' node objects, so the rewrite lands in `draft`.
    const scope: GraphDocument = {
      ...draft,
      nodes: Object.fromEntries(copyIds.map((id) => [id, draft.nodes[id] as GraphNode])),
      edges: {},
    };
    for (const rename of renames) {
      rewriteNodeNameReferences(scope, rename.oldName, rename.newName);
      const node = draft.nodes[rename.id];
      // In place, not a replacement object: `scope` shares this object, and a later
      // rewrite through it must keep landing on the node `draft` holds.
      if (node !== undefined) (node as { label?: string }).label = rename.newName;
    }
  }

  for (const edgeId of Object.keys(internal.edges).sort()) {
    const edge = internal.edges[edgeId];
    if (edge === undefined) continue;
    const source = remap[edge.source.nodeId];
    const target = remap[edge.target.nodeId];
    if (source === undefined || target === undefined) continue;
    const newEdgeId = ids.edge();
    draft.edges[newEdgeId] = {
      id: newEdgeId,
      source: { nodeId: source, portId: edge.source.portId },
      target: { nodeId: target, portId: edge.target.portId },
    };
  }

  return remap;
}

/** Nodes carrying `parent.<key>` bindings, which cannot mean anything once detached. */
function danglingParentBindings(internal: GraphDocument): NodeId[] {
  const found: NodeId[] = [];
  for (const nodeId of Object.keys(internal.nodes).sort()) {
    const bindings = internal.nodes[nodeId]?.state?.[PARENT_BINDINGS_STATE_KEY];
    if (typeof bindings === "object" && bindings !== null && Object.keys(bindings).length > 0) {
      found.push(nodeId);
    }
  }
  return found;
}

export function registerComponentCommands(bus: LoomBus, options: ComponentCommandOptions): void {
  const components = options.components;
  const host = options.host ?? null;

  const requireHostDefinition = (): GraphComponentDefinition | undefined =>
    host === null ? undefined : components.get(host.componentId, host.version);

  /** Registers a re-authored definition unless this was a dry run (§V36). */
  const commitDefinition = (
    context: CommandContext,
    next: GraphComponentDefinition,
    diagnostics: RuntimeDiagnostic[],
  ): boolean => {
    const problems = components.validate(next);
    diagnostics.push(...problems);
    if (problems.some((diagnostic) => diagnostic.severity === "error")) return false;
    if (!context.dryRun) components.register(next);
    return true;
  };

  bus.registerCommand({
    name: "component.saveSelection",
    description: "Save the selected nodes as a reusable component and instance it (§V79).",
    handler: (input, context): CommandOutcome<SaveSelectionOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const reject = (): CommandOutcome<SaveSelectionOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: {
          ok: false,
          componentId: null,
          version: null,
          instanceNodeId: null,
          exposedInputs: [],
          exposedOutputs: [],
          diagnostics,
        },
      });

      const componentId =
        input.componentId ?? options.newComponentId?.() ?? context.ids.next("cmp");
      const existing = components.latest(componentId);
      const version = existing === undefined ? 1 : existing.version + 1;

      const built = buildComponentFromSelection({
        graph: context.graph,
        nodeIds: input.nodeIds,
        componentId,
        version,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        nodes: context.registry,
      });
      diagnostics.push(...built.diagnostics);
      if (built.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return reject();

      const problems = components.validate(built.definition);
      diagnostics.push(...problems);
      if (problems.some((diagnostic) => diagnostic.severity === "error")) return reject();

      // §V83 at save: the definition is acyclic on its own, but placing its instance
      // where the selection was must not close a loop through the component we are in.
      const recursion = wouldRecurse(host?.componentId ?? null, componentId, version, {
        graphOf: (id, wanted) =>
          id === componentId && wanted === version
            ? built.definition.graph
            : components.graphOf(id, wanted),
      });
      if (recursion !== null) {
        diagnostics.push(error("component.recursion", describeRecursion(recursion)));
        return reject();
      }

      const instanceNodeId = context.ids.node();
      const applied = context.apply({
        label: `Save "${input.name}" as a component`,
        recipe: (draft) => {
          for (const edgeId of built.removedEdgeIds) delete draft.edges[edgeId];
          for (const nodeId of Object.keys(built.definition.graph.nodes)) delete draft.nodes[nodeId];

          draft.nodes[instanceNodeId] = {
            id: instanceNodeId,
            type: componentNodeType(componentId, version),
            definitionVersion: version,
            position: built.position,
            parameters: defaultPublishedValues(built.definition),
          };

          for (const wiring of built.inputWiring) {
            const edgeId = context.ids.edge();
            draft.edges[edgeId] = {
              id: edgeId,
              source: { ...wiring.outer },
              target: { nodeId: instanceNodeId, portId: wiring.externalId },
            };
          }
          for (const wiring of built.outputWiring) {
            const edgeId = context.ids.edge();
            draft.edges[edgeId] = {
              id: edgeId,
              source: { nodeId: instanceNodeId, portId: wiring.externalId },
              target: { ...wiring.outer },
            };
          }
        },
      });

      if (!context.dryRun) components.register(built.definition);

      // T607: the boundary-node sockets are folded in at registration; the reported
      // lists must be the EFFECTIVE interface, not the pre-normalization rows.
      const effective = withBoundaryPorts(built.definition);
      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: {
          ok: true,
          componentId,
          version,
          instanceNodeId,
          exposedInputs: effective.inputs.map((port) => port.externalId),
          exposedOutputs: effective.outputs.map((port) => port.externalId),
          diagnostics,
        },
      };
    },
  });

  bus.registerCommand({
    name: "component.instantiate",
    description: "Place a component as a linked instance or a detached copy (§V79, §V83).",
    handler: (input, context): CommandOutcome<InstantiateOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const fail = (): CommandOutcome<InstantiateOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: {
          ok: false,
          nodeId: null,
          nodeIds: [],
          componentId: input.componentId,
          version: null,
          diagnostics,
        },
      });

      const definition =
        input.version === undefined
          ? components.latest(input.componentId)
          : components.get(input.componentId, input.version);
      if (definition === undefined) {
        diagnostics.push(
          error(
            "component.notInstalled",
            `Component "${input.componentId}"${input.version === undefined ? "" : ` version ${input.version}`} is not installed.`,
          ),
        );
        return fail();
      }

      const recursion = wouldRecurse(
        host?.componentId ?? null,
        definition.componentId,
        definition.version,
        components,
      );
      if (recursion !== null) {
        diagnostics.push(
          error("component.recursion", describeRecursion(recursion), "A component may not contain itself (§V83)."),
        );
        return fail();
      }

      const position = input.position ?? { x: 0, y: 0 };
      const created: NodeId[] = [];
      let instanceNodeId: NodeId | null = null;

      if ((input.mode ?? "linked") === "detached") {
        const dangling = danglingParentBindings(definition.graph);
        if (dangling.length > 0) {
          diagnostics.push({
            severity: "warning",
            code: "component.detach.parentBindings",
            message: `${dangling.length} node(s) in the copy referenced parent.<key>; a detached copy has no parent, so those bindings no longer resolve.`,
            suggestion: "Set the affected parameters explicitly on the copy.",
          });
        }
        const applied = context.apply({
          label: `Copy "${definition.name}"`,
          recipe: (draft) => {
            const remap = copyInternalGraph(draft, definition.graph, position, context.ids);
            created.push(...Object.values(remap));
          },
        });
        return {
          status: "applied",
          revision: applied.revision,
          diagnostics,
          ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
          output: {
            ok: true,
            nodeId: null,
            nodeIds: created,
            componentId: definition.componentId,
            version: definition.version,
            diagnostics,
          },
        };
      }

      instanceNodeId = context.ids.node();
      const applied = context.apply({
        label: `Add "${definition.name}"`,
        recipe: (draft) => {
          draft.nodes[instanceNodeId as NodeId] = {
            id: instanceNodeId as NodeId,
            type: componentNodeType(definition.componentId, definition.version),
            // Pinned here and nowhere else: a newer definition never moves it (§V84).
            definitionVersion: definition.version,
            position,
            parameters: defaultPublishedValues(definition),
          };
        },
      });
      created.push(instanceNodeId);

      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: {
          ok: true,
          nodeId: instanceNodeId,
          nodeIds: created,
          componentId: definition.componentId,
          version: definition.version,
          diagnostics,
        },
      };
    },
  });

  bus.registerCommand({
    name: "component.detach",
    description: "Replace a linked instance with an independent copy of its internals (§V79).",
    handler: (input, context): CommandOutcome<DetachOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const fail = (): CommandOutcome<DetachOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: { ok: false, nodeIds: [], diagnostics },
      });

      const instance = context.graph.nodes[input.nodeId];
      if (instance === undefined) {
        diagnostics.push(error("node.missing", `Node "${input.nodeId}" does not exist.`));
        return fail();
      }
      const state = readComponentInstance(instance);
      if (state === null) {
        diagnostics.push(
          error("component.notAnInstance", `Node "${input.nodeId}" is not a component instance.`),
        );
        return fail();
      }
      const definition = components.get(state.componentId, state.version);
      if (definition === undefined) {
        diagnostics.push(
          error(
            "component.notInstalled",
            `Cannot detach: component "${state.componentId}" version ${state.version} is not installed.`,
            "A placeholder instance keeps its data but cannot be expanded (§V10).",
          ),
        );
        return fail();
      }

      const dangling = danglingParentBindings(definition.graph);
      if (dangling.length > 0) {
        diagnostics.push({
          severity: "warning",
          code: "component.detach.parentBindings",
          message: `${dangling.length} node(s) referenced parent.<key>; the copy has no parent, so those bindings no longer resolve.`,
          nodeId: input.nodeId,
        });
      }

      const created: NodeId[] = [];
      const applied = context.apply({
        label: `Detach "${definition.name}"`,
        recipe: (draft) => {
          const remap = copyInternalGraph(draft, definition.graph, instance.position, context.ids);
          created.push(...Object.values(remap));

          const inputById = new Map(definition.inputs.map((port) => [port.externalId, port]));
          const outputById = new Map(definition.outputs.map((port) => [port.externalId, port]));

          for (const edgeId of Object.keys(draft.edges).sort()) {
            const edge = draft.edges[edgeId] as GraphEdge | undefined;
            if (edge === undefined) continue;
            if (edge.target.nodeId === input.nodeId) {
              const exposed = inputById.get(edge.target.portId);
              const inner = exposed === undefined ? undefined : remap[exposed.nodeId];
              if (exposed === undefined || inner === undefined) {
                delete draft.edges[edgeId];
                continue;
              }
              edge.target = { nodeId: inner, portId: exposed.portId };
            }
            if (edge.source.nodeId === input.nodeId) {
              const exposed = outputById.get(edge.source.portId);
              const inner = exposed === undefined ? undefined : remap[exposed.nodeId];
              if (exposed === undefined || inner === undefined) {
                delete draft.edges[edgeId];
                continue;
              }
              edge.source = { nodeId: inner, portId: exposed.portId };
            }
          }

          delete draft.nodes[input.nodeId];
        },
      });

      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: { ok: true, nodeIds: created, diagnostics },
      };
    },
  });

  bus.registerCommand({
    name: "component.exposePort",
    description: "Surface an internal port on the component's boundary (T131).",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) {
        diagnostics.push(host === null ? NOT_INSIDE : error("component.notInstalled", "The component being edited is not installed."));
        return editOutcome(revision, false, host, diagnostics);
      }

      const node = definition.graph.nodes[input.nodeId];
      const port =
        node === undefined ? undefined : context.registry.port(node.type, input.portId, input.direction);
      if (node === undefined || port === undefined) {
        diagnostics.push(
          error(
            "component.port.missingPort",
            `"${input.nodeId}.${input.portId}" is not an ${input.direction} port inside "${definition.name}".`,
          ),
        );
        return editOutcome(revision, false, host, diagnostics);
      }

      const exposed: ExposedPort = {
        externalId: input.externalId ?? input.portId,
        label: input.label ?? port.label,
        nodeId: input.nodeId,
        portId: input.portId,
      };
      const next = withExposedPort(definition, input.direction, exposed);
      const ok = commitDefinition(context, next, diagnostics);
      return editOutcome(revision, ok, host, diagnostics);
    },
  });

  bus.registerCommand({
    name: "component.unexposePort",
    description: "Remove an exposed port from the component boundary (T131).",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) {
        diagnostics.push(NOT_INSIDE);
        return editOutcome(revision, false, host, diagnostics);
      }
      const next = withoutExposedPort(definition, input.direction, input.externalId);
      const ok = commitDefinition(context, next, diagnostics);
      return editOutcome(revision, ok, host, diagnostics);
    },
  });

  bus.registerCommand({
    name: "component.publishParameter",
    description: "Promote internal parameters onto the component's parameter page (§V80).",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) {
        diagnostics.push(NOT_INSIDE);
        return editOutcome(revision, false, host, diagnostics);
      }
      /*
       * A COMPLETE publish request, or a named refusal (§V288, B60's shape).
       *
       * Found by probing the row that names this command: the parameter context menu's
       * "Publish to component" resolves `{ nodeId, parameterKey }` through `parameterRef`
       * — a target, not a publish — and the handler THREW `Cannot read properties of
       * undefined (reading 'map')` on the click. That is B60 a third time: a menu row
       * naming a command whose input no menu route can supply. The row is the menus'
       * track to fix; a handler that crashes on a malformed call is this one's, and the
       * guard covers the agent and every future caller too, not just that row.
       */
      if (
        typeof input.key !== "string" ||
        input.key === "" ||
        input.definition === undefined ||
        !Array.isArray(input.targets)
      ) {
        diagnostics.push(
          error(
            "component.parameter.incomplete",
            "Publishing needs a page key, a re-authored parameter definition and the internal targets it drives.",
            "Publish from the component's parameter page, which supplies all three (§V80).",
          ),
        );
        return editOutcome(revision, false, host, diagnostics);
      }
      const next = withPublishedParameter(definition, {
        key: input.key,
        definition: input.definition,
        targets: input.targets.map((target) => ({ ...target })),
      });
      const ok = commitDefinition(context, next, diagnostics);
      return editOutcome(revision, ok, host, diagnostics);
    },
  });

  bus.registerCommand({
    name: "component.unpublishParameter",
    description: "Remove a parameter from the component's parameter page.",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) {
        diagnostics.push(NOT_INSIDE);
        return editOutcome(revision, false, host, diagnostics);
      }
      const ok = commitDefinition(context, withoutPublishedParameter(definition, input.key), diagnostics);
      return editOutcome(revision, ok, host, diagnostics);
    },
  });

  bus.registerCommand({
    name: "component.reorderParameter",
    description: "Move a published parameter on the component's parameter page (T423, §V80).",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) {
        diagnostics.push(NOT_INSIDE);
        return editOutcome(revision, false, host, diagnostics);
      }
      if (findPublishedParameter(definition, input.key) === undefined) {
        // Named, not silent: reordering a key that is not on the page means the caller
        // and the definition disagree about what the page holds (§V288).
        diagnostics.push(
          error(
            "component.parameter.unknown",
            `"${definition.name}" publishes no parameter "${input.key}".`,
          ),
        );
        return editOutcome(revision, false, host, diagnostics);
      }
      const next = reorderPublishedParameter(definition, input.key, input.toIndex);
      const ok = commitDefinition(context, next, diagnostics);
      return editOutcome(revision, ok, host, diagnostics);
    },
  });

  bus.registerCommand({
    name: "component.setPublishedParameter",
    description: "Turn a published knob: every internal target, one patch, one undo step (§V80).",
    handler: (input, context): CommandOutcome<GraphPatchResult> => {
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) return patchRejection(revision, [NOT_INSIDE]);

      const published = findPublishedParameter(definition, input.key);
      if (published === undefined) {
        return patchRejection(revision, [
          error(
            "component.parameter.unknown",
            `"${definition.name}" publishes no parameter "${input.key}".`,
          ),
        ]);
      }
      const operations = publishedParameterOperations(published, input.value);
      if (operations.length === 0) {
        return patchRejection(revision, [
          info("component.parameter.noTargets", `"${input.key}" drives no internal parameter.`),
        ]);
      }
      // ONE patch: all targets apply or none do (§V32) and the whole fan-out is a single
      // undo group (§V34). Three commands would be three undo steps and a half-applied
      // component after one undo.
      return applyGraphPatch(
        {
          baseRevision: context.graph.revision,
          label: `Set ${published.definition.label}`,
          operations,
        },
        context,
      );
    },
  });

  bus.registerCommand({
    name: "component.setParentBinding",
    description: "Bind an internal parameter to a published parameter of the owning component (§V81).",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const node = context.graph.nodes[input.nodeId];
      if (node === undefined) {
        diagnostics.push(error("node.missing", `Node "${input.nodeId}" does not exist.`));
        return editOutcome(revision, false, host, diagnostics);
      }
      if (input.reference !== null && parseParentReference(input.reference) === null) {
        diagnostics.push(
          error(
            "component.parentScope.malformed",
            `"${input.reference}" is not a parent reference.`,
            "Use parent.<key>, or parent.parent.<key> for an outer component (§V81).",
          ),
        );
        return editOutcome(revision, false, host, diagnostics);
      }
      if (host === null) {
        diagnostics.push({
          severity: "warning",
          code: "component.parentScope.noScope",
          message: "This node is in the root graph, where there is no parent component to read.",
        });
      }

      const applied = context.apply({
        label: input.reference === null ? "Unbind parameter" : "Bind parameter to parent",
        recipe: (draft) => {
          const target = draft.nodes[input.nodeId];
          if (target === undefined) return;
          const state: Record<string, unknown> = { ...(target.state ?? {}) };
          const raw = state[PARENT_BINDINGS_STATE_KEY];
          const bindings: Record<string, string> =
            typeof raw === "object" && raw !== null ? { ...(raw as Record<string, string>) } : {};
          if (input.reference === null) delete bindings[input.key];
          else bindings[input.key] = input.reference;
          if (Object.keys(bindings).length === 0) delete state[PARENT_BINDINGS_STATE_KEY];
          else state[PARENT_BINDINGS_STATE_KEY] = bindings;
          if (Object.keys(state).length === 0) delete target.state;
          else target.state = state;
        },
      });

      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: {
          ok: true,
          componentId: host?.componentId ?? null,
          version: host?.version ?? null,
          diagnostics,
        },
      };
    },
  });

  bus.registerCommand({
    name: "component.upgradeInstance",
    description: "Move one instance to another component version, explicitly and migrated (§V84).",
    handler: (input, context): CommandOutcome<UpgradeInstanceOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const fail = (): CommandOutcome<UpgradeInstanceOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: { ok: false, plan: null, migrations: [], diagnostics },
      });

      const instance = context.graph.nodes[input.nodeId];
      const state = instance === undefined ? null : readComponentInstance(instance);
      if (instance === undefined || state === null) {
        diagnostics.push(
          error("component.notAnInstance", `Node "${input.nodeId}" is not a component instance.`),
        );
        return fail();
      }

      const target =
        input.toVersion === undefined
          ? components.latest(state.componentId)
          : components.get(state.componentId, input.toVersion);
      if (target === undefined) {
        diagnostics.push(
          error(
            "component.notInstalled",
            `Component "${state.componentId}"${input.toVersion === undefined ? "" : ` version ${input.toVersion}`} is not installed.`,
          ),
        );
        return fail();
      }
      if (target.version === state.version) {
        diagnostics.push(
          info("component.upgrade.alreadyAtVersion", `Already at version ${state.version}.`),
        );
        return fail();
      }

      const plan = planComponentUpgrade({
        instance,
        from: components.get(state.componentId, state.version),
        to: target,
      });
      diagnostics.push(...plan.diagnostics);

      const removed = new Set([...plan.removedInputs, ...plan.removedOutputs]);
      const applied = context.apply({
        label: `Upgrade to ${target.name} v${target.version}`,
        recipe: (draft) => {
          const node = draft.nodes[input.nodeId] as GraphNode | undefined;
          if (node === undefined) return;
          node.type = componentNodeType(target.componentId, target.version);
          node.definitionVersion = target.version;
          node.parameters = plan.parameters;
          if (removed.size === 0) return;
          for (const edgeId of Object.keys(draft.edges).sort()) {
            const edge = draft.edges[edgeId];
            if (edge === undefined) continue;
            const touches =
              (edge.target.nodeId === input.nodeId && removed.has(edge.target.portId)) ||
              (edge.source.nodeId === input.nodeId && removed.has(edge.source.portId));
            if (touches) delete draft.edges[edgeId];
          }
        },
      });

      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: { ok: true, plan, migrations: plan.migrations, diagnostics },
      };
    },
  });

  bus.registerQuery({
    name: "component.list",
    description: "Installed components, latest version of each.",
    handler: (): ComponentSummary[] =>
      components.list().map((definition) => ({
        componentId: definition.componentId,
        version: definition.version,
        name: definition.name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputs: definition.inputs.map((port) => port.externalId),
        outputs: definition.outputs.map((port) => port.externalId),
        parameters: definition.parameters.map((published) => published.key),
        versions: components.versions(definition.componentId),
      })),
  });

  bus.registerQuery({
    name: "component.get",
    description: "One component definition, at a pinned version or the latest.",
    handler: (input): GraphComponentDefinition | null =>
      (input.version === undefined
        ? components.latest(input.componentId)
        : components.get(input.componentId, input.version)) ?? null,
  });

  bus.registerQuery({
    name: "component.upgrades",
    description: "Instances with a newer version available. Nothing acts on this (§V84).",
    handler: (_input, context): InstanceUpgradeSummary[] => {
      const summaries: InstanceUpgradeSummary[] = [];
      for (const nodeId of Object.keys(context.graph.nodes).sort()) {
        const node = context.graph.nodes[nodeId];
        if (node === undefined) continue;
        const upgrade = availableUpgrade(node, components);
        if (upgrade !== null) summaries.push({ nodeId, ...upgrade });
      }
      return summaries;
    },
  });
}
