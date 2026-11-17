import type { NodeId } from "../domain/types/ids.ts";
import type { FlatGraph, GraphNode } from "../domain/types/graph.ts";
import { parameterDependencies } from "../domain/graph/parameter-dependencies.ts";
import type { NodeDefinition, CompiledNodeDescription, KernelStepsDeclaration, NodeFrameValues, NodeValueFunction, PassFrameValues } from "../domain/types/node-definition.ts";
import type { ScenePayload } from "../domain/types/scene.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { effectiveParameterSchema, resolveParameterSchema } from "../domain/parameters/resolve.ts";
import type { ChannelResolver, ParameterMapBinding, ParameterMorphs } from "../domain/parameters/resolve.ts";
import { parameterReadOptions } from "../domain/parameters/node-references.ts";
import { animatedParameterRoots } from "../domain/channels/graph-channels.ts";
import type { DrawPassDescriptor, PassDescriptor, UniformValues } from "../runtime/backend/plan.ts";
import { isUniformValue, readPass, samePassStructure } from "../runtime/backend/plan.ts";
import { compileGraphRetaining, descriptionStructureKey, normalizePass } from "./compile.ts";
import type { CompileGraphResult, RetainedCompile, RetainedNodeCompile } from "./compile.ts";
import { isParameterPolicy } from "./resolution.ts";
import { kernelStepsFor, substepCount } from "./substeps.ts";
import { lookCameraInputs } from "./look.ts";
import { flatteningReadsOf, resolveNodeParameters } from "./validate.ts";
import { scaleOutputPixels } from "./pixel-scale.ts";
import { timeProbeFor } from "./time-probe.ts";
import { outputPixelScale } from "../domain/types/graph.ts";
import type { ParameterResolution } from "./validate.ts";
import { outputKey } from "./types.ts";
import type { ActiveSink, CompileRequest, CompiledGraph, CompiledInputBinding, CompilerNodeContext } from "./types.ts";

/**
 * The per-frame VALUES-ONLY compile (T1182, T1183, §V936).
 *
 * ## What it replaces
 *
 * An animated document re-ran the whole of `compileGraph` on every frame — flatten
 * reuse aside: every node's parameters re-resolved, the graph re-pruned and re-ordered,
 * resolution and format re-propagated, every node re-compiled, every pass re-keyed —
 * and the frame loop then read back exactly one thing from the result: the uniform
 * VALUES of each pass and the count of each loop-begin marker (`animate-parameters.ts`).
 * Measured on E24 that was 0.85 ms a frame of which ~85% produced nothing the consumer
 * looked at (`docs/perf-profile-2026-09-08.md` item 5).
 *
 * ## What it does instead
 *
 * ONE full compile per graph revision (`prepare`), which keeps, per compiled node, the
 * context it was compiled with, the pass ids it emitted and the structural half of its
 * description (`RetainedNodeCompile`). A frame then:
 *
 *   1. re-resolves parameters for the nodes that ANIMATE (expression / driven / bind —
 *      `animatedRootKeys` mirrors `nodeHasAnimatedParameters` — and, T1497b, a key a
 *      preset morph record covers), through the same resolver and the same `op()` reader
 *      the full compile uses (§V61, §V939);
 *   2. re-runs `definition.compile` for those nodes, and for every node downstream of
 *      them through a SCENE PAYLOAD edge — a payload is a CPU value that travels
 *      (camera → render), so its consumers' uniforms move when it does;
 *   3. PROVES each re-run is structure-preserving: same scratch and pointset
 *      declarations (`descriptionStructureKey`), same pass ids in the same order, and
 *      the same structure per pass as the base plan's (`samePassStructure`: what
 *      `passStructureKey` compares, without serialising the shader text to do it) — and
 *   4. splices the re-emitted passes over the base plan's, re-deriving loop-begin counts
 *      through `substepCount`, so the result's `signature` is the base's by construction.
 *
 * ## What it refuses, and how
 *
 * Two gates, both loud in the result rather than silent (§V936):
 *
 *   - the CLASSIFIER (`structuralParameterKeys`): a node animating a parameter the
 *     DEFINITIONS declare structural — `compileTime: true` in its effective schema, or a
 *     key a `kind: "parameter"` resolution policy reads — makes the whole document
 *     ineligible (`uniformOnly === false`, `reason` names the node and key), because the
 *     full compile would let that parameter change resolution, shader text or resources;
 *   - the VERIFIER (step 3): a definition whose structure depends on a parameter it did
 *     NOT declare `compileTime` is caught per frame; `compileFrame` returns `null`, the
 *     path stays degraded for the life of the prepared compiler (`reason` says why), and
 *     the caller falls through to the full compile — which is exactly what it did before
 *     this file existed, so a lying definition costs a fallback, never a wrong picture.
 *
 * `outputWhen` and `msaaWhen` read STORED parameters (`compile.ts` propagate), never
 * resolved ones, so they cannot vary with the frame inside a revision (T1176's finding);
 * the keys they read are `compileTime` today and `frame-compile.test.ts` derives that from
 * the registry rather than trusting it.
 *
 * ## What the result IS
 *
 * `{ ...base, passes }`: the base plan with pass uniforms and loop counts at the frame.
 * `diagnostics`, `outputs` (preview synthesis included), `feedback` and every signature
 * are the BASE's — the only consumer (`pushAnimatedValues`) reads passes and nothing
 * else, and the full per-frame compile's versions of those fields were discarded too. A
 * caller that needs per-frame diagnostics runs `compileGraph` with a `resolution`.
 */

export interface FrameCompiler {
  /** The full compile at the request's own resolution — the plan every frame is spliced over. */
  readonly base: CompiledGraph;
  /**
   * True when every animated parameter of every compiled node is a VALUE by declaration.
   * False means `compileFrame` always returns `null` and `reason` says which node and key.
   */
  readonly uniformOnly: boolean;
  /** Why the fast path is off or has degraded; `null` while it is live. */
  readonly reason: string | null;
  /**
   * The base plan with uniforms and loop counts at `resolution`, or `null` when this
   * frame could not be proven structure-preserving — the caller then compiles in full.
   */
  compileFrame(resolution: ParameterResolution): CompiledGraph | null;
}

/**
 * Root keys of the parameters that CAN read the frame: expression, driven or bind mode.
 * A component key (`color.g`) counts under its compound's root, because `compileTime`
 * is declared on the compound. The mode list is ONE function, `animatedParameterRoots`
 * (`graph-channels.ts`), which `nodeHasAnimatedParameters` and the value graph read too.
 *
 * T1497b: plus every key a preset MORPH record covers. A morphing key stores a plain
 * value — the destination — so no mode gives it away; the index is what knows (the
 * design doc §5.3). The index only ever lists keys that may fade, never a structural
 * one (`morphableKey`), so a morph cannot push a document off the values-only path.
 */
export function animatedRootKeys(node: GraphNode, morphs?: ParameterMorphs): ReadonlySet<string> {
  const keys = new Set<string>(animatedParameterRoots(node));
  for (const key of morphs?.keysOf(node.id) ?? []) keys.add(key.split(".")[0] as string);
  return keys;
}

/**
 * The parameters of ONE node whose value the compiler treats as STRUCTURE, derived from
 * the definition rather than listed: every key the effective schema marks
 * `compileTime`, plus the two a `kind: "parameter"` resolution policy reads for the
 * node's size (`resolution.ts`). A parameter outside this set may change nothing but
 * uniform values — `frame-compile.test.ts` perturbs every such parameter of every
 * registered node type and checks that claim against the full compile.
 */
export function structuralParameterKeys(
  definition: NodeDefinition,
  stored: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const schema = effectiveParameterSchema(definition, stored);
  for (const [key, parameter] of Object.entries(schema)) {
    if (parameter.compileTime === true) keys.add(key);
  }
  // The frozen ResolutionPolicy union has no "parameter" member yet (see resolution.ts,
  // T151), so the guard narrows from `unknown` exactly as the resolver itself does.
  const policy: unknown = definition.resolutionPolicy;
  if (isParameterPolicy(policy)) {
    keys.add(policy.width);
    keys.add(policy.height);
  }
  return keys;
}

interface FrameValues {
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly parameterMaps: Readonly<Record<string, ParameterMapBinding>>;
}

/** A node that animates, with what its per-frame resolution needs, computed once. */
interface AnimatedNode {
  readonly nodeId: NodeId;
  readonly record: RetainedNodeCompile;
  readonly schema: ReturnType<typeof effectiveParameterSchema>;
  /** T1719b: the part of `schema` that can move: the node's animated root keys (`animatedRootKeys`). */
  readonly moving: ReturnType<typeof effectiveParameterSchema>;
}

function classify(
  retained: RetainedCompile,
  /** T1652b: re-resolve exactly these nodes, animated or not (`rebaseOnValues`). */
  only?: ReadonlySet<NodeId>,
): { animated: AnimatedNode[]; reason: string | null } {
  const animated: AnimatedNode[] = [];
  for (const nodeId of retained.order) {
    const record = retained.nodes.get(nodeId);
    if (record === undefined) continue;
    if (only !== undefined && !only.has(nodeId)) continue;
    const keys = animatedRootKeys(record.node, retained.morphs);
    if (keys.size === 0 && only === undefined) continue;
    const structural = structuralParameterKeys(record.definition, record.node.parameters);
    for (const key of [...keys].sort()) {
      if (structural.has(key)) {
        return {
          animated,
          reason: `Node "${nodeId}" (${record.node.type}) animates "${key}", which is structural (compileTime or a resolution policy input); every frame compiles in full.`,
        };
      }
    }
    const schema = effectiveParameterSchema(record.definition, record.node.parameters);
    animated.push({
      nodeId,
      record,
      schema,
      // A rebase re-resolves a node because a STORED value moved: all of it can move then.
      moving: only !== undefined ? schema : Object.fromEntries(Object.entries(schema).filter(([key]) => keys.has(key))),
    });
  }
  return { animated, reason: null };
}

function bindingsReadScene(
  inputs: CompilerNodeContext["inputs"],
  recompiled: ReadonlySet<NodeId>,
): boolean {
  for (const bindings of Object.values(inputs)) {
    for (const binding of bindings) {
      if (binding.scene !== undefined && recompiled.has(binding.sourceNodeId)) return true;
    }
  }
  return false;
}

function withScenePayloads(
  inputs: CompilerNodeContext["inputs"],
  scene: ReadonlyMap<string, ScenePayload>,
): CompilerNodeContext["inputs"] {
  const next: Record<string, CompiledInputBinding[]> = {};
  for (const [portId, bindings] of Object.entries(inputs)) {
    next[portId] = bindings.map((binding) => {
      if (binding.scene === undefined) return binding;
      const payload = scene.get(outputKey(binding.sourceNodeId, binding.sourcePortId));
      return payload === undefined || payload === binding.scene ? binding : { ...binding, scene: payload };
    });
  }
  return next;
}

function sameSinks(
  a: ReadonlyArray<ActiveSink> | undefined,
  b: ReadonlyArray<ActiveSink> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((sink, index) => {
    const other = b[index] as ActiveSink;
    return sink.nodeId === other.nodeId && sink.portId === other.portId && sink.kind === other.kind;
  });
}

/**
 * Whether a base compiled for `built` IS the compile `request` would produce (T1254).
 *
 * The compiler is pure, so identical inputs are the proof: every input the plan depends
 * on must be the same object (sinks by value — a caller without a sink store derives a
 * fresh array per request), and both must be FRAMELESS with one channel reader, because
 * a base resolved at a frame carries that frame's values in every pass the frames do not
 * re-emit. Returns the first input that differs, or `null`.
 */
function baseMismatch(built: CompileRequest, request: CompileRequest): string | null {
  if (built.graph !== request.graph) return "graph";
  if (built.flattened !== request.flattened) return "flattened";
  if (built.settings !== request.settings) return "settings";
  if (built.registry !== request.registry) return "registry";
  if (built.capabilities !== request.capabilities) return "capabilities";
  if (built.components !== request.components) return "components";
  if (!sameSinks(built.sinks, request.sinks)) return "sinks";
  if (built.resolution?.frame !== undefined || request.resolution?.frame !== undefined) return "resolution.frame";
  if (built.resolution?.channels !== request.resolution?.channels) return "resolution.channels";
  return null;
}

/**
 * One full compile, then frames at the cost of the nodes that animate.
 *
 * `request.resolution` is the BASE's moment (the structural compile passes its channel
 * resolver and no frame); each `compileFrame` supplies its own.
 *
 * T1254: a caller that has ALREADY compiled `request` in full hands that result in as
 * `base` and no second compile happens — the app's structural memo compiles once per
 * revision and the frames splice over that very plan, which is also what makes the
 * frame loop's `isUniformOnlyChange` check hold by identity rather than by luck. A base
 * built for a different request is a wrong plan wearing a fast path, so it is REFUSED
 * with a throw (a caller bug, not a frame to degrade on): the compiler's own record of
 * what it compiled (`retained.request`) is compared input by input.
 */
/**
 * T1684b — ONE ANSWER PER CHANNEL ADDRESS A FRAME.
 *
 * The reader asks the resolver once per READ: sentinel-bot reads 88 addresses about 3,500
 * times a frame, and in the app each ask walks Analyze, MIDI, OSC, depth and Vision before
 * the value graph answers. Within one frame's compile nothing those read can move (the
 * value graph has evaluated, and the compile runs to the end without yielding), and every
 * ask of this reader carries this frame, so an address's first answer is all of its
 * answers. `undefined` ("nobody publishes it") is remembered too.
 *
 * The frame's own reader only. The time probe reads at other moments, and keeps the
 * resolver as it was given (`timeProbeFor`).
 */
/**
 * T1719b — THE BASE PASSES WITH THIS FRAME'S VALUES SWAPPED IN (V1031).
 *
 * Everything but the values is the base pass's own object, so there is nothing to normalise,
 * read again or compare: structure cannot move by a route that has no field for it. What a
 * value function CAN get wrong is the shape of the values themselves, which is checked here
 * for the price of copying them: one entry per base pass, and each uniform block with exactly
 * its base block's keys (the names are structure, `samePassStructure`) holding uniform values.
 * Anything else degrades the lane by name, as the verifier does for a re-emitted node (§V936).
 */
function passesWithValues(
  nodeId: NodeId,
  record: RetainedNodeCompile,
  values: NodeValueFunction,
  context: CompilerNodeContext,
  basePasses: ReadonlyMap<string, PassDescriptor>,
): { readonly passes: PassDescriptor[]; readonly scene: ReadonlyArray<readonly [string, ScenePayload]> } | string {
  const named = `Node "${nodeId}" (${record.node.type})`;
  let frame: NodeFrameValues;
  try {
    frame = values(context);
  } catch (error) {
    return `${named} threw while computing its values at this frame: ${error instanceof Error ? error.message : String(error)}.`;
  }
  if (frame.passes.length !== record.passIds.length) {
    return `${named} gave values for ${String(frame.passes.length)} passes at this frame and emitted ${String(record.passIds.length)} at the base.`;
  }
  const passes: PassDescriptor[] = [];
  for (let index = 0; index < record.passIds.length; index += 1) {
    const base = basePasses.get(record.passIds[index] as string);
    if (base === undefined) return `${named}: pass "${String(record.passIds[index])}" is not in the base plan.`;
    const moved = frame.passes[index] as PassFrameValues;
    if (moved.id !== undefined && `${nodeId}#${moved.id}` !== base.id) {
      return `${named} gave values for pass "${nodeId}#${moved.id}" where the base has "${base.id}".`;
    }
    const pass = withValues(base, moved);
    if (typeof pass === "string") return `${named} gave pass "${base.id}" ${pass}.`;
    passes.push(pass);
  }
  // A payload on every scene output the base published, and on no other: a consumer reads it
  // by the same key either way, and one left out would keep the base's (§V288's mirror hazard).
  const ports = record.scenePorts ?? [];
  const given = frame.scene === undefined ? [] : Object.keys(frame.scene);
  if (given.length !== ports.length || ports.some((port) => !given.includes(port))) {
    return `${named} gave scene payloads on [${given.join(", ")}] and published them on [${ports.join(", ")}] at the base.`;
  }
  const scene: Array<readonly [string, ScenePayload]> = [];
  for (const port of ports) {
    const payload = (frame.scene as Readonly<Record<string, ScenePayload>>)[port];
    if (typeof payload !== "object" || payload === null || typeof (payload as { kind?: unknown }).kind !== "string") {
      return `${named} gave output "${port}" a scene payload with no kind.`;
    }
    scene.push([port, payload]);
  }
  return { passes, scene };
}

/** The base pass with one frame's value fields in place, or what is wrong with them. */
function withValues(base: PassDescriptor, moved: PassFrameValues): PassDescriptor | string {
  let pass: PassDescriptor = base;
  if (moved.uniforms !== undefined) {
    const held = "uniforms" in base ? base.uniforms : undefined;
    const uniforms = held === undefined ? undefined : sameBlock(moved.uniforms, held);
    if (uniforms === undefined) return "a uniform block that is not its base block's names holding uniform values";
    pass = { ...pass, uniforms } as PassDescriptor;
  }
  if (moved.skip !== undefined || moved.instances !== undefined || moved.vertexCount !== undefined) {
    if (base.kind !== "draw") return "a draw's values, and it is not a draw";
    if (moved.instances !== undefined && (typeof base.instances !== "number" || !Number.isInteger(moved.instances) || moved.instances < 0)) {
      return "an instance count where its base count is not a literal, or that is not a whole number";
    }
    if (moved.vertexCount !== undefined && (!Number.isInteger(moved.vertexCount) || moved.vertexCount < 0)) return "a vertex count that is not a whole number";
    // A skip that is false is no skip: the reader keeps only `true` (`readDrawPass`).
    const { skip: _held, ...rest } = pass as DrawPassDescriptor;
    pass = {
      ...rest,
      ...(moved.skip === true || (moved.skip === undefined && _held === true) ? { skip: true } : {}),
      ...(moved.instances === undefined ? {} : { instances: moved.instances }),
      ...(moved.vertexCount === undefined ? {} : { vertexCount: moved.vertexCount }),
    };
  }
  if (moved.values !== undefined) {
    if (base.kind !== "write") return "a buffer write's rows, and it is not a buffer write";
    // The plan reader holds a write's rows to its capacity and its row layout; asked here as it is for a re-emitted one.
    const read = readPass({ ...base, values: moved.values });
    if (read === undefined) return "rows the plan reader refuses";
    pass = read;
  }
  return pass;
}

/**
 * `moved` itself, when it holds exactly `held`'s names and every value is a uniform value. Not
 * copied: a value function hands back a block made for this frame, and a plan's blocks are
 * read, never written (the re-emitted path's `readPass` builds its own the same way).
 */
function sameBlock(moved: Readonly<Record<string, unknown>>, held: Readonly<Record<string, unknown>>): UniformValues | undefined {
  let count = 0;
  for (const key in moved) {
    if (!Object.hasOwn(held, key) || !isUniformValue(moved[key])) return undefined;
    count += 1;
  }
  return count === namesIn(held) ? (moved as UniformValues) : undefined;
}

/** How many names a base block holds, counted once: the base's blocks are the same objects every frame. */
const namesHeld = new WeakMap<object, number>();
function namesIn(block: Readonly<Record<string, unknown>>): number {
  let count = namesHeld.get(block);
  if (count === undefined) {
    count = Object.keys(block).length;
    namesHeld.set(block, count);
  }
  return count;
}

function onceThisFrame(channels: ChannelResolver | undefined): ChannelResolver | undefined {
  if (channels === undefined) return undefined;
  const answers = new Map<string, ParameterValue | undefined>();
  return (channel, context) => {
    if (answers.has(channel)) return answers.get(channel);
    const answer = channels(channel, context);
    answers.set(channel, answer);
    return answer;
  };
}

export function prepareFrameCompiler(request: CompileRequest, base?: CompileGraphResult): FrameCompiler {
  if (base !== undefined && base.retained !== null) {
    const mismatch = baseMismatch(base.retained.request, request);
    if (mismatch !== null) {
      throw new Error(
        `prepareFrameCompiler: the supplied base was compiled for a different request (${mismatch} differs); compile the request itself or pass no base.`,
      );
    }
  }
  return frameCompilerOver(request, base ?? compileGraphRetaining(request));
}

/** T1652b: what a re-run left behind, for the caller that keeps it (`rebaseOnValues`). */
interface RerunCapture {
  /** The context each re-run node compiled with. */
  readonly contexts: Map<NodeId, CompilerNodeContext>;
  /** Scene payloads after the re-run. */
  scene: ReadonlyMap<string, ScenePayload> | null;
  /** What each re-run node said: resolving its parameters, then compiling them. */
  readonly said: Map<NodeId, RuntimeDiagnostic[]>;
}

function frameCompilerOver(
  request: CompileRequest,
  result: CompileGraphResult,
  only?: ReadonlySet<NodeId>,
): FrameCompiler & { compileFrame(resolution: ParameterResolution, capture?: RerunCapture): CompiledGraph | null } {
  const { compiled: base, retained } = result;
  if (retained === null) {
    return { base, uniformOnly: false, reason: "The compile produced no plan to splice over.", compileFrame: () => null };
  }
  const { animated, reason: classified } = classify(retained, only);
  if (classified !== null) {
    return { base, uniformOnly: false, reason: classified, compileFrame: () => null };
  }

  /* T1603b: the base's own passes, to compare a re-emitted one against where it stands
     (`samePassStructure`) instead of serialising it, shader text and all, every frame. */
  const basePasses = new Map<string, PassDescriptor>();
  for (const pass of base.passes) basePasses.set(pass.id, pass);
  /** Loop-begin markers, with the parameter whose value sets their count. */
  const loopCounts = new Map<string, { nodeId: NodeId; key: string }>();
  /** T1583b: kernel regions, whose count is two parameters' product (T1585b: or a rate's). */
  const kernelSteps = new Map<string, { nodeId: NodeId; declared: KernelStepsDeclaration }>();
  for (const pass of base.passes) {
    if (pass.kind !== "loop" || pass.edge !== "begin" || pass.nodeId === undefined) continue;
    const definition = retained.nodes.get(pass.nodeId)?.definition;
    if (pass.steps !== undefined) {
      if (definition?.steps !== undefined) kernelSteps.set(pass.id, { nodeId: pass.nodeId, declared: definition.steps });
      continue;
    }
    const key = definition?.temporal?.substeps;
    if (key !== undefined) loopCounts.set(pass.id, { nodeId: pass.nodeId, key });
  }

  let reason: string | null = null;
  const degrade = (why: string): null => {
    reason = why;
    return null;
  };

  const compileFrame = (resolution: ParameterResolution, capture?: RerunCapture): CompiledGraph | null => {
    if (reason !== null) return null;
    // T1497b: the morph index the BASE was compiled and classified with, unless the
    // caller brings its own — the same precedence `compileGraphRetaining` applies.
    const morphs = resolution.morphs ?? retained.morphs;
    // T1485b: the instances the BASE compile read through, by the same precedence.
    const instances = resolution.instances ?? retained.instances;
    // VN36: and the instance pages, the same way.
    const instancePages = resolution.instancePages ?? retained.instancePages;
    // The same reader `validateGraph` builds (§V939), asking each channel once (T1684b) and
    // evaluating each repeated subexpression once (T1720b): nothing it reads moves in a frame.
    const reader = parameterReadOptions({
      graph: retained.graph,
      registry: request.registry,
      frame: resolution.frame,
      channels: onceThisFrame(resolution.channels),
      flattening: flatteningReadsOf({ morphs, instances, instancePages }),
    }, { expressions: true });
    // Per-frame resolution diagnostics (a clamped expression, an unattached channel) are
    // dropped, exactly as the full per-frame compile's were by its one consumer.
    const discarded: RuntimeDiagnostic[] = [];
    const values = new Map<NodeId, FrameValues>();
    // T1432b: the same pixel scale the full compile gave the node's context.
    const pixelScale = outputPixelScale(retained.request.settings);
    for (const entry of animated) {
      // T1652b: a rebase keeps what the node said, exactly as `validateGraph` collects it:
      // the retained keys, the note and the version are what `validateGraph` passes too, so a
      // rebase compares what the node says with what it said there, sentence for sentence.
      // T1719b: a frame that keeps nothing the node says resolves without saying it: what
      // `resolveNodeParameters` adds to the values is diagnostics alone (a bind-cycle walk,
      // the undeclared keys, §T1641b), and every one of them would be discarded.
      const said: RuntimeDiagnostic[] | undefined = capture === undefined ? undefined : [];
      if (said === undefined) {
        // And only what can move: a key with no expression, driven, bind or morph is a stored
        // constant, resolved once in the base context already. The whole schema rides along
        // as the sibling schema, as §T1172's one-key resolve does, so a bind finds its sibling.
        const moved = resolveParameterSchema(entry.record.node, entry.moving, { ...reader, schema: entry.schema });
        values.set(entry.nodeId, {
          parameters: { ...entry.record.context.parameters, ...scaleOutputPixels(moved.values, entry.moving, pixelScale) },
          parameterMaps: { ...entry.record.context.parameterMaps, ...moved.maps },
        });
        continue;
      }
      const resolved = resolveNodeParameters(entry.record.node, entry.schema, entry.record.definition.type, said, reader, {
        retained: entry.record.definition.retainedParameterKeys,
        note: entry.record.definition.parameterKeysNote,
        otherVersion: entry.record.node.definitionVersion !== entry.record.definition.version,
      });
      if (said.length > 0) capture?.said.set(entry.nodeId, said);
      values.set(entry.nodeId, { parameters: scaleOutputPixels({ ...resolved.values }, entry.schema, pixelScale), parameterMaps: resolved.maps });
    }

    const scene = new Map(retained.scenePayloads);
    const recompiled = new Set<NodeId>();
    const replacements = new Map<string, PassDescriptor>();
    for (const nodeId of retained.order) {
      const record = retained.nodes.get(nodeId);
      if (record === undefined) continue;
      const frameValues = values.get(nodeId);
      const sceneMoved = bindingsReadScene(record.context.inputs, recompiled);
      // §T1732b: a look clone re-runs at every frame, because its look moves without a revision.
      const look = retained.looks.get(nodeId);
      const looked = look !== undefined && (only === undefined || only.has(nodeId));
      if (frameValues === undefined && !sceneMoved && !looked) continue;
      // T1421b: the probe moves with the frame, exactly as the full compile's does, and only
      // for a node whose motion something reads (T1721b).
      const probe = record.motionRead !== true ? undefined : timeProbeFor(record.node, record.definition, retained.graph, request.registry, { ...resolution, morphs, ...(instances === undefined ? {} : { instances }), ...(instancePages === undefined ? {} : { instancePages }) }, retained.request.settings);
      const context: CompilerNodeContext = {
        ...record.context,
        ...(frameValues === undefined ? {} : frameValues),
        inputs: looked
          ? lookCameraInputs(withScenePayloads(record.context.inputs, scene), look, look.orbit())
          : sceneMoved
            ? withScenePayloads(record.context.inputs, scene)
            : record.context.inputs,
        ...(probe === undefined ? {} : { timeProbe: probe }),
      };
      // T1719b: a node that handed back its value function is asked for this frame's values,
      // and its passes are the base's with them swapped in. A rebase (`capture`) still needs
      // what `compile` says, so it takes the path below.
      if (record.values !== undefined && capture === undefined) {
        const moved = passesWithValues(nodeId, record, record.values, context, basePasses);
        if (typeof moved === "string") return degrade(moved);
        for (const pass of moved.passes) replacements.set(pass.id, pass);
        for (const [portId, payload] of moved.scene) scene.set(outputKey(nodeId, portId), payload);
        recompiled.add(nodeId);
        continue;
      }
      let description: CompiledNodeDescription;
      try {
        description = record.definition.compile(context);
      } catch (error) {
        return degrade(`Node "${nodeId}" (${record.node.type}) threw while compiling a frame: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (descriptionStructureKey(description) !== record.structureKey) {
        return degrade(`Node "${nodeId}" (${record.node.type}) declared different scratch or pointset storage at this frame; a value-only parameter changed structure.`);
      }
      if (capture !== undefined) {
        capture.contexts.set(nodeId, context);
        if (description.diagnostics !== undefined && description.diagnostics.length > 0) {
          capture.said.set(nodeId, [...(capture.said.get(nodeId) ?? []), ...description.diagnostics]);
        }
      }
      const sceneRaw = (description as { scene?: unknown }).scene;
      if (typeof sceneRaw === "object" && sceneRaw !== null) {
        for (const [portId, payload] of Object.entries(sceneRaw as Record<string, unknown>)) {
          if (typeof payload === "object" && payload !== null && typeof (payload as { kind?: unknown }).kind === "string") {
            scene.set(outputKey(nodeId, portId), payload as ScenePayload);
          }
        }
      }
      const passes: PassDescriptor[] = [];
      for (let index = 0; index < description.passes.length; index += 1) {
        const normalized = normalizePass(nodeId, record.context.target, index, description.passes[index], discarded);
        const pass = normalized === undefined ? undefined : readPass(normalized);
        if (pass === undefined) {
          return degrade(`Node "${nodeId}" (${record.node.type}) emitted pass #${String(index)} that the plan reader refused at this frame.`);
        }
        passes.push(pass);
      }
      if (passes.length !== record.passIds.length) {
        return degrade(`Node "${nodeId}" (${record.node.type}) emitted ${String(passes.length)} passes at this frame, ${String(record.passIds.length)} at the base; a value-only parameter changed structure.`);
      }
      for (let index = 0; index < passes.length; index += 1) {
        const pass = passes[index] as PassDescriptor;
        const basePass = basePasses.get(pass.id);
        if (pass.id !== record.passIds[index] || basePass === undefined || !samePassStructure(pass, basePass)) {
          return degrade(`Node "${nodeId}" (${record.node.type}) emitted pass "${pass.id}" with a different structure at this frame; a value-only parameter changed structure.`);
        }
        replacements.set(pass.id, pass);
      }
      recompiled.add(nodeId);
    }

    const passes = base.passes.map((pass): PassDescriptor => {
      const replacement = replacements.get(pass.id);
      if (replacement !== undefined) return replacement;
      if (pass.kind !== "loop" || pass.edge !== "begin") return pass;
      const stepped = kernelSteps.get(pass.id);
      if (stepped !== undefined && pass.steps !== undefined) {
        /* T1585b: a RATE's count is this frame's own whether or not any parameter of the
           node animates, so it is re-derived from the node's base values when none does —
           which keeps this path saying what a full compile at this frame says. A count
           declaration with nothing animating has nothing that can have moved. */
        const node =
          values.get(stepped.nodeId) ??
          (typeof stepped.declared.substeps === "string" ? undefined : retained.nodes.get(stepped.nodeId)?.context);
        if (node === undefined) return pass;
        // The same function the full compile's region came from, so the two cannot disagree.
        // The backend derives a rate's count again, for the frame it renders.
        const { count, iterations, rate } = kernelStepsFor(stepped.declared, node.parameters, resolution.frame?.deltaSeconds ?? 0);
        const sameRate =
          rate === undefined
            ? pass.steps.rate === undefined
            : pass.steps.rate !== undefined &&
              rate.perSecond === pass.steps.rate.perSecond &&
              rate.min === pass.steps.rate.min &&
              rate.max === pass.steps.rate.max;
        return count === pass.count && iterations === pass.steps.iterations && sameRate
          ? pass
          : { ...pass, count, steps: { ...pass.steps, iterations, ...(rate === undefined ? {} : { rate }) } };
      }
      const loop = loopCounts.get(pass.id);
      const owner = loop === undefined ? undefined : values.get(loop.nodeId);
      if (loop === undefined || owner === undefined) return pass;
      const count = substepCount(owner.parameters[loop.key]);
      return count === pass.count ? pass : { ...pass, count };
    });
    if (capture !== undefined) capture.scene = scene;
    return { ...base, passes };
  };

  return {
    base,
    uniformOnly: true,
    get reason() {
      return reason;
    },
    compileFrame,
  };
}

/**
 * T1652b — who reads a node's VALUES, per retained compile, kept apart by HOW they read:
 *
 *  - `links`: a wire that carries a value or a payload, and a source named by a reference
 *    parameter (a Render's lights, a Feedback's source). What flows is baked into the
 *    reader when it compiles, and the per-frame compile re-bakes it only in a frame where
 *    the producer itself re-ran. So when a stored value moves, these readers move with it.
 *  - `expressions`: `op('a')` in an expression, a driven channel. A parameter that reads
 *    this way is resolved by the per-frame compile at EVERY frame (`animatedRootKeys`), from
 *    the document in hand and that frame's channels. Its value in a frameless plan is never
 *    what is drawn.
 *
 * Built once per structural compile, on the first value written after it, and carried from
 * each rebase to the next (a values-only revision changes no reference and no wire).
 */
interface ValueReaders {
  readonly links: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>;
  readonly expressions: ReadonlyMap<NodeId, ReadonlyArray<NodeId>>;
}

const VALUE_READERS = new WeakMap<RetainedCompile, ValueReaders>();

/** Port kinds that carry a GPU resource: what flows is pixels or points, never a parameter's value. */
const RESOURCE_PORT_KINDS: ReadonlySet<string> = new Set(["texture2d", "pointset", "buffer"]);

function valueReadersOf(retained: RetainedCompile, registry: CompileRequest["registry"]): ValueReaders {
  const known = VALUE_READERS.get(retained);
  if (known !== undefined) return known;
  const links = new Map<NodeId, NodeId[]>();
  const expressions = new Map<NodeId, NodeId[]>();
  const add = (table: Map<NodeId, NodeId[]>, source: NodeId, reader: NodeId): void => {
    const list = table.get(source);
    if (list === undefined) table.set(source, [reader]);
    else if (!list.includes(reader)) list.push(reader);
  };
  // §V154, the one traversal: an expression's `op('a')` and a driven channel are READS AT A
  // FRAME; every other kind is a source named by a reference parameter.
  for (const [reader, dependencies] of parameterDependencies(retained.graph)) {
    for (const dependency of dependencies) {
      add(dependency.kind === "reference" || dependency.kind === "driven" ? expressions : links, dependency.to, reader);
    }
  }
  // A wire that carries a VALUE: a value channel into the next value stage, a scene payload
  // into its consumer. A texture or a pointset wire carries a resource, and what its
  // consumer reads of the producer is structure (size, format, attributes).
  for (const edge of Object.values(retained.graph.edges)) {
    const source = retained.graph.nodes[edge.source.nodeId];
    const port = source === undefined ? undefined : registry.get(source.type)?.outputs.find((candidate) => candidate.id === edge.source.portId);
    if (port !== undefined && RESOURCE_PORT_KINDS.has(port.type.kind)) continue;
    add(links, edge.source.nodeId, edge.target.nodeId);
  }
  const readers: ValueReaders = { links, expressions };
  VALUE_READERS.set(retained, readers);
  return readers;
}

const saidKey = (said: ReadonlyArray<RuntimeDiagnostic> | undefined): string =>
  said === undefined || said.length === 0 ? "" : JSON.stringify(said);

/**
 * Whether two flattened nodes (or wires) are the same: the same object, or — a flattening
 * with instances mints a copy per walk — objects whose fields are the same objects, or say
 * the same. A document is JSON, so "says the same" is its serialisation; it is only asked
 * of the fields a copy rebuilt.
 */
function sameFlattened(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (left[key] === right[key]) continue;
    if (typeof left[key] !== "object" || left[key] === null || JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
  }
  return true;
}

/**
 * T1652b — THE VALUES LANE: the compile of `request`, from the compile of the revision
 * before it, when only VALUES moved between them (`classifyRevision` in the app says
 * which revisions those are, and which nodes were `written`).
 *
 * A value written on a 150-node document used to re-run the whole of `compileGraph`:
 * every node re-resolved, the graph re-pruned and re-ordered, every node re-compiled,
 * every pass re-keyed (10.8 ms of a 57 ms task, measured). The plan that came back
 * differed from the one before it in the uniform values of a handful of passes.
 *
 * This re-resolves the written nodes and what reads them through a LINK (a payload wire, a
 * reference parameter: `valueReadersOf`), and re-runs `definition.compile` for those,
 * through the per-frame compile's own re-run and UNDER ITS VERIFIER (§V936): same scratch
 * and pointset declarations, same pass ids in the same order, the same structure per pass.
 * Then it is the base plan with those passes spliced, and the base's retained records with
 * those nodes' moved, so the frames after it splice over this revision.
 *
 * ## What reads through an EXPRESSION is the frame's, not this function's
 *
 * A parameter with an expression is resolved by the per-frame compile at every frame, from
 * the retained document (which this function moves to the revision) and that frame's
 * channels; its uniform in a frameless plan is overwritten before anything is drawn. So a
 * value read through `op('slider').chan.x`, and everything downstream of that read, costs
 * a write NOTHING here and arrives with the next frame — which is when it arrived before,
 * because the frameless value this function used to push for it was a frame-zero value the
 * frame then replaced. Re-running that closure per write did, per write, what the frame
 * loop does per frame, and marked every pass in it dirty twice (measured on a 200-node
 * document: a control read by one expression whose channel most of the document reads,
 * 44 nodes re-resolved and 82 of 201 passes re-written for each value).
 *
 * The plan this returns is therefore NOT the full compile's pass for pass: it is the full
 * compile's wherever no expression is involved, and the FRAME compiled over it is the frame
 * compiled over the full compile's (`values-lane.test.ts` holds both).
 *
 * The one thing an expression reader is still asked, one hop out: the nodes that read a
 * WRITTEN node directly are resolved frameless and compared with what they SAID (a slider
 * dragged past the range of the opacity that reads it must raise its clamp warning). What
 * a node two or more reads away says is NOT asked on a value write: a finding that depends
 * on a value carried by a channel is a matter of the frame it is carried at, and the
 * frameless one in the Problems list stays as of the last structural revision until
 * §T1646b gives compiled nodes a per-frame problem carrier.
 *
 * Returns the reason, as a sentence, whenever it cannot PROVE the result is the full
 * compile's. The caller then compiles in full, which is what every revision did before
 * this existed, so a refusal costs time and never a wrong picture or a lost diagnostic:
 *
 *  - an input other than the document moved (settings, sinks, device, catalogue, reader);
 *  - the flattening differs anywhere but at the written nodes (a component instance);
 *  - a node that reads a written value animates a STRUCTURAL parameter;
 *  - a re-run node emitted another structure, or threw, or a loop's count moved;
 *  - a node SAYS something different about its new value: a diagnostic appeared, went or
 *    changed its words. Diagnostics are part of what a compile answers, and the spliced
 *    plan carries the base's.
 *
 * `frame-compile.test.ts` holds the result against `compileGraphRetaining(request)` pass
 * for pass on shipped examples.
 */
export function rebaseOnValues(previous: CompileGraphResult, request: CompileRequest, written: ReadonlyArray<NodeId>): CompileGraphResult | string {
  const { compiled: base, retained } = previous;
  if (retained === null) return "The compile before this value produced no plan to splice over.";
  if (!base.ok) return "The plan before this value has errors, so it is compiled in full.";
  const built = retained.request;
  for (const input of ["settings", "registry", "capabilities", "components"] as const) {
    if (built[input] !== request[input]) return `The compile's ${input} moved with the value.`;
  }
  if (!sameSinks(built.sinks, request.sinks)) return "The compile's sinks moved with the value.";
  if (built.resolution?.frame !== undefined || request.resolution?.frame !== undefined) return "A plan resolved at a frame is not a base.";
  if (built.resolution?.channels !== request.resolution?.channels) return "The compile's channel reader moved with the value.";

  const before = built.flattened?.graph;
  const after = request.flattened?.graph;
  if (before === undefined || after === undefined) return "No flattening to compare the two revisions by.";
  // The flattening of a document with no instance holds the document's OWN node and wire
  // objects (`identityFlattening`), so two revisions compare by reference. The walk of a
  // document with instances mints copies, and those are compared by what they say: the two
  // flattenings must differ at the written nodes and nowhere else.
  const wires = Object.keys(after.edges);
  if (wires.length !== Object.keys(before.edges).length || wires.some((id) => !sameFlattened(after.edges[id], before.edges[id]))) {
    return "The flattening's wires differ between the two revisions.";
  }
  const moved = new Set<NodeId>(written);
  const ids = Object.keys(after.nodes) as NodeId[];
  if (ids.length !== Object.keys(before.nodes).length) return "The flattening holds a different set of nodes.";
  for (const id of ids) {
    if (!moved.has(id) && !sameFlattened(after.nodes[id], before.nodes[id])) return `The flattening differs at "${id}", which was not written.`;
  }
  /*
   * T1655b: a WRITTEN node whose own scene-payload preview is being watched. That tile's
   * draw passes and their uniform values live on the node's ROW (`ResolvedOutput.synthesis`),
   * not in `passes`, and the splice below keeps the base's rows: the tile would go on
   * drawing the value before this one. Measured in the app before the lane existed, as the
   * camera gizmo (T692): the drag wrote the pose and the tile it was dragged on stood still.
   * So the revision is compiled in full, which mints the row afresh. It costs what every
   * revision cost before the lane, and only for an edit made ON a camera, light, material,
   * geometry or projector whose stock-scene tile is on screen. A pointset's splat is not
   * refused: its block is the stock rig and the granted tile, and no parameter reaches it.
   *
   * NOT refused, and so still stale (reported with T1655b, to be fixed by re-deriving the
   * rows from the payloads this re-run already captures): such a node that only READS the
   * written value, through an expression. Refusing there would send every slider that
   * tints a light down the structural road whenever that light's tile is on screen.
   */
  for (const id of moved) {
    const watched = base.outputs.some(
      (output) => output.nodeId === id && output.synthesis !== undefined && output.synthesis.kind !== "pointset",
    );
    if (watched) return `"${id}" is drawn on its own preview tile, whose values are on its row and not in a pass.`;
  }
  // §T1732b: a renderer drawn again for a look has a clone copied from it at the compile; a
  // value written on the renderer is compiled in full, which copies it again.
  for (const look of retained.looks.values()) {
    if (moved.has(look.renderer)) return `"${look.renderer}" is drawn again for a look, from a copy the full compile makes.`;
  }
  for (const id of moved) {
    if (after.nodes[id] === undefined) return `"${id}" was written and is not in the flattening.`;
    // The node the base read must be the flattening's own, not a timeline override of it.
    if (!sameFlattened(retained.graph.nodes[id], before.nodes[id])) return `The base compiled "${id}" under a structure override.`;
  }

  const readers = valueReadersOf(retained, request.registry);
  // Re-run: the written nodes and what reads them through links, as far as links go.
  const linked = new Set<NodeId>(moved);
  const queue = [...moved];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const reader of readers.links.get(next) ?? []) {
      if (linked.has(reader)) continue;
      linked.add(reader);
      queue.push(reader);
    }
  }
  // Asked what they say, and no more: the expressions that read a written node itself.
  const affected = new Set<NodeId>(linked);
  for (const id of moved) {
    for (const reader of readers.expressions.get(id) ?? []) affected.add(reader);
  }

  const nodes: Record<NodeId, GraphNode> = { ...retained.graph.nodes };
  for (const id of moved) nodes[id] = after.nodes[id] as GraphNode;
  const graph: FlatGraph = { ...retained.graph, nodes };
  const morphs = request.resolution?.morphs ?? request.flattened?.morphs ?? retained.morphs;
  const instances = request.resolution?.instances ?? request.flattened?.instanceChannels;
  const instancePages = request.resolution?.instancePages ?? request.flattened?.instancePages;
  const records = new Map(retained.nodes);
  for (const id of moved) {
    const record = records.get(id);
    if (record !== undefined) records.set(id, { ...record, node: nodes[id] as GraphNode });
  }
  const staged: RetainedCompile = { ...retained, request, graph, nodes: records, morphs, instances, instancePages };

  const rerun = new Set<NodeId>([...linked].filter((id) => records.has(id)));
  const compiler = frameCompilerOver(request, { compiled: base, retained: staged }, rerun);
  if (!compiler.uniformOnly) return compiler.reason ?? "A node that reads the value animates a structural parameter.";
  const capture: RerunCapture = { contexts: new Map(), scene: null, said: new Map() };
  const reading: ParameterResolution = {
    ...(request.resolution ?? {}),
    morphs,
    ...(instances === undefined ? {} : { instances }),
    ...(instancePages === undefined ? {} : { instancePages }),
  };
  const spliced = compiler.compileFrame(reading, capture);
  if (spliced === null) return compiler.reason ?? "A re-run node could not be proven structure-preserving.";
  for (const id of capture.contexts.keys()) {
    if (!rerun.has(id)) return `"${id}" re-ran through a scene payload and was not known to read the value.`;
  }
  for (let index = 0; index < spliced.passes.length; index += 1) {
    const pass = spliced.passes[index] as PassDescriptor;
    if (pass.kind === "loop" && pass !== base.passes[index]) return `The count of loop "${pass.id}" follows the value.`;
  }

  // A node that is asked and was not re-run — one that compiles nothing (a control, a lag),
  // or an expression that reads a written node — still resolves, and may say something: the
  // same call `validateGraph` makes for it.
  const reader = parameterReadOptions({
    graph,
    registry: request.registry,
    frame: undefined,
    channels: reading.channels,
    flattening: flatteningReadsOf(reading),
  });
  for (const id of affected) {
    if (rerun.has(id)) continue;
    const node = nodes[id];
    const definition = node === undefined ? undefined : request.registry.get(node.type);
    if (node === undefined || definition === undefined) continue;
    const said: RuntimeDiagnostic[] = [];
    resolveNodeParameters(node, effectiveParameterSchema(definition, node.parameters), definition.type, said, reader, {
      retained: definition.retainedParameterKeys,
      note: definition.parameterKeysNote,
      otherVersion: node.definitionVersion !== definition.version,
    });
    if (said.length > 0) capture.said.set(id, said);
  }
  const said = new Map(retained.said);
  for (const id of affected) {
    const now = capture.said.get(id);
    if (saidKey(now) !== saidKey(retained.said.get(id))) {
      return `Node "${id}" says something different about its new value, so the revision is compiled in full.`;
    }
    if (now === undefined) said.delete(id);
    else said.set(id, now);
  }

  for (const [id, context] of capture.contexts) {
    const record = records.get(id);
    if (record !== undefined) records.set(id, { ...record, context });
  }
  const rebased: RetainedCompile = { ...staged, scenePayloads: capture.scene ?? retained.scenePayloads, said };
  VALUE_READERS.set(rebased, readers);
  return { compiled: spliced, retained: rebased };
}
