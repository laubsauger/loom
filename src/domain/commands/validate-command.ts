import {
  orderNodes,
  synthesizeSourceReferenceEdges,
  validateGraph,
  validateRequiredInputs,
} from "../../compiler/index.ts";
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
 *
 * ## It reads the document the COMPILER reads, not a plainer one (T593, T595)
 *
 * "Validate without compiling" is about skipping the PLAN, not about seeing a different
 * graph. Two steps the compile path takes before `validateGraph` were missing here, and
 * each produced a report that could not be acted on:
 *
 *  - SOURCE REFERENCES were unresolved, so a port filled by name (§V372/§V373) read as an
 *    empty required input — and the editor refuses to wire it, so the complaint was
 *    unsatisfiable by construction (T595);
 *  - the CHANNEL RESOLVER was absent, so every `driven` parameter in every document in
 *    every tab came back "not attached" while the same channel was driving the plan
 *    (T593/B121 — B8's class, third instance).
 *
 * Both are now taken from the one place that owns them: the compiler's own name
 * resolution, and the app's own resolver by way of `CommandContext.channels`.
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
      /**
       * T595 (§V109, §V373): the SAME name→edge resolution the compiler runs, before
       * validation, not a second opinion about it.
       *
       * `feedback.in`, a Render's `camera`, a Geometry's `material` are declared as real
       * REQUIRED ports and filled BY NAME (§V372/§V373). `connect_ports` refuses a wire
       * into them; the compiler synthesizes the exact edge the wired shape had and then
       * validates. This command skipped that step, so it read the document one port short
       * and reported an input that is required, correctly filled, and impossible to
       * satisfy — the validator could not be made green by any legal edit. One resolution
       * mechanism, not two: `synthesizeSourceReferenceEdges` is the compiler's own.
       */
      const referenced = synthesizeSourceReferenceEdges(context.graph, context.registry);
      const graph = referenced.graph;
      /**
       * T593/B121 — the resolver the APP is compiling through, handed down the bus.
       *
       * Not `graphChannelResolver(graph, registry)` built here: that is the second
       * resolver B8 forbids, and it would answer for the LFO/Constant/Timer trio only, so
       * a document driving a parameter through the value graph or an Analyze would
       * validate against numbers the plan never used. Undefined when no app is attached,
       * and `resolveParameters` says THAT rather than "the channel is not attached"
       * (§V338).
       */
      const validated = validateGraph(graph, context.registry, {
        ...(context.channels === undefined ? {} : { channels: context.channels }),
      });
      const kept = new Set(validated.nodes.keys());
      const topology = orderNodes(kept, validated.edges);

      const diagnostics: RuntimeDiagnostic[] = [
        // A dangling name and a name-plus-wire ambiguity are refusals the compiler makes
        // (§V369); dropping them here would trade one unsatisfiable report for a silent one.
        ...referenced.diagnostics,
        ...validated.diagnostics,
        ...validateRequiredInputs(validated.nodes, validated.edges, kept),
        ...topology.diagnostics,
      ];

      const report: ValidationReport = {
        ok: !diagnostics.some((entry) => entry.severity === "error"),
        // The DOCUMENT's counts. Synthesized edges are plumbing (§V373) and counting them
        // would report more edges than the file has or an agent can address.
        nodeCount: Object.keys(context.graph.nodes).length,
        edgeCount: Object.keys(context.graph.edges).length,
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
