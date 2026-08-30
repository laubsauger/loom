import type {
  ComponentPath,
  ComponentRecursionError,
  GraphComponentDefinition,
  ParentScope,
} from "../domain/types/components.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../domain/types/graph.ts";
import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { ParameterSchema, ParameterValue, StoredParameter } from "../domain/types/parameters.ts";
import { isParameterSlot, storedStaticValue } from "../domain/parameters/slots.ts";
import { storedValues } from "../domain/parameters/stored-values.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import {
  buildParentScope,
  componentSourcePath,
  describeRecursion,
  detectComponentRecursion,
  effectiveInternalOverrides,
  instanceDisplayNames,
  parentBindResolver,
  parentScopeDrivers,
  parseInternalParameterPath,
  readComponentInstance,
} from "../domain/components/index.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";
import { resolveNodeParameters } from "./validate.ts";
import type { ActiveSink } from "./types.ts";

/**
 * Component flattening (T134, T135, §V82, §V83).
 *
 * A component does not compile as a node. It is INLINED into the parent logical graph
 * before anything else in the compiler runs, so the plan the backend receives has no idea
 * components exist — pruning, ordering, resolution propagation and resource assignment
 * all keep working on one flat graph, unchanged (§V25, §V21, §V6).
 *
 * Two things have to survive that inlining, and they are the whole of this module:
 *
 *  - the VALUES. An internal parameter driven by a published knob takes the instance's
 *    value, not the value stored in the definition's graph (§V80); a `parent.<key>`
 *    binding takes the value from the owning instance, walked lexically (§V81). Both are
 *    resolved here, at compile time (§V21), and baked onto the flattened node — so the
 *    rest of the compiler reads one ordinary `GraphNode` and cannot get it wrong.
 *
 *  - the SOURCE PATH. Every flattened node keeps `Main / DreamyFeedback_2 / Blur_1`, so a
 *    diagnostic, a timing row or a profile entry names a place the user can navigate to
 *    rather than an internal node id they have never seen (§V82).
 *
 * ## Id namespacing
 *
 * A flattened internal node is named `<instance node id>/<internal node id>`, applied once
 * per level of nesting: `feedback1/blur2/inner3`. That makes two instances of the same
 * component disjoint (`feedback1/blur` vs `feedback2/blur`), keeps root node ids untouched
 * so an existing plan's resource ids do not move, and stays reversible — splitting on "/"
 * gives back the instance chain, which is how `sources` is built. Node ids may not contain
 * "/"; `internalParameterPath` in the components track already relies on the same rule.
 */

/** Separator between an instance id and the ids it namespaces. */
export const COMPONENT_ID_SEPARATOR = "/";

export function flattenedNodeId(prefix: string, nodeId: NodeId): NodeId {
  return prefix === "" ? nodeId : `${prefix}${COMPONENT_ID_SEPARATOR}${nodeId}`;
}

/** The instance chain a flattened id encodes, outermost first. Empty for a root node. */
export function componentPathOf(flatNodeId: NodeId): ComponentPath {
  const segments = flatNodeId.split(COMPONENT_ID_SEPARATOR);
  const path: NodeId[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    path.push(segments.slice(0, index + 1).join(COMPONENT_ID_SEPARATOR));
  }
  return path;
}

/** One endpoint in the flattened graph. */
export interface FlatEndpoint {
  readonly nodeId: NodeId;
  readonly portId: PortId;
}

/**
 * Where a node in the flattened graph came from (§V82).
 *
 * Recorded for every node seen at every depth — including the instance nodes that were
 * inlined away, so a diagnostic about the instance itself also has a path.
 */
export interface ComponentSource {
  /** Id in the flattened graph. */
  readonly nodeId: NodeId;
  /** Enclosing instance chain as flattened ids, outermost first. Empty at the root. */
  readonly path: ComponentPath;
  /** The node's id inside the graph it was authored in. */
  readonly internalNodeId: NodeId;
  /** `Main / DreamyFeedback_2 / Blur_1` — what a diagnostic or timing row shows. */
  readonly sourcePath: string;
}

export interface FlattenRequest {
  readonly graph: GraphDocument;
  /** Node manifests. Normally the component-aware view, so nested types resolve. */
  readonly registry: NodeRegistryView;
  readonly components: ComponentRegistryView;
}

export interface FlattenedGraph {
  /** The parent logical graph with every instance inlined. No component types remain. */
  readonly graph: GraphDocument;
  /** Flattened node id -> where it came from, sorted by id. */
  readonly sources: ReadonlyMap<NodeId, ComponentSource>;
  /**
   * Flattened instance id -> its exposed OUTPUT ports, in exposure order, mapped to the
   * internal endpoint each became. This is what redirects a sink that named the instance.
   */
  readonly instanceOutputs: ReadonlyMap<NodeId, ReadonlyMap<PortId, FlatEndpoint>>;
  /** Sinks the flattened-away instances implied — a previewed instance (§V28, §V25). */
  readonly sinks: ReadonlyArray<ActiveSink>;
  /** Non-null when the graph recurses; the graph is returned untouched (§V83). */
  readonly recursion: ComponentRecursionError | null;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /** True when at least one instance was inlined. */
  readonly changed: boolean;
}

/** The published parameter page of a component, as a parameter schema. */
function publishedSchema(definition: GraphComponentDefinition): ParameterSchema {
  const schema: ParameterSchema = {};
  for (const published of definition.parameters) schema[published.key] = published.definition;
  return schema;
}

/** Overrides addressed `<internalNodeId>/<key>`, grouped by internal node. */
function overridesByNode(
  overrides: Readonly<Record<string, ParameterValue>>,
): Map<NodeId, Record<string, ParameterValue>> {
  const grouped = new Map<NodeId, Record<string, ParameterValue>>();
  for (const path of Object.keys(overrides).sort()) {
    const parsed = parseInternalParameterPath(path);
    if (parsed === null) continue;
    const value = overrides[path];
    if (value === undefined) continue;
    const forNode = grouped.get(parsed.nodeId);
    if (forNode === undefined) grouped.set(parsed.nodeId, { [parsed.key]: value });
    else forNode[parsed.key] = value;
  }
  return grouped;
}

interface LevelInput {
  readonly graph: GraphDocument;
  /** The component this graph belongs to, or null for the root document. */
  readonly definition: GraphComponentDefinition | null;
  readonly prefix: string;
  /** Enclosing instance chain as flattened ids, outermost first. */
  readonly path: ComponentPath;
  /** Effective values for this level's internal parameters, keyed `<nodeId>/<key>` (§V80). */
  readonly overrides: Readonly<Record<string, ParameterValue>>;
  /** Published values of the enclosing instances, outermost first (§V81). */
  readonly chain: ReadonlyArray<Readonly<Record<string, ParameterValue>>>;
}

interface LevelResult {
  /** External input port id -> the internal endpoint it maps to, in exposure order. */
  readonly inputs: Map<PortId, FlatEndpoint>;
  readonly outputs: Map<PortId, FlatEndpoint>;
}

/**
 * Flattens a graph, recursively.
 *
 * `detectComponentRecursion` runs first and the walk is abandoned when it fires, so this
 * function terminates by construction rather than by a depth counter — one detector,
 * shared with the editor, so the two can never disagree about what is legal (§V83).
 */
export function flattenComponents(request: FlattenRequest): FlattenedGraph {
  const diagnostics: RuntimeDiagnostic[] = [];

  const recursion = detectComponentRecursion({
    componentId: null,
    graph: request.graph,
    source: request.components,
  });
  if (recursion !== null) {
    diagnostics.push(
      compilerDiagnostic("error", CompilerDiagnosticCode.componentRecursion, describeRecursion(recursion), {
        suggestion:
          "A component may not contain itself, directly or through another component (§V83). Break the loop before compiling.",
      }),
    );
    return {
      graph: request.graph,
      sources: new Map(),
      instanceOutputs: new Map(),
      sinks: [],
      recursion,
      diagnostics,
      changed: false,
    };
  }

  const nodes: Record<NodeId, GraphNode> = {};
  const edges: Record<string, GraphEdge> = {};
  const sources = new Map<NodeId, ComponentSource>();
  const instanceOutputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
  const sinks: ActiveSink[] = [];
  /** Flattened instance id -> display name, the pieces a source path is made of. */
  const instanceNames: Record<NodeId, string> = {};
  let changed = false;

  const report = (diagnostic: RuntimeDiagnostic, nodeId: NodeId): void => {
    diagnostics.push({ ...diagnostic, nodeId });
  };

  const recordSource = (flatId: NodeId, path: ComponentPath, node: GraphNode, leaf: string): void => {
    sources.set(flatId, {
      nodeId: flatId,
      path,
      internalNodeId: node.id,
      sourcePath: componentSourcePath(path, instanceNames, leaf),
    });
  };

  /**
   * Effective parameter values for one node: stored values, then the published fan-out and
   * the instance's own overrides (§V80), then any `parent.<key>` binding (§V81).
   *
   * Both mechanisms are read through the components track's own functions rather than off
   * `GraphNode.parameters`, and the result is handed to the compiler's parameter resolver
   * below — so there is still exactly one place a value is validated against a schema.
   */
  const effectiveParameters = (
    node: GraphNode,
    schema: ParameterSchema | undefined,
    forNode: Readonly<Record<string, ParameterValue>>,
    scope: ParentScope | undefined,
    flatId: NodeId,
  ): Record<string, StoredParameter> => {
    const parameters: Record<string, StoredParameter> = { ...node.parameters };
    for (const key of Object.keys(forNode).sort()) {
      const value = forNode[key];
      if (value !== undefined) parameters[key] = value;
    }

    // Slot-mode `parent.*` binds (§V107, T203) are baked here, where the scope exists —
    // the flat graph is a compile artifact resolved without one. A bind that cannot
    // resolve is reported and falls back to the slot's retained static value (§V108) by
    // simply leaving the slot in place minus its scope, i.e. deleting nothing.
    const resolveRef = parentBindResolver(scope);
    for (const key of Object.keys(parameters).sort()) {
      const stored = parameters[key];
      if (stored === undefined || !isParameterSlot(stored)) continue;
      if (stored.mode !== "bind") continue;
      const binding = stored.bindings.bind;
      if (binding?.kind !== "bind" || !binding.ref.startsWith("parent.")) continue;
      const lookup = resolveRef(binding.ref);
      if (!lookup.ok) {
        report(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.componentParameterConflict,
            `"${key}" is bound to "${binding.ref}": ${lookup.message}`,
            { suggestion: "Fix the ref, or switch the parameter back to its static value (§V108)." },
          ),
          flatId,
        );
        const retained = storedStaticValue(stored);
        if (retained === undefined) delete parameters[key];
        else parameters[key] = retained;
        continue;
      }
      parameters[key] = lookup.value;
    }

    const drivers = parentScopeDrivers(node, scope, {
      onDiagnostic: (diagnostic) => report(diagnostic, flatId),
    });
    for (const key of Object.keys(drivers).sort()) {
      if (key in forNode) {
        // Both mechanisms claim the same parameter. The instance-level value wins because
        // it is the outer, per-instance statement — but silently shadowing one authored
        // mechanism with another is exactly the bug §V54 names, so it is reported.
        report(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.componentParameterConflict,
            `"${key}" is both driven by a published parameter and bound to a parent value; the published value wins.`,
            { suggestion: "Unpublish the parameter, or remove the parent binding (§V80, §V81)." },
          ),
          flatId,
        );
        continue;
      }
      const parameterDefinition = schema?.[key];
      if (parameterDefinition === undefined) {
        report(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.componentParameterConflict,
            `"${key}" is bound to a parent value but "${node.type}" declares no such parameter.`,
            { suggestion: "Remove the binding, or bind a parameter the node actually has." },
          ),
          flatId,
        );
        continue;
      }
      const driven = drivers[key]?.({ node, key, definition: parameterDefinition });
      if (driven !== undefined) parameters[key] = driven;
    }
    return parameters;
  };

  const addNode = (node: GraphNode, flatId: NodeId): void => {
    if (nodes[flatId] !== undefined) {
      report(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.componentIdCollision,
          `Flattening produced two nodes called "${flatId}"; the second is dropped.`,
          { suggestion: 'Node ids may not contain "/", which separates an instance from its internals.' },
        ),
        flatId,
      );
      return;
    }
    nodes[flatId] = node;
  };

  const flattenLevel = (input: LevelInput): LevelResult => {
    const scope = buildParentScope(input.chain);
    const grouped = overridesByNode(input.overrides);
    /** Raw instance id -> the boundary of the subgraph it expanded into. */
    const childInputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();
    const childOutputs = new Map<NodeId, ReadonlyMap<PortId, FlatEndpoint>>();

    const names = instanceDisplayNames(
      input.graph,
      (componentId, version) => request.components.get(componentId, version)?.name ?? componentId,
    );

    for (const nodeId of Object.keys(input.graph.nodes).sort()) {
      const node = input.graph.nodes[nodeId];
      if (node === undefined) continue;
      const flatId = flattenedNodeId(input.prefix, nodeId);
      const instance = readComponentInstance(node);
      const componentDefinition =
        instance === null ? undefined : request.components.get(instance.componentId, instance.version);

      const schema =
        componentDefinition === undefined
          ? request.registry.get(node.type)?.parameters
          : publishedSchema(componentDefinition);
      const parameters = effectiveParameters(node, schema, grouped.get(nodeId) ?? {}, scope, flatId);
      const resolved: GraphNode = { ...node, id: flatId, parameters };

      if (instance === null) {
        addNode(resolved, flatId);
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        continue;
      }

      if (componentDefinition === undefined) {
        // §V10: an uninstalled component is a placeholder, not a reason to lose the rest of
        // the project. The node is kept so the unknown-type diagnostic names it.
        report(
          compilerDiagnostic(
            "error",
            CompilerDiagnosticCode.componentMissing,
            `Component "${instance.componentId}" version ${instance.version} is not installed, so "${flatId}" cannot be flattened.`,
            { suggestion: "Install the component package, or upgrade the instance to a version you have (§V84)." },
          ),
          flatId,
        );
        addNode(resolved, flatId);
        recordSource(flatId, input.path, node, node.label ?? nodeId);
        continue;
      }

      const label = node.label ?? names[nodeId] ?? componentDefinition.name;
      instanceNames[flatId] = label;
      recordSource(flatId, input.path, node, label);

      // The instance's published page, validated against its re-authored definitions.
      // STORED space (T307, §V56): flattening writes these back onto internal parameters
      // and feeds them to `parent.<key>` drivers, and both of those re-resolve. Handing
      // over the evaluation values would decode a display colour twice — a picked
      // mid-grey reaching the shader at 0.0376 instead of 0.2140 (B8, T187).
      const published = storedValues(
        resolveNodeParameters(resolved, publishedSchema(componentDefinition), node.type, diagnostics),
      );
      const childOverrides = effectiveInternalOverrides(componentDefinition, resolved, published);

      const child = flattenLevel({
        graph: componentDefinition.graph,
        definition: componentDefinition,
        prefix: flatId,
        path: [...input.path, flatId],
        overrides: childOverrides,
        chain: [...input.chain, published],
      });
      childInputs.set(nodeId, child.inputs);
      childOutputs.set(nodeId, child.outputs);
      instanceOutputs.set(flatId, child.outputs);
      changed = true;

      // The instance node itself is gone, so a preview PINNED on it has to become a
      // preview of what it produced — otherwise §V25 prunes the whole component away.
      // The pin, not the switch (T353, §V297): the switch is default-on and would make
      // every instance an unconditional sink.
      if (node.ui?.previewPinned === true) {
        const first = [...child.outputs.values()][0];
        if (first !== undefined) sinks.push({ nodeId: first.nodeId, portId: first.portId, kind: "preview" });
      }
    }

    const endpointOf = (
      nodeId: NodeId,
      portId: PortId,
      direction: "input" | "output",
    ): FlatEndpoint | undefined => {
      const boundary = direction === "input" ? childInputs.get(nodeId) : childOutputs.get(nodeId);
      if (boundary === undefined) return { nodeId: flattenedNodeId(input.prefix, nodeId), portId };
      return boundary.get(portId);
    };

    for (const edgeId of Object.keys(input.graph.edges).sort()) {
      const edge = input.graph.edges[edgeId];
      if (edge === undefined) continue;
      const source = endpointOf(edge.source.nodeId, edge.source.portId, "output");
      const target = endpointOf(edge.target.nodeId, edge.target.portId, "input");
      if (source === undefined || target === undefined) {
        const unresolved = source === undefined ? edge.source : edge.target;
        diagnostics.push(
          compilerDiagnostic(
            "error",
            CompilerDiagnosticCode.componentPortUnresolved,
            `Edge "${flattenedNodeId(input.prefix, edgeId)}" reaches "${unresolved.portId}" on component instance "${flattenedNodeId(input.prefix, unresolved.nodeId)}", which the component does not expose.`,
            {
              nodeId: flattenedNodeId(input.prefix, unresolved.nodeId),
              portId: unresolved.portId,
              suggestion: "Expose the internal port on the component, or disconnect the edge (§V79).",
            },
          ),
        );
        continue;
      }
      const flatEdgeId = flattenedNodeId(input.prefix, edgeId);
      edges[flatEdgeId] = { id: flatEdgeId, source: { ...source }, target: { ...target } };
    }

    const inputs = new Map<PortId, FlatEndpoint>();
    const outputs = new Map<PortId, FlatEndpoint>();
    for (const [exposedPorts, into, direction] of [
      [input.definition?.inputs ?? [], inputs, "input"],
      [input.definition?.outputs ?? [], outputs, "output"],
    ] as const) {
      for (const exposed of exposedPorts) {
        const endpoint = endpointOf(exposed.nodeId, exposed.portId, direction);
        if (endpoint === undefined) {
          diagnostics.push(
            compilerDiagnostic(
              "error",
              CompilerDiagnosticCode.componentPortUnresolved,
              `Component "${input.definition?.name ?? ""}" exposes "${exposed.externalId}", which maps to "${exposed.nodeId}.${exposed.portId}" — a port that does not resolve.`,
              { suggestion: "Re-expose the port; the internal node or port it named has moved (§V79)." },
            ),
          );
          continue;
        }
        into.set(exposed.externalId, endpoint);
      }
    }

    return { inputs, outputs };
  };

  flattenLevel({
    graph: request.graph,
    definition: null,
    prefix: "",
    path: [],
    overrides: {},
    chain: [],
  });

  return {
    graph: {
      revision: request.graph.revision,
      nodes,
      edges,
      // Groups are a canvas affordance, not a logical one: a flattened graph has no canvas.
      groups: {},
    },
    sources,
    instanceOutputs,
    sinks,
    recursion: null,
    diagnostics,
    changed,
  };
}

/**
 * Rewrites a sink that named a component instance to name what the instance became.
 *
 * Without this a pinned preview on an instance would name a node that no longer exists,
 * and the whole component would be pruned as unreachable (§V25, §V28).
 */
export function redirectSink(
  sink: ActiveSink,
  instanceOutputs: ReadonlyMap<NodeId, ReadonlyMap<PortId, FlatEndpoint>>,
): ActiveSink {
  const outputs = instanceOutputs.get(sink.nodeId);
  if (outputs === undefined) return sink;
  const portId = sink.portId ?? [...outputs.keys()][0];
  const endpoint = portId === undefined ? undefined : outputs.get(portId);
  if (endpoint === undefined) return sink;
  return { nodeId: endpoint.nodeId, portId: endpoint.portId, kind: sink.kind };
}

/**
 * Stamps a diagnostic with the source path of the node it names (§V82).
 *
 * A diagnostic about `feedback1/blur2/warp` is unreadable; the same diagnostic followed by
 * `Main / DreamyFeedback_1 / Blur_2 / warp` names a place the user can navigate to.
 */
export function withSourcePath(
  diagnostic: RuntimeDiagnostic,
  sources: ReadonlyMap<NodeId, ComponentSource>,
): RuntimeDiagnostic {
  if (diagnostic.nodeId === undefined) return diagnostic;
  const source = sources.get(diagnostic.nodeId);
  if (source === undefined || source.path.length === 0) return diagnostic;
  return { ...diagnostic, message: `${diagnostic.message} (${source.sourcePath})` };
}
