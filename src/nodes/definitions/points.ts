import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { ParameterSchema, ParameterValue } from "../../domain/types/parameters.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import { MAX_KERNEL_STEPS, MAX_KERNEL_SUBSTEPS } from "../../runtime/backend/plan.ts";
import type { AuthoredSpan, WgslSourceMap } from "../../runtime/backend/wgsl-source-map.ts";
import { advance, endOf, placed, placedAroundCut } from "../../runtime/backend/wgsl-source-map.ts";
import { declaredNames, resolveSharedModules, SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";
import {
  validateAttributes,
  type PointAttributeSchema,
} from "../../points/attributes.ts";
import {
  POINT_KERNEL_CONTRACT_VERSION,
  POINT_KERNEL_VALUE_SLOTS,
  generateKernelModule,
  KERNEL_PARAM_PREFIX,
  kernelReadsValueSlot,
  pointKernelValueKey,
  type KernelNotice,
} from "../../points/codegen.ts";
import {
  attributeBinding,
  kernelBufferBindings,
  kernelStorage,
  packedPointStorage,
} from "./point-storage.ts";
import { kernelDimOf, parseTopology } from "../../points/topology.ts";
import { drawArgsWgsl } from "../../points/lifecycle.ts";
import { DEFAULT_POINT_KERNEL, SPRITE_RENDER_WGSL, TEXTURE_TO_ATTRIBUTE_WGSL, pointRayWgsl, spriteRenderWgsl } from "../shaders/points.wgsl.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs, readValueInputs } from "./compile-context.ts";
import { codeParametersLast } from "../../domain/parameters/code.ts";
import { readColor, readNumber } from "./parameter-readers.ts";
import type { Params } from "./parameter-readers.ts";
import {
  REFLECTED_PARAMETER_KEYS_NOTE,
  extractParamsStruct,
  reflectParamsStruct,
  reflectedParamCollisions,
  reflectedParamSchema,
  reflectedUniforms,
  remember,
  type ReflectedField,
} from "./params-reflection.ts";

/**
 * The point family (T121, T122): Point Kernel simulates, Render Points draws.
 *
 * A pointset edge carries a FAMILY of buffers — one ping-pong pair per attribute —
 * not one resource. The id convention below is the contract between producer and
 * consumer: the kernel node's pair for attribute `a` is `points:{nodeId}:{a}`, and a
 * consumer derives the same ids from the input binding's `source.nodeId`. The pair
 * swaps as ONE identity, so T143 carry-over keeps simulation state across unrelated
 * edits exactly as texture feedback survives them (§V22).
 *
 * Chain-compiled for real: `compileGraph` accepts dispatch/draw emission, materializes
 * the bufferPair scratch entries, propagates pointset edges as markers and appends the
 * pair swaps after all consumers (T176). The fixture and Dawn tests cover everything
 * below the compiler; the chain test covers the seam.
 */

import { scratchResourceId } from "../../compiler/resources.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";

/**
 * The point schema a node's parameters resolve to (T293) — the `pointSetInfo` the
 * read_points port needs, derived from the DOCUMENT so the composition root can wire
 * the port without re-reading node internals. Undefined for a non-point node or an
 * attributes parameter the schema rejects (the compile diagnostic already said why).
 */
export function pointSetInfoFor(
  node: { type: string; parameters: Readonly<Record<string, unknown>> },
): { attributes: ReadonlyArray<PointAttributeSchema>; capacity: number } | undefined {
  const numberOf = (key: string, fallback: number): number => {
    const value = storedStaticValue(node.parameters[key] as never);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
  };
  if (node.type === "pointKernel") {
    const { attributes } = parseAttributes(storedStaticValue(node.parameters["attributes"] as never));
    if (attributes === undefined) return undefined;
    return { attributes, capacity: numberOf("capacity", 4096) };
  }
  if (node.type === "textureToAttribute") {
    /* T1076: what this node OWNS, which is what its packed buffer holds. `position` used
       to be listed here and was never readable — the id this resolved to belonged to the
       upstream producer, so the readback threw "unknown buffer". Listing only `sample`
       makes the refusal say which attributes the node actually has. */
    return {
      attributes: [SAMPLE_ATTRIBUTE],
      capacity: numberOf("count", 4096),
    };
  }
  return undefined;
}

/**
 * A point node's PLAIN scratch buffer id — the lifecycle counts, the scan workspace, a
 * draw-argument buffer.
 *
 * It was `pointPairId` until T1076, when per-attribute pairs stopped existing: an
 * attribute is now a region of the producer's ONE packed pair (`pointStorageId`), so a
 * name minted per attribute would resolve to nothing. What survives is the plain-buffer
 * half, which was always this function's other job.
 */
export function pointBufferId(nodeId: string, key: string): string {
  return scratchResourceId(nodeId, key);
}

export const DEFAULT_POINT_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

export function parseAttributes(raw: unknown): { attributes?: ReadonlyArray<PointAttributeSchema>; error?: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { attributes: DEFAULT_POINT_ATTRIBUTES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `attributes is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(parsed)) return { error: "attributes must be a JSON array of { name, type, semantic?, default }" };
  const attributes = parsed as PointAttributeSchema[];
  const check = validateAttributes(attributes);
  if (!check.ok) return { error: check.errors.join("; ") };
  // The output PORT advertises `position: vec3f` (that is what makes it wirable into a
  // renderer under §V13's provides ⊇ requires rule), so every schema must honor it —
  // a port type is a static promise a dynamic parameter is not allowed to break.
  const position = attributes.find((attribute) => attribute.name === "position");
  if (position === undefined || position.type !== "vec3f") {
    return { error: 'the schema must include { name: "position", type: "vec3f" } — the output port promises it' };
  }
  return { attributes };
}


/**
 * T479 — the VALUE-GRAPH slots, defined ONCE for both kernel nodes (§V109: two nodes
 * wording the same idea differently is two answers to one question).
 *
 * Each slot is an ordinary drivable number. That is the whole design decision: the
 * channel NAME (`lfo1`, `mouse1:x`) lives in a `driven` binding on the parameter, which
 * rename already rewrites (§V128 kind 2, B40's fix) and which liveness, the reference
 * lines and the dangling-name diagnostics already understand. A name written inside the
 * kernel's WGSL would be a fifth reference currency that all five of those consumers
 * would have to learn — and wiring four of five is exactly how B40 happened.
 *
 * NOT `compileTime`: a slot changing is a uniform write, never a rebuild (§V5) — which is
 * the entire point, since the kernel text is compileTime and the slot is how live values
 * get past that.
 *
 * `inactiveWhen` asks the SAME reader codegen asks (`kernelReadsValueSlot`), so the
 * inspector shows exactly the slots this kernel reads and NAMES why the others are
 * inactive — never a knob that is present and does nothing (§V220/§V360).
 */
export function pointKernelValueParameters(sourceKeys: ReadonlyArray<string>): ParameterSchema {
  const entries = Array.from({ length: POINT_KERNEL_VALUE_SLOTS }, (_unused, index) => {
    const slot = index + 1;
    const key = pointKernelValueKey(slot);
    return [
      key,
      {
        type: "number" as const,
        label: `Value ${slot}`,
        default: 0,
        description:
          `Reaches the kernel as ctx.value${slot}. Put it in Driven mode and an LFO, the mouse or an ` +
          `audio channel changes what the kernel DOES, not just what it is scaled by (T479).`,
        inactiveWhen: (values: Readonly<Record<string, ParameterValue>>) =>
          kernelReadsValueSlot(slot, ...sourceKeys.map((sourceKey) => String(values[sourceKey] ?? "")))
            ? null
            : `This kernel does not read ctx.value${slot}.`,
      },
    ] as const;
  });
  return Object.fromEntries(entries);
}

/**
 * T900 — the LEGACY value slots, per instance: PARSE FOREVER, EMIT NEVER (§V813's shape).
 *
 * `value1`…`value4` were four generic numbered slots named for their INDEX rather than their
 * meaning, with a hard ceiling of four — the fixed-slot design §T880 rejected for `customWgsl`
 * and then left standing here. The replacement is `struct Params` reflection below. Shipped
 * documents hold these values and shipped kernels read `ctx.value1`, so they keep working
 * exactly as they did; what stops is EMITTING them onto a node that has neither.
 *
 * A slot appears when this kernel READS it (active, driving something) or when this node
 * already STORES it (a shipped loom's value keeps its home — a parameter whose schema entry
 * vanished is a value with nowhere to land). A fresh kernel that names neither gets neither,
 * so the inspector stops opening with four numbered knobs that mean nothing.
 *
 * The definitions themselves come from `pointKernelValueParameters` unchanged — including its
 * `inactiveWhen`, so a stored-but-unread slot still NAMES why it is inactive (§V220/§V360).
 */
const VALUE_SLOT_KEYS: ReadonlySet<string> = new Set(
  Array.from({ length: POINT_KERNEL_VALUE_SLOTS }, (_unused, index) => pointKernelValueKey(index + 1)),
);

/** A kernel node's own, type-fixed parameters: everything in its manifest but the legacy slots. */
export function structuralParameters(schema: ParameterSchema): ParameterSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !VALUE_SLOT_KEYS.has(key)));
}

export function legacyValueParametersFor(
  sourceKeys: ReadonlyArray<string>,
  stored: Readonly<Record<string, unknown>>,
): ParameterSchema {
  const all = pointKernelValueParameters(sourceKeys);
  const sources = sourceKeys.map((key) => String(storedStaticValue(stored[key] as never) ?? ""));
  const schema: ParameterSchema = {};
  for (let slot = 1; slot <= POINT_KERNEL_VALUE_SLOTS; slot += 1) {
    const key = pointKernelValueKey(slot);
    const definition = all[key];
    if (definition === undefined) continue;
    if (kernelReadsValueSlot(slot, ...sources) || stored[key] !== undefined) schema[key] = definition;
  }
  return schema;
}

/**
 * T900 — the kernel's OWN `struct Params`, through the SAME reflector `customWgsl` uses.
 *
 * This is the whole of "parity by reuse": `extractParamsStruct` and `reflectParamsStruct` are
 * the ones in `params-reflection.ts`, node-agnostic and shared, so `orbitSpeed: f32` becomes an
 * *Orbit Speed* number and `lightColor: vec4f` an RGBA picker on a point kernel for exactly the
 * reason it does on a custom shader — and the ceiling of four dies, because a struct has no
 * ceiling. The declaration is lifted out of the kernel body: WGSL needs it above the generated
 * `PointCtx` that carries it, and hoisting the author's own bytes beats re-emitting them.
 *
 * ⚠ THE INVALIDATION SPLIT (§V5 / §T900). One reflection pass, two classes:
 *   - the FIELDS become ordinary parameters, NOT `compileTime` — turning `orbitSpeed` is a
 *     uniform write into `kernelFrame`, and the pipeline is never rebuilt.
 *   - the TEXT they were read from (`kernel`) and the ATTRIBUTE schema (`attributes`) are
 *     `compileTime`, so changing the struct — or the point layout — rebuilds the region.
 * The classifier decides this off the node's EFFECTIVE schema (`classifyEdit`), which is what
 * makes the split a property of the manifest rather than of a key happening to be missing.
 */
export function kernelParamsFor(stored: Readonly<Record<string, unknown>>): {
  declaration: string;
  fields: ReadonlyArray<ReflectedField>;
} {
  const source = storedStaticValue(stored["kernel"] as never);
  /* T1210: a node with NO stored kernel reflects the SHIPPED DEFAULT's struct, which is the
     source it would compile with — `compile()` has always applied that same fallback, and
     `customWgsl.parametersFor` has always applied it too. Without it the two halves
     disagreed: the schema had no `jitter`, so a value set for it resolved to nothing while
     the pass bound the default anyway — a knob that reads back as absent and writes as
     ignored. An EMPTY STRING is a string and stays one: a user who deletes the block gets no
     controls, because deleting is an edit and only an ABSENT key means "never edited". */
  const text = typeof source === "string" ? source : DEFAULT_POINT_KERNEL;
  const { declaration } = extractParamsStruct(text);
  return { declaration, fields: declaration === "" ? [] : reflectParamsStruct(declaration) };
}

/**
 * The kernel text with its `struct Params` removed — what the generated module pastes.
 * Same extraction as `kernelParamsFor`, so the declaration hoisted above and the body pasted
 * below can never be two different readings of one text.
 */
export function kernelBodyOf(source: string): string {
  return extractParamsStruct(source).rest;
}

/** T1581b (F9): the diagnostic code of a kernel's `// @use` refusals. */
export const POINT_KERNEL_MODULE_CODE = "node.points.module";

/**
 * T1581b (F9) — A KERNEL'S SHARED MODULES. A kernel source may pull shared WGSL in with
 * `// @use <name>` exactly as a Custom WGSL and a Material · WGSL do (one resolver, §V349),
 * which is how a kernel that writes a per-instance `orient` reaches the `quat` module.
 *
 * The module text is pasted in FRONT of the kernel body, at module scope, so its functions
 * are declared before `process` reads them. Both failures refuse by name, as they do on the
 * two shader nodes: a module that does not exist (the kernel would compile without the code
 * it asked for), and a name the kernel and a module both declare (one would shadow the other).
 *
 * Each text asks for itself: the advanced kernel's SPAWN HOOK is a module of its own, and a
 * hook that turns its newborns writes its own `// @use quat` (`what` names it in a refusal).
 */
export function kernelSharedModules(
  nodeId: string,
  kernelSource: string,
  what: "kernel" | "spawn hook" = "kernel",
): { readonly prelude: string } | { readonly refusal: CompiledNodeDescription } {
  const shared = sharedModulesOf(kernelSource);
  if (shared.missing.length > 0) {
    return {
      refusal: {
        passes: [],
        diagnostics: shared.missing.map((name) => ({
          severity: "error" as const,
          code: POINT_KERNEL_MODULE_CODE,
          message: `Node "${nodeId}": \`// @use ${name}\` names a shared WGSL module that does not exist.`,
          nodeId,
          suggestion: `Shared modules: ${Object.keys(SHARED_WGSL_MODULES).join(", ")}.`,
        })),
      },
    };
  }
  if (shared.clashes.length > 0) {
    return {
      refusal: {
        passes: [],
        diagnostics: shared.clashes.map(({ module, declared }) => ({
          severity: "error" as const,
          code: POINT_KERNEL_MODULE_CODE,
          message: `Node "${nodeId}": this ${what} declares "${declared}", which the shared module "${module}" also declares — one of the two would be silently shadowed.`,
          nodeId,
          suggestion: `Rename yours, or drop \`// @use ${module}\` and keep your own.`,
        })),
      },
    };
  }
  return { prelude: shared.prelude };
}

/**
 * What a kernel SOURCE asks of the shared modules: a pure function of the bytes, remembered
 * per source because §T259 compiles every frame (the reason `resolveSharedModules` itself
 * is). The node id is not in it: the same text on two nodes shares one entry.
 */
function sharedModulesOf(kernelSource: string): KernelSharedModules {
  const hit = sharedModulesBySource.get(kernelSource);
  if (hit !== undefined) return hit;
  const shared = resolveSharedModules(kernelSource);
  const own = shared.names.length === 0 ? new Set<string>() : new Set(declaredNames(kernelSource));
  const clashes = shared.names.flatMap((name) =>
    declaredNames((SHARED_WGSL_MODULES[name] as { source: string }).source)
      .filter((declared) => own.has(declared))
      .map((declared) => ({ module: name, declared })),
  );
  return remember(sharedModulesBySource, kernelSource, { prelude: shared.prelude, missing: shared.missing, clashes });
}

interface KernelSharedModules {
  readonly prelude: string;
  readonly missing: readonly string[];
  readonly clashes: ReadonlyArray<{ readonly module: string; readonly declared: string }>;
}

const sharedModulesBySource = new Map<string, KernelSharedModules>();

/**
 * T1523b — A GENERATED KERNEL'S SOURCE MAP: which lines of the module are which parameter's.
 *
 * Codegen says where it pasted each text (`module.placed`); this says what each text WAS:
 * the kernel minus its hoisted `struct Params` (so the body maps around the cut and the
 * declaration back to where it was written), and a group predicate or spawn hook with the
 * leading whitespace codegen trimmed off. A device error on the author's line 3 then reads
 * line 3, not line 84 of a module they never saw.
 *
 * Memoised by the generated text (§T259 compiles every frame; the module's text is the
 * `wgsl` tag's cached string), with the inputs kept beside it so a different reading of the
 * same bytes can never be handed a stale map.
 */
export function kernelSourceMap(
  module: { readonly wgsl: string; readonly placed: KernelModulePlacements },
  texts: {
    readonly kernel: string;
    readonly group?: string;
    readonly spawn?: string;
    /** T1581b (F9): the shared-module text pasted in front of the kernel body (`kernelSharedModules`). */
    readonly prelude?: string;
    /** … and in front of the spawn hook, in the hook's own module. */
    readonly spawnPrelude?: string;
  },
): WgslSourceMap {
  const group = texts.group ?? "";
  const spawn = texts.spawn ?? "";
  const hit = kernelMaps.get(module.wgsl);
  if (hit !== undefined && hit.kernel === texts.kernel && hit.group === group && hit.spawn === spawn) return hit.map;
  const spans: AuthoredSpan[] = [];
  const { declaration, start } = extractParamsStruct(texts.kernel);
  if (module.placed.kernel !== undefined) {
    /* The author's text starts after the modules it asked for. */
    const at = advance(module.placed.kernel, texts.prelude ?? "");
    spans.push(...placedAroundCut("kernel", texts.kernel, start, start + declaration.length, at));
  }
  if (module.placed.params !== undefined && declaration !== "") {
    spans.push(placed("kernel", declaration, module.placed.params, endOf(texts.kernel.slice(0, start))));
  }
  if (module.placed.group !== undefined) {
    spans.push(placed("group", group.trim(), module.placed.group, trimmedStart(group)));
  }
  if (module.placed.hook !== undefined) {
    spans.push(placed("spawn", spawn.trim(), advance(module.placed.hook, texts.spawnPrelude ?? ""), trimmedStart(spawn)));
  }
  kernelMaps.set(module.wgsl, { kernel: texts.kernel, group, spawn, map: spans });
  if (kernelMaps.size > KERNEL_MAP_LIMIT) {
    const oldest = kernelMaps.keys().next();
    if (oldest.done !== true) kernelMaps.delete(oldest.value);
  }
  return spans;
}

type KernelModulePlacements = Extract<ReturnType<typeof generateKernelModule>, { ok: true }>["placed"];

/** Where a text's first non-blank character is — codegen pastes the TRIMMED group and hook. */
function trimmedStart(raw: string): { line: number; column: number } {
  return endOf(raw.slice(0, raw.length - raw.trimStart().length));
}

const KERNEL_MAP_LIMIT = 64;
const kernelMaps = new Map<
  string,
  { readonly kernel: string; readonly group: string; readonly spawn: string; readonly map: WgslSourceMap }
>();

/**
 * T900's collision pair, now shared — see `reflectedParamSchema` / `reflectedParamCollisions` in
 * `params-reflection.ts`. A reflected field may not take a name this node already owns (it would
 * overwrite `Capacity` or `Seed` with a knob of the same name); the node's parameter wins, the
 * reflected one is dropped, and the compiler refuses by name rather than skipping it in silence
 * (§V288). T1059 moved the pair beside the reflector when `customWgsl` needed the same guard
 * (§V349) — these two keep the point family's help text and diagnostic code in one place.
 */
export const POINT_KERNEL_PARAM_CODE = "node.points.params";

export function kernelParamSchema(
  fields: ReadonlyArray<ReflectedField>,
  ownKeys: ReadonlySet<string>,
): ParameterSchema {
  return reflectedParamSchema(
    fields,
    ownKeys,
    (field) =>
      `Reaches the kernel as \`ctx.params.${field.name}\` (${field.wgsl}). A uniform write, never a rebuild (§V5).`,
  );
}

export function kernelParamCollisions(
  nodeId: string,
  fields: ReadonlyArray<ReflectedField>,
  ownKeys: ReadonlySet<string>,
): RuntimeDiagnostic[] {
  return reflectedParamCollisions(nodeId, fields, ownKeys, POINT_KERNEL_PARAM_CODE);
}

/**
 * T479: the uniform mirror, defined beside the schema it must match. vgpu writes uniform
 * values BY NAME into the reflected layout, so a member with no value silently reads zero
 * and a value with no member is silently dropped — the hazard `KernelModule.usesPointer`
 * documents, now with four more names to keep in step.
 */
export function pointKernelValueUniforms(
  slots: ReadonlyArray<number>,
  parameters: Readonly<Record<string, ParameterValue>>,
): Record<string, number> {
  return Object.fromEntries(
    slots.map((slot) => [pointKernelValueKey(slot), readNumber(parameters, pointKernelValueKey(slot), 0)]),
  );
}

/**
 * T587: a generated module's advisories, as diagnostics on the node that emitted it.
 *
 * SEVERITY IS `info`, and the reasoning lives at `wrappingClockNotice` in codegen where the
 * notice is built. The mapping is here rather than there because codegen is a pure WGSL
 * unit with no opinion about the diagnostic bus — and it is ONE function rather than two so
 * the basic and the advanced kernel cannot come to disagree about how loud this is.
 *
 * Every point node that generates a module calls this, so a module gaining a second kind of
 * notice reaches both nodes at once.
 */
export function pointKernelNoticeDiagnostics(
  nodeId: string,
  notices: ReadonlyArray<KernelNotice>,
): RuntimeDiagnostic[] {
  return notices.map((notice) => ({
    severity: "info" as const,
    code: notice.code,
    message: `Node "${nodeId}": ${notice.message}`,
    nodeId,
    suggestion: notice.suggestion,
  }));
}

export const pointKernelNode: NodeDefinition = {
  type: "pointKernel",
  version: 1,
  title: "Point Kernel",
  category: "points",
  description:
    "Runs a per-point WGSL kernel over a GPU point set every frame. The POP-style custom operator. For a lot in 0..n-1 from a hash, `// @use lot` and hashLot(h, n): never divide a hash's high half (h >> 16u) by a constant, which Apple GPUs get wrong.",
  tags: ["points", "particles", "compute", "simulation"],
  inputs: [
    {
      // T401 (B57): the PROCESSOR port. Optional, so every existing kernel-as-source
      // graph keeps compiling byte-identically (§V309); connected, the kernel reads the
      // upstream pointset's attributes instead of its own last frame — torus in,
      // displaced torus out, the SOP-chain shape the catalogue was missing.
      id: "in",
      label: "Points In",
      optional: true,
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description:
        "Optional upstream point set. Attributes the schema shares with it are read from upstream; the rest keep this node's own state.",
    },
    {
      // T477: the advection FIELD — sparks carried by a fluid, the 2D↔3D crossing.
      // Optional and use-detected: an unwired field costs nothing, and a kernel that
      // calls fieldAt with nothing wired is refused by name (§V288/§V309).
      id: "field",
      label: "Field",
      optional: true,
      type: DATA_TEXTURE,
      description:
        "Optional texture the kernel samples with fieldAt(position) — clip-space xy mapped to uv, exactly as Texture To Attribute maps it. Read with textureLoad, so data fields work on Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      // The producer's `requires` is its PROVIDES list (§V13): consumers may demand any
      // subset. Position is guaranteed by schema validation above; everything else in a
      // custom schema rides along without appearing here.
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "The simulated point set. position:vec3f is guaranteed; other attributes follow the schema.",
    },
  ],
  /**
   * T1052: `codeParametersLast` is the manifest declaring that the text editors sort BELOW
   * everything else — the same rule the reflected schema below applies to the knobs read out
   * of the kernel. Declaration order is preserved within each half.
   */
  parameters: codeParametersLast({
    capacity: {
      type: "number",
      label: "Capacity",
      default: 4096,
      min: 1,
      max: 1_000_000,
      range: "bounded",
      step: 1,
      compileTime: true,
      description: "Allocated point slots. Changing it reallocates and resets the system.",
    },
    seed: {
      type: "number",
      label: "Seed",
      default: 7,
      step: 1,
      description: "Feeds pointRand(seed, pointId, frame) — same seed, same motion (§V74).",
    },
    /**
     * T1583b — KERNEL STEPS. Two counts, the pair Notch's Physics Root and TouchDesigner's
     * Flex Solver expose, and the kernel runs their product per displayed frame.
     *
     * Neither is `compileTime`, and neither may become it (§V358): the plan carries the
     * region at count 1 so that an expression driving either is a value write. That is
     * what makes Notch's RATE form expressible without a second parameter set —
     * `clamp(ceil(delta * 240), 1, 16)` holds the step near 1/240 s when a frame drops,
     * where a bare count would let the step double exactly when stability matters.
     *
     * The name is Feedback's and the meaning is not, which both descriptions say: that
     * node repeats a LOOP of nodes and changes no shader's delta; this one divides it.
     */
    substeps: {
      type: "number",
      label: "Substeps",
      default: 1,
      min: 1,
      max: MAX_KERNEL_SUBSTEPS,
      range: "bounded",
      step: 1,
      description:
        "Runs the kernel this many times per displayed frame, each run reading what the one before wrote, with ctx.delta DIVIDED by it — the frame covers the same time in smaller steps, which is what keeps stiff springs and fast points stable. (Feedback's Substeps repeats its loop and leaves every shader's delta alone; this one divides it.) A per-frame value, so it can hold a step size instead of a count: clamp(ceil(delta * 240), 1, 16). The kernel reads ctx.substep (0 to ctx.substeps-1). Costs that many dispatches. A kernel wired as a processor whose every attribute comes from the incoming point set has nothing to carry between runs and stays at one.",
    },
    iterations: {
      type: "number",
      label: "Iterations",
      default: 1,
      min: 1,
      max: MAX_KERNEL_STEPS,
      range: "bounded",
      step: 1,
      description:
        `Runs per SUBSTEP, at the same ctx.delta — the passes a constraint solver relaxes with. Dispatches per frame are Substeps × Iterations, at most ${MAX_KERNEL_STEPS}. The kernel reads ctx.iteration (0 to ctx.iterations-1): integrate when it is 0 and relax on the runs after it, alternating the halves of a chain with ctx.iteration & 1u so two neighbours never correct the same link in one run. pointAt reads the previous run, so a run that integrates cannot also relax against where its neighbours have just moved to.`,
    },
    attributes: {
      type: "code",
      language: "json",
      label: "Attributes",
      default: "",
      compileTime: true,
      description: 'JSON schema, e.g. [{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]. Empty = position/velocity/id.',
    },
    kernel: {
      type: "code",
      language: "wgsl",
      label: "Kernel",
      default: DEFAULT_POINT_KERNEL,
      compileTime: true,
      description:
        "fn process(p: Point, ctx: PointCtx) -> Point. Clocks first: ctx.absTime (f32 seconds) and ctx.absFrame (u32 — a texture shader's frameU.absFrame is f32) keep counting across a timeline loop, so reach for these for anything that should simply keep going. ctx.time and ctx.frameIndex are timeline readings and reset to the in point at every lap — take them only when where you are IN the piece is the point (a sweep, a scrubbed envelope), and write \"timeline-anchored\" in a comment when you do. ctx also carries index, count and delta — plus pointer (vec4f: x, y, buttons) and dim (cols, rows, i, j — the grid off the incoming edge, T472) for a kernel that names them, and substep, substeps, iteration and iterations (u32: which run of this frame it is, when Substeps or Iterations is above 1; delta is already divided by substeps). YOUR OWN KNOBS (T900): the kernel this node ships with ALREADY declares a `struct Params`, with a `// @default <literal>` and a describing comment per field (T1210) — keep the block and add to it. Every field becomes a named, typed, drivable control on this node, read as ctx.params.<name> — a uniform write, never a rebuild. A kernel with no such block has no knobs at all. That replaces ctx.value1..value4, which still work for kernels that already read them. pointRand(pointId, salt) is available, and fieldAt(position) samples the field input when one is wired (T477). SHARED CODE (T1581b): a line `// @use quat` pulls in unit-quaternion helpers for a per-instance orient — quatAxisAngle(axis, angle), quatMul(a, b) (b first, then a), quatRotate(q, v), quatFromFrame(x, y, z), quatLookAt(forward, up), quatFromTo(a, b), quatSlerp(a, b, t); right-handed, (x, y, z, w). A module that does not exist is refused by name.",
    },
    group: {
      type: "code",
      language: "wgsl",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T300: WGSL predicate over (p, ctx) — e.g. p.position.y > 0.0. Only matching points run the kernel; the rest pass through unchanged. Empty = all.",
    },
    // T479/T900: the legacy live channel, kept in the STATIC schema so a type-only context
    // (palette, help) still documents `ctx.value1`. A placed node's slots come from
    // `parametersFor` below and appear only when read or already stored — parse forever,
    // emit never.
    ...pointKernelValueParameters(["kernel", "group"]),
  }),
  /**
   * T900 (§V805, §T880's design rather than its shortcut): this node's controls ARE its
   * kernel's own `struct Params`, reflected by the shared reflector `customWgsl` uses. Declare
   * `orbitSpeed: f32` or `lightColor: vec4f` in the kernel and the knob appears — named, typed,
   * drivable, publishable — instead of `value2` with a comment saying what it means.
   *
   * The two classes this one pass produces have DIFFERENT invalidation, which is the whole
   * hazard §T900 named: a reflected field is a plain parameter, so turning it writes a uniform
   * (§V5); `kernel` and `attributes` stay `compileTime`, so changing the struct or the point
   * layout rebuilds. Nothing here may be marked `compileTime`, and nothing above may lose it.
   */
  parametersFor(stored) {
    const own = structuralParameters(pointKernelNode.parameters);
    // T1052: code LAST — the reflected knobs and the legacy slots sit above the kernel text
    // they were read out of, so nothing worth turning is below a screenful of WGSL.
    return codeParametersLast({
      ...own,
      ...kernelParamSchema(kernelParamsFor(stored).fields, new Set(Object.keys(own))),
      ...legacyValueParametersFor(["kernel", "group"], stored),
    });
  },
  parameterKeysNote: REFLECTED_PARAMETER_KEYS_NOTE,
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  // T1583b: the compiler wraps this node's one dispatch in a loop region and reads the
  // region's count from these two — nothing in `compile` below repeats anything.
  steps: { substeps: "substeps", iterations: "iterations" },
  contractVersion: POINT_KERNEL_CONTRACT_VERSION,
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters, inputs } = readCompileInputs(context);

    const capacity = Math.max(1, Math.round(readNumber(parameters, "capacity", 4096)));
    const { attributes, error } = parseAttributes(parameters["attributes"]);
    if (attributes === undefined) {
      return {
        passes: [],
        diagnostics: [
          { severity: "error", code: "node.points.attributes", message: `Node "${nodeId}": ${error}`, nodeId },
        ],
      };
    }

    /*
     * T401 (B57): the incoming pointset, when the processor port is wired.
     *
     * The chain contract, decided here and pinned by test:
     *  - CAPACITY must MATCH the node's own, refused by name otherwise — never adopted
     *    silently. The parameter also sizes this node's pairs and its dispatch, so a
     *    silent adoption would make the inspector's number a lie, and a three-node
     *    chain would truncate or over-read wherever the numbers first disagreed.
     *  - a COUNTED upstream (GPU live count) is refused: this kernel processes a fixed
     *    capacity, and splatting the dead tail through `process()` would resurrect it.
     *  - a shared attribute with a DIFFERENT (or undeclared) type is refused. Falling
     *    back to this node's own state would quietly feed defaults where the user
     *    wired data — the silent-wrong §V288 exists to prevent.
     * Every refusal names what the incoming pointset DOES carry, because the whole
     * error class here is a typo'd or absent attribute.
     */
    const incoming = inputs["in"]?.pointset;
    const refuse = (message: string, suggestion?: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        {
          severity: "error" as const,
          code: "node.points.input",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    });
    if (incoming !== undefined) {
      const carried = Object.entries(incoming.pairs)
        .map(([name, entry]) => `${name}: ${entry.type ?? "untyped"}`)
        .sort()
        .join(", ");
      if (incoming.count !== undefined) {
        return refuse(
          `the incoming pointset carries a GPU live count, and this kernel processes a fixed capacity — running process() over the dead tail would resurrect it (carries: ${carried}).`,
          "Chain after a static producer, or do this work inside the advanced kernel itself.",
        );
      }
      if (incoming.capacity !== capacity) {
        return refuse(
          `capacity ${capacity} does not match the incoming pointset's ${incoming.capacity} (carries: ${carried}).`,
          `Set capacity to ${incoming.capacity}.`,
        );
      }
      for (const attribute of attributes) {
        const upstream = incoming.pairs[attribute.name];
        if (upstream === undefined) continue; // starts from this node's own state, by design
        if (upstream.type !== attribute.type) {
          return refuse(
            `attribute "${attribute.name}" is ${upstream.type ?? "untyped"} on the incoming pointset but ${attribute.type} in this kernel's schema (carries: ${carried}).`,
            "Match the attribute's type, or rename one of the two.",
          );
        }
      }
    }

    const kernelSource = typeof parameters["kernel"] === "string" ? parameters["kernel"] : DEFAULT_POINT_KERNEL;
    /* T900: the kernel's own `struct Params`, reflected ONCE and used three ways — hoisted
       above the generated `PointCtx`, mirrored into `kernelFrame` as uniform members, and
       already resolved into `parameters` by the compiler through `parametersFor`, so a driven
       or bound control lands here exactly as a `customWgsl`'s does. A field that would shadow
       one of this node's own parameters is refused BY NAME rather than dropped in silence. */
    const params = kernelParamsFor({ kernel: kernelSource });
    const collisions = kernelParamCollisions(
      nodeId,
      params.fields,
      new Set(Object.keys(structuralParameters(pointKernelNode.parameters))),
    );
    if (collisions.length > 0) return { passes: [], diagnostics: collisions };
    const names = attributes.map((attribute) => attribute.name);
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"] : "";
    /* T472 (B85): `ctx.dim` comes off the EDGE, never off a parameter of this node. The
       topology string has ridden the pointset edge since T296 — the dimensions were
       already travelling, they were simply unreachable from inside a kernel, which is why
       E20 retyped `64u` into its WGSL beside the `cols: 64` the user can actually see. A
       non-grid (or absent) topology supplies nothing, and codegen refuses by name only if
       the kernel asks (§V288/§V309: costing nothing when unused is the whole point).
       T1586b: STRIPS are the same index (slot = j × cols + i), so a kernel over curves gets
       the same four numbers — `i` its station, `j` its strip. T1587b: a grid of several
       sheets gives ONE sheet's columns and rows, and how many sheets (`kernelDimOf`). */
    const incomingDim = kernelDimOf(parseTopology(incoming?.topology));
    const fieldTexture = inputs["field"];

    /* T1076: this node's own packed pair, and the addressing table codegen needs. Every
       declared attribute is written, so every one is owned (§V197's "if you write it, you
       own it"); the READS come from upstream wherever the chain shares an attribute. */
    const storage = packedPointStorage(nodeId, attributes, capacity, "write");
    if (!storage.ok) {
      return {
        passes: [],
        diagnostics: storage.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.capacity",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }
    const plan = kernelStorage({
      own: storage,
      touched: names,
      written: names,
      upstream: incoming?.pairs,
    });

    /* T1581b (F9): the shared modules the kernel asked for, in front of its body. */
    const shared = kernelSharedModules(nodeId, kernelSource);
    if ("refusal" in shared) return shared.refusal;
    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      storage: plan.storage,
      kernel: `${shared.prelude}${kernelBodyOf(kernelSource)}`,
      ...(groupSource.trim() === "" ? {} : { group: groupSource }),
      ...(incomingDim === undefined ? {} : { dim: incomingDim.sheets > 1 ? incomingDim : { cols: incomingDim.cols, rows: incomingDim.rows } }),
      ...(fieldTexture === undefined ? {} : { field: true }),
      ...(params.fields.length === 0 ? {} : { params }),
    });
    if (!module.ok) {
      return {
        passes: [],
        diagnostics: module.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.kernel",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }

    /* T1719b: the kernel's uniform block from its resolved values, over the module compiled
       above. The pass is filled through it and a values-only frame asks it again (`values`
       below), so the two cannot disagree (V1032). */
    const uniformsAt = (values: Params): NonNullable<DispatchPassDescriptor["uniforms"]> => ({
      timeSeconds: 0,
      deltaSeconds: 0,
      frameIndex: 0,
      // Preserve unsigned buffer packing: truncate fractions and wrap into u32.
      seed: readNumber(values, "seed", 7) >>> 0,
      count: capacity,
      // T367: present exactly when the generated block declares it. The backend
      // overwrites it every frame from the SAME value the shared block gets (§V182);
      // this entry only reserves the name, because vgpu matches uniforms by name.
      ...(module.usesPointer ? { pointer: [0, 0, 0, 0] } : {}),
      // T510: reserved exactly when the module declared it — the backend overwrites it
      // every dispatch (1u only when this pass's storage was just created or cleared).
      ...(module.usesFirstRun ? { firstRun: 0 } : {}),
      // T479: one entry per slot the module declared, and the value is the RESOLVED
      // parameter — a driven slot arrives already channel-resolved, so the per-frame
      // recompile-and-diff path (T259/§V5) pushes it like any other uniform, with no
      // new machinery at all.
      ...pointKernelValueUniforms(module.usesValues, values),
      // T900: one member per reflected `struct Params` field the module declared, shaped by
      // the SAME reflector that built the control (§V288's by-name mirror hazard — a member
      // with no value reads zero in silence). The values are the RESOLVED parameters, so a
      // driven colour or a bound number rides the per-frame uniform diff (§V5) with no new
      // machinery, exactly as the value slots above do.
      ...reflectedUniforms(module.usesParams, values, KERNEL_PARAM_PREFIX),
      // T489 (B97): the absolute pair, reserved exactly when the module declared it —
      // same by-name mirroring hazard as the pointer above. The backend overwrites both
      // every frame from the numbers the shared block gets, so a kernel and a shader
      // cannot disagree about how long the show has run (§V182).
      ...(module.usesAbsClock ? { absTimeSeconds: 0, absFrameIndex: 0 } : {}),
      // T1583b: the four step members, reserved exactly when the module declared them.
      // The backend overwrites them for every run of a stepped frame; these values are
      // what a kernel that is NOT stepped reads, and they say so — run 0 of 1.
      ...(module.usesSteps ? { substep: 0, substeps: 1, iteration: 0, iterations: 1 } : {}),
    });
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:kernel`,
      shader: module.wgsl,
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / module.workgroupSize), 1, 1],
      /* T401/T1076: a shared attribute is READ out of the upstream's packed buffer (the
         half the edge map names) rather than out of this node's own last frame — the whole
         processor mechanism, and codegen never knows which is which. Binding the upstream
         buffer also makes this pass one of its consumers, so the §V22 swap lands after it
         (T297). Writes stay on this node's own pair, whose swap makes this frame's writes
         next frame's reads. */
      buffers: kernelBufferBindings(module.buffers, plan),
      uniforms: uniformsAt(parameters),
      // T477: exactly when the module declared the texture (§V288's mirror hazard —
      // vgpu binds by name, and a declared texture with no binding fails loudly).
      ...(module.usesField && fieldTexture !== undefined
        ? { textures: [{ binding: "fieldTexture", resourceId: fieldTexture.resource, sampled: "unfiltered" as const }] }
        : {}),
      uniformBinding: "kernelFrame",
      nodeId,
      sourceMap: kernelSourceMap(module, { kernel: kernelSource, group: groupSource, prelude: shared.prelude }),
    };

    return {
      passes: [pass],
      values: (next) => ({ passes: [{ uniforms: uniformsAt(readValueInputs(next).parameters) }] }),
      // T587: the module compiled, and had something to say about the clock it reads.
      // Carried on a SUCCESSFUL compile on purpose — this is advice, not a refusal, and a
      // kernel that means to read the wrapping clock keeps running while it is shown.
      ...(module.notices.length === 0
        ? {}
        : { diagnostics: pointKernelNoticeDiagnostics(nodeId, module.notices) }),
      // T1076: ONE pair for the whole schema; the layout that produced `pairs` below is
      // the same one that sized it, so a key and an id can no longer disagree (§V349).
      scratch: [storage.scratch],
      // T296: the resolved edge payload. The kernel WRITES every declared attribute,
      // so every pair in the map is its own (§V197's "if you write it, you own it").
      pointsets: {
        out: {
          pairs: {
            // T401, §V197's narrowing verbatim: an attribute the incoming pointset
            // carries that this kernel's schema does NOT declare is UNMODIFIED — it
            // passes downstream BY REFERENCE, still the upstream's pair. The kernel
            // owns only what it writes; capacities are equal by the refusal above, so
            // the reference is coherent, and T297's binder-scan swap ownership makes
            // whoever binds it a consumer.
            ...Object.fromEntries(
              Object.entries(incoming?.pairs ?? {}).filter(
                ([name]) => !attributes.some((attribute) => attribute.name === name),
              ),
            ),
            // §V168 through §V231: the kernel writes every region this frame, so the
            // payload names the write half. `type` rides along for mapped parameters
            // (T286) — a consumer swizzles from it, never from a guess.
            ...storage.pairs,
          },
          capacity,
          // Displacing positions never changes CONNECTIVITY: a torus grid through a
          // kernel is still a grid, so the upstream topology rides through (T401).
          topology: incoming?.topology ?? "points",
        },
      },
    };
  },
};


/**
 * T322: everything a renderer needs to draw a COUNTED edge (a producer whose live
 * count is GPU-resident): one tiny dispatch converting the count into indirect draw
 * arguments with the renderer's own per-instance vertex count baked in, the argument
 * buffer, and the `instances: { indirect }` value. Undefined for a static edge — the
 * caller keeps its literal count and this feature costs nothing.
 */

/**
 * T333: resolves a draw-time group predicate against the TYPED edge payload (§V308).
 *
 * The predicate references attributes as `p.<name>`; every referenced attribute is
 * bound on demand — WHICH dissolves the narrowness that originally excluded renderers
 * from T300: with types on the edge, a renderer's predicate language equals the
 * kernel's over stored attributes, no longer just "whatever this renderer binds".
 * Failures are §V288-shaped: by name, saying what the pointset provides.
 */
/**
 * One attribute a draw-time group predicate reads — the edge's REGION plus the name and
 * type the generated WGSL needs (T1076: `attributeBinding` takes it straight).
 */
export interface GroupBind extends PointsetAttributeRef {
  readonly attribute: string;
  readonly type: string;
}

export function resolveGroupPredicate(
  nodeId: string,
  expression: string,
  pointset: { pairs: Readonly<Record<string, Readonly<PointsetAttributeRef>>> } | undefined,
):
  | { expression: string; binds: ReadonlyArray<GroupBind> }
  | { refusal: CompiledNodeDescription } {
  const refuse = (message: string, suggestion?: string): { refusal: CompiledNodeDescription } => ({
    refusal: {
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.points.group",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    },
  });
  const referenced = [...new Set([...expression.matchAll(/\bp\.([A-Za-z_]\w*)/g)].map((m) => m[1] as string))].sort();
  if (referenced.length === 0) {
    return refuse(
      `the group predicate references no attribute — write it over p.<attribute>, e.g. p.position.y > 0.0.`,
    );
  }
  const available = Object.keys(pointset?.pairs ?? {}).sort();
  const binds: GroupBind[] = [];
  for (const attribute of referenced) {
    const entry = pointset?.pairs[attribute];
    if (entry === undefined) {
      return refuse(
        `the group predicate reads "p.${attribute}", which the incoming pointset does not carry.`,
        available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
      );
    }
    if (entry.type === undefined) {
      return refuse(`the group predicate reads "p.${attribute}", but the edge does not declare its type.`);
    }
    binds.push({ ...entry, attribute, type: entry.type });
  }
  return { expression, binds };
}

/**
 * T364/T369: resolves a map on the COMPOUND HEAD `color` against the TYPED edge payload.
 *
 * ONE definition, because there are now two renderers that honour it (§V109): a refusal
 * worded differently on `renderPoints` and on `renderInstances` is two answers to the
 * same question, and the map's whole promise is that the same binding means the same
 * thing wherever a colour is drawn. Every failure is §V288-shaped — by name, saying what
 * the pointset actually provides — and there is no silent fall-back to the retained
 * static, which is the failure a per-point colour cannot show you (the picture stays
 * plausible; it is simply the wrong colour).
 *
 * `pointsPort` is the node's own pointset input id: §V306's `port` names WHICH pointset
 * when a node has several, and naming one that is not this node's is a mistake said out
 * loud rather than ignored.
 */
export function resolveColorMap(
  nodeId: string,
  binding: { attribute: string; channel?: string; port?: string } | undefined,
  pointset: { pairs: Readonly<Record<string, Readonly<PointsetAttributeRef>>> } | undefined,
  pointsPort: string,
  label: string = "color",
  /** T1581b: the attribute type the compound head is — a colour or a quaternion is vec4f, a place is vec3f. */
  type: "vec4f" | "vec3f" = "vec4f",
): { map: Readonly<PointsetAttributeRef> | undefined } | { refusal: CompiledNodeDescription } {
  if (binding === undefined) return { map: undefined };
  const refuse = (message: string, suggestion?: string): { refusal: CompiledNodeDescription } => ({
    refusal: {
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    },
  });
  if (binding.port !== undefined && binding.port !== pointsPort) {
    return refuse(`${label} maps port "${binding.port}", but the only pointset input is "${pointsPort}".`);
  }
  if (binding.channel !== undefined) {
    return refuse(
      `${label} maps the whole compound; a channel belongs on a component slot ("${label}.r"), not the head.`,
    );
  }
  const available = Object.keys(pointset?.pairs ?? {}).sort();
  const entry = pointset?.pairs[binding.attribute];
  if (entry === undefined) {
    return refuse(
      `${label} maps attribute "${binding.attribute}", which the incoming pointset does not carry.`,
      available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
    );
  }
  if (entry.type === undefined) {
    return refuse(
      `${label} maps "${binding.attribute}", but the edge does not declare its type; the producer predates typed pairs.`,
    );
  }
  if (entry.type !== type) {
    return refuse(
      `${label} needs a ${type} attribute to map the whole compound; "${binding.attribute}" is ${entry.type}.`,
    );
  }
  return { map: entry };
}

/**
 * T721 — the SCALAR half of `resolveColorMap`, and it exists for §V109's reason: two
 * nodes now map a per-point SIZE (`renderPoints.sizePixels` and `geometry.scale`), and
 * two copies of "what may drive a size" is two chances for them to refuse a document in
 * different words, or for one of them to grow a channel the other has not heard of.
 *
 * An f32 attribute drives it whole; a float VECTOR needs a channel, because "size from
 * `velocity`" is not a statement until it says which component. Anything else refuses by
 * name (§V288) rather than falling back to the retained static — the fault §B132 shipped
 * for weeks was exactly a size that looked authored and was silently dropped.
 */
/** A resolved scalar map: the attribute's region, its type, and the component to read. */
export interface ScalarMap extends PointsetAttributeRef {
  readonly type: string;
  readonly channel?: string;
}

export function resolveScalarMap(
  nodeId: string,
  binding: { attribute: string; channel?: string; port?: string } | undefined,
  pointset: { pairs: Readonly<Record<string, Readonly<PointsetAttributeRef>>> } | undefined,
  pointsPort: string,
  label: string,
): { map: ScalarMap | undefined } | { refusal: CompiledNodeDescription } {
  if (binding === undefined) return { map: undefined };
  const refuse = (message: string, suggestion?: string): { refusal: CompiledNodeDescription } => ({
    refusal: {
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    },
  });
  if (binding.port !== undefined && binding.port !== pointsPort) {
    return refuse(`${label} maps port "${binding.port}", but the only pointset input is "${pointsPort}".`);
  }
  const available = Object.keys(pointset?.pairs ?? {}).sort();
  const entry = pointset?.pairs[binding.attribute];
  if (entry === undefined) {
    return refuse(
      `${label} maps attribute "${binding.attribute}", which the incoming pointset does not carry.`,
      available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
    );
  }
  if (entry.type === undefined) {
    return refuse(
      `${label} maps "${binding.attribute}", but the edge does not declare its type; the producer predates typed pairs.`,
    );
  }
  const vectorChannels: Record<string, readonly string[]> = {
    vec2f: ["x", "y"],
    vec3f: ["x", "y", "z"],
    vec4f: ["x", "y", "z", "w"],
  };
  if (entry.type === "f32") {
    if (binding.channel !== undefined) {
      return refuse(`${label} maps f32 attribute "${binding.attribute}" with a channel; an f32 has none.`);
    }
    return { map: { ...entry, type: entry.type } };
  }
  const channels = vectorChannels[entry.type];
  if (channels === undefined) {
    return refuse(`${label} cannot map "${binding.attribute}" of type "${entry.type}"; a size needs f32 or a float vector channel.`);
  }
  if (binding.channel === undefined || !channels.includes(binding.channel)) {
    return refuse(`${label} maps ${entry.type} attribute "${binding.attribute}" and needs a channel (${channels.join("/")}).`);
  }
  return { map: { ...entry, type: entry.type, channel: binding.channel } };
}

export function countedDrawSupport(
  nodeId: string,
  pointset: { count?: { buffer: string } } | undefined,
  options: {
    vertexCount: number;
    maxInstances: number;
    /** T478: distinct key per draw when ONE node owns several counted draws (a render
     *  with two counted geometries) — the scratch id is `scratch:{nodeId}:{key}`. */
    argsKey?: string;
  },
):
  | {
      instances: { indirect: string };
      argsPass: DispatchPassDescriptor;
      scratch: { kind: "buffer"; key: string; stride: number; capacity: number; usage: "indirect" };
    }
  | undefined {
  const count = pointset?.count;
  if (count === undefined) return undefined;
  const argsKey = options.argsKey ?? "drawArgs";
  const argsId = pointBufferId(nodeId, argsKey);
  return {
    instances: { indirect: argsId },
    argsPass: {
      kind: "dispatch",
      id: `${nodeId}:${argsKey}`,
      shader: drawArgsWgsl(),
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [
        { binding: "liveCount", resourceId: count.buffer },
        { binding: "drawArgs", resourceId: argsId },
      ],
      uniforms: { vertexCount: options.vertexCount, maxInstances: options.maxInstances },
      uniformBinding: "params",
      nodeId,
    },
    scratch: { kind: "buffer", key: argsKey, stride: 4, capacity: 4, usage: "indirect" },
  };
}

export const renderPointsNode: NodeDefinition = {
  type: "renderPoints",
  version: 1,
  title: "Render Points",
  category: "points",
  description: "Draws a point set as soft billboarded sprites into a texture.",
  tags: ["points", "particles", "sprites", "render"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Needs a vec3f position attribute; everything else rides along.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      range: "bounded",
      step: 1,
      compileTime: true,
      description: "Instances drawn. Matches the producer's capacity until pointset edges carry it.",
    },
    sizePixels: {
      type: "number",
      label: "Size",
      /**
       * T856 — the floor is 0, not 0.5 (§T848 ruling 1).
       *
       * 0.5 was a legible-sprite minimum, and it made "draw nothing" unsayable. That
       * matters most exactly where E35 uses it: as a DRIVEN slot's retained value (§V108),
       * which is what the layer falls back to when the drive is detached. Clamping that
       * fallback to 0.5 would make a detached drive DRAW VISIBLE DOTS — the opposite of
       * what the author meant, and a value the command bus refused, so no UI edit could
       * have produced the shipped file (§T848 (b1)).
       */
      default: 4,
      min: 0,
      max: 256,
      range: "floor",
      unit: "px",
      description:
        "Sprite diameter in output pixels. 0 draws nothing — the honest fallback for a " +
        "driven size whose channel is detached.",
    },
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    blend: {
      type: "enum",
      label: "Blend",
      default: "additive",
      options: [
        { value: "additive", label: "Additive" },
        { value: "alpha", label: "Alpha" },
      ],
      compileTime: true,
    },
    accumulate: {
      type: "boolean",
      label: "Accumulate",
      default: false,
      compileTime: true,
      description: "Skip the clear each frame — sprites pile up into trails (T180).",
    },
    group: {
      type: "string",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T333: draw only matching points — a WGSL predicate over p.<attribute>, e.g. p.position.y > 0.0. Referenced attributes bind on demand from the edge. Empty = all.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const target = outputs["out"];
    const points = inputs["points"];
    if (target === undefined || points === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "points"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    if (points.source === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.source",
            message: `Node "${nodeId}": the points input carries no producer identity; per-attribute buffers cannot be located.`,
            nodeId,
          },
        ],
      };
    }

    const blend = parameters["blend"] === "alpha" ? ("alpha" as const) : ("additive" as const);

    /* T1076: the position REGION off the edge, refused BY NAME when the edge carries none.
       This used to fall back to `pointPairId(source, "position")` — a pre-T296 naming
       convention that packing retires: attributes no longer have buffers of their own, so
       a derived id names nothing and the draw would fail at resource lookup instead. */
    const drawPosition = points.pointset?.pairs["position"];
    if (drawPosition === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position attribute.`,
            nodeId,
          },
        ],
      };
    }

    // T333: the draw-time group. Excluded instances collapse to zero-area quads.
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"].trim() : "";
    let groupPredicate: { expression: string; binds: ReadonlyArray<GroupBind> } | undefined;
    if (groupSource !== "") {
      const resolvedGroup = resolveGroupPredicate(nodeId, groupSource, points.pointset);
      if ("refusal" in resolvedGroup) return resolvedGroup.refusal;
      groupPredicate = resolvedGroup;
    }

    // T369 (§V288, and §V109's "one answer"): renderInstances names a map it cannot
    // honour, so this renderer must too — a map on any OTHER key here (a `blend`, a
    // component slot like `color.r`) was silently ignored before, which is precisely the
    // parameter that looks mapped and is not.
    const unhonoured = Object.keys(parameterMaps)
      .filter((key) => key !== "color" && key !== "sizePixels")
      .sort();
    if (unhonoured.length > 0) {
      return {
        passes: [],
        diagnostics: unhonoured.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} is in map mode, but renderPoints maps only "color" and "sizePixels".`,
          nodeId,
          suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
        })),
      };
    }

    /* T721 moved this to `resolveScalarMap`, the same move T369 made for the colour: the
       geometry node maps a size now too, and one resolver is what keeps the two refusing
       a bad document in the SAME words (§V109). The wording here is unchanged. */
    const resolvedSize = resolveScalarMap(nodeId, parameterMaps["sizePixels"], points.pointset, "points", "sizePixels");
    if ("refusal" in resolvedSize) return resolvedSize.refusal;
    const mappedSize =
      resolvedSize.map === undefined
        ? undefined
        : {
            entry: resolvedSize.map,
            type: resolvedSize.map.type,
            ...(resolvedSize.map.channel === undefined ? {} : { channel: resolvedSize.map.channel }),
          };

    // T364 (§V195 as amended): a map on the COMPOUND HEAD, type-matched — a vec4f
    // attribute drives the whole colour. LINEAR by convention: attributes are data
    // (§V56/§V57); nothing display-decodes a per-point value. T369 moved the resolution
    // to `resolveColorMap` so renderInstances refuses in the SAME words (§V109).
    const resolvedColor = resolveColorMap(nodeId, parameterMaps["color"], points.pointset, "points");
    if ("refusal" in resolvedColor) return resolvedColor.refusal;
    const mappedColor = resolvedColor.map;
    // T322: a counted edge draws INDIRECTLY — the live count is GPU-resident, so a
    // tiny pass converts it to draw arguments and the draw reads them. A static edge
    // keeps the literal count (edge capacity clamped by the param).
    const counted = countedDrawSupport(nodeId, points.pointset, {
      vertexCount: 6,
      maxInstances: Math.max(1, Math.round(readNumber(parameters, "count", 4096))),
    });
    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:sprites`,
      shader:
        mappedSize === undefined && mappedColor === undefined && groupPredicate === undefined
          ? SPRITE_RENDER_WGSL
          : spriteRenderWgsl({
              ...(mappedSize === undefined
                ? {}
                : {
                    sizeMap: {
                      type: mappedSize.type,
                      ...(mappedSize.channel === undefined ? {} : { channel: mappedSize.channel }),
                    },
                  }),
              ...(mappedColor === undefined ? {} : { colorMap: true }),
              ...(groupPredicate === undefined
                ? {}
                : {
                    group: {
                      expression: groupPredicate.expression,
                      binds: groupPredicate.binds.map(({ attribute, type }) => ({ attribute, type })),
                    },
                  }),
            }),
      target,
      topology: "triangle-list",
      // T296: instances = the EDGE's capacity, clamped by the count param — the user
      // no longer keeps two numbers in sync by hand.
      instances:
        counted?.instances ??
        Math.max(
          1,
          Math.min(
            Math.round(readNumber(parameters, "count", 4096)),
            points.pointset?.capacity ?? Math.round(readNumber(parameters, "count", 4096)),
          ),
        ),
      vertexCount: 6,
      buffers: [
        // The producer's position REGION via the edge map, WRITE half: THIS frame's
        // positions (§V168) — whoever owns the buffer (§V197, by-reference reads).
        attributeBinding("positions", drawPosition),
        ...(mappedSize === undefined ? [] : [attributeBinding("mapSizes", mappedSize.entry)]),
        ...(mappedColor === undefined ? [] : [attributeBinding("mapColors", mappedColor)]),
        ...(groupPredicate === undefined
          ? []
          : groupPredicate.binds.map((bind) => attributeBinding(`group_${bind.attribute}`, bind))),
      ],
      // Mapped values LEAVE the uniform block entirely — the struct and the record
      // must keep matching exactly (the catalogue sweep pins that). Both mapped, the
      // block vanishes with the struct.
      ...(mappedSize !== undefined && mappedColor !== undefined
        ? {}
        : {
            uniforms: {
              ...(mappedColor === undefined ? { color: readColor(parameters, "color", [1, 1, 1, 1]) } : {}),
              ...(mappedSize === undefined ? { sizePixels: readNumber(parameters, "sizePixels", 4) } : {}),
            },
            uniformBinding: "params",
          }),
      sharedBinding: "frameU",
      blend,
      clear: parameters["accumulate"] !== true,
      nodeId,
    };
    return counted === undefined
      ? { passes: [pass] }
      : { passes: [counted.argsPass, pass], scratch: [counted.scratch] };
  },
};

/**
 * TextureToAttribute (T124): the TOP→POP bridge — sample a texture per point, write the
 * result as a point attribute. The first pointset consumer outside the family itself,
 * and what makes the two graphs ONE instrument: a Noise TOP driving particle colour,
 * a displacement field steering a sim.
 *
 * Ownership rule for pointset transforms: this node owns FRESH pairs for everything it
 * outputs (position copied through, `sample` written from the texture), because
 * downstream consumers derive pair ids from THEIR source's node id — a pointset node
 * that modified upstream pairs in place would break that derivation and alias state
 * across nodes.
 */
/** T1076: the attribute `textureToAttribute` owns, named once for layout and pass. */
const SAMPLE_ATTRIBUTE: PointAttributeSchema = { name: "sample", type: "vec4f", default: [0, 0, 0, 0] };

export const textureToAttributeNode: NodeDefinition = {
  type: "textureToAttribute",
  version: 1,
  title: "Texture To Attribute",
  category: "points",
  description: "Samples a texture at each point's position and writes it as a point attribute.",
  tags: ["points", "bridge", "texture", "sample"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
    {
      id: "texture",
      label: "Texture",
      type: RGBA_TEXTURE,
      description: "Read with textureLoad — data fields (r32float displacement) work on baseline Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      // Provides position (copied) plus the sampled value.
      type: {
        kind: "pointset",
        requires: [
          { name: "position", type: "vec3f" },
          { name: "sample", type: "vec4f" },
        ],
      },
    },
  ],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      range: "bounded",
      step: 1,
      compileTime: true,
      description: "Matches the producer's capacity until pointset edges carry it.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs } = readCompileInputs(context);
    const points = inputs["points"];
    const texture = inputs["texture"];
    if (points === undefined || texture === undefined) {
      const what = points === undefined ? 'input port "points"' : 'input port "texture"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    if (points.source === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.source",
            message: `Node "${nodeId}": the points input carries no producer identity; per-attribute buffers cannot be located.`,
            nodeId,
          },
        ],
      };
    }

    // T296/§V197: capacity comes off the EDGE, and position passes BY REFERENCE — this
    // node writes only `sample`, so `sample` is the only pair it owns. The old
    // copy-everything shape existed purely for the id-derivation convention the edge
    // map replaces; its per-frame memcpy is simply gone.
    const upstream = points.pointset;
    const upstreamPosition = upstream?.pairs["position"];
    if (upstream === undefined || upstreamPosition === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position pair (producer predates T296?).`,
            nodeId,
          },
        ],
      };
    }
    const count = upstream.capacity;
    // T1076: this node owns `sample` alone; the rest passes by reference (§V197).
    const storage = packedPointStorage(nodeId, [SAMPLE_ATTRIBUTE], count, "write");
    if (!storage.ok) {
      return {
        passes: [],
        diagnostics: storage.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.capacity",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:bridge`,
      shader: TEXTURE_TO_ATTRIBUTE_WGSL,
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        // The producer's region, WRITE half: this frame's positions, in plan order (§V168).
        attributeBinding("in_position", upstreamPosition),
        attributeBinding("out_sample", storage.pairs["sample"] as PointsetAttributeRef),
      ],
      textures: [{ binding: "sourceTexture", resourceId: texture.resource, sampled: "unfiltered" }],
      uniforms: { count },
      uniformBinding: "bridgeFrame",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [storage.scratch],
      pointsets: {
        out: {
          pairs: { ...upstream.pairs, ...storage.pairs },
          capacity: count,
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        },
      },
    };
  },
};

/**
 * T483 — the Ray POP: every point casts a ray against a HEIGHT FIELD and the hit comes
 * back as attributes, ready for the next kernel — GPU-resident per point, the owner's
 * "Ray POP not the SOP". Why a heightfield and not mesh intersection is argued on the
 * shader (`pointRayWgsl`); the short form: a displaced grid has no closed-form
 * intersection, brute force is P×2C, and a marched field is steps×P with the cost on a
 * parameter. Rays default straight down (rain onto terrain); a pointset carrying a
 * vec3f `direction` attribute aims each ray itself.
 */
/** T1076: the hit attributes `pointRay` owns, in packed-layout order. */
export const RAY_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "hit", type: "f32", default: [0] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "hitNormal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
  { name: "hitDistance", type: "f32", default: [0] },
];

export const pointRayNode: NodeDefinition = {
  type: "pointRay",
  version: 1,
  title: "Ray",
  category: "points",
  description:
    "Casts one ray per point against a height-field texture and writes hit, hitPosition, hitNormal and hitDistance as attributes. Cost = steps × points, every frame.",
  tags: ["points", "ray", "raycast", "collision", "heightfield"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Ray origins. A vec3f `direction` attribute, when carried, aims each ray; otherwise the Direction parameter aims all of them.",
    },
    {
      id: "field",
      label: "Field",
      type: RGBA_TEXTURE,
      description:
        "The height field: R is height (y = r × Height Scale + Height Offset) over world x,z ∈ [−Extent, +Extent]. Read with textureLoad — r32float data fields work on Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: {
        kind: "pointset",
        requires: [
          { name: "position", type: "vec3f" },
          { name: "hit", type: "f32" },
          { name: "hitPosition", type: "vec3f" },
          { name: "hitNormal", type: "vec3f" },
          { name: "hitDistance", type: "f32" },
        ],
      },
      description: "The same points, plus what each ray found. hit is 1 or 0; a miss carries the ray's end and the full distance.",
    },
  ],
  parameters: {
    steps: {
      type: "number",
      label: "Steps",
      default: 32,
      min: 1,
      max: 256,
      range: "bounded",
      step: 1,
      compileTime: true,
      description: "March samples per ray. THE cost knob: steps × points texture reads per frame.",
    },
    maxDistance: { type: "number", label: "Max Distance", default: 8, min: 0.01, range: "floor", description: "Ray length in world units." },
    direction: {
      type: "vector",
      size: 3,
      label: "Direction",
      default: [0, -1, 0],
      description: "Every ray's direction — unless the incoming points carry a vec3f `direction` attribute, which wins.",
    },
    extent: {
      type: "number",
      label: "Extent",
      default: 4,
      min: 0.01,
      range: "floor",
      description: "The field spans world x,z ∈ [−extent, +extent]. Explicit, like the shadow volume (V426): nothing knows your scene's bounds.",
    },
    heightScale: { type: "number", label: "Height Scale", default: 1, description: "y = texel.r × scale + offset." },
    heightOffset: { type: "number", label: "Height Offset", default: 0 },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const points = inputs["points"];
    const field = inputs["field"];
    if (points === undefined || field === undefined) {
      const what = points === undefined ? 'input port "points"' : 'input port "field"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const upstream = points.pointset;
    const position = upstream?.pairs["position"];
    if (upstream === undefined || position === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position pair (producer predates T296?).`,
            nodeId,
          },
        ],
      };
    }
    if (upstream.count !== undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.input",
            message: `Node "${nodeId}": the incoming pointset carries a GPU live count; this ray pass runs a fixed capacity and would cast from the dead tail.`,
            nodeId,
            suggestion: "Ray a static set, or run the query inside the advanced kernel.",
          },
        ],
      };
    }
    // The direction ATTRIBUTE wins when the edge carries one of the right type; a wrong
    // type refuses rather than quietly falling back to the parameter (§V288).
    const carried = upstream.pairs["direction"];
    if (carried !== undefined && carried.type !== "vec3f") {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.input",
            message: `Node "${nodeId}": the incoming \`direction\` attribute is ${carried.type ?? "untyped"}, and a ray needs vec3f — falling back to the parameter would silently ignore wired data.`,
            nodeId,
          },
        ],
      };
    }
    const count = upstream.capacity;
    const steps = Math.max(1, Math.min(256, Math.round(readNumber(parameters, "steps", 32))));
    const direction = ((): readonly [number, number, number] => {
      const raw = parameters["direction"];
      const list = Array.isArray(raw) ? raw : [0, -1, 0];
      return [Number(list[0] ?? 0), Number(list[1] ?? -1), Number(list[2] ?? 0)];
    })();
    // T1076: the four hit attributes are regions of ONE packed pair.
    const storage = packedPointStorage(nodeId, RAY_ATTRIBUTES, count, "write");
    if (!storage.ok) {
      return {
        passes: [],
        diagnostics: storage.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.capacity",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:ray`,
      shader: pointRayWgsl({ steps, directionAttribute: carried !== undefined }),
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        attributeBinding("in_position", position),
        ...(carried === undefined ? [] : [attributeBinding("in_direction", carried)]),
        ...RAY_ATTRIBUTES.map((attribute) =>
          attributeBinding(`out_${attribute.name}`, storage.pairs[attribute.name] as PointsetAttributeRef),
        ),
      ],
      textures: [{ binding: "fieldTexture", resourceId: field.resource, sampled: "unfiltered" }],
      uniforms: {
        count,
        extent: Math.max(0.01, readNumber(parameters, "extent", 4)),
        heightScale: readNumber(parameters, "heightScale", 1),
        heightOffset: readNumber(parameters, "heightOffset", 0),
        maxDistance: Math.max(0.01, readNumber(parameters, "maxDistance", 8)),
        direction: [direction[0], direction[1], direction[2], 0],
      },
      uniformBinding: "rayFrame",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [storage.scratch],
      pointsets: {
        out: {
          pairs: { ...upstream.pairs, ...storage.pairs },
          capacity: count,
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        },
      },
    };
  },
};

/**
 * Exported separately from `coreNodeDefinitions` until the compiler accepts
 * dispatch/draw emission and bufferPair scratch (see module doc).
 */
export const pointNodeDefinitions: readonly NodeDefinition[] = [
  pointKernelNode,
  pointRayNode,
  textureToAttributeNode,
  renderPointsNode,
];
