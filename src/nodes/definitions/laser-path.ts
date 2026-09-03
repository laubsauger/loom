import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, PassDescriptor } from "../../runtime/backend/plan.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import {
  LASER_SCAN_WORKGROUP,
  laserCountWgsl,
  laserEmitWgsl,
  laserScanBlocksWgsl,
  laserScanLocalWgsl,
} from "../shaders/laser-path.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readFlag, readNumber } from "./parameter-readers.ts";
import { attributeBinding, packedPointStorage } from "./point-storage.ts";

/**
 * The emit pass's stream bindings, named ONCE (§V349).
 *
 * T1076 made this matter: the wire pump used to rebuild `scratch:<node>:position` and
 * `scratch:<node>:tint` by convention, which packing retired — the stream is now two
 * REGIONS of one buffer, and the only place that says where they are is the plan. The
 * pump finds them by these names rather than by a second copy of the layout arithmetic,
 * and `laserStreamRegions` below is the lookup, kept beside the pass that emits them.
 */
export const LASER_STREAM_BINDINGS = { position: "out_position", tint: "out_tint" } as const;

/**
 * The planned stream's two regions, from the plan itself. Null when the named node emits
 * no laser plan this compile (unwired, pruned, or refused) — the pump then says so rather
 * than reading a buffer that means something else.
 */
export function laserStreamRegions(
  passes: ReadonlyArray<PassDescriptor>,
  nodeId: string,
): { readonly resourceId: string; readonly position: BufferRegion; readonly tint: BufferRegion } | null {
  for (const pass of passes) {
    if (!("nodeId" in pass) || pass.nodeId !== nodeId || !("buffers" in pass)) continue;
    const buffers = pass.buffers ?? [];
    const position = buffers.find((binding) => binding.binding === LASER_STREAM_BINDINGS.position);
    const tint = buffers.find((binding) => binding.binding === LASER_STREAM_BINDINGS.tint);
    if (position === undefined || tint === undefined) continue;
    if (position.offset === undefined || position.bytes === undefined) continue;
    if (tint.offset === undefined || tint.bytes === undefined) continue;
    return {
      resourceId: position.resourceId,
      position: { offset: position.offset, bytes: position.bytes },
      tint: { offset: tint.offset, bytes: tint.bytes },
    };
  }
  return null;
}

export interface BufferRegion {
  readonly offset: number;
  readonly bytes: number;
}

/** The sample-stream attributes this node owns, in packed-layout order. */
export const PLAN_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "meta", type: "vec2f", default: [0, 0] },
];

/**
 * Laser Path (T947) — the vector-display path planner: ordered points in, the PLANNED
 * sample stream out, at a scanner's points-per-second clock.
 *
 * A scope in X-Y mode IS a vector display and a laser projector IS an XY galvo
 * scanner (the row's ruling), so one planner serves both examples: the SCOPE is this
 * node with the planner stages turned down (no corner hold — the beam is inertialess),
 * and the LASER is the same node at full strength. TD ships the same split: its Laser
 * CHOP plans, its Laser Device CHOP transports; only Pangolin bypasses the planner
 * because Beyond plans itself — the contrast that proves who plans.
 *
 * THE PHYSICS IS ONE FACT — brightness is dwell time — and this node makes it true by
 * CONSTRUCTION rather than by styling: every emitted sample is one tick of the
 * scanner's clock. Rendered as small soft additive splats, sample DENSITY is deposited
 * energy: corner dwell (TD's mincornerhold/maxcornerhold, linear by angle steepness)
 * inserts coincident samples, so corners are hot because the beam decelerated there —
 * nobody drew a dot. Max-step resampling is the other half: without it a long segment
 * is one flight between two samples — bright at the ends, dim in the middle — which is
 * the plan's own acceptance criterion for the stage.
 *
 * SCAN RATE IS SIMULATED HONESTLY (never clamp, always report — §V185's shape): the
 * emitted stream carries the whole plan, and per frame a cursor lights only the slice
 * the beam covers in pps × dt. A plan bigger than the budget takes several display
 * frames to traverse — real flicker and visible drawing motion, not a post effect. The
 * ILDA 30K test pattern's own arithmetic: 1,192 points at 30,000 pps refresh at
 * 25.2 Hz.
 *
 * NOT IN v1, recorded with their ordering traps so a later stage lands right: path
 * reordering (blanked-travel minimisation; must stay seed-free and index-tie-broken or
 * every exact-value gate goes non-reproducible), decimation (which must run BEFORE
 * interpolation — Douglas-Peucker after resampling deletes exactly the points the
 * resampler inserted), colour delay, and the budget readouts as value channels (the
 * plan totals are GPU-resident; honest channels need the readback seam). This node is
 * simulation-only: the output stage (laserOut) is sequenced behind §T949's sideEffect
 * declaration and does not exist yet, deliberately.
 *
 * DETERMINISM: pure function of the input pointset, the params and the frame clock —
 * no atomics, scan by data order, everything an exact-value Dawn gate can pin.
 */

export const laserPathNode: NodeDefinition = {
  type: "laserPath",
  version: 1,
  title: "Laser Path",
  category: "points",
  description:
    "Plans an ordered point path the way a laser scanner or CRT beam would draw it: resamples long segments so galvo speed is bounded, dwells at corners (more samples where the beam decelerates — that is why corners glow), and plays the plan back at a points-per-second clock, so a path bigger than the scan budget flickers and crawls exactly like an overdriven projector. Draw the output as small soft additive points: sample density IS brightness.",
  tags: ["laser", "oscilloscope", "vector", "scanner", "galvo", "points", "plan", "dwell"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description: "The path, in slot order. Positions are the projector's field (clip space).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Samples",
      type: {
        kind: "pointset" as const,
        requires: [
          { name: "position", type: "vec3f" as const },
          { name: "tint", type: "vec4f" as const },
        ],
      },
      description:
        "The planned sample stream — the exact samples a DAC would receive. tint is the node's colour on samples inside this frame's scan window and zero outside it; meta carries (dwell, phase). Draw with soft additive points and map tint.",
    },
  ],
  parameters: {
    pps: {
      type: "number",
      label: "Points / second",
      default: 30000,
      min: 1000,
      max: 96000,
      range: "soft",
      step: 1000,
      description:
        "The scanner's clock. The frame budget is pps ÷ fps (500 points at 30k/60); a plan over budget is not clamped — it takes longer to draw and visibly flickers, which is what the real instrument does.",
    },
    maxStep: {
      type: "number",
      label: "Max step",
      default: 0.05,
      min: 0,
      max: 1,
      range: "soft",
      step: 0.005,
      description:
        "Longest allowed flight between samples, in field units (full deflection = 2). 0 turns resampling off — long lines then draw bright at the ends and dim in the middle, the ballistic artifact this stage exists to fix.",
    },
    holdMin: {
      type: "number",
      label: "Corner hold min",
      default: 0,
      min: 0,
      max: 32,
      range: "bounded",
      step: 1,
      description: "Extra samples at a straight-through vertex. TD's mincornerhold.",
    },
    holdMax: {
      type: "number",
      label: "Corner hold max",
      default: 8,
      min: 0,
      max: 32,
      range: "bounded",
      step: 1,
      description:
        "Extra samples at a full reversal, scaled linearly by angle steepness between the two (TD's maxcornerhold). 0 on both is the scope: an inertialess beam never dwells.",
    },
    closed: {
      type: "boolean",
      label: "Closed",
      default: true,
      description:
        "Closed joins the last point back to the first. Open treats the ends as full reversals — the beam turns around there, and dwells accordingly.",
    },
    color: {
      type: "color",
      label: "Color",
      default: [1, 1, 1, 1],
      space: "display",
      description: "The beam's colour, applied to every lit sample.",
    },
    slots: {
      type: "number",
      label: "Slots per point",
      default: 16,
      min: 2,
      max: 64,
      range: "bounded",
      step: 1,
      compileTime: true,
      description:
        "Capacity ceiling: how many planned samples one input point may expand into (its vertex, its corner dwell, its segment's subdivisions). Compile-time — it sizes the output buffers.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const points = inputs["points"];
    if (points === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
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

    const slots = Math.max(2, Math.min(64, Math.round(readNumber(parameters, "slots", 16))));
    const capacity = upstream.capacity;
    const outCapacity = capacity * slots;
    const blocks = Math.ceil(capacity / LASER_SCAN_WORKGROUP);
    const color = readColor(parameters, "color", [1, 1, 1, 1]);

    const planUniforms = {
      count: capacity,
      closed: readFlag(parameters, "closed", true),
      pps: Math.max(1, readNumber(parameters, "pps", 30000)),
      maxStep: Math.max(0, readNumber(parameters, "maxStep", 0.05)),
      holdMin: Math.max(0, readNumber(parameters, "holdMin", 0)),
      holdMax: Math.max(0, readNumber(parameters, "holdMax", 8)),
      colorR: color[0] ?? 1,
      colorG: color[1] ?? 1,
      colorB: color[2] ?? 1,
      colorA: color[3] ?? 1,
    };

    const scratch = (key: string): string => `scratch:${nodeId}:${key}`;

    /* T1076: position/tint/meta are regions of ONE packed pair. `use-laser-bridge` reads
       the stream back out of it by the same offsets, off the edge payload. */
    const storage = packedPointStorage(nodeId, PLAN_ATTRIBUTES, outCapacity, "write");
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

    const count: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:laser:count:${slots}`,
      shader: laserCountWgsl(slots),
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [
        attributeBinding("in_position", position),
        { binding: "counts", resourceId: scratch("counts") },
      ],
      uniforms: planUniforms,
      uniformBinding: "params",
      nodeId,
    };

    const scanLocal: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:laser:scan`,
      shader: laserScanLocalWgsl(),
      entryPoint: "main",
      workgroups: [blocks, 1, 1],
      buffers: [
        { binding: "counts", resourceId: scratch("counts") },
        { binding: "scanned", resourceId: scratch("scanned") },
        { binding: "blockSums", resourceId: scratch("blockSums") },
      ],
      uniforms: { count: capacity },
      uniformBinding: "params",
      nodeId,
    };

    const scanBlocks: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:laser:blocks`,
      shader: laserScanBlocksWgsl(),
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [
        { binding: "blockSums", resourceId: scratch("blockSums") },
        { binding: "total", resourceId: scratch("total") },
      ],
      uniforms: { count: capacity },
      uniformBinding: "params",
      nodeId,
    };

    const emit: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:laser:emit:${slots}`,
      shader: laserEmitWgsl(slots),
      entryPoint: "main",
      workgroups: [Math.ceil(outCapacity / 64), 1, 1],
      buffers: [
        attributeBinding("in_position", position),
        { binding: "counts", resourceId: scratch("counts") },
        { binding: "scanned", resourceId: scratch("scanned") },
        { binding: "blockSums", resourceId: scratch("blockSums") },
        { binding: "total", resourceId: scratch("total") },
        // `out_position` / `out_tint` are LASER_STREAM_BINDINGS — the pump finds the
        // planned stream's regions by these names (T1076).
        ...PLAN_ATTRIBUTES.map((attribute) =>
          attributeBinding(`out_${attribute.name}`, storage.pairs[attribute.name] as PointsetAttributeRef),
        ),
      ],
      uniforms: planUniforms,
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [count, scanLocal, scanBlocks, emit],
      scratch: [
        { key: "counts", kind: "buffer", stride: 4, capacity },
        { key: "scanned", kind: "buffer", stride: 4, capacity },
        { key: "blockSums", kind: "buffer", stride: 4, capacity: blocks },
        { key: "total", kind: "buffer", stride: 4, capacity: 1 },
        storage.scratch,
      ],
      pointsets: {
        out: {
          pairs: storage.pairs,
          capacity: outCapacity,
          // The plan is a sample stream, not a lattice; parked tail slots make any
          // stronger connectivity claim false.
          topology: "points",
        },
      },
    };
  },
};
