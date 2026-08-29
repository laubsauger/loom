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
 * Combines the caller's sinks with the ones the document itself declares.
 *
 * Manifest sinks are ALWAYS added — a declared sink is never pruned (§V25). The
 * document's `ui.preview` flags become preview sinks only when the caller passed no
 * explicit list: an explicit list is the caller saying which previews are actually on
 * screen (§V28), and unioning the document's flags back in would defeat exactly that
 * narrowing (T159).
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

  // T159: the caller is authoritative about PREVIEW sinks. Only it knows which preview
  // toggles are actually on screen (§V28 — the compiler has no DOM), so the document's
  // `ui.preview` flags act as sinks only when NO explicit list was passed at all — the
  // safe default for tests, validation and agent compiles. Manifest sinks are different:
  // a declared sink is never pruned regardless of who is calling.
  const callerProvided = explicit !== undefined;
  for (const nodeId of [...nodes.keys()].sort()) {
    const resolved = nodes.get(nodeId);
    if (resolved === undefined) continue;
    if (isDeclaredSink(resolved.definition)) add({ nodeId, kind: "output" });
    if (!callerProvided && resolved.node.ui?.preview === true) add({ nodeId, kind: "preview" });
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

  // T268 (§V173): `pruned` means DEAD — could have contributed GPU work and was
  // excluded. A value source (T238-T240) is non-plan-resident BY DESIGN: it has no
  // ports, resolves off the document through the channel seam, and was never a
  // candidate — reporting it pruned would misdirect exactly the person debugging why
  // "nothing moves". It is simply not in the list, kept or pruned.
  const pruned = [...nodes.keys()]
    .filter((nodeId) => !kept.has(nodeId) && nodes.get(nodeId)?.definition.valueChannel === undefined)
    .sort();
  return { kept, pruned };
}
