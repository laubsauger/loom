import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, ReactNode, RefObject } from "react";
import { ReactFlowProvider, useConnection, useReactFlow } from "@xyflow/react";
import type { CommandResult } from "@domain/types/commands.ts";
import type { ShaderloomBus } from "@domain/commands/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId, PortId } from "@domain/types/ids.ts";
import { publishesValueChannels } from "@domain/types/node-definition.ts";
import { bypassPassthroughPorts } from "@domain/graph/bypass.ts";
import { previewAspectOf } from "@domain/graph/node-box.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { PortType } from "@domain/types/ports.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import { GraphCanvas } from "@editor/graph-canvas/index.ts";
import { type CameraPose, createCameraGizmoStore } from "@editor/viewer/camera-gizmo-store.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { useKeymapPane } from "@editor/keymap/index.ts";
import { readNodeDragPayload } from "@editor/library/index.ts";
import { ContextMenuHost } from "@editor/menus/index.ts";
import type { NodeDragPayload } from "@editor/library/index.ts";
import { NodePreviewSlot, createPreviewOrbitStore, createPreviewSlotBounds, lensMarker, usePreviewViews } from "@editor/viewer/index.ts";
import { ValuePlot } from "@editor/nodes/value-plot.tsx";
import { plotValues } from "@editor/nodes/value-function.ts";
import type { ValueHistorySource } from "@editor/nodes/value-history.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { useAppRuntime } from "./app-context.ts";
import { registerSelectionCommands } from "./selection-commands.ts";
import { registerViewCommands } from "./view-commands.ts";
import { useNodePreviews } from "./use-node-previews.ts";
import { useGraphBackground } from "./use-graph-background.ts";
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
  /**
   * Rolling channel history for value nodes (T344). Optional for the same reason the
   * backend is: a caller that only wants the canvas gets nodes with no plot rather than
   * being forced to wire a frame loop.
   */
  valueHistory?: ValueHistorySource;
  /**
   * T639(e): the component-editing path this pane is showing (instance chain from the
   * root, innermost last). Only its TRANSITIONS matter here — see the effect below.
   */
  componentPath?: readonly NodeId[];
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
  valueHistory,
  componentPath,
}: GraphPaneProps) {
  // T519: `documentIdentity` — which DOCUMENT the previews below are showing. Taken
  // from the runtime rather than threaded as a prop, because the runtime IS the loaded
  // document: `adoptDocument` builds a new one per open (`app.tsx`, `app-runtime.ts`).
  const { bus, components, documentIdentity, invocation, nodeRuntime, registry, settings } = useAppRuntime();
  // T601: the component catalogue view, for resolving an instance's preview target.
  const componentsView = useMemo(() => components.view(), [components]);
  const flow = useReactFlow();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // One store per mounted pane: `NodePreviewSlot` writes each node's measured slot
  // rect, the preview tick below reads it every frame (T185, design note §3).
  const previewBounds = useMemo(() => createPreviewSlotBounds(), []);
  // T561: per-PANE inspection orbits — a second pane on the same node is a second
  // camera, by construction (each mounted pane creates its own store).
  const previewOrbits = useMemo(() => createPreviewOrbitStore(), []);
  // T336: the preview LENS. Registers `preview.setView`/`preview.resetView` and keeps their
  // default target on the selection while this pane is mounted — the pane that shows previews
  // is the one that can honestly offer a command for changing how they look (§V90).
  const previewViews = usePreviewViews(bus, selection);
  const getViewport = useCallback(() => flow.getViewport(), [flow]);
  // §V112 — React Flow's OWN live node array, never `GraphNode.position`: a drag stays
  // uncommitted in the document for its whole duration, and this is exactly the window
  // a preview must keep following the node through.
  const getNodePosition = useCallback((nodeId: NodeId) => flow.getNode(nodeId)?.position, [flow]);

  // T463: nodes flagged as GRAPH BACKGROUND render behind the patch, dimmed — the
  // preview machinery on a second canvas one z-layer down (see use-graph-background).
  useGraphBackground({
    backend: previewBackend,
    canvasRef: backgroundCanvasRef,
    graph,
    compiledOutputs,
    ...(previewSinks === undefined ? {} : { previewSinks }),
    previewFps,
    previewLongEdge,
    documentIdentity,
  });

  useNodePreviews({
    ...(previewSinks === undefined ? {} : { previewSinks }),
    backend: previewBackend,
    canvasRef: previewCanvasRef,
    bounds: previewBounds,
    graph,
    registry,
    compiledOutputs,
    nodeRuntime,
    views: previewViews,
    orbits: previewOrbits,
    components: componentsView,
    getViewport,
    getNodePosition,
    previewFps,
    previewLongEdge,
    documentIdentity,
  });

  /**
   * T561/T675 — which nodes can be orbited, asked ONCE per compile instead of once per
   * node per render.
   *
   * Orbitable iff the COMPILER marked this node's preview as a synthesized 3D picture
   * with a camera to move — never inferred from a node type here, and never listed. The
   * compiler derives that from the PAYLOAD KIND at one site (`compiler/preview-orbit.ts`),
   * which is the owner's "inherit from a common thing": a new payload kind cannot reach
   * this line without having stated whether it has a camera.
   */
  const orbitableNodes = useMemo(() => {
    const nodes = new Set<NodeId>();
    for (const output of compiledOutputs) {
      if (output.synthesis?.orbit !== undefined) nodes.add(output.nodeId as NodeId);
    }
    return nodes;
  }, [compiledOutputs]);

  /**
   * T692 — which tiles get the camera GIZMO: the compiler's own payload-kind
   * declaration, same discipline as `orbitableNodes` above (never a node-type guess).
   * A camera tile is deliberately NOT orbitable (its picture draws through the
   * document's matrix, §T639(a)) — which is exactly why the same gestures may WRITE
   * the document there: what moves on screen is the document moving.
   */
  const cameraGizmoNodes = useMemo(() => {
    const nodes = new Set<NodeId>();
    for (const output of compiledOutputs) {
      if (output.synthesis?.kind === "camera") nodes.add(output.nodeId as NodeId);
    }
    return nodes;
  }, [compiledOutputs]);

  const graphRef = useRef(graph);
  graphRef.current = graph;
  /**
   * The document's pose, read at gesture start (§V657). Null when either vector wears
   * a non-static envelope: a drag that clobbered a driven binding with a plain value
   * would silently disconnect the drive, so a driven camera simply offers no gizmo.
   */
  const readCameraPose = useCallback((nodeId: NodeId): CameraPose | null => {
    const node = graphRef.current.nodes[nodeId];
    if (node === undefined) return null;
    const vec = (key: string, fallback: readonly [number, number, number]) => {
      const raw = node.parameters[key];
      if (raw === undefined) return fallback;
      if (Array.isArray(raw) && raw.length === 3 && raw.every((n) => typeof n === "number")) {
        return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0] as const;
      }
      return null;
    };
    const eye = vec("eye", [0, 0.5, 3]);
    const lookAt = vec("lookAt", [0, 0, 0]);
    if (eye === null || lookAt === null) return null;
    return { eye, lookAt };
  }, []);

  const parameterEditor = useMemo(
    () => createParameterEditor({ bus, context: invocation }),
    [bus, invocation],
  );
  useEffect(() => () => parameterEditor.dispose(), [parameterEditor]);
  const cameraGizmos = useMemo(
    () => createCameraGizmoStore({ editor: parameterEditor, readPose: readCameraPose }),
    [parameterEditor, readCameraPose],
  );

  /**
   * T675 — the inspection control's source for the node HEADER.
   *
   * The toggle used to be drawn on the tile and was invisible there: the shared preview
   * surface composites over every pixel of a node's preview slot (`canvas-context.ts`
   * carries the stacking analysis). Returning the store rather than a rendered control
   * keeps `NodeView` free of any preview import, and returning `null` is how a node with
   * nothing to inspect says so — a suspended preview publishes no orbit, so it offers no
   * camera (T669, answered: no ghost control that cannot work).
   */
  const previewInspect = useCallback(
    (nodeId: NodeId) => {
      if (orbitableNodes.has(nodeId)) return previewOrbits;
      // T692: a camera tile's toggle arms the DOCUMENT gizmo — offered only while the
      // pose is plainly readable, so a driven camera shows no control that cannot work.
      if (cameraGizmoNodes.has(nodeId) && readCameraPose(nodeId) !== null) return cameraGizmos;
      return null;
    },
    [cameraGizmoNodes, cameraGizmos, orbitableNodes, previewOrbits, readCameraPose],
  );

  /**
   * T685 — the lens marker's source for the node HEADER, §V633's move applied to §V70a's
   * warning. The marker text is derived here rather than in the node view so that
   * `NodeView` keeps its zero imports from the preview system; `lensMarker` is the same
   * function the tile used to call, so there is one spelling of what a lens is called.
   */
  const lensSource = useMemo(
    () => ({
      marker: (nodeId: NodeId) => lensMarker(previewViews.get(nodeId)),
      subscribe: (nodeId: NodeId, listener: () => void) => previewViews.subscribe(nodeId, listener),
    }),
    [previewViews],
  );
  // One source for every node — it is keyed by nodeId on every call, so a per-node object
  // would only churn `useSyncExternalStore`'s subscription on each render.
  const previewLens = useCallback(() => lensSource, [lensSource]);

  /**
   * One seam, two surfaces (T185, T344).
   *
   * `NodeView` asks for "whatever this node shows" and knows nothing about either system.
   * A texture node gets the preview slot, which measures its bounds so the runtime can
   * composite a GPU tile there; a VALUE node gets a plot of its channels, which is plain
   * DOM and must NOT publish slot bounds — there is no tile to place.
   */
  const renderPreview = useCallback(
    (nodeId: NodeId) => {
      const type = graph.nodes[nodeId]?.type;
      const definition = type === undefined ? undefined : registry.get(type);
      // T438 (§V316): the DECLARED channel, not the category shelf — audio moved to
      // "input" and must keep its plot; a camera never earns one.
      if (definition !== undefined && publishesValueChannels(definition)) {
        if (valueHistory === undefined) return null;
        // T459: hand the plot what the node IS and let `sampleValueFunction` decide
        // whether it has a curve. The pure/stateful split lives THERE, in one place, so
        // there is exactly one thing to get right and one thing to test — a second copy
        // of the condition here would be redundant and, being redundant, untested.
        const node = graph.nodes[nodeId];
        const source =
          node === undefined
            ? null
            : {
                definition,
                values: plotValues(definition, node.parameters),
                randomSeed: settings.randomSeed,
              };
        /*
         * T576 — a node that is OFF says so instead of drawing.
         *
         * The same question the value graph asks, asked once (§V109). MUTE is
         * unconditional there — `if (node.ui?.muted === true) continue`, before inputs,
         * parameters, state or diagnostics (T541, §V504) — so a muted value node of any
         * kind publishes nothing. BYPASS is not the same question: a node with a coherent
         * passthrough keeps publishing (its input's bag, unchanged), and its plot is then
         * TRUE. Only a bypassed node with nothing to pass through is silent, which is
         * exactly what `bypassPassthroughPorts` returning undefined means — the same
         * predicate the value graph and the texture compiler splice by.
         */
        const silence =
          node?.ui?.muted === true
            ? "muted"
            : node?.ui?.bypassed === true && bypassPassthroughPorts(definition) === undefined
              ? "bypassed"
              : null;
        return (
          <ValuePlot nodeId={nodeId} history={valueHistory} source={source} silence={silence} />
        );
      }
      const orbitable = orbitableNodes.has(nodeId);
      const gizmo = !orbitable && cameraGizmoNodes.has(nodeId) && readCameraPose(nodeId) !== null;
      return (
        <NodePreviewSlot
          nodeId={nodeId}
          runtime={nodeRuntime}
          bounds={previewBounds}
          views={previewViews}
          orbits={gizmo ? cameraGizmos : previewOrbits}
          orbitable={orbitable || gizmo}
        />
      );
    },
    [cameraGizmoNodes, cameraGizmos, graph, nodeRuntime, orbitableNodes, previewBounds, previewOrbits, previewViews, readCameraPose, registry, settings, valueHistory],
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

  /**
   * `F` and `f` (T430/§V354). Same shape as select-all above and for the same reason: the
   * canvas is the only thing that can move its own camera, so it fills the holder while
   * it is mounted.
   *
   * The count comes from the nodes React Flow ACTUALLY holds, not from the ids asked for.
   * `fitView` silently ignores an id it does not know, so counting the request would let
   * a stale selection report a camera move that never happened (§V123).
   */
  useEffect(() => {
    const holder = registerViewCommands(bus);
    const handlers = {
      frame: (nodeIds: readonly string[] | null): number => {
        if (nodeIds === null) {
          const all = flow.getNodes();
          if (all.length > 0) void flow.fitView();
          return all.length;
        }
        const wanted = new Set(nodeIds);
        const present = flow.getNodes().filter((node) => wanted.has(node.id));
        if (present.length === 0) return 0;
        void flow.fitView({ nodes: present.map((node) => ({ id: node.id })) });
        return present.length;
      },
      home: (): number => {
        const all = flow.getNodes();
        if (all.length === 0) return 0;
        // 1:1 on the CONTENT's centre, not on the origin: an empty corner of the canvas
        // is a known scale showing nothing, which is not what "home" means to anyone.
        const bounds = flow.getNodesBounds(all);
        void flow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom: 1 });
        return all.length;
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus, flow]);

  // §V351/B66/B67: declaring the `graph` context and being able to hold focus are one
  // call. See `useKeymapPane` for why neither half works without the other.
  const paneProps = useKeymapPane<HTMLDivElement>("graph", surfaceRef);

  /*
   * T639(e): a dive round trip is two gestures, not five. The commands never required a
   * selection or a click — `graph.jumpUp` takes no input at all — but the UI leaked
   * both requirements in: entering a component moved focus off the pane (so `u` was
   * dead until a canvas click), and leaving one cleared the selection (so the next
   * `i` needed a hunt for the instance you were just inside). On every depth change
   * the pane takes focus back; on the way UP, the instance just exited becomes the
   * selection, so dive-in is immediately available again.
   */
  const pathRef = useRef<readonly NodeId[] | undefined>(componentPath);
  useEffect(() => {
    const before = pathRef.current;
    pathRef.current = componentPath;
    if (before === undefined || componentPath === undefined) return;
    if (before.length === componentPath.length) return;
    surfaceRef.current?.focus();
    if (componentPath.length < before.length) {
      const exited = before[componentPath.length];
      if (exited !== undefined) {
        flow.setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === exited })));
        onSelectionChange([exited]);
      }
    }
  }, [componentPath, flow, onSelectionChange]);

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
      // §V53: every key pressed in here resolves in the `graph` context, so the
      // single-key TD bindings (b, d, r, f…) work on the canvas and nowhere else.
      {...paneProps}
      className={styles.graph}
      // T668: the preview slots' aspect is the PROJECT's (previewAspectOf models the
      // same number for layout) — published as a CSS variable so every node reads it.
      style={{ "--preview-aspect": String(previewAspectOf(settings)) } as CSSProperties}
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
          components={componentsView}
          invocation={invocation}
          runtime={nodeRuntime}
          renderPreview={renderPreview}
          previewInspect={previewInspect}
          previewLens={previewLens}
          onSelectionChange={onSelectionChange}
          onHoveredNodeChange={onHoveredNodeChange}
          onPatchResult={onPatchResult}
          underlay={
            <canvas ref={backgroundCanvasRef} className={styles.graphBackground} aria-hidden="true" />
          }
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
/*
 * Written as an ESCAPE, not as a raw NUL byte. The byte itself makes the whole FILE
 * read as binary to `grep`, `rg` and anything that sniffs content, so every repo-wide
 * search silently SKIPS this module — which is how someone concludes that
 * `NodePreviewSlot` or `renderPreview` has no caller when both are right here.
 */
const SEPARATOR = "\u0000";

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
