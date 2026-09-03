import { expect, test } from "@playwright/test";

/**
 * T1088 — the MediaPipe matte, through the REAL stack in a REAL browser.
 *
 * Everything here is unreachable from the headless project and that is why it exists:
 * `mediapipe-matte.test.ts` gates the arithmetic with an injected segmenter, and node has
 * neither WebGL, nor WebGPU, nor a wasm runtime that can open a TFLite delegate. What can
 * only fail HERE is the part most likely to: MediaPipe's 11 MB wasm loading from this
 * app's own origin under `Cross-Origin-Embedder-Policy: require-corp`, the `?url` assets
 * vite emits for it, the delegate ladder, and the model bytes arriving over CORS.
 *
 * ## Why the model's own mask does not supply the "non-empty" assertion
 *
 * It would need a photograph of a person committed to this repository. The model is
 * correctly unimpressed by a synthetic stand-in — measured, a drawn head-and-shoulders
 * figure returns coverage 0.0000 with a peak of 0.0158, which is the model behaving
 * properly rather than a bug to work around. So the two halves are asserted separately
 * and neither is weakened: the REAL segmenter is gated on producing a well-formed mask of
 * the right shape and range, and the DELIVERY is gated on carrying a known non-zero mask
 * to a sampleable texture with its values intact.
 */

/** The app's own dev server, which is what supplies the COEP headers under test. */
const APP = "/";

/*
 * The module specifiers are passed INTO the page rather than written as literals, and
 * that is a typecheck concern rather than a style one: inside `page.evaluate` these are
 * browser URLs the dev server resolves, but a literal would also be read by tsc as a TS
 * module path and fail to resolve (`/src/...` is not a module specifier). As arguments
 * they stay strings to tsc and URLs to the browser; the `typeof import` casts below put
 * the real types back, through the tsconfig aliases.
 */
const MODULES = {
  matte: "/src/runtime/models/mediapipe-matte.ts",
  segmenter: "/src/runtime/models/mediapipe-segmenter.ts",
  catalogue: "/src/runtime/models/model-catalogue.ts",
} as const;

type MatteModule = typeof import("@runtime/models/mediapipe-matte.ts");
type SegmenterModule = typeof import("@runtime/models/mediapipe-segmenter.ts");
type CatalogueModule = typeof import("@runtime/models/model-catalogue.ts");

test.describe("MediaPipe matte (T1088)", () => {
  /**
   * The real runtime, end to end: model bytes over CORS, wasm from our origin, a delegate
   * opened, a mask returned. Asserted on SHAPE and RANGE rather than on content, because
   * content needs a photograph — see the file docblock.
   *
   * §V896's positive control is the mask's own length: a run that silently did nothing
   * would return an empty or wrongly-sized array, and this fails on that before it ever
   * reaches a value assertion.
   */
  test("opens a real segmenter under COEP and returns a well-formed mask", async ({ page }) => {
    await page.goto(APP);

    const result = await page.evaluate(async (paths) => {
      const SIDE = 256;
      const [matte, segmenter, catalogue] = (await Promise.all([
        import(paths.matte),
        import(paths.segmenter),
        import(paths.catalogue),
      ])) as [MatteModule, SegmenterModule, CatalogueModule];

      const descriptor = catalogue.MATTE_MEDIAPIPE;
      const response = await fetch(descriptor.url);
      if (!response.ok) throw new Error(`model fetch failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());

      const runner = matte.createMediaPipeMatteRunner({
        side: SIDE,
        openSegmenter: () => segmenter.openTasksVisionSegmenter(bytes),
      });

      // A flat mid-grey square. The point is that a real delegate consumed it and
      // answered in the declared shape, not what it decided about it.
      const texels = new Float32Array(SIDE * SIDE * 4).fill(0.5);
      const out = await runner.run(texels.buffer, SIDE, SIDE);
      const floats = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);

      let min = Infinity;
      let max = -Infinity;
      let finite = true;
      for (const value of floats) {
        if (!Number.isFinite(value)) finite = false;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      runner.dispose();
      return { downloaded: bytes.byteLength, length: floats.length, min, max, finite };
    }, MODULES);

    // The bytes the descriptor promises, checked against what the network actually served.
    expect(result.downloaded).toBe(249_537);
    // r32float, one value per output pixel — the encoding every matte model publishes.
    expect(result.length).toBe(256 * 256);
    expect(result.finite).toBe(true);
    // A confidence mask. Outside [0,1] means the mask was misread, not merely unexpected.
    expect(result.min).toBeGreaterThanOrEqual(0);
    expect(result.max).toBeLessThanOrEqual(1);
  });

  /**
   * THE DELIVERED VALUE — the assertion this task turns on.
   *
   * A mask is worthless to this app until a pass can sample it, and the benchmark that
   * justified the whole feature timed exactly this: bytes to a WebGPU texture, with
   * `onSubmittedWorkDone()` inside the measured region. So the gate is the same shape.
   * The mask is a known non-zero pattern pushed through the PRODUCT runner, and the
   * texture is read back through a render pass that `textureLoad`s it — which is how the
   * matte node's own binding reads it (`sampled: "unfiltered"`), not a bare buffer copy
   * that would prove only that writeTexture works.
   *
   * §V896, applied rather than cited: the destination carries RENDER_ATTACHMENT, an error
   * scope is popped around the submit, and the expected values are DISTINCT per texel —
   * so a copy that silently did nothing reads as zeros and fails, and a copy that landed
   * transposed or offset fails too. A uniform mask would have passed all three.
   */
  test("delivers the mask to a sampleable WebGPU texture with its values intact", async ({ page }) => {
    await page.goto(APP);

    const result = await page.evaluate(async (paths) => {
      const SIDE = 4;
      const matte = (await import(paths.matte)) as MatteModule;

      // Distinct per texel, so a transpose or an offset cannot pass.
      const mask = new Float32Array(SIDE * SIDE);
      for (let at = 0; at < mask.length; at += 1) mask[at] = (at + 1) / mask.length;

      const runner = matte.createMediaPipeMatteRunner({
        side: SIDE,
        openSegmenter: async () => ({
          delegate: "stub",
          segment: () => mask,
          close: () => {},
        }),
      });
      const bytes = await runner.run(new Float32Array(SIDE * SIDE * 4).buffer, SIDE, SIDE);
      const produced = [...new Float32Array(bytes.buffer, bytes.byteOffset, SIDE * SIDE)];

      if (navigator.gpu === undefined) throw new Error("this browser exposes no navigator.gpu");
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) throw new Error("no WebGPU adapter — the delivered path cannot be gated");
      const device = await adapter.requestDevice();

      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
      const source = device.createTexture({ size: [SIDE, SIDE], format: "r32float", usage });
      const target = device.createTexture({ size: [SIDE, SIDE], format: "r32float", usage });

      device.pushErrorScope("validation");
      // Copied into a plainly-backed Uint8Array: the runner returns a view over the float
      // buffer, and TS 5.7 types that as ArrayBufferLike, which writeTexture will not take.
      device.queue.writeTexture(
        { texture: source },
        new Uint8Array(bytes),
        { bytesPerRow: SIDE * 4 },
        [SIDE, SIDE],
      );

      const shader = device.createShaderModule({
        code: `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(i32(pos.x), i32(pos.y)), 0).r, 0.0, 0.0, 1.0);
}`,
      });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format: "r32float" }] },
        primitive: { topology: "triangle-list" },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source.createView() }],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: target.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();

      const bytesPerRow = 256;
      const readback = device.createBuffer({
        size: bytesPerRow * SIDE,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [SIDE, SIDE]);
      device.queue.submit([encoder.finish()]);
      // Inside the region, exactly as the benchmark timed it: the texture is not delivered
      // until the queue says the work is done.
      await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();

      await readback.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      const sampled: number[] = [];
      for (let y = 0; y < SIDE; y += 1) {
        const row = new Float32Array(raw.buffer, y * bytesPerRow, SIDE);
        sampled.push(...row);
      }
      runner.dispose();
      return { produced, sampled, validation: validation === null ? null : validation.message };
    }, MODULES);

    // §V896: a silent validation failure is what makes an empty texture look like proof.
    expect(result.validation).toBeNull();
    // Non-empty, and non-trivially so.
    expect(Math.max(...result.sampled)).toBeGreaterThan(0);
    // The delivered value, exactly — r32float through an unfiltered load is lossless, so
    // this is an equality rather than a tolerance band (§V147).
    expect(result.sampled).toEqual(result.produced);
    expect(result.produced).toEqual([
      0.0625, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.4375, 0.5,
      0.5625, 0.625, 0.6875, 0.75, 0.8125, 0.875, 0.9375, 1,
    ]);
  });
});
