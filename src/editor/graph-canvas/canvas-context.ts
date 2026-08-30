import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { GraphStoreView } from "@domain/graph/store.ts";
import type { EdgeGeometryStore } from "@editor/edges/edge-geometry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
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
  /** Preview slot. Track J (T34) fills it; until then the region stays empty. */
  renderPreview?: ((nodeId: NodeId) => ReactNode) | undefined;
  /**
   * Inline control slot — doc §17.2 wants the few important parameters on the node
   * itself, with the full set in the inspector. The control kit is track G (T37), so
   * this is where it plugs in without either track editing the other's files.
   */
  renderControls?: ((nodeId: NodeId) => ReactNode) | undefined;
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
