/**
 * T947 — the laser path planner's four passes.
 *
 * ONE planner, two consumers (the row's ruling): the passes below produce the PLANNED
 * sample stream — the exact samples that would go down a DAC's wire — and the preview
 * draws that stream, so flicker, corner dots and dim ballistic lines are the real
 * artifacts of the plan, not effects painted on top.
 *
 * THE MECHANISM, and why the renderer needs no special shader: brightness is dwell
 * time. Every emitted sample is one tick of the scanner's clock; drawn as small soft
 * ADDITIVE splats, sample density IS deposited energy. Corner dwell inserts coincident
 * samples, so corners glow because five samples landed in one place — nobody drew a
 * dot (the row's own sentence). A segment left ballistic (no resampling) is bright at
 * its endpoints and dim in the middle, which is the plan's stated acceptance criterion
 * for the interpolation stage.
 *
 * THE SCAN WINDOW is the honest refresh rate: a frame shows only the samples the beam
 * covers in that frame's time slice (pps × dt), advancing a cursor through the plan.
 * A plan larger than the budget is drawn across several display frames — the
 * characteristic wobble and drawing motion of an overdriven scanner, simulated by
 * arithmetic rather than faked.
 *
 * DETERMINISM (repo-specific, written down because a later optimisation would
 * innocently break it): no atomics anywhere; the scan is the lifecycle module's
 * Hillis–Steele + one-thread serial block scan, deterministic by data order; every
 * count is a pure function of the input positions and the params. Exact-value Dawn
 * gates depend on this.
 *
 * Pass order: COUNT (per input point: corner hold + subdivision counts, packed) →
 * SCAN LOCAL → SCAN BLOCKS (serial; writes the plan's total) → EMIT (one thread per
 * OUTPUT slot; binary-searches its source point, so the compacted stream needs no
 * scatter and the tail parks itself).
 */

export const LASER_SCAN_WORKGROUP = 256;

/** Packing of the counts buffer: low 16 bits = the slot count, high 16 = corner hold. */
const COUNT_MASK = "0xFFFFu";

/**
 * Shared per-point planning arithmetic — ONE implementation, inlined into both COUNT
 * and EMIT so the two passes cannot disagree about how many samples a point owns.
 *
 * Corner hold follows TD's shipped formulation (mincornerhold/maxcornerhold,
 * "calculated linearly by angle steepness"): steepness = (1 - cos θ)/2, so a
 * straight-through vertex takes holdMin extra samples and a full reversal holdMax.
 * An OPEN path's endpoints are full reversals — the beam turns around there.
 */
function planPointWgsl(slotsPerPoint: number): string {
  return `
const SLOTS_PER_POINT: u32 = ${slotsPerPoint}u;

struct PointPlan {
  hold: u32,     /* extra coincident samples at the vertex */
  subdiv: u32,   /* interpolated samples along the outgoing segment */
  count: u32,    /* 1 + hold + subdiv, clamped into SLOTS_PER_POINT */
};

fn planPoint(index: u32) -> PointPlan {
  let count = params.count;
  let closed = params.closed == 1u;
  let p = in_position[index];
  let hasPrev = closed || index > 0u;
  let hasNext = closed || index + 1u < count;
  let prev = in_position[select(index, (index + count - 1u) % count, hasPrev)];
  let next = in_position[select(index, (index + 1u) % count, hasNext)];

  /* Corner steepness. A degenerate neighbour (coincident points) reads straight. */
  let a = p - prev;
  let b = next - p;
  let la = length(a);
  let lb = length(b);
  var steepness = 0.0;
  if (hasPrev && hasNext && la > 1.0e-6 && lb > 1.0e-6) {
    steepness = (1.0 - dot(a / la, b / lb)) * 0.5;
  } else if (!hasPrev || !hasNext) {
    steepness = 1.0; /* an open end is a full reversal */
  }
  let holdSpan = max(params.holdMax - params.holdMin, 0.0);
  var hold = u32(round(params.holdMin + holdSpan * steepness));
  hold = min(hold, SLOTS_PER_POINT - 1u);

  /* Max-step resampling of the outgoing segment (the dwell carrier: a long line needs
     MORE samples, not fewer, or it draws bright at the ends and dim in the middle). */
  var subdiv = 0u;
  if (hasNext && params.maxStep > 1.0e-6 && lb > params.maxStep) {
    subdiv = min(u32(ceil(lb / params.maxStep)) - 1u, SLOTS_PER_POINT - 1u - hold);
  }

  return PointPlan(hold, subdiv, 1u + hold + subdiv);
}`;
}

const PARAMS_WGSL = `struct LaserParams {
  absTimeSeconds: f32,
  deltaSeconds: f32,
  count: u32,
  closed: u32,
  pps: f32,
  maxStep: f32,
  holdMin: f32,
  holdMax: f32,
  colorR: f32,
  colorG: f32,
  colorB: f32,
  colorA: f32,
};
@group(0) @binding(0) var<uniform> params: LaserParams;`;

/** COUNT — one thread per input point; packs (hold << 16) | count for the scan. */
export function laserCountWgsl(slotsPerPoint: number): string {
  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read_write> counts: array<u32>;
${planPointWgsl(slotsPerPoint)}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let plan = planPoint(index);
  counts[index] = (plan.hold << 16u) | plan.count;
}`;
}

/**
 * SCAN LOCAL — the lifecycle module's Hillis–Steele exclusive scan, restated here over
 * the packed counts (extract = raw & 0xFFFF). Deterministic by data order (§V74).
 */
export function laserScanLocalWgsl(): string {
  return `struct ScanParams { count: u32 };
@group(0) @binding(0) var<uniform> params: ScanParams;
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read_write> scanned: array<u32>;
@group(0) @binding(3) var<storage, read_write> blockSums: array<u32>;

var<workgroup> temp: array<u32, ${LASER_SCAN_WORKGROUP}>;

@compute @workgroup_size(${LASER_SCAN_WORKGROUP})
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let index = gid.x;
  let value = select(0u, counts[index] & ${COUNT_MASK}, index < params.count);
  temp[lid.x] = value;
  workgroupBarrier();
  var offset = 1u;
  while (offset < ${LASER_SCAN_WORKGROUP}u) {
    var addend = 0u;
    if (lid.x >= offset) {
      addend = temp[lid.x - offset];
    }
    workgroupBarrier();
    temp[lid.x] += addend;
    workgroupBarrier();
    offset = offset << 1u;
  }
  if (index < params.count) {
    scanned[index] = temp[lid.x] - value;
  }
  if (lid.x == ${LASER_SCAN_WORKGROUP}u - 1u) {
    blockSums[wid.x] = temp[lid.x];
  }
}`;
}

/** SCAN BLOCKS — one thread, serial exclusive scan of block totals; writes the total. */
export function laserScanBlocksWgsl(): string {
  return `struct ScanParams { count: u32 };
@group(0) @binding(0) var<uniform> params: ScanParams;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;
@group(0) @binding(2) var<storage, read_write> total: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u) {
    return;
  }
  let blocks = (params.count + ${LASER_SCAN_WORKGROUP}u - 1u) / ${LASER_SCAN_WORKGROUP}u;
  var acc = 0u;
  var block = 0u;
  while (block < blocks) {
    let value = blockSums[block];
    blockSums[block] = acc;
    acc = acc + value;
    block = block + 1u;
  }
  total[0] = acc;
}`;
}

/**
 * EMIT — one thread per OUTPUT slot. Each slot binary-searches the exclusive offsets
 * for its source point, computes its sample (hold copies first, then subdivision
 * lerps), and applies the scan window: only the samples inside this frame's time
 * slice are lit; the rest keep their place in the plan but carry zero colour. Slots
 * past the plan's total park at the codebase's park spot.
 */
export function laserEmitWgsl(slotsPerPoint: number): string {
  return `${PARAMS_WGSL}
@group(0) @binding(1) var<storage, read> in_position: array<vec3f>;
@group(0) @binding(2) var<storage, read> counts: array<u32>;
@group(0) @binding(3) var<storage, read> scanned: array<u32>;
@group(0) @binding(4) var<storage, read> blockSums: array<u32>;
@group(0) @binding(5) var<storage, read> total: array<u32>;
@group(0) @binding(6) var<storage, read_write> out_position: array<vec3f>;
@group(0) @binding(7) var<storage, read_write> out_tint: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> out_meta: array<vec2f>;
${planPointWgsl(slotsPerPoint)}

const PARKED: vec3f = vec3f(0.0, 0.0, -1.0e6);

fn offsetOf(index: u32) -> u32 {
  return scanned[index] + blockSums[index / ${LASER_SCAN_WORKGROUP}u];
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.count * SLOTS_PER_POINT) {
    return;
  }
  let planTotal = total[0];
  if (slot >= planTotal) {
    out_position[slot] = PARKED;
    out_tint[slot] = vec4f(0.0);
    out_meta[slot] = vec2f(0.0);
    return;
  }

  /* Binary search: the largest input index whose exclusive offset <= slot. */
  var lo = 0u;
  var hi = params.count - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) / 2u;
    if (offsetOf(mid) <= slot) {
      lo = mid;
    } else {
      hi = mid - 1u;
    }
  }
  let index = lo;
  let j = slot - offsetOf(index);
  let plan = planPoint(index);

  let p = in_position[index];
  var position = p;
  var dwell = f32(plan.hold + 1u);
  if (j > plan.hold) {
    /* A subdivision sample along the outgoing segment. */
    let next = in_position[(index + 1u) % params.count];
    let t = f32(j - plan.hold) / f32(plan.subdiv + 1u);
    position = mix(p, next, t);
    dwell = 1.0;
  }

  /* The scan window (honest refresh): cursor sweeps the plan at pps; this frame lights
     only the slice it covers. An over-budget plan takes several frames to draw. */
  let window = max(u32(params.pps * params.deltaSeconds), 1u);
  /* ABSOLUTE, not timeline (§V436): the scanner's clock is the instrument's, and a
     galvo does not rewind when a bounded piece laps — a timeline read here snapped
     the drawing head to the plan's start once per loop. */
  let cursor = u32(params.absTimeSeconds * params.pps) % planTotal;
  let lit = ((slot + planTotal - cursor) % planTotal) < window;

  out_position[slot] = position;
  out_tint[slot] = select(vec4f(0.0), vec4f(params.colorR, params.colorG, params.colorB, params.colorA), lit);
  out_meta[slot] = vec2f(dwell, f32(slot) / f32(planTotal));
}`;
}
