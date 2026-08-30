import type { ReactNode } from "react";
import { Position, ReactFlowProvider } from "@xyflow/react";
import type { EdgeProps, NodeProps } from "@xyflow/react";
import { createEdgeGeometry } from "@editor/edges/edge-geometry.ts";
import { createRenameSessionStore } from "@editor/nodes/rename-session.ts";
import type { CommandResult } from "@domain/types/commands.ts";
import { GraphCanvasContext } from "./canvas-context.ts";
import type { GraphCanvasContextValue, GraphDispatch } from "./canvas-context.ts";
import { LOOM_NODE_TYPE, SIGNAL_EDGE_TYPE } from "./derive.ts";
import type { LoomEdge, LoomNode, SignalEdgeData } from "./derive.ts";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import type { NodeRuntimeStore } from "./node-runtime.ts";

/**
 * Test scaffolding for the graph view. Not shipped — mirrors `src/ui/testing/`.
 *
 * Node and edge components need React Flow's store context (handles read it) and the
 * canvas context (document store, registry, runtime channel), but not a mounted
 * `<ReactFlow>`. Rendering them directly is what makes the visual invariants — V26's
 * hue, V19's static edge, V20's control drag — testable without a laid-out canvas.
 */

type Mutable = Record<string, unknown>;

/**
 * jsdom never fires a ResizeObserver, and React Flow will not lay out an edge until it
 * has measured both endpoint nodes. This observer reports every observed element once,
 * on the next macrotask, which is enough for React Flow to measure nodes and handles
 * and therefore to render edges at all.
 */
interface StubResizeEntry {
  target: Element;
  contentRect: DOMRect;
}

class FiringResizeObserver {
  callback: (entries: StubResizeEntry[]) => void;
  targets = new Set<Element>();
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(callback: (entries: StubResizeEntry[]) => void) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.targets.add(target);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.targets.size === 0) return;
      this.callback(
        [...this.targets].map((element) => ({
          target: element,
          contentRect: element.getBoundingClientRect(),
        })),
      );
    }, 0);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** jsdom gaps React Flow's viewport code trips over. */
export function installFlowStubs(): void {
  const globals = globalThis as unknown as Mutable;

  // Deliberately unconditional: the shared UI stub installs an inert observer, and an
  // observer that never fires leaves every node unmeasured and every edge unrendered.
  globals["ResizeObserver"] = FiringResizeObserver;

  if (typeof globals["DOMMatrixReadOnly"] === "undefined") {
    class DOMMatrixReadOnlyStub {
      m22 = 1;
      constructor(transform?: string) {
        const match = transform?.match(/matrix\(([^)]+)\)/);
        const parts = match?.[1]?.split(",").map((part) => Number.parseFloat(part.trim()));
        this.m22 = parts?.[3] ?? 1;
      }
    }
    globals["DOMMatrixReadOnly"] = DOMMatrixReadOnlyStub;
  }

  // React Flow measures a node with offsetWidth/offsetHeight, which jsdom reports as 0.
  // A node with no size is never "initialized", and an edge between uninitialized nodes
  // is not rendered at all — so without this there is nothing to assert about edges.
  if (typeof HTMLElement !== "undefined") {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 178,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 120,
    });
  }

  if (typeof SVGElement !== "undefined") {
    const proto = SVGElement.prototype as unknown as Mutable;
    proto["getBBox"] ??= () => ({ x: 0, y: 0, width: 0, height: 0 });
  }

  if (typeof document !== "undefined") {
    const doc = document as unknown as Mutable;
    doc["elementFromPoint"] ??= () => null;
  }
}

/**
 * Force `prefers-reduced-motion` on or off for a test. jsdom has no media engine, so
 * V19's behaviour is otherwise untestable.
 */
export function setReducedMotion(reduce: boolean): void {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  (window as unknown as Mutable)["matchMedia"] = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * What `fixtureContext` answers a rename with when the test wired none. A refusal rather
 * than a silent success: a fixture that pretends to rename lets a test assert a commit
 * path nothing actually performed, which is the shape of §V220 this whole file exists in
 * the neighbourhood of.
 */
const FIXTURE_RENAME_REFUSAL: CommandResult<"node.rename"> = {
  status: "rejected",
  revision: 0,
  diagnostics: [
    {
      severity: "error",
      code: "fixture.noRename",
      message: "fixture: no renameNode wired",
    },
  ],
  output: {
    status: "rejected",
    revision: 0,
    appliedOperations: 0,
    diagnostics: [],
    createdIds: {},
  },
};

export interface CanvasFixtureProps {
  value: GraphCanvasContextValue;
  children: ReactNode;
}

export function CanvasFixture({ value, children }: CanvasFixtureProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasContext.Provider value={value}>{children}</GraphCanvasContext.Provider>
    </ReactFlowProvider>
  );
}

export interface FixtureContextOptions {
  store: GraphCanvasContextValue["store"];
  registry: GraphCanvasContextValue["registry"];
  runtime?: NodeRuntimeStore;
  edgeGeometry?: GraphCanvasContextValue["edgeGeometry"];
  dispatch?: GraphDispatch;
  selection?: GraphCanvasContextValue["selection"];
  toggleUi?: GraphCanvasContextValue["toggleUi"];
  renameSession?: GraphCanvasContextValue["renameSession"];
  beginRename?: GraphCanvasContextValue["beginRename"];
  renameNode?: GraphCanvasContextValue["renameNode"];
  renderPreview?: GraphCanvasContextValue["renderPreview"];
  renderControls?: GraphCanvasContextValue["renderControls"];
}

export function fixtureContext(options: FixtureContextOptions): {
  value: GraphCanvasContextValue;
  runtime: NodeRuntimeStore;
} {
  // Zero interval: tests drive time themselves rather than waiting on the 10 Hz tick.
  const runtime = options.runtime ?? createNodeRuntimeStore({ intervalMs: 0 });
  return {
    runtime,
    value: {
      store: options.store,
      registry: options.registry,
      runtime,
      edgeGeometry: options.edgeGeometry ?? createEdgeGeometry(),
      dispatch: options.dispatch ?? (() => {}),
      selection: options.selection ?? [],
      toggleUi: options.toggleUi ?? (() => {}),
      renameSession: options.renameSession ?? createRenameSessionStore(),
      beginRename: options.beginRename ?? (() => {}),
      // Deliberately a REFUSAL rather than a no-op: a fixture that silently "succeeds" at
      // renaming would let a test assert a commit path nothing performed (§V220).
      renameNode: options.renameNode ?? (() => Promise.resolve(FIXTURE_RENAME_REFUSAL)),
      renderPreview: options.renderPreview,
      renderControls: options.renderControls,
    },
  };
}

export function nodeProps(id: string, overrides: Partial<NodeProps<LoomNode>> = {}) {
  const base: NodeProps<LoomNode> = {
    id,
    data: { nodeId: id },
    type: LOOM_NODE_TYPE,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected: false,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  return { ...base, ...overrides };
}

export function edgeProps(id: string, data: SignalEdgeData, overrides: Partial<EdgeProps<LoomEdge>> = {}) {
  const base: EdgeProps<LoomEdge> = {
    id,
    type: SIGNAL_EDGE_TYPE,
    source: data.sourceNodeId,
    target: "target-node",
    data,
    selected: false,
    sourceX: 0,
    sourceY: 0,
    targetX: 120,
    targetY: 60,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };
  return { ...base, ...overrides };
}
