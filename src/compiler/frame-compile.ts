import type { NodeId } from "../domain/types/ids.ts";
import type { GraphNode } from "../domain/types/graph.ts";
import type { NodeDefinition, CompiledNodeDescription } from "../domain/types/node-definition.ts";
import type { ScenePayload } from "../domain/types/scene.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import type { ParameterMapBinding } from "../domain/parameters/resolve.ts";
import { createParameterReadOptions } from "../domain/parameters/node-references.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { passStructureKey, readPass } from "../runtime/backend/plan.ts";
import { compileGraphRetaining, descriptionStructureKey, normalizePass } from "./compile.ts";
import type { CompileGraphResult, RetainedCompile, RetainedNodeCompile } from "./compile.ts";
import { isParameterPolicy } from "./resolution.ts";
import { substepCount } from "./substeps.ts";
import { resolveNodeParameters } from "./validate.ts";
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
 *      `animatedRootKeys` mirrors `nodeHasAnimatedParameters`), through the same
 *      resolver and the same `op()` reader the full compile uses (§V61, §V939);
 *   2. re-runs `definition.compile` for those nodes, and for every node downstream of
 *      them through a SCENE PAYLOAD edge — a payload is a CPU value that travels
 *      (camera → render), so its consumers' uniforms move when it does;
 *   3. PROVES each re-run is structure-preserving: same scratch and pointset
 *      declarations (`descriptionStructureKey`), same pass ids in the same order, and
 *      the same `passStructureKey` per pass as the base plan carries — and
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
 * is declared on the compound. The mode list is `nodeHasAnimatedParameters`'s
 * (`graph-channels.ts`); `frame-compile.test.ts` holds the two together on every
 * shipped example.
 */
export function animatedRootKeys(node: GraphNode): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, stored] of Object.entries(node.parameters)) {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) continue;
    const mode = (stored as { mode?: unknown }).mode;
    if (mode === "expression" || mode === "driven" || mode === "bind") keys.add(key.split(".")[0] as string);
  }
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
}

function classify(
  retained: RetainedCompile,
): { animated: AnimatedNode[]; reason: string | null } {
  const animated: AnimatedNode[] = [];
  for (const nodeId of retained.order) {
    const record = retained.nodes.get(nodeId);
    if (record === undefined) continue;
    const keys = animatedRootKeys(record.node);
    if (keys.size === 0) continue;
    const structural = structuralParameterKeys(record.definition, record.node.parameters);
    for (const key of [...keys].sort()) {
      if (structural.has(key)) {
        return {
          animated,
          reason: `Node "${nodeId}" (${record.node.type}) animates "${key}", which is structural (compileTime or a resolution policy input); every frame compiles in full.`,
        };
      }
    }
    animated.push({
      nodeId,
      record,
      schema: effectiveParameterSchema(record.definition, record.node.parameters),
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
  if (built.resolution?.nodes !== request.resolution?.nodes) return "resolution.nodes";
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

function frameCompilerOver(request: CompileRequest, result: CompileGraphResult): FrameCompiler {
  const { compiled: base, retained } = result;
  if (retained === null) {
    return { base, uniformOnly: false, reason: "The compile produced no plan to splice over.", compileFrame: () => null };
  }
  const { animated, reason: classified } = classify(retained);
  if (classified !== null) {
    return { base, uniformOnly: false, reason: classified, compileFrame: () => null };
  }

  const basePassKeys = new Map<string, string>();
  for (const entry of base.passSignatures) basePassKeys.set(entry.id, entry.signature);
  /** Loop-begin markers, with the parameter whose value sets their count. */
  const loopCounts = new Map<string, { nodeId: NodeId; key: string }>();
  for (const pass of base.passes) {
    if (pass.kind !== "loop" || pass.edge !== "begin" || pass.nodeId === undefined) continue;
    const key = retained.nodes.get(pass.nodeId)?.definition.temporal?.substeps;
    if (key !== undefined) loopCounts.set(pass.id, { nodeId: pass.nodeId, key });
  }

  let reason: string | null = null;
  const degrade = (why: string): null => {
    reason = why;
    return null;
  };

  const compileFrame = (resolution: ParameterResolution): CompiledGraph | null => {
    if (reason !== null) return null;
    // The same reader `validateGraph` builds (§V939): a caller's own `nodes` wins, as there.
    const reader: ParameterResolution =
      resolution.nodes === undefined
        ? {
            ...resolution,
            ...createParameterReadOptions({
              graph: retained.graph,
              registry: request.registry,
              frame: resolution.frame,
              channels: resolution.channels,
            }),
          }
        : resolution;
    // Per-frame resolution diagnostics (a clamped expression, an unattached channel) are
    // dropped, exactly as the full per-frame compile's were by its one consumer.
    const discarded: RuntimeDiagnostic[] = [];
    const values = new Map<NodeId, FrameValues>();
    for (const entry of animated) {
      const resolved = resolveNodeParameters(entry.record.node, entry.schema, entry.record.definition.type, discarded, reader);
      values.set(entry.nodeId, { parameters: { ...resolved.values }, parameterMaps: resolved.maps });
    }

    const scene = new Map(retained.scenePayloads);
    const recompiled = new Set<NodeId>();
    const replacements = new Map<string, PassDescriptor>();
    for (const nodeId of retained.order) {
      const record = retained.nodes.get(nodeId);
      if (record === undefined) continue;
      const frameValues = values.get(nodeId);
      const sceneMoved = bindingsReadScene(record.context.inputs, recompiled);
      if (frameValues === undefined && !sceneMoved) continue;
      const context: CompilerNodeContext = {
        ...record.context,
        ...(frameValues === undefined ? {} : frameValues),
        inputs: sceneMoved ? withScenePayloads(record.context.inputs, scene) : record.context.inputs,
      };
      let description: CompiledNodeDescription;
      try {
        description = record.definition.compile(context);
      } catch (error) {
        return degrade(`Node "${nodeId}" (${record.node.type}) threw while compiling a frame: ${error instanceof Error ? error.message : String(error)}.`);
      }
      if (descriptionStructureKey(description) !== record.structureKey) {
        return degrade(`Node "${nodeId}" (${record.node.type}) declared different scratch or pointset storage at this frame; a value-only parameter changed structure.`);
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
        if (pass.id !== record.passIds[index] || passStructureKey(pass) !== basePassKeys.get(pass.id)) {
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
      const loop = loopCounts.get(pass.id);
      const owner = loop === undefined ? undefined : values.get(loop.nodeId);
      if (loop === undefined || owner === undefined) return pass;
      const count = substepCount(owner.parameters[loop.key]);
      return count === pass.count ? pass : { ...pass, count };
    });
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
