import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { ParameterSchema, ParameterValue } from "../domain/types/parameters.ts";
import type { PortDefinition } from "../domain/types/ports.ts";
import { arePortsCompatible, describePortType } from "../domain/graph/port-compat.ts";
import { resolveParameterSchema, effectiveParameterSchema, type ParameterMapBinding } from "../domain/parameters/resolve.ts";
import { createNodeReferenceReader } from "../domain/parameters/node-references.ts";
import type { ResolveParametersOptions } from "../domain/parameters/resolve.ts";
import { bindCycleDiagnostics } from "../domain/parameters/bind-cycles.ts";
import { referenceCycleDiagnostics } from "../domain/graph/reference-cycles.ts";
import { isComponentKeyOf } from "../domain/parameters/slots.ts";
import type { ResolvedParameters } from "../domain/parameters/resolve.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import type { CompileEdge } from "./types.ts";

/**
 * Definition resolution, parameter validation and connection validation (T24, §V13, §V14).
 *
 * Everything here is a rejection with a diagnostic, never a throw: a project with one bad
 * edge still compiles the rest of itself, and the user gets told exactly which edge.
 */

/**
 * What a resolution needs to know about the moment it is resolving AT (T259, §V163).
 *
 * Empty for a structural compile, which is the common case and resolves every animated
 * parameter at its zero-frame value. A per-frame values-only pass supplies both: the
 * frame an expression reads `time` from, and the channel resolver a `driven` parameter
 * reads its LFO through. Nothing else about the compile changes — same graph, same
 * topology, same resources — so the resulting plan differs only in its uniform VALUES,
 * which is what makes the update path `updateUniforms` rather than a recompile (§V5).
 */
export type ParameterResolution = Pick<ResolveParametersOptions, "frame" | "channels" | "nodes">;

export interface ResolvedNode {
  readonly node: GraphNode;
  readonly definition: NodeDefinition;
  /**
   * The values EVALUATION consumes: defaults filled in, invalid values replaced by the
   * default and reported, and a `space: "display"` colour decoded to linear (§V56, B8).
   * This is `ResolvedParameters.values` from the §V61 resolver, unaltered — the compiler
   * no longer has an opinion of its own about what a parameter is worth.
   */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /** T286 (§V287): parameters whose active mode is `map` — the consumer compiles from this. */
  readonly parameterMaps: Readonly<Record<string, ParameterMapBinding>>;
}

export interface ValidatedGraph {
  /** Nodes whose type resolved, keyed by id. Insertion order is sorted by id. */
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  /** Edges that passed endpoint, type (§V13) and arity (§V14) validation, sorted by edge id. */
  readonly edges: ReadonlyArray<CompileEdge>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

function findPort(ports: ReadonlyArray<PortDefinition>, portId: PortId): PortDefinition | undefined {
  return ports.find((port) => port.id === portId);
}

/** True when the definition declares this output as carrying previous-frame data (§V4). */
export function isTemporalOutput(definition: NodeDefinition, portId: PortId): boolean {
  return definition.temporal?.outputs.includes(portId) === true;
}

/**
 * One node's parameters, resolved through THE parameter read path (§V61, T168).
 *
 * The compiler used to carry its own copy of this resolution, and the copies drifted:
 * the display→linear colour decode reached the inspector's copy and not this one, so a
 * mid-grey swatch rendered near-black (B8). There is now one implementation, in
 * `src/domain/parameters/resolve.ts`, and this function is the compiler's call site into
 * it — schema resolution plus the two things that are genuinely the COMPILER's business:
 *
 *  - forwarding the resolver's own rejections into the compilation's diagnostics. The
 *    validation itself belongs to the shared resolver, because validating is what picks
 *    the value (reject → default, accept → stored); a caller that validated on its own
 *    would resolve differently, which is B8 wearing another parameter type.
 *  - the "carries a parameter this type does not declare" warning, which is about keys
 *    OUTSIDE the schema, is worded in terms of a node type, and carries a compiler
 *    diagnostic code. Nothing an inspector would ever want.
 *
 * Takes a bare schema rather than a `NodeDefinition` because a component instance's
 * parameter page is the component's PUBLISHED definitions, which exist before any node
 * manifest does (§V80) — and one resolver is the point. `typeLabel` is only for the
 * "carries a parameter this type does not declare" message.
 */
export function resolveNodeParameters(
  node: GraphNode,
  parameters: ParameterSchema,
  typeLabel: string,
  diagnostics: RuntimeDiagnostic[],
  options: ParameterResolution = {},
): ResolvedParameters {
  const resolved = resolveParameterSchema(node, parameters, options);

  // §V110 belt-and-braces: the patch gate refuses cycles at write time, but a document
  // can arrive from a file. Surfacing them here keeps compile the second line, and the
  // resolver's visited-set guard the last.
  diagnostics.push(...bindCycleDiagnostics(node, parameters));

  // Sorted by key, not manifest order: a diagnostic list is read by a human scanning for
  // a parameter name, and the order must not change when a manifest is reordered.
  for (const entry of [...resolved.entries].sort((a, b) => a.key.localeCompare(b.key))) {
    if (entry.diagnostic !== null) diagnostics.push(entry.diagnostic);
  }

  for (const key of Object.keys(node.parameters).sort()) {
    if (key in parameters) continue;
    // `color.r` addresses a component of a declared compound (§V113), not an unknown key.
    if (isComponentKeyOf(parameters, key)) continue;
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
 * The values evaluation consumes — `space: "display"` colours decoded to linear (§V56).
 *
 * This is what feeds `NodeDefinition.compile` and therefore the plan's uniforms. A
 * caller that needs the STORED-space values instead (flattening bakes published values
 * back onto `GraphNode.parameters`, where a second decode would be wrong) reads
 * `resolveNodeParameters(...).entries` directly.
 */
export function resolveParameterValues(
  node: GraphNode,
  parameters: ParameterSchema,
  typeLabel: string,
  diagnostics: RuntimeDiagnostic[],
  options: ParameterResolution = {},
): Record<string, ParameterValue> {
  return { ...resolveNodeParameters(node, parameters, typeLabel, diagnostics, options).values };
}

/**
 * Resolves definitions and validates every node and edge in the document.
 *
 * Runs over the WHOLE document rather than the pruned subgraph: a miswired branch that
 * nothing renders is still a mistake worth surfacing in the problems tab.
 */
export function validateGraph(
  graph: GraphDocument,
  registry: NodeRegistryView,
  options: ParameterResolution = {},
): ValidatedGraph {
  const diagnostics: RuntimeDiagnostic[] = [];
  const nodes = new Map<NodeId, ResolvedNode>();

  /**
   * §V152 belt-and-braces, the cross-node half. The patch gate refuses an `op()` cycle at
   * write time (`referenceCyclesThrough`), but a document can arrive from a file — and a
   * cycle spans NODES, so unlike a bind cycle it has no per-node home in
   * `resolveNodeParameters`. Reported once for the graph, before any resolution runs.
   */
  diagnostics.push(...referenceCycleDiagnostics(graph));

  /**
   * T316/§V148 — the cross-node read path, supplied HERE rather than by each caller.
   *
   * `op('noise1').par.gain` resolves against the graph being compiled, and this function
   * is the one place that has it: every compiler entry point comes through here, so
   * building the reader once means the plan's uniforms carry referenced values without a
   * single `compileGraph` caller having to know the seam exists. A caller MAY pass its
   * own (`options.nodes`) — the flattener does, so an instance's internals read against
   * the flattened graph they actually live in — and its choice wins.
   *
   * §V61 in one line: the compiler and the inspector read through the same resolver with
   * the same reader, so a reference cannot mean one thing on screen and another on the
   * GPU. That divergence is B8, and it cost this project a day.
   */
  const resolution: ParameterResolution = {
    ...options,
    nodes:
      options.nodes ??
      createNodeReferenceReader({
        graph,
        // T903: through the funnel — `op('lantern').par.orbitSpeed` reads a key that only
        // exists in the node's REFLECTED schema, and a static-schema reader would answer
        // "no such parameter" for a control the inspector is showing.
        schemaOf: (node) => effectiveParameterSchema(registry.get(node.type), node.parameters),
        base: { ...(options.frame === undefined ? {} : { frame: options.frame }),
                ...(options.channels === undefined ? {} : { channels: options.channels }) },
      }),
  };

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
    const resolvedParameters = resolveNodeParameters(
      node,
      // T880: the node's EFFECTIVE schema — a customWgsl reflects its own shader's struct, so
      // a control it declares (orbitSpeed, lightColor) resolves and reaches the kernel. Every
      // other node returns its static schema unchanged.
      effectiveParameterSchema(definition, node.parameters),
      definition.type,
      diagnostics,
      resolution,
    );
    nodes.set(nodeId, {
      node,
      definition,
      parameters: { ...resolvedParameters.values },
      parameterMaps: resolvedParameters.maps,
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
      // T225/§V131: the variadic input order rides along, or the compiler would fold a
      // Composite's layers in whatever order their ids happened to sort in.
      ...(edge.order === undefined ? {} : { order: edge.order }),
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
