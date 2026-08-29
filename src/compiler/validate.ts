import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { ParameterDefinition, ParameterSchema, ParameterValue } from "../domain/types/parameters.ts";
import type { PortDefinition } from "../domain/types/ports.ts";
import { arePortsCompatible, describePortType } from "../domain/graph/port-compat.ts";
import { validateParameterValue } from "../domain/parameters/validate.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import type { CompileEdge } from "./types.ts";

/**
 * Definition resolution, parameter validation and connection validation (T24, §V13, §V14).
 *
 * Everything here is a rejection with a diagnostic, never a throw: a project with one bad
 * edge still compiles the rest of itself, and the user gets told exactly which edge.
 */

export interface ResolvedNode {
  readonly node: GraphNode;
  readonly definition: NodeDefinition;
  /** Declared parameters with defaults filled in; invalid values fall back to the default. */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
}

export interface ValidatedGraph {
  /** Nodes whose type resolved, keyed by id. Insertion order is sorted by id. */
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  /** Edges that passed endpoint, type (§V13) and arity (§V14) validation, sorted by edge id. */
  readonly edges: ReadonlyArray<CompileEdge>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

function defaultParameterValue(definition: ParameterDefinition): ParameterValue {
  // An asset parameter has no inline default — an unset asset is genuinely absent.
  return definition.type === "asset" ? null : definition.default;
}

function findPort(ports: ReadonlyArray<PortDefinition>, portId: PortId): PortDefinition | undefined {
  return ports.find((port) => port.id === portId);
}

/** True when the definition declares this output as carrying previous-frame data (§V4). */
export function isTemporalOutput(definition: NodeDefinition, portId: PortId): boolean {
  return definition.temporal?.outputs.includes(portId) === true;
}

/**
 * Effective values for one node's declared parameters: defaults filled in, stored values
 * validated against the schema, an invalid value replaced by the default and reported.
 *
 * Takes a bare schema rather than a `NodeDefinition` because a component instance's
 * parameter page is the component's PUBLISHED definitions, which exist before any node
 * manifest does (§V80) — and one resolver is the point. `typeLabel` is only for the
 * "carries a parameter this type does not declare" message.
 */
export function resolveParameterValues(
  node: GraphNode,
  parameters: ParameterSchema,
  typeLabel: string,
  diagnostics: RuntimeDiagnostic[],
): Record<string, ParameterValue> {
  const resolved: Record<string, ParameterValue> = {};

  for (const key of Object.keys(parameters).sort()) {
    const schema = parameters[key];
    if (schema === undefined) continue;
    const raw = node.parameters[key];
    if (raw === undefined) {
      resolved[key] = defaultParameterValue(schema);
      continue;
    }
    // The domain validator owns the rules; re-implementing them here would let the
    // compiler and the command bus disagree about what a legal value is.
    const failure = validateParameterValue(key, schema, raw, node.id);
    if (failure !== null) {
      diagnostics.push(failure);
      resolved[key] = defaultParameterValue(schema);
      continue;
    }
    resolved[key] = raw;
  }

  for (const key of Object.keys(node.parameters).sort()) {
    if (key in parameters) continue;
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.parameterUnknown,
        `Node "${node.id}" carries parameter "${key}", which "${typeLabel}" does not declare.`,
        { nodeId: node.id, suggestion: "The value is ignored; remove it or update the node definition." },
      ),
    );
  }

  return resolved;
}

/**
 * Resolves definitions and validates every node and edge in the document.
 *
 * Runs over the WHOLE document rather than the pruned subgraph: a miswired branch that
 * nothing renders is still a mistake worth surfacing in the problems tab.
 */
export function validateGraph(graph: GraphDocument, registry: NodeRegistryView): ValidatedGraph {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodes = new Map<NodeId, ResolvedNode>();

  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const definition = registry.get(node.type);
    if (definition === undefined) {
      // §V10: an unknown type is preserved in the document as a placeholder, so this is a
      // report about this compilation, not a reason to drop the node from the project.
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.unknownNodeType,
          `Node "${nodeId}" has unknown type "${node.type}".`,
          { nodeId, suggestion: "Install the node package that provides this type, or delete the node." },
        ),
      );
      continue;
    }
    if (node.definitionVersion !== definition.version) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.definitionVersion,
          `Node "${nodeId}" was saved against "${node.type}" v${node.definitionVersion}; the registry has v${definition.version}.`,
          { nodeId, suggestion: "Run the node's migration before relying on this compilation." },
        ),
      );
    }
    nodes.set(nodeId, {
      node,
      definition,
      parameters: resolveParameterValues(node, definition.parameters, definition.type, diagnostics),
    });
  }

  const edges: CompileEdge[] = [];
  /** target node/port -> edges already accepted there, for the §V14 arity check. */
  const occupancy = new Map<string, number>();

  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId];
    if (edge === undefined) continue;

    const source = nodes.get(edge.source.nodeId);
    const target = nodes.get(edge.target.nodeId);
    if (source === undefined || target === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.edgeEndpointMissing,
          `Edge "${edgeId}" connects "${edge.source.nodeId}" to "${edge.target.nodeId}"; at least one of them is missing or unknown.`,
        ),
      );
      continue;
    }

    const sourcePort = findPort(source.definition.outputs, edge.source.portId);
    if (sourcePort === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portMissing,
          `"${source.definition.type}" has no output port "${edge.source.portId}".`,
          { nodeId: source.node.id, portId: edge.source.portId },
        ),
      );
      continue;
    }
    const targetPort = findPort(target.definition.inputs, edge.target.portId);
    if (targetPort === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portMissing,
          `"${target.definition.type}" has no input port "${edge.target.portId}".`,
          { nodeId: target.node.id, portId: edge.target.portId },
        ),
      );
      continue;
    }

    // §V13: exact type match. A near miss is a missing conversion node, not a cast.
    if (!arePortsCompatible(sourcePort.type, targetPort.type)) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portIncompatible,
          `Edge "${edgeId}" connects ${describePortType(sourcePort.type)} to ${describePortType(targetPort.type)}.`,
          {
            nodeId: target.node.id,
            portId: targetPort.id,
            suggestion: "Insert an explicit conversion node; there is no implicit conversion (§V13).",
          },
        ),
      );
      continue;
    }

    // §V14: one incoming edge per input unless the port declares itself variadic.
    const slot = `${target.node.id}:${targetPort.id}`;
    const used = occupancy.get(slot) ?? 0;
    if (targetPort.variadic !== true && used > 0) {
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.portOccupied,
          `Input "${targetPort.id}" on "${target.node.id}" already has an incoming edge; "${edgeId}" is ignored.`,
          {
            nodeId: target.node.id,
            portId: targetPort.id,
            suggestion: "Disconnect the existing edge, or declare the port variadic.",
          },
        ),
      );
      continue;
    }
    occupancy.set(slot, used + 1);

    edges.push({
      id: edgeId,
      source: { nodeId: edge.source.nodeId, portId: edge.source.portId },
      target: { nodeId: edge.target.nodeId, portId: edge.target.portId },
      temporal: isTemporalOutput(source.definition, edge.source.portId),
    });
  }

  return { nodes, edges, diagnostics };
}

/**
 * §V14 completeness, checked only for nodes that actually run: a required input with no
 * incoming edge cannot be rendered, and saying so late (at encode time) would be a blank
 * frame with no explanation.
 */
export function validateRequiredInputs(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  edges: ReadonlyArray<CompileEdge>,
  kept: ReadonlySet<NodeId>,
): RuntimeDiagnostic[] {
  const connected = new Set<string>();
  for (const edge of edges) connected.add(`${edge.target.nodeId}:${edge.target.portId}`);

  const diagnostics: RuntimeDiagnostic[] = [];
  for (const nodeId of [...kept].sort()) {
    const resolved = nodes.get(nodeId);
    if (resolved === undefined) continue;
    for (const port of resolved.definition.inputs) {
      if (port.optional === true) continue;
      if (connected.has(`${nodeId}:${port.id}`)) continue;
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.inputMissing,
          `Input "${port.id}" on "${nodeId}" (${resolved.definition.type}) is required but nothing is connected to it.`,
          { nodeId, portId: port.id },
        ),
      );
    }
  }
  return diagnostics;
}
