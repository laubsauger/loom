import {
  COMPONENT_COUNTS,
  validateAttributes,
  type PointAttributeSchema,
} from "./attributes.ts";

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
 */

/** Bumped when the generated Point/PointCtx/process signature changes shape (§V77). */
export const POINT_KERNEL_CONTRACT_VERSION = 1;

/**
 * Contract for the LIFECYCLE variant (T322): same `process` signature, but the module
 * additionally reads a GPU-resident live count (dispatch is guarded by it, not by the
 * static capacity), and the alive attribute is forced to 1 on frame zero so a
 * zero-initialised pair does not start universally dead.
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
   * T322: generate the lifecycle variant. The named attribute (u32, in the schema) is
   * the alive flag; the module gains a `liveCount` read binding, guards the dispatch
   * by it (frame zero uses the static count — the buffer is zero-initialised), and
   * loads the flag as 1 (alive by construction inside the guard — no read binding).
   */
  readonly lifecycle?: { readonly aliveAttribute: string };
  /**
   * T300: Houdini's Group field as a WGSL predicate over (p, ctx). Only matching
   * points run `process`; the rest pass through byte-identical. Evaluated in the
   * thread already running — no list is ever materialized.
   */
  readonly group?: string;
}

export interface KernelModule {
  readonly ok: true;
  readonly wgsl: string;
  /** Storage bindings in binding-index order. Binding 0 is always the uniforms block. */
  readonly buffers: ReadonlyArray<PointBufferBinding>;
  readonly contractVersion: number;
  readonly workgroupSize: number;
}

export interface KernelModuleFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<string>;
}

export type KernelModuleResult = KernelModule | KernelModuleFailure;

const PROCESS_SIGNATURE = /fn\s+process\s*\(\s*\w+\s*:\s*Point\s*,\s*\w+\s*:\s*PointCtx\s*\)\s*->\s*Point/;

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
    const alive = byName.get(lifecycle.aliveAttribute);
    if (alive === undefined) {
      errors.push(`lifecycle names alive attribute "${lifecycle.aliveAttribute}", which the schema does not declare`);
    } else if (alive.type !== "u32") {
      errors.push(`alive attribute "${lifecycle.aliveAttribute}" must be u32, not ${alive.type}`);
    } else if (!writes.includes(lifecycle.aliveAttribute)) {
      errors.push(`alive attribute "${lifecycle.aliveAttribute}" must be written, or nothing can die`);
    }
  }

  const workgroupSize = request.workgroupSize ?? DEFAULT_WORKGROUP_SIZE;
  if (!Number.isInteger(workgroupSize) || workgroupSize < 1 || workgroupSize > 256) {
    errors.push(`workgroupSize ${String(request.workgroupSize)} is outside [1, 256]`);
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
    // T322: the alive flag is WRITE-ONLY. Inside the guarded range a slot is alive BY
    // CONSTRUCTION (compaction packed survivors below the live count), so reading the
    // flag back is redundant — and the saved binding is what keeps the default schema
    // inside the baseline 8-storage-buffers-per-stage budget (§V24).
    if (attribute.name === lifecycle?.aliveAttribute) continue;
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
      attribute: lifecycle.aliveAttribute,
      variable: "liveCount",
      binding: nextBinding,
      access: "read",
      role: "live",
    });
    nextBinding += 1;
  }

  const structFields = touched
    .map((attribute) => `  ${attribute.name}: ${attribute.type},`)
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
      attribute.name === lifecycle?.aliveAttribute
        ? `  p.${attribute.name} = 1u; /* alive by construction inside the guard (T322) */`
        : `  p.${attribute.name} = in_${attribute.name}[index];`,
    )
    .join("\n");

  const stores = written
    .map((attribute) => `  out_${attribute.name}[index] = q.${attribute.name};`)
    .join("\n");

  /* T322: the lifecycle module is guarded by the LIVE count — frame zero uses the
     static count because the buffer is zero-initialised and nothing has counted yet —
     and forces the alive flag on frame zero for the same reason. */
  const group = typeof request.group === "string" ? request.group.trim() : "";
  /* T300: a group predicate gates `process`; non-members pass through byte-identical.
     The no-group text stays EXACTLY what v1 generated, so existing plans' pass
     signatures do not change under this feature's mere existence. */
  const groupFunction =
    group === ""
      ? ""
      : `
fn groupMatch(p: Point, ctx: PointCtx) -> bool {
  return (${group});
}
`;
  const invoke =
    group === ""
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


  const wgsl = `// Generated point kernel (T117, contract v${POINT_KERNEL_CONTRACT_VERSION}). Do not edit by hand.
struct KernelFrame {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  seed: u32,
  count: u32,
};

@group(0) @binding(0) var<uniform> kernelFrame: KernelFrame;

${bufferDeclarations}

struct Point {
${structFields}
};

struct PointCtx {
  /* Slot in the buffers — addressing, never identity (§V73). */
  index: u32,
  count: u32,
  time: f32,
  delta: f32,
  frameIndex: u32,
};

${RNG_WGSL}

${kernel}
${groupFunction}
@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
${guard}
  var p: Point;
${loads}
  let ctx = PointCtx(index, ${lifecycle === undefined ? "kernelFrame.count" : "live"}, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex);
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
  };
}

/** Components a default value needs, re-exported so node manifests can validate cheaply. */
export { COMPONENT_COUNTS };
