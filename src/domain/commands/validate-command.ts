import { orderNodes, validateGraph, validateRequiredInputs } from "../../compiler/index.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeId } from "../types/ids.ts";
import type { ShaderloomBus } from "./bus.ts";

/**
 * `project.validate` (T174, §V39).
 *
 * The agent surface has named this command since it was written and reported itself
 * `unavailable` because nothing registered it. The reason given there was right for an
 * ADAPTER — reaching into `src/compiler` from a tool would be the app-logic duplication
 * §V39 forbids — and it is exactly why the command belongs HERE instead: one
 * implementation, on the bus, reachable by the keymap, the palette, a WebMCP call and an
 * out-of-process MCP server alike.
 *
 * ## Why this one is implementable and `project.compile` is not
 *
 * Validation needs the document and the node registry, and the bus has both. Compiling
 * additionally needs `ProjectSettings` (resolution, formats, limits) and a
 * `BackendCapabilities` report from a live device — neither of which the domain layer
 * has or should invent — plus the composition root's retained-plan and recompile
 * scheduling (§V9, §V31). A `project.compile` here would either fabricate settings and
 * capabilities or become a second compile path that drifts from the real one, so it is
 * reported as missing rather than stubbed.
 *
 * ## What it checks
 *
 * Definitions and parameters, port compatibility and arity (§V13, §V14), required inputs,
 * and illegal same-frame cycles (§V4) — the whole document, not the pruned subgraph, so a
 * miswired branch nothing renders is still reported. Resolution, format and capability
 * checks belong to compilation and are deliberately absent.
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    "project.validate": { input: Record<string, never>; output: ValidationReport };
  }
}

export interface ValidationReport {
  /** False when any diagnostic is an error. Warnings do not make a graph invalid. */
  ok: boolean;
  nodeCount: number;
  edgeCount: number;
  /** Nodes whose type the registry could not resolve — placeholders (§V10). */
  unresolvedNodeIds: NodeId[];
  /** Same-frame cycles, each sorted, groups sorted (§V4). */
  cycles: NodeId[][];
  diagnostics: RuntimeDiagnostic[];
}

export function registerValidateCommand(bus: ShaderloomBus): void {
  bus.registerCommand({
    name: "project.validate",
    description: "Validate the graph without compiling it: definitions, wiring and cycles.",
    handler: (_input, context) => {
      const graph = context.graph;
      const validated = validateGraph(graph, context.registry);
      const kept = new Set(validated.nodes.keys());
      const topology = orderNodes(kept, validated.edges);

      const diagnostics: RuntimeDiagnostic[] = [
        ...validated.diagnostics,
        ...validateRequiredInputs(validated.nodes, validated.edges, kept),
        ...topology.diagnostics,
      ];

      const report: ValidationReport = {
        ok: !diagnostics.some((entry) => entry.severity === "error"),
        nodeCount: Object.keys(graph.nodes).length,
        edgeCount: Object.keys(graph.edges).length,
        unresolvedNodeIds: Object.keys(graph.nodes)
          .filter((nodeId) => !kept.has(nodeId))
          .sort(),
        cycles: topology.cycles.map((cycle) => [...cycle]),
        diagnostics,
      };

      // "applied" means THE VALIDATION RAN, not that the graph is valid — the same
      // distinction a compiler makes between exiting successfully and finding no errors.
      // `ok` is the answer to the question; a status of "rejected" here would mean the
      // command itself could not run. Nothing is mutated, so dryRun changes nothing.
      return { status: "applied", revision: context.store.getRevision(), output: report };
    },
    rejectionOutput: (_input, diagnostics): ValidationReport => ({
      ok: false,
      nodeCount: 0,
      edgeCount: 0,
      unresolvedNodeIds: [],
      cycles: [],
      diagnostics,
    }),
  });
}
