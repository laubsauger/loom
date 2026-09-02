import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { CommandResult } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { GraphStoreView } from "@domain/graph/store.ts";
import type { EdgeGeometryStore } from "@editor/edges/edge-geometry.ts";
import type { RenameSessionStore } from "@editor/nodes/rename-session.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { ComponentRegistryView } from "@domain/components/index.ts";
import type { NodeRuntimeSnapshot, NodeRuntimeSource } from "./node-runtime.ts";

/**
 * What a node or an edge component needs, handed down once by the canvas instead of
 * threaded through React Flow's `data` on every projection.
 *
 * Keeping the read-only store here (rather than copying node state into `data`) is what
 * makes §V1 and §V16 hold at the same time: React Flow's arrays carry identity and
 * geometry only, each node subscribes to its own document slice, and per-frame metrics
 * arrive on a separate channel that the document never sees.
 */
/** The three per-node flags a TD-style badge toggles, each its own bus command. */
export type NodeToggleCommand = "node.toggleBypass" | "node.toggleDisplay" | "node.toggleRender";

export interface GraphCanvasContextValue {
  /** Read-only document projection. Mutation goes through `dispatch` (§V1, §V29). */
  store: GraphStoreView;
  registry: NodeRegistryView;
  runtime: NodeRuntimeSource;
  /**
   * Where each edge tells the canvas where it is (§V14b, §V14c).
   *
   * Written by `SignalEdge` on every render, read only when a drop lands — so an edge is
   * a target because it is DRAWN, not because something re-derived its geometry. Not
   * React state, deliberately: it changes at pointer rate during a node drag and nothing
   * renders from it (§V16).
   */
  edgeGeometry: EdgeGeometryStore;
  /** Every semantic edit the view makes, as one atomic patch on the bus (§V29, §V32). */
  dispatch: GraphDispatch;
  /** Current canvas selection (§V101): a per-node toggle acts on it when the node is in it. */
  selection: readonly NodeId[];
  /**
   * Runs a selection-scoped node toggle through the bus command the keymap and the
   * context menu already use, never a raw patch (§V101, §V102, §V29, §V52) — so the
   * badge, the hotkey and the menu item are one implementation, not three.
   */
  toggleUi: (command: NodeToggleCommand, nodeIds: readonly NodeId[]) => void;
  /**
   * Which node's title is currently an input box (T415). Not document state — it produces
   * no patch and reaches no file — so it rides the context beside `selection` rather than
   * the store (§V16).
   */
  renameSession: RenameSessionStore;
  /**
   * Opens the inline editor by running `ui.beginRename` — the same command `n` and the
   * context menu's "Rename…" name. Exactly why `toggleUi` exists beside it: a double-click
   * on the title, the hotkey and the menu row are one implementation, not three (§V78).
   */
  beginRename: (nodeId: NodeId) => void;
  /**
   * Commits an inline rename through the SAME `node.rename` command the bus, the menu and
   * an agent use (§V29, §V61). The node header supplies the argument nothing supplied
   * before (B60); it does not own a second rename, so §V128's reference rewrite and the
   * §V325 collision refusal happen in the one place they already happen.
   */
  renameNode: (nodeId: NodeId, label: string) => Promise<CommandResult<"node.rename">>;
  /**
   * T599: brings the problems pane to the front — the node's "+N more" chip, when a
   * node carries more diagnostics than its one message line can show.
   */
  showProblems: () => void;
  /**
   * T602: enter a component instance — double-click's door onto the SAME
   * `graph.diveIn` the keymap and the context menu run (§V78, never a second
   * implementation).
   */
  diveIn: (nodeId: NodeId) => void;
  /** T603: catalogue view for instance marks (version, upgrade). Absent in bare fixtures. */
  components?: ComponentRegistryView | undefined;
  /** Preview slot. Track J (T34) fills it; until then the region stays empty. */
  renderPreview?: ((nodeId: NodeId) => ReactNode) | undefined;
  /**
   * Inline control slot — doc §17.2 wants the few important parameters on the node
   * itself, with the full set in the inspector. The control kit is track G (T37), so
   * this is where it plugs in without either track editing the other's files.
   */
  renderControls?: ((nodeId: NodeId) => ReactNode) | undefined;
  /**
   * T892 — THERE IS NO `previewInspect` SEAM ANY MORE, and its removal is the point.
   *
   * The camera toggle used to be handed down here so the node HEADER could draw it, which
   * T675 chose because the shared preview surface (`panes.module.css .previewSurface`) is
   * a full-pane canvas at `--z-canvas-overlay` (30) while everything inside a node is
   * trapped in `.react-flow__viewport`'s stacking context at z-index 2 — the composited
   * tile paints over any chrome inside the slot, and no z-index reachable from in here can
   * beat it.
   *
   * That stacking fact is unchanged and still governs everything this file hands to a
   * node. What changed is the conclusion: the owner asked three times for the control to
   * be ON the picture, and the reason is the node TITLE — a conditional fourth button in
   * the `P B M` row made the header's width depend on whether a node had a camera, and
   * squeezed the name to `ha…`. So the control is no longer node chrome at all. It is
   * drawn by a PANE-level layer that is a sibling of the compositing surface
   * (`editor/viewer/preview-inspect-overlay.tsx`), which is the only place a control on a
   * live tile can live.
   *
   * The rule this file still enforces, for whoever adds the next piece of preview chrome:
   * CHROME THAT MUST BE LEGIBLE OVER A LIVE TILE CANNOT BE RENDERED BY A NODE. Either the
   * node header (`previewLens` below) or that pane-level layer — never the slot.
   */
  /**
   * T685 — the preview LENS marker, moved out of the tile for §V633's reason.
   *
   * It is §V70a's warning: a preview being shown through a lens is NOT the node's real
   * output, and a display transform that outlives the inspection hides which node is
   * wrong. It was drawn in the tile's bottom-right corner, which means it was occluded by
   * the composited tile — invisible EXACTLY when the preview is live, which is the one
   * case it exists to warn about. Strictly worse than the toggle's version of the same
   * bug: a control you cannot find is a nuisance, a warning you cannot see is a wrong
   * answer nobody is told about.
   *
   * A SOURCE, not a rendered node: the marker has to change when the lens does, and the
   * store is the only thing that can say so. Typed structurally rather than by importing
   * the lens store — `@editor/viewer` imports this package, so naming its type here would
   * close a cycle.
   */
  previewLens?: ((nodeId: NodeId) => PreviewLensSource | null) | undefined;
}

/** T685: the marker text for this node's lens, and a subscription to changes in it. */
export interface PreviewLensSource {
  /** Null while the picture is unaltered — the quiet case stays quiet (§V90). */
  marker(nodeId: NodeId): string | null;
  subscribe(nodeId: NodeId, listener: () => void): () => void;
}

export type GraphDispatch = (operations: GraphPatchOperation[], label: string) => void;

export const GraphCanvasContext = createContext<GraphCanvasContextValue | null>(null);

export function useGraphCanvas(): GraphCanvasContextValue {
  const value = useContext(GraphCanvasContext);
  if (value === null) {
    throw new Error("Graph canvas components must be rendered inside <GraphCanvas>.");
  }
  return value;
}

/**
 * Subscribe one component to one node's runtime slice (§V16). Nothing else re-renders
 * when a metric ticks, and the store coalesces those ticks to <= 10 Hz.
 */
export function useNodeRuntime(source: NodeRuntimeSource, nodeId: NodeId): NodeRuntimeSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(nodeId, listener),
    [source, nodeId],
  );
  const snapshot = useCallback(() => source.get(nodeId), [source, nodeId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
