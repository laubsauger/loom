import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type {
  ComponentMigration,
  ExposedPort,
  GraphComponentDefinition,
} from "../types/components.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { ComponentId, NodeId, PortId, Revision } from "../types/ids.ts";
import type { ParameterDefinition, ParameterSchema, ParameterValue } from "../types/parameters.ts";
import type { GraphPatchResult } from "../types/patch.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "../commands/bus.ts";
import { applyGraphPatch, dropUnusedTies } from "../commands/apply-patch.ts";
import { z } from "zod";
import { idInput, nodeIdsInput, pointInput } from "../commands/input-schema.ts";
import { parameterValueSchema } from "../types/schemas.ts";
import { parameterDefinitionSchema } from "./schemas.ts";
import { attachClipboardComponents } from "../commands/loom-clipboard.ts";
import { renumberedName, rewriteNodeNameReferences, uniqueNodeName } from "../graph/names.ts";
import { kindFromName } from "../graph/node-kinds.ts";
import { withBoundaryPorts } from "./boundary-ports.ts";
import { componentClipboard } from "./component-clipboard.ts";
import { componentNodeType } from "./component-type.ts";
import { parseInternalParameterPath, readComponentInstance, PARENT_BINDINGS_STATE_KEY } from "./instance.ts";
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
import { registerComponentFileCommands, type ComponentFileReader, type ComponentFileWriter } from "./file-commands.ts";
import { pageBanksOf, presetCatalogueHolderFor } from "../presets/bank-view.ts";
import { detachedPageBank } from "../presets/detach-page-bank.ts";
import { effectiveParameterSchema } from "../parameters/resolve.ts";
import { detachedValues, nestedParentReads, type DetachedValues, type MovedOuterTarget } from "./detach-values.ts";
import { publishedSchema } from "./published-page.ts";
import { pruneComponentDefinition } from "./definition.ts";
import { carryInstanceChannelMask, internalChannelMasks } from "./internal-channel-masks.ts";
import { internalResolutions } from "./internal-resolutions.ts";
import { applyInstance } from "./apply-instance.ts";

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
  /**
   * Author-chosen socket names, keyed by the internal endpoint that crosses the boundary
   * (`"<nodeId>.<portId>"`). T1194 — the ONE moment a socket can be named, because after
   * this the name is an address parents are wired by (§B170). See `SaveSelectionInput`.
   */
  portNames?: Readonly<Record<string, string>>;
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
  /** T1553b: internal node id (in the definition) -> the id of its copy. Empty when refused. */
  copies: Readonly<Record<NodeId, NodeId>>;
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
  /**
   * Where `component.export` writes (T1395b): the composition root's `writeTextFile`.
   * Absent on a session bus or a headless harness, where export refuses by name.
   */
  writeFile?: ComponentFileWriter;
  /** Where `component.import` asks for a file when it is given none (T1494b). Absent: it refuses. */
  readFile?: ComponentFileReader;
  /**
   * T1519b: whether this host's file picker keeps a retained reference (File System
   * Access), so `component.export`'s refusal of a session-only file can name the fix.
   * Absent: false — the refusal says the file is session-only on this host.
   */
  retainsPickedFiles?: boolean;
  /**
   * §T1545b: a command re-registered the host definition as part of the graph step
   * `undoGroupId` (an in-session detach moving the outer page onto the copies). The session
   * records the definition with that step, so undo and redo restore it with the graph.
   * §T1546b: also called for a definition-only edit, whose step is `context.applyStep`.
   */
  onDefinitionStep?: (undoGroupId: string) => void;
  /**
   * §T1545b: the project document, READ-ONLY, for a session bus — so an in-session detach can
   * name the root instances whose paths into the detached instance it leaves dangling
   * (`danglingInstancePaths`). Absent: only the catalogue's holders are found.
   */
  rootGraph?: () => GraphDocument;
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
  undoGroupId?: string,
): CommandOutcome<ComponentEditOutput> {
  return {
    status: ok ? "applied" : "rejected",
    revision,
    diagnostics,
    ...(undoGroupId === undefined ? {} : { undoGroupId }),
    output: {
      ok,
      componentId: host?.componentId ?? null,
      version: host?.version ?? null,
      diagnostics,
    },
  };
}

/** §T1556b: the input schemas' shared pieces. A component version is a positive integer. */
const versionInput = z.number().int().positive();
const portDirection = z.enum(["input", "output"]);

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
      // T1553b: a variadic port's declared order (§V131) survives the copy, as it survives
      // flattening (B155) — the new ids sort however they sort, so dropping it re-stacked layers.
      ...(edge.order === undefined ? {} : { order: edge.order }),
      source: { nodeId: source, portId: edge.source.portId },
      target: { nodeId: target, portId: edge.target.portId },
    };
  }

  return remap;
}

/**
 * T1541b — a detached LOOK's page bank (targets `parent`) would land as a root bank whose
 * `parent` names nothing. Detach and (T1545b) detached instantiate both come through here.
 * The one its instances use is rewritten onto the copies
 * (`detachedPageBank`: Targets and presets through the published mapping, the instance's
 * current preset and running fades with them) and said as an info; when that cannot be
 * exact — or for a second page bank, which no instance used — it is left as it was and a
 * warning names it as inert, and why. Returns what to say.
 */
function rewritePageBanks(
  draft: GraphDocument,
  definition: GraphComponentDefinition,
  instance: GraphNode,
  remap: Readonly<Record<NodeId, NodeId>>,
): RuntimeDiagnostic[] {
  const said: RuntimeDiagnostic[] = [];
  const look = instance.label ?? instance.id;
  const nameOf = (internalId: NodeId): string | undefined => {
    const copyId = remap[internalId];
    return copyId === undefined ? undefined : draft.nodes[copyId]?.label;
  };
  for (const [index, pageBank] of pageBanksOf(definition).entries()) {
    const copyId = remap[pageBank.id];
    const copy = copyId === undefined ? undefined : draft.nodes[copyId];
    if (copyId === undefined || copy === undefined) continue;
    const name = copy.label ?? copyId;
    const rewritten =
      index === 0
        ? detachedPageBank(definition, copy, instance, nameOf)
        : { ok: false as const, reasons: [`"${definition.name}" used only its first preset bank targeting parent`] };
    if (rewritten.ok) {
      draft.nodes[copyId] = { ...copy, parameters: { ...copy.parameters, ...rewritten.parameters } };
      said.push({
        severity: "info",
        code: "component.detach.pageBank",
        message: `Preset bank "${name}" was rewritten for the detached copy: it now targets ${rewritten.targets === "" ? "nothing" : rewritten.targets}, its presets set those parameters, and it keeps "${look}"'s current preset and any fade in flight.`,
        nodeId: copyId,
      });
    } else {
      said.push({
        severity: "warning",
        code: "component.detach.pageBankInert",
        message: `Preset bank "${name}" targets parent, which names nothing once "${look}" is detached, and it could not be rewritten exactly: ${rewritten.reasons.join("; ")}. Its recalls now do nothing.`,
        nodeId: copyId,
        suggestion: "Set its Targets and presets by hand, or undo the detach.",
      });
    }
  }
  return said;
}

/**
 * B238/B239 — everything a detached copy needs decided BEFORE the patch: the values
 * (`detachedValues`), and the definition graph with the instance's own internal channel
 * masks and resolution overrides written onto it. T1553b: the page, its fan-out and that
 * graph are flattening's own projection of the instance (`applyInstance`), not a second
 * assembly of the same parts. What cannot be carried exactly is said, by name.
 */
interface DetachPlan {
  readonly values: DetachedValues;
  readonly graph: GraphDocument;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

function planDetach(input: {
  readonly definition: GraphComponentDefinition;
  readonly instance: GraphNode;
  /** The id diagnostics name; absent for a detached instantiate, which has no instance. */
  readonly nodeId?: NodeId;
  readonly components: ComponentRegistry;
  readonly registry: CommandContext["registry"];
  readonly outerTargets?: ReadonlyMap<string, readonly string[]>;
  /** T1545b: the session host's published page, for the carried-range check. */
  readonly outerSchema?: ParameterSchema;
  /** T1545b: the document holding the instance, for its own Processing Channels. */
  readonly outer?: GraphDocument;
}): DetachPlan {
  const { definition, instance, nodeId } = input;
  const at = nodeId === undefined ? {} : { nodeId };
  const definitionOf = (node: GraphNode): GraphComponentDefinition | undefined => {
    const nested = readComponentInstance(node);
    return nested === null ? undefined : input.components.get(nested.componentId, nested.version);
  };
  const applied = applyInstance({ definition, instance });
  const values = detachedValues({
    definition,
    instance,
    applied,
    schemaOf: (node) => {
      const nested = definitionOf(node);
      return nested === undefined ? effectiveParameterSchema(input.registry.get(node.type), node.parameters) : publishedSchema(nested);
    },
    ...(input.outerTargets === undefined ? {} : { outerTargets: input.outerTargets }),
    ...(input.outerSchema === undefined ? {} : { outerSchema: input.outerSchema }),
  });
  const look = instance.label ?? nodeId ?? definition.name;
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const nestedId of nestedParentReads(definition.graph, definitionOf)) {
    const nested = definition.graph.nodes[nestedId];
    diagnostics.push({
      severity: "warning",
      code: "component.detach.nestedParentReads",
      message: `"${nested?.label ?? nestedId}" inside "${look}" holds a component that reads past its own parent with parent.parent.<key>; with "${look}" detached, that read names one component further out.`,
      ...at,
      suggestion: "Undo the detach, or bind those parameters inside the nested component instead.",
    });
  }
  for (const message of values.inexact) {
    diagnostics.push({ severity: "warning", code: "component.detach.inexact", message: `${message}.`, ...at, suggestion: "Set it by hand on the copies, or undo the detach." });
  }
  for (const [what, missing] of [["channel mask", applied.missing.channelMasks], ["resolution", applied.missing.resolutions]] as const) {
    for (const path of missing) {
      diagnostics.push({
        severity: "warning",
        code: "component.detach.overrideMissing",
        message: `"${look}" carried a ${what} override for internal node "${path}", which "${definition.name}" does not have; the copies do not carry it.`,
        ...at,
      });
    }
  }
  // T1545b: the instance's own Processing Channels, onto the node behind each output when
  // that draws the same picture (`carryInstanceChannelMask`); otherwise said by name.
  const channels = input.outer === undefined ? { graph: applied.graph } : carryInstanceChannelMask({ graph: applied.graph, definition, instance, outer: input.outer, registry: input.registry });
  if (channels.reason !== undefined) {
    const mask = instance.channelMask;
    const kept = mask === undefined ? "" : (["r", "g", "b", "a"] as const).filter((channel) => mask[channel]).map((channel) => channel.toUpperCase()).join(" ");
    diagnostics.push({
      severity: "warning",
      code: "component.detach.channelMask",
      message: `"${look}"'s Processing Channels (${kept === "" ? "none" : kept}) cannot be carried onto the copies exactly: ${channels.reason}. The copies draw every channel.`,
      ...at,
      suggestion: "Set Processing Channels on the copies by hand, or undo the detach.",
    });
  }
  return { values, graph: channels.graph, diagnostics };
}

/** Writes a planned detach into `draft`: the copies, holding the plan's values. */
function writeDetach(
  draft: GraphDocument,
  plan: DetachPlan,
  position: { x: number; y: number },
  ids: { node: () => string; edge: () => string },
): { remap: Record<NodeId, NodeId>; baked: number; moved: MovedOuterTarget[] } {
  const remap = copyInternalGraph(draft, plan.graph, position, ids);
  let baked = 0;
  const moved: MovedOuterTarget[] = [];
  for (const internalId of Object.keys(remap).sort()) {
    const copyId = remap[internalId] as NodeId;
    const copied = draft.nodes[copyId];
    if (copied === undefined) continue;
    const written = plan.values.copy(internalId, copied);
    draft.nodes[copyId] = written.node;
    baked += written.baked;
    moved.push(...written.moved);
  }
  return { remap, baked, moved };
}

/**
 * §T1545b — PATHS INTO A DETACHED NESTED INSTANCE, held outside the session. An instance of
 * the component being edited may address the nested instance `inner` by path from wherever
 * it sits: `componentOverrides` (`inner/<key>`), `componentResolutionOverrides` and
 * `componentChannelMaskOverrides` (`inner` or `inner/<descendant>`). Detaching `inner`
 * inside the session leaves those paths naming nothing. They live in the project document
 * and in other components' definitions — other stores, with undo histories of their own — so
 * the session cannot rewrite them as part of its own undo step (a rewrite would survive the
 * session's undo and dangle the other way). They are said, per holder, by name, with what
 * each path would name on the copies.
 */
function danglingInstancePaths(input: {
  readonly host: ComponentHost;
  readonly detachedId: NodeId;
  readonly look: string;
  readonly copyName: (internalId: NodeId) => string | undefined;
  readonly holders: ReadonlyArray<{ readonly where: string; readonly graph: GraphDocument }>;
}): RuntimeDiagnostic[] {
  const said: RuntimeDiagnostic[] = [];
  const prefix = `${input.detachedId}/`;
  const read = <T,>(reader: () => Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
    try {
      return reader();
    } catch {
      return {};
    }
  };
  for (const holder of input.holders) {
    for (const node of Object.values(holder.graph.nodes)) {
      const state = readComponentInstance(node);
      if (state === null || state.componentId !== input.host.componentId || state.version !== input.host.version) continue;
      const paths: string[] = [];
      const onCopies: string[] = [];
      for (const path of Object.keys(state.overrides ?? {}).sort()) {
        if (parseInternalParameterPath(path)?.nodeId === input.detachedId) paths.push(`override ${path}`);
      }
      for (const [what, record] of [
        ["resolution", read(() => internalResolutions(node))],
        ["channel mask", read(() => internalChannelMasks(node))],
      ] as const) {
        for (const path of Object.keys(record).sort()) {
          if (path !== input.detachedId && !path.startsWith(prefix)) continue;
          paths.push(`${what} ${path}`);
          const rest = path.slice(prefix.length).split("/");
          const copy = path === input.detachedId ? undefined : input.copyName(rest[0] as NodeId);
          if (copy !== undefined) onCopies.push(`${what} ${[copy, ...rest.slice(1)].join("/")}`);
        }
      }
      if (paths.length === 0) continue;
      said.push({
        severity: "warning",
        code: "component.detach.instancePaths",
        message: `"${node.label ?? node.id}" in ${holder.where} sets ${paths.join(", ")} inside "${input.look}"; with "${input.look}" detached, those paths name nothing.`,
        nodeId: input.detachedId,
        suggestion: `Set them again on ${node.label ?? node.id}${onCopies.length === 0 ? "" : ` (${onCopies.join(", ")})`}, or undo the detach. This editor cannot rewrite them: they live in ${holder.where}, outside this component's undo history.`,
      });
    }
  }
  return said;
}

/** §T1546b: the two definitions agree on everything beside the graph. */
function sameDefinitionShell(a: GraphComponentDefinition, b: GraphComponentDefinition): boolean {
  const { graph: _a, ...left } = a;
  const { graph: _b, ...right } = b;
  void _a;
  void _b;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function registerComponentCommands(bus: LoomBus, options: ComponentCommandOptions): void {
  const components = options.components;
  const host = options.host ?? null;

  /**
   * §T1556b: what an edit command answers when the bus refuses its input before the handler
   * runs, in the shape its own refusals have. The parameter menu's "Publish to component" row
   * sends a target, not a publish, and must get a refusal back, not a throw.
   */
  const editRejection = (_input: unknown, diagnostics: RuntimeDiagnostic[]): ComponentEditOutput => ({
    ok: false,
    componentId: host?.componentId ?? null,
    version: host?.version ?? null,
    diagnostics,
  });
  const patchRejectionOutput = (_input: unknown, diagnostics: RuntimeDiagnostic[], revision: Revision): GraphPatchResult =>
    patchRejection(revision, diagnostics).output;
  const requireHostDefinition = (): GraphComponentDefinition | undefined =>
    host === null ? undefined : components.get(host.componentId, host.version);

  /** A changed published schema can activate a previously unresolved parent/page read. */
  const publicationCycles = (context: CommandContext, next: GraphComponentDefinition): RuntimeDiagnostic[] => {
    const before = components.get(next.componentId, next.version);
    if (before === undefined || JSON.stringify(before.parameters) === JSON.stringify(next.parameters)) return [];
    const prior = context.referenceCycles(before.graph, null, { componentId: before.componentId, version: before.version, definition: before });
    const known = new Set(prior.filter(d => d.code === "parameter.referenceCycle").map(d => d.message));
    return context.referenceCycles(next.graph, null, { componentId: next.componentId, version: next.version, definition: next })
      .filter(d => d.code !== "parameter.referenceCycle" || !known.has(d.message));
  };

  /**
   * Registers a re-authored definition unless this was a dry run (§V36). `undoGroupId`: the
   * graph step this re-registration belongs to, so undo restores it too (§T1545b).
   */
  const commitDefinition = (
    context: CommandContext,
    next: GraphComponentDefinition,
    diagnostics: RuntimeDiagnostic[],
    undoGroupId?: string,
  ): boolean => {
    const problems = [...components.validate(next), ...publicationCycles(context, next)];
    diagnostics.push(...problems);
    if (problems.some((diagnostic) => diagnostic.severity === "error")) return false;
    if (!context.dryRun) {
      components.register(next);
      if (undoGroupId !== undefined) options.onDefinitionStep?.(undoGroupId);
    }
    return true;
  };

  /**
   * §T1546b: a DEFINITION-ONLY edit (publish, unpublish, expose, unexpose, reorder) as an
   * undo step of its own. It changes no graph, so `context.applyStep` records the step — the
   * revision, the audit entry, the slot in the actor's history — and the definition is
   * registered INSIDE it, so `onDefinitionStep` pairs the before/after with that step exactly
   * as for detach. The step comes first so that a coalesced step keeps the definition from
   * where it began. The session leaves the definition's graph alone on a step with no graph
   * entity in it, so `next` registers as built. An edit that changes nothing makes no step.
   */
  const commitDefinitionStep = (
    context: CommandContext,
    label: string,
    next: GraphComponentDefinition,
    diagnostics: RuntimeDiagnostic[],
  ): CommandOutcome<ComponentEditOutput> => {
    const problems = [...components.validate(next), ...publicationCycles(context, next)];
    diagnostics.push(...problems);
    const failed = problems.some((diagnostic) => diagnostic.severity === "error");
    const current = requireHostDefinition();
    if (failed || context.dryRun || host === null || current === undefined || sameDefinitionShell(current, next)) {
      return editOutcome(context.store.getRevision(), !failed, host, diagnostics);
    }
    const applied = context.applyStep({ label });
    components.register(next);
    if (applied.undoGroupId !== undefined) options.onDefinitionStep?.(applied.undoGroupId);
    return editOutcome(applied.revision, true, host, diagnostics, applied.undoGroupId);
  };

  bus.registerCommand({
    name: "component.saveSelection",
    inSession: "definition",
    inputSchema: z.object({ nodeIds: nodeIdsInput, name: z.string(), description: z.string().optional(), componentId: idInput.optional(), portNames: z.record(z.string()).optional() }).strict(),
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
        ...(input.portNames === undefined ? {} : { portNames: input.portNames }),
        nodes: context.registry,
        components,
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
          // Peers left standing must keep the same total order as the reminted edges.
          for (const [edgeId, order] of Object.entries(built.edgeOrders)) draft.edges[edgeId]!.order = order;
          for (const edgeId of built.removedEdgeIds) delete draft.edges[edgeId];
          for (const nodeId of Object.keys(built.definition.graph.nodes)) delete draft.nodes[nodeId];

          draft.nodes[instanceNodeId] = {
            id: instanceNodeId,
            type: componentNodeType(componentId, version),
            definitionVersion: version,
            position: built.position,
            parameters: defaultPublishedValues(built.definition),
            // T1593b: named for its component, like an instance from the library, an import
            // or an `addNode` (`mattecut1`). The selection is already out of the draft, so a
            // node it held cannot be what the number is counted against. Every shipped
            // starter component is authored through this command, which is why the 12 files
            // under `examples/components/` each carry this label on their root instance.
            label: uniqueNodeName(draft, kindFromName(built.definition.name)),
          };

          for (const wiring of built.inputWiring) {
            const edgeId = context.ids.edge();
            draft.edges[edgeId] = {
              id: edgeId,
              source: { ...wiring.outer },
              target: { nodeId: instanceNodeId, portId: wiring.externalId },
              ...(wiring.order === undefined ? {} : { order: wiring.order }),
              ...(wiring.via === undefined ? {} : { via: [...wiring.via] }),
            };
          }
          for (const wiring of built.outputWiring) {
            const edgeId = context.ids.edge();
            draft.edges[edgeId] = {
              id: edgeId,
              source: { nodeId: instanceNodeId, portId: wiring.externalId },
              target: { ...wiring.outer },
              ...(wiring.order === undefined ? {} : { order: wiring.order }),
              ...(wiring.via === undefined ? {} : { via: [...wiring.via] }),
            };
          }
          // T1821b(b), §V1040: the inside wires took their ties into the component; a tie
          // no wire left in the parent passes goes, in this same undo step.
          dropUnusedTies(draft);
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
    rejectionOutput: (_input, diagnostics): SaveSelectionOutput => ({
      ok: false, componentId: null, version: null, instanceNodeId: null, exposedInputs: [], exposedOutputs: [], diagnostics,
    }),
  });

  bus.registerCommand({
    name: "component.instantiate",
    inSession: "definition",
    inputSchema: z.object({ componentId: idInput, version: versionInput.optional(), position: pointInput.optional(), mode: z.enum(["linked", "detached"]).optional() }).strict(),
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
        // B239: a detached copy is what detaching a fresh linked instance gives — the page
        // at its published DEFAULTS, written onto the copies by detach's own rule — not the
        // definition's internal values, which a published default need not equal.
        const fresh: GraphNode = {
          id: "",
          type: componentNodeType(definition.componentId, definition.version),
          definitionVersion: definition.version,
          label: definition.name,
          position,
          parameters: defaultPublishedValues(definition),
        };
        const plan = planDetach({ definition, instance: fresh, components, registry: context.registry });
        diagnostics.push(...plan.diagnostics);
        const applied = context.apply({
          label: `Copy "${definition.name}"`,
          recipe: (draft) => {
            const written = writeDetach(draft, plan, position, context.ids);
            created.push(...Object.values(written.remap));
            if (written.baked > 0) {
              diagnostics.push({
                severity: "info",
                code: "component.detach.parentValues",
                message: `${written.baked} parameter(s) read "${definition.name}"'s page through parent.<key>; the copies hold its default values.`,
              });
            }
            // T1545b: a look's page bank targets `parent`, which names nothing once copied —
            // rewritten onto the copies exactly as detach rewrites it (`rewritePageBanks`).
            diagnostics.push(...rewritePageBanks(draft, definition, fresh, written.remap));
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
            // T1593b (ruled 2026-10-05): a new instance is NAMED, for its component —
            // `bloom1`, then `bloom2`. It used to be left unnamed, which made it the one
            // new node `op('…')` could not address until someone renamed it.
            label: uniqueNodeName(draft, kindFromName(definition.name)),
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
    rejectionOutput: (input, diagnostics): InstantiateOutput => ({
      ok: false, nodeId: null, nodeIds: [], version: null, diagnostics,
      componentId: typeof (input as Partial<InstantiateInput> | null)?.componentId === "string" ? (input as InstantiateInput).componentId : "",
    }),
  });

  bus.registerCommand({
    name: "component.detach",
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput }).strict(),
    description: "Replace a linked instance with an independent copy of its internals (§V79).",
    handler: (input, context): CommandOutcome<DetachOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const fail = (): CommandOutcome<DetachOutput> => ({
        status: "rejected",
        revision,
        diagnostics,
        output: { ok: false, nodeIds: [], copies: {}, diagnostics },
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

      // B238: the copies hold what the instance's page put on screen — flattening's rule,
      // written once (`detachedValues`) — not the definition's own values.
      // B239: inside a component edit session, the component being edited may publish
      // knobs ONTO this instance's page; those move onto the copies the page key drove.
      const hostDefinition = requireHostDefinition();
      const look = instance.label ?? input.nodeId;
      const outerTargets = new Map<string, string[]>();
      const pageSchema = publishedSchema(definition);
      for (const published of hostDefinition?.parameters ?? []) {
        for (const target of published.targets) {
          if (target.nodeId !== input.nodeId) continue;
          if (!Object.hasOwn(pageSchema, target.key)) {
            diagnostics.push({
              severity: "warning",
              code: "component.detach.outerTarget",
              message: `"${hostDefinition?.name}"'s published ${published.key} drove ${target.key}, one channel of "${look}"'s ${target.key.split(".")[0]}; it cannot be moved onto the copies exactly and no longer drives it.`,
              nodeId: input.nodeId,
              suggestion: "Republish the channel on the copies, or undo the detach.",
            });
            continue;
          }
          const keys = outerTargets.get(target.key) ?? [];
          outerTargets.set(target.key, keys);
          keys.push(published.key);
        }
      }
      const plan = planDetach({
        definition,
        instance,
        nodeId: input.nodeId,
        components,
        registry: context.registry,
        ...(outerTargets.size === 0 ? {} : { outerTargets }),
        ...(hostDefinition === undefined ? {} : { outerSchema: publishedSchema(hostDefinition) }),
        outer: context.graph,
      });
      diagnostics.push(...plan.diagnostics);

      const created: NodeId[] = [];
      let moved: MovedOuterTarget[] = [];
      let copiedAs: Readonly<Record<NodeId, NodeId>> = {};
      const applied = context.apply({
        label: `Detach "${definition.name}"`,
        recipe: (draft) => {
          const written = writeDetach(draft, plan, instance.position, context.ids);
          const remap = written.remap;
          created.push(...Object.values(remap));
          moved = written.moved;
          copiedAs = remap;
          if (written.baked > 0) {
            diagnostics.push({
              severity: "info",
              code: "component.detach.parentValues",
              message: `${written.baked} parameter(s) read "${look}"'s page through parent.<key>; the copies hold the values they read.`,
              nodeId: input.nodeId,
            });
          }
          diagnostics.push(...rewritePageBanks(draft, definition, instance, remap));

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

      // B239: the outer page's targets on the instance, moved onto the copies the page key
      // drove (the session has just written the new graph back, pruning the instance's
      // targets; this re-registers the page with the moves). Built from the page as it was
      // before the detach, so a knob whose only target was the instance is not lost before
      // its move lands. The outer component's exposed ports on the instance move the same
      // way, through the detached definition's own exposures — as the outside edges do.
      const names = (each: { nodeId: NodeId }): boolean => each.nodeId === input.nodeId;
      const referenced =
        hostDefinition !== undefined &&
        (hostDefinition.inputs.some(names) || hostDefinition.outputs.some(names) || hostDefinition.parameters.some((published) => published.targets.some(names)));
      if (host !== null && hostDefinition !== undefined && referenced && !context.dryRun) {
        const reexpose = (ports: readonly ExposedPort[], inner: readonly ExposedPort[]): ExposedPort[] =>
          ports.map((port) => {
            if (!names(port)) return port;
            const exposed = inner.find((each) => each.externalId === port.portId);
            const copyId = exposed === undefined ? undefined : copiedAs[exposed.nodeId];
            // Unmappable: left naming the instance, which the prune below drops.
            return exposed === undefined || copyId === undefined ? port : { ...port, nodeId: copyId, portId: exposed.portId };
          });
        const parameters = hostDefinition.parameters.map((published) => {
          const targets = new Map<string, { nodeId: NodeId; key: string }>();
          for (const target of published.targets) {
            const onCopies = moved
              .filter((move) => move.outerKey === published.key && move.pageKey === target.key)
              .map((move) => ({ nodeId: move.nodeId, key: move.key }));
            // B240: a target that reaches no copy is left naming the instance, which the
            // prune below drops — so the knob goes only if that was its last target and
            // nothing reads parent.<key> (a page key with no targets of its own hands its
            // parent.<pageKey> readers to this knob, and they keep it).
            const next = target.nodeId !== input.nodeId || onCopies.length === 0 ? [target] : onCopies;
            for (const each of next) targets.set(`${each.nodeId}\u0000${each.key}`, each);
          }
          return { ...published, targets: [...targets.values()] };
        });
        const current = components.get(host.componentId, host.version) ?? hostDefinition;
        const pruned = pruneComponentDefinition(
          {
            ...current,
            graph: context.store.getGraph(),
            inputs: reexpose(hostDefinition.inputs, definition.inputs),
            outputs: reexpose(hostDefinition.outputs, definition.outputs),
            parameters,
          },
          context.registry,
          components,
        );
        for (const published of hostDefinition.parameters) {
          if (!published.targets.some(names) || pruned.parameters.some((each) => each.key === published.key)) continue;
          diagnostics.push({
            severity: "warning",
            code: "component.detach.outerTarget",
            message: `"${hostDefinition.name}"'s published ${published.key} drove only "${look}"'s page, the key it drove reaches no copy, and nothing reads parent.${published.key}; ${published.key} is unpublished.`,
            nodeId: input.nodeId,
            suggestion: "Republish it onto the copies, or undo the detach.",
          });
        }
        commitDefinition(context, pruned, diagnostics, applied.undoGroupId);
      }
      if (host !== null && !context.dryRun) {
        diagnostics.push(
          ...danglingInstancePaths({
            host,
            detachedId: input.nodeId,
            look,
            copyName: (internalId) => {
              const copyId = copiedAs[internalId];
              return copyId === undefined ? undefined : (context.store.getGraph().nodes[copyId]?.label ?? copyId);
            },
            holders: [
              ...(options.rootGraph === undefined ? [] : [{ where: "the project", graph: options.rootGraph() }]),
              ...components
                .all()
                .filter((each) => each.componentId !== host.componentId || each.version !== host.version)
                .map((each) => ({ where: `component "${each.name}"`, graph: each.graph })),
            ],
          }),
        );
      }

      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: { ok: true, nodeIds: created, copies: copiedAs, diagnostics },
      };
    },
    rejectionOutput: (_input, diagnostics): DetachOutput => ({ ok: false, nodeIds: [], copies: {}, diagnostics }),
  });

  bus.registerCommand({
    name: "component.exposePort",
    inSession: "definition",
    inputSchema: z.object({ direction: portDirection, nodeId: idInput, portId: idInput, externalId: idInput.optional(), label: z.string().optional() }).strict(),
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
        ...(input.direction === "input" && port.variadic === true ? { variadic: true } : {}),
      };
      const next = withExposedPort(definition, input.direction, exposed);
      return commitDefinitionStep(context, `Expose ${exposed.label}`, next, diagnostics);
    },
    rejectionOutput: editRejection,
  });

  bus.registerCommand({
    name: "component.unexposePort",
    inSession: "definition",
    inputSchema: z.object({ direction: portDirection, externalId: idInput }).strict(),
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
      return commitDefinitionStep(context, `Unexpose ${input.externalId}`, next, diagnostics);
    },
    rejectionOutput: editRejection,
  });

  bus.registerCommand({
    name: "component.publishParameter",
    inSession: "definition",
    inputSchema: z.object({ key: idInput, definition: parameterDefinitionSchema, targets: z.array(z.object({ nodeId: idInput, key: idInput }).strict()) }).strict(),
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
      return commitDefinitionStep(context, `Publish ${input.definition.label}`, next, diagnostics);
    },
    rejectionOutput: editRejection,
  });

  bus.registerCommand({
    name: "component.unpublishParameter",
    inSession: "definition",
    inputSchema: z.object({ key: idInput }).strict(),
    description: "Remove a parameter from the component's parameter page.",
    handler: (input, context): CommandOutcome<ComponentEditOutput> => {
      const diagnostics: RuntimeDiagnostic[] = [];
      const revision = context.store.getRevision();
      const definition = requireHostDefinition();
      if (host === null || definition === undefined) {
        diagnostics.push(NOT_INSIDE);
        return editOutcome(revision, false, host, diagnostics);
      }
      return commitDefinitionStep(context, `Unpublish ${input.key}`, withoutPublishedParameter(definition, input.key), diagnostics);
    },
    rejectionOutput: editRejection,
  });

  bus.registerCommand({
    name: "component.reorderParameter",
    inSession: "definition",
    inputSchema: z.object({ key: idInput, toIndex: z.number().int() }).strict(),
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
      return commitDefinitionStep(context, `Reorder ${input.key}`, next, diagnostics);
    },
    rejectionOutput: editRejection,
  });

  bus.registerCommand({
    name: "component.setPublishedParameter",
    inSession: "definition",
    inputSchema: z.object({ key: idInput, value: parameterValueSchema }).strict(),
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
    rejectionOutput: patchRejectionOutput,
  });

  bus.registerCommand({
    name: "component.setParentBinding",
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, key: idInput, reference: z.string().nullable() }).strict(),
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
    rejectionOutput: editRejection,
  });

  bus.registerCommand({
    name: "component.upgradeInstance",
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, toVersion: versionInput.optional() }).strict(),
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
    rejectionOutput: (_input, diagnostics): UpgradeInstanceOutput => ({ ok: false, plan: null, migrations: [], diagnostics }),
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

  // T1395b: one component crossing a document boundary as a file.
  registerComponentFileCommands(bus, {
    components,
    host,
    ...(options.writeFile === undefined ? {} : { writeFile: options.writeFile }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.retainsPickedFiles === undefined ? {} : { retainsPickedFiles: options.retainsPickedFiles }),
  });
  // T1493b: and crossing it on the clipboard — a node copy carries the definitions its
  // instances need, and `graph.paste` installs them by the same identity rule.
  attachClipboardComponents(bus, componentClipboard({ components, host }));
  // T1505b: and to the preset commands, so an instance whose component holds a page bank
  // is a bank from outside (`bank-view.ts`); a bus with no catalogue refuses one by name.
  presetCatalogueHolderFor(bus).current = { components, host };
}
