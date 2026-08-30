import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DragEvent as ReactDragEvent, ReactNode, RefObject } from "react";
import { ReactFlowProvider, useConnection, useReactFlow } from "@xyflow/react";
import type { CommandResult } from "@domain/types/commands.ts";
import type { ShaderloomBus } from "@domain/commands/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { PortType } from "@domain/types/ports.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import { GraphCanvas } from "@editor/graph-canvas/index.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { readNodeDragPayload } from "@editor/library/index.ts";
import { ContextMenuHost } from "@editor/menus/index.ts";
import type { NodeDragPayload } from "@editor/library/index.ts";
import { NodePreviewSlot, createPreviewSlotBounds } from "@editor/viewer/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { useAppRuntime } from "./app-context.ts";
import { registerSelectionCommands } from "./selection-commands.ts";
import { useNodePreviews } from "./use-node-previews.ts";
import styles from "./panes.module.css";

/**
 * The graph pane: the canvas plus the two channels only the composition root can wire —
 * the in-flight port drag the node library filters on (§V13, T39), and the library drop
 * that turns a dragged definition into a real node (§V29).
 *
 * The canvas component itself is untouched. Everything here talks to React Flow through
 * its public hooks from inside a provider the pane owns, and every mutation still leaves
 * as a patch on the bus.
 */

/** The end of a connection currently being dragged, with enough to complete it. */
export interface PortDragOrigin {
  readonly nodeId: NodeId;
  readonly portId: PortId;
  readonly type: PortType;
  /** Which end the user grabbed: an output looks for an input, and vice versa. */
  readonly direction: "input" | "output";
}

/** What the rest of the app can ask the canvas to do. */
export interface GraphActions {
  /** Adds a node at the centre of the current viewport, optionally wiring it up. */
  addNode(type: string, connectTo?: NodeDragPayload["connectTo"]): void;
}

export interface GraphPaneProps {
  /** Current canvas selection, so a right-click inside one acts on all of it (§V78). */
  selection: readonly NodeId[];
  onSelectionChange: (nodeIds: readonly NodeId[]) => void;
  onHoveredNodeChange: (nodeId: NodeId | null) => void;
  /** Published on connect start, cleared on connect end. */
  portDrag: PortDragOrigin | null;
  onPortDragChange: (drag: PortDragOrigin | null) => void;
  onPatchResult: (result: CommandResult<"graph.applyPatch">) => void;
  /** Filled with the canvas actions while the pane is mounted. */
  actionsRef: RefObject<GraphActions | null>;
  /**
   * The live device, once the capability probe has one (§V12), and what the preview
   * request builder needs to resolve a node's tile source (T182, T185). All optional so
   * a caller that only wants the canvas — a test, an embedding — keeps working with no
   * previews rather than being forced to wire a backend it does not have.
   */
  previewBackend?: ShaderloomBackend | null;
  graph?: GraphDocument;
  compiledOutputs?: ReadonlyArray<ResolvedOutput>;
  previewFps?: number;
  previewLongEdge?: number;
  /** T252 (§V158): sink for the preview scheduler's kept set, gating compilation. */
  previewSinks?: { set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void };
}

const EMPTY_GRAPH: GraphDocument = { revision: 0, nodes: {}, edges: {}, groups: {} };
const EMPTY_OUTPUTS: ReadonlyArray<ResolvedOutput> = [];

export function GraphPane(props: GraphPaneProps) {
  // The canvas mounts its own provider when there is none; hoisting it here lets the
  // pane use the same store the canvas renders from, without editing the canvas.
  return (
    <ReactFlowProvider>
      <GraphPaneInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphPaneInner({
  selection,
  onSelectionChange,
  onHoveredNodeChange,
  portDrag,
  onPortDragChange,
  onPatchResult,
  actionsRef,
  previewBackend = null,
  graph = EMPTY_GRAPH,
  compiledOutputs = EMPTY_OUTPUTS,
  previewFps = 20,
  previewLongEdge = 192,
  previewSinks,
}: GraphPaneProps) {
  const { bus, invocation, nodeRuntime, registry } = useAppRuntime();
  const flow = useReactFlow();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // One store per mounted pane: `NodePreviewSlot` writes each node's measured slot
  // rect, the preview tick below reads it every frame (T185, design note §3).
  const previewBounds = useMemo(() => createPreviewSlotBounds(), []);
  const getViewport = useCallback(() => flow.getViewport(), [flow]);
  // §V112 — React Flow's OWN live node array, never `GraphNode.position`: a drag stays
  // uncommitted in the document for its whole duration, and this is exactly the window
  // a preview must keep following the node through.
  const getNodePosition = useCallback((nodeId: NodeId) => flow.getNode(nodeId)?.position, [flow]);

  useNodePreviews({
    ...(previewSinks === undefined ? {} : { previewSinks }),
    backend: previewBackend,
    canvasRef: previewCanvasRef,
    bounds: previewBounds,
    graph,
    registry,
    compiledOutputs,
    nodeRuntime,
    getViewport,
    getNodePosition,
    previewFps,
    previewLongEdge,
  });

  const renderPreview = useCallback(
    (nodeId: NodeId) => (
      <NodePreviewSlot nodeId={nodeId} runtime={nodeRuntime} bounds={previewBounds} />
    ),
    [nodeRuntime, previewBounds],
  );

  const dispatch = useCallback(
    (operations: GraphPatchOperation[], label: string) => {
      if (operations.length === 0) return;
      void bus
        .execute(
          "graph.applyPatch",
          { baseRevision: bus.store.getRevision(), operations, label },
          invocation,
        )
        .then(onPatchResult);
    },
    [bus, invocation, onPatchResult],
  );

  /**
   * One patch adds the node and, when the drag came from a port, wires it — so the
   * whole gesture is one atomic operation and one undo group (§V32, §V34).
   */
  const addNodeAt = useCallback(
    (
      type: string,
      position: { x: number; y: number },
      connectTo: NodeDragPayload["connectTo"],
      origin: PortDragOrigin | null,
    ) => {
      const ref = "$dropped" as const;
      const operations: GraphPatchOperation[] = [{ op: "addNode", ref, type, position }];

      if (connectTo !== undefined && origin !== null) {
        // `connectTo` names the port on the NEW node; the other end is the port the
        // user dragged from.
        operations.push(
          connectTo.direction === "input"
            ? {
                op: "connect",
                source: { nodeId: origin.nodeId, portId: origin.portId },
                target: { nodeId: ref, portId: connectTo.portId },
              }
            : {
                op: "connect",
                source: { nodeId: ref, portId: connectTo.portId },
                target: { nodeId: origin.nodeId, portId: origin.portId },
              },
        );
      }

      dispatch(operations, `Add ${type}`);
      onPortDragChange(null);
    },
    [dispatch, onPortDragChange],
  );

  /**
   * Screen point → graph point, so a node lands under the cursor at any zoom.
   *
   * Guarded, because the projection divides by the viewport zoom: a canvas that has not
   * been laid out yet (a collapsed pane, the first frame, a headless DOM) has no zoom,
   * and the result is NaN. §V66 is explicit about where that ends — NaN serializes to
   * null and the saved document will not load — so a position that is not a real number
   * never reaches a patch.
   */
  const flowPosition = useCallback(
    (client: { x: number; y: number }) => {
      const point = flow.screenToFlowPosition(client);
      return {
        x: Number.isFinite(point.x) ? point.x : 0,
        y: Number.isFinite(point.y) ? point.y : 0,
      };
    },
    [flow],
  );

  const viewportCentre = useCallback((): { x: number; y: number } => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return flowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }, [flowPosition]);

  useEffect(() => {
    const actions: GraphActions = {
      addNode: (type, connectTo) => addNodeAt(type, viewportCentre(), connectTo, portDrag),
    };
    actionsRef.current = actions;
    return () => {
      if (actionsRef.current === actions) actionsRef.current = null;
    };
  }, [actionsRef, addNodeAt, portDrag, viewportCentre]);

  // `mod+a` is a bus command like everything else (§V52); the canvas is what can
  // actually perform it, so it attaches the handler while it is mounted.
  useEffect(() => {
    const holder = registerSelectionCommands(bus);
    const handlers = {
      selectAll: (nodeIds: readonly NodeId[]) => {
        const wanted = new Set(nodeIds);
        flow.setNodes((nodes) => nodes.map((node) => ({ ...node, selected: wanted.has(node.id) })));
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus, flow]);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    // Without this the browser refuses the drop and the library drag does nothing.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const payload = readNodeDragPayload(event.dataTransfer);
      // A foreign drag (a file, a URL, another app) is not ours: leave it alone.
      if (payload === null) return;
      event.preventDefault();
      addNodeAt(
        payload.type,
        flowPosition({ x: event.clientX, y: event.clientY }),
        payload.connectTo,
        portDrag,
      );
    },
    [addNodeAt, flowPosition, portDrag],
  );

  return (
    <div
      ref={surfaceRef}
      className={styles.graph}
      // §V53: every key pressed in here resolves in the `graph` context, so the
      // single-key TD bindings (b, d, r, f…) work on the canvas and nowhere else.
      {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "graph" }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/*
        The one shared preview surface (T185, design note §2/§3): pooled tiles composited
        GPU-to-GPU (§V7), never a canvas per node. It sits ON TOP of the graph — not
        behind it with a hole punched through, which would need React Flow's own opaque
        background pane made transparent — because nothing is drawn here outside a
        tile's own rect, so everywhere else stays see-through. `--z-canvas-overlay` sits
        above node chrome and below popovers/tooltips/dialogs, and `pointer-events: none`
        keeps it out of every gesture the canvas below handles.
      */}
      <canvas ref={previewCanvasRef} className={styles.previewSurface} aria-hidden="true" />
      <GraphMenuHost bus={bus} selection={selection}>
        <GraphCanvas
          bus={bus}
          invocation={invocation}
          runtime={nodeRuntime}
          renderPreview={renderPreview}
          onSelectionChange={onSelectionChange}
          onHoveredNodeChange={onHoveredNodeChange}
          onPatchResult={onPatchResult}
        />
      </GraphMenuHost>
      <PortDragBridge onChange={onPortDragChange} />
    </div>
  );
}

/**
 * Right-click menus for the graph (§V78).
 *
 * Its own component because `screenToFlowPosition` is only available inside the React
 * Flow provider, and "add node here" must land under the cursor rather than at the
 * origin. One host wraps the whole canvas: the target is resolved from the event when
 * the menu opens, so there is no Radix root per node.
 */
function GraphMenuHost({
  bus,
  selection,
  children,
}: {
  bus: ShaderloomBus;
  selection: readonly NodeId[];
  children: ReactNode;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const toGraphPosition = useCallback(
    (client: { x: number; y: number }) => screenToFlowPosition(client),
    [screenToFlowPosition],
  );

  return (
    <ContextMenuHost
      bus={bus}
      fallbackSurface="canvas"
      selection={selection}
      toGraphPosition={toGraphPosition}
    >
      {children}
    </ContextMenuHost>
  );
}

/** Separator that cannot appear inside a handle id or a node id. */
const SEPARATOR = " ";

/**
 * Publishes the in-flight connection.
 *
 * Its own component so that subscribing to React Flow's connection state — which
 * updates on every pointer move during a drag — re-renders nothing but this null. The
 * selector collapses that stream to a string that changes twice per gesture: once when
 * the drag starts, once when it ends.
 *
 * The drag SURVIVES an end that made no connection. That is what completes V13's
 * "drag out of a port and pick a compatible node": the user releases on empty canvas,
 * the library stays filtered to what can accept that port, and the node they choose is
 * wired up on drop. Clearing on every end — including a miss — left the filter alive for
 * no time at all and made `connectTo` unreachable in practice. A drag that DID connect
 * clears, since the intent is satisfied; so does starting another drag, or an explicit
 * clear from the library once it has been used.
 */
function PortDragBridge({ onChange }: { onChange: (drag: PortDragOrigin | null) => void }) {
  const { bus, registry } = useAppRuntime();
  const handleKey = useConnection((connection) =>
    connection.inProgress
      ? [
          connection.fromHandle.nodeId,
          connection.fromHandle.id ?? "",
          connection.fromHandle.type,
        ].join(SEPARATOR)
      : "",
  );

  // Edge count at the moment a drag begins. If it is unchanged when the drag ends, the
  // user released on empty canvas and we keep the filter alive for the library.
  const edgeCountAtStart = useRef<number | null>(null);
  const lastDrag = useRef<PortDragOrigin | null>(null);

  const parsed = useMemo<PortDragOrigin | null>(() => {
    if (handleKey === "") return null;
    const [nodeId, portId, handleType] = handleKey.split(SEPARATOR);
    if (nodeId === undefined || portId === undefined || portId === "") return null;
    const node = bus.store.getGraph().nodes[nodeId];
    if (node === undefined) return null;
    // React Flow's "source" handle is our output; "target" is our input.
    const direction = handleType === "source" ? "output" : "input";
    const port = registry.port(node.type, portId, direction);
    if (port === undefined) return null;
    return { nodeId, portId, type: port.type, direction };
  }, [bus, handleKey, registry]);

  useEffect(() => {
    if (parsed !== null) {
      // A drag started (or replaced an earlier one).
      edgeCountAtStart.current = Object.keys(bus.store.getGraph().edges).length;
      lastDrag.current = parsed;
      onChange(parsed);
      return;
    }

    // A drag just ended. Nothing to do if there was not one.
    const previous = lastDrag.current;
    if (previous === null) return;
    lastDrag.current = null;

    const before = edgeCountAtStart.current;
    edgeCountAtStart.current = null;
    const connected = before !== null && Object.keys(bus.store.getGraph().edges).length > before;

    // Connected: intent satisfied, drop the filter. Missed: keep it, so the library is
    // still showing compatible nodes when the user goes looking for one.
    if (connected) onChange(null);
  }, [bus, onChange, parsed]);

  return null;
}
