import type { ColormapId } from "../color/colormaps.ts";
import type { PortId } from "./ids.ts";
import type { PortDefinition } from "./ports.ts";
import type { ParameterSchema, ParameterValue, StoredParameter } from "./parameters.ts";
import type { AudioFeatures, FrameEvaluationInput } from "./frame.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";
import type { RuntimeRequirementId } from "./requirements.ts";
import type { ScenePayload } from "./scene.ts";

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
   * The key it names is a per-frame VALUE since T425 (it was `compileTime` under T387):
   * the loop REGION is plan structure, the count is read live by the encoder (§V358).
   */
  substeps?: string;
}

/**
 * T1583b — KERNEL STEPS: this node's one dispatch may run several times per displayed
 * frame over its own buffer pair, each run reading what the run before it wrote.
 *
 * Two parameter keys, named here for the reason `TemporalDefinition.substeps` gives: the
 * compiler reads numbers out of a node whose parameters are otherwise its own business.
 *
 *  - `substeps` DIVIDES TIME: the dispatch's `deltaSeconds` is the frame's divided by it.
 *  - `iterations` repeats inside one substep at the same time step.
 *
 * Dispatches per frame = substeps × iterations. Both are per-frame VALUES and must NOT be
 * `compileTime` (§V358): the compiler emits the region at count 1 so that driving either
 * from 1 to 3 is a value write, never a rebuild.
 *
 * Not `temporal.substeps`, though both end as a loop region. That key says "iterate the
 * feedback LOOP this node closes" — a cycle of several nodes, found on the graph, with the
 * pair's swap inside it. This says "iterate this node's own pass", and it divides time.
 *
 * T1585b — two more shapes, for a solver node:
 *
 *  - `substeps` may be a RATE (`KernelStepRateDeclaration`) in place of a count: three
 *    parameter keys, and the count is `clamp(round(delta × rate), min, max)` of whichever
 *    frame is being rendered. Notch's Update Frame Rate with Min and Max Update Steps.
 *  - `iterations` may be left out, which is one run per substep. A solver that repeats
 *    inside its own shader has no use for a second dispatch count.
 */
export interface KernelStepsDeclaration {
  readonly substeps: string | KernelStepRateDeclaration;
  readonly iterations?: string;
}

/**
 * T1585b — the parameter keys a rate-driven step count is read from. All three are
 * per-frame VALUES, for the reason the counts are (§V358).
 */
export interface KernelStepRateDeclaration {
  /** Solver steps per second of the piece. */
  readonly rate: string;
  /** Fewest and most substeps one displayed frame may run. */
  readonly min: string;
  readonly max: string;
}

export interface CapabilityRequirement {
  feature: string;
  reason: string;
}

/**
 * DOES THIS NODE ACT ON THE WORLD (T949)? — the axis the record lacked, and it is
 * ORTHOGONAL to `Reproducibility`.
 *
 * `Reproducibility`'s three values all answer ONE question: how does this node's OUTPUT
 * depend on the world. That question has nothing to say about a node whose whole purpose
 * is to push something OUT of the process, and the classification it produces for one is
 * actively dangerous: a `laserOut` has no output at all, so it is a pure function of its
 * inputs, so it classifies as `pure` — and `pure` is exactly what makes a node safe to
 * evaluate in a headless export. `src/tests/headless/**` and the example GPU gates render
 * EVERY example. A laser that fires because a test suite rendered an example is the
 * failure this declaration exists to prevent.
 *
 * A FOURTH `Reproducibility` VALUE WAS RULED OUT AND THE REASON IS WORTH KEEPING: it
 * would make one field answer two unrelated questions, and every existing reader —
 * `nonReproducibleNodes`, the render warning, the node info popup — would silently
 * mis-handle it, because each of them branches on "is this `pure`" meaning "does the
 * render reproduce" and would get "does this drive hardware" instead.
 *
 * TWO VALUES, because the axis is a yes/no. HAZARD TIER IS NOT THIS AXIS: a laser needs
 * an interlock, a maximum power and scan-fail blanking; a DMX universe does not. That is
 * a property of the TRANSPORT and belongs to the node and the device bridge, and putting
 * it here would repeat the exact mistake this type was created to avoid.
 *
 * The ledger that forces every node to answer is `NODE_SIDE_EFFECTS`
 * (`domain/render/side-effects.ts`), pinned to this field in both directions by
 * `side-effects.test.ts`; the predicate every emission site must pass is
 * `emissionRefusal` beside it.
 */
export type SideEffect =
  /**
   * This node changes nothing outside the render. The overwhelming majority, and the
   * value a node gets by saying nothing — which is why the LEDGER, not this field, is
   * what makes a decision mandatory.
   */
  | "none"
  /**
   * This node sends data OUT OF THIS PROCESS to something that may act on it: a lighting
   * desk over OSC today, a laser DAC or a DMX universe next. The emission itself must NOT
   * live in the node — see `NODE_SIDE_EFFECTS` for why, and for the gate that checks it —
   * and whatever pumps it must refuse unless `emissionRefusal` says otherwise.
   */
  | "emits";

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
  /** T481: attach a depth buffer, exactly as an output target may (T295). Structural. */
  depth?: boolean;
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
  /**
   * T1353b: the bytes come from a registered source (a decoded mesh), not from a pass —
   * the buffer twin of `ScratchExternalTextureRequest.sourceId`. Never bytes (§V135).
   */
  sourceId?: string;
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

/**
 * A LAYERED target (T1623b slice 4): one texture of `layers` layers. The node's draws each
 * name the layer they render into, and a shader reads every layer through ONE binding
 * (`texture_2d_array`), so a text can index what N targets would make it name. A Render's
 * shadow maps: a layer a casting light.
 */
export interface ScratchLayersRequest {
  kind: "layers";
  key: string;
  /** Layer count, >= 1. Structural: a node that adds layers rarely asks for them in steps. */
  layers: number;
  /** Fraction of the node's resolved size, as a target scratch takes. Default 1. */
  scale?: number;
  /** Omitted = the node's resolved format. */
  format?: TextureFormat;
  /** One depth buffer shared by the layers: each layer's first draw must clear. */
  depth?: boolean;
}

export type ScratchRequest =
  | ScratchTargetRequest
  | ScratchBufferPairRequest
  | ScratchBufferRequest
  | ScratchExternalTextureRequest
  | ScratchRingRequest
  | ScratchLayersRequest;

/**
 * WHERE one attribute of a pointset lives (T296, T1076).
 *
 * T1076 replaced `{ pair, half }` — one storage buffer per attribute — with a REGION of a
 * packed buffer, because the old layout spent 2n bindings for n attributes and WebGPU's
 * baseline allows 8 per stage: four attributes, and the fifth failed the pipeline in
 * silence (§V588, B33). The bytes are the same bytes in the same order; only the address
 * changed, from "its own buffer" to "this buffer plus this offset".
 *
 * The field is named `buffer` rather than `pair` precisely so the rename is a TYPE ERROR
 * at every consumer. Adoption cannot be partial — a kernel reads its UPSTREAM's map for
 * shared attributes (T401), so one unpacked producer puts every downstream kernel back on
 * a binding per attribute — and "all producers or none" is worth having the compiler
 * enforce rather than a reviewer.
 */
export interface PointsetAttributeRef {
  /** The bufferPair holding this attribute's region. One per PRODUCER, not per attribute. */
  buffer: string;
  /**
   * §V231/T322: which half holds THIS frame's data. A payload fact, never a convention —
   * an ordinary producer names its write half (§V168), a compacted one its read half
   * (scatter lands there), and a consumer binds what the payload says.
   */
  half: "read" | "write";
  /** Byte offset of the attribute's region inside `buffer`. 256-aligned (see `src/points/packing.ts`). */
  offset: number;
  /** Bytes the region occupies: `stride × capacity`. */
  bytes: number;
  /** T286: the attribute's WGSL type, so a mapped parameter can bind and swizzle it. */
  type?: string;
}

/**
 * T1598b — a SPHERE that holds every point of a pointset, in the frame its positions are in.
 *
 * It rides a pointset edge only where it is KNOWN EXACTLY WITHOUT READING THE GPU: a Mesh
 * File In measures it from the file. A node that moves points on the GPU (a kernel, a clip)
 * publishes none, and it is never carried through by default — a node builds its own edge
 * description, so forgetting this field loses the bound, which is the safe direction. A
 * consumer without one must assume the points can be anywhere (§V426: no guessed bounds).
 */
export interface PointsetBounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

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
        pairs: Readonly<Record<string, PointsetAttributeRef>>;
        capacity: number;
        topology?: string;
        count?: { buffer: string };
        /** T1598b: the sphere holding every point, when the producer knows it exactly. */
        bounds?: PointsetBounds;
      }
    >
  >;
  diagnostics?: RuntimeDiagnostic[];
  /**
   * T1719b — the values of THESE passes at another frame. Absent: a values-only frame re-runs
   * `compile` for this node, as it always has. See {@link NodeValueFunction}.
   */
  values?: NodeValueFunction;
}

/**
 * T1719b — WHAT A VALUES-ONLY FRAME ASKS OF A NODE THAT ALREADY COMPILED.
 *
 * Called with the context `compile` would have been called with at this frame. It returns
 * this frame's values and nothing else: there is no field for a shader, a binding, a target,
 * a pass count or an id, so it cannot change the plan's structure (V1031). `compile` fills
 * its own passes' values through the same function (V1032), so the two cannot disagree.
 * `docs/value-functions-design-2026-11-03.md`.
 */
export type NodeValueFunction = (context: NodeCompileContext) => NodeFrameValues;

export interface NodeFrameValues {
  /** One entry per pass the description emitted, in emission order. */
  readonly passes: ReadonlyArray<PassFrameValues>;
  /**
   * This frame's payload on every scene output the description published, and on no other:
   * a camera's pose travels its scene edge as values (T1719b S2).
   */
  readonly scene?: Readonly<Record<string, ScenePayload>>;
}

export interface PassFrameValues {
  /**
   * The pass's own id, as the description emitted it. Given, it is checked against the base
   * pass at the same place, so a function whose passes came out in another order says so.
   */
  readonly id?: string;
  /** The pass's uniform block: the same keys as the base pass's, this frame's numbers. */
  readonly uniforms?: Readonly<Record<string, number | boolean | readonly number[]>>;
  /** A draw's per-frame skip (T1598b: a caster out of its light's reach). */
  readonly skip?: boolean;
  /** A draw's literal instance count, where the base pass's is literal. */
  readonly instances?: number;
  /** A draw's vertex count. */
  readonly vertexCount?: number;
  /** A buffer write's rows and their count (§T1623b). */
  readonly values?: { readonly rows: readonly number[]; readonly count: number };
}

export interface MigrationResult {
  parameters: Record<string, unknown>;
  diagnostics?: RuntimeDiagnostic[];
}

/** A value node's per-frame output: named numbers (T274). */
export type ValueChannels = Readonly<Record<string, number>>;

/**
 * What one named channel means, so a bar over it can be drawn against a real scale.
 *
 * `bounded` carries the zero too, implicitly and on purpose: a track whose `low` is
 * negative and whose `high` is positive is BIPOLAR, and the bar fills from the zero
 * position outward rather than from the left edge — which is the difference between
 * "this is at -0.9" and "this is nearly empty". Declaring `{ low: -1, high: 1 }` is
 * therefore the whole of what a centred meter needs; there is no second flag to forget
 * to set, and no way to declare a bipolar range and get a unipolar picture.
 *
 * `boolean` is its own kind rather than `{ low: 0, high: 1 }` because a half-filled
 * boolean is not a state it has. It draws as on or off, and nothing in between.
 */
export type ValueChannelMeta =
  | { readonly kind: "bounded"; readonly low: number; readonly high: number }
  | { readonly kind: "boolean" };

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
  /**
   * T414: the frame's audio FEATURES, from FrameInputs — never a second analyser, the
   * §V182 rule with sound. Absent when the session has no audio input (offline render
   * with no recorded track, headless, mic denied): sources publish silence, loudly
   * documented, never a different render per run (§V45, §V329).
   */
  readonly audio?: AudioFeatures;
  /** Per-node persistent state (§V181). Mutate in place; cleared on transport reset. */
  readonly state: Record<string, unknown>;
  /**
   * T654: EXTERNAL channels by name — what `channelIn` reads. The analyze resolver (and
   * anything else the composition publishes) arrives through the session's extras, the
   * same seam `audio` came through; the value graph's OWN channels are deliberately not
   * here (they are edges — wire them). Absent when the session has none, in which case
   * a reader publishes its retained fallback, loudly documented, never a stall (§V144).
   */
  readonly channels?: (name: string) => number | undefined;
}

/** T1532b: what `NodeDefinition.coupledParameters` adds to one `setParameters` edit. */
export interface CoupledParameterWrites {
  /** Written in the same operation; the edit's own entries win over these. */
  readonly set: Readonly<Record<string, StoredParameter>>;
  /** Stored keys deleted in the same operation (a key `set` or the edit writes is kept). */
  readonly remove: readonly string[];
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
  /**
   * PER-INSTANCE schema (T880). Almost every node's parameters are fixed by its TYPE, so
   * `parameters` above is the whole story and this is absent. A `customWgsl` is the
   * exception the owner asked for: its controls are its shader's own `struct Params`, so the
   * SET of parameters depends on the node's stored `source`, not just its type. When present,
   * this derives the effective schema from the node's stored values; `parameters` remains the
   * fallback for type-only contexts (the palette, a fresh drop) and for every node without it.
   * The reflected schema MUST still contain the static keys a fresh node stores, so a value
   * already on disk keeps a home.
   */
  parametersFor?(stored: Readonly<Record<string, unknown>>): ParameterSchema;
  /**
   * §T1641b slice 2 (§B264 (2)): how this node's parameter keys come about, when its AUTHOR
   * wrote them and the rule is not visible where they wrote. A reflecting node turns its
   * shader's `struct Params` into controls, and a `vec3f` there is a colour (parts r, g, b)
   * or a vector (parts x, y, z) by the field's NAME. One sentence, said beside a refusal of
   * a stored key the node does not declare, at the write gate and at rest. Absent for a node
   * whose keys are fixed by its type: the refusal lists them.
   */
  parameterKeysNote?: string;
  /**
   * T1532b: parameters that must change TOGETHER with an edit. Absent for almost every node.
   * Grid Warp is the case that asked: its points are one parameter per point of the
   * CURRENT grid, so changing Columns must rewrite every point (the warp resampled onto the
   * new grid) and drop the ones that no longer exist — in the same patch, or the document
   * holds a size and a set of points that disagree.
   *
   * `graph.applyPatch`'s `setParameters` calls this with the node's stored parameters
   * BEFORE the operation and the operation's own entries, and applies what it returns in
   * that one operation: `set` entries under the edit's own (an entry the edit names wins),
   * `remove` keys deleted. The result is validated against the schema of the parameters
   * AFTER the write, so the edit may introduce keys the old schema did not declare. Because
   * it happens inside the operation, every write path (inspector, gizmo, agent tools,
   * paste, preset recall) gets it and the patch's one undo step takes all of it back.
   *
   * Pure and headless (§V11, §V44): a function of its two arguments. `null` means nothing
   * is coupled to this edit.
   */
  coupledParameters?(
    stored: Readonly<Record<string, StoredParameter>>,
    written: Readonly<Record<string, StoredParameter>>,
  ): CoupledParameterWrites | null;
  /**
   * T1619b: what a NEW node of this type stores beside its manifest defaults, given the
   * parameters it was created with. Absent for almost every node. A control is the case
   * that asked: it is BORN AT ITS DEFAULT, so the default it stores is the value it was
   * made with. The manifest's own number there would be a default nobody chose — a Slider
   * created at 7 that resets to 0.5.
   *
   * `graph.applyPatch`'s `addNode` lays these over the manifest defaults and under what the
   * creator provided, so every way a node is made on the bus (the library, a paste, an
   * agent's tool, "Control from Panel") gets it and an explicit entry always wins.
   *
   * Pure and headless (§V11, §V44): a function of its argument.
   */
  bornWith?(provided: Readonly<Record<string, StoredParameter>>): Record<string, StoredParameter>;
  /**
   * Known variant keys intentionally retained in stored documents while absent from the
   * effective schema. They are not resolved or offered as controls in that variant.
   * Switching back restores the stored settings; other undeclared keys still warn.
   */
  retainedParameterKeys?: readonly string[];
  resolutionPolicy?: ResolutionPolicy;
  formatPolicy?: FormatPolicy;
  temporal?: TemporalDefinition;
  /** T1583b: this node's dispatch may step several times per frame — see the type. */
  steps?: KernelStepsDeclaration;
  stateful?: StatefulDeclaration;
  /**
   * T949: does this node ACT ON THE WORLD? Absent means `"none"` — see `SideEffect` above
   * for why that default is safe only because `NODE_SIDE_EFFECTS` makes the decision
   * mandatory, and why this is not a fourth `Reproducibility` value.
   */
  sideEffect?: SideEffect;
  /**
   * T1006: this node needs THE SESSION to open a listening socket on its behalf. The
   * ingress mirror of `sideEffect` — that field says a node's data leaves the process,
   * this one says the process must be listening for a node's data to arrive at all.
   *
   * A page can neither bind a UDP port nor speak the protocol, so the node cannot open
   * anything itself (§V182). It declares the CHANNEL NAMESPACE its readings arrive under
   * and WHICH of its parameters carries the port number; the pump for that namespace
   * (`use-osc-bridge.ts` for `osc:`) subscribes to the union of the ports its instances
   * name, and to nothing when none do.
   *
   * DECLARED RATHER THAN PATTERN-MATCHED ON THE TYPE NAME, which is the whole point of
   * the row: the pump used to test `node.type !== "oscIn" && node.type !== "oscOut"` —
   * a set stated over a CATEGORY and implemented as two MEMBERS, §B45/§V316 exactly,
   * silently wrong the moment member #3 appears. With this field a second listening node
   * is pumped BY EXISTING.
   *
   * The parameter NAME lives here rather than being assumed to be `port`, so the
   * declaration is load-bearing rather than decorative: remove it and the socket is
   * never opened, which is what `use-osc-bridge.test.tsx` measures.
   */
  listensOn?: {
    /** The `ValueEvaluateContext.channels` prefix its readings arrive under (`osc:`). */
    readonly channelPrefix: string;
    /** The parameter holding the port to listen on. `0` means NOT LISTENING. */
    readonly portParameter: string;
  };
  capabilities?: CapabilityRequirement[];
  /**
   * T1340b: WHAT THIS NODE NEEDS FROM THE MACHINE — the desktop app, the local helper,
   * macOS, an installed SDK. Absent means "a plain browser tab is enough", which is the
   * overwhelming majority and is why the default is UNSTATED rather than a `"browser"`
   * member: a requirement list says what is EXTRA.
   *
   * ⚑ DECLARED HERE RATHER THAN LOOKED UP BY TYPE, and the row that moved it says why:
   * this lived as a `switch` on node type inside the EXAMPLE LIST, so the example library
   * knew a Syphon node needs macOS and the node did not know it about itself. Every
   * second surface then had to re-derive the map or import the examples layer, and the
   * hand-kept duplicate is how four different sentences for one fact got written. Pure
   * data, so §V11 is untroubled — no definition imports react, ui or editor for this.
   *
   * The FUNCTION form is for a node whose requirement depends on a compile-time parameter
   * — Person Mask's `transport` picks between the desktop app on Apple Silicon and the
   * local helper, and a flat list would have to claim both. Same shape and same reason as
   * `outputWhen`/`msaaWhen`: a structural fact that a parameter selects. It is handed the
   * node's RESOLVED effective values, and it may THROW on a value it does not recognise —
   * a caller that cannot tell must say so, never fall back to the default and report a
   * confident wrong answer (§V986).
   */
  requires?:
    | readonly RuntimeRequirementId[]
    | ((values: Readonly<Record<string, unknown>>) => readonly RuntimeRequirementId[]);
  /**
   * The colour map this node's PREVIEW starts in, for a node whose output is one value read
   * as a picture — Depth (owner 2026-11-22: depth reads better red to blue). Display only:
   * the node renders the same grey data either way, and a person can change or clear it in
   * the preview lens. Absent means the plain picture.
   */
  previewColormap?: ColormapId;
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
   * T939: texture outputs whose target materializes MULTISAMPLED (4x; the backend keeps
   * the samples across preserve passes and resolves into the sampleable color every
   * pass — the patched vgpu contract). Predicate over the node's parameters so a render
   * offers it as an opt-in mode; structural like depth, hence declared not inferred.
   */
  msaaWhen?: Readonly<Record<PortId, (parameters: Readonly<Record<string, unknown>>) => boolean>>;
  /**
   * T722: an output port that EXISTS only when a compile-time parameter enables it.
   * The compiler skips allocating the port's target when the predicate answers false,
   * so an off-by-default auxiliary output (the render's camera-depth read) costs zero
   * memory and zero passes until asked for. The port stays visible in the editor —
   * its description says which switch enables it — and wiring it while off surfaces
   * as the ordinary missing-resource diagnostic rather than a silent black.
   */
  outputWhen?: Readonly<Record<PortId, (parameters: Readonly<Record<string, unknown>>) => boolean>>;
  /**
   * B226: the output every other output of this node is drawn AGAINST — the Render's colour
   * target, which owns the depth attachment its Depth, Normal and Albedo passes test with.
   * It materializes whenever any output of the node does, so wiring only a Render's Depth
   * (a light's-eye depth view, say) compiles instead of refusing for a port nobody read.
   */
  anchorOutput?: PortId;
  /**
   * T350 (§V285): this node's source is a NAME, not a wire — the named parameter
   * holds another node's name and the compiler synthesizes the edge into `input`.
   * The declaration of record; `SOURCE_REFERENCE_PARAMETERS` (domain/graph) is its
   * projection for registry-free consumers, pinned to this by test.
   */
  /**
   * T350/T447: parameters that carry NODE NAMES resolved into synthesized edges — the
   * feedback source, and the scene family's assembly (camera/lights/scenes/material).
   * `list` marks a whitespace/comma-separated name LIST (order = draw/light order).
   * Mirrored by the domain-side SOURCE_REFERENCE_PARAMETERS table; index.test.ts pins
   * the two to each other in both directions.
   * `wire` (B233) marks an input that ALSO takes a wire, which then wins over the name;
   * the rule and the reason it is opt-in are in `domain/graph/source-references.ts`.
   */
  sourceReferences?: ReadonlyArray<{
    readonly parameter: string;
    readonly input: PortId;
    readonly list?: boolean;
    readonly wire?: boolean;
  }>;
  /**
   * Marks this node as an ACTIVE SINK: the compiler traces dependencies backward from
   * sinks and prunes everything else (§V25). Declared, never inferred — "has no outputs"
   * is not the same claim, and a node with a side effect must survive pruning either way.
   */
  sink?: boolean;
  /**
   * §T1391b — what a declared sink's target is FOR. Absent means `"picture"`: THE image the
   * viewer presents and render-out writes (`presentsPicture`). `"display"` is a sink that
   * renders into its own target for a surface outside the document — a Window Out's perform
   * window — and is two things a picture sink is not:
   *
   *  - never the picture: a Window Out whose id sorts before `out` must not take the viewer
   *    or the export over, which is what "first matching sink by id" would do;
   *  - active only while shown: §V25's "a declared sink is never pruned" is about the
   *    picture. A display sink joins the active set only when the caller names it (its
   *    window is open), so a Window Out nobody is looking at costs nothing.
   */
  sinkRole?: "picture" | "display";
  /** Preview this input's producer without allocating a render target for the node. */
  previewInput?: PortId;
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
   * What this node's channels MEAN, by channel name — the declared half of the bar's
   * scale.
   *
   * A channel bag is named numbers and nothing else, so a bar drawn over one has no
   * honest full-scale and no honest zero: auto-ranging a constant 0.7 over its own
   * extremes fills half the track forever, and a boolean reads identically to a float
   * that happens to sit at 1. Declaring the range is the only way a bar states a fact
   * rather than a ratio of a window to itself.
   *
   * OPTIONAL, and the fallback is deliberate rather than a gap: a channel with no entry
   * is drawn against the extremes actually OBSERVED since the plot opened, and is marked
   * as observed so the two are never read as the same claim. A Math node's output has no
   * range anyone can declare — that is a fact about the node, not an omission — and
   * refusing to draw it would leave the majority of value nodes with no bar at all.
   *
   * Static per channel NAME rather than a function of the parameter values: a range that
   * moves with a parameter cannot be stated once, and those channels fall to the observed
   * lane, which is where a moving range belongs anyway.
   *
   * The key `"*"` applies to EVERY channel the node publishes, and is not a convenience —
   * it is the only way the most declarable nodes here can declare anything. A Trigger
   * emits exactly 0 or 1 and a Normalize emits exactly 0..1, both BY CONSTRUCTION, but
   * both republish their INPUT's channel names (`mapChannels`), so neither knows what its
   * channels will be called. A named entry wins over `"*"` where both match.
   */
  valueChannelMeta?: Readonly<Record<string, ValueChannelMeta>>;
  /**
   * T438: this node publishes a MEASURED channel — a per-frame number produced by
   * machinery outside the value graph (analyze's GPU readback), addressed by the
   * node's name exactly like a value source's. Declared so `publishesValueChannels`
   * counts it without a type list; the measuring machinery itself stays where it is.
   */
  measuredChannel?: boolean;
  /**
   * §T1674b: channels that are a FUNCTION OF THIS NODE'S OWN PARAMETERS, read as
   * `op('name').chan.<channel>`. See `ParameterChannels`.
   */
  parameterChannels?: ParameterChannels;
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
  /**
   * How long one cycle of this node's output lasts, in seconds, for the parameter values
   * given — or null when the output has no period (a Timer's ramp, a Constant).
   *
   * Declared by the NODE rather than sniffed by the plot (T459, §V316). A plot that
   * looked for a parameter called `frequency` would be an invariant stated over a
   * category and implemented over one member: it would work for the LFO and silently
   * miss the next periodic source, or misread a `cutoff` in Hz as a period. Declaring it
   * means kind #N+1 has to say so itself.
   *
   * Only consulted for a PURE source (see `isPureValueSource`), because drawing a cycle
   * ahead of time requires evaluating frames the app has not reached.
   */
  plotPeriod?(values: Readonly<Record<string, ParameterValue>>): number | null;
  /**
   * This node's output repeats on the SAME period as its value inputs (T735).
   *
   * `plotPeriod` above answers "what does this SOURCE do"; this answers "what does this
   * STAGE do to a period", and together they let a period travel down a chain. A Math
   * node fed by an LFO has a period — the LFO's — even though it has no frequency of its
   * own, so it can have T459's static full-cycle curve instead of the sliding history
   * window that produced §T735.
   *
   * DECLARED, not sniffed, for the reason `plotPeriod` states one paragraph up and for
   * one more: the property is "clockless AND stateless AND output-repeats-with-input",
   * and nothing about a `valueEvaluate` signature reveals it. `valueStep` reads `frame`,
   * `channelIn` reads an ambient bag, and `valueSwitch` may select a different input from
   * one moment to the next — all three take a value input, none of them propagates a
   * period, and no predicate over their types could tell. Kind #N+1 has to say so itself.
   *
   * Absent is the safe answer and the default: the plot falls back to history, which is
   * what every value node did before this existed. A node must NOT declare it if it is
   * `stateful` (its output depends on everything before, not on one cycle), if it reads
   * the clock, or if it reads anything outside the value graph.
   */
  plotPeriodFollowsInputs?: boolean;
  compile(context: NodeCompileContext): CompiledNodeDescription;
  migrate?(oldVersion: number, data: unknown): MigrationResult;
}

/**
 * §T1674b — WHAT A NODE'S PARAMETERS COMPOSE TO, READABLE BY NAME.
 *
 * A Camera's Eye and Look At are offsets in the frame its Origin and Heading make (§T1656b).
 * The camera's payload carries the composed pose, so a Render never knows the frame exists;
 * an EXPRESSION reading `op('camera').par.eye` is a consumer that is not of the payload, and
 * it read the offset, silently (sentinel-bot's lit air went out within the hour). The pose is
 * said once, by the definition, and read here as channels:
 * `op('camera_rig').chan.eyeX`.
 *
 * WHY NOT A VALUE HOOK. `valueEvaluate` would make the camera a member of the value graph:
 * its tile would become a plot (`publishesValueChannels`), it would never be reported dead
 * (`isValueSourceDefinition`), its parameters would resolve a second time every frame
 * whether or not anything reads the pose, and the read would need a channel resolver, which
 * a structural compile and a panel do not have. This is none of those. It is a pure function
 * of the node's RESOLVED parameters, so it is read exactly where and when a parameter is: by
 * the one reader (`node-references.ts`), off the same per-frame resolve of the target a
 * `.par` read uses, in every context a `.par` read works in, and it costs nothing unread.
 * It is TouchDesigner's `op('cam1').worldTransform`: a member of the object, computed from
 * its transform. It is not its Object CHOP: there is no wire. A Constant whose Value is the
 * read is the wire.
 *
 * A definition declares this OR a value hook, never both (`parameter-channels.test.ts`).
 */
export interface ParameterChannels {
  /** Every channel, in the order a menu offers them, and what each one is. */
  readonly names: Readonly<Record<string, string>>;
  /**
   * The parameters the channels are composed from. A read of a channel fails with the
   * failure of any of these (§V108's fallback must not read as a healthy number).
   */
  readonly reads: readonly string[];
  /** The channels, from the node's resolved values. Pure: no clock, no state. */
  readonly evaluate: (values: Readonly<Record<string, ParameterValue>>) => ValueChannels;
  /**
   * The finding for a reader of any file: is `par.<parameter>[.<component>]` of a node
   * storing THESE parameters something other than what its name says, and which channel
   * says it? null when the parameter is what it says (a camera with no frame).
   */
  readonly insteadOf?: (
    parameter: string,
    component: string | undefined,
    stored: Readonly<Record<string, StoredParameter>>,
  ) => { readonly channel: string; readonly gives: string; readonly wants: string } | null;
}

/**
 * Does this node's value come from a PURE function of the frame (T459, §V143)?
 *
 * The distinction the plot turns on, and it is NOT the one `isValueSourceDefinition`
 * makes. That predicate is the UNION — "is this a value node at all" — and answers true
 * for a Lag as readily as for an LFO. Reading its implementation rather than its name is
 * §V316's instruction, and it says: it does not split pure from stateful.
 *
 * The split is here instead, beside the two hooks it discriminates, and it has to account
 * for something the union does not: `valueEvaluate` SUPERSEDES `valueChannel` when a
 * definition declares both. So "pure" is not "declares valueChannel" — it is "declares
 * valueChannel and nothing overrides it". No shipped node declares both today; the
 * contract permits it, and a definition that grew a `valueEvaluate` later would otherwise
 * keep a function plot that no longer described what it produces.
 */
export function isPureValueSource(definition: NodeDefinition | undefined): boolean {
  return definition?.valueChannel !== undefined && definition.valueEvaluate === undefined;
}

/**
 * T1340b: the ONE read path for `requires` — normalises the list and the function form so
 * no caller has to know which a given definition uses.
 *
 * `values` are the node's RESOLVED effective parameter values. An unrecognised value
 * propagates the definition's own throw; callers decide whether "we cannot classify this
 * document" is fatal (the example list: it refuses rather than promising browser support)
 * or merely unreportable (the editor: the compiler is already complaining about the same
 * value, and a second shout adds nothing).
 */
export function nodeRuntimeRequirements(
  definition: NodeDefinition | undefined,
  values: Readonly<Record<string, unknown>>,
): readonly RuntimeRequirementId[] {
  const declared = definition?.requires;
  if (declared === undefined) return [];
  return typeof declared === "function" ? declared(values) : declared;
}

/**
 * T438 (§V316): does this node PUBLISH VALUE CHANNELS — the one fact the plot gate,
 * the preview slot and the history sampler all need.
 *
 * Keyed on the DECLARATIONS, never the category string: `category` groups the library
 * shelf, and the day the scene nodes moved onto the "value" shelf every camera and
 * material was silently offered a value plot it could not fill ("no signal yet"). A
 * channel publisher is one of exactly three declared shapes — a value OUTPUT port (the
 * wireable channel), a value hook (the evaluable channel), or `measuredChannel` (a
 * channel produced by machinery outside the value graph — analyze's GPU readback).
 */
export function publishesValueChannels(definition: NodeDefinition | undefined): boolean {
  if (definition === undefined) return false;
  return (
    definition.outputs.some((port) => port.type.kind === "value") ||
    definition.valueChannel !== undefined ||
    definition.valueEvaluate !== undefined ||
    definition.measuredChannel === true
  );
}
