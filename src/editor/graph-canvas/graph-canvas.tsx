// Library chrome first, then our overrides, then (transitively, below) the component
// modules — so a token override never loses a specificity tie to React Flow's default.
import "@xyflow/react/dist/style.css";
import "./xyflow-theme.css";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, TouchEvent as ReactTouchEvent } from "react";
import {
  ConnectionLineType,
  Position,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useKeyPress,
} from "@xyflow/react";
import type {
  Connection,
  EdgeChange,
  EdgeTypes,
  FinalConnectionState,
  IsValidConnection,
  NodeChange,
  NodeTypes,
  OnConnectStartParams,
  ReactFlowInstance,
} from "@xyflow/react";
import { arePortsCompatible } from "@domain/graph/port-compat.ts";
import { parseHandleId } from "@domain/graph/edge-order.ts";
import type { CommandResult, InvocationContext } from "@domain/types/commands.ts";
import type { ComponentRegistryView } from "@domain/components/index.ts";
import type { GraphDocument, GraphEdge } from "@domain/types/graph.ts";
import type { EdgeId, NodeId } from "@domain/types/ids.ts";
import type { GraphPatch, GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { NodeView } from "@editor/nodes/node-view.tsx";
import { AnnotationNode } from "@editor/nodes/annotation-node.tsx";
import { registerRenameSessionCommand, renameCanvasHolderFor } from "@editor/nodes/rename-session.ts";
import { createKindLabelRegistry } from "@editor/nodes/kind-label.ts";
import { SignalEdge } from "@editor/edges/signal-edge.tsx";
import {
  EDGE_HIT_TOLERANCE_PX,
  SPLICE_BAND_FRACTION,
  createEdgeGeometry,
} from "@editor/edges/edge-geometry.ts";
import { connectDropOperations } from "@editor/edges/connect-drop.ts";
import { replaceEdgeOperations, spliceNodeOperations } from "@editor/edges/edge-drop.ts";
import { edgeFamilyColor } from "@editor/edges/flow.ts";
import { WireInFlight } from "@editor/edges/wire-in-flight.tsx";
import { WIRE_GRAB_RADIUS, wireAnswer } from "@editor/edges/wire-range.ts";
import { playWireLanding } from "@editor/edges/wire-snap.ts";
import type { WireEnd } from "@editor/edges/wire-snap.ts";
import { ReferenceLines } from "@editor/edges/reference-lines.tsx";
import { registerReferenceLinesCommand } from "@editor/edges/reference-lines-command.ts";
import { registerWireStyleCommand } from "@editor/edges/wire-style-command.ts";
import { createTieView } from "@editor/edges/tie-view.ts";
import { WireTies } from "@editor/edges/wire-ties.tsx";
import { REROUTE_EDGE_COMMAND } from "@domain/commands/wire-tie-commands.ts";
import { registerEdgeFlowCommand } from "@editor/edges/edge-flow-command.ts";
import { registerTimingOverlayCommand } from "@editor/nodes/timing-overlay-command.ts";
import { createNodeTimingScaleStore } from "@editor/nodes/node-timing.ts";
import { NodeSearch } from "@editor/library/node-search.tsx";
import {
  OPEN_NODE_SEARCH_COMMAND,
  registerNodeSearchCommand,
} from "@editor/library/node-search-command.ts";
import { resolveMenuTarget } from "@editor/menus/target.ts";
import { parameterDependencies } from "@domain/graph/parameter-dependencies.ts";
import { GraphGrid } from "./graph-grid.tsx";
import { KindLabelDriver } from "./kind-label-driver.tsx";
import { WireRangeDriver } from "./wire-range-driver.tsx";
import { GraphMinimap } from "./graph-minimap.tsx";
import { registerMinimapCommand } from "./minimap-command.ts";
import { registerScrollPanCommand } from "./scroll-pan-command.ts";
import { RightDragSelect } from "./right-drag-select.tsx";
import { GraphCanvasContext } from "./canvas-context.ts";
import type {
  GraphCanvasContextValue,
  GraphDispatch,
  NodeToggleCommand,
  PreviewLensSource,
} from "./canvas-context.ts";
import {
  registerSelectNodesCommand,
  selectCreatedNodes,
} from "@editor/selection/select-created.ts";
import type { SelectNodesHandlers } from "@editor/selection/select-created.ts";
import {
  ANNOTATION_NODE_TYPE,
  LOOM_NODE_TYPE,
  SIGNAL_EDGE_TYPE,
  projectEdges,
  projectNodes,
  withSelection,
} from "./derive.ts";
import type { LoomEdge, LoomNode } from "./derive.ts";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import type { NodeRuntimeSource } from "./node-runtime.ts";
import { joinPanelOperations, panelUnderDrop } from "@editor/controls/panel-join.ts";
import { presetCatalogueHolderFor } from "@domain/presets/bank-view.ts";
import { addBankTargetsOperations, bankUnderDrop, topmostDropTarget } from "@editor/controls/bank-join.ts";
import { orderSelection, promoteInSelection } from "@editor/selection/selection-order.ts";
import { VIEW_CLIP_ATTRIBUTE } from "@ui/hooks/use-visible-subscribe.ts";
import styles from "./graph-canvas.module.css";

/**
 * The graph canvas (T18/T19 host).
 *
 * React Flow is presentation and gesture only (§C). The arrays it renders are projected
 * from the domain document on every revision, and every semantic edit a gesture produces
 * — connect, disconnect, move, delete, toggle — leaves here as one atomic patch on the
 * command bus (§V1, §V29, §V32). Nothing in this file writes to the store, and nothing
 * reads a value out of React Flow's arrays and treats it as authoritative; the one
 * exception is spelled out where it happens: a node's position while it is being
 * dragged, which is view state until the drag ends and commits as a single undo entry
 * (§V15).
 */

const NODE_TYPES: NodeTypes = {
  [LOOM_NODE_TYPE]: NodeView as NodeTypes[string],
  // T1262: the annotation box — projected to its own type by `derive.ts`, stacked under
  // every graph node there (`ANNOTATION_Z`).
  [ANNOTATION_NODE_TYPE]: AnnotationNode as NodeTypes[string],
};
const EDGE_TYPES: EdgeTypes = { [SIGNAL_EDGE_TYPE]: SignalEdge as EdgeTypes[string] };
const DEFAULT_EDGE_OPTIONS = { type: SIGNAL_EDGE_TYPE } as const;
/**
 * §I.ui, TouchDesigner's network editor (`docs.derivative.ca/Network_Editor`, owner
 * 2026-11-03: middle-drag was the hardest thing in the editor to use, and unusable on a
 * trackpad): LEFT-drag on empty canvas pans, Shift+left-drag box-selects, the wheel and a
 * trackpad pinch zoom about the pointer, right-click opens the canvas menu. Middle-drag
 * still pans, and alt-drag pans over nodes (B195 below). A trackpad pans by pressing and
 * dragging, as in TouchDesigner, which has no two-finger pan either.
 *
 * ONE array for the life of the module (T1653b). React Flow's zoom pane keys an effect on
 * this prop's IDENTITY, and that effect re-binds its non-passive `wheel` listener on the
 * canvas root. A new array per render (it was `[...PAN_MOUSE_BUTTONS]` in the JSX) re-bound
 * it on every render of this component — every value written, every selection — and for a
 * blocking wheel listener that changed Chromium re-derives the hit-test data of everything
 * under it: its paint invalidator visited every object of every node and every layer was
 * repainted, 0.1 ms a node, with no DOM change at all (measured: 900 objects visited for
 * one write on a 54-node document, 15 in a frame without one).
 */
const PAN_MOUSE_BUTTONS: number[] = [0, 1];
/** TouchDesigner's second box-select gesture (its first, right-drag, is the canvas menu here). */
const SELECTION_KEY = "Shift";
/** Shift-click adds to a selection in TouchDesigner, and so does Ctrl-click; Cmd-click on a Mac. One array for the module's life, as above. */
const MULTI_SELECTION_KEYS: string[] = ["Shift", "Meta", "Control"];
/**
 * Alt-drag is `panActivationKeyCode`: the pan that works OVER a node, where a left drag moves
 * the node instead. React Flow gives every node wrapper its `nopan` class and its node-drag filter ignores
 * modifier keys, so alt+press on a node — any part of it — starts a node drag instead of a
 * pan. At zoom 8 one preview tile is wider than the canvas: nothing but a node is under the
 * pointer, and the canvas cannot be panned at all (B195). While the key is held the canvas
 * carries `data-pan-key`, and `xyflow-theme.css` makes nodes transparent to the pointer so
 * the press lands on the pane and pans. Orbitable tiles (`data-inspect`, T675) stay opaque:
 * there alt+drag is the camera, by design.
 */
const PAN_KEY = "Alt";
/** Module scope so "nothing is selected" is one array rather than one per canvas mount. */
const EMPTY_SELECTION: readonly NodeId[] = [];

export interface GraphCanvasProps {
  bus: LoomBus;
  /** Actor identity for every mutation this canvas makes (§V30). */
  invocation: InvocationContext;
  /**
   * Status / GPU-ms / agent-activity channel (§V16, §V42). Defaults to a private empty
   * store, in which case every node reads idle and every edge is a static hairline —
   * the honest rendering of "nothing has been measured".
   */
  runtime?: NodeRuntimeSource;
  renderPreview?: (nodeId: NodeId) => ReactNode;
  renderControls?: (nodeId: NodeId) => ReactNode;
  /** T1512b: header chrome of a node's own (the Panel's phone icon), after P/B/M. */
  renderHeaderControls?: (nodeId: NodeId) => ReactNode;
  /* T892: no `previewInspect` — the camera toggle is not node chrome at all any more.
     The graph pane draws it over the tiles; see `preview-inspect-overlay.tsx`. */
  /** T685: the preview lens marker's source — §V70a's warning, out from under the tile. */
  previewLens?: (nodeId: NodeId) => PreviewLensSource | null;
  /** Patch outcomes, so a rejected gesture can surface instead of failing silently. */
  onPatchResult?: (result: CommandResult<"graph.applyPatch">) => void;
  /**
   * T1248 — called once per batch of node changes that can move a preview tile: a
   * position, a resize, a node appearing or leaving, or a selection (which React Flow
   * elevates, so it reorders the stack). The host uses it to skip a `querySelectorAll`
   * per rAF; nothing here depends on it, and a host that does not pass it loses only
   * that saving.
   */
  onNodeLayoutChange?: () => void;
  /**
   * Selection and hover are view state — the document does not model them — but the
   * keymap resolves `inputFrom: "selection" | "hoveredNode"` against them (T77). This
   * is where they leave the canvas.
   */
  onSelectionChange?: (nodeIds: readonly NodeId[]) => void;
  onHoveredNodeChange?: (nodeId: NodeId | null) => void;
  /**
   * T463: a surface rendered in React Flow's own negative-z slot — the same stacking
   * layer as the dot Background, LATER in the DOM, so it paints above the dots and
   * beneath every node and edge. The graph pane puts its background canvas here.
   */
  underlay?: ReactNode;
  /** T603: the component catalogue — instance nodes read version/upgrade marks off it. */
  components?: ComponentRegistryView;
  /**
   * T1652b: the document as of its last STRUCTURAL revision — the same nodes, wires, modes
   * and names as the store's, with values that may be older — as an external store. What
   * the reference lines are derived from: a line is who reads whom, and a moved value
   * changes no reference. The host builds it (`revision-watch.ts`, which lives above this
   * layer); a host that passes none gets the store's document and every revision, which is
   * what this did before.
   */
  structure?: { subscribe(listener: () => void): () => void; get(): GraphDocument };
}

export function GraphCanvas({
  bus,
  components,
  invocation,
  runtime,
  renderPreview,
  renderControls,
  renderHeaderControls,
  previewLens,
  onPatchResult,
  onSelectionChange,
  underlay,
  onHoveredNodeChange,
  onNodeLayoutChange,
  structure,
}: GraphCanvasProps) {
  const registry = bus.registry;
  /*
   * T1668b — THE CANVAS DRAWS THE DOCUMENT'S STRUCTURE. Everything it projects is a node's
   * FIELD or a wire (type, position, size, stacking, bypass; `derive.ts`), and a value
   * written changes none of those: each node's body reads its own values. So the document
   * it renders from is the one `structure` hands it (the app: `revision-watch.ts`, which
   * does not move for a values-only revision), and the canvas does not render for a moved
   * slider at all. It did, twice a write, to re-project 200 nodes into the arrays it
   * already had. Without `structure` (a test, an embed) it follows the store.
   */
  const structureGraph = useSyncExternalStore(structure?.subscribe ?? bus.store.subscribe, structure?.get ?? bus.store.getGraph);
  const domainNodes = structureGraph.nodes;
  const domainEdges = structureGraph.edges;

  // One per mounted canvas: every edge writes where it is, the drop handlers read it.
  const edgeGeometry = useMemo(() => createEdgeGeometry(), []);
  /*
   * T1821b — where each wire tie is drawn: the document's positions, and the tie in the hand
   * (`tie-view.ts`). Fed the document's ties before paint, so a wire and its tie's dot move
   * in the same frame.
   */
  const ties = useMemo(() => createTieView(), []);
  const domainTies = structureGraph.ties;
  useLayoutEffect(() => {
    ties.setDocument(domainTies);
  }, [ties, domainTies]);

  const fallbackRuntime = useMemo(() => createNodeRuntimeStore(), []);
  useEffect(() => () => fallbackRuntime.dispose(), [fallbackRuntime]);
  const runtimeSource = runtime ?? fallbackRuntime;

  /**
   * T1010 — the timing overlay's toggle and its denominator.
   *
   * The toggle is per BUS, like the reference lines: two canvases on one document must
   * agree about what they are drawing (§V97). The scale store is per CANVAS, because it is
   * a sum over the overlays that are actually mounted, and a second canvas showing a
   * different part of the graph has a different set of them.
   */
  const timingOverlay = useMemo(() => registerTimingOverlayCommand(bus.root), [bus]);
  /** T1013 — the flow dashes' switch, the timing overlay's twin in the Debug submenu. */
  const edgeFlow = useMemo(() => registerEdgeFlowCommand(bus.root), [bus]);
  const timingScale = useMemo(() => createNodeTimingScaleStore(), []);
  useEffect(() => () => timingScale.dispose(), [timingScale]);

  /**
   * §V151/§V153 — the reference lines are DERIVED here and drawn as a picture.
   *
   * Derived from the document on every revision, exactly like the node and edge
   * projections above, and deliberately NOT projected into `viewEdges`: an entry there is
   * selectable, deletable and a drop target, and `onEdgesChange` would hand a removed
   * reference line to `graph.disconnect` — which has nothing to disconnect, because the
   * dependency lives in a parameter. Keeping them out of the array is the invariant made
   * structural instead of promised.
   *
   * Computed only while they are SHOWN: a hidden line costs one boolean, not a walk of
   * every expression in the document on every revision.
   *
   * T1652b: and derived per STRUCTURAL revision, not per revision. On a document of 150
   * nodes and 1200 `op()` reads this walk was 10 000 expression nodes, and every moved
   * slider ran it and re-rendered all 300 lines — for a picture a value cannot change.
   */
  const referenceLines = useMemo(() => registerReferenceLinesCommand(bus.root), [bus]);
  const showReferenceLines = useSyncExternalStore(referenceLines.subscribe, referenceLines.get);
  /*
   * §T1696b: the commands this canvas answers that are the APP's (the map, select these
   * nodes, the node browser, rename) are registered on the app's bus, once. A component
   * session inherits them, so a key, a menu row and this canvas's own gestures reach one
   * registration and one holder whichever bus they dispatch on. T1195 and T1257 registered
   * each on the canvas's bus and on a list of "door" buses.
   */
  const appBus = bus.root;
  const minimap = useMemo(() => registerMinimapCommand(appBus), [appBus]);
  const showMinimap = useSyncExternalStore(minimap.subscribe, minimap.get);
  // T1724b: a two-finger scroll pans (pinch zooms), or the wheel zooms as in TouchDesigner.
  const scrollPan = useMemo(() => registerScrollPanCommand(appBus), [appBus]);
  const scrollPans = useSyncExternalStore(scrollPan.subscribe, scrollPan.get);
  // T1820b: curved, gentle or straight wires. Registered here for its command; every edge
  // reads the one per-person store itself (`signal-edge.tsx`).
  useMemo(() => registerWireStyleCommand(appBus), [appBus]);
  // The map's DOM lands here (see `graph-minimap.tsx`); state, not a ref, so the portal
  // renders once the host exists.
  const [minimapHost, setMinimapHost] = useState<HTMLDivElement | null>(null);
  const referenceGraph = structureGraph;
  const dependencies = useMemo(
    () => (showReferenceLines ? [...parameterDependencies(referenceGraph).values()].flat() : []),
    [showReferenceLines, referenceGraph],
  );

  const [viewNodes, setViewNodes] = useState<LoomNode[]>(() => projectNodes(domainNodes));
  const [viewEdges, setViewEdges] = useState<LoomEdge[]>(() =>
    projectEdges(domainEdges, domainNodes, registry),
  );

  // The projection runs on every document revision. React Flow's arrays are a view of
  // the graph, so this is the only writer of node identity, type and position (§V1).
  useEffect(() => {
    setViewNodes((previous) => projectNodes(domainNodes, previous));
  }, [domainNodes]);

  useEffect(() => {
    setViewEdges((previous) => projectEdges(domainEdges, domainNodes, registry, previous));
  }, [domainEdges, domainNodes, registry]);

  /** T1821b: a tie's dot takes the hue of the first wire through it (§V26), sorted by wire id. */
  const tieColors = useMemo(() => {
    const colors = new Map<string, string>();
    for (const edge of viewEdges) {
      for (const tieId of edge.data?.via ?? []) {
        if (!colors.has(tieId)) colors.set(tieId, edgeFamilyColor(edge.data?.portKind));
      }
    }
    return colors;
  }, [viewEdges]);

  /**
   * `graph.selectNodes`' performer, and the ONE place that knows what selecting means
   * here (§V78, §V101). See `@editor/selection/select-created.ts` for why it is a command.
   *
   * IT PROJECTS FROM THE LIVE DOCUMENT RATHER THAN MAPPING OVER THE CURRENT ARRAY, and
   * that is the whole difficulty of "select the node that was just added". The request
   * arrives immediately after the patch that created the node applied — a microtask after
   * `bus.execute` resolves — and at that moment React Flow's array is still the pre-patch
   * one: the effect above, which is what puts the new node into it, has not run yet,
   * because the store update only SCHEDULES a render. A `setNodes` map over what is
   * currently held would therefore quietly drop exactly the node the user just added,
   * which is the entire feature, and it would do so on a timing race — green in a test
   * that awaits the effect, dead in the app.
   *
   * Re-running `projectNodes` against `bus.store.getGraph()` removes the race instead of
   * betting on it: the store is authoritative and already holds the new node, whichever
   * side of the commit this lands on. The effect above then re-projects with the same
   * document and hands back the node objects it finds in `previous` untouched, so the
   * `selected` flag set here survives (that reuse is what `projectNodes` already does for
   * every other React-Flow-owned field).
   */
  const selectNodes = useCallback(
    (nodeIds: readonly NodeId[]) => {
      const wanted = new Set<string>(nodeIds);
      setViewNodes((previous) =>
        withSelection(projectNodes(bus.store.getGraph().nodes, previous), wanted),
      );
    },
    [bus],
  );

  /**
   * One patch on the bus, and whether it was applied. `dispatch` below is this with the
   * answer dropped, which is all most gestures need; a wire landing wants the answer,
   * because the snap is played for a connection that was MADE and not for one that was
   * asked for (T1639b: a refused patch plays nothing).
   */
  const apply = useCallback(
    async (operations: GraphPatchOperation[], label: string): Promise<boolean> => {
      if (operations.length === 0) return false;
      const patch: GraphPatch = {
        baseRevision: bus.store.getRevision(),
        operations,
        label,
      };
      const result = await bus.execute("graph.applyPatch", patch, invocation);
      onPatchResult?.(result);
      return result.status === "applied";
    },
    [bus, invocation, onPatchResult],
  );

  const dispatch = useCallback<GraphDispatch>(
    (operations: GraphPatchOperation[], label: string) => {
      void apply(operations, label);
    },
    [apply],
  );

  /**
   * The live React Flow instance, kept in a ref rather than in state.
   *
   * `screenToFlowPosition` is the only way to turn a drop point into graph coordinates,
   * and it needs the current viewport transform. Subscribing to that transform would
   * re-render this component on every frame of a pan — which is precisely the shape of
   * B13 (§V142: a camera move must cost nothing). A ref updated once, on init, gives the
   * drop handlers the live projection and re-renders nothing, ever.
   */
  const flowRef = useRef<ReactFlowInstance<LoomNode, LoomEdge> | null>(null);
  const onInit = useCallback((instance: ReactFlowInstance<LoomNode, LoomEdge>) => {
    flowRef.current = instance;
  }, []);

  /**
   * The canvas fills `graph.selectNodes`' holder while it is mounted — the same shape as
   * `graph.selectAll` and `view.frameAll`, and for the same reason: selection is not
   * document state, so the surface that can perform it is the one that registers it.
   */
  useEffect(() => {
    const handlers: SelectNodesHandlers = {
      select: selectNodes,
      // What React Flow is holding IS what the user is looking at — the component's
      // internals inside a dive, the document at the root (T969(b)).
      nodeIds: () => (flowRef.current?.getNodes() ?? []).map((node) => node.id as NodeId),
    };
    // `commandHolder` is one object per bus, so this is one holder at the root and two
    // inside a component; registration itself is idempotent on each.
    const holder = registerSelectNodesCommand(appBus);
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [appBus, selectNodes]);

  /** The canvas element — the double-click boundary and the viewport-centre fallback. */
  const canvasRef = useRef<HTMLDivElement | null>(null);

  /**
   * Live drag positions. React Flow reports a position on every move and then a final
   * `dragging: false` change with no position of its own, so the last seen position is
   * kept here — outside both the document and React state — and committed once (§V15).
   */
  const dragPositions = useRef(new Map<NodeId, { x: number; y: number }>());
  /**
   * Live resize sizes, kept for the same reason and with the same shape (T208, §V15).
   *
   * React Flow reports a `dimensions` change on every pointer move of a resize and then
   * one final change carrying `resizing: false`. Only the last one is a semantic edit;
   * the rest are the gesture in flight, so they stay out of the document entirely. A
   * `dimensions` change with no `resizing` field at all is React Flow MEASURING the node
   * (its resize observer, on mount and on any content reflow) — that is not an edit by
   * anyone and must never write to the document, which is why both branches below test
   * `resizing` explicitly rather than reacting to `dimensions` being present.
   */
  const dragSizes = useRef(new Map<NodeId, { width: number; height: number }>());

  /**
   * T213 / §V14b's sibling — a NODE dropped on an edge SPLICES into it.
   *
   * The hit test is done entirely in GRAPH space: the node's centre against the wire's
   * curve. Both are graph-space facts, so unlike a cursor drop this one needs no screen
   * projection and means the same thing at every zoom (§V142). The position comes from
   * the live drag rather than from the document, which is stale for the whole gesture
   * (§V112); only the node's measured SIZE is read from React Flow, and that does not
   * move while it is being dragged.
   *
   * Edges attached to the dragged node are excluded from the search, not just refused
   * afterwards: they follow the node, so one of them is always the nearest wire, and
   * leaving them in would let a node's own edge shadow the one it was dropped on.
   */
  const spliceAt = useCallback(
    (nodeId: NodeId, position: { x: number; y: number }): GraphPatchOperation[] => {
      const view = flowRef.current?.getNode(nodeId);
      const width = view?.measured?.width ?? view?.width ?? 0;
      const height = view?.measured?.height ?? view?.height ?? 0;
      if (!(width > 0) || !(height > 0)) return [];

      const graph = bus.store.getGraph();
      const centre = { x: position.x + width / 2, y: position.y + height / 2 };
      const tolerance = Math.max(EDGE_HIT_TOLERANCE_PX, height * SPLICE_BAND_FRACTION);
      const hit = edgeGeometry.hit(centre, tolerance, (candidate) => {
        const edge = graph.edges[candidate];
        return edge === undefined || edge.source.nodeId === nodeId || edge.target.nodeId === nodeId;
      });
      if (hit === null) return [];
      const edge = graph.edges[hit.edgeId];
      if (edge === undefined) return [];
      // T1821b: the leg it landed on decides which ties stay upstream of the node.
      return spliceNodeOperations(graph, registry, edge, nodeId, hit.segment);
    },
    [bus, edgeGeometry, registry],
  );

  /**
   * T1512b — a WIDGET dropped ON a Panel joins it: its `out` wired into the Panel's
   * Controls, in the same patch as the move. Graph space both sides, like the splice above:
   * the widget's centre from the live drag, each Panel's box from React Flow's measure.
   *
   * T1531b — a node dropped ON a Presets bank becomes one of its targets the same way
   * (`bank-join.ts`). Where a Panel and a bank overlap under the drop, the one drawn on top
   * takes it (`topmostDropTarget`); the other is not consulted.
   */
  const dropJoinAt = useCallback(
    (nodeId: NodeId, position: { x: number; y: number }): { operations: GraphPatchOperation[]; label: string } => {
      const none = { operations: [], label: "" };
      const flow = flowRef.current;
      const view = flow?.getNode(nodeId);
      const width = view?.measured?.width ?? view?.width ?? 0;
      const height = view?.measured?.height ?? view?.height ?? 0;
      if (flow === null || !(width > 0) || !(height > 0)) return none;
      const graph = bus.store.getGraph();
      const centre = { x: position.x + width / 2, y: position.y + height / 2 };
      const boxOf = (id: NodeId) => {
        const panel = flow.getNode(id);
        const w = panel?.measured?.width ?? panel?.width ?? 0;
        const h = panel?.measured?.height ?? panel?.height ?? 0;
        return panel === undefined || !(w > 0) || !(h > 0) ? null : { x: panel.position.x, y: panel.position.y, width: w, height: h };
      };
      // T1541b: a look's instance joins a Panel like a bank — the catalogue says which are looks.
      const catalogue = presetCatalogueHolderFor(bus).current?.components;
      const panelId = panelUnderDrop(graph, nodeId, centre, boxOf, catalogue);
      const bankId = bankUnderDrop(graph, nodeId, centre, boxOf);
      const target = topmostDropTarget(graph, panelId, bankId);
      if (target === null) return none;
      return target === bankId
        ? { operations: addBankTargetsOperations(graph, bankId, [nodeId]), label: "Add to preset targets" }
        : { operations: joinPanelOperations(graph, nodeId, target, catalogue), label: "Add to panel" };
    },
    [bus],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<LoomNode>[]) => {
      setViewNodes((previous) => applyNodeChanges(changes, previous));

      /*
       * T1248 — the "something moved" signal, raised for the CHANGE TYPES that can move a
       * preview tile and no others. `select` is in the list because React Flow elevates the
       * selected node's z-index, which reorders the stack the compositor clips against;
       * `replace` because a node swapped in place is a new box at the same id. What is
       * deliberately NOT here is every other change React Flow reports during a drag, which
       * is the point: the host reads the DOM when this fires rather than every frame.
       */
      if (
        onNodeLayoutChange !== undefined &&
        changes.some(
          (change) =>
            change.type === "position" ||
            change.type === "dimensions" ||
            change.type === "add" ||
            change.type === "remove" ||
            change.type === "replace" ||
            change.type === "select",
        )
      ) {
        onNodeLayoutChange();
      }

      const committed: Record<NodeId, { x: number; y: number }> = {};
      const resized: Array<[NodeId, { width: number; height: number }]> = [];
      const removed: NodeId[] = [];
      for (const change of changes) {
        if (change.type === "position") {
          if (change.position !== undefined) dragPositions.current.set(change.id, change.position);
          if (change.dragging === false) {
            const position = dragPositions.current.get(change.id);
            dragPositions.current.delete(change.id);
            if (position !== undefined) committed[change.id] = { x: position.x, y: position.y };
          }
        } else if (change.type === "dimensions") {
          if (change.resizing === true && change.dimensions !== undefined) {
            dragSizes.current.set(change.id, change.dimensions);
          } else if (change.resizing === false) {
            const size = dragSizes.current.get(change.id) ?? change.dimensions;
            dragSizes.current.delete(change.id);
            if (size !== undefined) resized.push([change.id, size]);
          }
        } else if (change.type === "remove") {
          removed.push(change.id);
        }
      }

      if (resized.length > 0) {
        // ONE patch for the whole gesture (§V15, §V32). Dragging a top or left handle
        // moves the node as well as sizing it, and React Flow reports those as separate
        // changes with no `dragging: false` of their own — so the position half is
        // drained here rather than left to expire, and both halves land as one undo
        // entry. Undoing a resize that also moved must not leave the node relocated.
        const moved: Record<NodeId, { x: number; y: number }> = {};
        const operations: GraphPatchOperation[] = [];
        for (const [nodeId, size] of resized) {
          const position = dragPositions.current.get(nodeId);
          if (position !== undefined) {
            dragPositions.current.delete(nodeId);
            moved[nodeId] = { x: position.x, y: position.y };
          }
          operations.push({ op: "setNodeSize", nodeId, size });
        }
        if (Object.keys(moved).length > 0) {
          operations.unshift({ op: "moveNodes", positions: moved });
        }
        dispatch(operations, "Resize node");
      }
      const movedIds = Object.keys(committed);
      if (movedIds.length > 0) {
        const operations: GraphPatchOperation[] = [{ op: "moveNodes", positions: committed }];
        // Only a single-node drop can splice. Dropping a whole selection on a wire has no
        // one answer — which of them goes inline? — and picking one silently would be a
        // guess the user cannot see or undo separately from the move.
        const only = movedIds.length === 1 ? movedIds[0] : undefined;
        const target = only === undefined ? undefined : committed[only];
        // T1512b: a widget dropped ON a Panel joins it, and that wins over a wire under it —
        // the Panel is the thing the widget was aimed at.
        // T1531b: so does a node dropped ON a Presets bank (it becomes a target).
        const joined = only === undefined || target === undefined ? null : dropJoinAt(only, target);
        const join = joined?.operations ?? [];
        const splice = only === undefined || target === undefined || join.length > 0 ? [] : spliceAt(only, target);
        // The move and the splice are ONE gesture, so they are one patch and one undo
        // entry (§V15, §V32, §V34): undoing puts the node back AND restores the wire it
        // cut into. Two patches would make the user undo twice for one drop, and would
        // leave a graph rewired around a node that had moved back.
        operations.push(...join, ...splice);
        dispatch(operations, joined !== null && join.length > 0 ? joined.label : splice.length > 0 ? "Insert node into edge" : "Move node");
      }
      if (removed.length > 0) {
        dispatch([{ op: "removeNodes", nodeIds: removed }], "Delete node");
      }
    },
    [dispatch, spliceAt, dropJoinAt, onNodeLayoutChange],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<LoomEdge>[]) => {
      setViewEdges((previous) => applyEdgeChanges(changes, previous));
      const removed = changes.flatMap((change) => (change.type === "remove" ? [change.id] : []));
      if (removed.length > 0) {
        dispatch([{ op: "disconnect", edgeIds: removed }], "Disconnect");
      }
    },
    [dispatch],
  );

  /**
   * T1639b — which end of the wire is in the hand: React Flow's type of the handle the
   * drag started from (`source` is our output). For a wire pulled off an input it is the
   * edge's OTHER end, the output, because that is where the library's connection starts.
   * A ref: it is read once, when the wire lands.
   */
  const heldEnd = useRef<"source" | "target" | null>(null);
  const onConnectStart = useCallback((_event: unknown, params: OnConnectStartParams) => {
    heldEnd.current = params.handleType;
  }, []);

  /**
   * T1639b — the snap, for a wire that now exists between `source` and `target`.
   *
   * `on` names the end the wire's tip was let go at, which is where the rings and the
   * bar play: the input for a wire dragged from an output, the output for one dragged
   * backwards. The colour is what the wire carries, the output port's family (§V26).
   * Everything on screen about it is `wire-snap.ts`'s; this only says which wire.
   */
  const land = useCallback(
    (source: WireEnd, target: WireEnd, on: "source" | "target") => {
      const canvas = canvasRef.current;
      const flow = flowRef.current;
      if (canvas === null || flow === null) return;
      const node = bus.store.getGraph().nodes[source.nodeId];
      const port =
        node === undefined ? undefined : registry.port(node.type, parseHandleId(source.handleId).portId, "output");
      playWireLanding({
        canvas,
        toGraph: (point) => flow.screenToFlowPosition(point),
        // The same call `SignalEdge` makes, so the fill lies on the edge arriving under it.
        curve: (from, to) =>
          getBezierPath({
            sourceX: from.x,
            sourceY: from.y,
            sourcePosition: Position.Right,
            targetX: to.x,
            targetY: to.y,
            targetPosition: Position.Left,
          })[0],
        zoom: flow.getZoom(),
        color: edgeFamilyColor(port?.type.kind),
        source,
        target,
        on,
      });
    },
    [bus, registry],
  );

  /**
   * A completed connect gesture is a request, not a fact: it goes to the bus, and the
   * edge only appears once the patch comes back through the projection (§V1, §V29).
   */
  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (sourceHandle === null || targetHandle === null) return;
      // Read now: the gesture is over by the time the patch answers.
      const landedOn = heldEnd.current === "target" ? "source" : "target";
      const landing = (): void =>
        land({ nodeId: source, handleId: sourceHandle }, { nodeId: target, handleId: targetHandle }, landedOn);

      // T695: a variadic input's handles are addressed by SLOT, so the handle id is not
      // the port id. Everything below works in port-and-slot terms from here.
      const { portId: targetPortId, slot } = parseHandleId(targetHandle);
      const { portId: sourcePortId } = parseHandleId(sourceHandle);

      /*
       * T1049 — what the drop MEANS is decided in `connect-drop.ts`, not here.
       *
       * This used to be forty lines of §V14a displacement and T695 slot resolution inline.
       * The Connections panel aims wires at exactly the same sockets, and the owner ruled
       * on the shape rather than letting a second copy appear: "definitely don't
       * duplicate it". A refusal cannot reach us — `isValidConnection` already declined an
       * incompatible drop under the cursor — so the canvas dispatches or does nothing.
       */
      // The document AS IT IS when the wire lands (T1668b): a callback that closed over the
      // rendered one was another function for every revision, and the library copies this
      // prop into its store, where every node and handle is asked again.
      const drop = connectDropOperations({
        graph: bus.store.getGraph(),
        registry,
        source: { nodeId: source, portId: sourcePortId },
        target: { nodeId: target, portId: targetPortId, ...(slot === undefined ? {} : { slot }) },
      });
      // The wire that is already there, let go on its own socket: nothing to say to the
      // document, and the wire is in the port, which is what the snap means.
      if (drop.kind === "unchanged") landing();
      if (drop.kind !== "connect") return;
      void apply(drop.operations, drop.label).then((applied) => {
        if (applied) landing();
      });
    },
    [apply, land, bus, registry],
  );

  /**
   * §V14b/§V14c — the wire under a release, or `null`.
   *
   * The hit test of a connection let go over a WIRE rather than over a port, shared by a
   * new wire (`onConnectEnd`) and a pulled one (`onReconnectEnd`) so the two cannot come
   * to mean different things by a wire's hit area.
   */
  const edgeUnderRelease = useCallback(
    (event: MouseEvent | TouchEvent): GraphEdge | null => {
      const flow = flowRef.current;
      if (flow === null) return null;
      const client = "changedTouches" in event ? event.changedTouches[0] : event;
      if (client === undefined) return null;
      const point = flow.screenToFlowPosition({ x: client.clientX, y: client.clientY });
      // The tolerance is a SCREEN measurement (§V14c), so it is divided by the zoom to
      // stay the same size under the cursor however far the camera is pulled back.
      const zoom = flow.getZoom();
      if (!(zoom > 0)) return null;
      const edgeId = edgeGeometry.nearest(point, EDGE_HIT_TOLERANCE_PX / zoom);
      if (edgeId === null) return null;
      return bus.store.getGraph().edges[edgeId] ?? null;
    },
    [bus, edgeGeometry],
  );

  /** The handle an edge's input end is drawn to: a variadic socket has a slot (T695). */
  const inputEndOf = useCallback(
    (edge: GraphEdge): WireEnd => ({
      nodeId: edge.target.nodeId,
      handleId: flowRef.current?.getEdge(edge.id)?.targetHandle ?? edge.target.portId,
    }),
    [],
  );

  /**
   * T1639b — a connected wire's input end, pulled off its port (React Flow's reconnect).
   *
   * While it is in the hand the library hides the edge and draws the connection line from
   * the edge's output, so it is the same white wire, the same ring and arc, and the same
   * range as a new one. The document is not touched until the release, which is one patch
   * and one undo entry whatever it means (§V15, §V32):
   *
   *  - on a port that takes it: `onReconnect`, the move;
   *  - back on its own port: nothing, and the snap, because the wire is in the port;
   *  - on a wire: that wire's input, as a new wire does (§V14b), with its own disconnect;
   *  - on a port that refuses, with no wire under it: nothing, the wire goes back;
   *  - anywhere else: the wire comes off (`disconnect`).
   *
   * `pulled` is the edge in the hand, set for the length of the gesture. `onConnectEnd`
   * reads it and stands aside: the library calls both ends for a reconnect, and two
   * handlers each dispatching a patch for one release is two undo entries and a race.
   */
  const pulled = useRef<EdgeId | null>(null);
  const onReconnectStart = useCallback((_event: unknown, edge: LoomEdge) => {
    pulled.current = edge.id as EdgeId;
  }, []);

  const onReconnect = useCallback(
    (oldEdge: LoomEdge, connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (sourceHandle === null || targetHandle === null) return;
      const landing = (): void =>
        land({ nodeId: source, handleId: sourceHandle }, { nodeId: target, handleId: targetHandle }, "target");
      if (target === oldEdge.target && targetHandle === oldEdge.targetHandle) {
        landing();
        return;
      }
      const { portId: targetPortId, slot } = parseHandleId(targetHandle);
      const drop = connectDropOperations({
        graph: bus.store.getGraph(),
        registry,
        source: { nodeId: source, portId: parseHandleId(sourceHandle).portId },
        target: { nodeId: target, portId: targetPortId, ...(slot === undefined ? {} : { slot }) },
        moving: oldEdge.id as EdgeId,
      });
      if (drop.kind === "unchanged") landing();
      if (drop.kind !== "connect") return;
      void apply(drop.operations, drop.label).then((applied) => {
        if (applied) landing();
      });
    },
    [apply, bus, land, registry],
  );

  const onReconnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, edge: LoomEdge, _handleType: unknown, state: FinalConnectionState) => {
      pulled.current = null;
      // Let go on a port that takes it: `onReconnect` has already answered.
      if (state.isValid === true) return;
      const graph = bus.store.getGraph();
      const moving = graph.edges[edge.id];
      if (moving === undefined) return;

      const hit = edgeUnderRelease(event);
      if (hit !== null && hit.id !== moving.id) {
        const replace = replaceEdgeOperations(graph, registry, hit, {
          nodeId: moving.source.nodeId,
          portId: moving.source.portId,
          direction: "output",
        });
        if (replace.length > 0) {
          const source = { nodeId: moving.source.nodeId, handleId: moving.source.portId };
          const target = inputEndOf(hit);
          void apply([{ op: "disconnect", edgeIds: [moving.id] }, ...replace], "Move connection").then((applied) => {
            if (applied) land(source, target, "target");
          });
          return;
        }
      }
      // A port in range that refuses the wire: nothing happens, and the edge is drawn again.
      if (wireAnswer(state) === "refused") return;
      dispatch([{ op: "disconnect", edgeIds: [moving.id] }], "Disconnect");
    },
    [apply, bus, dispatch, edgeUnderRelease, inputEndOf, land, registry],
  );

  /**
   * T1639b — a press ON a connected input's dot picks up the wire that ends there.
   *
   * React Flow's own grab zone is a circle on the wire's last pixels, in the edge layer,
   * UNDER the nodes. The dot is a handle on the node, above it, so a press on the dot
   * never reached that circle: it started a second wire out of the input and left the
   * first one where it was. The reference's gesture, and the owner's, is to take hold of
   * the wire at the port.
   *
   * So the press is re-aimed, and that is all this does: it finds the one edge drawn into
   * that handle and hands the same press to that edge's reconnect anchor. From there the
   * gesture is entirely the library's (the hidden edge, the range, `onReconnect`). It runs
   * in the CAPTURE phase and stops the press, so neither the handle's own connection nor a
   * node drag starts from it.
   *
   * Left alone, and so behaving as before: an input with no wire, an input whose wire
   * cannot be told from its siblings (the Panel's one socket holds many, T1518b), every
   * output (an output fans out), and anything but the primary button.
   */
  const grabConnectedEnd = useCallback((event: ReactMouseEvent<HTMLDivElement> | ReactTouchEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    const flow = flowRef.current;
    if (canvas === null || flow === null || !(event.target instanceof Element)) return;
    const dot = event.target.closest<HTMLElement>(".react-flow__handle.target");
    if (dot === null) return;
    if ("button" in event && event.button !== 0) return;
    const point = "touches" in event ? event.touches[0] : event;
    if (point === undefined) return;

    const nodeId = dot.dataset["nodeid"];
    const handleId = dot.dataset["handleid"];
    const ending = flow
      .getEdges()
      .filter((edge) => edge.target === nodeId && edge.targetHandle === handleId && edge.reconnectable !== false);
    const only = ending.length === 1 ? ending[0] : undefined;
    if (only === undefined) return;
    let anchor: Element | null = null;
    for (const edge of canvas.querySelectorAll(".react-flow__edge")) {
      if (edge.getAttribute("data-id") === only.id) anchor = edge.querySelector(".react-flow__edgeupdater-target");
    }
    if (anchor === null) return;

    event.stopPropagation();
    anchor.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: point.clientX,
        clientY: point.clientY,
      }),
    );
  }, []);

  /**
   * §V14b/§V14c — an EDGE is a drop target for a connection.
   *
   * Released over a wire rather than over a port, the drag takes that wire's TARGET: the
   * old edge goes and the dragged port takes its place, as ONE patch and so one undo
   * group (§V32, §V34). The port dot is 7px (§V99) and the wire leading to it is right
   * there under the cursor; demanding the dot is asking for precision the task does not
   * need.
   *
   * `isValid` is React Flow telling us the drop landed on a real, compatible handle — in
   * which case `onConnect` has already fired and this is not our gesture. Everything else
   * (empty canvas, an incompatible handle, a wire) reaches the hit test, and a miss
   * dispatches nothing at all.
   */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      // T1639b: a wire pulled off its port is `onReconnectEnd`'s, which is called next.
      if (pulled.current !== null) return;
      if (state.isValid === true) return;
      const from = state.fromHandle;
      if (from === null || from === undefined) return;
      // A handle with no id belongs to a node that declares a single unnamed port; ours
      // always name their ports, so there is nothing to reconnect.
      const fromPortId = from.id;
      if (fromPortId === null || fromPortId === undefined) return;

      const edge = edgeUnderRelease(event);
      if (edge === null) return;
      const graph = bus.store.getGraph();
      // React Flow's "source" handle is our output; "target" is our input.
      const direction = from.type === "source" ? "output" : "input";
      const operations = replaceEdgeOperations(graph, registry, edge, {
        nodeId: from.nodeId,
        // T695 — the grabbed end may be one SOCKET of a variadic input; what the document
        // records is the port.
        portId: parseHandleId(fromPortId).portId,
        direction,
      });
      // T1639b: the snap plays on the input that was just fed. Read before the patch: the
      // wire that was hit is gone once it applies.
      const source =
        direction === "output"
          ? { nodeId: from.nodeId, handleId: fromPortId }
          : { nodeId: edge.source.nodeId, handleId: edge.source.portId };
      const target = direction === "output" ? inputEndOf(edge) : { nodeId: from.nodeId, handleId: fromPortId };
      void apply(operations, "Replace connection").then((applied) => {
        if (applied) land(source, target, "target");
      });
    },
    [apply, bus, edgeUnderRelease, inputEndOf, land, registry],
  );

  /**
   * §V13 — exact port-type match, checked while the connection line is still in the
   * air. The bus enforces it again on apply; doing it here too means an impossible
   * connection is refused under the cursor instead of silently rejected afterwards.
   */
  const isValidConnection = useCallback<IsValidConnection<LoomEdge>>(
    (connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (sourceHandle === null || sourceHandle === undefined) return false;
      if (targetHandle === null || targetHandle === undefined) return false;
      // Read at the moment it is asked, for `onConnect`'s reason (T1668b).
      const nodes = bus.store.getGraph().nodes;
      const sourceNode = nodes[source];
      const targetNode = nodes[target];
      if (sourceNode === undefined || targetNode === undefined) return false;

      // T695 — the handle id carries a slot on a variadic input; the PORT is what decides
      // compatibility, and asking the registry for `in2#1` would answer `undefined` and
      // refuse a legal drop under the cursor.
      const sourcePort = registry.port(sourceNode.type, parseHandleId(sourceHandle).portId, "output");
      const targetPort = registry.port(targetNode.type, parseHandleId(targetHandle).portId, "input");
      if (sourcePort === undefined || targetPort === undefined) return false;
      if (!arePortsCompatible(sourcePort.type, targetPort.type)) return false;

      // §V14a — an occupied non-variadic input is not a refusal: dropping here REPLACES
      // the existing edge (`onConnect` above), so the drop must be allowed to land.
      return true;
    },
    [bus, registry],
  );

  /**
   * Selection and hover leave the canvas as plain node ids. They are not document state
   * — the graph document models neither — but the keymap resolves selection-driven
   * command input against them (T77), so this is the seam.
   *
   * ⚑ T1177 — A REF, NOT STATE, AND NOTHING ON THIS PAGE RE-RENDERS WHEN IT MOVES.
   *
   * This was `useState`, and its ONLY reader was the canvas context below — so a click on
   * a node re-rendered `GraphCanvas`, minted a new context value, and repainted every
   * `NodeView` and every `SignalEdge` on the canvas, however many there were. §V16 is
   * explicit that view state which nothing renders from does not belong in a render path,
   * and this is that case exactly: React Flow already gives each node its own `selected`
   * prop (`withSelection`/`projectNodes` above), so the two nodes whose highlight actually
   * changed repaint on their own and needed none of this.
   *
   * What reads it is `NodeView`'s badge press, at PRESS time, through the getter on the
   * context (§V101: act on the whole selection when this node is in it). A getter is what a
   * read at event time wants; a subscription would be paying every frame for an answer
   * needed on a click.
   */
  const selectedRef = useRef<readonly NodeId[]>(EMPTY_SELECTION);
  const getSelection = useCallback(() => selectedRef.current, []);

  // T1531b: React Flow reports in its own node order; the selection leaves in the order it
  // was MADE in, primary last (`selection-order.ts`).
  const reportSelection = useCallback(
    ({ nodes }: { nodes: LoomNode[] }) => {
      const ids = orderSelection(selectedRef.current, nodes.map((node) => node.id));
      selectedRef.current = ids;
      onSelectionChange?.(ids);
    },
    [onSelectionChange],
  );
  // T1531b: a click on a node that is already selected makes it the primary.
  const promoteClicked = useCallback(
    (_event: unknown, node: LoomNode) => {
      const ids = promoteInSelection(selectedRef.current, node.id);
      if (ids === selectedRef.current) return;
      selectedRef.current = ids;
      onSelectionChange?.(ids);
    },
    [onSelectionChange],
  );

  /**
   * §V101/§V102/§V29 — the badge, `space`-style hotkeys and the context menu are one
   * implementation: all three run this same bus command, and the command itself (not
   * this callback) decides the ALL-ON-then-ALL-OFF semantics (`toggleFlagOperations`,
   * `src/domain/commands/editor-commands.ts`). This callback only names which nodes.
   */
  const toggleUi = useCallback(
    (command: NodeToggleCommand, nodeIds: readonly NodeId[]) => {
      void bus.execute(command, { nodeIds }, invocation);
    },
    [bus, invocation],
  );

  // T599: the node's "+N more" chip — same door as everything else, a bus command
  // (§V29, §V307), so the palette and a keybinding get it for free.
  const showProblems = useCallback(() => {
    void bus.execute("ui.showProblems", {}, invocation);
  }, [bus, invocation]);

  // T602: double-click enters a component — the same command the keymap (`i`) and the
  // context menu run, so three doors, one implementation (§V78, §V307).
  const diveIn = useCallback(
    (nodeId: NodeId) => {
      void bus.execute("graph.diveIn", { nodeId }, invocation);
    },
    [bus, invocation],
  );

  /**
   * T415/B60 — the inline name editor's two halves.
   *
   * Registering the command here is what makes `n` and the context menu's "Rename…" reach
   * a surface at all; before this, both fired `node.rename` with no label and nothing
   * happened (§V342). `renameNode` is the commit, and it runs the SAME `node.rename`
   * command rather than a `setNodeLabel` patch of its own — the node header supplies the
   * argument, it does not own a second rename (§V29, §V61).
   */
  const renameSession = useMemo(() => registerRenameSessionCommand(bus.root), [bus]);
  // §T1695b: the command asks THIS canvas whether it shows the node, whichever graph that is.
  useEffect(() => {
    const holder = renameCanvasHolderFor(bus);
    const canvas = { holds: (nodeId: NodeId) => bus.store.getGraph().nodes[nodeId] !== undefined };
    holder.current = canvas;
    return () => {
      if (holder.current === canvas) holder.current = null;
    };
  }, [bus]);
  const beginRename = useCallback(
    (nodeId: NodeId) => {
      void bus.execute("ui.beginRename", { nodeIds: [nodeId] }, invocation);
    },
    [bus, invocation],
  );
  const renameNode = useCallback(
    (nodeId: NodeId, label: string, exact?: boolean) =>
      bus.execute("node.rename", { nodeId, label, ...(exact === true ? { exact: true } : {}) }, invocation),
    [bus, invocation],
  );

  /**
   * T1597b — the low-zoom kind labels of THIS canvas. One registry per canvas, because a
   * zoom is a property of a canvas and two canvases on one document zoom apart (§V97).
   * Every node's label joins it; `KindLabelDriver` below tells it the zoom.
   */
  const kindLabels = useMemo(() => createKindLabelRegistry(), []);

  /**
   * T709 — the node browser, and the double-click that opens it.
   *
   * State is the GRAPH position only. The client anchor is derived from it at render
   * time, so "the browser opened at the cursor" and "the node landed at the cursor" are
   * one number used twice rather than two paths that must be kept in agreement.
   */
  const [nodeSearchAt, setNodeSearchAt] = useState<{ x: number; y: number } | null>(null);

  const openNodeSearch = useCallback((position: { x: number; y: number } | undefined) => {
    const flow = flowRef.current;
    if (flow === null) return null;
    let target = position;
    if (target === undefined) {
      // No cursor — a bare `tab`. The viewport centre is the honest stand-in.
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect === undefined) return null;
      target = flow.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    }
    // §V66: an unlaid-out pane projects to NaN, and a NaN position reaches the document.
    if (!(Number.isFinite(target.x) && Number.isFinite(target.y))) return null;
    const settled = { x: target.x, y: target.y };
    setNodeSearchAt(settled);
    return settled;
  }, []);

  /**
   * T1195 — `tab` inside a component, found by the audit rather than reported. Same
   * mechanism as the Shift+F the owner DID report: registered on `bus` alone, so one
   * `graph.diveIn` moved the holder to the session bus and left the root one — the bus
   * `KeymapProvider` and the palette dispatch on — holding `null`. Measured through the
   * real app: `applied` at the root, `rejected library.noSurface` after one dive, and
   * `library.noSurface` is `info`, which no surface shows.
   *
   * The double-click below never broke, because it executes on this canvas's OWN bus —
   * which is exactly why a keyboard-only defect can live behind a working gesture.
   */
  const nodeSearchHolder = useMemo(() => registerNodeSearchCommand(appBus), [appBus]);
  useEffect(() => {
    const handlers = { open: openNodeSearch };
    nodeSearchHolder.current = handlers;
    return () => {
      if (nodeSearchHolder.current === handlers) nodeSearchHolder.current = null;
    };
  }, [nodeSearchHolder, openNodeSearch]);

  /**
   * The gesture. It does not open anything itself — it names the command, the way the
   * middle-click node-info watcher does (§V78, §V307), so the palette and the `tab`
   * binding stay the same door.
   *
   * `resolveMenuTarget` is what decides "this landed on the background": it reads React
   * Flow's own DOM markers, so a double-click on a node still means dive-in or rename
   * (node-view.tsx already owns those and stops propagation) and never opens a browser
   * on top of the node you just double-clicked.
   */
  /**
   * T1821b — a double-click on a WIRE puts a tie on it, where it was clicked (Unreal's
   * gesture; Houdini's Alt-click is taken by Alt-pan here, B195). The same
   * `graph.rerouteEdge` as the edge menu's "Add tie" (§V78). The hit is asked of the wire
   * that was double-clicked alone, so the tie lands ON it — at the nearest point of the
   * drawn curve — and in the leg of its route that was clicked.
   */
  const onEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: LoomEdge) => {
      const flow = flowRef.current;
      if (flow === null) return;
      const zoom = flow.getZoom();
      if (!(zoom > 0)) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const hit = edgeGeometry.hit(point, (2 * EDGE_HIT_TOLERANCE_PX) / zoom, (edgeId) => edgeId !== edge.id);
      const at = hit?.point ?? point;
      if (!(Number.isFinite(at.x) && Number.isFinite(at.y))) return;
      void bus
        .execute(
          REROUTE_EDGE_COMMAND,
          {
            edgeIds: [edge.id],
            position: { x: at.x, y: at.y },
            ...(hit === null ? {} : { index: hit.segment }),
          },
          invocation,
        )
        .then((result) => onPatchResult?.(result));
    },
    [bus, edgeGeometry, invocation, onPatchResult],
  );

  const onCanvasDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const element = canvasRef.current;
      if (element === null) return;
      const start = event.target instanceof Element ? event.target : null;
      // T1257: the overview map is chrome over the canvas, not the canvas — a double
      // click on it (two quick jumps) must not open the node browser underneath.
      if (start !== null && start.closest(".react-flow__minimap") !== null) return;
      const resolved = resolveMenuTarget(start, { fallback: "canvas", boundary: element });
      if (resolved === null || resolved.surface !== "canvas") return;
      const flow = flowRef.current;
      if (flow === null) return;
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void bus.execute(OPEN_NODE_SEARCH_COMMAND, { position }, invocation);
    },
    [bus, invocation],
  );

  const addSearchedNode = useCallback(
    (type: string, position: { x: number; y: number }) => {
      setNodeSearchAt(null);
      const patch: GraphPatch = {
        baseRevision: bus.store.getRevision(),
        operations: [
          { op: "addNode", ref: "$added", type, position: { x: position.x, y: position.y } },
        ],
        label: "Add node",
      };
      // Not `dispatch`: the node the user just picked becomes the selection, and that
      // needs the RESULT — `createdIds` is the only place the minted id exists.
      void bus.execute("graph.applyPatch", patch, invocation).then(async (result) => {
        onPatchResult?.(result);
        await selectCreatedNodes(bus, invocation, result);
      });
    },
    [bus, invocation, onPatchResult],
  );

  const reportEnter = useCallback(
    (_event: unknown, node: LoomNode) => onHoveredNodeChange?.(node.id),
    [onHoveredNodeChange],
  );

  const reportLeave = useCallback(() => onHoveredNodeChange?.(null), [onHoveredNodeChange]);

  // B195: the same key React Flow reads for `panActivationKeyCode`, read the same way.
  const panKeyHeld = useKeyPress(PAN_KEY);

  const context = useMemo<GraphCanvasContextValue>(
    () => ({
      store: bus.store,
      registry,
      runtime: runtimeSource,
      edgeGeometry,
      ties,
      dispatch,
      selection: getSelection,
      toggleUi,
      renameSession,
      beginRename,
      renameNode,
      kindLabels,
      renderPreview,
      renderControls,
      renderHeaderControls,
      previewLens,
      showProblems,
      diveIn,
      components,
      timingOverlay,
      timingScale,
      edgeFlow,
    }),
    [
      bus.store,
      registry,
      runtimeSource,
      edgeGeometry,
      ties,
      dispatch,
      getSelection,
      toggleUi,
      renameSession,
      beginRename,
      renameNode,
      kindLabels,
      renderPreview,
      renderControls,
      renderHeaderControls,
      previewLens,
      showProblems,
      diveIn,
      components,
      timingOverlay,
      timingScale,
      edgeFlow,
    ],
  );

  return (
    <GraphCanvasContext.Provider value={context}>
      <div
        className={styles.canvas}
        data-testid="graph-canvas"
        // T1691b: this box is the view the tiles are panned in; one outside it is off screen.
        {...{ [VIEW_CLIP_ATTRIBUTE]: "" }}
        data-pan-key={panKeyHeld ? "held" : undefined}
        ref={canvasRef}
        onDoubleClick={onCanvasDoubleClick}
        // T1639b: capture, so a press on a connected input's dot is re-aimed before the
        // handle or the node under it hears of it. Both events, as the library listens
        // to both.
        onMouseDownCapture={grabConnectedEnd}
        onTouchStartCapture={grabConnectedEnd}
      >
        <ReactFlow<LoomNode, LoomEdge>
          nodes={viewNodes}
          edges={viewEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          connectionLineType={ConnectionLineType.Bezier}
          // T1639b: the wire in the hand, its tip, and the ring and arc of the port in
          // range. No `connectionRadius` here: `WireRangeDriver` below owns that number.
          connectionLineComponent={WireInFlight}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onConnectStart={onConnectStart}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          // T1639b: a connected wire's input end can be pulled off and put elsewhere.
          // `derive.ts` says which edges and which end; this is the size of the grab zone.
          onReconnectStart={onReconnectStart}
          onReconnect={onReconnect}
          onReconnectEnd={onReconnectEnd}
          reconnectRadius={WIRE_GRAB_RADIUS}
          onInit={onInit}
          isValidConnection={isValidConnection}
          onSelectionChange={reportSelection}
          onNodeClick={promoteClicked}
          onNodeMouseEnter={reportEnter}
          onNodeMouseLeave={reportLeave}
          // Deletion is a keymap binding, not a hidden built-in: §V52 wants every
          // hotkey to be data pointing at a bus command (T76/T77 own that table).
          deleteKeyCode={null}
          panOnDrag={PAN_MOUSE_BUTTONS}
          panActivationKeyCode={PAN_KEY}
          selectionKeyCode={SELECTION_KEY}
          multiSelectionKeyCode={MULTI_SELECTION_KEYS}
          panOnScroll={scrollPans}
          zoomOnScroll={!scrollPans}
          selectionMode={SelectionMode.Partial}
          zoomOnDoubleClick={false}
          /*
            Wide on purpose. 0.2 could not frame a large patch and 2.5 stopped short of
            inspecting a preview — the owner reported both ends as capped early. Node
            previews sharpen with zoom up to their own ladder cap (T490), so the top end is
            useful rather than decorative.
          */
          minZoom={0.05}
          maxZoom={8}
          fitView
        >
          {/*
            T708 gave the dots a colour that can be seen — --graph-dot at size 1.5, where
            --line at size 1 was ΔL* 10.7 over its ground across a sub-pixel radius, so
            the little contrast it had was antialiased straight back out. T717 gave them
            a density that survives the zoom range; the two-layer cross-fade and the
            reason it is not one adaptive gap live in `graph-grid.tsx`.
          */}
          <GraphGrid />
          {/* T1597b: hands the zoom to the low-zoom kind labels. Renders nothing, and re-renders nothing. */}
          <KindLabelDriver registry={kindLabels} />
          {/* T1639b: keeps the range a wire connects from the same size on screen. Renders nothing. */}
          <WireRangeDriver />
          {/* T1724b: TouchDesigner's right-drag box selection; a right click stays the canvas menu. */}
          <RightDragSelect />
          {underlay}
          <ReferenceLines dependencies={dependencies} />
          {/* T1821b: the wire ties — above wires and nodes, so a tie can always be grabbed. */}
          <WireTies colors={tieColors} apply={apply} />
          {showMinimap ? <GraphMinimap host={minimapHost} /> : null}
        </ReactFlow>
        {showMinimap ? <div className={styles.minimapHost} ref={setMinimapHost} /> : null}
        {nodeSearchAt === null ? null : (
          <NodeSearch
            definitions={registry.list()}
            /* Projected back from the graph position the browser will place at, so the
               surface cannot appear anywhere other than where its node will land. */
            anchor={flowRef.current?.flowToScreenPosition(nodeSearchAt) ?? nodeSearchAt}
            onPick={(type) => addSearchedNode(type, nodeSearchAt)}
            onClose={() => setNodeSearchAt(null)}
          />
        )}
      </div>
    </GraphCanvasContext.Provider>
  );
}
