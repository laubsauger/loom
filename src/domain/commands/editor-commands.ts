import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId, Revision } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { GraphPatchOperation, GraphPatchResult } from "../types/patch.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";
import { nodeNames, renumberedName, rewriteNodeNameReferences } from "../graph/names.ts";
import { applyGraphPatch } from "./apply-patch.ts";

/**
 * The editing commands the keymap and the palette name (§V52, §V29).
 *
 * Track Q's default keymap names ~30 commands; these are the ones that are actually
 * implementable against today's document contract. Every one of them is a real
 * implementation that goes through `graph.applyPatch`, so atomicity, audit, undo
 * grouping and dryRun come from the one place that already has them (§V32, §V34, §V36) —
 * a second mutation route would be a second place to forget them.
 *
 * DELIBERATELY NOT REGISTERED, and reported `unresolved` by the engine instead:
 *  - `view.*`, `graph.diveIn`, `graph.jumpUp` — viewport and subgraph navigation. `view.*`
 *    is built and registers beside the canvas (`src/app/view-commands.ts`); subgraphs do
 *    not exist. `graph.layout*` was on this list until B84 and now registers in
 *    `./layout-commands.ts` — same bus, same patch path, its own module.
 *  - `transport.*`, `runtime.resetFeedback` — there is no running frame loop to drive.
 *  - `project.save` — persistence is T43.
 *  - `node.rename` — `GraphNode` has NO per-instance name field, and no patch operation
 *    writes one. Registering it would mean either inventing a document field outside a
 *    contract change or writing a command that quietly does nothing. Both are worse than
 *    an honest "unavailable" in the palette.
 *  - `graph.selectAll`, `ui.*` — selection and chrome are view state, not document state.
 *    Their owner registers them (the palette does exactly this for `ui.openCommandPalette`).
 */
export interface RenameInput {
  nodeId: NodeId;
  /** null clears the label so the node follows its definition's title again. */
  label: string | null;
}

declare module "../types/commands.ts" {
  interface CommandMap {
    /** Delete nodes and their incident edges (§V40). */
    "graph.removeNodes": { input: NodeSelectionInput; output: GraphPatchResult };
    /** Copy nodes and the edges wholly inside the selection to the bus clipboard. */
    "graph.copySelection": { input: NodeSelectionInput; output: ClipboardCommandOutput };
    /** Copy, then delete — one patch, one undo group. */
    "graph.cutSelection": { input: NodeSelectionInput; output: GraphPatchResult };
    /** Recreate the clipboard contents, offset, as new nodes with new ids (§V35). */
    "graph.paste": { input: PasteInput; output: GraphPatchResult };
    /** Copy the selection in place, offset, without touching the clipboard. */
    "graph.duplicateSelection": { input: DuplicateInput; output: GraphPatchResult };
    /** TD `b` — node passes its input through untouched. */
    "node.toggleBypass": { input: NodeSelectionInput; output: GraphPatchResult };
    /** TD `d` — node shows its preview. */
    "node.toggleDisplay": { input: NodeSelectionInput; output: GraphPatchResult };
    "node.togglePin": { input: NodeSelectionInput; output: GraphPatchResult };
    /** TD `r` — node does GPU work at all. */
    "node.toggleRender": { input: NodeSelectionInput; output: GraphPatchResult };
    /** T463 — node's output renders behind the patch, dimmed (TD's network background). */
    "node.toggleBackground": { input: NodeSelectionInput; output: GraphPatchResult };
    /** T1102 — raise nodes above every other node, and keep them there across a reload. */
    "node.bringToFront": { input: NodeSelectionInput; output: GraphPatchResult };
    /** TD `n` — rename a node. `label: null` clears it back to the definition's title. */
    "node.rename": { input: RenameInput; output: GraphPatchResult };
  }
}

export interface NodeSelectionInput {
  nodeIds: readonly NodeId[];
}

export interface PasteInput {
  /** Where to put the pasted copy. Defaults to a small cascade off the original. */
  offset?: { x: number; y: number };
}

export interface DuplicateInput extends NodeSelectionInput {
  offset?: { x: number; y: number };
}

export interface ClipboardCommandOutput {
  nodeCount: number;
  edgeCount: number;
}

/** One copied node, flattened to the fields a patch can actually recreate. */
interface ClipboardNode {
  readonly sourceId: NodeId;
  readonly type: string;
  /** The NAME (§V129) — the copy keeps it when free, renames from it when taken (B44). */
  readonly label: string | undefined;
  readonly position: { x: number; y: number };
  /** Stored form: a copied node keeps its mode envelopes (T202), not just flat values. */
  readonly parameters: Record<string, StoredParameter>;
  readonly ui: GraphNode["ui"] | undefined;
  readonly resolution: GraphNode["resolution"] | undefined;
  readonly format: GraphNode["format"] | undefined;
}

interface ClipboardEdge {
  readonly source: { nodeId: NodeId; portId: string };
  readonly target: { nodeId: NodeId; portId: string };
}

interface Clipboard {
  readonly nodes: readonly ClipboardNode[];
  readonly edges: readonly ClipboardEdge[];
}

/** Successive pastes of one clipboard cascade instead of stacking on each other. */
const CASCADE = { x: 32, y: 32 } as const;

const rejection = (
  _input: unknown,
  diagnostics: RuntimeDiagnostic[],
  revision: Revision,
): GraphPatchResult => ({
  status: "rejected",
  revision,
  appliedOperations: 0,
  diagnostics,
  createdIds: {},
});

function rejected(revision: Revision, message: string, code: string): CommandOutcome<GraphPatchResult> {
  const diagnostics: RuntimeDiagnostic[] = [{ severity: "info", code, message }];
  return { status: "rejected", revision, diagnostics, output: rejection(null, diagnostics, revision) };
}

/**
 * Sorted and de-duplicated. Two actors replaying the same command must build the same
 * operation list, or the resulting documents differ (§V40).
 */
function targets(input: NodeSelectionInput): NodeId[] {
  return [...new Set(input.nodeIds ?? [])].sort();
}

function existing(graph: GraphDocument, nodeIds: readonly NodeId[]): GraphNode[] {
  const found: GraphNode[] = [];
  for (const nodeId of nodeIds) {
    const node = graph.nodes[nodeId];
    if (node !== undefined) found.push(node);
  }
  return found;
}

/** Edges with BOTH ends inside the set — a dangling half-edge is not copyable. */
function internalEdges(graph: GraphDocument, nodeIds: readonly NodeId[]): ClipboardEdge[] {
  const inside = new Set(nodeIds);
  const edges: ClipboardEdge[] = [];
  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId];
    if (edge === undefined) continue;
    if (!inside.has(edge.source.nodeId) || !inside.has(edge.target.nodeId)) continue;
    edges.push({ source: { ...edge.source }, target: { ...edge.target } });
  }
  return edges;
}

function snapshot(graph: GraphDocument, nodeIds: readonly NodeId[]): Clipboard {
  const nodes = existing(graph, nodeIds).map<ClipboardNode>((node) => ({
    sourceId: node.id,
    type: node.type,
    label: node.label,
    position: { ...node.position },
    parameters: { ...node.parameters },
    ui: node.ui === undefined ? undefined : { ...node.ui },
    resolution: node.resolution,
    format: node.format,
  }));
  return { nodes, edges: internalEdges(graph, nodes.map((node) => node.sourceId)) };
}

/**
 * The copies' names and reference rewrites, decided BEFORE the patch is built (B44/T371).
 *
 * The clipboard's parameters are copied verbatim, so a pasted node's op()/driven/source
 * reference still names the SOURCE node — the copy would silently drive the original, or
 * dangle if the original is gone. Every copied label is kept when free and renamed from
 * its base when taken, and references BETWEEN clipboard members follow the rename via the
 * clause-complete rewrite (§V128); a reference to a node outside the clipboard stays,
 * deliberately — half a chain pasted next to its driver should still be driven by it.
 */
function mintCopies(
  clipboard: Clipboard,
  graph: GraphDocument,
): Map<NodeId, { label: string | undefined; parameters: Record<string, StoredParameter> }> {
  const taken = new Set(nodeNames(graph).keys());
  const clipboardLabels = new Set<string>();
  for (const node of clipboard.nodes) {
    if (node.label !== undefined) clipboardLabels.add(node.label);
  }

  const finals = new Map<NodeId, string | undefined>();
  const renames: Array<{ oldName: string; newName: string }> = [];
  for (const node of clipboard.nodes) {
    if (node.label === undefined) {
      finals.set(node.sourceId, undefined);
      continue;
    }
    if (!taken.has(node.label)) {
      finals.set(node.sourceId, node.label);
      taken.add(node.label);
      continue;
    }
    const candidate = renumberedName(node.label, (name) => taken.has(name) || clipboardLabels.has(name));
    finals.set(node.sourceId, candidate);
    taken.add(candidate);
    renames.push({ oldName: node.label, newName: candidate });
  }

  // Fresh parameter records per call: the clipboard outlives this paste, and the rewrite
  // below must not edit what the NEXT paste will copy from.
  const standIns: Record<string, GraphNode> = {};
  for (const node of clipboard.nodes) {
    standIns[node.sourceId] = {
      id: node.sourceId,
      type: node.type,
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: { ...node.parameters },
    };
  }
  const scope: GraphDocument = { revision: 0 as GraphDocument["revision"], nodes: standIns, edges: {}, groups: {} };
  for (const rename of renames) rewriteNodeNameReferences(scope, rename.oldName, rename.newName);

  const copies = new Map<NodeId, { label: string | undefined; parameters: Record<string, StoredParameter> }>();
  for (const node of clipboard.nodes) {
    copies.set(node.sourceId, {
      label: finals.get(node.sourceId),
      parameters: standIns[node.sourceId]?.parameters ?? { ...node.parameters },
    });
  }
  return copies;
}

/**
 * Turns a clipboard into one patch: add every node under a temp id, restore the
 * instance state `addNode` cannot carry, then reconnect the copied edges by temp id
 * (§V35). One patch, so it is one undo group (§V34). The label rides the `addNode` op
 * explicitly (§V324): minted here against `graph`, so replaying the patch recreates the
 * same names instead of reclaiming whatever is free at apply time.
 */
function recreateOperations(
  clipboard: Clipboard,
  offset: { x: number; y: number },
  graph: GraphDocument,
): GraphPatchOperation[] {
  const ref = (sourceId: NodeId): `$${string}` => `$copy:${sourceId}`;
  const operations: GraphPatchOperation[] = [];
  const copies = mintCopies(clipboard, graph);

  for (const node of clipboard.nodes) {
    const copy = copies.get(node.sourceId);
    operations.push({
      op: "addNode",
      ref: ref(node.sourceId),
      type: node.type,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      parameters: copy?.parameters ?? { ...node.parameters },
      ...(copy?.label === undefined ? {} : { label: copy.label }),
    });
    // `addNode` carries type, position and parameters only. Everything else the user
    // set on the instance is restored explicitly, or duplicating a node would silently
    // drop its bypass flag, its resolution override and its format override.
    if (node.ui !== undefined && Object.keys(node.ui).length > 0) {
      operations.push({ op: "setNodeUi", nodeId: ref(node.sourceId), ui: { ...node.ui } });
    }
    if (node.resolution !== undefined) {
      operations.push({ op: "setNodeResolution", nodeId: ref(node.sourceId), resolution: node.resolution });
    }
    if (node.format !== undefined) {
      operations.push({ op: "setNodeFormat", nodeId: ref(node.sourceId), format: node.format });
    }
  }

  for (const edge of clipboard.edges) {
    operations.push({
      op: "connect",
      source: { nodeId: ref(edge.source.nodeId), portId: edge.source.portId },
      target: { nodeId: ref(edge.target.nodeId), portId: edge.target.portId },
    });
  }

  return operations;
}

function patchThrough(
  context: CommandContext,
  label: string,
  operations: GraphPatchOperation[],
): CommandOutcome<GraphPatchResult> {
  return applyGraphPatch({ baseRevision: context.graph.revision, label, operations }, context);
}

type UiFlag = "bypassed" | "preview" | "previewPinned" | "muted" | "background";

/**
 * Flags whose ABSENT state means ON (T353, §V297).
 *
 * `preview` is the switch and previews are default-on (§V28b), so an untouched node is
 * previewing and `undefined` has to read as `true` here. Reading absence as "off" would
 * make the first press of `P` turn the preview ON for a node that was already showing
 * one — the button lying about its own state on its very first use.
 */
const DEFAULT_ON: ReadonlySet<UiFlag> = new Set<UiFlag>(["preview"]);

function flagIsOn(node: GraphNode, flag: UiFlag): boolean {
  return DEFAULT_ON.has(flag) ? node.ui?.[flag] !== false : node.ui?.[flag] === true;
}

/**
 * Toggling a mixed selection turns the flag ON for everything unless it is already on
 * everywhere — the same rule every layer panel in every tool uses, and the only one that
 * does not leave a selection half-toggled after a single keypress.
 */
function toggleFlagOperations(nodes: readonly GraphNode[], flag: UiFlag): GraphPatchOperation[] {
  const allOn = nodes.every((node) => flagIsOn(node, flag));
  const next = !allOn;
  return nodes.map((node) => ({ op: "setNodeUi", nodeId: node.id, ui: { [flag]: next } }));
}

function registerToggle(
  bus: LoomBus,
  name:
    | "node.toggleBypass"
    | "node.toggleDisplay"
    | "node.togglePin"
    | "node.toggleRender"
    | "node.toggleBackground",
  flag: UiFlag,
  label: string,
): void {
  bus.registerCommand({
    name,
    description: `${label} on the target nodes.`,
    handler: (input, context) => {
      const nodes = existing(context.graph, targets(input));
      if (nodes.length === 0) {
        return rejected(context.store.getRevision(), "No target node for this command.", "selection.empty");
      }
      return patchThrough(context, label, toggleFlagOperations(nodes, flag));
    },
    rejectionOutput: rejection,
  });
}

/**
 * Registers the editing commands on `bus`. The clipboard is per-bus and lives here: it
 * is scratch state, never document state, so it is neither serialized nor undoable.
 */
export function registerEditorCommands(bus: LoomBus): void {
  let clipboard: Clipboard = { nodes: [], edges: [] };
  let pasteCount = 0;

  bus.registerCommand({
    name: "graph.removeNodes",
    description: "Delete nodes and their incident edges (§V40).",
    handler: (input, context) => {
      const nodeIds = targets(input);
      if (nodeIds.length === 0) {
        return rejected(context.store.getRevision(), "Nothing selected to delete.", "selection.empty");
      }
      return patchThrough(context, "Delete nodes", [{ op: "removeNodes", nodeIds }]);
    },
    rejectionOutput: rejection,
  });

  bus.registerCommand({
    name: "graph.copySelection",
    description: "Copy the selected nodes and the edges between them.",
    handler: (input, context) => {
      const copied = snapshot(context.graph, targets(input));
      const output: ClipboardCommandOutput = {
        nodeCount: copied.nodes.length,
        edgeCount: copied.edges.length,
      };
      if (copied.nodes.length === 0) {
        return {
          status: "rejected",
          revision: context.store.getRevision(),
          diagnostics: [
            { severity: "info", code: "selection.empty", message: "Nothing selected to copy." },
          ],
          output,
        };
      }
      // A dry run must not disturb the clipboard any more than it disturbs the document.
      if (!context.dryRun) {
        clipboard = copied;
        pasteCount = 0;
      }
      return { status: "applied", revision: context.store.getRevision(), output };
    },
    rejectionOutput: (): ClipboardCommandOutput => ({ nodeCount: 0, edgeCount: 0 }),
  });

  bus.registerCommand({
    name: "graph.cutSelection",
    description: "Copy the selection to the clipboard, then delete it.",
    handler: (input, context) => {
      const nodeIds = targets(input);
      const copied = snapshot(context.graph, nodeIds);
      if (copied.nodes.length === 0) {
        return rejected(context.store.getRevision(), "Nothing selected to cut.", "selection.empty");
      }
      const outcome = patchThrough(context, "Cut nodes", [
        { op: "removeNodes", nodeIds: copied.nodes.map((node) => node.sourceId) },
      ]);
      // The clipboard is only filled once the delete actually applied: a rejected cut
      // that still overwrote the clipboard would destroy the user's previous copy.
      if (outcome.status === "applied" && !context.dryRun) {
        clipboard = copied;
        pasteCount = 0;
      }
      return outcome;
    },
    rejectionOutput: rejection,
  });

  bus.registerCommand({
    name: "graph.paste",
    description: "Paste the clipboard as new nodes with new ids (§V35).",
    handler: (input, context) => {
      if (clipboard.nodes.length === 0) {
        return rejected(context.store.getRevision(), "The clipboard is empty.", "clipboard.empty");
      }
      const step = pasteCount + 1;
      const offset = input.offset ?? { x: CASCADE.x * step, y: CASCADE.y * step };
      const outcome = patchThrough(context, "Paste", recreateOperations(clipboard, offset, context.graph));
      if (outcome.status === "applied" && !context.dryRun && input.offset === undefined) {
        pasteCount = step;
      }
      return outcome;
    },
    rejectionOutput: rejection,
  });

  bus.registerCommand({
    name: "graph.duplicateSelection",
    description: "Copy the selected nodes in place, offset, keeping the edges between them.",
    handler: (input, context) => {
      const copied = snapshot(context.graph, targets(input));
      if (copied.nodes.length === 0) {
        return rejected(context.store.getRevision(), "Nothing selected to duplicate.", "selection.empty");
      }
      const offset = input.offset ?? { x: CASCADE.x, y: CASCADE.y };
      return patchThrough(context, "Duplicate", recreateOperations(copied, offset, context.graph));
    },
    rejectionOutput: rejection,
  });

  bus.registerCommand({
    name: "node.rename",
    description: "Rename a node, or clear the name back to its definition title (§V29).",
    handler: (input, context) =>
      patchThrough(context, input.label === null ? "Clear name" : "Rename", [
        { op: "setNodeLabel", nodeId: input.nodeId, label: input.label },
      ]),
    rejectionOutput: rejection,
  });

  registerToggle(bus, "node.toggleBypass", "bypassed", "Toggle bypass");
  // TD's display flag is "show this operator's output"; ours is the node's preview tile,
  // and it is a SWITCH: off means no tile and no GPU work (T353, §V297).
  registerToggle(bus, "node.toggleDisplay", "preview", "Toggle preview");
  // Pinning is the rarer need — keep previewing while scrolled off screen — so it has no
  // button on the node and lives in the context menu (§V78, §V90).
  registerToggle(bus, "node.togglePin", "previewPinned", "Toggle preview pin");
  // TD's render flag is "does this operator cook at all"; ours is mute — the pass does
  // no GPU work and its edges stop flowing.
  registerToggle(bus, "node.toggleRender", "muted", "Toggle render");
  // T463: TD's network background, as a flag — the graph pane renders every marked
  // node's output behind the patch, dimmed, through the preview-sink machinery.
  registerToggle(bus, "node.toggleBackground", "background", "Toggle graph background");

  /*
   * T1102 — BRING TO FRONT, and why it is a document edit rather than view state.
   *
   * The owner's ask was to "place nodes above others", and a stacking order that resets on
   * reload is not a placement — so `ui.z` is document state and this is the command that
   * writes it, on the one mutation path there is (§V29). Selecting a node still raises it
   * for free (React Flow elevates the selected node), which covers the node you are
   * dragging; this covers the arrangement you meant to keep.
   *
   * There is deliberately no SEND TO BACK. Going below the current floor means either
   * negative z-indexes — which fall behind React Flow's own edge layer, so a node sent
   * back would lose its wires rather than its foreground — or renumbering every node in
   * the document to make room, which is a whole-graph patch to move one node. Bringing the
   * OTHER node forward is the same arrangement, reachable, and costs one node's worth of
   * undo. If that turns out to be the wrong call it is a second command, not a rewrite.
   */
  bus.registerCommand({
    name: "node.bringToFront",
    description: "Raise the target nodes above every other node in the graph.",
    handler: (input, context) => {
      const nodes = existing(context.graph, targets(input));
      if (nodes.length === 0) {
        return rejected(context.store.getRevision(), "No target node for this command.", "selection.empty");
      }
      const raised = new Set(nodes.map((node) => node.id));
      let ceiling = 0;
      for (const node of Object.values(context.graph.nodes)) {
        if (raised.has(node.id)) continue;
        ceiling = Math.max(ceiling, node.ui?.z ?? 0);
      }
      /*
       * The targets keep their order RELATIVE to each other, which is why this assigns a
       * run of consecutive values rather than one shared number. Raising a selection of
       * three onto a single z would silently flatten an arrangement the user built, and
       * they would have to rebuild it to find out.
       *
       * Already-on-top is not special-cased: re-issuing the command renumbers them to the
       * same relative order one step higher, which is a no-op on screen and one undo step.
       */
      const ordered = [...nodes].sort((a, b) => (a.ui?.z ?? 0) - (b.ui?.z ?? 0));
      return patchThrough(
        context,
        "Bring to front",
        ordered.map((node, index) => ({
          op: "setNodeUi" as const,
          nodeId: node.id,
          ui: { z: ceiling + 1 + index },
        })),
      );
    },
  });
}
