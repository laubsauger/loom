import {
  COMPONENT_COUNTS,
  validateAttributes,
  type PointAttributeSchema,
} from "./attributes.ts";
import { MAX_SPAWN_PER_PARENT } from "./lifecycle.ts";

/**
 * The attribute→WGSL codegen module (T117) — named the TOP RISK of the P3a slice, which
 * is why it is its own small, pure, heavily-tested unit instead of a side effect of the
 * first point node.
 *
 * Given an attribute schema and a per-point kernel, it generates the complete compute
 * module: the `Point` struct assembled from per-attribute buffer loads, the read/write
 * buffer bindings (structure-of-arrays; written attributes get an in/out PAIR so a
 * kernel always reads the pre-frame value), the deterministic RNG (§V74: every random
 * draw is `hash(seed, pointId, frameIndex, salt)` — same seed, same point, same frame,
 * same value, on every device), and the dispatch wrapper with its count guard.
 *
 * The kernel ABI (§V77, versioned below) is one pure function:
 *
 *     fn process(p: Point, ctx: PointCtx) -> Point { … }
 *
 * `ctx.index` is the SLOT — usable for addressing, never for identity (§V73: slots move
 * under compaction; identity is the id attribute's value). No raw buffer access exists
 * in the contract; neighbor iteration arrives later as an addition to `PointCtx`, which
 * is exactly why the wrapper owns all loads and stores.
 *
 * `ctx.pointer` (T367) is the first OPTIONAL member: present only in a kernel that names
 * it, so a graph that does not read the pointer generates exactly the text it generated
 * before the member existed (§V309). Its four numbers are the shared frame block's, byte
 * for byte — one publisher, one convention, §V182.
 *
 * `ctx.dim` (T472) is the second, and it exists to end B85: E20 hard-coded `64u` twice
 * inside its WGSL while `cols: 64` sat in two node parameters, so turning the visible
 * knob silently broke the kernel (§V349, with the extra sting that the reachable control
 * LIED). The grid is already travelling — the topology string rides the pointset edge
 * (T296/T302) — it was simply not reachable from inside a kernel. Same detection, same
 * zero cost when unused.
 *
 * `ctx.value1` … `ctx.value4` (T479) are the third, and they close the last absent
 * channel: `kernel`, `attributes` and `group` are all `compileTime`, so before this every
 * point animation's SHAPE lived in WGSL rather than in the graph — an LFO could drive a
 * kernel's uniforms but never its behaviour. Each slot is an ordinary DRIVABLE parameter
 * on the node, so the channel reference is stored where the value graph already stores
 * one and is rewritten by rename like every other (§V128/§V316, kind 2). See
 * `VALUE_REFERENCE` for why the name is NOT written inside the WGSL.
 */

/** Bumped when the generated Point/PointCtx/process signature changes shape (§V77). */
export const POINT_KERNEL_CONTRACT_VERSION = 1;

/**
 * Contract for the LIFECYCLE variant (T322/T323): same `process` signature, plus a
 * GPU-resident live-count guard and the packed flags word exposed as `alive` and
 * `spawnCount` Point fields (both write-only by construction).
 *
 * THE BINDING BUDGET, and the two named ways past it (documented per B33 — the limit
 * fails SILENTLY when exceeded, so the strategy must be written where the arithmetic
 * lives, not rediscovered):
 *
 * Baseline WebGPU guarantees 8 storage buffers per compute STAGE (bind GROUPS do not
 * raise the per-stage limit). The lifecycle kernel spends 2·(n−1)+2 for n attributes
 * incl. flags — the default schema lands exactly at 8, and one more attribute busts
 * it, which is why the spawn(parent) hook (2n+4 in one pass) is deferred. The paths:
 *
 *  1. REQUEST a higher limit at device creation: `maxStorageBuffersPerShaderStage`
 *     is a baseline DEFAULT, not a ceiling — most desktop adapters offer 10–64+.
 *     `initialize()` can pass requiredLimits from `adapter.limits` and the compiler's
 *     budget checks (T328) then validate against the REAL device limit instead of 8.
 *     This widens every kernel at once and is the right first move.
 *
 *  2. TWO-PASS spawn hook: children are copied first (chunked, fits), then an
 *     in-place `spawn(child: Point, ctx)` kernel runs over just the newborn range —
 *     the child arrives as its parent's copy, so inheritance is the initial value
 *     and the pass needs only n+2 bindings. Correct hook semantics regardless of
 *     limits; design it with T287's attribute qualifiers.
 */
export const ADVANCED_KERNEL_CONTRACT_VERSION = 2;

export const DEFAULT_WORKGROUP_SIZE = 64;

export interface PointBufferBinding {
  /** Attribute this binding carries. */
  readonly attribute: string;
  /** WGSL variable name (`in_position`, `out_position`). */
  readonly variable: string;
  readonly binding: number;
  readonly access: "read" | "read_write";
  /** Written attributes bind an in/out pair; `live` is the lifecycle count buffer (T322). */
  readonly role: "in" | "out" | "live";
}

export interface KernelModuleRequest {
  readonly attributes: ReadonlyArray<PointAttributeSchema>;
  /** Attribute names the kernel reads. Order irrelevant; must exist in the schema. */
  readonly reads: ReadonlyArray<string>;
  /** Attribute names the kernel writes. Implicitly read too (the Point struct carries them in). */
  readonly writes: ReadonlyArray<string>;
  /** WGSL text containing `fn process(p: Point, ctx: PointCtx) -> Point`. */
  readonly kernel: string;
  readonly workgroupSize?: number;
  /**
   * T322/T323: generate the lifecycle variant. The named attribute (u32, in the
   * schema, written) is the PACKED flags word — the kernel ABI exposes it as two
   * Point fields, `alive: u32` and `spawnCount: u32`, and the generated store packs
   * `(min(spawnCount, cap) << 1) | (alive & 1)`. Both are write-only BY CONSTRUCTION:
   * inside the guard a slot is alive (compaction packed survivors below the count)
   * and last frame's spawnCount is meaningless — which is what keeps the default
   * schema inside the 8-storage-buffers-per-stage budget (§V24, B33). The module
   * gains a `liveCount` read binding and guards the dispatch by it; frame zero uses
   * the static count, the buffer being zero-initialised.
   */
  readonly lifecycle?: { readonly flagsAttribute: string };
  /**
   * T300: Houdini's Group field as a WGSL predicate over (p, ctx). Only matching
   * points run `process`; the rest pass through byte-identical. Evaluated in the
   * thread already running — no list is ever materialized.
   */
  readonly group?: string;
  /**
   * T472: the GRID this kernel runs over, when the pointset it processes publishes a
   * grid topology (T296/T302). Supplied by the emitting node from the EDGE — never a
   * parameter of the kernel node itself, because the dimensions belong to the producer
   * and a second copy is the bug (§V349, B85). Absent for a `points` topology or an
   * unwired processor port, and a kernel that then names `ctx.dim` is REFUSED by name
   * rather than handed zeros (§V288).
   */
  readonly dim?: { readonly cols: number; readonly rows: number };
  /**
   * T477: a texture FIELD is wired to the kernel node. When the kernel calls
   * `fieldAt(position)`, the module declares the texture binding and the helper; a
   * kernel that calls it with NO field wired is refused by name (§V288), and a wired
   * field an incurious kernel never samples costs nothing (§V309).
   */
  readonly field?: boolean;
}

export interface KernelModule {
  readonly ok: true;
  readonly wgsl: string;
  /** Storage bindings in binding-index order. Binding 0 is always the uniforms block. */
  readonly buffers: ReadonlyArray<PointBufferBinding>;
  readonly contractVersion: number;
  readonly workgroupSize: number;
  /**
   * T367: whether this module's `KernelFrame` block carries the `pointer` member, i.e.
   * whether the kernel asked for it. The emitting node MUST mirror this in the pass's
   * `uniforms` record — vgpu writes uniform values BY NAME into the reflected layout, so
   * a member with no value silently reads zero and a value with no member is silently
   * dropped (the catalogue's uniform sweep is what holds the two together).
   */
  readonly usesPointer: boolean;
  /**
   * T479: the value slots this module declared, ascending. The emitting node MUST mirror
   * exactly these into the pass's `uniforms` record — same hazard as `usesPointer`, since
   * vgpu matches by name and a member with no value reads zero in silence.
   */
  readonly usesValues: ReadonlyArray<number>;
  /**
   * T477: the kernel samples `fieldAt(...)` and a field is wired. The emitting node
   * MUST bind the texture as `fieldTexture` exactly when this is true — vgpu matches
   * by name, and a declared texture with no binding fails loudly at pass build.
   */
  readonly usesField: boolean;
}

export interface KernelModuleFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<string>;
}

export type KernelModuleResult = KernelModule | KernelModuleFailure;

const PROCESS_SIGNATURE = /fn\s+process\s*\(\s*\w+\s*:\s*Point\s*,\s*\w+\s*:\s*PointCtx\s*\)\s*->\s*Point/;

/**
 * T367 (§V182, §V309): the POINTER is an OPTIONAL member of `PointCtx`, and it is
 * optional for the reason every other stage on this family is — a member that appeared
 * unconditionally would rewrite the `KernelFrame` block and the ctx constructor of every
 * point graph that has ever shipped, structurally recompiling all of them for a field
 * they never read. "Costs nothing by existing" is a sustained property, so the sixth
 * stage keeps it too.
 *
 * DETECTED, not declared: the ctx parameter's NAME is the kernel author's (`ctx`, `c`,
 * anything), so what is recognisable is the field ACCESS. Over-detection is harmless —
 * a kernel that says `.pointer` anywhere gets a member it may not read, which costs one
 * vec4f. Under-detection is LOUD: the kernel names a member the struct does not declare
 * and Dawn refuses the module by name, which is the failure this codebase prefers over
 * a zero that looks like a pointer parked in the corner (§V288).
 */
const POINTER_REFERENCE = /\.\s*pointer\b/;

/**
 * T477: the advection FIELD, detected the way the pointer and the grid are — by use.
 * `fieldAt(p.position)` samples the wired texture with the SAME clip→uv mapping
 * `textureToAttribute` uses (T262/T417), so the bridge and the in-kernel read of one
 * field agree texel for texel; two mappings for one idea would be §V349's bug.
 */
const FIELD_REFERENCE = /\bfieldAt\s*\(/;

/**
 * T472 (§V309, §V349): the GRID, detected exactly the way the pointer is, for exactly
 * the same reason — an unconditional member would rewrite the ctx struct and the ctx
 * constructor of every point graph ever saved.
 *
 * The dimensions are BAKED as literals rather than carried in `KernelFrame`, and that is
 * a decision worth stating: topology is already STRUCTURAL (the generator's `cols`/`rows`
 * are `compileTime`, and the string is on the edge payload the compiler resolves), so a
 * uniform would buy nothing and would cost the mirroring hazard `usesPointer` documents
 * above — a member with no value in the pass's `uniforms` record silently reads zero.
 * Nothing here can drift out of step with the edge because nothing here is written twice.
 *
 * WHAT IS DELIBERATELY ABSENT: `u`/`v`. The normalising divisor is a CHOICE, not a fact —
 * `i / cols` closes a wrapped seam, `i / (cols - 1)` closes an open one — and the wrap
 * flags on the INCOMING topology need not be the ones the author is targeting. E20 is
 * precisely that case: its sheet is an unwrapped `grid:64x64` and its kernel deliberately
 * divides by COLS because a `pointTopology` node DOWNSTREAM re-claims the edge with
 * `wrapU`. A `ctx.dim.u` derived from the input's flags would have quietly halved that
 * example's seam cell into a duplicated column — the plausible-wrong answer §V288 exists
 * to refuse. The kernel author writes the division; `ctx.dim` supplies the numbers.
 */
const DIM_REFERENCE = /\.\s*dim\b/;

/**
 * T479: how many live value-graph slots a point kernel can reach. Four is a judgement,
 * and it is stated rather than defaulted: one (the `customWgsl` precedent) is a wall for
 * anything with more than a single knob, and a dozen is inspector clutter on every kernel
 * in the catalogue. Unused slots cost nothing in the WGSL (§V309, per-slot) and are
 * `inactiveWhen`-hidden in the inspector by the SAME detection, so the visible surface is
 * exactly what the kernel asked for.
 */
export const POINT_KERNEL_VALUE_SLOTS = 4;

/**
 * T479 (§V309, §V316, B40) — the VALUE GRAPH in `PointCtx`, detected like the other two.
 *
 * THE DESIGN QUESTION, ANSWERED WHERE IT LIVES: how does a kernel NAME a channel?
 *
 * It does not, and that is the point. The name (`lfo1`, `mouse1:x`) is stored in an
 * ordinary DRIVEN parameter slot on the node — `value1` … `value4` — and the kernel reads
 * the slot, not the name. A name written inside the kernel's WGSL would be a FIFTH
 * reference currency (§V316), and the currency has five consumers today, not one: the
 * rename rewrite, the strand count on a label clear, `documentLiveness`'s producer walk
 * (B63), the editor's reference lines (T248), and the dangling-name refusal. Wiring four
 * of five is precisely B40 — where `driven` channels were a reference nobody rewrote, and
 * a rename silently froze every parameter naming the node, with no diagnostic because an
 * unattached channel is deliberately info-severity (§V317).
 *
 * A driven slot is already wired into all five. So the reference stays in the parameter,
 * where rename can reach it, and the WGSL holds an ORDINAL that no rename can orphan.
 *
 * The cost is honest and worth naming: the slot names carry no meaning, so a kernel's
 * comment has to say what `value2` is. The alternative buys that meaning with a class of
 * silent breakage we spent this morning removing.
 */
const VALUE_REFERENCE = /\.\s*value(\d+)\b/g;

/** Slot ordinals a kernel actually reads, ascending. Out-of-range ordinals come back too. */
function referencedValueSlots(...sources: ReadonlyArray<string>): number[] {
  const found = new Set<number>();
  for (const source of sources) {
    VALUE_REFERENCE.lastIndex = 0;
    for (const match of source.matchAll(VALUE_REFERENCE)) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The parameter key for slot `n`, and the only place the spelling is written. The node
 * manifest, the uniform mirror and the inspector's applicability all call this, so
 * `value1` cannot come to mean two different things.
 */
export function pointKernelValueKey(slot: number): string {
  return `value${slot}`;
}

/**
 * Whether a kernel/group/hook text reads slot `n` — exported because the node's
 * `inactiveWhen` must answer it with the SAME reader codegen uses. A second regex here
 * would be a parameter that looks active and is not, or vice versa (§V288).
 */
export function kernelReadsValueSlot(slot: number, ...sources: ReadonlyArray<string>): boolean {
  return referencedValueSlots(...sources).includes(slot);
}

/**
 * PCG-based hash, the deterministic core of §V74. Everything about it is fixed on
 * purpose: same constants on every device, no atomics, no scheduling dependence.
 */
const RNG_WGSL = `fn pointPcg(value: u32) -> u32 {
  var state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

/* §V74: hash(seed, pointId, frameIndex, salt) — identity-keyed, never slot-keyed. */
fn pointHash(pointId: u32, salt: u32) -> u32 {
  return pointPcg(pointPcg(pointPcg(kernelFrame.seed ^ pointId) ^ kernelFrame.frameIndex) ^ salt);
}

/* Uniform in [0, 1). Distinct salts give independent draws for the same point+frame. */
fn pointRand(pointId: u32, salt: u32) -> f32 {
  return f32(pointHash(pointId, salt)) * (1.0 / 4294967296.0);
}`;

export function generateKernelModule(request: KernelModuleRequest): KernelModuleResult {
  const { attributes, reads, writes, kernel } = request;
  const errors: string[] = [];

  const schemaCheck = validateAttributes(attributes);
  errors.push(...schemaCheck.errors);

  const byName = new Map(attributes.map((attribute) => [attribute.name, attribute]));
  for (const name of [...reads, ...writes]) {
    if (!byName.has(name)) errors.push(`kernel names attribute "${name}", which the schema does not declare`);
  }
  if (writes.length === 0) errors.push("a kernel that writes nothing does nothing; declare at least one write");
  if (!PROCESS_SIGNATURE.test(kernel)) {
    errors.push("kernel must define `fn process(p: Point, ctx: PointCtx) -> Point` (§V77 contract v1)");
  }
  const lifecycle = request.lifecycle;
  if (lifecycle !== undefined) {
    const flags = byName.get(lifecycle.flagsAttribute);
    if (flags === undefined) {
      errors.push(`lifecycle names flags attribute "${lifecycle.flagsAttribute}", which the schema does not declare`);
    } else if (flags.type !== "u32") {
      errors.push(`flags attribute "${lifecycle.flagsAttribute}" must be u32, not ${flags.type}`);
    } else if (!writes.includes(lifecycle.flagsAttribute)) {
      errors.push(`flags attribute "${lifecycle.flagsAttribute}" must be written, or nothing can die`);
    }
    for (const reserved of ["alive", "spawnCount"]) {
      if (byName.has(reserved) && reserved !== lifecycle.flagsAttribute) {
        errors.push(`"${reserved}" is a lifecycle Point field (contract v2); the schema must not declare it`);
      }
    }
  }

  const workgroupSize = request.workgroupSize ?? DEFAULT_WORKGROUP_SIZE;
  if (!Number.isInteger(workgroupSize) || workgroupSize < 1 || workgroupSize > 256) {
    errors.push(`workgroupSize ${String(request.workgroupSize)} is outside [1, 256]`);
  }

  /* T472/B85: the kernel asked for a grid the point set does not have. Refuse BY NAME —
     handing it zeros would divide by zero and put every point in cell (0, 0), which is a
     picture, and a plausible one (§V288). */
  const groupSource = typeof request.group === "string" ? request.group.trim() : "";
  const usesDim = DIM_REFERENCE.test(kernel) || DIM_REFERENCE.test(groupSource);
  const dim = request.dim;
  if (usesDim && dim === undefined) {
    errors.push(
      "kernel reads ctx.dim, but the point set it runs over publishes no grid topology — " +
        "ctx.dim is the cols×rows the kernel is running over (T296/T302). Put a Point Grid, " +
        "Tube or Torus upstream, or claim connectivity with a Point Topology node before this one.",
    );
  }
  if (usesDim && dim !== undefined && (!Number.isInteger(dim.cols) || dim.cols < 1 || !Number.isInteger(dim.rows) || dim.rows < 1)) {
    errors.push(`ctx.dim needs whole positive dimensions; the edge published ${dim.cols}×${dim.rows}`);
  }

  /* T477: the kernel samples a field nothing supplies. Refuse BY NAME — a helper that
     silently returned zeros would advect every point nowhere, which is a picture, and a
     plausible one (§V288). */
  const usesField = FIELD_REFERENCE.test(kernel) || FIELD_REFERENCE.test(groupSource);
  if (usesField && request.field !== true) {
    errors.push(
      "kernel calls fieldAt(...), but nothing is wired to the field input — " +
        "fieldAt samples that texture at a position, clip-space xy mapped to uv exactly as " +
        "Texture To Attribute maps it (T262). Wire a texture to the field input.",
    );
  }

  /* T479: an ordinal outside the declared slots is refused BY NAME here rather than left
     to arrive as Dawn's "struct PointCtx has no member named 'value9'" (§V288). */
  const valueSlots = referencedValueSlots(kernel, groupSource);
  const outOfRange = valueSlots.filter((slot) => slot < 1 || slot > POINT_KERNEL_VALUE_SLOTS);
  if (outOfRange.length > 0) {
    errors.push(
      `kernel reads ctx.value${outOfRange.join(", ctx.value")}, but a point kernel has ${POINT_KERNEL_VALUE_SLOTS} value slots — ` +
        `ctx.value1 through ctx.value${POINT_KERNEL_VALUE_SLOTS}, each a drivable parameter on this node (T479).`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // The Point struct carries every attribute the kernel touches — reads, plus writes
  // (a written attribute is loaded too, so `var q = p; q.x += …` composes). Schema
  // order keeps the generated text deterministic regardless of reads/writes order.
  const touched = attributes.filter(
    (attribute) => reads.includes(attribute.name) || writes.includes(attribute.name),
  );
  const written = attributes.filter((attribute) => writes.includes(attribute.name));

  const bindings: PointBufferBinding[] = [];
  let nextBinding = 1; // binding 0 is the uniforms block
  for (const attribute of touched) {
    // T322/T323: the flags word is WRITE-ONLY. Inside the guarded range a slot is
    // alive BY CONSTRUCTION (compaction packed survivors below the live count) and
    // last frame's spawnCount is meaningless, so reading back is redundant — and the
    // saved binding is what keeps the default schema inside the baseline
    // 8-storage-buffers-per-stage budget (§V24).
    if (attribute.name === lifecycle?.flagsAttribute) continue;
    bindings.push({
      attribute: attribute.name,
      variable: `in_${attribute.name}`,
      binding: nextBinding,
      access: "read",
      role: "in",
    });
    nextBinding += 1;
  }
  for (const attribute of written) {
    bindings.push({
      attribute: attribute.name,
      variable: `out_${attribute.name}`,
      binding: nextBinding,
      access: "read_write",
      role: "out",
    });
    nextBinding += 1;
  }
  if (lifecycle !== undefined) {
    bindings.push({
      attribute: lifecycle.flagsAttribute,
      variable: "liveCount",
      binding: nextBinding,
      access: "read",
      role: "live",
    });
    nextBinding += 1;
  }

  /* T477: the field texture takes the next slot AFTER every storage binding, and the
     helper mirrors the bridge's mapping verbatim — clip [-1,1] → uv [0,1] → texel,
     clamped so an off-screen point still samples the edge. */
  const fieldDeclarations =
    usesField && request.field === true
      ? `@group(0) @binding(${nextBinding}) var fieldTexture: texture_2d<f32>;

/* T477: sample the wired field at a point's position — the SAME mapping
   Texture To Attribute uses (T262), so the bridge and this read agree texel for texel. */
fn fieldAt(position: vec3f) -> vec4f {
  let dims = vec2f(textureDimensions(fieldTexture, 0));
  let uv = clamp(position.xy * 0.5 + vec2f(0.5), vec2f(0.0), vec2f(1.0));
  return textureLoad(fieldTexture, vec2i(uv * (dims - vec2f(1.0))), 0);
}

`
      : "";

  const structFields = touched
    .map((attribute) =>
      attribute.name === lifecycle?.flagsAttribute
        ? "  alive: u32,\n  spawnCount: u32,"
        : `  ${attribute.name}: ${attribute.type},`,
    )
    .join("\n");

  const bufferDeclarations = bindings
    .map(
      (binding) =>
        `@group(0) @binding(${binding.binding}) var<storage, ${binding.access}> ${binding.variable}: array<${
          binding.role === "live" ? "u32" : byName.get(binding.attribute)?.type
        }>;`,
    )
    .join("\n");

  const loads = touched
    .map((attribute) =>
      attribute.name === lifecycle?.flagsAttribute
        ? "  p.alive = 1u; /* by construction inside the guard (T322) */\n" +
          "  p.spawnCount = 0u; /* last frame's births are not this frame's (T323) */"
        : `  p.${attribute.name} = in_${attribute.name}[index];`,
    )
    .join("\n");

  const stores = written
    .map((attribute) =>
      attribute.name === lifecycle?.flagsAttribute
        ? `  out_${attribute.name}[index] = (min(q.spawnCount, ${MAX_SPAWN_PER_PARENT}u) << 1u) | (q.alive & 1u);`
        : `  out_${attribute.name}[index] = q.${attribute.name};`,
    )
    .join("\n");

  /* T322: the lifecycle module is guarded by the LIVE count — frame zero uses the
     static count because the buffer is zero-initialised and nothing has counted yet —
     and forces the alive flag on frame zero for the same reason. */
  /* T300: a group predicate gates `process`; non-members pass through byte-identical.
     The no-group text stays EXACTLY what v1 generated, so existing plans' pass
     signatures do not change under this feature's mere existence. */
  const groupFunction =
    groupSource === ""
      ? ""
      : `
fn groupMatch(p: Point, ctx: PointCtx) -> bool {
  return (${groupSource});
}
`;
  const invoke =
    groupSource === ""
      ? "  let q = process(p, ctx);"
      : `  var q = p;
  if (groupMatch(p, ctx)) {
    q = process(p, ctx);
  }`;

  const liveExpression =
    lifecycle === undefined
      ? "kernelFrame.count"
      : "select(min(liveCount[0], kernelFrame.count), kernelFrame.count, kernelFrame.frameIndex == 0u)";
  const guard =
    lifecycle === undefined
      ? `  if (index >= kernelFrame.count) {
    return;
  }`
      : `  let live = ${liveExpression};
  if (index >= live) {
    return;
  }`;

  /* T367: the pointer rides the same block the clock does, in the SAME packing the
     shared frame block uses (x, y, buttons, unused) so the two carry identical numbers
     (§V182). Appended last: `count` ends the block at 20 bytes and a vec4f aligns to
     32, so no member that existed before this moves. */
  const usesPointer = POINTER_REFERENCE.test(kernel) || POINTER_REFERENCE.test(groupSource);
  const framePointer = usesPointer ? "\n  pointer: vec4f," : "";
  const ctxPointer = usesPointer
    ? "\n  /* T367: viewer-normalised x, y (v DOWN, §V236), buttons, unused — the same\n     numbers the shared frame block hands every shader (§V182). */\n  pointer: vec4f,"
    : "";

  /* T472: the grid, appended after the pointer for the same reason the pointer was
     appended last — a member that moved would move every kernel that already reads the
     one before it. `cols`/`rows` are the EDGE's (T296/T302); `i`/`j` are this slot's
     cell, computed once here so no kernel repeats the modulo. */
  const dimStruct =
    usesDim && dim !== undefined
      ? `struct PointDim {
  /* T472 (B85, §V349): the grid the kernel is RUNNING OVER, taken from the topology the
     incoming pointset publishes — never a number retyped into the kernel. */
  cols: u32,
  rows: u32,
  /* This slot's cell: index % cols, index / cols. */
  i: u32,
  j: u32,
};

`
      : "";
  const ctxDim = usesDim && dim !== undefined ? "\n  /* T472: the grid this kernel runs over (T296/T302). */\n  dim: PointDim," : "";
  const dimArgument =
    usesDim && dim !== undefined
      ? `, PointDim(${dim.cols}u, ${dim.rows}u, index % ${dim.cols}u, index / ${dim.cols}u)`
      : "";

  /* T479: one f32 per slot the kernel actually named, appended last for the same reason
     the pointer was — nothing that existed before this moves. Per-SLOT, so a kernel
     reading only `ctx.value3` carries one member, not four (§V309 at its finest grain). */
  const frameValues = valueSlots.map((slot) => `\n  value${slot}: f32,`).join("");
  const ctxValues =
    valueSlots.length === 0
      ? ""
      : `\n  /* T479: live value-graph slots — each is a DRIVABLE parameter on this node, so\n     an LFO, the mouse or an audio channel changes what the kernel DOES, not just what\n     it is scaled by. The channel NAME lives in the parameter, where rename reaches it. */${valueSlots
          .map((slot) => `\n  value${slot}: f32,`)
          .join("")}`;
  const valueArguments = valueSlots.map((slot) => `, kernelFrame.value${slot}`).join("");

  const wgsl = `// Generated point kernel (T117, contract v${POINT_KERNEL_CONTRACT_VERSION}). Do not edit by hand.
struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,${framePointer}${frameValues}
};

@group(0) @binding(0) var<uniform> kernelFrame: KernelFrame;

${bufferDeclarations}

struct Point {
${structFields}
};

${dimStruct}struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,${ctxPointer}${ctxDim}${ctxValues}
};

${RNG_WGSL}

${fieldDeclarations}${kernel}
${groupFunction}
@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
${guard}
  var p: Point;
${loads}
  let ctx = PointCtx(index, ${lifecycle === undefined ? "kernelFrame.count" : "live"}, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex${usesPointer ? ", kernelFrame.pointer" : ""}${dimArgument}${valueArguments});
${invoke}
${stores}
}
`;

  return {
    ok: true,
    wgsl,
    buffers: bindings,
    contractVersion: lifecycle === undefined ? POINT_KERNEL_CONTRACT_VERSION : ADVANCED_KERNEL_CONTRACT_VERSION,
    workgroupSize,
    usesPointer,
    usesValues: valueSlots,
    usesField: usesField && request.field === true,
  };
}


/* ------------------------------------------------------------------------------------
 * T339: the spawn HOOK — pass two of the two-pass design the binding budget forces
 * (a one-pass hook needs 2n+4 storage bindings; Dawn/Metal grants 10).
 *
 * `fn spawn(child: Point, ctx: PointCtx) -> Point` runs IN PLACE over just the
 * newborn range, after the copy passes: the child ARRIVES as its parent's copy, so
 * inheritance is the initial value and the pass needs only the read halves
 * (read_write) plus the counts buffer — n+1 bindings.
 *
 * The hook's Point deliberately has NO alive/spawnCount fields: this frame's
 * lifecycle already ran, so a hook-written kill or birth would be silently lost next
 * frame (the kernel loads both by construction). A hook shapes ATTRIBUTES; the
 * lifecycle stays the kernel's. Omitting the fields makes the wrong program fail to
 * compile instead of quietly doing nothing.
 * ---------------------------------------------------------------------------------- */

const SPAWN_HOOK_SIGNATURE = /fn\s+spawn\s*\(\s*\w+\s*:\s*Point\s*,\s*\w+\s*:\s*PointCtx\s*\)\s*->\s*Point/;

export interface SpawnHookRequest {
  readonly attributes: ReadonlyArray<PointAttributeSchema>;
  /** The packed lifecycle word — excluded from the hook's Point and bindings. */
  readonly flagsAttribute: string;
  /** WGSL text containing `fn spawn(child: Point, ctx: PointCtx) -> Point`. */
  readonly hook: string;
  readonly workgroupSize?: number;
}

export function generateSpawnHookModule(request: SpawnHookRequest): KernelModuleResult {
  const errors: string[] = [];
  const schemaCheck = validateAttributes(request.attributes);
  errors.push(...schemaCheck.errors);
  if (!SPAWN_HOOK_SIGNATURE.test(request.hook)) {
    errors.push("spawn hook must define `fn spawn(child: Point, ctx: PointCtx) -> Point` (§V77 contract v2)");
  }
  /* T472: the hook runs on the advanced kernel, whose pointset is a spawning population
     with no grid connectivity at all — so `ctx.dim` is refused HERE by name rather than
     left to surface as Dawn's "struct PointCtx has no member named 'dim'". */
  if (DIM_REFERENCE.test(request.hook)) {
    errors.push(
      "spawn hook reads ctx.dim, but a spawning population has no grid topology — points are " +
        "born and killed, so there are no fixed cols×rows to index (T472).",
    );
  }
  /* T479: the hook is a second pass on the SAME node, so it reaches the same four slots —
     which is what makes "spawn with the speed the LFO says" expressible at all. */
  const hookValueSlots = referencedValueSlots(request.hook);
  const hookOutOfRange = hookValueSlots.filter((slot) => slot < 1 || slot > POINT_KERNEL_VALUE_SLOTS);
  if (hookOutOfRange.length > 0) {
    errors.push(
      `spawn hook reads ctx.value${hookOutOfRange.join(", ctx.value")}, but a point kernel has ${POINT_KERNEL_VALUE_SLOTS} value slots (T479).`,
    );
  }
  const workgroupSize = request.workgroupSize ?? DEFAULT_WORKGROUP_SIZE;
  if (errors.length > 0) return { ok: false, errors };

  /* T367, the hook's half: same optional member, same detection, same reason (§V309) —
     a hookless-then-hooked graph must not see its OTHER passes' text move either. */
  const usesPointer = POINTER_REFERENCE.test(request.hook);

  const shaped = request.attributes.filter((attribute) => attribute.name !== request.flagsAttribute);
  const bindings: PointBufferBinding[] = [
    // In place: the read halves, where the copy passes left the newborns.
    ...shaped.map((attribute, index) => ({
      attribute: attribute.name,
      variable: `io_${attribute.name}`,
      binding: index + 1,
      access: "read_write" as const,
      role: "out" as const,
    })),
    { attribute: "counts", variable: "counts", binding: shaped.length + 1, access: "read", role: "live" },
  ];

  const wgsl = `// Generated spawn hook (T339, contract v${ADVANCED_KERNEL_CONTRACT_VERSION}). Do not edit by hand.
struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,${usesPointer ? "\n  pointer: vec4f," : ""}${hookValueSlots.map((slot) => `\n  value${slot}: f32,`).join("")}
};

@group(0) @binding(0) var<uniform> kernelFrame: KernelFrame;

${shaped
  .map(
    (attribute, index) =>
      `@group(0) @binding(${index + 1}) var<storage, read_write> io_${attribute.name}: array<${attribute.type}>;`,
  )
  .join("\n")}
@group(0) @binding(${shaped.length + 1}) var<storage, read> counts: array<u32>;

struct Point {
${shaped.map((attribute) => `  ${attribute.name}: ${attribute.type},`).join("\n")}
};

struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,${usesPointer ? "\n  /* T367: the same four numbers the shared frame block carries (§V182). */\n  pointer: vec4f," : ""}${hookValueSlots.length === 0 ? "" : `\n  /* T479: the same live value slots the kernel reads, on the same node. */${hookValueSlots.map((slot) => `\n  value${slot}: f32,`).join("")}`}
};

${RNG_WGSL}

${request.hook}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  let live = counts[0u];
  let placed = counts[3u];
  /* Only the newborn range [live - placed, live): everyone else was shaped by the
     kernel this frame and must pass through untouched. */
  if (index + placed < live || index >= live) {
    return;
  }
  var p: Point;
${shaped.map((attribute) => `  p.${attribute.name} = io_${attribute.name}[index];`).join("\n")}
  let ctx = PointCtx(index, live, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex${usesPointer ? ", kernelFrame.pointer" : ""}${hookValueSlots.map((slot) => `, kernelFrame.value${slot}`).join("")});
  let q = spawn(p, ctx);
${shaped.map((attribute) => `  io_${attribute.name}[index] = q.${attribute.name};`).join("\n")}
}
`;

  return { ok: true, wgsl, buffers: bindings, contractVersion: ADVANCED_KERNEL_CONTRACT_VERSION, workgroupSize, usesPointer, usesValues: hookValueSlots, usesField: false };
}

/** Components a default value needs, re-exported so node manifests can validate cheaply. */
export { COMPONENT_COUNTS };
