import { describe, expect, it } from "vitest";
import { readPointAttribute } from "../../../nodes/definitions/test-support.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T472 — `ctx.dim` reaches a real kernel, and it is the EDGE's grid (B85, §V349).
 *
 * The bug this file closes is not "the kernel cannot see the grid" — that one refuses at
 * compile and is loud. It is B85's: E20 hard-coded `64u` twice inside its WGSL while
 * `cols: 64` sat in two node parameters, so the visible knob LIED. Nothing was red; the
 * picture simply became a different, still-plausible picture the moment anyone turned it.
 *
 * §V220 is why this test builds a GRAPH rather than calling codegen with a `dim` in hand:
 * a test that supplies the wiring cannot observe whether the product supplies it. Nothing
 * below hands the kernel a dimension. `pointGrid` publishes `grid:8x4` on its edge, the
 * compiler resolves the edge, `pointKernel` reads the topology off it, and the numbers
 * that come back out of the GPU are the only evidence that the path is joined.
 *
 * §V361 is the second half, and the one that would have caught B85 itself: the SAME
 * kernel text is compiled against two different grids, and the readback must differ.
 * A kernel with `64u` typed into it passes the first assertion and fails this one — which
 * is exactly what "turning the knob silently breaks the kernel" means, made red.
 *
 * Exactness is free here (§V147/§V397): cols, rows and cell indices are small whole
 * numbers, so every f32 that comes back is compared for EQUALITY. There is no tolerance
 * for an off-by-one, a transposed i/j, or a stale grid to hide inside.
 */

const PROBE_SCHEMA = [
  { name: "position", type: "vec3f" as const, semantic: "position" as const, default: [0, 0, 0] },
  { name: "probe", type: "vec4f" as const, default: [0, 0, 0, 0] },
];
const ATTRIBUTES = JSON.stringify(PROBE_SCHEMA);

/**
 * The whole of `ctx.dim`, verbatim, into a per-point attribute. Note what is NOT here:
 * no dimension is written anywhere in this string. That is the property under test.
 */
const DIM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(f32(ctx.dim.cols), f32(ctx.dim.rows), f32(ctx.dim.i), f32(ctx.dim.j));
  return q;
}`;

/** A kernel that never names the grid — the §V309 control. */
const PLAIN_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.probe = vec4f(f32(ctx.index), 0.0, 0.0, 0.0);
  return q;
}`;

const SETTINGS = {
  outputResolution: { width: 16, height: 16 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const CAPABILITIES = {
  tier: "B" as const,
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"] as const,
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** grid → kernel → sprites → out. The kernel is a T401 PROCESSOR; the grid is the source. */
function gridGraph(options: { cols: number; rows: number; kernel: string; wireGrid?: boolean }) {
  const count = options.cols * options.rows;
  const wireGrid = options.wireGrid !== false;
  return {
    revision: 1,
    nodes: {
      sheet: {
        id: "sheet",
        type: "pointGrid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { count, cols: options.cols, rows: options.rows },
      },
      sim: {
        id: "sim",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { capacity: count, seed: 7, kernel: options.kernel, attributes: ATTRIBUTES },
      },
      sprites: {
        id: "sprites",
        type: "renderPoints",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { count, sizePixels: 2 },
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      ...(wireGrid
        ? { e0: { id: "e0", source: { nodeId: "sheet", portId: "out" }, target: { nodeId: "sim", portId: "in" } } }
        : {}),
      e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "sprites", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "sprites", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function compile(graph: ReturnType<typeof gridGraph>) {
  return compileGraph({
    graph: graph as never,
    settings: SETTINGS,
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: CAPABILITIES,
  });
}

/** Runs one frame and returns the `probe` attribute the kernel wrote, per slot. */
async function runProbe(graph: ReturnType<typeof gridGraph>): Promise<ReadonlyArray<ReadonlyArray<number>>> {
  const plan = compile(graph);
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
      resolution: [16, 16],
    });
    expect(errors).toEqual([]);
    /* T1076: `probe` is a REGION of the kernel's packed buffer — the schema puts it
       after `position`, so a read from byte 0 would hand back coordinates. */
    const raw = (
      await readPointAttribute(
        backend.readBuffer,
        "sim",
        PROBE_SCHEMA,
        graph.nodes.sim.parameters.capacity,
        "probe",
      )
    ).floats;
    const slots: number[][] = [];
    for (let slot = 0; slot * 4 + 3 < raw.length; slot += 1) {
      slots.push([raw[slot * 4] as number, raw[slot * 4 + 1] as number, raw[slot * 4 + 2] as number, raw[slot * 4 + 3] as number]);
    }
    return slots;
  } finally {
    backend.dispose();
  }
}

describe("ctx.dim on Dawn — the grid comes off the EDGE (T472, B85)", () => {
  it("hands every point the publisher's cols and rows, and its own cell", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const slots = await runProbe(gridGraph({ cols: 8, rows: 4, kernel: DIM_KERNEL }));
    expect(slots).toHaveLength(32);
    // Every slot, not just slot zero: an index mistake that fed the first thread only
    // would otherwise pass, and i/j are exactly where an off-by-one would live.
    for (let index = 0; index < 32; index += 1) {
      expect(slots[index], `slot ${index}`).toEqual([8, 4, index % 8, Math.floor(index / 8)]);
    }
  }, 60_000);

  /**
   * §V361, and B85 made red: the kernel TEXT is byte-identical across the two runs, the
   * only thing that changed is the grid node's knob. A kernel with the dimension typed
   * into it returns the first run's numbers for both.
   */
  it("FOLLOWS the knob — the same kernel over a different grid returns different numbers", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const narrow = await runProbe(gridGraph({ cols: 8, rows: 4, kernel: DIM_KERNEL }));
    const wide = await runProbe(gridGraph({ cols: 16, rows: 2, kernel: DIM_KERNEL }));
    expect(narrow).toHaveLength(32);
    expect(wide).toHaveLength(32);
    expect(wide[0]).toEqual([16, 2, 0, 0]);
    // Slot 8 is row 1 on the narrow sheet and still row 0 on the wide one — the cell, not
    // just the reported size, has to move with the claim.
    expect(narrow[8]).toEqual([8, 4, 0, 1]);
    expect(wide[8]).toEqual([16, 2, 8, 0]);
    expect(wide).not.toEqual(narrow);
  }, 60_000);

  /**
   * §V309, checked where it costs something: the shipped point graph. The kernel here
   * runs over a grid — the edge is OFFERING a dimension — and must still emit the text it
   * emitted before T472 existed, or every saved point graph recompiles once for a member
   * none of them reads.
   */
  it("a kernel that does not name the grid emits neither the struct nor the member", () => {
    const plan = compile(gridGraph({ cols: 8, rows: 4, kernel: PLAIN_KERNEL }));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const kernelPass = plan.passes.find((pass) => pass.kind === "dispatch" && pass.nodeId === "sim") as {
      shader: string;
      uniforms: Record<string, unknown>;
    };
    expect(kernelPass.shader).not.toContain("PointDim");
    expect(kernelPass.shader).not.toContain("dim");
    expect(kernelPass.shader).toContain(
      "  let ctx = PointCtx(index, kernelFrame.count, kernelFrame.timeSeconds, kernelFrame.deltaSeconds, kernelFrame.frameIndex);",
    );
    // The grid is compile-time, so it must not have appeared in the uniform block either
    // — a member with no value there reads zero in silence (the `usesPointer` hazard).
    expect(Object.keys(kernelPass.uniforms).sort()).toEqual([
      "count",
      "deltaSeconds",
      "frameIndex",
      "seed",
      "timeSeconds",
    ]);
  });

  /**
   * §V288: a kernel asking for a grid that is not there is REFUSED BY NAME. Handing it
   * zeros would divide by zero and stack every point in cell (0, 0) — a picture, and a
   * plausible one, which is the failure mode this codebase refuses on principle.
   */
  it("refuses by name when the kernel is a source with no grid upstream", () => {
    const plan = compile(gridGraph({ cols: 8, rows: 4, kernel: DIM_KERNEL, wireGrid: false }));
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    const message = errors.map((d) => d.message).join(" ");
    expect(message).toContain("ctx.dim");
    expect(message).toContain("no grid topology");
    expect(message).toMatch(/Point Grid|Point Topology/);
  });
});
