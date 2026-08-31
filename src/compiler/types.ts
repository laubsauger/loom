import type { EdgeId, NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ColorPolicy, GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../domain/types/backend.ts";
import type { NodeCompileContext, TextureFormat } from "../domain/types/node-definition.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import type { ComponentSource } from "./flatten.ts";
import type { DrawPassDescriptor, PassDescriptor, ResourceDescriptor } from "../runtime/backend/plan.ts";
import type { ParameterResolution } from "./validate.ts";
import type { ColorSpace } from "./color-space.ts";

/**
 * Compiler surface types (§P track E).
 *
 * The compiler is a pure function of (graph, settings, registry, capabilities, sinks).
 * Same input, same plan — including iteration order, which is why every map here is
 * projected to an array sorted by a stable key before it leaves this module.
 */

/**
 * Why a node's output is alive (§V25). The compiler traces backward from these and prunes
 * everything they do not reach.
 */
export type SinkKind =
  | "output"
  /** A node preview that is actually visible or pinned (§V28). */
  | "preview"
  | "inspector"
  /** A feedback pair that must keep advancing even when nothing is looking at it. */
  | "feedback"
  /** Readback / debug: export, screenshot, headless capture (§V48). */
  | "readback";

export interface ActiveSink {
  readonly nodeId: NodeId;
  /** Defaults to the definition's first output port. */
  readonly portId?: PortId;
  readonly kind: SinkKind;
}

export interface CompileRequest {
  readonly graph: GraphDocument;
  readonly settings: ProjectSettings;
  readonly registry: NodeRegistryView;
  readonly capabilities: BackendCapabilities;
  /**
   * The frame this compilation resolves parameters AT, and how it reads driven channels
   * (T259, §V163). Omitted — the normal, structural case — every animated parameter
   * resolves at its zero-frame value, exactly as before.
   *
   * Supplied, the plan that comes back differs from the structural one ONLY in its pass
   * uniform VALUES: same nodes, same passes, same resources, same signatures. That is
   * what lets the caller push it with `updateUniforms` instead of recompiling, which is
   * the whole of §V5 and the reason an animated graph does not rebuild at 60 Hz.
   */
  readonly resolution?: ParameterResolution;
  /**
   * Explicit sinks. Nodes that exist only for their side effect (no declared outputs) are
   * always added to this set — a side-effect node is never pruned (§V25).
   */
  readonly sinks?: ReadonlyArray<ActiveSink>;
  /**
   * The component catalogue, when the project uses components (§V82).
   *
   * Supplied separately from `registry` because the two answer different questions: the
   * node registry hands back a component's synthesized MANIFEST, which is what the canvas
   * and §V13 need, while flattening needs the internal GRAPH behind it. Omitted, nothing
   * is flattened and an instance trips the manifest's `component.notFlattened` error —
   * loudly, rather than rendering nothing.
   */
  readonly components?: ComponentRegistryView;
}

/**
 * One materialized node output: exactly one persistent GPU resource, reused by every
 * consumer (§V6, §V8).
 *
 * Identity is port-scoped, never node-scoped: one node can materialize several outputs
 * (a 3D render node emits colour, depth, normals and object ids from one pass), so
 * `${nodeId}:${portId}` is the only safe key.
 */
export interface ResolvedOutput {
  readonly nodeId: NodeId;
  readonly portId: PortId;
  /** Id of the resource in the emitted plan. */
  readonly resourceId: string;
  /** Resource kind, read from the port rather than assumed. "pointset" is a MARKER: the
   *  edge propagates (consumers get the producer's identity) but no texture resource is
   *  emitted — storage is the producer's per-attribute buffer pairs (T121/T176). */
  readonly resourceKind: "target" | "pingPong" | "pointset";
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /** Working-space tracking (doc §16.2). Carried here until `PortType` grows the field. */
  readonly space: ColorSpace;
  /** True when the output is declared temporal and therefore backed by a ping-pong pair (§V4, §V22). */
  readonly temporal: boolean;
  /** True when the definition declares this target output carries a depth attachment (T299, T295). */
  readonly depth?: boolean;
  /**
   * T563: a SYNTHESIZED preview — the pointset splat or a scene payload's stock scene.
   *
   * The draw passes are DATA for the PREVIEW PROGRAM, which owns the target they render
   * into (`resourceId` above; the program sizes it to the granted tile) and runs them on
   * the preview cadence. The main plan carries neither the passes nor the target — which
   * is the fix for the measured T502 failure: the splat lived in the main plan, the main
   * plan does not run while the transport is paused, so a ladder-crossing recompile
   * reallocated the target and the preview went black until playback resumed. The
   * preview program rebuilds outside the frame and refreshes regardless of transport.
   *
   * Buffer-pair bindings inside these passes bind half "read": between main frames the
   * swap has landed the latest state on the read half, which is what a next-frame
   * consumer sees. Texture bindings (a material's maps) resolve as externals from the
   * main program, exactly like a lens pass's source texture.
   */
  readonly synthesis?: {
    readonly passes: ReadonlyArray<DrawPassDescriptor>;
    /** The synthesized target needs a depth attachment (scene payloads depth-test). */
    readonly depth: boolean;
  };
}

/**
 * A ping-pong pair standing in for a temporal output (§V22).
 *
 * `resetSignature` folds in exactly the triggers the node's `TemporalDefinition.resetOn`
 * declares, so history is dropped when — and only when — the manifest says it must be.
 */
export interface FeedbackPair {
  readonly resourceId: string;
  readonly nodeId: NodeId;
  readonly portId: PortId;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  readonly swapPassId: string;
  readonly resetSignature: string;
}

/**
 * The compiled plan.
 *
 * Structurally a `LogicalExecutionPlan`, so it can be handed straight to
 * `RenderBackend.compile` — the extra fields are compiler-side knowledge (order, pruning,
 * per-output resolution/format, feedback pairs) that the editor and the recompile
 * classifier need and the backend ignores.
 */
export interface CompiledGraph extends LogicalExecutionPlan {
  readonly passes: ReadonlyArray<PassDescriptor>;
  readonly resources: ReadonlyArray<ResourceDescriptor>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
  /** False when any diagnostic is an error. The caller keeps the last good plan (§V9). */
  readonly ok: boolean;
  /** Kept nodes in execution order (§V4). */
  readonly order: ReadonlyArray<NodeId>;
  /** Nodes no active sink reaches (§V25). */
  readonly pruned: ReadonlyArray<NodeId>;
  /** Sorted by `${nodeId}:${portId}` so the projection is deterministic. */
  readonly outputs: ReadonlyArray<ResolvedOutput>;
  readonly feedback: ReadonlyArray<FeedbackPair>;
  /**
   * Where each node came from, sorted by id (§V82).
   *
   * Empty for a project with no components. For a flattened one it carries the source path
   * of every node at every depth — `Main / DreamyFeedback_2 / Blur_1` — which is what a
   * timing row, a profile entry or a problems-tab line shows instead of the namespaced id.
   * Every pass in the plan carries its `nodeId`, so a row is one lookup away from its path.
   */
  readonly sources: ReadonlyArray<ComponentSource>;
  /**
   * Per-resource identity, sorted by id. THIS is what a consumer diffs to decide what to
   * rebuild: a document-level hash would make one unrelated new node reallocate every
   * target and zero every feedback pair, which §V22 and §V50 forbid.
   */
  readonly resourceSignatures: ReadonlyArray<PlanEntrySignature>;
  /** Per-pass identity, sorted by id. Uniform VALUES are excluded by construction (§V5). */
  readonly passSignatures: ReadonlyArray<PlanEntrySignature>;
  /**
   * Whole-plan identity. A convenience for "did anything structural change at all" — never
   * the key for deciding what to rebuild; use the per-entry signatures for that.
   */
  readonly signature: string;
  /**
   * Coarse texture-memory estimate for the plan's resources (§V24). Reported alongside a
   * `compiler/memory-budget` warning when it exceeds `settings.limits.memoryBudgetBytes`.
   */
  readonly estimatedResourceBytes: number;
}

export interface PlanEntrySignature {
  readonly id: string;
  readonly signature: string;
}

/** An edge that survived validation, plus whether it crosses a frame boundary (§V4). */
export interface CompileEdge {
  readonly id: EdgeId;
  readonly source: { readonly nodeId: NodeId; readonly portId: PortId };
  readonly target: { readonly nodeId: NodeId; readonly portId: PortId };
  /** True when the source output is declared temporal: it carries the PREVIOUS frame. */
  readonly temporal: boolean;
  /**
   * The edge's position on a VARIADIC target port (T225, §V131), carried through from the
   * document. Absent on an ordinary port, and on documents written before the field
   * existed — `compareEdgeOrder` puts those last, which is exactly the id order the
   * compiler used before.
   */
  readonly order?: number;
}

/** What a node's `compile()` sees on one of its inputs. */
/**
 * What a pointset EDGE carries (T296, §V197): the RESOLVED attribute→pair map, the
 * capacity and the topology. One change, four payoffs — consumers stop deriving pair
 * ids from a naming convention, capacity stops being a parameter the user must keep in
 * sync, topology reaches the renderer, and the map IS the copy-on-write mechanism: a
 * transform that writes only `sample` publishes upstream's pairs for everything else,
 * so an unmodified attribute passes downstream BY REFERENCE (no per-node copy of the
 * whole schema — V197's 28.8 GB/s of memcpy at a million points simply never happens).
 */
export interface PointsetEdgeInfo {
  /**
   * attribute name → the pair to bind AND the half holding this frame's data. The pair
   * another NODE may own. §V231/T322: the half is a PAYLOAD FACT for every pair, not a
   * convention — an ordinary producer names its write half (§V168), a compacted one
   * names its read half (scatter lands there), and a consumer binds what the payload
   * says without knowing which kind fed it.
   */
  readonly pairs: Readonly<
    Record<
      string,
      {
        readonly pair: string;
        readonly half: "read" | "write";
        /** T286: the attribute's WGSL type, so a mapped parameter can bind and swizzle it. */
        readonly type?: string;
      }
    >
  >;
  readonly capacity: number;
  readonly topology?: string;
  /**
   * T322: present when the LIVE count is GPU-resident (an advanced kernel that kills).
   * `capacity` stays the allocation bound; the buffer's first u32 is the count.
   * Consumers that draw switch to indirect; consumers needing a static count refuse.
   */
  readonly count?: { readonly buffer: string };
}

export interface CompiledInputBinding {
  readonly portId: PortId;
  readonly resourceId: string;
  /** Sampler to bind alongside this texture. Shared across the plan; carried here so a
   *  node's `compile()` never has to reach outside its own binding. */
  readonly sampler: string;
  readonly sourceNodeId: NodeId;
  readonly sourcePortId: PortId;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  readonly space: ColorSpace;
  /** A temporal binding reads the pair's previous-frame half (§V22). */
  readonly temporal: boolean;
  /** Present iff the upstream output is a pointset (T296). */
  readonly pointset?: PointsetEdgeInfo;
  /** T447: the scene payload the producing node published (camera/light/geometry/material). */
  scene?: import("../domain/types/scene.ts").ScenePayload;
}

export interface CompiledOutputBinding {
  readonly portId: PortId;
  readonly resourceId: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  readonly space: ColorSpace;
  readonly temporal: boolean;
}

/**
 * The concrete shape the compiler passes to `NodeDefinition.compile`.
 *
 * Declared as a type alias rather than an interface on purpose: an alias gets an implicit
 * index signature, so it satisfies the deliberately-opaque `NodeCompileContext` in the
 * frozen contract without either side having to widen.
 *
 * Everything a node needs is resolved BEFORE this is built — size, format, target and
 * input resource ids are compile-time facts, never per-frame ones (§V21).
 */
export type CompilerNodeContext = {
  readonly nodeId: NodeId;
  readonly nodeType: string;
  /** Declared parameters, defaults filled in, values already validated against the schema. */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  /**
   * T286 (§V287): parameters whose active mode is `map` — attribute-per-point. The
   * VALUE in `parameters` is the retained static; a POINT consumer that honours the
   * map compiles a different shader interface from this record, and one that cannot
   * reports it by name (§V288).
   */
  readonly parameterMaps: Readonly<Record<string, { attribute: string; channel?: string; port?: string }>>;
  /** Resolved size for this node's outputs (§V21, §V50). */
  readonly resolution: readonly [number, number];
  /** Resolved pixel format for this node's outputs (§V21, §V51). */
  readonly format: TextureFormat;
  /** Working colour space of this node's outputs (doc §16.2). */
  readonly space: ColorSpace;
  /** Resource id a pass renders into when it does not name one. Undefined = nothing materialized. */
  readonly target: string | undefined;
  /** Incoming bindings by input port id. A variadic port carries more than one (§V14). */
  readonly inputs: Readonly<Record<PortId, ReadonlyArray<CompiledInputBinding>>>;
  readonly outputs: Readonly<Record<PortId, CompiledOutputBinding>>;
  /** Id of the shared sampler resource; bind it rather than declaring one per node. */
  readonly sampler: string;
  readonly projectResolution: readonly [number, number];
  /**
   * The project's colour commitments (T84, T375, §V56). Only a DISPLAY node acts on it —
   * §V56 puts the encode at the output/display node and forbids it anywhere else — and
   * `sinkDisplayTransform` in `src/domain/color/display.ts` is the one function that reads it
   * on a node's behalf, so the compiler's published `space` and the node's shader are the
   * same decision (B47 was those two disagreeing).
   */
  readonly colorPolicy: ColorPolicy;
};

/**
 * Reads the compiler's context out of the opaque contract type.
 *
 * Node definitions call this as the first line of `compile()`. It is the single documented
 * place the cast happens, so widening the context later touches one function.
 */
export function asCompilerContext(context: NodeCompileContext): CompilerNodeContext {
  return context as unknown as CompilerNodeContext;
}

export function outputKey(nodeId: NodeId, portId: PortId): string {
  return `${nodeId}:${portId}`;
}
