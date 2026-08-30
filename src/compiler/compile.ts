import type { NodeId, PortId } from "../domain/types/ids.ts";
import { compareEdgeOrder } from "../domain/graph/edge-order.ts";
import { nodeNames } from "../domain/graph/names.ts";
import { sourceReferenceTokens, sourceReferencesOf } from "../domain/graph/source-references.ts";
import type { ScenePayload } from "../domain/types/scene.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, GraphEdge } from "../domain/types/graph.ts";
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
import { colorPolicyOf, presentDecodesSrgbSource, sinkTargetSpace } from "../domain/color/display.ts";
import { CompilerDiagnosticCode, compilerDiagnostic, hasError } from "./diagnostics.ts";
import { bindingOverflows, describeOverflow } from "./bindings.ts";
import { flattenComponents, redirectSink, withSourcePath } from "./flatten.ts";
import type { ComponentSource } from "./flatten.ts";
import { resolveNodeFormat } from "./format.ts";
import { isDeclaredSink, pruneToActiveSinks, resolveSinks } from "./prune.ts";
import { resolveNodeResolution } from "./resolution.ts";
import {
  SHARED_SAMPLER_ID,
  SINK_TARGET_PORT,
  pingPongResourceId,
  pointsPreviewResourceId,
  scenePreviewResourceId,
  scratchResourceId,
  swapPassId,
  targetResourceId,
} from "./resources.ts";
import { POINTS_PREVIEW_VERTEX_COUNT, pointsPreviewWgsl } from "../nodes/shaders/points-preview.wgsl.ts";
import {
  CAMERA_PREVIEW_VERTEX_COUNT,
  SCENE_PREVIEW_BALL_VERTEX_COUNT,
  cameraPreviewWgsl,
  scenePreviewBallWgsl,
} from "../nodes/shaders/scene-preview.wgsl.ts";
import { cameraPayloadMatrix, viewProjection } from "../domain/geometry/camera.ts";
import { DEFAULT_MATERIAL } from "../domain/types/scene.ts";
import { applySubstepLoops, planSubstepLoops } from "./substeps.ts";
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
  PointsetEdgeInfo,
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

/**
 * The default framing every pointset preview shares (T373): an isometric-ish orbit at
 * the origin, aspect 1 for the square tile. One constant, not per-node state — the
 * viewer camera (T379) replaces the VALUE later, never the structure (§V5, §V330).
 */
const POINTS_PREVIEW_CAMERA = viewProjection([1.7, 1.2, 2.4], [0, 0, 0], { aspect: 1 });

/** Clip-space disc half-extent — ~3px on a 192px tile, readable without occluding. */
const POINTS_PREVIEW_POINT_SIZE = 0.03;

/**
 * T462: the stock rig every scene-payload preview shares. The ball camera looks
 * straight down -z so the ball's centre texel faces the viewer exactly — which is what
 * makes the §V147 pins below arithmetic instead of screenshots. The fill light's
 * direction has no z component, so its lambert term is ZERO at that centre texel: the
 * key alone sets the pinned value, and the fill only models the terminator.
 */
const SCENE_PREVIEW_CAMERA = viewProjection([0, 0, 2.6], [0, 0, 0], {
  fovY: Math.PI / 4,
  aspect: 1,
  near: 0.1,
  far: 10,
});
const SCENE_PREVIEW_EYE = [0, 0, 2.6, 0] as const;
const SCENE_PREVIEW_BACKGROUND = [0.055, 0.06, 0.075, 1] as const;
const SCENE_PREVIEW_AMBIENT = 0.08;
/** Straight down the preview axis: |N·L| = 1 at the ball's centre. */
const SCENE_PREVIEW_KEY = { direction: [0, 0, -1] as const, color: [1, 0.96, 0.9] as const, intensity: 0.85 };
/** No z component: contributes nothing at the centre texel, shapes the terminator. */
const SCENE_PREVIEW_FILL = { direction: [1, -0.4, 0] as const, color: [0.75, 0.85, 1] as const, intensity: 0.35 };

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
      // T375/B47, §V288: an `-srgb` sink target cannot be presented correctly. Its bytes
      // are display values, but `textureSample` DECODES them, and the present blit is a
      // raw copy (§V70a) into a canvas whose format is never an srgb variant — so the
      // viewer shows linear light where the preview and the exporter show the picture
      // (measured on Dawn: 54 against 127). Named rather than silently wrong.
      if (
        isDeclaredSink(definition) &&
        presentDecodesSrgbSource(colorPolicyOf(request.settings), format.format)
      ) {
        diagnostics.push(
          compilerDiagnostic(
            "warning",
            CompilerDiagnosticCode.sinkFormatUndisplayable,
            `Output "${nodeId}" renders to ${format.format}, which the viewer decodes on sample: ` +
              `the presented image will be lighter than the preview and the exported file.`,
            {
              nodeId,
              suggestion:
                'Use "rgba8unorm" (same depth, no hardware transfer) or "rgba16float" for this output, ' +
                'or set the project colour policy displayTransform to "none".',
            },
          ),
        );
      }
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
      // T375/B47 (§V56, §V57, §V70a): a declared SINK's target is what the viewer, the
      // preview tile and the exporter all look at, and the Output node applies the
      // project's display transform to it. The space it lands in is published HERE, from
      // the SAME function the node asks which shader to run, so the declaration and the
      // pixels are one decision rather than two that drift (B47 was exactly that drift).
      // A sink has no output PORT to carry `declaredColorSpace`, which is why this is not
      // the port-type mechanism above.
      const sinkSpace =
        slot.portId === SINK_TARGET_PORT
          ? sinkTargetSpace(colorPolicyOf(request.settings), format.format, space.space)
          : undefined;
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
        space: declaredSpace ?? sinkSpace ?? space.space,
        temporal: slot.resourceKind === "pingPong",
        // T299: only a plain target can carry a depth attachment in the current IR — a
        // ping-pong 3D history target would need depth on both halves (deferred until
        // something asks for it, loudly, rather than half-supported silently).
        ...(slot.resourceKind === "target" && definition.depthOutputs?.includes(slot.portId) === true
          ? { depth: true }
          : {}),
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
        ...(output.depth === true ? { depth: true } : {}),
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
  // T250 (B16): a MUTED node is silence — it, and every edge touching it, leaves the
  // compile graph. Its consumers see a disconnected input, which is the honest signal;
  // the mute badge already explains why. Removed before wires resolve, so a wire fed
  // only by a muted producer correctly reads as unconnected.
  const muted = new Set<NodeId>();
  for (const [nodeId, resolved] of validated.nodes) {
    if (resolved.node.ui?.muted === true) muted.add(nodeId);
  }
  const wires = new Map<NodeId, { input: PortId; output: PortId }>();
  const bypassDiagnostics: RuntimeDiagnostic[] = [];
  for (const [nodeId, resolved] of validated.nodes) {
    if (muted.has(nodeId)) continue;
    if (resolved.definition.passthrough !== undefined) {
      wires.set(nodeId, resolved.definition.passthrough);
      continue;
    }
    // T250 (B16): BYPASS makes any node a wire, TD-style — first input through to
    // first output. A bypassed source (no inputs) has nothing to pass and mutes
    // instead: its output reads disconnected, exactly what "temporarily off" means.
    //
    // T356: the wire must be TYPE-COHERENT. A converter (renderPoints: pointset in,
    // texture out) has no input a consumer of its output could bind — splicing one
    // handed downstream a pointset MARKER as a texture id and the plan exploded at
    // build (found by the cook oracle bypassing E9's renderPoints). The passthrough
    // is the first input whose port KIND matches the first output's; none matching
    // mutes instead, exactly like a source, with the reason said out loud.
    if (resolved.node.ui?.bypassed === true) {
      const output = resolved.definition.outputs[0];
      const input = resolved.definition.inputs.find(
        (port) => output !== undefined && port.type.kind === output.type.kind,
      );
      if (input !== undefined && output !== undefined) {
        wires.set(nodeId, { input: input.id, output: output.id });
      } else {
        muted.add(nodeId);
        if (resolved.definition.inputs.length > 0 && output !== undefined) {
          bypassDiagnostics.push(
            compilerDiagnostic(
              "warning",
              CompilerDiagnosticCode.bypassIncoherent,
              `Node "${nodeId}" (${resolved.node.type}) is bypassed, but no input matches its "${output.type.kind}" output — it is muted instead of wired through.`,
              { nodeId, suggestion: "Un-bypass it, or disconnect it while you work." },
            ),
          );
        }
      }
    }
  }
  if (wires.size === 0 && muted.size === 0) {
    return {
      nodes: validated.nodes,
      edges: validated.edges,
      aliases: [],
      redirectSink: (sink) => sink,
      diagnostics: bypassDiagnostics,
    };
  }

  const diagnostics: RuntimeDiagnostic[] = [...bypassDiagnostics];
  const edgesAfterMute =
    muted.size === 0
      ? validated.edges
      : validated.edges.filter(
          (edge) => !muted.has(edge.source.nodeId) && !muted.has(edge.target.nodeId),
        );
  /** First edge into each wire's declared input. */
  const feeding = new Map<NodeId, { nodeId: NodeId; portId: PortId }>();
  for (const edge of edgesAfterMute) {
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
  for (const edge of edgesAfterMute) {
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
    if (!wires.has(nodeId) && !muted.has(nodeId)) nodes.set(nodeId, resolved);
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
  const flatGraph = flattened?.graph ?? request.graph;

  // T350 (§V285): a SOURCE REFERENCE synthesizes the exact edge the wired shape had.
  // The document stays a DAG; everything downstream — V13 validation, inheritance
  // through the input, the temporal split, the pair, the swap — is the machinery that
  // already existed, so the ref and the wire compile to IDENTICAL plans by
  // construction. A dangling name and a ref-plus-wire ambiguity are both said here.
  const graph = ((): GraphDocument => {
    let synthesized: Record<string, GraphEdge> | undefined;
    const names = nodeNames(flatGraph);
    for (const nodeId of Object.keys(flatGraph.nodes).sort()) {
      const node = flatGraph.nodes[nodeId];
      if (node === undefined) continue;
      for (const spec of sourceReferencesOf(node.type)) {
        const tokens = sourceReferenceTokens(spec, node.parameters);
        const wired = Object.values(flatGraph.edges).find(
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
          const sourceNode = flatGraph.nodes[sourceId];
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
          synthesized ??= { ...flatGraph.edges };
          synthesized[edgeId] = {
            id: edgeId,
            source: { nodeId: sourceId, portId: sourcePort },
            target: { nodeId, portId: spec.input },
            ...(spec.list === true ? { order: index } : {}),
          };
        });
      }
    }
    return synthesized === undefined ? flatGraph : { ...flatGraph, edges: synthesized };
  })();

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

  // T373: `${nodeId}:${portId}` of every resolved PREVIEW sink. A pointset output that
  // appears here gets a synthesized splat pass below — and one that does not gets
  // nothing, which is what makes an OFF preview cost zero (§V297, §V309).
  const previewSinkKeys = new Set<string>();
  for (const sink of sinkResolution.sinks) {
    if (sink.kind !== "preview") continue;
    const sinkDefinition = validated.nodes.get(sink.nodeId)?.definition;
    if (sinkDefinition === undefined) continue;
    const sinkPort = sink.portId ?? outputSlots(sinkDefinition)[0]?.portId;
    if (sinkPort !== undefined) previewSinkKeys.add(outputKey(sink.nodeId, sinkPort));
  }
  const { kept, pruned } = pruneToActiveSinks(validated.nodes, validated.edges, sinkResolution.sinks);
  diagnostics.push(...validateRequiredInputs(validated.nodes, validated.edges, kept));

  // 3. temporal split, cycle rejection, ordering (T25, §V4)
  const topology = orderNodes(kept, validated.edges);
  diagnostics.push(...topology.diagnostics);
  if (topology.cycles.length > 0) return emptyPlan(stamp(diagnostics), pruned, sourceRows);

  const incoming = new Map<NodeId, CompileEdge[]>();
  // §V131: a variadic port's inputs arrive in the order the DOCUMENT declares, not in the
  // order their ids happen to sort — for Over, layer order is the operation. One
  // comparator, shared with the patch layer that writes the order (T225).
  for (const edge of [...topology.currentFrameEdges, ...topology.temporalEdges].sort(
    compareEdgeOrder,
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
  /** Ring scratch ids (T237); each gets its rotation placed after its last reader. */
  const scratchRingIds: string[] = [];
  /** T296: what each pointset OUTPUT resolved to, published by the producing node's compile. */
  const pointsetInfoByOutput = new Map<string, PointsetEdgeInfo>();
  /** T373: synthesized preview targets, later swapped into the outputs projection. */
  const pointsPreviewOutputs = new Map<string, ResolvedOutput>();
  /** T462: synthesized scene-payload preview targets, concatenated into the projection
   *  (a scene producer materializes no row of its own to replace). */
  const scenePreviewOutputs = new Map<string, ResolvedOutput>();
  /** T447: scene payloads (camera/light/geometry/material) per output — the pointsets
   *  channel's sibling, all CPU values, re-published on every animate recompile. */
  const sceneInfoByOutput = new Map<string, ScenePayload>();
  for (const nodeId of topology.order) {
    const resolved = validated.nodes.get(nodeId);
    if (resolved === undefined) continue;
    const { node, definition } = resolved;

    const inputs: Record<PortId, CompiledInputBinding[]> = {};
    for (const port of definition.inputs) inputs[port.id] = [];
    for (const edge of incoming.get(nodeId) ?? []) {
      const upstream = propagated.outputs.get(outputKey(edge.source.nodeId, edge.source.portId));
      const pointsetInfo = pointsetInfoByOutput.get(outputKey(edge.source.nodeId, edge.source.portId));
      const sceneInfo = sceneInfoByOutput.get(outputKey(edge.source.nodeId, edge.source.portId));
      if (upstream === undefined) {
        /*
         * T447: a scene producer (camera, light, geometry, material) materializes NO GPU
         * resource — its output is a CPU payload — so there is no ResolvedOutput to hand
         * over. The binding still exists: the payload IS the cargo, and the placeholder
         * resource fields are inert by construction (nothing binds a `scene:` id).
         */
        if (sceneInfo !== undefined) {
          inputs[edge.target.portId]?.push({
            portId: edge.target.portId,
            resourceId: `scene:${edge.source.nodeId}:${edge.source.portId}`,
            sampler: SHARED_SAMPLER_ID,
            sourceNodeId: edge.source.nodeId,
            sourcePortId: edge.source.portId,
            size: [1, 1],
            format: settings.workingFormat,
            space: colorSpaceForFormat(settings.workingFormat),
            temporal: false,
            scene: sceneInfo,
          });
        }
        continue;
      }
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
        ...(pointsetInfo === undefined ? {} : { pointset: pointsetInfo }),
        ...(sceneInfo === undefined ? {} : { scene: sceneInfo }),
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
      parameterMaps: resolved.parameterMaps,
      resolution: resolution ?? [settings.outputResolution.width, settings.outputResolution.height],
      format: format ?? settings.workingFormat,
      space: space ?? colorSpaceForFormat(format ?? settings.workingFormat),
      target,
      inputs,
      outputs: outputBindings,
      sampler: SHARED_SAMPLER_ID,
      projectResolution: [settings.outputResolution.width, settings.outputResolution.height],
      // T375 (§V56): the project's colour commitments, so the ONE node §V56 puts the
      // display transform in can read them. T84 recorded `colorPolicy` and nothing ever
      // read it — the §V220 shape, and the whole of B47.
      colorPolicy: colorPolicyOf(settings),
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
    // T296: the node's pointset OUTPUT map, published for downstream edges. Read
    // structurally like scratch, so the frozen contract needs no change to carry it.
    const pointsetsRaw = (description as { pointsets?: unknown }).pointsets;
    if (isRecord(pointsetsRaw)) {
      for (const [portId, rawInfo] of Object.entries(pointsetsRaw)) {
        if (!isRecord(rawInfo) || !isRecord(rawInfo["pairs"])) continue;
        const capacity = rawInfo["capacity"];
        if (!(Number.isInteger(capacity) && (capacity as number) >= 1)) continue;
        // T322 (§V231): each pair names the half holding this frame's data.
        const pairs: Record<string, { pair: string; half: "read" | "write"; type?: string }> = {};
        for (const [attribute, entry] of Object.entries(rawInfo["pairs"])) {
          if (!isRecord(entry)) continue;
          const pair = entry["pair"];
          const half = entry["half"];
          const attributeType = entry["type"];
          if (typeof pair !== "string" || pair.length === 0) continue;
          if (half !== "read" && half !== "write") continue;
          pairs[attribute] = {
            pair,
            half,
            ...(typeof attributeType === "string" ? { type: attributeType } : {}),
          };
        }
        const topology = rawInfo["topology"];
        const countRaw = rawInfo["count"];
        const countBuffer = isRecord(countRaw) ? countRaw["buffer"] : undefined;
        pointsetInfoByOutput.set(outputKey(nodeId, portId), {
          pairs,
          capacity: capacity as number,
          ...(typeof topology === "string" ? { topology } : {}),
          ...(typeof countBuffer === "string" && countBuffer.length > 0
            ? { count: { buffer: countBuffer } }
            : {}),
        });
      }
    }

    // T447: the scene channel — structural like `pointsets`, values-only in content.
    // Trusted as-is: producers are our own definitions, and a malformed payload fails
    // loudly at the consumer with the producer named (§V288).
    const sceneRaw = (description as { scene?: unknown }).scene;
    if (isRecord(sceneRaw)) {
      for (const [portId, payload] of Object.entries(sceneRaw)) {
        if (isRecord(payload) && typeof payload["kind"] === "string") {
          sceneInfoByOutput.set(outputKey(nodeId, portId), payload as unknown as ScenePayload);
        }
      }
    }

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
        const entry = raw as { key?: unknown; scale?: unknown; format?: unknown; kind?: unknown; stride?: unknown; capacity?: unknown; sourceId?: unknown; frames?: unknown; swap?: unknown; usage?: unknown };
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
          // T322 (§V231): a compacted pair declares swap:false — this frame's data
          // lands in the READ half by scatter, so the appended swap would hand next
          // frame the stale half. The edge map names the half consumers bind.
          if (entry.swap !== false) scratchPairIds.push(pairId);
          continue;
        }
        // T262 (§V135, §V167): a CPU-fed texture. The node names its media SOURCE; the
        // backend's registry supplies the frames. Sized to the node's resolved output,
        // so the per-node resolution override governs media like everything else.
        if (entry.kind === "external") {
          const sourceId = entry.sourceId;
          const externalFormat =
            entry.format === undefined
              ? "rgba8unorm"
              : typeof entry.format === "string" && (TEXTURE_FORMATS as readonly string[]).includes(entry.format)
                ? (entry.format as TextureFormat)
                : undefined;
          if (
            key === undefined ||
            seenScratch.has(key) ||
            typeof sourceId !== "string" ||
            sourceId.length === 0 ||
            externalFormat === undefined
          ) {
            diagnostics.push(
              compilerDiagnostic(
                "error",
                CompilerDiagnosticCode.scratchInvalid,
                `Node "${nodeId}" (${node.type}) declared an invalid or duplicate external scratch entry ${JSON.stringify(raw)}.`,
                { nodeId, suggestion: 'An external entry is { key, kind: "external", sourceId, format? }.' },
              ),
            );
            continue;
          }
          seenScratch.add(key);
          resources.push({
            kind: "externalTexture",
            id: scratchResourceId(nodeId, key),
            size: baseSize,
            format: externalFormat,
            sourceId,
            label: `${nodeId} ${key}`,
          });
          continue;
        }
        // T237 (§V226): a frame ring — N slices, one written per frame, taps reading
        // back. Sized like a target scratch (scale x the node's resolved size) because
        // §V228 says the depth AND the resolution are the user's to spend.
        if (entry.kind === "ring") {
          const frames = entry.frames;
          const ringScale =
            entry.scale === undefined
              ? 1
              : typeof entry.scale === "number" && Number.isFinite(entry.scale) && entry.scale > 0
                ? entry.scale
                : undefined;
          const ringFormat =
            entry.format === undefined
              ? (format ?? settings.workingFormat)
              : typeof entry.format === "string" && (TEXTURE_FORMATS as readonly string[]).includes(entry.format)
                ? (entry.format as TextureFormat)
                : undefined;
          if (
            key === undefined ||
            seenScratch.has(key) ||
            ringScale === undefined ||
            ringFormat === undefined ||
            !(Number.isInteger(frames) && (frames as number) >= 2)
          ) {
            diagnostics.push(
              compilerDiagnostic(
                "error",
                CompilerDiagnosticCode.scratchInvalid,
                `Node "${nodeId}" (${node.type}) declared an invalid or duplicate ring scratch entry ${JSON.stringify(raw)}.`,
                { nodeId, suggestion: 'A ring entry is { key, kind: "ring", frames >= 2, scale?, format? }.' },
              ),
            );
            continue;
          }
          seenScratch.add(key);
          const ringId = scratchResourceId(nodeId, key);
          resources.push({
            kind: "ring",
            id: ringId,
            size: [
              Math.max(1, Math.round(baseSize[0] * ringScale)),
              Math.max(1, Math.round(baseSize[1] * ringScale)),
            ],
            format: ringFormat,
            frames: frames as number,
            label: `${nodeId} ring ${key}`,
          });
          scratchRingIds.push(ringId);
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
            // T322: "indirect" marks GPU-consumed dispatch/draw arguments.
            usage: entry.usage === "indirect" ? "indirect" : "storage",
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

    /*
     * T373 (§V85): a node whose OUTPUT is a pointset gets a preview of its OWN — a splat
     * of its points into a synthesized square target — whenever a preview sink watches
     * that output. Keyed on the PORT KIND, never the node type (§V316, §V319): every
     * generator, kernel or converter with a point output — present and future — is
     * covered by construction, not by a list. No sink means no pass, no target, no
     * bytes: the P switch's off-costs-nothing (§V297, §V309) holds because the
     * synthesis is gated on the same sink set that gates texture materialization.
     *
     * The pass is appended AFTER the producer's own passes and binds the half that
     * holds THIS frame's data (§V168 via the edge map), so it draws what a consumer
     * this frame would see; binding the pair also makes the §V22 swap placement count
     * it as a consumer. A counted pointset (GPU lifecycle) gets the count-gated shader
     * so dead capacity slots collapse instead of splatting stale positions.
     */
    for (const slot of outputSlots(definition)) {
      if (slot.resourceKind !== "pointset") continue;
      const key = outputKey(nodeId, slot.portId);
      if (!previewSinkKeys.has(key)) continue;
      const info = pointsetInfoByOutput.get(key);
      const position = info?.pairs["position"];
      if (info === undefined || position === undefined) continue;
      const edgePx = Math.max(1, Math.round(settings.previewLongEdge));
      const previewId = pointsPreviewResourceId(nodeId, slot.portId);
      resources.push({
        kind: "target",
        id: previewId,
        size: [edgePx, edgePx],
        format: "rgba8unorm",
        label: `${nodeId}.${slot.portId} points preview`,
      });
      passes.push({
        kind: "draw",
        id: `${nodeId}#pointsPreview:${slot.portId}`,
        nodeId,
        shader: pointsPreviewWgsl({ counted: info.count !== undefined }),
        target: previewId,
        topology: "triangle-list",
        instances: info.capacity,
        vertexCount: POINTS_PREVIEW_VERTEX_COUNT,
        buffers: [
          { binding: "positions", resourceId: position.pair, half: position.half },
          ...(info.count === undefined ? [] : [{ binding: "counts", resourceId: info.count.buffer }]),
        ],
        uniforms: {
          // Fixed default framing for now; T379's viewer camera can drive this as a
          // VALUE update — the uniform is data, never structure (§V5, §V330).
          viewProjection: Array.from(POINTS_PREVIEW_CAMERA),
          pointSize: POINTS_PREVIEW_POINT_SIZE,
        },
        uniformBinding: "params",
        blend: "alpha",
      });
      pointsPreviewOutputs.set(key, {
        nodeId,
        portId: slot.portId,
        resourceId: previewId,
        resourceKind: "target",
        size: [edgePx, edgePx],
        format: "rgba8unorm",
        space: colorSpaceForFormat("rgba8unorm"),
        temporal: false,
      });
    }

    /*
     * T462 (§V85): a SCENE PAYLOAD output — camera, light, material — previews as its
     * own payload in a tiny stock scene, whenever a preview sink watches it. Keyed on
     * the PAYLOAD KIND, never the node type (§V316/§V319), exactly as the pointset
     * splat above keys on the port kind. Gated on the same sink set (§V309): off costs
     * nothing — no pass, no target, no bytes.
     *
     * Geometry ("scene" payloads) deliberately does NOT preview: its shape is already
     * the upstream pointset's splat, its material is the material node's ball, and what
     * it uniquely adds — the pairing — is what the render it feeds shows.
     *
     * Everything analytic (no buffers); a material's map textures bind because they ARE
     * its look, and the wires that carry them keep their producers alive. Payload
     * values land as uniforms with the render's own field names, so an orbiting light
     * animates its preview as a value update (§V5) and never a rebuild.
     */
    for (const port of definition.outputs) {
      const key = outputKey(nodeId, port.id);
      if (!previewSinkKeys.has(key)) continue;
      const payload = sceneInfoByOutput.get(key);
      if (payload === undefined || payload.kind === "geometry") continue;
      const edgePx = Math.max(1, Math.round(settings.previewLongEdge));
      const previewId = scenePreviewResourceId(nodeId, port.id);
      resources.push({
        kind: "target",
        id: previewId,
        size: [edgePx, edgePx],
        format: "rgba8unorm",
        depth: true,
        label: `${nodeId}.${port.id} ${payload.kind} preview`,
      });
      const passBase = {
        kind: "draw" as const,
        id: `${nodeId}#scenePreview:${port.id}`,
        nodeId,
        target: previewId,
        topology: "triangle-list" as const,
        instances: 1,
        uniformBinding: "params",
        clear: true,
      };
      if (payload.kind === "camera") {
        passes.push({
          ...passBase,
          shader: cameraPreviewWgsl(),
          vertexCount: CAMERA_PREVIEW_VERTEX_COUNT,
          uniforms: {
            viewProjection: Array.from(cameraPayloadMatrix(payload, 1)),
            background: [...SCENE_PREVIEW_BACKGROUND],
          },
        });
      } else if (payload.kind === "light") {
        // The stock ball in the DEFAULT material, lit by ONLY this light, zero
        // ambient: a light at zero intensity previews black — true, and the point.
        const light = payload.light;
        passes.push({
          ...passBase,
          shader: scenePreviewBallWgsl({ model: "lambert", lightCount: 1 }),
          vertexCount: SCENE_PREVIEW_BALL_VERTEX_COUNT,
          uniforms: {
            viewProjection: Array.from(SCENE_PREVIEW_CAMERA),
            eye: [...SCENE_PREVIEW_EYE],
            ambientColor: [0, 0, 0, 0],
            baseColor: [...DEFAULT_MATERIAL.baseColor],
            specular: [...DEFAULT_MATERIAL.specularColor, DEFAULT_MATERIAL.shininess],
            material: [DEFAULT_MATERIAL.metallic, DEFAULT_MATERIAL.roughness, 0, 0],
            background: [...SCENE_PREVIEW_BACKGROUND],
            light0Meta: [light.type === "point" ? 1 : 0, light.intensity, 0, 0],
            light0Color: [...light.color, 0],
            light0Vector: [...(light.type === "point" ? light.position : light.direction), 0],
          },
        });
      } else {
        // Material: the shaded ball under the fixed warm key and cool fill — the
        // model/specular mapping is the scene Render's own (T428's pbr-through-phong).
        const model =
          payload.model === "unlit" ? "unlit" : payload.model === "phong" || payload.model === "pbr" ? "phong" : "lambert";
        const specularColor =
          payload.model === "pbr"
            ? ([
                1 + (payload.baseColor[0] - 1) * payload.metallic,
                1 + (payload.baseColor[1] - 1) * payload.metallic,
                1 + (payload.baseColor[2] - 1) * payload.metallic,
              ] as const)
            : payload.specularColor;
        const shininess = payload.model === "pbr" ? 96 : payload.shininess;
        const maps = {
          ...(payload.maps.albedo === undefined ? {} : { albedo: true }),
          ...(payload.maps.roughness === undefined ? {} : { roughness: true }),
        };
        passes.push({
          ...passBase,
          shader: scenePreviewBallWgsl({ model, lightCount: 2, maps }),
          vertexCount: SCENE_PREVIEW_BALL_VERTEX_COUNT,
          ...(payload.maps.albedo === undefined && payload.maps.roughness === undefined
            ? {}
            : {
                textures: [
                  ...(payload.maps.albedo === undefined
                    ? []
                    : [{ binding: "albedoMap", resourceId: payload.maps.albedo, sampled: "unfiltered" as const }]),
                  ...(payload.maps.roughness === undefined
                    ? []
                    : [{ binding: "roughnessMap", resourceId: payload.maps.roughness, sampled: "unfiltered" as const }]),
                ],
              }),
          uniforms: {
            viewProjection: Array.from(SCENE_PREVIEW_CAMERA),
            eye: [...SCENE_PREVIEW_EYE],
            ambientColor: [1, 1, 1, SCENE_PREVIEW_AMBIENT],
            baseColor: [...payload.baseColor],
            specular: [...specularColor, shininess],
            material: [payload.metallic, payload.roughness, 0, 0],
            background: [...SCENE_PREVIEW_BACKGROUND],
            light0Meta: [0, SCENE_PREVIEW_KEY.intensity, 0, 0],
            light0Color: [...SCENE_PREVIEW_KEY.color, 0],
            light0Vector: [...SCENE_PREVIEW_KEY.direction, 0],
            light1Meta: [0, SCENE_PREVIEW_FILL.intensity, 0, 0],
            light1Color: [...SCENE_PREVIEW_FILL.color, 0],
            light1Vector: [...SCENE_PREVIEW_FILL.direction, 0],
          },
        });
      }
      scenePreviewOutputs.set(key, {
        nodeId,
        portId: port.id,
        resourceId: previewId,
        resourceKind: "target",
        size: [edgePx, edgePx],
        format: "rgba8unorm",
        space: colorSpaceForFormat("rgba8unorm"),
        temporal: false,
      });
    }
  }

  // §V22: the pair swaps only after every current-frame consumer has been encoded. Placing
  // every swap after every effect pass satisfies that for any number of pairs, without the
  // per-pair last-consumer bookkeeping that would have to be right for all of them.
  const feedbackOutputs = [...propagated.outputs.values()].filter((output) => output.temporal);
  for (const output of feedbackOutputs) {
    passes.push({ kind: "swap", id: swapPassId(output.resourceId), resourceId: output.resourceId });
  }
  // T297 (§V197, §V22): swap OWNERSHIP under copy-on-write. With by-reference reads, a
  // pair's consumers are found by WHO BINDS ITS ID — scanning every pass's buffer
  // bindings — never by graph reachability: a downstream node reading upstream's pair
  // by reference is invisible to reachability-from-the-owner, and swapping before it
  // would hand it next frame's half mid-frame, silently corrupting simulation state.
  // Each pair's swap is placed immediately after the LAST pass that binds it.
  const lastBinder = new Map<string, number>();
  passes.forEach((pass, index) => {
    const bindings = (pass as { buffers?: ReadonlyArray<{ resourceId?: unknown }> }).buffers ?? [];
    for (const binding of bindings) {
      if (typeof binding.resourceId === "string") lastBinder.set(binding.resourceId, index);
    }
  });
  // T237: a ring rotates under the SAME rule, because it has the same hazard — rotate
  // before a reader has run and its tap points one slice off, silently, for one frame per
  // rotation. Only the bindings differ: a ring's consumers bind it as a TEXTURE and its
  // producer names it as a render TARGET, where a buffer pair's do neither. The rule
  // (last pass that touches it, found by what passes bind rather than by reachability)
  // is the geometry track's, transferred rather than re-derived.
  const lastRingUser = new Map<string, number>();
  passes.forEach((pass, index) => {
    const textures = (pass as { textures?: ReadonlyArray<{ resourceId?: unknown }> }).textures ?? [];
    for (const binding of textures) {
      if (typeof binding.resourceId === "string") lastRingUser.set(binding.resourceId, index);
    }
    const target = (pass as { target?: unknown }).target;
    if (typeof target === "string") lastRingUser.set(target, index);
  });
  const swapsAt = new Map<number, string[]>();
  for (const pairId of scratchPairIds) {
    const at = lastBinder.get(pairId) ?? passes.length - 1;
    const list = swapsAt.get(at) ?? [];
    list.push(pairId);
    swapsAt.set(at, list);
  }
  for (const ringId of scratchRingIds) {
    const at = lastRingUser.get(ringId) ?? passes.length - 1;
    const list = swapsAt.get(at) ?? [];
    list.push(ringId);
    swapsAt.set(at, list);
  }
  for (const index of [...swapsAt.keys()].sort((a, b) => b - a)) {
    const swaps = (swapsAt.get(index) ?? []).sort();
    passes.splice(
      index + 1,
      0,
      ...swaps.map((pairId) => ({ kind: "swap", id: swapPassId(pairId), resourceId: pairId })),
    );
  }

  /*
   * 6b. SUBSTEPS (T387). Every pass and every swap now exists in topological order; this
   * step only says which of them run more than once per displayed frame, and moves them
   * together so a begin/end marker pair can say it. Nothing is allocated and nothing is
   * duplicated — `expandLoops` in the backend is what turns the region into iterations.
   *
   * It runs LAST, after swap placement, on purpose: §V22's rule (a pair swaps after its
   * last consumer) is what makes the region a complete iteration, so the region cannot be
   * worked out before the swaps are where they belong.
   */
  const substeps = planSubstepLoops({
    temporalOutputs: feedbackOutputs,
    nodes: validated.nodes,
    currentFrameEdges: topology.currentFrameEdges,
    temporalEdges: topology.temporalEdges,
  });
  diagnostics.push(...substeps.diagnostics);
  if (substeps.loops.length > 0) {
    const feeders = (bodyNodes: ReadonlySet<NodeId>): ReadonlySet<NodeId> => {
      const seen = new Set<NodeId>();
      const stack = [...bodyNodes];
      while (stack.length > 0) {
        const next = stack.pop() as NodeId;
        for (const edge of topology.currentFrameEdges) {
          if (edge.target.nodeId !== next) continue;
          const upstream = edge.source.nodeId;
          if (bodyNodes.has(upstream) || seen.has(upstream)) continue;
          seen.add(upstream);
          stack.push(upstream);
        }
      }
      return seen;
    };
    const reordered = applySubstepLoops(passes, substeps.loops, feeders, diagnostics);
    passes.length = 0;
    passes.push(...(reordered as ReadonlyArray<Record<string, unknown>>));
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
    if (pass.kind === "swap" || pass.kind === "counter" || pass.kind === "loop") continue;
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

  /**
   * T328/B33 — a pass that binds more than the device allows is refused HERE.
   *
   * The runtime net (T327) catches this too, and cannot catch it everywhere: a headless
   * render and a CI run have no session to report through, and the user on a stricter
   * device is exactly the person the author never reproduces. Nine storage buffers
   * against a limit of eight does not throw — pipeline creation fails, dispatches
   * silently no-op, and the plan compiles clean while frames keep "rendering". So this is
   * an ERROR: a plan the GPU will decline is not a plan.
   */
  for (const overflow of bindingOverflows(read.passes, request.capabilities)) {
    diagnostics.push(
      compilerDiagnostic("error", CompilerDiagnosticCode.bindingBudget, describeOverflow(overflow), {
        ...(overflow.nodeId === undefined ? {} : { nodeId: overflow.nodeId as NodeId }),
        suggestion: overflow.remedy,
      }),
    );
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
  // T373: a pointset output with a synthesized preview projects as that TARGET — a row
  // the preview system can bind — replacing the marker row for the same port. Without
  // the sink the marker row stands, exactly as before.
  const outputs = [...propagated.outputs.values()]
    .map((output) => pointsPreviewOutputs.get(outputKey(output.nodeId, output.portId)) ?? output)
    .concat(aliasOutputs)
    // T462: scene-payload previews ADD rows — camera/light/material outputs never had
    // a materialized row to replace.
    .concat([...scenePreviewOutputs.values()])
    .sort((a, b) => outputKey(a.nodeId, a.portId).localeCompare(outputKey(b.nodeId, b.portId)));

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
