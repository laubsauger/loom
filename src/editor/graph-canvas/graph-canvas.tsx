// Library chrome first, then our overrides, then (transitively, below) the component
// modules — so a token override never loses a specificity tie to React Flow's default.
import "@xyflow/react/dist/style.css";
import "./xyflow-theme.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { CommandResult, InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatch, GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { NodeView } from "@editor/nodes/node-view.tsx";
import { SignalEdge } from "@editor/edges/signal-edge.tsx";
import { EDGE_HIT_TOLERANCE_PX, createEdgeGeometry } from "@editor/edges/edge-geometry.ts";
import { replaceEdgeOperations } from "@editor/edges/edge-drop.ts";
import { GraphCanvasContext } from "./canvas-context.ts";
import type { GraphCanvasContextValue, GraphDispatch, NodeToggleCommand } from "./canvas-context.ts";
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
  /** Patch outcomes, so a rejected gesture can surface instead of failing silently. */
  onPatchResult?: (result: CommandResult<"graph.applyPatch">) => void;
  /**
   * Selection and hover are view state — the document does not model them — but the
   * keymap resolves `inputFrom: "selection" | "hoveredNode"` against them (T77). This
   * is where they leave the canvas.
   */
  onSelectionChange?: (nodeIds: readonly NodeId[]) => void;
  onHoveredNodeChange?: (nodeId: NodeId | null) => void;
}

export function GraphCanvas({
  bus,
  invocation,
  runtime,
  renderPreview,
  renderControls,
  onPatchResult,
  onSelectionChange,
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
      if (Object.keys(committed).length > 0) {
        dispatch([{ op: "moveNodes", positions: committed }], "Move node");
      }
      if (removed.length > 0) {
        dispatch([{ op: "removeNodes", nodeIds: removed }], "Delete node");
      }
    },
    [dispatch],
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

      // §V14a: dropping onto an input that already holds a non-variadic edge REPLACES
      // it rather than being refused — the drop itself is the user's intent, and making
      // them hunt down the old edge to delete first is the wrong answer to that. Both
      // ops leave as one patch, so it is one atomic change and one undo entry (§V32, §V34).
      const targetNode = domainNodes[target];
      const targetPort =
        targetNode === undefined ? undefined : registry.port(targetNode.type, targetHandle, "input");
      const operations: GraphPatchOperation[] = [];
      if (targetPort?.variadic !== true) {
        const displaced = Object.entries(domainEdges)
          .filter(([, edge]) => edge.target.nodeId === target && edge.target.portId === targetHandle)
          .map(([edgeId]) => edgeId);
        if (displaced.length > 0) operations.push({ op: "disconnect", edgeIds: displaced });
      }
      operations.push({
        op: "connect",
        source: { nodeId: source, portId: sourceHandle },
        target: { nodeId: target, portId: targetHandle },
      });
      dispatch(operations, "Connect ports");
    },
    [dispatch, domainEdges, domainNodes, registry],
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
        portId: fromPortId,
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

      const sourcePort = registry.port(sourceNode.type, sourceHandle, "output");
      const targetPort = registry.port(targetNode.type, targetHandle, "input");
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
      renderPreview,
      renderControls,
    }),
    [
      bus.store,
      registry,
      runtimeSource,
      edgeGeometry,
      dispatch,
      selectedIds,
      toggleUi,
      renderPreview,
      renderControls,
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
          minZoom={0.2}
          maxZoom={2.5}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--line)" />
        </ReactFlow>
      </div>
    </GraphCanvasContext.Provider>
  );
}
