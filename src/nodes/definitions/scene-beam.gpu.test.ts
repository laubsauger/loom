import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T680 — BEAM MODE: the third member of the billboard family, and the first primitive in
 * this renderer whose LONG AXIS comes from the data instead of from the camera.
 *
 * ## Why the assertion has to be pixels
 *
 * Every structural claim about this mode is also true of a beam drawn wrong. "It emits a
 * six-vertex draw and binds an endpoints buffer" is satisfied by a quad at the origin, a
 * quad pointing the wrong way, a quad of zero width, and a quad drawn along the camera's
 * right vector instead of along the segment. §V147/B15 is explicit that a test over plan
 * SHAPE is not evidence a pixel moved, and every one of those failures still renders a
 * plausible-looking picture somewhere in the frame.
 *
 * So the gate MEASURES the segment: with a beam laid across the middle of the frame from
 * x = −0.6 to x = +0.6 and the camera square on, the lit pixels have to fall between the
 * two ends and nowhere else. The controls (§V461) are the parts that would still pass if
 * the axis were wrong — columns OUTSIDE the segment must be dark, which fails the moment
 * the quad is camera-aligned rather than data-aligned, and rows well off the axis must be
 * dark, which fails the moment the width is unbounded.
 *
 * ## And the taper, measured as a DIFFERENCE
 *
 * `taper` is the parameter that keeps N beams sharing one origin from fusing into a solid
 * wedge around it, so it is load-bearing rather than decorative — E34 could not use this
 * mode without it. A single reading of "the near end is thin" proves nothing (thin
 * compared to what?), so the case below renders the SAME beam at taper 1 and taper 0 and
 * asserts the near end shrinks while the far end does not.
 */

const SIZE = 64;

const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}, label?: string): GraphNode {
  return {
    id,
    type,
    definitionVersion: registry.get(type)?.version ?? 1,
    position: { x: 0, y: 0 },
    parameters,
    ...(label === undefined ? {} : { label }),
  };
}

/* ONE point carrying two positions. The kernel is the whole fixture: `here` is the beam's
   near end and `there` its far end, both hard-coded, so nothing about the picture depends
   on a generator's layout. The beam lies along world x at y = 0, z = 0. */
const BEAM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tip", type: "vec3f", default: [0, 0, 0] },
]);
const BEAM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(-0.6, 0.0, 0.0);
  q.tip = vec3f(0.6, 0.0, 0.0);
  return q;
}`;

interface BeamCase {
  /** Attribute the geometry names as the far end. "tip" is the one the kernel writes. */
  readonly endpoint?: string;
  readonly scale?: number;
  readonly taper?: number;
  readonly material?: "materialUnlit" | "materialPhong";
  readonly mode?: "beam" | "points" | "instances";
}

function beamGraph(options: BeamCase = {}): GraphDocument {
  const mode = options.mode ?? "beam";
  const material = options.material ?? "materialUnlit";
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("seed", "pointGrid", { cols: 1, rows: 1, count: 1 }, "seed1"),
        node("place", "pointKernel", { capacity: 1, attributes: BEAM_ATTRIBUTES, kernel: BEAM_KERNEL }, "place1"),
        node("chalk", material, { color: [1, 1, 1, 1] }, "chalk1"),
        node(
          "bar",
          "geometry",
          {
            mode,
            endpoint: options.endpoint ?? "tip",
            scale: options.scale ?? 0.08,
            taper: options.taper ?? 1,
            material: "chalk1",
          },
          "bar1",
        ),
        /* Square on, far enough that the 1.2-unit beam sits well inside the frame, and
           orthographic so a pixel column maps to a world x with no perspective to argue
           about. */
        node("cam", "camera", { eye: [0, 0, 4], lookAt: [0, 0, 0], ortho: true, fov: 46, near: 0.1, far: 20 }, "cam1"),
        node("shot", "render", { scenes: "bar1", camera: "cam1", lights: "", background: [0, 0, 0, 1] }, "shot1"),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "place", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "place", portId: "out" }, target: { nodeId: "bar", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function compile(graph: GraphDocument) {
  return compileGraph({ graph, settings, registry, capabilities });
}

type Pass = { id: string; vertexCount?: number; buffers?: ReadonlyArray<{ binding: string }> };

/** Luma per pixel of the rendered frame, row-major, 0..1-ish (rgba16float, decoded). */
async function renderLuma(graph: GraphDocument): Promise<Float32Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    const image = await backend.readOutput(plan.outputs[0]?.resourceId ?? "");
    const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    const out = new Float32Array(image.width * image.height);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        out[y * image.width + x] = halfFloat(view.getUint16(y * image.rowStride + x * 8, true));
      }
    }
    return out;
  } finally {
    backend.dispose();
  }
}

/** rgba16float is half-precision; a readback is bytes, and this is how they mean anything. */
function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

/** Lit pixels in one column, and in one row-band. Anything above black counts. */
const litInColumn = (luma: Float32Array, x: number): number => {
  let count = 0;
  for (let y = 0; y < SIZE; y += 1) if ((luma[y * SIZE + x] as number) > 0.05) count += 1;
  return count;
};

describe("T680: beam mode draws a segment BETWEEN two positions, on a real device", () => {
  it("lights the span from one end to the other and nothing outside it", async () => {
    // Required, never skipped: skipping turns the one test that can see a wrong axis into
    // a green tick on every machine without a GPU.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const luma = await renderLuma(beamGraph());

    /* The beam spans world x ∈ [−0.6, 0.6]. The ortho camera's half-width here is 1.0 at
       a square aspect, so those ends land near columns 12.8 and 51.2 of 64. Sample well
       inside and well outside, so a few pixels of edge coverage cannot decide the test. */
    expect(litInColumn(luma, 32)).toBeGreaterThan(0); // dead centre: on the beam
    expect(litInColumn(luma, 20)).toBeGreaterThan(0);
    expect(litInColumn(luma, 44)).toBeGreaterThan(0);

    /* THE CONTROL §V461 asks for, and the one that fails if the quad expanded along the
       camera's right/up like a billboard: a billboard centred on `position` would light
       column 6 (world x ≈ −0.8) and leave column 44 dark. */
    expect(litInColumn(luma, 4)).toBe(0);
    expect(litInColumn(luma, 60)).toBe(0);

    /* And the width is BOUNDED — a beam is a ribbon, not a half-plane. Scale 0.08 is a
       half-width, so roughly 5 of 64 rows; anything near the full column means the side
       vector came out unnormalised or zero. */
    expect(litInColumn(luma, 32)).toBeLessThan(SIZE / 3);
  }, 60_000);

  it("taper pinches the ORIGIN end and leaves the far end alone", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // Wide enough that a taper has room to show as whole pixels rather than as coverage.
    const parallel = await renderLuma(beamGraph({ scale: 0.28, taper: 1 }));
    const tapered = await renderLuma(beamGraph({ scale: 0.28, taper: 0 }));

    /* Column 20 sits a fifth of the way along the beam from the ORIGIN end, column 44
       four fifths of the way toward the FAR end, so the width the taper leaves is
       roughly t itself. Asserted as a RATIO against the parallel-sided render at the
       SAME column, which is the only comparison that isolates the taper from the width
       and from where the ends happen to land in pixels. Measured: 0.19 near, 0.78 far. */
    const nearRatio = litInColumn(tapered, 20) / litInColumn(parallel, 20);
    const farRatio = litInColumn(tapered, 44) / litInColumn(parallel, 44);
    expect(nearRatio).toBeLessThan(0.45);
    expect(farRatio).toBeGreaterThan(0.65);
    // A taper is not a delete: the near end still draws something.
    expect(litInColumn(tapered, 20)).toBeGreaterThan(0);
    // And the shape is a WEDGE, which is the whole point: narrow near, wide far.
    expect(litInColumn(tapered, 20)).toBeLessThan(litInColumn(tapered, 44));
  }, 60_000);
});

describe("T680: what the beam refuses, and what it does not cast", () => {
  it("refuses BY NAME when no endpoint attribute is named", () => {
    const plan = compile(beamGraph({ endpoint: "" }));
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toContain("node.scene.endpoint");
    expect(errors[0]?.message).toMatch(/needs an Endpoint attribute/);
  });

  it("refuses BY NAME when the named attribute is not on the edge", () => {
    const plan = compile(beamGraph({ endpoint: "nowhere" }));
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toContain("node.scene.endpoint");
    expect(errors[0]?.message).toMatch(/carries no attribute "nowhere"/);
  });

  it("refuses BY NAME when the named attribute is the wrong type", () => {
    // `position` is vec3f and would pass; the kernel's own schema has nothing else to
    // offer, so point at a scalar the Ray family publishes instead.
    const graph = beamGraph({ endpoint: "wrong" });
    const place = graph.nodes["place"] as GraphNode;
    graph.nodes["place"] = {
      ...place,
      parameters: {
        ...place.parameters,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "wrong", type: "f32", default: [0] },
        ]),
        kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(-0.6, 0.0, 0.0);
  q.wrong = 1.0;
  return q;
}`,
      },
    };
    const errors = compile(graph).diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => d.code)).toContain("node.scene.endpoint");
    expect(errors[0]?.message).toMatch(/is f32, and a beam's far end must be vec3f/);
  });

  it("casts NO shadow even under a LIT material — §V610's argument, extended", () => {
    /* The material is lit, so §V617's material skip cannot be what does this: only the
       MODE skip can. Without that distinction the case passes for the wrong reason. */
    const graph = beamGraph({ material: "materialPhong" });
    const shot = graph.nodes["shot"] as GraphNode;
    graph.nodes["sun"] = node("sun", "light", { kind: "directional", direction: [0.3, -0.8, -0.4], shadows: true, shadowExtent: 3 }, "sun1");
    graph.nodes["shot"] = { ...shot, parameters: { ...shot.parameters, lights: "sun1" } };
    const plan = compile(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const shadowDraws = (plan.passes as unknown as Pass[])
      .map((pass) => pass.id)
      .filter((id) => id.includes(":shadow:") && !id.endsWith(":clear"));
    expect(shadowDraws).toEqual([]);
  });

  it("draws six vertices and binds the endpoint buffer", () => {
    const plan = compile(beamGraph());
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = (plan.passes as unknown as Pass[]).find((pass) => pass.id.includes(":scene:"));
    expect(draw?.vertexCount).toBe(6);
    expect(draw?.buffers?.map((b) => b.binding)).toContain("endpoints");
  });
});

/**
 * The bug T680 fell over while wiring the beam's width: `scale` reached the payload for
 * INSTANCES only, so a points-mode billboard fell through to the draw's `?? { scale:
 * 0.05 }` fallback and the Scale parameter — which declares itself ACTIVE for points —
 * did nothing whatsoever. Measured on E34-Lidar while prototyping: 0.005 and 0.30
 * rendered BYTE-IDENTICAL. §V465's fault, and worse than the case that invariant names,
 * because nothing overrode the value; it was dropped on the floor.
 *
 * Pinned as a PAIR, because "the uniform holds 0.3" is also true of a build that always
 * holds 0.3: two different scales must produce two different uniforms, and both must
 * differ from the fallback that used to swallow them.
 */
describe("T680 (B-fix): Scale reaches every per-point mode, not just instances", () => {
  const scaleOf = (mode: "points" | "beam" | "instances", scale: number): number => {
    const plan = compile(beamGraph({ mode, scale }));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const draw = (plan.passes as unknown as { id: string; uniforms?: { instance?: readonly number[] } }[]).find(
      (pass) => pass.id.includes(":scene:"),
    );
    return draw?.uniforms?.instance?.[0] ?? Number.NaN;
  };

  it("points mode carries the authored scale, and two values differ", () => {
    expect(scaleOf("points", 0.3)).toBeCloseTo(0.3);
    expect(scaleOf("points", 0.005)).toBeCloseTo(0.005);
    // The value that used to swallow both.
    expect(scaleOf("points", 0.3)).not.toBeCloseTo(0.05);
  });

  it("beam and instances carry it too", () => {
    expect(scaleOf("beam", 0.3)).toBeCloseTo(0.3);
    expect(scaleOf("instances", 0.3)).toBeCloseTo(0.3);
  });
});
