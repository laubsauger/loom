import {
  ATTRIBUTE_STRIDES,
  COMPONENT_COUNTS,
  validateAttributes,
  type PointAttributeSchema,
} from "./attributes.ts";
import type { PackedLayout } from "./packing.ts";

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
 *   3. `scatter`     — survivors copy their attributes from slot i to slot
 *                      scanned[i] + blockOffset[block(i)]. ONE pass over the whole
 *                      schema since T1076: the attributes are regions of one packed
 *                      buffer per half, so the pass spends flags + scanned + blockSums
 *                      + in + out = 5 storage bindings whatever n is. It used to be
 *                      CHUNKED at two attributes a pass (2·attrs + 3 ≤ 8), which cost
 *                      ⌈n/2⌉ dispatches per frame for nothing but the binding budget.
 *
 * Slots MOVE under compaction — which is exactly why identity is the `id` attribute's
 * value and never a slot index (§V73). Nothing in these kernels reads `pointId`; they
 * move whole slots, ids riding along like any other attribute.
 */

export const SCAN_WORKGROUP_SIZE = 256;

/**
 * T323: per-parent births per frame are CAPPED. A WGSL loop must be bounded, and a
 * runaway emitter should saturate loudly (the dropped counter) rather than hang a
 * dispatch. Eight per parent per frame is 480/second at 60fps from ONE point.
 */
export const MAX_SPAWN_PER_PARENT = 8;

/**
 * T323: the counts buffer layout (u32 × 4, one per producer). Slot 0 is what T322
 * shipped as the live count — consumers read it unchanged. The rest arrived with
 * spawn: the monotone id cursor (§V73 — identity survives compaction AND birth),
 * the CUMULATIVE dropped-births counter (a saturating emitter must be countable,
 * or it is indistinguishable from a working one that spawns fewer), and this
 * frame's births — raw before finalize, PLACED after it (the spawn hook's range
 * input, T339).
 */
export const COUNTS_LIVE = 0;
export const COUNTS_NEXT_ID = 1;
export const COUNTS_DROPPED = 2;
export const COUNTS_BIRTHS = 3;

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

/**
 * T323: `extract` reads the scanned quantity out of a flags word — `raw` (v1's 0/1
 * arrays), the alive bit (`& 1u`) or the spawn count (`>> 1u`, capped). ONE scan
 * implementation, three spellings, so the second scan cannot drift from the first.
 */
export type FlagsExtract = "raw" | "aliveBit" | "spawnCount";

function extractWgsl(extract: FlagsExtract): string {
  switch (extract) {
    case "raw":
      return "raw";
    case "aliveBit":
      return "raw & 1u";
    case "spawnCount":
      return `min(raw >> 1u, ${MAX_SPAWN_PER_PARENT}u)`;
  }
}

function scanLocalWgsl(extract: FlagsExtract): string {
  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> scanned: array<u32>;
@group(0) @binding(3) var<storage, read_write> blockSums: array<u32>;

var<workgroup> temp: array<u32, ${SCAN_WORKGROUP_SIZE}>;

fn extract(raw: u32) -> u32 {
  return ${extractWgsl(extract)};
}

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let index = gid.x;
  let value = select(0u, extract(flags[index]), index < params.capacity);
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

function scanBlocksWgsl(targetSlot = 0): string {
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
  aliveCount[${targetSlot}u] = acc;
}`;
}

/**
 * T1076: the word-wise copy of one attribute's region from slot `index` to slot
 * `destination`, inside packed buffers that share ONE layout. `vec3f` moves three words
 * out of its four-word stride — the padding word was never read and is not copied.
 */
function copyRegionWgsl(layout: PackedLayout, indent: string): string {
  return layout.regions
    .flatMap((region) => {
      const words = region.stride / 4;
      const base = region.offset / 4;
      return Array.from({ length: COMPONENT_COUNTS[region.type] }, (_, component) => {
        const tail = component === 0 ? "" : ` + ${component}u`;
        return (
          `${indent}out_points[${base}u + destination * ${words}u${tail}] = ` +
          `in_points[${base}u + index * ${words}u${tail}];`
        );
      });
    })
    .join("\n");
}

function scatterWgsl(layout: PackedLayout, extract: FlagsExtract): string {
  const declarations =
    "@group(0) @binding(4) var<storage, read> in_points: array<u32>;\n" +
    "@group(0) @binding(5) var<storage, read_write> out_points: array<u32>;";
  const copies = copyRegionWgsl(layout, "  ");

  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> scanned: array<u32>;
@group(0) @binding(3) var<storage, read> blockSums: array<u32>;
${declarations}

fn extract(raw: u32) -> u32 {
  return ${extractWgsl(extract)};
}

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.capacity) {
    return;
  }
  if (extract(flags[index]) == 0u) {
    return;
  }
  let destination = scanned[index] + blockSums[index / ${SCAN_WORKGROUP_SIZE}u];
${copies}
}`;
}

export function generateCompactionModule(
  attributes: ReadonlyArray<PointAttributeSchema>,
  capacity: number,
  /**
   * T1076: where those attributes live inside the packed pair. Handed in rather than
   * recomputed so the scatter and the node's own scratch request cannot come to disagree
   * about an offset (§V349) — the pass writes bytes the renderers then read.
   */
  layout: PackedLayout,
  /** T323: how the scan reads its quantity out of the flags word. Default: v1's raw 0/1. */
  extract: FlagsExtract = "raw",
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
      wgsl: scanLocalWgsl(extract),
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

  /* T1076: ONE scatter for the whole schema. This used to be ⌈n/2⌉ dispatches a frame,
     chunked purely to stay inside the 8-storage-buffers budget; packing removed the
     reason, so the dispatches went with it. */
  passes.push({
    name: "scatter",
    wgsl: scatterWgsl(layout, extract),
    entryPoint: "main",
    dispatch: "perPoint",
    bindings: [
      { binding: 1, name: "flags", access: "read" },
      { binding: 2, name: "scanned", access: "read" },
      { binding: 3, name: "blockSums", access: "read" },
      { binding: 4, name: "in_points", access: "read" },
      { binding: 5, name: "out_points", access: "read_write" },
    ],
  });

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
  firstRun: u32,
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
  /* T510: "my storage is fresh" is params.firstRun, never frameIndex — a timeline LAP
     rewinds frameIndex to 0 with the buffers intact, and treating that as fresh
     resurrected the dead tail at every loop. */
  let live = select(min(liveCount[0], params.capacity), params.capacity, params.firstRun == 1u);
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


/* ------------------------------------------------------------------------------------
 * T323: the SPAWN half. A second scan over the same flags word (spawnCount bits) plus ONE
 * child-copy pass (T1076 — it was one PER ATTRIBUTE) and one finalize. Children are COPIES
 * of their parent — every attribute rides over verbatim except id (fresh, from the monotone
 * cursor) and flags (born alive, spawning nothing). Differentiation happens NEXT frame
 * through pointRand(id, salt): distinct ids, distinct draws (§V74).
 *
 * The spawn(parent) hook stays a SECOND PASS, and since T1076 that is a semantic choice
 * rather than a budget one: a one-pass hook used to need 2n+4 storage bindings against the
 * per-stage limit of 8 (B33's arithmetic), and packing retired that arithmetic. What keeps
 * the two-pass shape is that the child arrives as its parent's copy, so inheritance is the
 * initial value the hook shapes rather than something it would have to invent (T287).
 * ---------------------------------------------------------------------------------- */

/** Frame-aware params block shared by spawn passes (T172: frame fields merge in). */
const SPAWN_PARAMS_WGSL = `struct SpawnParams {
  timeSeconds: f32,
  deltaSeconds: f32,
  frameIndex: u32,
  capacity: u32,
  firstRun: u32,
};
@group(0) @binding(0) var<uniform> params: SpawnParams;`;

/**
 * T1076: every copied attribute in ONE pass. It was one dispatch PER ATTRIBUTE — the
 * hook's `in`/`out` pair could not be chunked any smaller against the old budget — and
 * with the schema packed, the pass binds 6 storage buffers whatever n is.
 */
function spawnCopyWgsl(layout: PackedLayout, copied: ReadonlySet<string>): string {
  const copyLayout: PackedLayout = {
    ...layout,
    regions: layout.regions.filter((region) => copied.has(region.name)),
  };
  return `${SPAWN_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> spawnScanned: array<u32>;
@group(0) @binding(3) var<storage, read> spawnBlockSums: array<u32>;
@group(0) @binding(4) var<storage, read> counts: array<u32>;
@group(0) @binding(5) var<storage, read> in_points: array<u32>;
@group(0) @binding(6) var<storage, read_write> out_points: array<u32>;

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.capacity) {
    return;
  }
  let births = min(flags[index] >> 1u, ${MAX_SPAWN_PER_PARENT}u);
  if (births == 0u) {
    return;
  }
  let base = counts[${COUNTS_LIVE}u] + spawnScanned[index] + spawnBlockSums[index / ${SCAN_WORKGROUP_SIZE}u];
  for (var child = 0u; child < births; child = child + 1u) {
    let destination = base + child;
    if (destination < params.capacity) {
${copyRegionWgsl(copyLayout, "      ")}
    }
  }
}`;
}

/**
 * Ids and flags for newborns, one pass: fresh id from the cursor, born alive.
 *
 * T1076: BOTH writes go through ONE `out_points` binding. They were two — `out_id` and
 * `out_flags` on separate pairs — and once the attributes became regions of one packed
 * buffer, binding it twice as `read_write` is a writable ALIAS, which vgpu refuses at
 * dispatch ("`src` and writable `dst` alias"). One binding, two offsets.
 */
function spawnIdentityWgsl(layout: PackedLayout, idAttribute: string, flagsAttribute: string): string {
  const id = layout.byName.get(idAttribute);
  const flagsRegion = layout.byName.get(flagsAttribute);
  if (id === undefined || flagsRegion === undefined) {
    throw new Error(`spawn identity needs packed regions for "${idAttribute}" and "${flagsAttribute}"`);
  }
  const idWord = `${id.offset / 4}u + slot * ${id.stride / 4}u`;
  const flagsWord = `${flagsRegion.offset / 4}u + slot * ${flagsRegion.stride / 4}u`;
  return `${SPAWN_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read> spawnScanned: array<u32>;
@group(0) @binding(3) var<storage, read> spawnBlockSums: array<u32>;
@group(0) @binding(4) var<storage, read> counts: array<u32>;
@group(0) @binding(5) var<storage, read_write> out_points: array<u32>;

@compute @workgroup_size(${SCAN_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.capacity) {
    return;
  }
  let births = min(flags[index] >> 1u, ${MAX_SPAWN_PER_PARENT}u);
  if (births == 0u) {
    return;
  }
  /* First run: the cursor buffer is zero-initialised and ids 0..capacity-1 are the
     first generation's, so newborn ids start at capacity (§V73). firstRun, not
     frameIndex == 0 — a timeline lap keeps the cursor (T510). */
  let nextIdBase = select(counts[${COUNTS_NEXT_ID}u], params.capacity, params.firstRun == 1u);
  let birthIndex = spawnScanned[index] + spawnBlockSums[index / ${SCAN_WORKGROUP_SIZE}u];
  let base = counts[${COUNTS_LIVE}u] + birthIndex;
  for (var child = 0u; child < births; child = child + 1u) {
    let slot = base + child;
    if (slot < params.capacity) {
      out_points[${idWord}] = nextIdBase + birthIndex + child;
      out_points[${flagsWord}] = 1u; /* alive, spawning nothing */
    }
  }
}`;
}

function spawnFinalizeWgsl(): string {
  return `${SPAWN_PARAMS_WGSL}
@group(0) @binding(1) var<storage, read_write> counts: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u) {
    return;
  }
  let alive = counts[${COUNTS_LIVE}u];
  let requested = counts[${COUNTS_BIRTHS}u];
  let placed = min(requested, params.capacity - alive);
  /* CUMULATIVE (T323's countable condition): a saturating emitter that dropped
     silently would be indistinguishable from a working one that spawns fewer. */
  counts[${COUNTS_DROPPED}u] = counts[${COUNTS_DROPPED}u] + (requested - placed);
  counts[${COUNTS_NEXT_ID}u] =
    select(counts[${COUNTS_NEXT_ID}u], params.capacity, params.firstRun == 1u) + placed;
  counts[${COUNTS_LIVE}u] = alive + placed;
  /* T339: the births slot ends the frame holding PLACED, which is the spawn hook's
     range input — [live - placed, live) is exactly the newborns. */
  counts[${COUNTS_BIRTHS}u] = placed;
}`;
}

export interface SpawnModule {
  readonly ok: true;
  readonly passes: ReadonlyArray<LifecyclePass>;
}

/**
 * The spawn pass list, appended AFTER the survivor scatter: spawn scan (the alive
 * scan's generated passes with the spawnCount extraction — one implementation, so the
 * second scan cannot drift from the first), ONE child-copy pass into the read halves
 * (T1076 — it was one dispatch per attribute), identity, finalize. Bindings are named; the node maps them to resources exactly as
 * it does for compaction.
 */
export function generateSpawnModule(
  attributes: ReadonlyArray<PointAttributeSchema>,
  /** T1076: the packed layout the copies address, from the node that allocated it. */
  layout: PackedLayout,
  options: { readonly idAttribute: string; readonly flagsAttribute: string },
): SpawnModule {
  const copyBindings = [
    { binding: 1, name: "flags", access: "read" as const },
    { binding: 2, name: "spawnScanned", access: "read" as const },
    { binding: 3, name: "spawnBlockSums", access: "read" as const },
    { binding: 4, name: "counts", access: "read" as const },
  ];
  const copied = attributes.filter(
    (attribute) => attribute.name !== options.idAttribute && attribute.name !== options.flagsAttribute,
  );
  return {
    ok: true,
    passes: [
      {
        name: "spawnScanLocal",
        wgsl: scanLocalWgsl("spawnCount"),
        entryPoint: "main",
        dispatch: "perPoint",
        // The WGSL is the SHARED scan — its binding names are scanned/blockSums; the
        // consumer maps them to the spawn-side buffers per pass (see the node).
        bindings: [
          { binding: 1, name: "flags", access: "read" },
          { binding: 2, name: "scanned", access: "read_write" },
          { binding: 3, name: "blockSums", access: "read_write" },
        ],
      },
      {
        name: "spawnScanBlocks",
        wgsl: scanBlocksWgsl(COUNTS_BIRTHS),
        entryPoint: "main",
        dispatch: "single",
        bindings: [
          { binding: 1, name: "blockSums", access: "read_write" },
          { binding: 2, name: "aliveCount", access: "read_write" },
        ],
      },
      {
        name: "spawnCopy",
        wgsl: spawnCopyWgsl(layout, new Set(copied.map((attribute) => attribute.name))),
        entryPoint: "main",
        dispatch: "perPoint",
        bindings: [
          ...copyBindings,
          { binding: 5, name: "in_points", access: "read" as const },
          { binding: 6, name: "out_points", access: "read_write" as const },
        ],
      },
      {
        name: "spawnIdentity",
        wgsl: spawnIdentityWgsl(layout, options.idAttribute, options.flagsAttribute),
        entryPoint: "main",
        dispatch: "perPoint",
        bindings: [...copyBindings, { binding: 5, name: "out_points", access: "read_write" as const }],
      },
      {
        name: "spawnFinalize",
        wgsl: spawnFinalizeWgsl(),
        entryPoint: "main",
        dispatch: "single",
        bindings: [{ binding: 1, name: "counts", access: "read_write" }],
      },
    ],
  };
}

/** Re-export so lifecycle consumers size attribute buffers without a second import. */
export { ATTRIBUTE_STRIDES };
