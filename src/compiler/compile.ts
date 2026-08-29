import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { LogicalExecutionPlan } from "../domain/types/backend.ts";
import type { CompiledNodeDescription, NodeDefinition, TextureFormat } from "../domain/types/node-definition.ts";
import { TEXTURE_FORMATS } from "../domain/types/node-definition.ts";
import type { PortType } from "../domain/types/ports.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import {
  estimateResourceBytes,
  passStructureKey,
  planStructureSignature,
  readExecutionPlan,
  resourceStructureKey,
} from "../runtime/backend/plan.ts";
import { describeError } from "../runtime/backend/diagnostics.ts";
import type { ColorSpace } from "./color-space.ts";
import { colorSpaceForFormat, resolveColorSpace } from "./color-space.ts";
import { declaredColorSpace } from "../domain/graph/port-compat.ts";
import { CompilerDiagnosticCode, compilerDiagnostic, hasError } from "./diagnostics.ts";
import { flattenComponents, redirectSink, withSourcePath } from "./flatten.ts";
import type { ComponentSource } from "./flatten.ts";
import { resolveNodeFormat } from "./format.ts";
import { isDeclaredSink, pruneToActiveSinks, resolveSinks } from "./prune.ts";
import { resolveNodeResolution } from "./resolution.ts";
import {
  SHARED_SAMPLER_ID,
  SINK_TARGET_PORT,
  pingPongResourceId,
  scratchResourceId,
  swapPassId,
  targetResourceId,
} from "./resources.ts";
import { orderNodes } from "./topology.ts";
import { isTemporalOutput, validateGraph, validateRequiredInputs } from "./validate.ts";
import type { ResolvedNode } from "./validate.ts";
import { outputKey } from "./types.ts";
import type {
  ActiveSink,
  CompileEdge,
  CompileRequest,
  CompiledGraph,
  CompiledInputBinding,
  CompiledOutputBinding,
  CompilerNodeContext,
  FeedbackPair,
  ResolvedOutput,
} from "./types.ts";

/**
 * The graph compiler (T24-T33).
 *
 * `compileGraph` is pure: the same document, settings, registry and capabilities always
 * produce the same plan, down to the order of passes and resources. That is not tidiness —
 * the plan's structural signature decides whether GPU resources are rebuilt, so an
 * unstable ordering would rebuild the world on every keystroke (§V5).
 *
 * The pipeline, in order:
 *   0. flatten component instances into the parent logical graph   (T134, T135, §V82, §V83)
 *   1. resolve definitions, validate parameters and connections   (T24, §V13, §V14)
 *   2. trace active sinks and prune                                (T26, §V25)
 *   3. split temporal edges, reject illegal cycles, order          (T25, §V4)
 *   4. propagate resolution and format                             (T27/T72/T28/T75, §V21)
 *   5. assign one persistent resource per materialized output      (T29, §V8, §V6)
 *   6. compile each node once, append ping-pong swaps              (T32, T33, §V22)
 *   7. emit the plan and its diagnostics                           (T30)
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pass kinds a node definition is allowed to emit.
 *
 * `swap` is the compiler's alone (§V22 places it after every consumer, which a node cannot
 * know from inside its own compile). When the plan IR grows a `compute` kind this set and
 * `TARGETED_PASS_KINDS` are the two places that learn about it — scheduling, pruning and
 * ordering never look at a pass kind at all.
 */
const NODE_EMITTABLE_PASS_KINDS: ReadonlySet<string> = new Set(["effect", "dispatch", "draw"]);

/** Pass kinds that render into a resource and therefore need a target. */
const TARGETED_PASS_KINDS: ReadonlySet<string> = new Set(["effect", "draw"]);

/**
 * Which resource kind an output materializes into, read off the port rather than assumed.
 *
 * Returning undefined means "this port carries no GPU resource in the current IR" — a
 * `buffer` output becomes a `buffer` resource once the plan descriptors have one; until
 * then it materializes nothing rather than pretending to be a texture.
 */
function resourceKindForOutput(
  portType: PortType,
  temporal: boolean,
): "target" | "pingPong" | "pointset" | undefined {
  // T121/T176: a pointset output materializes as a MARKER, not a texture resource — the
  // edge must survive propagation so consumers receive the producer's identity, but the
  // actual GPU storage is the per-attribute buffer pairs the node's scratch declares.
  if (portType.kind === "pointset") return "pointset";
  if (portType.kind !== "texture2d") return undefined;
  return temporal ? "pingPong" : "target";
}

interface OutputSlot {
  readonly portId: PortId;
  readonly resourceKind: "target" | "pingPong" | "pointset";
}

/**
 * The resources a node can materialize: one per declared output port that carries a GPU
 * resource, plus — for a declared sink with no output ports at all — the render target it
 * presents into. An Output node publishes no port, but it still has to render somewhere.
 */
function outputSlots(definition: NodeDefinition): OutputSlot[] {
  const slots: OutputSlot[] = [];
  for (const port of definition.outputs) {
    const resourceKind = resourceKindForOutput(port.type, isTemporalOutput(definition, port.id));
    if (resourceKind !== undefined) slots.push({ portId: port.id, resourceKind });
  }
  if (slots.length === 0 && isDeclaredSink(definition)) {
    slots.push({ portId: SINK_TARGET_PORT, resourceKind: "target" });
  }
  return slots;
}

function declaresDepthOutput(definition: NodeDefinition): boolean {
  return definition.outputs.some(
    (port) => port.type.kind === "texture2d" && port.type.sample === "depth",
  );
}

interface PropagationResult {
  /** Materialized outputs keyed by `${nodeId}:${portId}`, inserted in execution order. */
  readonly outputs: ReadonlyMap<string, ResolvedOutput>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

interface PropagationArgs {
  readonly order: ReadonlyArray<NodeId>;
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  readonly incoming: ReadonlyMap<NodeId, ReadonlyArray<CompileEdge>>;
  readonly materialized: ReadonlySet<string>;
  readonly request: CompileRequest;
  /**
   * Result of a previous pass, consulted only for a temporal edge whose producer has not
   * been visited yet. A feedback loop is a cycle: its sizes cannot be known in one sweep,
   * so the walk runs twice and the second sweep inherits properly instead of falling back.
   */
  readonly seed: ReadonlyMap<string, ResolvedOutput> | undefined;
  /** Diagnostics are collected on the final sweep only, so the fixpoint is not reported twice. */
  readonly collectDiagnostics: boolean;
}

function propagate(args: PropagationArgs): PropagationResult {
  const { order, nodes, incoming, materialized, request, seed, collectDiagnostics } = args;
  const outputs = new Map<string, ResolvedOutput>();
  const diagnostics: RuntimeDiagnostic[] = [];

  for (const nodeId of order) {
    const resolved = nodes.get(nodeId);
    if (resolved === undefined) continue;
    const { node, definition } = resolved;

    const sizeByPort: Record<PortId, readonly [number, number] | undefined> = {};
    const formatByPort: Record<PortId, TextureFormat | undefined> = {};
    /** Every incoming binding, not one per port: a variadic port can mix spaces by itself. */
    const spaceBindings: Array<{ portId: PortId; space: ColorSpace }> = [];
    let primaryPort: PortId | undefined;

    for (const edge of incoming.get(nodeId) ?? []) {
      const key = outputKey(edge.source.nodeId, edge.source.portId);
      const upstream = outputs.get(key) ?? seed?.get(key);
      if (upstream === undefined) continue;
      // T83/B5: an input port DECLARING `space: "data"` reads its input as data no
      // matter what arrives — a Mask's mask input takes any channel as coverage, and
      // that is not a colour mismatch (§V57).
      const inputPortType = definition.inputs.find((port) => port.id === edge.target.portId)?.type;
      const readsAsData =
        inputPortType?.kind === "texture2d" && declaredColorSpace(inputPortType) === "data";
      spaceBindings.push({
        portId: edge.target.portId,
        space: readsAsData ? "data" : upstream.space,
      });
      if (sizeByPort[edge.target.portId] === undefined) {
        sizeByPort[edge.target.portId] = upstream.size;
        formatByPort[edge.target.portId] = upstream.format;
      }
    }
    // "Primary input" is the first DECLARED input that actually has something on it —
    // declaration order is the author's statement of which input matters most.
    for (const port of definition.inputs) {
      if (sizeByPort[port.id] !== undefined) {
        primaryPort = port.id;
        break;
      }
    }

    const resolution = resolveNodeResolution({
      nodeId,
      nodeType: node.type,
      override: node.resolution,
      policy: definition.resolutionPolicy,
      inputs: { byPort: sizeByPort, primaryPort },
      settings: request.settings,
      capabilities: request.capabilities,
      parameters: resolved.parameters,
    });

    const format = resolveNodeFormat({
      nodeId,
      nodeType: node.type,
      override: node.format,
      policy: definition.formatPolicy,
      inputs: { byPort: formatByPort, primaryPort },
      settings: request.settings,
      capabilities: request.capabilities,
      allowsDepth: declaresDepthOutput(definition),
    });

    // Colour space rides alongside format, with the same precedence: inherited when the
    // format was inherited, implied by the resolved format otherwise (doc §16.2).
    // T149: the space comes from the PORT the format precedence actually named — an
    // instance override in "input" mode, or the policy's inherit port — never from
    // whichever connected input happens to sort first in edge order.
    const inheritPort =
      node.format !== undefined && node.format.mode !== "auto"
        ? node.format.mode === "input"
          ? (node.format.input ?? primaryPort)
          : undefined
        : definition.formatPolicy?.kind === "inherit"
          ? definition.formatPolicy.input
          : undefined;
    const space = resolveColorSpace({
      nodeId,
      nodeType: node.type,
      inputs: spaceBindings,
      resolved: colorSpaceForFormat(format.format),
      inherited: inheritPort !== undefined,
      inheritPort,
    });

    if (collectDiagnostics) {
      diagnostics.push(...resolution.diagnostics, ...format.diagnostics, ...space.diagnostics);
    }

    for (const slot of outputSlots(definition)) {
      const key = outputKey(nodeId, slot.portId);
      if (!materialized.has(key)) continue;
      // T83/B5: an EXPLICIT `space` on the output port is the author's claim and wins
      // over everything derived — a Mask's output declaring `data` stays data no matter
      // what formats flowed in. `declaredColorSpace` answers "did the author claim one"
      // (absence = no claim, derived space fills it); `colorSpaceOf` answers the §V13
      // comparison question and would erase that distinction.
      const portType = definition.outputs.find((port) => port.id === slot.portId)?.type;
      const declaredSpace =
        portType !== undefined && portType.kind === "texture2d" ? declaredColorSpace(portType) : undefined;
      outputs.set(key, {
        nodeId,
        portId: slot.portId,
        resourceId:
          slot.resourceKind === "pingPong"
            ? pingPongResourceId(nodeId, slot.portId)
            : slot.resourceKind === "pointset"
              ? `points:${nodeId}:${slot.portId}`
              : targetResourceId(nodeId, slot.portId),
        resourceKind: slot.resourceKind,
        size: resolution.size,
        format: format.format,
        space: declaredSpace ?? space.space,
        temporal: slot.resourceKind === "pingPong",
      });
    }
  }

  return { outputs, diagnostics };
}

function normalizePass(
  nodeId: NodeId,
  defaultTarget: string | undefined,
  index: number,
  raw: unknown,
  diagnostics: RuntimeDiagnostic[],
): Record<string, unknown> | undefined {
  const reject = (message: string, suggestion?: string): undefined => {
    diagnostics.push(
      compilerDiagnostic("error", CompilerDiagnosticCode.passInvalid, message, {
        nodeId,
        ...(suggestion === undefined ? {} : { suggestion }),
      }),
    );
    return undefined;
  };

  if (!isRecord(raw)) return reject(`Node "${nodeId}" emitted a pass that is not an object.`);

  const rawKind = raw["kind"];
  const kind = typeof rawKind === "string" ? rawKind : "effect";
  if (!NODE_EMITTABLE_PASS_KINDS.has(kind)) {
    return reject(
      `Node "${nodeId}" emitted a "${kind}" pass, which a node definition may not emit.`,
      `Emittable kinds: ${[...NODE_EMITTABLE_PASS_KINDS].join(", ")}. Ping-pong swaps are the compiler's, placed after all current-frame consumers (§V22).`,
    );
  }

  const rawId = raw["id"];
  const localId = typeof rawId === "string" && rawId !== "" ? rawId : String(index);
  const rawTarget = raw["target"];
  const target = typeof rawTarget === "string" && rawTarget !== "" ? rawTarget : defaultTarget;
  if (target === undefined && TARGETED_PASS_KINDS.has(kind)) {
    return reject(
      `Node "${nodeId}" emitted a pass with no target, and none of its outputs is materialized.`,
      "Connect the node's output to something that is rendered, or name a target on the pass.",
    );
  }

  const { id: _id, kind: _kind, target: _target, nodeId: _nodeId, ...rest } = raw;
  // Ids are namespaced by node so two definitions cannot collide, and stay stable across
  // recompiles so a pass signature only changes when that pass really changed.
  return {
    ...rest,
    kind,
    id: `${nodeId}#${localId}`,
    ...(target === undefined ? {} : { target }),
    nodeId,
  };
}

/**
 * One materialized output -> one resource descriptor. The switch is exhaustive on purpose:
 * a new resource kind must be handled here, and the compiler will not build until it is.
 */
function describeResource(output: ResolvedOutput): Record<string, unknown> {
  switch (output.resourceKind) {
    case "target":
    case "pingPong":
      return {
        kind: output.resourceKind,
        id: output.resourceId,
        size: output.size,
        format: output.format,
        label: `${output.nodeId}.${output.portId}`,
      };
    case "pointset":
      // The caller filters markers out before this point; reaching here is a bug.
      throw new Error(`pointset output "${output.resourceId}" materializes no resource (T121).`);
  }
}

// T144 (§V62d): one identity definition, not two. `resourceStructureKey` and
// `passStructureKey` from plan.ts are THE per-entry identity — the backend's T143
// carry-over diffs the same functions, so the compiler's recompile classifier and the
// backend's resource reuse can never disagree about "has this changed". (The exported
// keys fold the entry's id in; every consumer compares per-id, so that is inert.)

function emptyPlan(
  diagnostics: ReadonlyArray<RuntimeDiagnostic>,
  pruned: ReadonlyArray<NodeId>,
  sources: ReadonlyArray<ComponentSource> = [],
): CompiledGraph {
  return {
    passes: [],
    resources: [],
    diagnostics,
    ok: !hasError(diagnostics),
    order: [],
    pruned,
    outputs: [],
    feedback: [],
    sources,
    resourceSignatures: [],
    passSignatures: [],
    signature: planStructureSignature([], []),
    estimatedResourceBytes: 0,
  };
}

function feedbackResetSignature(
  definition: NodeDefinition,
  output: ResolvedOutput,
  passes: ReadonlyArray<PassDescriptor>,
): string {
  const resetOn = definition.temporal?.resetOn ?? [];
  const parts: unknown[] = [];
  if (resetOn.includes("resolution")) parts.push(["resolution", output.size[0], output.size[1]]);
  if (resetOn.includes("format")) parts.push(["format", output.format]);
  if (resetOn.includes("shader-interface")) {
    // The interface, deliberately not the shader body: rebinding or renaming a uniform
    // changes what the history buffer means, editing an expression does not.
    parts.push([
      "shader-interface",
      passes
        .filter((pass) => pass.kind === "effect" && pass.target === output.resourceId)
        .map((pass) =>
          pass.kind === "effect"
            ? [
                (pass.textures ?? []).map((texture) => [texture.binding, texture.resourceId]),
                (pass.samplers ?? []).map((sampler) => [sampler.binding, sampler.resourceId]),
                pass.uniformBinding ?? null,
                Object.keys(pass.uniforms ?? {}).sort(),
                pass.sharedBinding ?? null,
              ]
            : null,
        ),
    ]);
  }
  return JSON.stringify(parts);
}

interface PassthroughSplice {
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  readonly edges: ReadonlyArray<CompileEdge>;
  /** Spliced output → the producer endpoint it aliases, for §V130 output resolution. */
  readonly aliases: ReadonlyArray<
    [{ nodeId: NodeId; portId: PortId }, { nodeId: NodeId; portId: PortId }]
  >;
  readonly redirectSink: (sink: ActiveSink) => ActiveSink;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

/**
 * Splices passthrough nodes out of the compile graph (T223, §V130).
 *
 * A node whose definition declares `passthrough` is a wire: every edge leaving its
 * output is rewired to the producer feeding its input, the node and its inbound edge
 * disappear, and no pass or resource is ever emitted for it. Chains of wires resolve
 * transitively. An unconnected wire simply vanishes (its consumers lose the input and
 * report through the ordinary required-input path); a wire loop cannot happen — it
 * would need a graph cycle, which ordering rejects — but the walk still guards.
 *
 * Temporality follows the REAL producer: a Null after a Feedback output carries the
 * previous-frame semantics of that output, because the rewired edge recomputes
 * `temporal` from the endpoint it now reads.
 */
function splicePassthroughNodes(validated: {
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  readonly edges: ReadonlyArray<CompileEdge>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}): PassthroughSplice {
  const wires = new Map<NodeId, { input: PortId; output: PortId }>();
  for (const [nodeId, resolved] of validated.nodes) {
    if (resolved.definition.passthrough !== undefined) {
      wires.set(nodeId, resolved.definition.passthrough);
    }
  }
  if (wires.size === 0) {
    return {
      nodes: validated.nodes,
      edges: validated.edges,
      aliases: [],
      redirectSink: (sink) => sink,
      diagnostics: [],
    };
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  /** First edge into each wire's declared input. */
  const feeding = new Map<NodeId, { nodeId: NodeId; portId: PortId }>();
  for (const edge of validated.edges) {
    const wire = wires.get(edge.target.nodeId);
    if (wire !== undefined && edge.target.portId === wire.input && !feeding.has(edge.target.nodeId)) {
      feeding.set(edge.target.nodeId, edge.source);
    }
  }

  /** The real (non-wire) producer behind a wire, or undefined for an unconnected chain. */
  const producerBehind = (wireId: NodeId): { nodeId: NodeId; portId: PortId } | undefined => {
    const seen = new Set<NodeId>();
    let current = feeding.get(wireId);
    while (current !== undefined && wires.has(current.nodeId)) {
      if (seen.has(current.nodeId)) return undefined; // defensive: a loop of wires
      seen.add(current.nodeId);
      current = feeding.get(current.nodeId);
    }
    return current;
  };

  const producers = new Map<NodeId, { nodeId: NodeId; portId: PortId } | undefined>();
  for (const wireId of [...wires.keys()].sort()) {
    const producer = producerBehind(wireId);
    producers.set(wireId, producer);
    if (producer === undefined && feeding.has(wireId)) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.passthroughUnconnected,
          `"${wireId}" passes through a chain that reaches no producer; its output is disconnected.`,
          { nodeId: wireId },
        ),
      );
    }
  }

  const temporalOf = (endpoint: { nodeId: NodeId; portId: PortId }): boolean => {
    const definition = validated.nodes.get(endpoint.nodeId)?.definition;
    return definition !== undefined && isTemporalOutput(definition, endpoint.portId);
  };

  const edges: CompileEdge[] = [];
  for (const edge of validated.edges) {
    // Edges INTO a wire are consumed by the splice.
    if (wires.has(edge.target.nodeId)) continue;
    const sourceWire = wires.get(edge.source.nodeId);
    if (sourceWire === undefined) {
      edges.push(edge);
      continue;
    }
    const producer = producers.get(edge.source.nodeId);
    if (producer === undefined) continue; // unconnected wire: the consumer loses the edge
    edges.push({ ...edge, source: producer, temporal: temporalOf(producer) });
  }

  const nodes = new Map<NodeId, ResolvedNode>();
  for (const [nodeId, resolved] of validated.nodes) {
    if (!wires.has(nodeId)) nodes.set(nodeId, resolved);
  }

  const aliases: Array<[{ nodeId: NodeId; portId: PortId }, { nodeId: NodeId; portId: PortId }]> = [];
  for (const [wireId, wire] of [...wires.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const producer = producers.get(wireId);
    if (producer !== undefined) aliases.push([{ nodeId: wireId, portId: wire.output }, producer]);
  }

  const redirectSink = (sink: ActiveSink): ActiveSink => {
    const wire = wires.get(sink.nodeId);
    if (wire === undefined) return sink;
    const producer = producers.get(sink.nodeId);
    if (producer === undefined) return sink; // stays; resolves to nothing like any dangling sink
    return { ...sink, nodeId: producer.nodeId, portId: producer.portId };
  };

  return { nodes, edges, aliases, redirectSink, diagnostics };
}

export function compileGraph(request: CompileRequest): CompiledGraph {
  const { registry, settings } = request;
  const diagnostics: RuntimeDiagnostic[] = [];

  // 0. flatten component instances (T134, §V82). Everything after this point sees one
  // flat logical graph: pruning, ordering and resource assignment never learn what a
  // component is. Without a component registry there is nothing to flatten against, and
  // an instance falls through to the manifest's `component.notFlattened` tripwire.
  const flattened =
    request.components === undefined
      ? undefined
      : flattenComponents({ graph: request.graph, registry, components: request.components });
  const sources = flattened?.sources ?? new Map<NodeId, ComponentSource>();
  const sourceRows = [...sources.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const stamp = (collected: ReadonlyArray<RuntimeDiagnostic>): RuntimeDiagnostic[] =>
    collected.map((diagnostic) => withSourcePath(diagnostic, sources));

  if (flattened !== undefined) {
    diagnostics.push(...flattened.diagnostics);
    // §V83: a recursive graph expands for ever. It stops here, with the cycle named.
    if (flattened.recursion !== null) return emptyPlan(stamp(diagnostics), [], sourceRows);
  }
  const graph = flattened?.graph ?? request.graph;

  // A sink naming an instance has to follow it into the flattening (§V25, §V28).
  const explicitSinks: ReadonlyArray<ActiveSink> | undefined =
    flattened === undefined
      ? request.sinks
      : [
          ...(request.sinks ?? []).map((sink) => redirectSink(sink, flattened.instanceOutputs)),
          ...flattened.sinks,
        ];

  // 1. definitions, parameters, connections (T24)
  const validatedRaw = validateGraph(graph, registry, request.resolution ?? {});
  diagnostics.push(...validatedRaw.diagnostics);

  // 1b. splice passthrough nodes (T223, §V130): a Null is a WIRE. Its consumers bind
  // the producer feeding it, the node emits nothing, and everything downstream of this
  // point — pruning, ordering, resources, passes — never sees it. Its output stays
  // addressable through the alias map, so previewing a Null costs exactly nothing.
  const splice = splicePassthroughNodes(validatedRaw);
  diagnostics.push(...splice.diagnostics);
  const validated = { nodes: splice.nodes, edges: splice.edges };
  const redirectedSinks = explicitSinks?.map((sink) => splice.redirectSink(sink));

  // 2. active sinks and pruning (T26, §V25)
  const sinkResolution = resolveSinks(validated.nodes, redirectedSinks);
  diagnostics.push(...sinkResolution.diagnostics);
  const { kept, pruned } = pruneToActiveSinks(validated.nodes, validated.edges, sinkResolution.sinks);
  diagnostics.push(...validateRequiredInputs(validated.nodes, validated.edges, kept));

  // 3. temporal split, cycle rejection, ordering (T25, §V4)
  const topology = orderNodes(kept, validated.edges);
  diagnostics.push(...topology.diagnostics);
  if (topology.cycles.length > 0) return emptyPlan(stamp(diagnostics), pruned, sourceRows);

  const incoming = new Map<NodeId, CompileEdge[]>();
  for (const edge of [...topology.currentFrameEdges, ...topology.temporalEdges].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const list = incoming.get(edge.target.nodeId);
    if (list === undefined) incoming.set(edge.target.nodeId, [edge]);
    else list.push(edge);
  }

  // Which outputs must exist as GPU resources: those a kept consumer reads, plus those an
  // active sink observes. Nothing else is allocated (§V8, §V25).
  const materialized = new Set<string>();
  for (const edge of [...topology.currentFrameEdges, ...topology.temporalEdges]) {
    materialized.add(outputKey(edge.source.nodeId, edge.source.portId));
  }
  for (const sink of sinkResolution.sinks) {
    if (!kept.has(sink.nodeId)) continue;
    const definition = validated.nodes.get(sink.nodeId)?.definition;
    if (definition === undefined) continue;
    // A sink observes a named port, or the node's first materializable slot — which for a
    // node with no output ports is the render target it presents into.
    const portId = sink.portId ?? outputSlots(definition)[0]?.portId;
    if (portId === undefined) continue;
    materialized.add(outputKey(sink.nodeId, portId));
  }

  // 4. resolution and format propagation (T27, T72, T28, T75)
  const base: PropagationArgs = {
    order: topology.order,
    nodes: validated.nodes,
    incoming,
    materialized,
    request,
    seed: undefined,
    collectDiagnostics: false,
  };
  const firstSweep = propagate(base);
  const propagated = propagate({ ...base, seed: firstSweep.outputs, collectDiagnostics: true });
  diagnostics.push(...propagated.diagnostics);

  // 5. one persistent resource per materialized output (T29, §V6, §V8). Pointset
  // markers emit NO resource — their storage is the per-attribute pairs the producing
  // node's scratch declares (T121/T176).
  const resources: Array<Record<string, unknown>> = [];
  for (const output of propagated.outputs.values()) {
    if (output.resourceKind === "pointset") continue;
    resources.push(describeResource(output));
  }

  // 6. compile each node exactly once (T32, §V6)
  const passes: Array<Record<string, unknown>> = [];
  /** BufferPair scratch ids emitted this compile; each gets a swap after all consumers (§V22). */
  const scratchPairIds: string[] = [];
  for (const nodeId of topology.order) {
    const resolved = validated.nodes.get(nodeId);
    if (resolved === undefined) continue;
    const { node, definition } = resolved;

    const inputs: Record<PortId, CompiledInputBinding[]> = {};
    for (const port of definition.inputs) inputs[port.id] = [];
    for (const edge of incoming.get(nodeId) ?? []) {
      const upstream = propagated.outputs.get(outputKey(edge.source.nodeId, edge.source.portId));
      if (upstream === undefined) continue;
      inputs[edge.target.portId]?.push({
        portId: edge.target.portId,
        resourceId: upstream.resourceId,
        sampler: SHARED_SAMPLER_ID,
        sourceNodeId: edge.source.nodeId,
        sourcePortId: edge.source.portId,
        size: upstream.size,
        format: upstream.format,
        space: upstream.space,
        temporal: edge.temporal,
      });
    }

    const outputBindings: Record<PortId, CompiledOutputBinding> = {};
    let target: string | undefined;
    let resolution: readonly [number, number] | undefined;
    let format: TextureFormat | undefined;
    let space: ColorSpace | undefined;
    for (const slot of outputSlots(definition)) {
      const output = propagated.outputs.get(outputKey(nodeId, slot.portId));
      if (output === undefined) continue;
      outputBindings[slot.portId] = {
        portId: slot.portId,
        resourceId: output.resourceId,
        size: output.size,
        format: output.format,
        space: output.space,
        temporal: output.temporal,
      };
      if (target === undefined && output.resourceKind !== "pointset") {
        target = output.resourceId;
        resolution = output.size;
        format = output.format;
        space = output.space;
      }
    }

    const context: CompilerNodeContext = {
      nodeId,
      nodeType: node.type,
      parameters: resolved.parameters,
      resolution: resolution ?? [settings.outputResolution.width, settings.outputResolution.height],
      format: format ?? settings.workingFormat,
      space: space ?? colorSpaceForFormat(format ?? settings.workingFormat),
      target,
      inputs,
      outputs: outputBindings,
      sampler: SHARED_SAMPLER_ID,
      projectResolution: [settings.outputResolution.width, settings.outputResolution.height],
    };

    let description: CompiledNodeDescription;
    try {
      description = definition.compile(context);
    } catch (error) {
      // A definition that throws is a bug in that definition, not a reason to lose the
      // rest of the graph (§V9).
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.nodeCompileFailed,
          `Node "${nodeId}" (${node.type}) failed to compile: ${describeError(error)}.`,
          { nodeId },
        ),
      );
      continue;
    }
    diagnostics.push(...(description.diagnostics ?? []));

    // T147: scratch targets — node-private intermediates for multi-pass work (a
    // separable blur's horizontal leg). Read structurally so the frozen
    // CompiledNodeDescription contract needs no change to start using them; the typed
    // field can land in the manifest types later without touching this code. Sized from
    // the node's resolved output (scale-relative, §V21 — never per frame), formatted
    // like it unless the entry says otherwise, and materialized as ordinary targets, so
    // T143 carry-over and the memory estimate cover them for free.
    const scratchRaw = (description as { scratch?: unknown }).scratch;
    if (scratchRaw !== undefined) {
      const baseSize = resolution ?? [settings.outputResolution.width, settings.outputResolution.height];
      const seenScratch = new Set<string>();
      const entries = Array.isArray(scratchRaw) ? scratchRaw : [];
      if (!Array.isArray(scratchRaw)) {
        diagnostics.push(
          compilerDiagnostic(
            "error",
            CompilerDiagnosticCode.scratchInvalid,
            `Node "${nodeId}" (${node.type}) declared a non-array scratch list.`,
            { nodeId },
          ),
        );
      }
      for (const raw of entries) {
        const entry = raw as { key?: unknown; scale?: unknown; format?: unknown; kind?: unknown; stride?: unknown; capacity?: unknown };
        const key = typeof entry.key === "string" && entry.key !== "" ? entry.key : undefined;
        // T121/T176: a bufferPair scratch entry — SoA point storage. One identity per
        // attribute; the compiler appends its swap after all consumers (§V22), and T143
        // carry-over keeps its contents across unrelated edits.
        if (entry.kind === "bufferPair") {
          const stride = entry.stride;
          const bufferCapacity = entry.capacity;
          if (
            key === undefined ||
            seenScratch.has(key) ||
            !(Number.isInteger(stride) && (stride as number) >= 1) ||
            !(Number.isInteger(bufferCapacity) && (bufferCapacity as number) >= 1)
          ) {
            diagnostics.push(
              compilerDiagnostic(
                "error",
                CompilerDiagnosticCode.scratchInvalid,
                `Node "${nodeId}" (${node.type}) declared an invalid or duplicate bufferPair scratch entry ${JSON.stringify(raw)}.`,
                { nodeId, suggestion: 'A bufferPair entry is { key, kind: "bufferPair", stride >= 1, capacity >= 1 }.' },
              ),
            );
            continue;
          }
          seenScratch.add(key);
          const pairId = scratchResourceId(nodeId, key);
          resources.push({ kind: "bufferPair", id: pairId, stride, capacity: bufferCapacity, label: `${nodeId} points ${key}` });
          scratchPairIds.push(pairId);
          continue;
        }
        // T236: a single storage buffer — a reduction result, a lookup table. No pair,
        // no swap; readable between frames via readBuffer (§V48).
        if (entry.kind === "buffer") {
          const stride = entry.stride;
          const bufferCapacity = entry.capacity;
          if (
            key === undefined ||
            seenScratch.has(key) ||
            !(Number.isInteger(stride) && (stride as number) >= 1) ||
            !(Number.isInteger(bufferCapacity) && (bufferCapacity as number) >= 1)
          ) {
            diagnostics.push(
              compilerDiagnostic(
                "error",
                CompilerDiagnosticCode.scratchInvalid,
                `Node "${nodeId}" (${node.type}) declared an invalid or duplicate buffer scratch entry ${JSON.stringify(raw)}.`,
                { nodeId, suggestion: 'A buffer entry is { key, kind: "buffer", stride >= 1, capacity >= 1 }.' },
              ),
            );
            continue;
          }
          seenScratch.add(key);
          resources.push({
            kind: "buffer",
            id: scratchResourceId(nodeId, key),
            stride,
            capacity: bufferCapacity,
            usage: "storage",
            label: `${nodeId} ${key}`,
          });
          continue;
        }
        const scale =
          entry.scale === undefined
            ? 1
            : typeof entry.scale === "number" && Number.isFinite(entry.scale) && entry.scale > 0
              ? entry.scale
              : undefined;
        const scratchFormat =
          entry.format === undefined
            ? (format ?? settings.workingFormat)
            : typeof entry.format === "string" && (TEXTURE_FORMATS as readonly string[]).includes(entry.format)
              ? (entry.format as TextureFormat)
              : undefined;
        if (key === undefined || scale === undefined || scratchFormat === undefined || seenScratch.has(key)) {
          diagnostics.push(
            compilerDiagnostic(
              "error",
              CompilerDiagnosticCode.scratchInvalid,
              `Node "${nodeId}" (${node.type}) declared an invalid or duplicate scratch entry ${JSON.stringify(raw)}.`,
              { nodeId, suggestion: 'A scratch entry is { key: string, scale?: number > 0, format?: TextureFormat }.' },
            ),
          );
          continue;
        }
        seenScratch.add(key);
        resources.push({
          kind: "target",
          id: scratchResourceId(nodeId, key),
          size: [
            Math.max(1, Math.round(baseSize[0] * scale)),
            Math.max(1, Math.round(baseSize[1] * scale)),
          ],
          format: scratchFormat,
          label: `${nodeId} scratch ${key}`,
        });
      }
    }

    let emitted = 0;
    description.passes.forEach((raw, index) => {
      const pass = normalizePass(nodeId, target, index, raw, diagnostics);
      if (pass === undefined) return;
      passes.push(pass);
      emitted += 1;
    });

    if (emitted === 0 && target !== undefined) {
      diagnostics.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.nodeNoPasses,
          `Node "${nodeId}" (${node.type}) emitted no passes; its target "${target}" is left as-is.`,
          { nodeId },
        ),
      );
    }
  }

  // §V22: the pair swaps only after every current-frame consumer has been encoded. Placing
  // every swap after every effect pass satisfies that for any number of pairs, without the
  // per-pair last-consumer bookkeeping that would have to be right for all of them.
  const feedbackOutputs = [...propagated.outputs.values()].filter((output) => output.temporal);
  for (const output of feedbackOutputs) {
    passes.push({ kind: "swap", id: swapPassId(output.resourceId), resourceId: output.resourceId });
  }
  // Point-pair swaps ride the SAME placement rule as texture feedback: after every
  // pass, so no per-pair last-consumer bookkeeping has to be right for all pairs at
  // once (§V22). This frame's kernel writes become next frame's reads.
  for (const pairId of scratchPairIds) {
    passes.push({ kind: "swap", id: swapPassId(pairId), resourceId: pairId });
  }

  // One shared sampler for the plan. Emitted whenever anything renders: deciding per-plan
  // whether it is referenced would make the resource list depend on shader text, and a
  // sampler is the cheapest object the backend owns.
  if (passes.length > 0) {
    resources.unshift({ kind: "sampler", id: SHARED_SAMPLER_ID, filter: "linear", addressMode: "clamp-to-edge" });
  }

  // 7. emit (T30). The backend's own reader validates what we produced, so a shape
  // mismatch with `plan.ts` surfaces here as a diagnostic rather than at render time.
  const candidate: LogicalExecutionPlan = { passes, resources, diagnostics: [] };
  const read = readExecutionPlan(candidate);
  diagnostics.push(...read.diagnostics);

  // T150/B5: a texture binding that SAMPLES an unfilterable format is refused here,
  // with the node named, instead of surfacing as a cryptic vgpu bind error at render
  // time. r32float is renderable everywhere; sampling it through a sampler needs the
  // float32-filterable feature — a data texture avoids the whole question by declaring
  // `sampled: "unfiltered"` and reading with textureLoad (§V57).
  const formatById = new Map<string, TextureFormat>();
  for (const resource of read.resources) {
    if (resource.kind === "target" || resource.kind === "pingPong") formatById.set(resource.id, resource.format);
  }
  const float32Filterable = request.capabilities.features.includes("float32-filterable");
  for (const pass of read.passes) {
    if (pass.kind === "swap" || pass.kind === "counter") continue;
    for (const binding of pass.textures ?? []) {
      if (binding.sampled === "unfiltered") continue;
      if (formatById.get(binding.resourceId) !== "r32float" || float32Filterable) continue;
      diagnostics.push(
        compilerDiagnostic(
          "error",
          CompilerDiagnosticCode.bindingUnfilterable,
          `Pass "${pass.id}" samples "${binding.resourceId}" (r32float) through a sampler, but this device cannot filter 32-bit floats.`,
          {
            ...(pass.kind === "effect" && pass.nodeId !== undefined ? { nodeId: pass.nodeId } : {}),
            suggestion:
              'Read the texture with textureLoad and declare the binding { sampled: "unfiltered" }, or use a filterable format (§V57).',
          },
        ),
      );
    }
  }

  // §V24: the project memory budget is REPORTED, not enforced — per-resource caps are
  // already clamped upstream (resolution.ts), so exceeding the budget is a warning the
  // user can act on, never a refusal to render.
  const estimatedResourceBytes = estimateResourceBytes(read.resources);
  if (estimatedResourceBytes > settings.limits.memoryBudgetBytes) {
    const budgetMb = (settings.limits.memoryBudgetBytes / (1024 * 1024)).toFixed(0);
    const estimateMb = (estimatedResourceBytes / (1024 * 1024)).toFixed(1);
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.memoryBudget,
        `Estimated texture memory ${estimateMb} MB exceeds the project budget of ${budgetMb} MB.`,
        { suggestion: "Lower node or project resolutions, or raise the budget in project settings." },
      ),
    );
  }

  const feedback: FeedbackPair[] = feedbackOutputs.map((output) => {
    const definition = validated.nodes.get(output.nodeId)?.definition;
    return {
      resourceId: output.resourceId,
      nodeId: output.nodeId,
      portId: output.portId,
      size: output.size,
      format: output.format,
      swapPassId: swapPassId(output.resourceId),
      resetSignature:
        definition === undefined ? "[]" : feedbackResetSignature(definition, output, read.passes),
    };
  });

  // §V130: a spliced Null's output resolves to its producer's resource — same id, same
  // pixels, zero cost — so previews and readbacks of the Null keep working.
  const aliasOutputs: ResolvedOutput[] = [];
  for (const [alias, upstream] of splice.aliases) {
    const resolved = propagated.outputs.get(outputKey(upstream.nodeId, upstream.portId));
    if (resolved !== undefined) {
      aliasOutputs.push({ ...resolved, nodeId: alias.nodeId, portId: alias.portId });
    }
  }
  const outputs = [...propagated.outputs.values(), ...aliasOutputs].sort((a, b) =>
    outputKey(a.nodeId, a.portId).localeCompare(outputKey(b.nodeId, b.portId)),
  );

  // §V82: every diagnostic that names a node inside a component carries its source path.
  const reported = stamp(diagnostics);

  return {
    passes: read.passes,
    resources: read.resources,
    diagnostics: reported,
    ok: !hasError(reported),
    order: topology.order,
    pruned,
    outputs,
    feedback,
    sources: sourceRows,
    resourceSignatures: read.resources
      .map((resource) => ({ id: resource.id, signature: resourceStructureKey(resource) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    passSignatures: read.passes
      .map((pass) => ({ id: pass.id, signature: passStructureKey(pass) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    signature: planStructureSignature(read.resources, read.passes),
    estimatedResourceBytes,
  };
}
