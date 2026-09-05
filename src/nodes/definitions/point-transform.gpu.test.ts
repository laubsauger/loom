import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { pointStorageId } from "./point-storage.ts";

/**
 * Transform (T1205) on a real device, asserted on READ-BACK POSITIONS and on rendered
 * pixels — never on a uniform, because "the uniform holds 2.0" is also true of a build
 * that holds 2.0 and does nothing with it (§B132's lesson, and §B132 is precisely the
 * fault the owner walked into on the neighbouring parameter).
 *
 * ## The fixture is arithmetically exact, on purpose (§V147)
 *
 * A 4×4 lattice authored by a kernel at quarter-unit spacing about (5, 3, 2). Every
 * coordinate, every partial sum of the tree reduction, the total (80, 48, 32) and the
 * quotients (5, 3, 2) are exactly representable in f32, so there is no band to hide in:
 * the centroid is 5 or the test fails. A fixture centred on the ORIGIN would have been the
 * plausible-wrong one — it makes "pivot at the centroid" and "pivot at the origin"
 * indistinguishable, which is the single most likely way to get this node wrong.
 *
 * ## The three claims, in the order they answer the question
 *
 * 1. TWICE THE EXTENT, THE SAME CENTROID. Exact on both halves. Scaling about the origin
 *    would also double the extent — and move the cloud, which is the thing that makes it
 *    useless for "fill more of the screen". The second half is what separates them, and it
 *    is asserted as a MEAN COMPUTED IN JS OVER THE READ-BACK POINTS, independently of the
 *    GPU reduction, so the reduction cannot certify itself.
 * 2. PER-POINT SIZE IS UNTOUCHED. A one-point cloud scaled 64× about its own centroid does
 *    not move (the point IS the pivot), so the frame must come back BIT-IDENTICAL to the
 *    unscaled render. If `scale` leaked into the billboard the way `geometry.scale` does,
 *    64× would fill the frame. The control renders `geometry.scale` doubled instead and
 *    shows the picture the owner actually got.
 * 3. PARKED POINTS ARE NOT MEMBERS AND NOT TRANSFORMED. A range filter upstream parks half
 *    the cloud; the centroid must be the mean of the SURVIVORS (5.5, 3, 2 — again exact),
 *    and the parked slots must read back at the park spot even under a translate that
 *    would otherwise have dragged them into shot.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SIZE = 64;

const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
} as never;

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: `${id}1` }) as never;

const edge = (id: string, source: [string, string], target: [string, string]) => ({
  id,
  source: { nodeId: source[0], portId: source[1] },
  target: { nodeId: target[0], portId: target[1] },
});

const POSITION_ONLY = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);

/**
 * A 4×4 lattice at quarter-unit spacing about (5, 3, 2). Deliberately NOT about the origin:
 * see the file docblock. Every value below is exact in f32.
 */
const LATTICE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let col = f32(ctx.index % 4u);
  let row = f32(ctx.index / 4u);
  q.position = vec3f(5.0 + (col - 1.5) * 0.5, 3.0 + (row - 1.5) * 0.5, 2.0);
  return q;
}`;

const CENTROID = [5, 3, 2] as const;
const HALF_EXTENT = 0.75; // (3 - 0) * 0.5 / 2 — the lattice spans 1.5 on x and on y.
const COUNT = 16;
const PARKED_Z = -1.0e6;

/** The buffer the node's finalize pass writes: `vec4f(centroid.xyz, memberCount)`. */
const centroidBuffer = (nodeId: string): string => `scratch:${nodeId}:centroid`;

interface Rendered {
  readonly buffers: Record<string, Float32Array>;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly rowStride: number;
}

async function render(graph: GraphDocument, buffers: ReadonlyArray<string>): Promise<Rendered> {
  // Required, never skipped: skipping turns the one test that can see the fault into a
  // green tick on every machine without a GPU.
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    expect(errors).toEqual([]);
    const read: Record<string, Float32Array> = {};
    for (const id of buffers) read[id] = new Float32Array(await backend.readBuffer(id));
    /* `plan.outputs` carries the point-set ports too, and a pointset is not an image —
       the frame is the one the `output` node published. */
    const frame = plan.outputs.find((output) => output.nodeId === "out") ?? plan.outputs[0];
    const image = await backend.readOutput(frame?.resourceId ?? "");
    return {
      buffers: read,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      rowStride: image.rowStride,
    };
  } finally {
    backend.dispose();
  }
}

/** vec3f strides at 16 bytes, so component `c` of point `i` sits at `i * 4 + c`. */
const at = (positions: Float32Array, point: number, axis: number): number => positions[point * 4 + axis] as number;

const AXES = [0, 1, 2] as const;

function meanOf(positions: Float32Array, count: number): [number, number, number] {
  const sums = AXES.map((axis) => {
    let total = 0;
    for (let point = 0; point < count; point += 1) total += at(positions, point, axis);
    return total / count;
  });
  return [sums[0] as number, sums[1] as number, sums[2] as number];
}

function extentOf(positions: Float32Array, count: number): [number, number, number] {
  const spans = AXES.map((axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let point = 0; point < count; point += 1) {
      const value = at(positions, point, axis);
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    return hi - lo;
  });
  return [spans[0] as number, spans[1] as number, spans[2] as number];
}

/** The kernel-and-transform half of every graph below. */
function cloud(transform: Record<string, unknown>, extra: Record<string, GraphNode> = {}, count = COUNT) {
  return {
    seed: node("seed", "pointGrid", { cols: 4, rows: Math.max(1, count / 4), count }),
    cloud: node("cloud", "pointKernel", { capacity: count, attributes: POSITION_ONLY, kernel: LATTICE_KERNEL }),
    move: node("move", "pointTransform", transform),
    ...extra,
  };
}

function bufferGraph(transform: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      ...cloud(transform),
      draw: node("draw", "renderPoints", { count: COUNT, sizePixels: 2 }),
      out: node("out", "output", {}),
    },
    edges: {
      e0: edge("e0", ["seed", "out"], ["cloud", "in"]),
      e1: edge("e1", ["cloud", "out"], ["move", "points"]),
      e2: edge("e2", ["move", "out"], ["draw", "points"]),
      e3: edge("e3", ["draw", "out"], ["out", "input"]),
    },
    groups: {},
  } as never;
}

describe("pointTransform on Dawn (T1205)", () => {
  it("scaled 2x about the centroid: twice the extent, the SAME centroid, exactly", async () => {
    const read = await render(bufferGraph({ pivot: "centroid", scale: [2, 2, 2] }), [
      pointStorageId("cloud"),
      pointStorageId("move"),
      centroidBuffer("move"),
    ]);
    const input = read.buffers[pointStorageId("cloud")] as Float32Array;
    const output = read.buffers[pointStorageId("move")] as Float32Array;
    const measured = read.buffers[centroidBuffer("move")] as Float32Array;

    // The fixture is what it says it is, before anything is claimed about the transform.
    expect(meanOf(input, COUNT)).toEqual([...CENTROID]);
    expect(extentOf(input, COUNT)).toEqual([HALF_EXTENT * 2, HALF_EXTENT * 2, 0]);

    // The GPU's own reduction, exact — and the member count beside it, so a divisor that
    // counted the padding lanes of the 256-wide workgroup would show up here as 256.
    expect([measured[0], measured[1], measured[2], measured[3]]).toEqual([...CENTROID, COUNT]);

    // ⚑ THE TWO HALVES OF THE ANSWER. Twice the extent…
    expect(extentOf(output, COUNT)).toEqual([HALF_EXTENT * 4, HALF_EXTENT * 4, 0]);
    // …and the centroid has not moved, computed in JS over the read-back points rather
    // than read out of the buffer the node itself wrote. Scaling about the ORIGIN would
    // pass the extent assertion and land this one on (10, 6, 4).
    expect(meanOf(output, COUNT)).toEqual([...CENTROID]);

    // Point by point, derived from the read-back input the way the shader computes it:
    // (p - c) is one f32 subtract, x2 is exact, + c is one f32 add. Identity rotation
    // contributes 1.0 and 0.0 exactly, and the zero translate adds nothing.
    for (let point = 0; point < COUNT; point += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const centre = CENTROID[axis] as number;
        const expected = Math.fround(centre + Math.fround(Math.fround(at(input, point, axis) - centre) * 2));
        expect(at(output, point, axis), `point ${point} axis ${axis}`).toBe(expected);
      }
    }
  }, 240_000);

  it("the pivot is the whole feature: origin MOVES the cloud, centroid does not", async () => {
    const buffers = [pointStorageId("cloud"), pointStorageId("move")];
    const centroid = await render(bufferGraph({ pivot: "centroid", scale: [2, 2, 2] }), buffers);
    const origin = await render(bufferGraph({ pivot: "origin", scale: [2, 2, 2] }), buffers);
    const point = await render(
      bufferGraph({ pivot: "point", pivotPoint: [5, 3, 2], scale: [2, 2, 2] }),
      buffers,
    );

    const centroidOut = centroid.buffers[pointStorageId("move")] as Float32Array;
    const originOut = origin.buffers[pointStorageId("move")] as Float32Array;
    const pointOut = point.buffers[pointStorageId("move")] as Float32Array;

    // Same growth on all three — the extent claim cannot tell the pivots apart…
    for (const out of [centroidOut, originOut, pointOut]) {
      expect(extentOf(out, COUNT)).toEqual([HALF_EXTENT * 4, HALF_EXTENT * 4, 0]);
    }
    // …and the centroid is the only thing that does. Origin scaling doubles the cloud's
    // DISTANCE FROM THE ORIGIN too, which is the "it grew and flew off frame" the owner
    // would have got from an object matrix with no pivot.
    expect(meanOf(centroidOut, COUNT)).toEqual([...CENTROID]);
    expect(meanOf(originOut, COUNT)).toEqual([10, 6, 4]);

    // An explicit pivot ON the centroid is the same transform by a different route — bit
    // for bit, which is also the reduction agreeing with an authored number.
    expect(Array.from(pointOut)).toEqual(Array.from(centroidOut));
  }, 240_000);

  it("parks stay parked, and a parked point is not a member of the centroid", async () => {
    /* `pointRange` on x keeps the two right-hand columns (x = 5.25 and 5.75, eight
       points) and parks the rest. The survivors' mean is (5.5, 3, 2) — exact again. And
       the translate is large enough that a transformed park spot would land in front of
       the camera, which is the failure this catches: a point the author DELETED coming
       back because a later node did arithmetic on its sentinel. */
    const graph = {
      revision: 1,
      nodes: {
        ...cloud({ pivot: "centroid", scale: [2, 2, 2], translate: [0, 0, 100] }, {
          zone: node("zone", "pointRange", { attribute: "position", component: "x", from: 5.1, to: 9, mode: "inside" }),
        }),
        draw: node("draw", "renderPoints", { count: COUNT, sizePixels: 2 }),
        out: node("out", "output", {}),
      },
      edges: {
        e0: edge("e0", ["seed", "out"], ["cloud", "in"]),
        e1: edge("e1", ["cloud", "out"], ["zone", "points"]),
        e2: edge("e2", ["zone", "out"], ["move", "points"]),
        e3: edge("e3", ["move", "out"], ["draw", "points"]),
        e4: edge("e4", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;

    const read = await render(graph, [pointStorageId("zone"), pointStorageId("move"), centroidBuffer("move")]);
    const parkedIn = read.buffers[pointStorageId("zone")] as Float32Array;
    const output = read.buffers[pointStorageId("move")] as Float32Array;
    const measured = read.buffers[centroidBuffer("move")] as Float32Array;

    // Eight survivors, and the centroid is theirs alone. A reduction that averaged the
    // parked slots in would read z ≈ -500 000 here, not 2.
    expect([measured[0], measured[1], measured[2], measured[3]]).toEqual([5.5, 3, 2, 8]);

    let survivors = 0;
    let parked = 0;
    for (let point = 0; point < COUNT; point += 1) {
      if (at(parkedIn, point, 2) === PARKED_Z) {
        // Untouched, including by the +100 on z that every live point received.
        expect(at(output, point, 0), `parked ${point} x`).toBe(0);
        expect(at(output, point, 1), `parked ${point} y`).toBe(0);
        expect(at(output, point, 2), `parked ${point} z`).toBe(PARKED_Z);
        parked += 1;
      } else {
        expect(at(output, point, 2), `live ${point} z`).toBe(102);
        survivors += 1;
      }
    }
    // Neither cohort may be empty, or every assertion above ran one-sided.
    expect([survivors, parked]).toEqual([8, 8]);
  }, 240_000);
});

/**
 * The claim the owner's question actually turns on, as PIXELS: this node moves points
 * apart, it does not make them bigger. `geometry.scale` is the one that makes them bigger,
 * and the third render here is that — the picture he got.
 */
describe("pointTransform does not touch per-point size (T1205, on Dawn)", () => {
  /**
   * ONE point, so it sits exactly ON its own centroid and the scale can move it nowhere.
   *
   * OFF THE ORIGIN on purpose: a point at (0,0,0) is invariant under every pivot, so the
   * bit-identity below would hold for a build that scaled about the origin instead — the
   * exact bug this fixture has to be able to see. At (0.5, 0.25, 0) a 64× origin scale
   * throws it clean out of frame and the two renders stop matching.
   */
  const SOLO_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(0.5, 0.25, 0.0);
  return q;
}`;

  function sceneGraph(options: { cloudScale: number; dotScale: number }): GraphDocument {
    return {
      revision: 1,
      nodes: {
        seed: node("seed", "pointGrid", { cols: 1, rows: 1, count: 1 }),
        cloud: node("cloud", "pointKernel", { capacity: 1, attributes: POSITION_ONLY, kernel: SOLO_KERNEL }),
        move: node("move", "pointTransform", {
          pivot: "centroid",
          scale: [options.cloudScale, options.cloudScale, options.cloudScale],
        }),
        ink: node("ink", "materialUnlit", { color: [1, 1, 1, 1] }),
        dots: node("dots", "geometry", { mode: "points", material: "ink1", scale: options.dotScale }),
        cam: node("cam", "camera", { eye: [0, 0, 4], lookAt: [0, 0, 0], ortho: true, fov: 46, near: 0.1, far: 20 }),
        shot: node("shot", "render", { scenes: "dots1", camera: "cam1", lights: "", background: [0, 0, 0, 1] }),
        out: node("out", "output", {}),
      },
      edges: {
        e0: edge("e0", ["seed", "out"], ["cloud", "in"]),
        e1: edge("e1", ["cloud", "out"], ["move", "points"]),
        e2: edge("e2", ["move", "out"], ["dots", "points"]),
        e3: edge("e3", ["shot", "out"], ["out", "input"]),
      },
      groups: {},
    } as never;
  }

  const lit = (frame: Rendered): number => {
    let count = 0;
    const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        if (view.getUint16(y * frame.rowStride + x * 8, true) !== 0) count += 1;
      }
    }
    return count;
  };

  it("scaling a one-point cloud 64x about its own centroid renders BIT-IDENTICALLY", async () => {
    const control = await render(sceneGraph({ cloudScale: 1, dotScale: 0.1 }), []);
    const scaled = await render(sceneGraph({ cloudScale: 64, dotScale: 0.1 }), []);

    /* The point IS the pivot, so `(p - pivot) * 64` is zero however large the factor: the
       transform is a no-op on this cloud, and the frame must therefore be the SAME FRAME.
       If the scale reached the billboard the way `geometry.scale` does, a 64× dot would
       cover the whole 64px frame — the loudest possible failure, and exactly the one the
       owner hit on the neighbouring parameter. */
    expect(Array.from(scaled.bytes)).toEqual(Array.from(control.bytes));
    // …and the control is lit at all, or the comparison above is two black frames.
    expect(lit(control)).toBeGreaterThan(0);

    /* THE OTHER OPERATOR, so the equality above is a statement about THIS node rather than
       about a frame that never changes: doubling `geometry.scale` doubles the billboard,
       which quadruples its area. That is the picture the owner described, kept here as the
       contrast that makes the bit-identity meaningful. */
    const fatter = await render(sceneGraph({ cloudScale: 1, dotScale: 0.2 }), []);
    expect(lit(fatter)).toBeGreaterThan(lit(control) * 3);
  }, 240_000);
});
