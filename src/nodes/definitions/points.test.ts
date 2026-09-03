import { describe, expect, it } from "vitest";

import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import type { LogicalExecutionPlan } from "../../domain/types/backend.ts";
import {
  DEFAULT_POINT_ATTRIBUTES,
  pointKernelNode,
  pointSetInfoFor,
  renderPointsNode,
} from "./points.ts";
import { pointStorageId } from "./point-storage.ts";
import { packAttributes } from "../../points/packing.ts";
import { compileContext, fixturePairs } from "./test-support.ts";

/** T1076: the u32 words one half of a default-schema point buffer occupies. */
function packedWords(capacity: number): number {
  const layout = packAttributes(DEFAULT_POINT_ATTRIBUTES, capacity);
  if (!layout.ok) throw new Error(layout.errors.join("; "));
  return layout.bytes / 4;
}

/**
 * The point family at the fixture level (T121, T122): manifests, emitted passes, the
 * producer/consumer id contract, and the whole emitted output accepted by the backend's
 * own plan reader. The pixels-on-Dawn half lives in
 * `src/runtime/backend/vgpu/point-nodes.gpu.test.ts`.
 */

describe("pointKernel — manifest and emission (T121)", () => {
  it("declares determinism honestly and carries the kernel contract version (§V46, §V77)", () => {
    expect(pointKernelNode.stateful).toEqual({
      reset: true,
      deterministicReplay: true,
      checkpoint: false,
      randomAccess: false,
    });
    expect(pointKernelNode.contractVersion).toBe(1);
    expect(pointKernelNode.outputs[0]?.type.kind).toBe("pointset");
  });

  it("emits one dispatch whose buffers follow the pair-id contract with read/write halves", () => {
    const result = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 1000, seed: 3 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toHaveLength(1);
    const pass = result.passes[0] as {
      kind: string;
      buffers: Array<{ binding: string; resourceId: string; half: string }>;
      uniforms: Record<string, number>;
      uniformBinding: string;
    };
    expect(pass.kind).toBe("dispatch");
    expect(pass.uniformBinding).toBe("kernelFrame");
    expect(pass.uniforms["count"]).toBe(1000);
    expect(pass.uniforms["seed"]).toBe(3);

    /* T1076: TWO storage bindings for the whole schema — the node's packed read half
       (pre-frame values) and its write half (results) — one identity, swapped by the
       compiler after all consumers (§V22, T143 carry applies). Before packing this was
       one binding per attribute per direction, so three attributes cost six and a fifth
       attribute failed the pipeline in silence. */
    expect(pass.buffers.map((binding) => `${binding.resourceId}:${binding.half}`)).toEqual([
      `${pointStorageId("sim")}:read`,
      `${pointStorageId("sim")}:write`,
    ]);
  });

  it("rejects a broken attributes schema or kernel with named diagnostics", () => {
    const badSchema = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { attributes: "[{\"name\":\"3x\"}]" } }),
    );
    expect(badSchema.passes).toEqual([]);
    expect(badSchema.diagnostics?.[0]?.code).toBe("node.points.attributes");

    const badKernel = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { kernel: "fn nope() {}" } }),
    );
    expect(badKernel.passes).toEqual([]);
    expect(badKernel.diagnostics?.[0]?.code).toBe("node.points.kernel");
  });
});

describe("renderPoints — manifest and emission (T122)", () => {
  it("requires a position attribute on its pointset input (§V13)", () => {
    const input = renderPointsNode.inputs[0];
    expect(input?.type.kind).toBe("pointset");
    if (input?.type.kind === "pointset") {
      expect(input.type.requires).toEqual([{ name: "position", type: "vec3f" }]);
    }
  });

  it("binds the producer's position REGION off the edge payload (T296, T1076)", () => {
    const result = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        /* T1076: the payload, not a derived id. Attributes no longer have buffers of
           their own, so the pre-T296 `scratch:<node>:position` convention names nothing;
           a consumer that tried it is refused by name below. */
        pointsets: {
          points: {
            pairs: fixturePairs(
              "sim",
              [
                { name: "velocity", type: "vec3f" },
                { name: "position", type: "vec3f" },
              ],
              512,
            ),
            capacity: 512,
          },
        },
        parameters: { count: 512, sizePixels: 8, blend: "alpha", accumulate: true },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as {
      kind: string;
      buffers: Array<{ resourceId: string; half: string; offset: number; bytes: number }>;
      blend: string;
      clear: boolean;
      instances: number;
    };
    expect(pass.kind).toBe("draw");
    expect(pass.buffers[0]?.resourceId).toBe(pointStorageId("sim"));
    // T296/§V168: consumers read the WRITE half — THIS frame's positions, in plan order.
    expect(pass.buffers[0]?.half).toBe("write");
    /* The OFFSET is the load-bearing number: `velocity` is laid out first here, so a
       binding that took the buffer from byte 0 would draw velocities as positions —
       plausible, animated, and wrong. */
    expect(pass.buffers[0]?.offset).toBe(16 * 512);
    expect(pass.buffers[0]?.bytes).toBe(16 * 512);
    expect(pass.blend).toBe("alpha");
    // accumulate = the T180 trails pattern: no clear between frames.
    expect(pass.clear).toBe(false);
    expect(pass.instances).toBe(512);
  });

  it("reports a missing producer identity instead of guessing buffer ids", () => {
    const result = renderPointsNode.compile(compileContext({ nodeId: "draw", inputs: ["points"] }));
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.source");
  });
});

describe("pointKernel → renderPoints → output through the REAL compiler (T176)", () => {
  it("materializes pairs, propagates the pointset edge, swaps after all consumers", async () => {
    const { compileGraph } = await import("../../compiler/index.ts");
    const { createNodeRegistry } = await import("../registry/registry.ts");
    const { allNodeDefinitions } = await import("./index.ts");

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 512 } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 512 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 640, height: 360 },
        workingFormat: "rgba16float",
        randomSeed: 1,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });

    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

    /* T1076: ONE pair for the whole schema, materialized from the node's single scratch
       declaration, sized to the packed layout: position and velocity at 16 B, id at 4,
       each × 512 points, every region 256-aligned. */
    const pairs = plan.resources.filter((resource) => resource.kind === "bufferPair");
    expect(pairs.map((pair) => pair.id)).toEqual([pointStorageId("sim")]);
    const packed = packAttributes(DEFAULT_POINT_ATTRIBUTES, 512);
    if (!packed.ok) throw new Error(packed.errors.join("; "));
    expect(packed.regions.map((region) => region.offset)).toEqual([0, 8192, 16384]);
    const pair = pairs[0] as { stride: number; capacity: number };
    expect(pair.stride * pair.capacity).toBe(packed.bytes);
    // …and NO texture resource for the pointset marker itself.
    expect(plan.resources.some((resource) => resource.id.startsWith("points:sim"))).toBe(false);

    // The consumer found the producer through the propagated edge.
    const drawPass = plan.passes.find((pass) => pass.kind === "draw");
    expect(drawPass?.buffers?.[0]?.resourceId).toBe(pointStorageId("sim"));
    // …at the POSITION region's offset, not from byte 0 (T1076).
    expect(drawPass?.buffers?.[0]?.offset).toBe(0);
    expect(drawPass?.buffers?.[0]?.bytes).toBe(16 * 512);

    // T297 (§V197/§V22): each pair's swap comes after the LAST pass that BINDS it —
    // ownership by binder, not by reachability. Position is read by the draw, so its
    // swap must follow the draw; the attributes only the kernel touches swap right
    // after the kernel. Every swap still precedes nothing that binds its pair.
    const swaps = plan.passes
      .map((pass, index) => ({ pass, index }))
      .filter((entry) => entry.pass.kind === "swap");
    // T1076: one pair, so one swap — it was one per attribute.
    expect(swaps).toHaveLength(1);
    for (const { pass, index } of swaps) {
      const pairId = (pass as { resourceId: string }).resourceId;
      const lastBinder = plan.passes
        .map((candidate, candidateIndex) =>
          (candidate as { buffers?: Array<{ resourceId: string }> }).buffers?.some((b) => b.resourceId === pairId) === true
            ? candidateIndex
            : -1,
        )
        .reduce((a, b) => Math.max(a, b), -1);
      expect(index, `swap for ${pairId}`).toBeGreaterThan(lastBinder);
    }
    const drawIndex = plan.passes.findIndex((pass) => pass.kind === "draw");
    const positionSwapIndex = plan.passes.findIndex(
      (pass) => pass.kind === "swap" && (pass as { resourceId: string }).resourceId === pointStorageId("sim"),
    );
    expect(positionSwapIndex).toBeGreaterThan(drawIndex); // the by-binding claim, explicitly

    // The whole plan reads cleanly through the backend's own validation.
    expect(readExecutionPlan(plan).ok).toBe(true);
  });
});

describe("the emitted output is a plan the backend accepts", () => {
  it("kernel + render + pairs + swaps read cleanly end to end", () => {
    const kernel = pointKernelNode.compile(
      compileContext({ nodeId: "sim", outputs: [], parameters: { capacity: 256 } }),
    );
    const render = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        // T1076: the edge payload the kernel above publishes — the region map, not an id.
        pointsets: { points: { pairs: kernel.pointsets?.["out"]?.pairs ?? {}, capacity: 256 } },
        parameters: { count: 256 },
      }),
    );
    expect(kernel.diagnostics ?? []).toEqual([]);
    expect(render.diagnostics ?? []).toEqual([]);

    const plan: LogicalExecutionPlan = {
      resources: [
        { kind: "bufferPair", id: pointStorageId("sim"), stride: 4, capacity: packedWords(256) },
        { kind: "target", id: "target:out", size: [64, 64], format: "rgba16float" },
      ],
      passes: [
        ...kernel.passes,
        // Retarget the render pass at the declared target (the fixture's id differs).
        { ...(render.passes[0] as Record<string, unknown>), target: "target:out" },
        // The compiler owns swap placement (§V22); the assembled plan mirrors it.
        { kind: "swap" as const, id: `swap:${pointStorageId("sim")}`, resourceId: pointStorageId("sim") },
      ],
      diagnostics: [],
    };

    const read = readExecutionPlan(plan);
    expect(read.diagnostics).toEqual([]);
    expect(read.ok).toBe(true);
  });
});

describe("attribute qualifiers ride the schema end to end (T287)", () => {
  it("a qualified attribute compiles and reaches read_points intact", () => {
    const attributes = JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "id", type: "u32", semantic: "id", default: [0] },
      { name: "heading", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
    ]);
    const result = pointKernelNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: {
          attributes,
          kernel: "fn process(p: Point, ctx: PointCtx) -> Point { var q = p; q.heading = q.heading; return q; }",
        },
      }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    // The agent-facing view (T293): the qualifier is DATA a reader can act on, never
    // a magic name it has to know.
    const info = pointSetInfoFor({ type: "pointKernel", parameters: { attributes } });
    expect(info?.attributes.find((attribute) => attribute.name === "heading")?.qualifier).toBe("direction");
  });

  it("a malformed qualifier is refused with the node's own diagnostic", () => {
    const result = pointKernelNode.compile(
      compileContext({
        nodeId: "sim",
        outputs: [],
        parameters: {
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "aim", type: "f32", qualifier: "direction", default: [0] },
          ]),
        },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.attributes");
  });
});

describe("bypass on a converter is muted, not spliced (T356)", () => {
  it("a bypassed renderPoints never hands its consumer a pointset marker", async () => {
    const { compileGraph } = await import("../../compiler/index.ts");
    const { createNodeRegistry } = await import("../registry/registry.ts");
    const { allNodeDefinitions } = await import("./index.ts");
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const graph = {
      revision: 1,
      nodes: {
        sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 64 } },
        draw: {
          id: "draw",
          type: "renderPoints",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: { count: 64 },
          ui: { bypassed: true },
        },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never;
    const plan = compileGraph({
      graph,
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      } as never,
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    // The failure this pins: the splice handed Output "points:sim:out" as a texture
    // and the backend EXPLODED AT BUILD. Now: muted with the reason said out loud, no
    // marker id ever appears in a pass, and what remains downstream is the ordinary
    // missing-input story any mute produces — V9 keeps the last good plan, the
    // problems tab says why, nothing detonates.
    expect(plan.diagnostics.some((d) => d.code === "compiler/bypass-incoherent")).toBe(true);
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    expect(errors.every((d) => String(d.code).includes("input") || String(d.code).includes("missing"))).toBe(true);
    const referencesMarker = plan.passes.some((pass) =>
      JSON.stringify(pass).includes("points:sim:out"),
    );
    expect(referencesMarker).toBe(false);
  });
});

describe("sizePixels in map mode — pscale (T286)", () => {
  const edge = {
    points: {
      pairs: fixturePairs(
        "sim",
        [
          { name: "position", type: "vec3f" },
          { name: "size", type: "f32" },
          { name: "velocity", type: "vec3f" },
        ],
        128,
      ),
      capacity: 128,
      topology: "points",
    },
  };
  const mapped = (map: { attribute: string; channel?: string; port?: string }) =>
    renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        pointsets: edge,
        parameters: { count: 128 },
        parameterMaps: { sizePixels: map },
      }),
    );

  it("compiles the mapped shader interface: attribute bound, uniform GONE", () => {
    const result = mapped({ attribute: "size" });
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as {
      shader: string;
      buffers: Array<{ binding: string; resourceId: string; half?: string }>;
      uniforms: Record<string, unknown>;
    };
    expect(pass.shader).toContain("mapSizes: array<f32>");
    expect(pass.shader).not.toContain("sizePixels");
    expect(pass.uniforms).toEqual({ color: [1, 1, 1, 1] });
    /* T1076: the REGION, not a buffer of its own — `size` sits after `position` in the
       fixture's packed layout, and binding it at byte 0 would size every sprite by the
       x of its position. */
    expect(pass.buffers).toContainEqual({
      binding: "mapSizes",
      resourceId: pointStorageId("sim"),
      half: "write",
      offset: 16 * 128,
      bytes: 4 * 128,
    });
  });

  it("swizzles a vector attribute through its declared type, never a guess", () => {
    const result = mapped({ attribute: "velocity", channel: "y" });
    const pass = result.passes[0] as { shader: string };
    expect(pass.shader).toContain("mapSizes: array<vec3f>");
    expect(pass.shader).toContain("mapSizes[instance].y");
  });

  it("fails BY NAME when the attribute is absent, listing what the pointset provides", () => {
    const result = mapped({ attribute: "pscale" });
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.parameter.map");
    expect(result.diagnostics?.[0]?.suggestion).toContain("position, size, velocity");
  });

  it("fails when a vector map names no channel, and when the port is not this node's", () => {
    const missingChannel = mapped({ attribute: "velocity" });
    expect(missingChannel.diagnostics?.[0]?.message).toContain("needs a channel (x/y/z)");
    const wrongPort = mapped({ attribute: "size", port: "points2" });
    expect(wrongPort.diagnostics?.[0]?.message).toContain('only pointset input is "points"');
  });

  /**
   * T369 (§V288): the same refusal renderInstances gives, because §V109 forbids two
   * answers to one question. Map mode is offered on EVERY parameter, so before this a
   * map on `blend` (or on a component slot like `color.r`, which nothing honours anywhere)
   * compiled quietly and drew the retained static.
   */
  it("names a map it cannot honour rather than ignoring it", () => {
    const result = renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        pointsets: edge,
        parameters: { count: 64 },
        parameterMaps: { "color.r": { attribute: "size" } },
      }),
    );
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.message).toContain(
      'color.r is in map mode, but renderPoints maps only "color" and "sizePixels"',
    );
  });

  it("unmapped stays byte-identical to what always shipped (T300's property)", () => {
    const result = renderPointsNode.compile(
      compileContext({ nodeId: "draw", inputs: ["points"], sources: { points: "sim" }, pointsets: edge, parameters: { count: 128 } }),
    );
    const pass = result.passes[0] as { shader: string; uniforms: Record<string, unknown> };
    expect(pass.shader).toContain("sizePixels: f32");
    expect(pass.uniforms["sizePixels"]).toBe(4);
  });
});

describe("color in map mode — per-point colour on the compound head (T364)", () => {
  const edge = {
    points: {
      pairs: fixturePairs(
        "sim",
        [
          { name: "position", type: "vec3f" },
          { name: "tint", type: "vec4f" },
          { name: "size", type: "f32" },
        ],
        64,
      ),
      capacity: 64,
      topology: "points",
    },
  };
  const compile = (maps: Record<string, { attribute: string; channel?: string }>) =>
    renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        pointsets: edge,
        parameters: { count: 64 },
        parameterMaps: maps,
      }),
    );

  it("binds the vec4f attribute; colour leaves the uniform block", () => {
    const result = compile({ color: { attribute: "tint" } });
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as {
      shader: string;
      buffers: Array<{ binding: string; resourceId: string }>;
      uniforms?: Record<string, unknown>;
    };
    expect(pass.shader).toContain("mapColors: array<vec4f>");
    expect(pass.uniforms).toEqual({ sizePixels: 4 });
    expect(pass.buffers).toContainEqual({
      binding: "mapColors",
      resourceId: pointStorageId("sim"),
      half: "write",
      // T1076: `tint` is the second region — after `position`'s 16 B × 64 points.
      offset: 16 * 64,
      bytes: 16 * 64,
    });
  });

  it("BOTH mapped: the uniform block vanishes with its struct", () => {
    const result = compile({ color: { attribute: "tint" }, sizePixels: { attribute: "size" } });
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as { shader: string; uniforms?: unknown; uniformBinding?: unknown };
    expect(pass.shader).not.toContain("SpriteParams");
    expect(pass.uniforms).toBeUndefined();
    expect(pass.uniformBinding).toBeUndefined();
  });

  it("refuses a channel on the head, and a non-vec4f attribute, by name", () => {
    const channelled = compile({ color: { attribute: "tint", channel: "r" } });
    expect(channelled.diagnostics?.[0]?.message).toContain("component slot");
    const wrongType = compile({ color: { attribute: "size" } });
    expect(wrongType.diagnostics?.[0]?.message).toContain('"size" is f32');
  });
});

describe("the draw-time group (T333)", () => {
  const edge = {
    points: {
      pairs: fixturePairs(
        "sim",
        [
          { name: "position", type: "vec3f" },
          { name: "life", type: "f32" },
        ],
        64,
      ),
      capacity: 64,
      topology: "points",
    },
  };
  const compile = (group: string) =>
    renderPointsNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "sim" },
        pointsets: edge,
        parameters: { count: 64, group },
      }),
    );

  it("binds exactly the attributes the predicate references, typed from the edge", () => {
    const result = compile("p.life < 0.5 && p.position.y > 0.0");
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as { shader: string; buffers: Array<{ binding: string; resourceId: string }> };
    expect(pass.shader).toContain("group_life: array<f32>");
    expect(pass.shader).toContain("group_position: array<vec3f>");
    expect(pass.shader).toContain("return (p.life < 0.5 && p.position.y > 0.0)");
    expect(pass.buffers).toContainEqual({
      binding: "group_life",
      resourceId: pointStorageId("sim"),
      half: "write",
      // T1076: `life` is the second region — after `position`'s 16 B × 64 points.
      offset: 16 * 64,
      bytes: 4 * 64,
    });
  });

  it("refuses an unknown attribute by name, listing what the pointset provides", () => {
    const result = compile("p.age > 1.0");
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.code).toBe("node.points.group");
    expect(result.diagnostics?.[0]?.suggestion).toContain("life, position");
  });

  it("refuses a predicate that references nothing — it would gate on a constant", () => {
    const result = compile("1.0 > 0.5");
    expect(result.diagnostics?.[0]?.message).toContain("references no attribute");
  });

  it("empty group leaves the shipped shader byte-identical (§V309, fifth stage)", () => {
    const result = renderPointsNode.compile(
      compileContext({ nodeId: "draw", inputs: ["points"], sources: { points: "sim" }, pointsets: edge, parameters: { count: 64 } }),
    );
    const pass = result.passes[0] as { shader: string };
    expect(pass.shader).not.toContain("groupMatch");
    expect(pass.shader).not.toContain("GroupPoint");
  });
});

/**
 * T587 — the seam codegen's own tests cannot reach: a notice becomes an `info` diagnostic
 * on a node whose compile SUCCEEDED, and travels with the passes rather than instead of
 * them. Severity is asserted, not assumed: an `error` here would refuse a legitimate
 * timeline-anchored kernel and a missing entry would be silence, which is the state T587
 * exists to end.
 */
describe("T587 — a point kernel on the wrapping clock says so, without refusing", () => {
  const compileWith = (kernel: string) =>
    pointKernelNode.compile(compileContext({ nodeId: "sim", outputs: [], parameters: { kernel } }));

  const WRAPPING = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.x = sin(ctx.time);
  return q;
}`;

  it("emits ONE info diagnostic and still emits its dispatch", () => {
    const result = compileWith(WRAPPING);
    expect(result.passes).toHaveLength(1);
    const diagnostics = result.diagnostics ?? [];
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0] as { severity: string; code: string; message: string; nodeId?: string };
    expect(diagnostic.severity).toBe("info");
    expect(diagnostic.code).toBe("node.points.clock");
    // Attributed to the node, so the problems panel can jump to it (T465).
    expect(diagnostic.nodeId).toBe("sim");
    expect(diagnostic.message).toContain('Node "sim"');
  });

  it("says nothing at all when the kernel declares itself timeline-anchored", () => {
    const declared = WRAPPING.replace(
      "  var q = p;",
      "  var q = p;\n  // timeline-anchored: the sweep IS the position in the piece.",
    );
    expect(compileWith(declared).diagnostics ?? []).toEqual([]);
    expect(compileWith(declared).passes).toHaveLength(1);
  });

  it("the DEFAULT kernel every new node ships with provokes nothing", () => {
    // If it did, the notice would greet every user on every fresh node and become noise
    // before it ever taught anyone anything.
    expect(pointKernelNode.compile(compileContext({ nodeId: "sim", outputs: [] })).diagnostics ?? []).toEqual([]);
  });
});
