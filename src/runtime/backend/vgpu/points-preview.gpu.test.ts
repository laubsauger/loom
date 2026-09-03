import { describe, expect, it } from "vitest";
import { pointStorageId } from "../../../nodes/definitions/point-storage.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { pointsPreviewResourceId } from "../../../compiler/resources.ts";
import { viewProjection } from "../../../domain/geometry/camera.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { probeDawn } from "./node-gpu-host.ts";
import { capturingHost, drawSynthesizedPreview } from "./preview-synthesis-fixture.ts";
import { orbitUniforms } from "../../previews/orbit.ts";
import { POINTS_PREVIEW_DIAMETER_PX } from "../../../nodes/shaders/points-preview.wgsl.ts";

/**
 * T373 on a REAL device: a watched point generator's synthesized splat pass actually
 * puts ink where the point projects.
 *
 * One point, so the picture is fully predictable: the position is read back, projected
 * through the SAME default camera the compiler bakes into the pass, and the splat's
 * center texel is asserted against the shader's own math (§V147 — a value derived from
 * the contract, not "some pixels lit"). The zero ring proves the splat is local; a
 * full-screen wash or a stuck clear both fail loudly.
 */

/** The tile edge this test grants — T563: the preview program sizes the target to it. */
const EDGE = 384;
const PREVIEW_LONG_EDGE = 192;
/**
 * T952: the disc is a DEVICE-PIXEL diameter now, not a clip-space fraction — so this is
 * the disc's size in texels at every tile size, rather than at this one. Restated as a
 * literal and pinned against the shader's own constant below, so a change to the look
 * reddens here with the number in the failure rather than silently re-baselining.
 */
const DIAMETER_PX = 4;

describe("pointset preview splat on Dawn (T373)", () => {
  it("splats the single point exactly where the default camera projects it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: {
            id: "gen",
            type: "pointLine",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { count: 1, sizeX: 2 },
          },
        },
        edges: {},
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: PREVIEW_LONG_EDGE,
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
      sinks: [{ nodeId: "gen", portId: "out", kind: "preview" }],
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    const previewId = pointsPreviewResourceId("gen", "out");
    // T563: the splat rides the output row's synthesis, not the plan.
    const row = plan.outputs.find((entry) => entry.nodeId === "gen" && entry.portId === "out");
    const pass = row?.synthesis?.passes.find((entry) => entry.id === "gen#pointsPreview:out");
    expect(pass).toBeDefined();
    // The constant this test's own projection uses must be the one the shader ships.
    expect(POINTS_PREVIEW_DIAMETER_PX).toBe(DIAMETER_PX);
    // T952: the compiler states the extent against its NOMINAL target (a square one
    // here, since the project is 64x64), and the preview program restates it against the
    // granted tile. Both are 384 in this test, so the pass carries the same pair either
    // way — `preview-boost.gpu.test.ts` is where they deliberately differ.
    expect((pass as { uniforms?: { pointSize?: readonly number[] } }).uniforms?.pointSize).toEqual([
      DIAMETER_PX / EDGE,
      DIAMETER_PX / EDGE,
    ]);

    const { host, session } = capturingHost();
    const backend = createVgpuBackend({ host });
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
        resolution: [64, 64],
      });
      expect(errors).toEqual([]);

      // T563: encode the splat through the preview program, at this test's tile.
      const device = session()?.gpu.gpu as unknown as GPUDevice;
      drawSynthesizedPreview({ backend, device, outputs: plan.outputs, nodeId: "gen", portId: "out", tileEdge: EDGE });
      await device.queue.onSubmittedWorkDone();
      expect(errors).toEqual([]);

      // The point's actual position, then the SAME projection the compiler bakes in.
      /* T1076: a generator owns `position` alone, so its packed buffer IS that region. */
      const raw = new Float32Array(await backend.readBuffer(pointStorageId("gen")));
      const point: [number, number, number] = [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
      const camera = viewProjection([1.7, 1.2, 2.4], [0, 0, 0], { aspect: 1 });
      // Column-major mat4 × vec4(point, 1).
      const clip = [0, 1, 2, 3].map(
        (row) =>
          (camera[row] ?? 0) * point[0] +
          (camera[4 + row] ?? 0) * point[1] +
          (camera[8 + row] ?? 0) * point[2] +
          (camera[12 + row] ?? 0),
      );
      const w = clip[3] ?? 1;
      const ndc = [(clip[0] ?? 0) / w, (clip[1] ?? 0) / w];
      const centerPx = [((ndc[0] ?? 0) + 1) * 0.5 * EDGE, (1 - ((ndc[1] ?? 0) + 1) * 0.5) * EDGE];

      const image = await backend.readOutput(previewId);
      expect([image.width, image.height]).toEqual([EDGE, EDGE]);
      const byteAt = (x: number, y: number, channel: number): number =>
        image.bytes[(y * EDGE + x) * 4 + channel] ?? 0;

      // The texel whose center is nearest the projected point: its uv distance is
      // |texelCenter - splatCenter| / halfExtentPx, and the shader writes
      // (1, 0.62, 0.24) * alpha with alpha = 1 - distance, alpha-blended over a clear.
      const texel = [Math.floor(centerPx[0] ?? 0), Math.floor(centerPx[1] ?? 0)];
      // T952: half a disc of DIAMETER_PX texels — no longer a function of the tile.
      const halfExtentPx = DIAMETER_PX / 2;
      const dx = (texel[0] ?? 0) + 0.5 - (centerPx[0] ?? 0);
      const dy = (texel[1] ?? 0) + 0.5 - (centerPx[1] ?? 0);
      const alpha = Math.max(0, 1 - Math.hypot(dx, dy) / halfExtentPx);
      expect(alpha).toBeGreaterThan(0.5); // the nearest texel is well inside the disc
      for (const [channel, tint] of [
        [0, 1.0],
        [1, 0.62],
        [2, 0.24],
      ] as const) {
        const expected = Math.round(tint * alpha * 255);
        const actual = byteAt(texel[0] ?? 0, texel[1] ?? 0, channel);
        // ±1: f32 interpolation of uv across the quad rounds the last bit differently
        // than this f64 reconstruction; one quantization step is the honest bound.
        expect(Math.abs(actual - expected), `channel ${channel}`).toBeLessThanOrEqual(1);
      }

      // Locality: outside the disc the target is exactly the clear — a wash or a
      // stuck-open blend fails here.
      const off = Math.ceil(halfExtentPx) + 2;
      for (const [x, y] of [
        [(texel[0] ?? 0) + off, texel[1] ?? 0],
        [texel[0] ?? 0, (texel[1] ?? 0) + off],
        [0, 0],
        [EDGE - 1, EDGE - 1],
      ]) {
        expect(byteAt(x as number, y as number, 0), `(${x},${y})`).toBe(0);
      }
    } finally {
      backend.dispose();
    }
  });

  /**
   * T563's PROPERTY, measured where it broke: E16 at 4× zoom with the transport PAUSED
   * went black after a ladder crossing, because the splat pass lived in the main plan,
   * the recompile reallocated the target, and the main plan does not run while paused.
   * Here the main plan renders exactly ONCE (the "pause"), the tile then crosses a
   * ladder step (192 → 1152: a fresh program, a fresh target), and the splat must still
   * have ink — drawn by the preview program from the untouched point storage.
   */
  it("survives a ladder crossing with the transport paused — the E16 black preview cannot recur", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointLine", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 64, sizeX: 2 } },
        },
        edges: {},
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: PREVIEW_LONG_EDGE,
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
      sinks: [{ nodeId: "gen", portId: "out", kind: "preview" }],
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const { host, session } = capturingHost();
    const backend = createVgpuBackend({ host });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      // ONE main frame, then the transport "pauses": no further backend.render calls.
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      });
      const device = session()?.gpu.gpu as unknown as GPUDevice;
      const previewId = pointsPreviewResourceId("gen", "out");
      const lit = async (): Promise<number> => {
        const image = await backend.readOutput(previewId);
        let count = 0;
        for (let index = 0; index < image.bytes.length; index += 4) {
          if ((image.bytes[index] ?? 0) > 12) count += 1;
        }
        return count;
      };

      const at192 = drawSynthesizedPreview({ backend, device, outputs: plan.outputs, nodeId: "gen", portId: "out", tileEdge: 192 });
      await device.queue.onSubmittedWorkDone();
      const before = await lit();
      expect(before).toBeGreaterThan(0);
      at192.dispose();

      // THE LADDER CROSSING, paused: a new program, a new (bigger) target — and the
      // splat repaints from the storage the paused plan left behind. Before T563 this
      // read ZERO lit texels and stayed zero until playback resumed.
      const boosted = drawSynthesizedPreview({ backend, device, outputs: plan.outputs, nodeId: "gen", portId: "out", tileEdge: 1152 });
      await device.queue.onSubmittedWorkDone();
      const after = await lit();
      expect(after).toBeGreaterThan(before); // more picture, not black — and not a copy

      // T561: the inspection ORBIT, still paused — a pushed camera VALUE moves the
      // picture on the same program object (no setPreviewProgram call anywhere below).
      // A quarter-turn looks down the line's own axis, so the spread collapses; pushing
      // identity back restores the stock framing byte for byte, which is the "reset is
      // arithmetic" half of the property.
      const row = plan.outputs.find((entry) => entry.nodeId === "gen" && entry.portId === "out");
      const basis = row?.synthesis?.orbit;
      expect(basis).toBeDefined();
      const stock = (await backend.readOutput(previewId)).bytes.slice();
      boosted.present([
        {
          passId: "gen#pointsPreview:out",
          values: orbitUniforms(basis as never, { azimuth: Math.PI / 2, elevation: 0, distance: 1, panX: 0, panY: 0 }),
        },
      ]);
      await device.queue.onSubmittedWorkDone();
      const orbited = (await backend.readOutput(previewId)).bytes;
      let differing = 0;
      for (let index = 0; index < stock.length; index += 4) {
        if (orbited[index] !== stock[index]) differing += 1;
      }
      expect(differing).toBeGreaterThan(200); // the camera moved the picture, not a texel or two

      boosted.present([
        {
          passId: "gen#pointsPreview:out",
          values: orbitUniforms(basis as never, { azimuth: 0, elevation: 0, distance: 1, panX: 0, panY: 0 }),
        },
      ]);
      await device.queue.onSubmittedWorkDone();
      const restored = (await backend.readOutput(previewId)).bytes;
      expect(restored).toEqual(stock);
      expect(errors).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
