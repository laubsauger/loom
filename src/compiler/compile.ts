import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { LogicalExecutionPlan } from "../domain/types/backend.ts";
import type { CompiledNodeDescription, NodeDefinition, TextureFormat } from "../domain/types/node-definition.ts";
import type { PortType } from "../domain/types/ports.ts";
import type { PassDescriptor, ResourceDescriptor } from "../runtime/backend/plan.ts";
import { estimateResourceBytes, planStructureSignature, readExecutionPlan } from "../runtime/backend/plan.ts";
import { describeError } from "../runtime/backend/diagnostics.ts";
import type { ColorSpace } from "./color-space.ts";
import { colorSpaceForFormat, resolveColorSpace } from "./color-space.ts";
import { CompilerDiagnosticCode, compilerDiagnostic, hasError } from "./diagnostics.ts";
import { resolveNodeFormat } from "./format.ts";
import { isDeclaredSink, pruneToActiveSinks, resolveSinks } from "./prune.ts";
import { resolveNodeResolution } from "./resolution.ts";
import {
  SHARED_SAMPLER_ID,
  SINK_TARGET_PORT,
  pingPongResourceId,
  swapPassId,
  targetResourceId,
} from "./resources.ts";
import { orderNodes } from "./topology.ts";
import { isTemporalOutput, validateGraph, validateRequiredInputs } from "./validate.ts";
import type { ResolvedNode } from "./validate.ts";
import { outputKey } from "./types.ts";
import type {
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
const NODE_EMITTABLE_PASS_KINDS: ReadonlySet<string> = new Set(["effect"]);

/** Pass kinds that render into a resource and therefore need a target. */
const TARGETED_PASS_KINDS: ReadonlySet<string> = new Set(["effect"]);

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
): "target" | "pingPong" | undefined {
  if (portType.kind !== "texture2d") return undefined;
  return temporal ? "pingPong" : "target";
}

interface OutputSlot {
  readonly portId: PortId;
  readonly resourceKind: "target" | "pingPong";
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
      spaceBindings.push({ portId: edge.target.portId, space: upstream.space });
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
    const space = resolveColorSpace({
      nodeId,
      nodeType: node.type,
      inputs: spaceBindings,
      resolved: colorSpaceForFormat(format.format),
      inherited: format.source === "policy" && definition.formatPolicy?.kind === "inherit",
    });

    if (collectDiagnostics) {
      diagnostics.push(...resolution.diagnostics, ...format.diagnostics, ...space.diagnostics);
    }

    for (const slot of outputSlots(definition)) {
      const key = outputKey(nodeId, slot.portId);
      if (!materialized.has(key)) continue;
      outputs.set(key, {
        nodeId,
        portId: slot.portId,
        resourceId:
          slot.resourceKind === "pingPong"
            ? pingPongResourceId(nodeId, slot.portId)
            : targetResourceId(nodeId, slot.portId),
        resourceKind: slot.resourceKind,
        size: resolution.size,
        format: format.format,
        space: space.space,
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
  }
}

/** Identity of one resource: what must be true for the existing GPU object to be reusable. */
function resourceSignature(resource: ResourceDescriptor): string {
  switch (resource.kind) {
    case "sampler":
      return JSON.stringify([
        "sampler",
        resource.filter ?? "nearest",
        resource.addressMode ?? "clamp-to-edge",
      ]);
    case "target":
    case "pingPong":
      return JSON.stringify([resource.kind, resource.size[0], resource.size[1], resource.format]);
    case "buffer":
      return JSON.stringify([resource.kind, resource.stride, resource.capacity, resource.usage]);
    case "bufferPair":
      return JSON.stringify([resource.kind, resource.stride, resource.capacity]);
  }
}

/** Identity of one pass. Uniform NAMES are part of it; uniform VALUES never are (§V5). */
function passSignature(pass: PassDescriptor): string {
  switch (pass.kind) {
    case "swap":
      return JSON.stringify(["swap", pass.resourceId]);
    case "effect":
      return JSON.stringify([
        "effect",
        pass.shader,
        pass.target,
        pass.clear ?? true,
        (pass.textures ?? []).map((texture) => [texture.binding, texture.resourceId]),
        (pass.samplers ?? []).map((sampler) => [sampler.binding, sampler.resourceId]),
        pass.uniformBinding ?? null,
        Object.keys(pass.uniforms ?? {}).sort(),
        pass.sharedBinding ?? null,
      ]);
    case "dispatch":
      return JSON.stringify([
        "dispatch",
        pass.shader,
        pass.entryPoint,
        typeof pass.workgroups === "object" && "indirect" in pass.workgroups
          ? ["indirect", pass.workgroups.indirect]
          : pass.workgroups,
        (pass.buffers ?? []).map((b) => [b.binding, b.resourceId]),
        (pass.textures ?? []).map((t) => [t.binding, t.resourceId]),
        Object.keys(pass.uniforms ?? {}).sort(),
      ]);
    case "draw":
      return JSON.stringify([
        "draw",
        pass.shader,
        pass.target,
        pass.topology,
        typeof pass.instances === "object" ? ["indirect", pass.instances.indirect] : "literal",
        (pass.buffers ?? []).map((b) => [b.binding, b.resourceId]),
        (pass.textures ?? []).map((t) => [t.binding, t.resourceId]),
      ]);
    case "counter":
      return JSON.stringify(["counter", pass.op, pass.resourceId, pass.outputResourceId ?? null]);
  }
}

function emptyPlan(diagnostics: ReadonlyArray<RuntimeDiagnostic>, pruned: ReadonlyArray<NodeId>): CompiledGraph {
  return {
    passes: [],
    resources: [],
    diagnostics,
    ok: !hasError(diagnostics),
    order: [],
    pruned,
    outputs: [],
    feedback: [],
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

export function compileGraph(request: CompileRequest): CompiledGraph {
  const { graph, registry, settings } = request;
  const diagnostics: RuntimeDiagnostic[] = [];

  // 1. definitions, parameters, connections (T24)
  const validated = validateGraph(graph, registry);
  diagnostics.push(...validated.diagnostics);

  // 2. active sinks and pruning (T26, §V25)
  const sinkResolution = resolveSinks(validated.nodes, request.sinks);
  diagnostics.push(...sinkResolution.diagnostics);
  const { kept, pruned } = pruneToActiveSinks(validated.nodes, validated.edges, sinkResolution.sinks);
  diagnostics.push(...validateRequiredInputs(validated.nodes, validated.edges, kept));

  // 3. temporal split, cycle rejection, ordering (T25, §V4)
  const topology = orderNodes(kept, validated.edges);
  diagnostics.push(...topology.diagnostics);
  if (topology.cycles.length > 0) return emptyPlan(diagnostics, pruned);

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

  // 5. one persistent resource per materialized output (T29, §V6, §V8)
  const resources: Array<Record<string, unknown>> = [];
  for (const output of propagated.outputs.values()) {
    resources.push(describeResource(output));
  }

  // 6. compile each node exactly once (T32, §V6)
  const passes: Array<Record<string, unknown>> = [];
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
      if (target === undefined) {
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

  const outputs = [...propagated.outputs.values()].sort((a, b) =>
    outputKey(a.nodeId, a.portId).localeCompare(outputKey(b.nodeId, b.portId)),
  );

  return {
    passes: read.passes,
    resources: read.resources,
    diagnostics,
    ok: !hasError(diagnostics),
    order: topology.order,
    pruned,
    outputs,
    feedback,
    resourceSignatures: read.resources
      .map((resource) => ({ id: resource.id, signature: resourceSignature(resource) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    passSignatures: read.passes
      .map((pass) => ({ id: pass.id, signature: passSignature(pass) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    signature: planStructureSignature(read.resources, read.passes),
    estimatedResourceBytes,
  };
}
