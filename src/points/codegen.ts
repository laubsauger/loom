import {
  ATTRIBUTE_STRIDES,
  COMPONENT_COUNTS,
  validateAttributes,
  type PointAttributeSchema,
  type PointAttributeType,
} from "./attributes.ts";
import { MAX_SPAWN_PER_PARENT } from "./lifecycle.ts";
import { regionAccessorWgsl, regionStoreWgsl } from "./packing.ts";

/**
 * The attribute→WGSL codegen module (T117) — named the TOP RISK of the P3a slice, which
 * is why it is its own small, pure, heavily-tested unit instead of a side effect of the
 * first point node.
 *
 * Given an attribute schema and a per-point kernel, it generates the complete compute
 * module: the `Point` struct assembled from region loads out of the producer's PACKED
 * point buffer (T1076 — one binding per producer per half, never one per attribute; a
 * written attribute still reads its pre-frame value from the read half), the deterministic
 * RNG (§V74: every random
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
 *
 * `ctx.absTime` / `ctx.absFrame` (T489, B97) are the fourth, and the requirement they
 * serve is a PROPERTY rather than a feature: NOTHING RESETS AT THE LOOP. `ctx.time` is
 * timeline time and wraps at the out point (T455), so a kernel animating off it snapped its
 * whole population back once a lap and its author had nothing else to read. Expressions
 * were given the absolute pair at T461 and the shared frame block at T468; this channel was
 * missed both rounds (§V437). Same detection, same zero cost when unused, same determinism
 * — a frame COUNT at the timeline rate, never a wall clock (§V44, T467).
 */

/** Bumped when the generated Point/PointCtx/process signature changes shape (§V77). */
export const POINT_KERNEL_CONTRACT_VERSION = 1;

/**
 * Contract for the LIFECYCLE variant (T322/T323): same `process` signature, plus a
 * GPU-resident live-count guard and the packed flags word exposed as `alive` and
 * `spawnCount` Point fields (both write-only by construction).
 *
 * THE BINDING BUDGET, SETTLED (T1076). Baseline WebGPU guarantees 8 storage buffers per
 * compute STAGE, and bind GROUPS do not raise it. This kernel used to spend 2·(n−1)+2 for
 * n attributes incl. flags — the default schema landed exactly at 8 and one more attribute
 * busted it, silently (B33). Attributes are REGIONS of one packed buffer now, so the count
 * is 2 plus the live-count binding whatever n is, and the ceiling moved to the bytes one
 * binding may carry (`points/packing.ts`).
 *
 * The two escapes that used to be written here are therefore both retired: requesting a
 * higher `maxStorageBuffersPerShaderStage` at device creation would have widened the wrong
 * limit (and §V588's lesson is that a generous DEV device HIDES a baseline one), and the
 * TWO-PASS spawn hook no longer needs to be two passes to fit. It stays two on its own
 * merits: the child arrives as its parent's copy, so inheritance is the initial value
 * rather than something a one-pass hook would have to invent (T339, T287).
 */
export const ADVANCED_KERNEL_CONTRACT_VERSION = 2;

export const DEFAULT_WORKGROUP_SIZE = 64;

/**
 * WHERE one attribute lives, as the emitting NODE knows it (T1076).
 *
 * `group` is opaque to codegen: attributes carrying the same key share ONE storage
 * binding, and the node maps the key back to a resource id and a half. This is the seam
 * §V197's by-reference narrowing needs — a processor reads its UPSTREAM's regions for
 * shared attributes (T401), so the layout RIDES THE EDGE and codegen cannot compute its
 * own offsets.
 */
export interface KernelStorageRegion {
  readonly group: string;
  /** Byte offset of the attribute's region inside that group's buffer. */
  readonly offset: number;
}

/**
 * The full addressing table for one generated module: where each touched attribute is
 * READ from and where each written attribute is WRITTEN to. A group named by both is
 * bound once, `read_write` — which is exactly the spawn hook, editing in place.
 */
export interface KernelStorageMap {
  readonly reads: Readonly<Record<string, KernelStorageRegion>>;
  readonly writes: Readonly<Record<string, KernelStorageRegion>>;
}

export interface PointBufferBinding {
  /** WGSL variable name (`pk_0`, `pk_1`, `liveCount`). */
  readonly variable: string;
  readonly binding: number;
  readonly access: "read" | "read_write";
  /** "storage" = a packed point group; "live" = the lifecycle count buffer (T322). */
  readonly role: "storage" | "live";
  /** The group key the emitting node supplied. Absent on "live". */
  readonly group?: string;
}

export interface KernelModuleRequest {
  readonly attributes: ReadonlyArray<PointAttributeSchema>;
  /** Attribute names the kernel reads. Order irrelevant; must exist in the schema. */
  readonly reads: ReadonlyArray<string>;
  /** Attribute names the kernel writes. Implicitly read too (the Point struct carries them in). */
  readonly writes: ReadonlyArray<string>;
  /**
   * T1076: where every touched attribute lives — which packed buffer GROUP and at what
   * byte offset. Supplied by the emitting node because a processor reads its upstream's
   * regions (T401) and the layout therefore rides the EDGE, not this module.
   *
   * Every attribute in `touched` needs a `reads` entry (except a lifecycle flags word,
   * which is write-only by construction) and every written attribute needs a `writes`
   * one; a gap is refused by name rather than generating a module that cannot address
   * what its own `Point` declares.
   */
  readonly storage: KernelStorageMap;
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
  /**
   * T900: the kernel's OWN `struct Params`, reflected by the shared reflector the
   * `customWgsl` node uses (`params-reflection.ts`) and handed here as data.
   *
   * The direction matters: codegen stays a pure WGSL unit that knows nothing about node
   * manifests or parameter schemas, so the NODE reflects and this emits. `declaration` is
   * the author's own `struct Params { … }` text, lifted out of the kernel body because WGSL
   * requires declaration before use and the generated `PointCtx` carries a `params: Params`
   * member; `fields` is the same struct's members in declaration order, which is what makes
   * the positional `Params(…)` construction below correct.
   *
   * ⚠ THE INVALIDATION SPLIT (§V5 vs §V588): every field here becomes a UNIFORM member, so
   * turning one of these knobs is a buffer write and never a rebuild. The kernel TEXT that
   * declared them is `compileTime` — editing the struct is a structural change and does
   * rebuild. One reflection pass, two classes, and the class is decided by WHERE the value
   * lives (a parameter value vs. the shader text), not by what it looks like.
   */
  readonly params?: {
    readonly declaration: string;
    readonly fields: ReadonlyArray<{ readonly name: string; readonly wgsl: string }>;
  };
}

/**
 * §V588, enforced where the arithmetic is. Baseline WebGPU guarantees 8 storage buffers per
 * compute STAGE, and B33 is what happens when a kernel walks past it: the pipeline fails
 * SILENTLY. Every kernel used to spend exactly 2n bindings for n attributes, so the ceiling
 * was four for a plain kernel and three plus the injected flags for the advanced one.
 *
 * T1076 made the count independent of n — attributes are regions of one packed buffer per
 * producer — so what this now catches is a kernel reading from too many distinct PRODUCERS
 * at once (§V197's by-reference chain), and the attribute ceiling became a SIZE bound in
 * `points/packing.ts`.
 *
 * Checked HERE rather than in the two node manifests because the count is the length of the
 * binding list this function just built — an arithmetic copy in a node is a second answer
 * that can drift from the bindings actually emitted (§V349), and the plain kernel proved it
 * by having no check at all while the advanced one did.
 */
export const MAX_KERNEL_STORAGE_BINDINGS = 8;

/** WGSL types a reflected `struct Params` field may declare (mirrors the reflector's controls). */
const PARAM_FIELD_TYPES = new Set(["f32", "i32", "u32", "vec2f", "vec3f", "vec4f"]);

/**
 * The `KernelFrame` member a reflected param rides in. PREFIXED on purpose: the params share
 * the ONE uniform block a dispatch pass is allowed, beside members the generator owns
 * (`seed`, `count`, `firstRun`, `value1`…), and an author's `struct Params { count: u32 }`
 * must not be able to collide with one of them — now or after the generator gains its next
 * member. The node's PARAMETER key stays the author's bare name; this is the wire name.
 */
export const KERNEL_PARAM_PREFIX = "p_";

export function kernelParamUniformKey(name: string): string {
  return `${KERNEL_PARAM_PREFIX}${name}`;
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
   * T489 (B97): whether this module's `KernelFrame` block carries the ABSOLUTE pair —
   * `absTimeSeconds`/`absFrameIndex`, the clock that does not wrap at a timeline lap. Same
   * mirroring contract as `usesPointer` above: the emitting node reserves the names in the
   * pass's `uniforms` record exactly when this is true, and the backend fills them every
   * frame from the same numbers the shared block gets (§V182).
   */
  readonly usesAbsClock: boolean;
  /** T510: the module names `ctx.firstRun`; the pass must reserve the uniform member. */
  readonly usesFirstRun: boolean;
  /**
   * T477: the kernel samples `fieldAt(...)` and a field is wired. The emitting node
   * MUST bind the texture as `fieldTexture` exactly when this is true — vgpu matches
   * by name, and a declared texture with no binding fails loudly at pass build.
   */
  readonly usesField: boolean;
  /**
   * T900: the reflected `struct Params` members this module declared, in declaration order.
   * The emitting node MUST mirror exactly these into the pass's `uniforms` record under
   * `kernelParamUniformKey` — the same by-name hazard as `usesPointer`: a declared member
   * with no value reads zero in silence (§V288).
   */
  readonly usesParams: ReadonlyArray<{ readonly name: string; readonly wgsl: string }>;
  /**
   * T587: advisories the emitting node turns into `info` diagnostics. NOT refusals — a
   * module carrying notices is a module that compiled. Today there is one: the kernel
   * reads the clock that wraps and has not declared itself timeline-anchored.
   */
  readonly notices: ReadonlyArray<KernelNotice>;
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
 * ═════════════════════════════════════════════════════════════════════════════════════
 * T1070 — `pointAt(slot)`: THE NEIGHBOUR READ THIS FILE'S OWN DOCBLOCK PROMISED.
 * ═════════════════════════════════════════════════════════════════════════════════════
 *
 * The module doc above has said since T117 that *"no raw buffer access exists in the
 * contract; neighbor iteration arrives later"*. This is later, and the shape of the gap is
 * worth stating because it was load-bearing: a point kernel was a PURE PER-POINT FUNCTION,
 * so no kernel could read another point at all. The catalogue's only neighbour query is
 * `pointProximity`, and its answer is a DRAWABLE LINK SET rather than data — a kernel
 * cannot consume it, and a kernel over the links cannot scatter back (no atomics, §V24).
 * ∴ every coupled system in the shipped set is an honest fake: E16's `MURMURATION_FLOCK_KERNEL`
 * is a *flock* whose birds never see each other (its own comment says so — a shared flow
 * field plus a spring home), E32's herd couples through a TEXTURE, E38's motes spring to a
 * target they read off a texture. There was no path to a spring network, a Laplacian, or a
 * boid that actually looks at a neighbour.
 *
 * IT IS THE POINT STRUCT, NOT A PER-ATTRIBUTE ACCESSOR, and that is the decision. One name
 * generalises over any schema, cannot name an attribute that is not bound (impossible by
 * construction, so there is no refusal path to get wrong), and mirrors `p` exactly: the same
 * struct, for a different slot. `pointAt(ctx.index)` is `p`, byte for byte.
 *
 * NAMED FOR WHAT IT DOES, NOT FOR WHAT THE AUTHOR WANTS IT TO MEAN. It is `pointAt`, not
 * `neighbor`: this function knows nothing about adjacency — it hands back the Point in a
 * SLOT (§V73's word: addressing, never identity). WHO is a neighbour is the kernel author's
 * predicate, which is the whole reason this is one primitive rather than a policy.
 *
 * ⚠ IT READS THE PRE-FRAME HALF, AND THAT IS A CORRECTNESS PROPERTY RATHER THAN AN
 * ARTEFACT. `in_*` is the half the wrapper already loads `p` from (that is what makes
 * `var q = p; q.x += …` compose), so every slot a kernel inspects carries LAST FRAME's
 * value — uniformly, for every reader, whatever order the workgroups happen to run in.
 * That makes a coupled update a JACOBI iteration: order-independent, device-independent,
 * reproducible, no atomics and no read-write hazard by construction. A helper reading
 * `out_*` would have been Gauss-Seidel with a scheduling-dependent answer, i.e. §V44's
 * determinism lost to a name that looked more current.
 *
 * COSTS NOTHING BY EXISTING (§V309): no uniform member, no binding, no `PointCtx` change —
 * it is sugar over storage the wrapper had already bound, so a kernel that never names it
 * generates the text it generated before this existed, and one that does adds no resource
 * for the emitting node to mirror. The loads it performs are the Point's, so an author who
 * wants a lean O(N²) inner loop declares a lean schema.
 */
const NEIGHBOR_REFERENCE = /\bpointAt\s*\(/;

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
 * T489 (B97, §V309, §V437): the ABSOLUTE CLOCK — `ctx.absTime` and `ctx.absFrame`, the
 * FOURTH optional member of this family and detected exactly like the other three.
 *
 * `ctx.time` is TIMELINE time and it WRAPS: once a piece is bounded (T455) every lap puts
 * it back to the in point, so a kernel animating off `ctx.time` snaps its whole population
 * back at the out point and its author had no other clock to reach for. Expressions got
 * the absolute pair at T461 and the shared frame block got it at T468; the kernel channel
 * was missed both rounds, which is the entire shape of §V437 — a PROPERTY (nothing resets
 * at the loop) delivered one SITE at a time is not delivered.
 *
 * Detected as ONE pair rather than two members, because they are one clock read two ways
 * and a kernel that names either wants the other available: the cost is two scalars in a
 * block that is already padded, against the confusion of `ctx.absFrame` compiling while
 * `ctx.absTime` does not. Byte-identical WGSL when neither is named (§V309), which is what
 * keeps every point graph ever saved on exactly the text it compiled with.
 *
 * Determinism is UNCHANGED and that is the design (§V44/§V47): what arrives here is a
 * frame COUNT since transport start divided by the timeline rate — never a wall reading —
 * and a render zeroes it first (T467), so the same project renders the same bytes.
 */
const ABS_CLOCK_REFERENCE = /\.\s*(?:absTime|absFrame)\b/;

/**
 * ═════════════════════════════════════════════════════════════════════════════════════
 * T587 — REACHABILITY IS NOT DISCOVERABILITY. The wrapping clock, named BY US.
 * ═════════════════════════════════════════════════════════════════════════════════════
 *
 * T489 made the absolute pair above REACHABLE from every kernel and T497 got the shipped
 * surface onto it. Neither changed the fact that `time` is the OBVIOUS name and the wrong
 * one for anything that has to survive a lap: an author (or an agent) writes `ctx.time`,
 * the picture snaps at the out point, and nothing anywhere says why. An API whose default
 * is the trap has not been fixed, only made survivable.
 *
 * So codegen answers first, the way it already answers `fieldAt` with nothing wired and
 * `ctx.value9` (§V288): BY NAME, saying what the read does and what the alternative is.
 * The difference from those two is SEVERITY, and it is a decision rather than an oversight
 * — see `wrappingClockNotice`.
 *
 * The pairing lives here and nowhere else, so `time`→`absTime` cannot come to mean two
 * things. Written as a member NAME rather than an access (`ctx.` + name) on purpose: the
 * repo-wide clock audit counts `.time` occurrences in this file and a literal in a message
 * would inflate a count that is load-bearing (§V464(c), T582's freshness inference).
 */
const WRAPPING_CLOCK_REFERENCE = /\.\s*(time|frameIndex)\b/g;

const ABSOLUTE_COUNTERPART: Readonly<Record<string, string>> = {
  time: "absTime",
  frameIndex: "absFrame",
};

/**
 * §V453/§V464 one layer down, in the only text a USER'S kernel has: the kernel itself.
 *
 * A shipped node declares its clock in its description and the audit's table; a kernel
 * typed into a document has neither, so the declaration is the word in a comment — the
 * same word, in the artifact the person reads, which is §V464's rule. A Timer-shaped
 * kernel says `// timeline-anchored: the sweep IS the position in the piece` and the
 * notice stops; nothing else stops it, and there is deliberately no dismiss (the problems
 * panel has no acknowledged-state — nothing can be silenced while still true, T465).
 */
const TIMELINE_ANCHORED_DECLARATION = /timeline-anchored/i;

/**
 * §V443: a text scan reads comments too, and here that is backwards in both directions —
 * a kernel EXPLAINING which clock it took ("absTime, not time") would be reported as
 * reading the wrapping one, and a kernel declaring itself timeline-anchored says so IN a
 * comment. So the READ is looked for in stripped source and the DECLARATION in raw source.
 */
function stripWgslComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** An advisory a generated module carries out with it — never a refusal. */
export interface KernelNotice {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}

/**
 * THE SEVERITY DECISION, stated where it is made.
 *
 * This is an `info`, not a warning and emphatically not a refusal, because `ctx.time` is
 * CORRECT for a whole class of kernel (§V436: a Timer, a scrubbed envelope, anything whose
 * position in the piece is the point). A refusal would be a lie about the API; a warning
 * would put a standing yellow on every legitimately timeline-anchored kernel, and a warning
 * that is usually wrong is a warning people stop reading. `info` is also what §V317 already
 * reserves for "legitimate, and you should know". The audience that most needs this reads
 * the LIST rather than the colour: `useAgentSurface` publishes every diagnostic regardless
 * of severity, so the agent that wrote `ctx.time` gets told either way.
 *
 * §V338: the message names what would make it go away — read the absolute member, or
 * declare the kernel timeline-anchored.
 */
function wrappingClockNotice(
  subject: "kernel" | "spawn hook",
  ...sources: ReadonlyArray<string>
): KernelNotice | undefined {
  if (sources.some((source) => TIMELINE_ANCHORED_DECLARATION.test(source))) return undefined;
  const members: string[] = [];
  for (const source of sources) {
    WRAPPING_CLOCK_REFERENCE.lastIndex = 0;
    for (const match of stripWgslComments(source).matchAll(WRAPPING_CLOCK_REFERENCE)) {
      const member = match[1] as string;
      if (!members.includes(member)) members.push(member);
    }
  }
  if (members.length === 0) return undefined;
  const wrapping = members.map((member) => `ctx.${member}`).join(" and ");
  const absolute = members.map((member) => `ctx.${ABSOLUTE_COUNTERPART[member] ?? ""}`).join(" and ");
  /* B119, told exactly where it bites: the reader has just been sent to `ctx.absFrame`,
     which is u32 here and f32 in a shader's block. Unconverted shader arithmetic on it is
     what produces Dawn's "no matching overload", which explains nothing. */
  const frameNote = members.includes("frameIndex")
    ? " — ctx.absFrame is u32 like the member it replaces, so float maths on it needs f32(...), where a texture shader's frameU.absFrame is already f32"
    : "";
  return {
    code: "node.points.clock",
    message:
      `${subject} reads ${wrapping} — the TIMELINE clock, which resets to the in point every ` +
      `time the loop comes round, so whatever it drives snaps back there. ${absolute} ` +
      `${members.length > 1 ? "keep" : "keeps"} counting straight through the lap (T489).`,
    suggestion:
      `Read ${absolute} instead${frameNote}. If where you are IN the piece is the point ` +
      `(a timer, a scrubbed envelope) that is a real choice — write "timeline-anchored" in a ` +
      `comment in the ${subject} and this stops.`,
  };
}

/**
 * T510 (§V309): FIRST RUN — `ctx.firstRun`, 1u on exactly the dispatches whose storage
 * was just created or cleared, 0u otherwise. The seeding signal the clocks cannot
 * carry: `frameIndex == 0` also fires at a timeline LAP (which is how E9's fountain
 * re-seeded at every loop), and `absFrame == 0` never fires again after a seek. One
 * token per meaning: the clocks say WHEN, this says "my buffers are fresh".
 */
const FIRST_RUN_REFERENCE = /\.\s*firstRun\b/;

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

  /* T1070: `pointAt` on a LIFECYCLE kernel is refused BY NAME (§V288), and the reason is
     the flags word rather than the population: `alive`/`spawnCount` are WRITE-ONLY by
     construction (they have no `in_` binding — that saved binding is what keeps the default
     schema inside §V588's budget), so a Point assembled for another slot could only fill
     them with an invention. A neighbour that always reads back "alive, bearing no children"
     is precisely the plausible-wrong answer this codebase refuses to hand over. */
  const usesNeighbor = NEIGHBOR_REFERENCE.test(kernel) || NEIGHBOR_REFERENCE.test(groupSource);
  if (usesNeighbor && lifecycle !== undefined) {
    errors.push(
      "kernel calls pointAt(...), which the advanced (lifecycle) kernel does not offer — the " +
        "packed flags word is write-only by construction (§V588), so another slot's alive and " +
        "spawnCount cannot be read, only invented (T1070). Read neighbours in a plain Point " +
        "Kernel, and carry what the population needs in an ordinary attribute.",
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

  /* T900: a reflected param must be constructible POSITIONALLY (`Params(a, b, c)` below), so
     every declared field needs a type this generator can pull out of the uniform block. A
     field it cannot — a matrix, an array, a nested struct — is refused BY NAME rather than
     left to arrive as Dawn's "no matching constructor", and rather than silently skipped:
     a skipped member is a knob that is not there and a uniform that reads zero (§V288). */
  const paramFields = request.params?.fields ?? [];
  for (const field of paramFields) {
    if (!PARAM_FIELD_TYPES.has(field.wgsl)) {
      errors.push(
        `struct Params field "${field.name}" is ${field.wgsl}, which cannot become a node control — ` +
          `a kernel's Params may declare ${[...PARAM_FIELD_TYPES].join(", ")} (T900).`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // The Point struct carries every attribute the kernel touches — reads, plus writes
  // (a written attribute is loaded too, so `var q = p; q.x += …` composes). Schema
  // order keeps the generated text deterministic regardless of reads/writes order.
  const touched = attributes.filter(
    (attribute) => reads.includes(attribute.name) || writes.includes(attribute.name),
  );
  const written = attributes.filter((attribute) => writes.includes(attribute.name));

  /* T1076: the addressing table, resolved into GROUPS. Attributes sharing a group share
     ONE `array<u32>` binding — which is why the count below no longer grows with n. */
  const readAt = (name: string): KernelStorageRegion | undefined => request.storage.reads[name];
  const writeAt = (name: string): KernelStorageRegion | undefined => request.storage.writes[name];
  const missing: string[] = [];
  for (const attribute of touched) {
    if (attribute.name === lifecycle?.flagsAttribute) continue;
    if (readAt(attribute.name) === undefined) missing.push(`read of "${attribute.name}"`);
  }
  for (const attribute of written) {
    if (writeAt(attribute.name) === undefined) missing.push(`write of "${attribute.name}"`);
  }
  if (missing.length > 0) {
    /* A gap here means the NODE built a Point out of attributes it cannot address. Refused
       by name rather than emitting a module whose `Point` declares a field no load fills
       (§V288) — the exact silence T1076 replaced. */
    return {
      ok: false,
      errors: [
        `the storage map is missing the ${missing.join(", ")} — every touched attribute needs a ` +
          `region and every written one a destination (T1076).`,
      ],
    };
  }

  /* Groups in FIRST-APPEARANCE order over reads then writes, so the generated text is
     deterministic for a given schema. A group named by any write is bound `read_write` —
     which is how the spawn hook, editing the read halves in place, gets ONE binding. */
  const groupAccess = new Map<string, "read" | "read_write">();
  const noteGroup = (region: KernelStorageRegion | undefined, write: boolean): void => {
    if (region === undefined) return;
    const current = groupAccess.get(region.group);
    if (current === undefined) groupAccess.set(region.group, write ? "read_write" : "read");
    else if (write) groupAccess.set(region.group, "read_write");
  };
  for (const attribute of touched) noteGroup(readAt(attribute.name), false);
  for (const attribute of written) noteGroup(writeAt(attribute.name), true);

  const groupVariable = new Map<string, string>();
  const bindings: PointBufferBinding[] = [];
  let nextBinding = 1; // binding 0 is the uniforms block
  for (const [group, access] of groupAccess) {
    const variable = `pk_${groupVariable.size}`;
    groupVariable.set(group, variable);
    bindings.push({ variable, binding: nextBinding, access, role: "storage", group });
    nextBinding += 1;
  }
  if (lifecycle !== undefined) {
    bindings.push({
      variable: "liveCount",
      binding: nextBinding,
      access: "read",
      role: "live",
    });
    nextBinding += 1;
  }

  /* §V588/B33: the budget, checked against the bindings actually built.
     T1076 changed what this catches. It used to be the ATTRIBUTE ceiling — 2n bindings
     against a baseline of 8, so four attributes and the fifth failed the pipeline in
     silence. Packing made the count independent of n, so what is left is the number of
     distinct PRODUCERS one kernel reads from: a chain of by-reference forwards (T401,
     §V197) can hand a kernel attributes owned by many upstream nodes, and each is one
     more buffer to bind. The SIZE bound that replaced the attribute ceiling lives in
     `points/packing.ts`, where the layout arithmetic is. */
  if (bindings.length > MAX_KERNEL_STORAGE_BINDINGS) {
    const producers = [...groupAccess.keys()].length;
    return {
      ok: false,
      errors: [
        `this kernel binds ${bindings.length} storage buffers — ${producers} packed point ` +
          `${producers === 1 ? "buffer" : "buffers"}${lifecycle === undefined ? "" : " plus the live count"} — ` +
          `and the WebGPU baseline maxStorageBuffersPerShaderStage is ${MAX_KERNEL_STORAGE_BINDINGS} (§V588). ` +
          `Attribute COUNT is no longer the limit (T1076); this many buffers means the attributes ` +
          `arrive from ${producers} different upstream producers by reference. Collapse the chain — ` +
          `a kernel that WRITES an attribute owns it, and owned attributes share one buffer.`,
      ],
    };
  }

  /* T477: the field texture takes the next slot AFTER every storage binding, and the
     helper mirrors the bridge's mapping verbatim — clip [-1,1] → uv [0,1] → texel,
     clamped so an off-screen point still samples the edge. */
  const fieldDeclarations =
    usesField && request.field === true
      ? `@group(0) @binding(${nextBinding}) var fieldTexture: texture_2d<f32>;

/* T477: sample the wired field at a point's position — the SAME mapping
   Texture To Attribute uses (T262/T512), so the bridge and this read agree texel for
   texel. y INVERTED (T512): world +y is up, texel row 0 is the picture's top, so
   +1 maps to uv.y = 0 — the two sites moved together, or §V349's two-mappings bug
   returns wearing this fix. */
fn fieldAt(position: vec3f) -> vec4f {
  let dims = vec2f(textureDimensions(fieldTexture, 0));
  let uv = clamp(vec2f(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5), vec2f(0.0), vec2f(1.0));
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

  /* T1076: one `array<u32>` per group. Every consumer reads its attribute out of a region
     of it, so the binding count is the number of PRODUCERS rather than of attributes. */
  const bufferDeclarations = bindings
    .map(
      (binding) =>
        `@group(0) @binding(${binding.binding}) var<storage, ${binding.access}> ${binding.variable}: array<u32>;`,
    )
    .join("\n");

  /* One accessor per attribute per direction, generated off the SAME region table the
     bindings came from — so `p`, `pointAt` and the stores cannot come to disagree about
     where an attribute is. `bitcast` because one binding cannot be two element types. */
  const loadName = (name: string): string => `pointLoad_${name}`;
  const storeName = (name: string): string => `pointStore_${name}`;
  const regionOfAttribute = (name: string, region: KernelStorageRegion): { type: PointAttributeType; offset: number; stride: number } => {
    const type = byName.get(name)?.type as PointAttributeType;
    return { type, offset: region.offset, stride: ATTRIBUTE_STRIDES[type] };
  };
  const accessorDeclarations = [
    ...touched
      .filter((attribute) => attribute.name !== lifecycle?.flagsAttribute)
      .map((attribute) => {
        const region = readAt(attribute.name) as KernelStorageRegion;
        return regionAccessorWgsl(
          loadName(attribute.name),
          groupVariable.get(region.group) as string,
          regionOfAttribute(attribute.name, region),
        );
      }),
    ...written.map((attribute) => {
      const region = writeAt(attribute.name) as KernelStorageRegion;
      return regionStoreWgsl(
        storeName(attribute.name),
        groupVariable.get(region.group) as string,
        regionOfAttribute(attribute.name, region),
      );
    }),
  ].join("\n\n");

  const loads = touched
    .map((attribute) =>
      attribute.name === lifecycle?.flagsAttribute
        ? "  p.alive = 1u; /* by construction inside the guard (T322) */\n" +
          "  p.spawnCount = 0u; /* last frame's births are not this frame's (T323) */"
        : `  p.${attribute.name} = ${loadName(attribute.name)}(index);`,
    )
    .join("\n");

  /* T1070: the same loads `main` performs for `index`, performed for a slot the kernel
     names. Written from `touched` so the accessor and `p` can never disagree about what a
     Point is — one list, read twice. Emitted only when the kernel says the word (§V309). */
  const neighborDeclaration = usesNeighbor
    ? `/* T1070: the Point in another SLOT, read from the PRE-FRAME half — the same half \`p\`
   itself was loaded from. ∴ every reader sees LAST frame's values whatever order the
   workgroups ran in: a Jacobi update, order- and device-independent (§V44), with no
   atomics and no read-write hazard. \`pointAt(ctx.index)\` is \`p\`.

   The SLOT is addressing, never identity (§V73) — and this function knows nothing about
   adjacency. Which slots are neighbours is the kernel's own predicate. */
fn pointAt(slot: u32) -> Point {
  var n: Point;
${touched.map((attribute) => `  n.${attribute.name} = ${loadName(attribute.name)}(slot);`).join("\n")}
  return n;
}

`
    : "";

  const stores = written
    .map((attribute) =>
      attribute.name === lifecycle?.flagsAttribute
        ? `  ${storeName(attribute.name)}(index, (min(q.spawnCount, ${MAX_SPAWN_PER_PARENT}u) << 1u) | (q.alive & 1u));`
        : `  ${storeName(attribute.name)}(index, q.${attribute.name});`,
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
      : "select(min(liveCount[0], kernelFrame.count), kernelFrame.count, kernelFrame.firstRun == 1u)";
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

  /* T489 (B97): the absolute pair, appended LAST for the reason every member before it was
     — a member that moved would move every kernel already reading the one in front of it.
     The GROUP PREDICATE is scanned too: it is compiled against this same `PointCtx`, so a
     predicate reading `ctx.absTime` must be able to declare the member the kernel did not. */
  const usesAbsClock = ABS_CLOCK_REFERENCE.test(kernel) || ABS_CLOCK_REFERENCE.test(groupSource);
  /* T510: appended after the absolute pair, for the same nothing-moves reason. */
  /* T510: a LIFECYCLE kernel always declares firstRun — its own live-count guard needs
     it (below), whether or not the user's kernel names it. Inferring freshness from
     frameIndex == 0 opened the guard to full capacity at every timeline lap. */
  const usesFirstRun =
    lifecycle !== undefined ||
    FIRST_RUN_REFERENCE.test(kernel) ||
    FIRST_RUN_REFERENCE.test(groupSource);
  const frameFirstRun = usesFirstRun ? "\n  firstRun: u32," : "";
  const ctxFirstRun = usesFirstRun
    ? "\n  /* T510: 1u on exactly the dispatches whose storage was just created or cleared —\n     the seeding signal. A LAP is not this (frameIndex wraps, buffers keep); a seek and\n     a document load are (both clear, §V170/T519). */\n  firstRun: u32,"
    : "";
  const firstRunArgument = usesFirstRun ? ", kernelFrame.firstRun" : "";
  /* T900: the reflected params, appended LAST of all — after the absolute pair and firstRun —
     for the reason every member before them was: a member that moved would move every kernel
     already reading the one in front of it. The struct is the AUTHOR'S OWN TEXT, hoisted; the
     uniform members are prefixed (`kernelParamUniformKey`) so an author's field name can never
     collide with one this generator owns. */
  const paramsDeclaration = paramFields.length === 0 ? "" : `${request.params?.declaration ?? ""}\n\n`;
  const frameParams = paramFields
    .map((field) => `\n  ${kernelParamUniformKey(field.name)}: ${field.wgsl},`)
    .join("");
  const ctxParams =
    paramFields.length === 0
      ? ""
      : "\n  /* T900: this node's OWN `struct Params`, reflected into named typed controls — each\n     field is a real drivable parameter on this node, so `ctx.params.orbitSpeed` is a knob\n     with a name rather than `ctx.value2` with a comment. A uniform write, never a rebuild\n     (§V5); the STRUCT is compileTime, because editing it changes the module. */\n  params: Params,";
  const paramsArgument =
    paramFields.length === 0
      ? ""
      : `, Params(${paramFields.map((field) => `kernelFrame.${kernelParamUniformKey(field.name)}`).join(", ")})`;

  const frameAbs = usesAbsClock ? "\n  absTimeSeconds: f32,\n  absFrameIndex: u32," : "";
  const ctxAbs = usesAbsClock
    ? "\n  /* T489: the clock that does NOT wrap at a timeline lap — `time` above restarts at\n     the in point, this keeps counting (T461). A frame COUNT at the timeline rate, never\n     a wall reading, so an offline take reproduces (§V44, T467).\n\n     B119 — THE ONE ASYMMETRY, said here because this is where it bites. `absFrame` is\n     u32 in THIS struct and f32 in a texture shader's `frameU` block. Each matches the\n     `frameIndex` beside it (u32 here, f32 there — that block is f32 throughout), so\n     neither side is wrong on its own and the two do not agree with each other. Float\n     maths on it wants `f32(ctx.absFrame)`; shader arithmetic pasted in unconverted is\n     what Dawn answers with \"no matching overload\". `absTime` is f32 on both sides. */\n  absTime: f32,\n  absFrame: u32,"
    : "";
  const absArguments = usesAbsClock ? ", kernelFrame.absTimeSeconds, kernelFrame.absFrameIndex" : "";

  /* T582, timeline-anchored: the kernelFrame.timeSeconds / kernelFrame.frameIndex reads
     below exist to BUILD `ctx.time` and `ctx.frameIndex`, which are the wrapping clock by
     contract (the salt keys randomness to the timeline frame so a replayed frame
     reproduces). What this file must never do is INFER storage freshness from
     frameIndex == 0 — that is `ctx.firstRun` (T510); the clock audit counts these reads. */
  const wgsl = `// Generated point kernel (T117, contract v${POINT_KERNEL_CONTRACT_VERSION}). Do not edit by hand.
struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,${framePointer}${frameValues}${frameAbs}${frameFirstRun}${frameParams}
};

@group(0) @binding(0) var<uniform> kernelFrame: KernelFrame;

${bufferDeclarations}

${accessorDeclarations}

${paramsDeclaration}struct Point {
${structFields}
};

${dimStruct}struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,${ctxPointer}${ctxDim}${ctxValues}${ctxAbs}${ctxFirstRun}${ctxParams}
};

${RNG_WGSL}

${fieldDeclarations}${neighborDeclaration}${kernel}
${groupFunction}
@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
${guard}
  var p: Point;
${loads}
  let ctx = PointCtx(index, ${lifecycle === undefined ? "kernelFrame.count" : "live"}, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex${usesPointer ? ", kernelFrame.pointer" : ""}${dimArgument}${valueArguments}${absArguments}${firstRunArgument}${paramsArgument});
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
    usesAbsClock,
    usesField: usesField && request.field === true,
    usesFirstRun,
    usesParams: paramFields,
    /* T587: the GROUP predicate is scanned with the kernel because it compiles against the
       same `PointCtx` — a predicate gating on `ctx.time` wraps exactly as loudly. */
    notices: noticesOf(wrappingClockNotice("kernel", kernel, groupSource)),
  };
}

/** One place that turns "maybe a notice" into the list every module carries. */
function noticesOf(...found: ReadonlyArray<KernelNotice | undefined>): ReadonlyArray<KernelNotice> {
  return found.filter((notice): notice is KernelNotice => notice !== undefined);
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
  /**
   * T1076: where the shaped attributes live. The hook edits IN PLACE, so every attribute
   * names the same group in `reads` and `writes` — which is what makes it one
   * `read_write` binding instead of two.
   */
  readonly storage: KernelStorageMap;
  /** WGSL text containing `fn spawn(child: Point, ctx: PointCtx) -> Point`. */
  readonly hook: string;
  readonly workgroupSize?: number;
  /**
   * T900: the SAME reflected `struct Params` the kernel on this node declared. The hook is a
   * second pass on one node, so it reaches the same knobs — which is what makes "spawn with
   * the speed the slider says" expressible. ONE declaration site (the kernel text), two
   * modules, exactly as the value slots already work.
   */
  readonly params?: KernelModuleRequest["params"];
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
  /* T1070: the hook runs IN PLACE over the newborn range, after the copy passes — so the
     buffers it sees are MID-UPDATE: some slots hold this frame's survivors, some hold
     children that have not been shaped yet, and the tail is last frame's dead. There is no
     coherent frame for a neighbour read to belong to, which is a worse failure than the
     lifecycle kernel's (there the answer is unreadable; here it would be READABLE AND
     MEANINGLESS). Refused by name (§V288). */
  if (NEIGHBOR_REFERENCE.test(request.hook)) {
    errors.push(
      "spawn hook calls pointAt(...), but it runs in place over just the newborn range after " +
        "the copy passes ∴ the buffers are mid-update and another slot holds no coherent " +
        "frame's value (T1070). Look at neighbours in the kernel that decides the birth and " +
        "stash what the child needs in an attribute; the child arrives as its parent's copy.",
    );
  }
  /* T744: the field reaches the KERNEL, deliberately not the hook — the child arrives
     as its parent's copy, so the kernel (which just sampled the field to decide the
     birth) stashes whatever the child needs in an attribute and the copy pass carries
     it. A hook binding the texture would be a second sampling site for one decision. */
  if (FIELD_REFERENCE.test(request.hook)) {
    errors.push(
      "spawn hook calls fieldAt(...), but the field input reaches the kernel only (T744) — " +
        "sample it in the kernel that decides the birth and stash what the child needs in an " +
        "attribute; the child arrives as its parent's copy.",
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
  /* T489 (B97), the hook's half — and the hook is the surface where the absolute clock is
     LEAST optional: a spawn hook is the natural place to write "born with a phase taken
     from the clock", and on `ctx.time` every population born after a lap repeats the phases
     of the population born before it. Same detection, same optionality (§V309). */
  const usesAbsClock = ABS_CLOCK_REFERENCE.test(request.hook);
  const hookFrameAbs = usesAbsClock ? "\n  absTimeSeconds: f32,\n  absFrameIndex: u32," : "";
  const hookCtxAbs = usesAbsClock
    ? "\n  /* T489: the clock that does NOT wrap at a timeline lap (T461), same numbers the\n     kernel on this node reads. B119: `absFrame` is u32 here (matching the `frameIndex`\n     above) and f32 in a shader's `frameU` block — convert, do not paste. */\n  absTime: f32,\n  absFrame: u32,"
    : "";
  const hookAbsArguments = usesAbsClock ? ", kernelFrame.absTimeSeconds, kernelFrame.absFrameIndex" : "";

  /* T900: the kernel's params, on the hook's ctx too — one declaration, both passes. */
  const hookParamFields = request.params?.fields ?? [];
  const hookParamsDeclaration = hookParamFields.length === 0 ? "" : `${request.params?.declaration ?? ""}\n\n`;
  const hookFrameParams = hookParamFields
    .map((field) => `\n  ${kernelParamUniformKey(field.name)}: ${field.wgsl},`)
    .join("");
  const hookCtxParams =
    hookParamFields.length === 0
      ? ""
      : "\n  /* T900: the same reflected `struct Params` the kernel on this node reads. */\n  params: Params,";
  const hookParamsArgument =
    hookParamFields.length === 0
      ? ""
      : `, Params(${hookParamFields.map((field) => `kernelFrame.${kernelParamUniformKey(field.name)}`).join(", ")})`;

  const shaped = request.attributes.filter((attribute) => attribute.name !== request.flagsAttribute);
  /* T1076: in place on the read halves, where the copy passes left the newborns — one
     `read_write` binding per group rather than one per attribute. */
  const hookGroups: string[] = [];
  for (const attribute of shaped) {
    const region = request.storage.writes[attribute.name];
    if (region === undefined) {
      return {
        ok: false,
        errors: [`the spawn hook's storage map is missing a destination for "${attribute.name}" (T1076).`],
      };
    }
    if (!hookGroups.includes(region.group)) hookGroups.push(region.group);
  }
  const hookVariable = new Map(hookGroups.map((group, index) => [group, `pk_${index}`]));
  const bindings: PointBufferBinding[] = [
    ...hookGroups.map((group, index) => ({
      variable: hookVariable.get(group) as string,
      binding: index + 1,
      access: "read_write" as const,
      role: "storage" as const,
      group,
    })),
    { variable: "counts", binding: hookGroups.length + 1, access: "read" as const, role: "live" as const },
  ];
  const hookRegion = (attribute: PointAttributeSchema): { type: PointAttributeType; offset: number; stride: number } => ({
    type: attribute.type,
    offset: (request.storage.writes[attribute.name] as KernelStorageRegion).offset,
    stride: ATTRIBUTE_STRIDES[attribute.type],
  });
  const hookAccessors = [
    ...shaped.map((attribute) =>
      regionAccessorWgsl(
        `pointLoad_${attribute.name}`,
        hookVariable.get((request.storage.writes[attribute.name] as KernelStorageRegion).group) as string,
        hookRegion(attribute),
      ),
    ),
    ...shaped.map((attribute) =>
      regionStoreWgsl(
        `pointStore_${attribute.name}`,
        hookVariable.get((request.storage.writes[attribute.name] as KernelStorageRegion).group) as string,
        hookRegion(attribute),
      ),
    ),
  ].join("\n\n");

  const wgsl = `// Generated spawn hook (T339, contract v${ADVANCED_KERNEL_CONTRACT_VERSION}). Do not edit by hand.
struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,${usesPointer ? "\n  pointer: vec4f," : ""}${hookValueSlots.map((slot) => `\n  value${slot}: f32,`).join("")}${hookFrameAbs}${hookFrameParams}
};

@group(0) @binding(0) var<uniform> kernelFrame: KernelFrame;

${hookGroups.map((group, index) => `@group(0) @binding(${index + 1}) var<storage, read_write> ${hookVariable.get(group) as string}: array<u32>;`).join("\n")}
@group(0) @binding(${hookGroups.length + 1}) var<storage, read> counts: array<u32>;

${hookAccessors}

${hookParamsDeclaration}struct Point {
${shaped.map((attribute) => `  ${attribute.name}: ${attribute.type},`).join("\n")}
};

struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,${usesPointer ? "\n  /* T367: the same four numbers the shared frame block carries (§V182). */\n  pointer: vec4f," : ""}${hookValueSlots.length === 0 ? "" : `\n  /* T479: the same live value slots the kernel reads, on the same node. */${hookValueSlots.map((slot) => `\n  value${slot}: f32,`).join("")}`}${hookCtxAbs}${hookCtxParams}
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
${shaped.map((attribute) => `  p.${attribute.name} = pointLoad_${attribute.name}(index);`).join("\n")}
  let ctx = PointCtx(index, live, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex${usesPointer ? ", kernelFrame.pointer" : ""}${hookValueSlots.map((slot) => `, kernelFrame.value${slot}`).join("")}${hookAbsArguments}${hookParamsArgument});
  let q = spawn(p, ctx);
${shaped.map((attribute) => `  pointStore_${attribute.name}(index, q.${attribute.name});`).join("\n")}
}
`;

  // T510: the spawn hook runs on NEWBORNS mid-simulation; "my buffers are fresh" is a
  // kernel-level fact, so the hook never declares it.
  return {
    ok: true,
    wgsl,
    buffers: bindings,
    contractVersion: ADVANCED_KERNEL_CONTRACT_VERSION,
    workgroupSize,
    usesPointer,
    usesValues: hookValueSlots,
    usesAbsClock,
    usesField: false,
    usesFirstRun: false,
    usesParams: hookParamFields,
    /* T587: the hook is the surface where this matters MOST — "born with a phase off the
       clock" is the natural thing to write there, and on the wrapping one every generation
       born after a lap repeats the phases of the generation born before it. */
    notices: noticesOf(wrappingClockNotice("spawn hook", request.hook)),
  };
}

/** Components a default value needs, re-exported so node manifests can validate cheaply. */
export { COMPONENT_COUNTS };
