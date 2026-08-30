import type { PortId } from "./ids.ts";
import type { PortDefinition } from "./ports.ts";
import type { ParameterSchema, ParameterValue } from "./parameters.ts";
import type { FrameEvaluationInput } from "./frame.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";

export type ResolutionPolicy =
  | { kind: "inherit"; input: PortId }
  | { kind: "fixed"; width: number; height: number }
  | { kind: "scale"; input: PortId; factor: number }
  | { kind: "project" }
  | { kind: "custom" };

/**
 * Canonical texture format list. The TextureFormat type is DERIVED from it, so a new
 * format cannot be added to the type without every runtime list that validates against
 * it seeing the addition too.
 */
export const TEXTURE_FORMATS = [
  "rgba8unorm",
  "rgba8unorm-srgb",
  "rgba16float",
  "r32float",
  "depth24plus",
] as const;

export type TextureFormat = (typeof TEXTURE_FORMATS)[number];

/** Formats a user may select for a colour output. Depth is never offered here (§V51). */
export const SELECTABLE_COLOR_FORMATS = [
  "rgba8unorm",
  "rgba8unorm-srgb",
  "rgba16float",
  "r32float",
] as const satisfies ReadonlyArray<TextureFormat>;

export type SelectableColorFormat = (typeof SELECTABLE_COLOR_FORMATS)[number];

export type FormatPolicy =
  | { kind: "inherit"; input: PortId }
  | { kind: "fixed"; format: TextureFormat }
  | { kind: "project" };

/** Declares that an output carries previous-frame data, legalising a cycle (§V4). */
export interface TemporalDefinition {
  outputs: PortId[];
  resetOn: ReadonlyArray<"resolution" | "format" | "shader-interface" | "device" | "load">;
  /**
   * T387 — SUBSTEPS: the parameter key holding how many times this loop advances per
   * DISPLAYED frame. Absent (every other temporal node) the loop advances once, exactly
   * as it always has.
   *
   * DECLARED rather than assumed by name. The compiler needs to read a number out of a
   * node whose parameters are otherwise its own business, and "there is a parameter called
   * substeps" is the kind of convention that works until someone names one differently.
   * Naming the key here is what lets the compiler read it without guessing, and what makes
   * a node that has no such parameter structurally incapable of claiming substeps.
   *
   * The key it names MUST be `compileTime: true`: the count is a plan STRUCTURE fact
   * (§V5) — it changes how many times the region is encoded, and no uniform write can
   * express that.
   */
  substeps?: string;
}

export interface CapabilityRequirement {
  feature: string;
  reason: string;
}

/** How a stateful node behaves under seek, replay, and offline render (§V46, doc §16.4). */
export interface StatefulDeclaration {
  reset: boolean;
  deterministicReplay: boolean;
  checkpoint: boolean;
  randomAccess: boolean;
}

/** Filled in by the compiler track. Opaque here so tracks do not guess its shape. */
export interface NodeCompileContext {
  readonly [key: string]: unknown;
}

/**
 * Intermediate target a node needs BETWEEN its own passes — a separable blur's horizontal
 * half, for instance. Declared structurally rather than allocated by the node, so the
 * compiler owns the resource and V8 (no allocation inside the frame loop) still holds.
 */
export interface ScratchTargetRequest {
  /** Absent kind = a texture target. */
  kind?: "target";
  /** Node-local name; the compiler namespaces it. */
  key: string;
  /** Size relative to the node's resolved output. Omitted = same size. */
  scale?: number;
  /** Omitted = the node's resolved output format. */
  format?: TextureFormat;
}

/**
 * SoA point storage a node owns (T121/T124, §V75): one ping-pong pair per attribute,
 * ONE identity per pair so carry-over keeps simulation state across unrelated edits
 * (§V22). The compiler materializes it and appends the swap; the node never allocates.
 */
export interface ScratchBufferPairRequest {
  kind: "bufferPair";
  key: string;
  /** Element stride in bytes — the attribute's WGSL type decides it. */
  stride: number;
  capacity: number;
  /**
   * T322: `false` suppresses the compiler's appended swap. A COMPACTED pair inverts
   * the flow — scatter writes this frame's data into the READ half — so swapping
   * would hand next frame the stale half. The edge map names the half consumers bind
   * (§V231), so the inversion is invisible downstream.
   */
  swap?: boolean;
}

/** A single storage buffer a node's passes write — a reduction result, a lookup table. */
export interface ScratchBufferRequest {
  kind: "buffer";
  key: string;
  /** Element stride in bytes. */
  stride: number;
  capacity: number;
  /** T322: "indirect" marks a buffer holding dispatch/draw arguments the GPU consumes. */
  usage?: "indirect";
}

/**
 * A CPU-fed texture (T262, §V135): the node declares WHO supplies frames — a sourceId
 * into the backend's media registry — and the compiler materializes an
 * `externalTexture` resource sized to the node's resolved output. This is the seam
 * that makes media REACHABLE from the catalogue (§V167): without it the descriptor,
 * registry and upload path all exist and no node can declare them.
 */
export interface ScratchExternalTextureRequest {
  kind: "external";
  key: string;
  /** The media registry key. Never pixels (§V135). */
  sourceId: string;
  /** Omitted = rgba8unorm. Media nodes typically want rgba8unorm-srgb so sampling decodes. */
  format?: TextureFormat;
}

/**
 * A RING of N textures — one written per frame, older ones readable by tap (T237).
 *
 * §V226: `bufferPair`/`pingPong` generalised from two slots to N, so the compiler
 * materializes it and appends the same swap pass, and carry-over, reset and no-allocation
 * all apply unchanged. §V228: `frames` and `scale` are the node's to expose, because the
 * memory IS the parameter — `size × bytesPerPixel × frames`, which the compiler's budget
 * warning reports like any other resource.
 */
export interface ScratchRingRequest {
  kind: "ring";
  key: string;
  /** Slice count, >= 2. The deepest readable tap is `frames - 1`. */
  frames: number;
  /** Fraction of the node's resolved size, as a target scratch takes. Default 1. */
  scale?: number;
  /** Omitted = the node's resolved format. */
  format?: TextureFormat;
}

export type ScratchRequest =
  | ScratchTargetRequest
  | ScratchBufferPairRequest
  | ScratchBufferRequest
  | ScratchExternalTextureRequest
  | ScratchRingRequest;

export interface CompiledNodeDescription {
  passes: ReadonlyArray<unknown>;
  /** Scratch resources this node's passes use between each other. */
  scratch?: ReadonlyArray<ScratchRequest>;
  /**
   * T296 (§V197): what each pointset OUTPUT port resolved to — the attribute→pair map
   * (pairs another node may own, for by-reference attributes), capacity and topology.
   * The compiler forwards it along pointset edges; consumers bind these ids instead of
   * deriving them from a naming convention. §V231/T322: each pair names the HALF that
   * holds this frame's data — a payload fact, never a convention — and a producer with
   * a GPU-resident live count publishes its buffer under `count`.
   */
  pointsets?: Readonly<
    Record<
      string,
      {
        pairs: Readonly<Record<string, { pair: string; half: "read" | "write"; type?: string }>>;
        capacity: number;
        topology?: string;
        count?: { buffer: string };
      }
    >
  >;
  diagnostics?: RuntimeDiagnostic[];
}

export interface MigrationResult {
  parameters: Record<string, unknown>;
  diagnostics?: RuntimeDiagnostic[];
}

/** A value node's per-frame output: named numbers (T274). */
export type ValueChannels = Readonly<Record<string, number>>;

export interface ValueEvaluateContext {
  /** Upstream channel bags, one per connected input port (merged over sorted edge ids). */
  readonly inputs: Readonly<Record<PortId, ValueChannels>>;
  /** The node's effective parameter values (static view + frame-scoped expressions). */
  readonly values: Readonly<Record<string, ParameterValue>>;
  readonly frame: FrameEvaluationInput;
  /**
   * §V182: the SAME pointer the shaders read, from FrameInputs — never a second DOM
   * listener. Absent when the composition root has no pointer (offline render).
   */
  readonly pointer?: { readonly x: number; readonly y: number; readonly buttons: number };
  /** Per-node persistent state (§V181). Mutate in place; cleared on transport reset. */
  readonly state: Record<string, unknown>;
}

/**
 * Versioned manifest plus compile implementation. Must be executable headless —
 * never import React or @xyflow from a node definition (§V11).
 */
export interface NodeDefinition {
  type: string;
  version: number;
  title: string;
  category: string;
  description?: string;
  tags?: string[];
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  parameters: ParameterSchema;
  resolutionPolicy?: ResolutionPolicy;
  formatPolicy?: FormatPolicy;
  temporal?: TemporalDefinition;
  stateful?: StatefulDeclaration;
  capabilities?: CapabilityRequirement[];
  /**
   * Kernel ABI version this definition was written against (§V77). Checked before a
   * point kernel runs; a mismatch refuses with a diagnostic rather than running a
   * generated `Point` struct against a signature that no longer matches it.
   */
  contractVersion?: number;
  /**
   * T299 (§V198): texture outputs whose target materializes WITH a depth attachment.
   * A 3D render pass needs depth testing; the attachment is structural (a target
   * gaining or losing depth is a different render signature, T295), so it is declared
   * here — data on the definition — rather than inferred from what the passes draw.
   */
  depthOutputs?: ReadonlyArray<PortId>;
  /**
   * T350 (§V285): this node's source is a NAME, not a wire — the named parameter
   * holds another node's name and the compiler synthesizes the edge into `input`.
   * The declaration of record; `SOURCE_REFERENCE_PARAMETERS` (domain/graph) is its
   * projection for registry-free consumers, pinned to this by test.
   */
  sourceReference?: { readonly parameter: string; readonly input: PortId };
  /**
   * Marks this node as an ACTIVE SINK: the compiler traces dependencies backward from
   * sinks and prunes everything else (§V25). Declared, never inferred — "has no outputs"
   * is not the same claim, and a node with a side effect must survive pruning either way.
   */
  sink?: boolean;
  /**
   * Declares this node a pure WIRE (T223, §V130): the compiler splices it out —
   * consumers of `output` bind the producer feeding `input` directly, no pass is
   * emitted and no resource is allocated. TD's null idiom: point everything at a null,
   * rewire upstream freely, pay nothing at render time. `compile()` is never called for
   * a spliced node; it exists so the definition stays executable stand-alone.
   */
  passthrough?: { readonly input: PortId; readonly output: PortId };
  /**
   * Declares this node a VALUE SOURCE (T238-T240, §V143): a pure function from its own
   * effective parameter values and the frame clock to a number. The node's NAME (§V129)
   * is its channel: a parameter in `driven` mode naming `lfo1` reads this function on
   * the node named `lfo1`, through the resolver's channel seam (T203). Pure and
   * deterministic BY CONTRACT — the frame is the only clock (§V44), so offline and live
   * agree frame for frame (§V45). A source that cannot be a pure function (audio, MIDI)
   * does not use this; it registers a runtime channel instead (Phase 2).
   */
  valueChannel?(
    values: Readonly<Record<string, ParameterValue>>,
    frame: FrameEvaluationInput,
  ): number;
  /**
   * The full value-graph hook (T273/T274, §V179): evaluated per frame, CPU-side,
   * BEFORE the render, in topological order over value edges. Returns the node's
   * channel bag — named numbers (`{ x, y }` for a Mouse, `{ value }` for a scalar) —
   * addressed downstream as `name` or `name:channel`. Supersedes `valueChannel` when
   * both exist; `valueChannel` remains the single-channel shorthand (`{ value }`).
   *
   * `state` is the node's persistent bag (§V181): a stateful stage (Lag, Slope,
   * Trigger) reads and mutates it in place, MUST also declare `stateful` (§V46/§V155 —
   * a skipped stateful node diverges permanently), and gets it cleared on transport
   * reset. Determinism stands (§V143): frame + inputs + params + state in, numbers
   * out, no clock, no ambient reads.
   */
  valueEvaluate?(context: ValueEvaluateContext): ValueChannels;
  compile(context: NodeCompileContext): CompiledNodeDescription;
  migrate?(oldVersion: number, data: unknown): MigrationResult;
}
