import {
  ATTRIBUTE_STRIDES,
  validateAttributes,
  type PointAttributeSchema,
} from "./attributes.ts";

/**
 * Scan-based lifecycle compaction (T119, §V74/§V76).
 *
 * Kill and spawn compact through an exclusive prefix sum over alive flags — NEVER
 * through atomics. Atomic slot assignment depends on GPU scheduling order, which would
 * break §V45's same-seed-same-frame reproducibility and the browser/Dawn parity gate in
 * one stroke. The scan is deterministic by data order; the price is two extra small
 * passes per lifecycle system per frame.
 *
 * v1 structure, chosen for correctness-first:
 *   1. `scanLocal`   — per-workgroup exclusive scan of the flags, block totals out.
 *   2. `scanBlocks`  — ONE thread serially scans the block totals and writes the alive
 *                      count. Deliberately serial: at 1M points that is 4096 additions
 *                      on one invocation, deterministic and trivially correct. This is
 *                      a known perf lever, not a limitation — swap for a hierarchical
 *                      scan later without touching the pass interface.
 *   3. `scatter…`    — survivors copy their attributes from slot i to slot
 *                      scanned[i] + blockOffset[block(i)]. Chunked so a chunk's
 *                      in/out pairs stay inside baseline storage-buffer limits (§V24):
 *                      flags + scanned + blockSums + 2·attrs ≤ 8 per stage.
 *
 * Slots MOVE under compaction — which is exactly why identity is the `id` attribute's
 * value and never a slot index (§V73). Nothing in these kernels reads `pointId`; they
 * move whole slots, ids riding along like any other attribute.
 */

export const SCAN_WORKGROUP_SIZE = 256;

/** Baseline WebGPU guarantees 8 storage buffers per stage; scatter uses 3 + 2·chunk. */
const SCATTER_ATTRIBUTES_PER_PASS = 2;

export interface LifecyclePass {
  readonly name: string;
  readonly wgsl: string;
  readonly entryPoint: "main";
  /**
   * How to size the dispatch: "perPoint" = ceil(capacity / workgroup), "single" = one
   * workgroup (the serial block scan).
   */
  readonly dispatch: "perPoint" | "single";
  /** Storage bindings in binding-index order; binding 0 is always the params uniform. */
  readonly bindings: ReadonlyArray<{ readonly binding: number; readonly name: string; readonly access: "read" | "read_write" }>;
}

export interface CompactionModule {
  readonly ok: true;
  readonly passes: ReadonlyArray<LifecyclePass>;
  /** Elements (u32) the scratch buffers need at `capacity` points. */
  readonly scratch: {
    readonly scanned: number;
    readonly blockSums: number;
  };
  readonly workgroupSize: number;
}

export interface CompactionFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<string>;
}

export type CompactionResult = CompactionModule | CompactionFailure;

export function blockCount(capacity: number): number {
  return Math.ceil(capacity / SCAN_WORKGROUP_SIZE);
}

const PARAMS_WGSL = `struct LifecycleParams {
  capacity: u32,
};
@group(0) @binding(0) var<uniform> params: LifecycleParams;`;

function scanLocalWgsl(): string {
  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> scanned: array<u32>;
@group(0) @binding(3) var<storage, read_write> blockSums: array<u32>;

var<workgroup> temp: array<u32, ${SCAN_WORKGROUP_SIZE}>;

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let index = gid.x;
  let value = select(0u, flags[index], index < params.capacity);
  temp[lid.x] = value;
  workgroupBarrier();

  /* Hillis–Steele inclusive scan in shared memory: deterministic, no atomics (§V74). */
  var offset = 1u;
  while (offset < ${SCAN_WORKGROUP_SIZE}u) {
    var addend = 0u;
    if (lid.x >= offset) {
      addend = temp[lid.x - offset];
    }
    workgroupBarrier();
    temp[lid.x] += addend;
    workgroupBarrier();
    offset = offset << 1u;
  }

  if (index < params.capacity) {
    /* Exclusive = inclusive minus own input. */
    scanned[index] = temp[lid.x] - value;
  }
  if (lid.x == ${SCAN_WORKGROUP_SIZE}u - 1u) {
    blockSums[wid.x] = temp[lid.x];
  }
}`;
}

function scanBlocksWgsl(): string {
  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read_write> aliveCount: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u) {
    return;
  }
  /* Serial exclusive scan over block totals — one thread, order fixed, deterministic. */
  let blocks = (params.capacity + ${SCAN_WORKGROUP_SIZE}u - 1u) / ${SCAN_WORKGROUP_SIZE}u;
  var acc = 0u;
  var block = 0u;
  while (block < blocks) {
    let value = blockSums[block];
    blockSums[block] = acc;
    acc = acc + value;
    block = block + 1u;
  }
  aliveCount[0] = acc;
}`;
}

function scatterWgsl(chunk: ReadonlyArray<PointAttributeSchema>): string {
  const declarations = chunk
    .map(
      (attribute, index) =>
        `@group(0) @binding(${4 + index * 2}) var<storage, read> in_${attribute.name}: array<${attribute.type}>;\n` +
        `@group(0) @binding(${5 + index * 2}) var<storage, read_write> out_${attribute.name}: array<${attribute.type}>;`,
    )
    .join("\n");
  const copies = chunk
    .map((attribute) => `  out_${attribute.name}[destination] = in_${attribute.name}[index];`)
    .join("\n");

  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> scanned: array<u32>;
@group(0) @binding(3) var<storage, read> blockSums: array<u32>;
${declarations}

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.capacity) {
    return;
  }
  if (flags[index] == 0u) {
    return;
  }
  let destination = scanned[index] + blockSums[index / ${SCAN_WORKGROUP_SIZE}u];
${copies}
}`;
}

export function generateCompactionModule(
  attributes: ReadonlyArray<PointAttributeSchema>,
  capacity: number,
): CompactionResult {
  const errors: string[] = [];
  const schemaCheck = validateAttributes(attributes);
  errors.push(...schemaCheck.errors);
  if (!Number.isInteger(capacity) || capacity < 1) {
    errors.push(`capacity ${String(capacity)} must be a positive integer`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const passes: LifecyclePass[] = [
    {
      name: "scanLocal",
      wgsl: scanLocalWgsl(),
      entryPoint: "main",
      dispatch: "perPoint",
      bindings: [
        { binding: 1, name: "flags", access: "read" },
        { binding: 2, name: "scanned", access: "read_write" },
        { binding: 3, name: "blockSums", access: "read_write" },
      ],
    },
    {
      name: "scanBlocks",
      wgsl: scanBlocksWgsl(),
      entryPoint: "main",
      dispatch: "single",
      bindings: [
        { binding: 1, name: "blockSums", access: "read_write" },
        { binding: 2, name: "aliveCount", access: "read_write" },
      ],
    },
  ];

  for (let start = 0; start < attributes.length; start += SCATTER_ATTRIBUTES_PER_PASS) {
    const chunk = attributes.slice(start, start + SCATTER_ATTRIBUTES_PER_PASS);
    passes.push({
      name: `scatter:${chunk.map((attribute) => attribute.name).join("+")}`,
      wgsl: scatterWgsl(chunk),
      entryPoint: "main",
      dispatch: "perPoint",
      bindings: [
        { binding: 1, name: "flags", access: "read" },
        { binding: 2, name: "scanned", access: "read" },
        { binding: 3, name: "blockSums", access: "read" },
        ...chunk.flatMap((attribute, index) => [
          { binding: 4 + index * 2, name: `in_${attribute.name}`, access: "read" as const },
          { binding: 5 + index * 2, name: `out_${attribute.name}`, access: "read_write" as const },
        ]),
      ],
    });
  }

  return {
    ok: true,
    passes,
    scratch: { scanned: capacity, blockSums: blockCount(capacity) },
    workgroupSize: SCAN_WORKGROUP_SIZE,
  };
}

/**
 * CPU reference for the whole compaction (tests, and later the spreadsheet's oracle):
 * given flags and per-attribute arrays-of-slots, returns the compacted arrays and count.
 * Must agree with the GPU passes EXACTLY — that agreement is what the Dawn test pins.
 */
export function compactReference<T>(
  flags: ReadonlyArray<number>,
  slots: ReadonlyArray<T>,
): { compacted: T[]; aliveCount: number } {
  const compacted: T[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] !== 0) compacted.push(slots[index] as T);
  }
  return { compacted, aliveCount: compacted.length };
}

/** Bytes each scratch buffer needs; strides are u32. */
export function scratchBytes(capacity: number): { scanned: number; blockSums: number; aliveCount: number } {
  return {
    scanned: capacity * 4,
    blockSums: blockCount(capacity) * 4,
    aliveCount: 4,
  };
}


/**
 * T322 glue kernel: zeroes STALE alive flags in the tail the guarded kernel never
 * touched. After compaction the kernel processes only [0, liveCount) — slots beyond
 * hold a previous frame's flags in the write half, and the scan would resurrect them.
 * Frame zero exempts itself (the kernel processed the full capacity).
 */
export function clearDeadTailWgsl(): string {
  return `struct TailParams {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  capacity: u32,
};
@group(0) @binding(0) var<uniform> params: TailParams;
@group(0) @binding(1) var<storage, read> liveCount: array<u32>;
@group(0) @binding(2) var<storage, read_write> aliveFlags: array<u32>;

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.capacity) {
    return;
  }
  let live = select(min(liveCount[0], params.capacity), params.capacity, params.frameIndex == 0u);
  if (index >= live) {
    aliveFlags[index] = 0u;
  }
}`;
}

/**
 * T322 glue kernel: live count → indirect DRAW arguments. One workgroup, one thread;
 * the consumer bakes its per-instance vertex count in and clamps by its own max.
 */
export function drawArgsWgsl(): string {
  return `struct ArgsParams {
  vertexCount: u32,
  maxInstances: u32,
};
@group(0) @binding(0) var<uniform> params: ArgsParams;
@group(0) @binding(1) var<storage, read> liveCount: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawArgs: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u) {
    return;
  }
  drawArgs[0] = params.vertexCount;
  drawArgs[1] = min(liveCount[0], params.maxInstances);
  drawArgs[2] = 0u;
  drawArgs[3] = 0u;
}`;
}

/** Re-export so lifecycle consumers size attribute buffers without a second import. */
export { ATTRIBUTE_STRIDES };
