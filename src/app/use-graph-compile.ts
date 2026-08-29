import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { compileGraph } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { telemetryPlan } from "@runtime/telemetry/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRunStatus, NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * Compiles the document and routes the result to the two places that need it: the
 * problems tab (whole-graph diagnostics) and each node's badge (§V27).
 *
 * The compiler is pure and cheap, so it runs on every revision. Its diagnostics reach a
 * node through the runtime channel, NOT through the document — per-node status is
 * derived state and must not enter the store or re-render the tree (§V16). Each node
 * component subscribes to its own id, so a diagnostic on one node repaints one node.
 *
 * With no capability report there is no compile: the format rules are validated against
 * the device (§V51), and inventing a device to validate against is exactly what §V12
 * forbids. That state reports itself instead of guessing.
 */

export interface GraphCompileResult {
  readonly graph: GraphDocument;
  /** Null while the capability report is missing — see §V12 note above. */
  readonly compiled: CompiledGraph | null;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly errorCount: number;
}

function statusFor(errors: number, warnings: number, compiled: boolean): NodeRunStatus {
  if (errors > 0) return "error";
  if (warnings > 0) return "warning";
  return compiled ? "valid" : "idle";
}

function compileSafely(
  graph: GraphDocument,
  runtime: AppRuntime,
  capabilities: BackendCapabilities,
): { compiled: CompiledGraph | null; diagnostics: RuntimeDiagnostic[] } {
  try {
    const compiled = compileGraph({
      graph,
      settings: runtime.settings,
      registry: runtime.registry,
      capabilities,
      // §V28a: NO `sinks` key, deliberately. An explicit list is AUTHORITATIVE — an
      // empty one means "no previews are visible", not "fall back to the document's
      // `ui.preview` flags" — and this root cannot yet tell which previews are on
      // screen, because visibility lives with the preview surface (T34/T161, still in
      // flight). Passing a partial list would silently schedule the wrong set; omitting
      // the key is the documented "use the flags" case. When visibility is derivable
      // here, pass EVERY visible preview and never the union of the two rules.
    });
    return { compiled, diagnostics: [...compiled.diagnostics] };
  } catch (error) {
    // A compiler crash is a bug, but it is not a reason to unmount the editor: report
    // it where every other problem is reported and keep the document editable.
    return {
      compiled: null,
      diagnostics: [
        {
          severity: "error",
          code: "compiler.crashed",
          message: `The compiler threw: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/** Publishes per-node diagnostic counts onto the runtime channel (§V16, §V27). */
function publishNodeStatus(
  store: NodeRuntimeStore,
  graph: GraphDocument,
  diagnostics: readonly RuntimeDiagnostic[],
  compiled: boolean,
  previous: Set<NodeId>,
): Set<NodeId> {
  const byNode = new Map<NodeId, { errors: number; warnings: number; message: string | null }>();
  for (const nodeId of Object.keys(graph.nodes)) {
    byNode.set(nodeId, { errors: 0, warnings: 0, message: null });
  }
  for (const diagnostic of diagnostics) {
    const nodeId = diagnostic.nodeId;
    if (nodeId === undefined) continue;
    const entry = byNode.get(nodeId);
    if (entry === undefined) continue;
    if (diagnostic.severity === "error") entry.errors += 1;
    else if (diagnostic.severity === "warning") entry.warnings += 1;
    else continue;
    // Highest severity wins the one line the node badge can show.
    if (entry.message === null || diagnostic.severity === "error") entry.message = diagnostic.message;
  }

  for (const [nodeId, entry] of byNode) {
    store.publish(nodeId, {
      status: statusFor(entry.errors, entry.warnings, compiled),
      errorCount: entry.errors,
      warningCount: entry.warnings,
      message: entry.message,
    });
  }
  for (const nodeId of previous) {
    if (!byNode.has(nodeId)) store.clear(nodeId);
  }
  return new Set(byNode.keys());
}

export function useGraphCompile(
  runtime: AppRuntime,
  capabilities: BackendCapabilities | null,
): GraphCompileResult {
  const graph = useSyncExternalStore<GraphDocument>(
    runtime.bus.store.subscribe,
    runtime.bus.store.getGraph,
    runtime.bus.store.getGraph,
  );

  const result = useMemo<GraphCompileResult>(() => {
    if (capabilities === null) {
      return { graph, compiled: null, diagnostics: [], errorCount: 0 };
    }
    const { compiled, diagnostics } = compileSafely(graph, runtime, capabilities);
    return {
      graph,
      compiled,
      diagnostics,
      errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    };
  }, [graph, runtime, capabilities]);

  // The static half of the performance tab and of every node info popup (T41, §V85).
  // Once per compile, never per frame: the plan does not change between frames, and
  // pushing it at frame rate is exactly the §V16 mistake the hub exists to prevent.
  useEffect(() => {
    runtime.telemetry.setPlan(
      result.compiled === null
        ? null
        : telemetryPlan(result.compiled, {
            memoryBudgetBytes: runtime.settings.limits.memoryBudgetBytes,
          }),
    );
  }, [result.compiled, runtime]);

  const publishedRef = useRef<Set<NodeId>>(new Set());
  useEffect(() => {
    publishedRef.current = publishNodeStatus(
      runtime.nodeRuntime,
      result.graph,
      result.diagnostics,
      result.compiled !== null,
      publishedRef.current,
    );
  }, [runtime.nodeRuntime, result]);

  return result;
}
