// Library chrome first, then our overrides, then (transitively, below) the component
// modules — so a token override never loses a specificity tie to React Flow's default.
import "@xyflow/react/dist/style.css";
import "./xyflow-theme.css";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";
import type {
  Connection,
  EdgeChange,
  EdgeTypes,
  FinalConnectionState,
  IsValidConnection,
  NodeChange,
  NodeTypes,
  ReactFlowInstance,
} from "@xyflow/react";
import { useStore } from "zustand";
import { arePortsCompatible } from "@domain/graph/port-compat.ts";
import { incomingEdgesInOrder, parseHandleId } from "@domain/graph/edge-order.ts";
import type { CommandResult, InvocationContext } from "@domain/types/commands.ts";
import type { ComponentRegistryView } from "@domain/components/index.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatch, GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { NodeView } from "@editor/nodes/node-view.tsx";
import { registerRenameSessionCommand } from "@editor/nodes/rename-session.ts";
import { SignalEdge } from "@editor/edges/signal-edge.tsx";
import {
  EDGE_HIT_TOLERANCE_PX,
  SPLICE_BAND_FRACTION,
  createEdgeGeometry,
} from "@editor/edges/edge-geometry.ts";
import { replaceEdgeOperations, spliceNodeOperations } from "@editor/edges/edge-drop.ts";
import { ReferenceLines } from "@editor/edges/reference-lines.tsx";
import { registerReferenceLinesCommand } from "@editor/edges/reference-lines-command.ts";
import { parameterDependencies } from "@domain/graph/parameter-dependencies.ts";
import { GraphCanvasContext } from "./canvas-context.ts";
import type {
  GraphCanvasContextValue,
  GraphDispatch,
  NodeToggleCommand,
  PreviewInspectSource,
  PreviewLensSource,
} from "./canvas-context.ts";
import { LOOM_NODE_TYPE, SIGNAL_EDGE_TYPE, projectEdges, projectNodes } from "./derive.ts";
import type { LoomEdge, LoomNode } from "./derive.ts";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import type { NodeRuntimeSource } from "./node-runtime.ts";
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

const NODE_TYPES: NodeTypes = { [LOOM_NODE_TYPE]: NodeView as NodeTypes[string] };
const EDGE_TYPES: EdgeTypes = { [SIGNAL_EDGE_TYPE]: SignalEdge as EdgeTypes[string] };
const DEFAULT_EDGE_OPTIONS = { type: SIGNAL_EDGE_TYPE } as const;
/** §I.ui: middle-drag pans, alt-drag pans, left-drag rubber-band selects, scroll zooms. */
const PAN_MOUSE_BUTTONS = [1] as const;

export interface GraphCanvasProps {
  bus: ShaderloomBus;
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
  /** T675: the preview inspection control's source — see `canvas-context.ts` for why the
      control is in the node HEADER and not on the tile it drives. */
  previewInspect?: (nodeId: NodeId) => PreviewInspectSource | null;
  /** T685: the preview lens marker's source — §V70a's warning, out from under the tile. */
  previewLens?: (nodeId: NodeId) => PreviewLensSource | null;
  /** Patch outcomes, so a rejected gesture can surface instead of failing silently. */
  onPatchResult?: (result: CommandResult<"graph.applyPatch">) => void;
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
}

export function GraphCanvas({
  bus,
  components,
  invocation,
  runtime,
  renderPreview,
  renderControls,
  previewInspect,
  previewLens,
  onPatchResult,
  onSelectionChange,
  underlay,
  onHoveredNodeChange,
}: GraphCanvasProps) {
  const registry = bus.registry;
  const domainNodes = useStore(bus.store, (state) => state.graph.nodes);
  const domainEdges = useStore(bus.store, (state) => state.graph.edges);

  // One per mounted canvas: every edge writes where it is, the drop handlers read it.
  const edgeGeometry = useMemo(() => createEdgeGeometry(), []);

  const fallbackRuntime = useMemo(() => createNodeRuntimeStore(), []);
  useEffect(() => () => fallbackRuntime.dispose(), [fallbackRuntime]);
  const runtimeSource = runtime ?? fallbackRuntime;

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
   */
  const referenceLines = useMemo(() => registerReferenceLinesCommand(bus), [bus]);
  const showReferenceLines = useSyncExternalStore(referenceLines.subscribe, referenceLines.get);
  const domainGraph = useStore(bus.store, (state) => state.graph);
  const dependencies = useMemo(
    () => (showReferenceLines ? [...parameterDependencies(domainGraph).values()].flat() : []),
    [showReferenceLines, domainGraph],
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

  const dispatch = useCallback<GraphDispatch>(
    (operations: GraphPatchOperation[], label: string) => {
      if (operations.length === 0) return;
      const patch: GraphPatch = {
        baseRevision: bus.store.getRevision(),
        operations,
        label,
      };
      void bus
        .execute("graph.applyPatch", patch, invocation)
        .then((result) => onPatchResult?.(result));
    },
    [bus, invocation, onPatchResult],
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
      const edgeId = edgeGeometry.nearest(centre, tolerance, (candidate) => {
        const edge = graph.edges[candidate];
        return edge === undefined || edge.source.nodeId === nodeId || edge.target.nodeId === nodeId;
      });
      if (edgeId === null) return [];
      const edge = graph.edges[edgeId];
      if (edge === undefined) return [];
      return spliceNodeOperations(graph, registry, edge, nodeId);
    },
    [bus, edgeGeometry, registry],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<LoomNode>[]) => {
      setViewNodes((previous) => applyNodeChanges(changes, previous));

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
        const splice = only === undefined || target === undefined ? [] : spliceAt(only, target);
        // The move and the splice are ONE gesture, so they are one patch and one undo
        // entry (§V15, §V32, §V34): undoing puts the node back AND restores the wire it
        // cut into. Two patches would make the user undo twice for one drop, and would
        // leave a graph rewired around a node that had moved back.
        operations.push(...splice);
        dispatch(operations, splice.length > 0 ? "Insert node into edge" : "Move node");
      }
      if (removed.length > 0) {
        dispatch([{ op: "removeNodes", nodeIds: removed }], "Delete node");
      }
    },
    [dispatch, spliceAt],
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
   * A completed connect gesture is a request, not a fact: it goes to the bus, and the
   * edge only appears once the patch comes back through the projection (§V1, §V29).
   */
  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (sourceHandle === null || targetHandle === null) return;

      // T695: a variadic input's handles are addressed by SLOT, so the handle id is not
      // the port id. Everything below works in port-and-slot terms from here.
      const { portId: targetPortId, slot } = parseHandleId(targetHandle);
      const { portId: sourcePortId } = parseHandleId(sourceHandle);

      // §V14a: dropping onto an input that already holds a non-variadic edge REPLACES
      // it rather than being refused — the drop itself is the user's intent, and making
      // them hunt down the old edge to delete first is the wrong answer to that. Both
      // ops leave as one patch, so it is one atomic change and one undo entry (§V32, §V34).
      const targetNode = domainNodes[target];
      const targetPort =
        targetNode === undefined ? undefined : registry.port(targetNode.type, targetPortId, "input");
      const operations: GraphPatchOperation[] = [];
      let order: number | undefined;
      if (targetPort?.variadic !== true) {
        const displaced = Object.entries(domainEdges)
          .filter(([, edge]) => edge.target.nodeId === target && edge.target.portId === targetPortId)
          .map(([edgeId]) => edgeId);
        if (displaced.length > 0) operations.push({ op: "disconnect", edgeIds: displaced });
      } else if (slot !== undefined) {
        /*
         * T695 — the gesture the one-socket port could not express: a drop on an OCCUPIED
         * socket replaces the wire in it, in place.
         *
         * `incomingEdgesInOrder` and not a filter of my own: this has to resolve "slot 2"
         * to the same edge the node drew at slot 2 and the projection drew the wire to
         * (§V487). The `order` on the connect is what puts the newcomer where the old one
         * was — without it the disconnect would compact the survivors and the replacement
         * would append, which counts right and wires wrong.
         *
         * A drop on the SPARE socket (slot === count) resolves to nothing here and falls
         * through to a plain append, which is what it means.
         */
        const occupant = incomingEdgesInOrder({ edges: domainEdges }, target, targetPortId)[slot];
        if (occupant !== undefined) {
          if (occupant.source.nodeId === source && occupant.source.portId === sourcePortId) return;
          operations.push({ op: "disconnect", edgeIds: [occupant.id] });
          order = slot;
        }
      }
      operations.push({
        op: "connect",
        source: { nodeId: source, portId: sourcePortId },
        target: { nodeId: target, portId: targetPortId },
        ...(order === undefined ? {} : { order }),
      });
      dispatch(operations, order === undefined ? "Connect ports" : "Replace connection");
    },
    [dispatch, domainEdges, domainNodes, registry],
  );

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
      if (state.isValid === true) return;
      const from = state.fromHandle;
      const flow = flowRef.current;
      if (from === null || from === undefined || flow === null) return;
      // A handle with no id belongs to a node that declares a single unnamed port; ours
      // always name their ports, so there is nothing to reconnect.
      const fromPortId = from.id;
      if (fromPortId === null || fromPortId === undefined) return;

      const client = "changedTouches" in event ? event.changedTouches[0] : event;
      if (client === undefined) return;
      const point = flow.screenToFlowPosition({ x: client.clientX, y: client.clientY });
      // The tolerance is a SCREEN measurement (§V14c), so it is divided by the zoom to
      // stay the same size under the cursor however far the camera is pulled back.
      const zoom = flow.getZoom();
      if (!(zoom > 0)) return;
      const edgeId = edgeGeometry.nearest(point, EDGE_HIT_TOLERANCE_PX / zoom);
      if (edgeId === null) return;

      const graph = bus.store.getGraph();
      const edge = graph.edges[edgeId];
      if (edge === undefined) return;
      const operations = replaceEdgeOperations(graph, registry, edge, {
        nodeId: from.nodeId,
        // T695 — the grabbed end may be one SOCKET of a variadic input; what the document
        // records is the port.
        portId: parseHandleId(fromPortId).portId,
        // React Flow's "source" handle is our output; "target" is our input.
        direction: from.type === "source" ? "output" : "input",
      });
      dispatch(operations, "Replace connection");
    },
    [bus, dispatch, edgeGeometry, registry],
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
      const sourceNode = domainNodes[source];
      const targetNode = domainNodes[target];
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
    [domainNodes, registry],
  );

  /**
   * Selection and hover leave the canvas as plain node ids. They are not document state
   * — the graph document models neither — but the keymap resolves selection-driven
   * command input against them (T77), so this is the seam.
   */
  const [selectedIds, setSelectedIds] = useState<readonly NodeId[]>([]);

  const reportSelection = useCallback(
    ({ nodes }: { nodes: LoomNode[] }) => {
      const ids = nodes.map((node) => node.id);
      setSelectedIds(ids);
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
  const renameSession = useMemo(() => registerRenameSessionCommand(bus), [bus]);
  const beginRename = useCallback(
    (nodeId: NodeId) => {
      void bus.execute("ui.beginRename", { nodeIds: [nodeId] }, invocation);
    },
    [bus, invocation],
  );
  const renameNode = useCallback(
    (nodeId: NodeId, label: string) => bus.execute("node.rename", { nodeId, label }, invocation),
    [bus, invocation],
  );

  const reportEnter = useCallback(
    (_event: unknown, node: LoomNode) => onHoveredNodeChange?.(node.id),
    [onHoveredNodeChange],
  );

  const reportLeave = useCallback(() => onHoveredNodeChange?.(null), [onHoveredNodeChange]);

  const context = useMemo<GraphCanvasContextValue>(
    () => ({
      store: bus.store,
      registry,
      runtime: runtimeSource,
      edgeGeometry,
      dispatch,
      selection: selectedIds,
      toggleUi,
      renameSession,
      beginRename,
      renameNode,
      renderPreview,
      renderControls,
      previewInspect,
      previewLens,
      showProblems,
      diveIn,
      components,
    }),
    [
      bus.store,
      registry,
      runtimeSource,
      edgeGeometry,
      dispatch,
      selectedIds,
      toggleUi,
      renameSession,
      beginRename,
      renameNode,
      renderPreview,
      renderControls,
      previewInspect,
      previewLens,
      showProblems,
      diveIn,
      components,
    ],
  );

  return (
    <GraphCanvasContext.Provider value={context}>
      <div className={styles.canvas} data-testid="graph-canvas">
        <ReactFlow<LoomNode, LoomEdge>
          nodes={viewNodes}
          edges={viewEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          connectionLineType={ConnectionLineType.Bezier}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onInit={onInit}
          isValidConnection={isValidConnection}
          onSelectionChange={reportSelection}
          onNodeMouseEnter={reportEnter}
          onNodeMouseLeave={reportLeave}
          // Deletion is a keymap binding, not a hidden built-in: §V52 wants every
          // hotkey to be data pointing at a bus command (T76/T77 own that table).
          deleteKeyCode={null}
          panOnDrag={[...PAN_MOUSE_BUTTONS]}
          panActivationKeyCode="Alt"
          selectionOnDrag
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
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--line)" />
          {underlay}
          <ReferenceLines dependencies={dependencies} />
        </ReactFlow>
      </div>
    </GraphCanvasContext.Provider>
  );
}
