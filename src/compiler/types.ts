import type { EdgeId, NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../domain/types/backend.ts";
import type { NodeCompileContext, TextureFormat } from "../domain/types/node-definition.ts";
import type { ParameterValue } from "../domain/types/parameters.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import type { PassDescriptor, ResourceDescriptor } from "../runtime/backend/plan.ts";
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
   * Explicit sinks. Nodes that exist only for their side effect (no declared outputs) are
   * always added to this set — a side-effect node is never pruned (§V25).
   */
  readonly sinks?: ReadonlyArray<ActiveSink>;
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
  /** Resource kind, read from the port rather than assumed. */
  readonly resourceKind: "target" | "pingPong";
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  /** Working-space tracking (doc §16.2). Carried here until `PortType` grows the field. */
  readonly space: ColorSpace;
  /** True when the output is declared temporal and therefore backed by a ping-pong pair (§V4, §V22). */
  readonly temporal: boolean;
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
}

/** What a node's `compile()` sees on one of its inputs. */
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
