import { nodeNames } from "../domain/graph/names.ts";
import { sourceReferenceTokens, sourceReferencesOf } from "../domain/graph/source-references.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphEdge } from "../domain/types/graph.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * Names → edges (T350, T447, §V372, §V373).
 *
 * Scene assembly and the feedback loop are stated by NAME: a Feedback names the node it
 * records, a Render names its camera and lights, a Geometry names its material. The ports
 * behind those names are declared as REAL, REQUIRED, connect-refused inputs, and this is
 * the step that fills them — synthesizing the exact edge the wired shape would have had,
 * so payload propagation, port typing, ordering, the temporal split and required-input
 * validation never learn that names exist. §V373 in one function.
 *
 * ## Why it is a module and not a block inside `compileGraph` (T595, B121's sibling)
 *
 * It used to be an inline IIFE in `compile.ts`, which meant the ONLY reader was the
 * compile path. `project.validate` — the bus command the agent surface and the palette
 * both call — ran `validateGraph` on the raw document, so it saw `feedback.in` as an
 * unfilled required port and reported
 *
 *   Input "in" on "fb1" (feedback) is required but nothing is connected to it.
 *
 * on a loop that compiles and runs. `connect_ports` refuses a wire into that port by
 * design, so the report named a defect no legal edit could clear: two halves of the
 * codebase disagreeing about whether the port is filled (§V109's shape). The answer was
 * already written down for the scene family — references ARE edges, resolved once,
 * before validation — so the fix is to make both halves run the one resolution rather
 * than to teach `validateRequiredInputs` about names, which would have been the second
 * mechanism §V373 exists to avoid.
 *
 * Pure: the document is never mutated, and a graph with no references is returned
 * UNCHANGED (same object), so a caller can compare identities to see whether anything
 * was synthesized.
 */
export interface SourceReferenceEdges {
  /** The document plus one synthesized edge per resolved name. */
  readonly graph: GraphDocument;
  /** Dangling names, ref-plus-wire ambiguities and type refusals (§V369). */
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export function synthesizeSourceReferenceEdges(
  graph: GraphDocument,
  registry: NodeRegistryView,
): SourceReferenceEdges {
  const diagnostics: RuntimeDiagnostic[] = [];
  let synthesized: Record<string, GraphEdge> | undefined;
  const names = nodeNames(graph);
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    for (const spec of sourceReferencesOf(node.type)) {
      const tokens = sourceReferenceTokens(spec, node.parameters);
      const wired = Object.values(graph.edges).find(
        (edge) => edge.target.nodeId === nodeId && edge.target.portId === spec.input,
      );
      if (tokens.length === 0) continue; // unwired AND unnamed = the ordinary missing-input story
      if (wired !== undefined) {
        diagnostics.push(
          compilerDiagnostic(
            "error",
            CompilerDiagnosticCode.sourceReferenceAmbiguous,
            `Node "${nodeId}" (${node.type}) names ${spec.parameter} "${tokens.join(" ")}" AND has "${spec.input}" wired; one link, one truth.`,
            { nodeId, suggestion: `Clear the ${spec.parameter} parameter, or disconnect the wire.` },
          ),
        );
        continue;
      }
      tokens.forEach((name, index) => {
        const sourceId = names.get(name);
        if (sourceId === undefined) {
          // §V369: a dangling name is an ERROR that names the name — never a quietly
          // smaller scene. An empty render because every name dangled is the failure
          // this refusal exists to make impossible.
          diagnostics.push(
            compilerDiagnostic(
              "error",
              CompilerDiagnosticCode.sourceReferenceMissing,
              `Node "${nodeId}" (${node.type}) names ${spec.parameter} "${name}", which no node in the document is called.`,
              { nodeId, suggestion: "Name an existing node, or rename the intended one to match." },
            ),
          );
          return;
        }
        const sourceNode = graph.nodes[sourceId];
        const sourceDefinition = sourceNode === undefined ? undefined : registry.get(sourceNode.type);
        const sourcePort = sourceDefinition?.outputs[0]?.id;
        if (sourcePort === undefined) {
          diagnostics.push(
            compilerDiagnostic(
              "error",
              CompilerDiagnosticCode.sourceReferenceMissing,
              `Node "${nodeId}" (${node.type}) names ${spec.parameter} "${name}", which has no output to reference.`,
              { nodeId },
            ),
          );
          return;
        }
        const consumerDefinition = registry.get(node.type);
        const targetKind = consumerDefinition?.inputs.find((port) => port.id === spec.input)?.type.kind;
        const sourceKind = sourceDefinition?.outputs[0]?.type.kind;
        if (targetKind !== undefined && sourceKind !== undefined && targetKind !== sourceKind) {
          // T447: the type check references gave up returns as a NAMED refusal — the
          // parameter, the name, and what the named node actually is.
          diagnostics.push(
            compilerDiagnostic(
              "error",
              CompilerDiagnosticCode.sourceReferenceMissing,
              `Node "${nodeId}" (${node.type}) names ${spec.parameter} "${name}", but "${name}" is a ${sourceNode?.type ?? "node"} and publishes no ${targetKind}.`,
              { nodeId, suggestion: `Name a node whose output is a ${targetKind}.` },
            ),
          );
          return;
        }
        // T447: one synthesized edge per token; `order` is the token's LIST position,
        // so draw/light order is the user's stated order through the ordinary §V131
        // comparator — never edge-id accident.
        const edgeId = spec.list === true ? `ref:${nodeId}:${spec.parameter}:${index}` : `ref:${nodeId}`;
        synthesized ??= { ...graph.edges };
        synthesized[edgeId] = {
          id: edgeId,
          source: { nodeId: sourceId, portId: sourcePort },
          target: { nodeId, portId: spec.input },
          ...(spec.list === true ? { order: index } : {}),
        };
      });
    }
  }
  return {
    graph: synthesized === undefined ? graph : { ...graph, edges: synthesized },
    diagnostics,
  };
}
