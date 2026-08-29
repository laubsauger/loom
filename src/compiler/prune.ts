import type { NodeId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import type { ActiveSink, CompileEdge } from "./types.ts";
import type { ResolvedNode } from "./validate.ts";

/**
 * Active-sink tracing and pruning (T26, §V25).
 *
 * The compiler evaluates only what is reachable backward from an active sink: the main
 * output, a visible or pinned preview, an inspector, a feedback pair that must keep
 * advancing, and readback/debug taps. Everything else is dead work in a loop that has to
 * hold 60 Hz, so it is not compiled at all.
 */

/**
 * A node that declares itself a sink is never pruned (§V25).
 *
 * Declared, never inferred. "Has no output ports" is a different claim — a side-effect node
 * (a readback tap, a recorder) can perfectly well have outputs, and a node with none may
 * still be dead weight. Only the manifest knows.
 */
export function isDeclaredSink(definition: NodeDefinition): boolean {
  return definition.sink === true;
}

export interface SinkResolution {
  /** Sinks that name a node the compiler can actually see, sorted for determinism. */
  readonly sinks: ReadonlyArray<ActiveSink>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

const sinkKeyOf = (sink: ActiveSink): string => `${sink.nodeId}:${sink.portId ?? ""}:${sink.kind}`;

/**
 * Combines the caller's sinks with the ones the document itself declares: manifest sinks
 * (never pruned) and nodes whose preview is switched on (§V28 — the caller decides which of
 * those are actually on screen and may pass a narrower list).
 */
export function resolveSinks(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  explicit: ReadonlyArray<ActiveSink> | undefined,
): SinkResolution {
  const diagnostics: RuntimeDiagnostic[] = [];
  const collected = new Map<string, ActiveSink>();

  const add = (sink: ActiveSink): void => {
    const key = sinkKeyOf(sink);
    if (!collected.has(key)) collected.set(key, sink);
  };

  for (const sink of explicit ?? []) {
    const resolved = nodes.get(sink.nodeId);
    if (resolved === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.sinkUnknown,
          `Active sink names node "${sink.nodeId}", which is not in the graph.`,
          { nodeId: sink.nodeId },
        ),
      );
      continue;
    }
    if (sink.portId !== undefined && !resolved.definition.outputs.some((port) => port.id === sink.portId)) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.sinkUnknown,
          `Active sink names output "${sink.portId}" on "${sink.nodeId}", which "${resolved.definition.type}" does not declare.`,
          { nodeId: sink.nodeId, portId: sink.portId },
        ),
      );
      continue;
    }
    add(sink);
  }

  for (const nodeId of [...nodes.keys()].sort()) {
    const resolved = nodes.get(nodeId);
    if (resolved === undefined) continue;
    if (isDeclaredSink(resolved.definition)) add({ nodeId, kind: "output" });
    if (resolved.node.ui?.preview === true) add({ nodeId, kind: "preview" });
  }

  const sinks = [...collected.values()].sort((a, b) => sinkKeyOf(a).localeCompare(sinkKeyOf(b)));
  if (sinks.length === 0) {
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.noActiveSinks,
        "No active sink: nothing is rendered.",
        { suggestion: "Connect an output node, or pin a preview (§V25)." },
      ),
    );
  }
  return { sinks, diagnostics };
}

export interface PruneResult {
  readonly kept: ReadonlySet<NodeId>;
  /** Nodes no sink reaches, sorted. */
  readonly pruned: ReadonlyArray<NodeId>;
}

/**
 * Walks backward from the sinks.
 *
 * Temporal edges are traversed too: the value they carry is a frame old, but somebody
 * still has to produce it, so the producer stays alive (§V22).
 */
export function pruneToActiveSinks(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  edges: ReadonlyArray<CompileEdge>,
  sinks: ReadonlyArray<ActiveSink>,
): PruneResult {
  const producers = new Map<NodeId, NodeId[]>();
  for (const edge of edges) {
    const list = producers.get(edge.target.nodeId);
    if (list === undefined) producers.set(edge.target.nodeId, [edge.source.nodeId]);
    else list.push(edge.source.nodeId);
  }

  const kept = new Set<NodeId>();
  const queue = [...new Set(sinks.map((sink) => sink.nodeId))].sort();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    if (kept.has(nodeId) || !nodes.has(nodeId)) continue;
    kept.add(nodeId);
    for (const upstream of [...(producers.get(nodeId) ?? [])].sort()) {
      if (!kept.has(upstream)) queue.push(upstream);
    }
  }

  const pruned = [...nodes.keys()].filter((nodeId) => !kept.has(nodeId)).sort();
  return { kept, pruned };
}
