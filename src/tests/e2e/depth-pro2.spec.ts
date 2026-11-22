import { expect, test } from "@playwright/test";

/**
 * T1816b — Depth Pro 2's streaming build through the REAL inference worker, on WebGPU.
 *
 * What only a browser can show: the worker shim Vite serves, onnxruntime-web's WebGPU
 * provider on a real adapter, the stream cache handed back as DEVICE tensors
 * (`preferredOutputLocation`), and fp16 zero state shaped from the session's own metadata.
 * The headless suite drives the same core with fakes and the single-frame S FP32 build on
 * the CPU; the FP16 stream measured 78 s a frame there, so the streaming proof lives here.
 *
 * Both streaming builds (FP32 97.9 MB, FP16 50.6 MB), each from the pinned Hugging Face
 * revision, its bytes checked against
 * the catalogue's length before they reach the worker. The picture is a real street frame
 * from `public/media`, panned four pixels a frame so each run sees new content and the
 * cache is exercised the way a live camera exercises it.
 */

const MODULES = { catalogue: "/src/runtime/models/model-catalogue.ts" } as const;
type CatalogueModule = typeof import("@runtime/models/model-catalogue.ts");

const CASES = [
  { build: "DEPTH_PRO2_S_STREAM_FP32", wide: false },
  { build: "DEPTH_PRO2_S_STREAM", wide: false },
  { build: "DEPTH_PRO2_S_STREAM_FP32", wide: true },
] as const;

for (const { build, wide } of CASES) test(`${build}${wide ? " 672×384" : ""}: four frames on WebGPU, its cache fed back on the device`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const result = await page.evaluate(async ({ paths, build, wide }) => {
    const catalogue = (await import(paths.catalogue)) as CatalogueModule;
    const descriptor = wide ? catalogue.DEPTH_PRO2_WIDE[catalogue[build].id]! : catalogue[build];
    const weights = await (await fetch(descriptor.url)).arrayBuffer();
    if (weights.byteLength !== descriptor.bytes) throw new Error(`downloaded ${weights.byteLength} bytes`);

    const [W, H] = wide ? [672, 384] : [640, 480];
    const [OUT_W, OUT_H] = [160, 90];
    const video = document.createElement("video");
    video.muted = true;
    video.src = "/media/shibuya-crossing.mp4";
    document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
    // A decoded frame, not the element's empty first paint: seek and wait for it.
    video.currentTime = 2;
    await new Promise((resolve) => { video.onseeked = resolve; });
    const canvas = new OffscreenCanvas(W, H);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const toLinear = (byte: number) => {
      const v = byte / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const frames: Float32Array[] = [];
    const means: number[] = [];
    for (let f = 0; f < 4; f += 1) {
      // 16:9 source letterboxed into the 4:3 box, as the node's preprocess does.
      const h = (W * video.videoHeight) / video.videoWidth;
      context.fillStyle = "black";
      context.fillRect(0, 0, W, H);
      context.drawImage(video, -2 * f, (H - h) / 2, W + 8, h);
      const rgba = context.getImageData(0, 0, W, H).data;
      const texels = new Float32Array(W * H * 4);
      for (let i = 0; i < W * H; i += 1) {
        for (let c = 0; c < 3; c += 1) texels[i * 4 + c] = toLinear(rgba[i * 4 + c]!);
        texels[i * 4 + 3] = 1;
      }
      frames.push(texels);
      let sum = 0;
      for (let i = 0; i < rgba.length; i += 4) sum += rgba[i + 1]!;
      means.push(sum / (W * H * 255));
    }

    const worker = new Worker("/src/runtime/models/inference.worker.ts", { type: "module" });
    const replies: Array<Record<string, unknown>> = [];
    const next = () => new Promise<Record<string, unknown>>((resolve) => {
      worker.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    const sessionKey = `${descriptor.id}@webgpu`;
    let pending = next();
    worker.postMessage({ kind: "load", sessionKey, modelId: descriptor.id, weights, providers: ["webgpu"] }, [weights]);
    replies.push(await pending);
    const maps: Float32Array[] = [];
    for (let f = 0; f < frames.length; f += 1) {
      pending = next();
      const texels = frames[f]!.buffer;
      worker.postMessage({
        kind: "run", requestId: f + 1, sessionKey, nodeId: "depth1", nodeType: "depth", texels,
        width: OUT_W, height: OUT_H, side: W, sourceWidth: 1920, sourceHeight: 1080,
        modelId: descriptor.id, ratio: 0, smoothing: 1, fieldOfView: 60,
      }, [texels]);
      const reply = await pending;
      replies.push({ ...reply, bytes: undefined });
      if (reply["kind"] !== "result") break;
      maps.push(new Float32Array(reply["bytes"] as ArrayBuffer));
    }
    worker.terminate();
    const stats = maps.map((map) => {
      let sky = 0, finite = true, min = Infinity, max = -Infinity;
      for (const v of map) {
        if (!Number.isFinite(v) || v < 0) finite = false;
        if (v === 0) sky += 1;
        else { min = Math.min(min, v); max = Math.max(max, v); }
      }
      return { length: map.length, finite, skyFraction: sky / map.length, nearestMetres: 1 / max, furthestMetres: 1 / min };
    });
    const changed = maps.slice(1).map((map, i) => map.some((v, j) => v !== maps[i]![j]));
    return { replies, stats, changed, means };
  }, { paths: MODULES, build, wide });

  expect(result.replies[0], JSON.stringify(result.replies)).toMatchObject({ kind: "loaded", backend: "webgpu" });
  // Four results, not an error on frame two: the device-resident cache went back in.
  expect(result.replies.slice(1).map((reply) => reply["kind"]), JSON.stringify(result.replies)).toEqual(["result", "result", "result", "result"]);
  for (const reply of result.replies.slice(1)) expect(reply["backend"]).toBe("webgpu");
  // §V896's positive control: the picture really was a picture. A blank first paint read
  // as a wall 0.6 m away, which is a plausible depth map of the wrong thing.
  for (const mean of result.means) expect(mean).toBeGreaterThan(0.05);
  for (const stats of result.stats) {
    expect(stats.length).toBe(160 * 90);
    expect(stats.finite).toBe(true);
    // A street crossing, measured 2026-11-21: nearest 8–10 m, furthest 278–770 m. Metric,
    // and deep — a squeezed, double-normalised or unfocused input lands nowhere near.
    expect(stats.nearestMetres).toBeGreaterThan(2);
    expect(stats.furthestMetres).toBeGreaterThan(50);
    expect(stats.furthestMetres / stats.nearestMetres).toBeGreaterThan(5);
  }
  expect(result.changed).toEqual([true, true, true]);
});

/**
 * T1817b — Depth Pro 2 in PHOTO PREPARATION, through the real preparer: the 2D canvas, the
 * letterbox into the 16:9 box, the shipped worker on WebGPU, the raw metres it returns and
 * the prepared map they become. The headless suite drives each piece with fakes; this is
 * where they meet the model. Run twice on one photo at two fields of view, because the
 * field of view is the one input a wrong wire would leave silently at its default.
 */
test("photo preparation: S FP32 in the 16:9 box at 40° and 80°, saved as inverse metres", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  const result = await page.evaluate(async (paths) => {
    const { createPhotoPreparer } = (await import(paths.preparation)) as typeof import("@/app/photo-preparation.ts");
    const { preparedMetadata, letterboxOccupancy } = (await import(paths.preparedMap)) as typeof import("@runtime/media/prepared-map.ts");
    const video = document.createElement("video");
    video.muted = true;
    video.src = "/media/shibuya-crossing.mp4";
    document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
    video.currentTime = 2;
    await new Promise((resolve) => { video.onseeked = resolve; });
    const frame = new OffscreenCanvas(1280, 720);
    frame.getContext("2d")!.drawImage(video, 0, 0, 1280, 720);
    const photo = { bitmap: await createImageBitmap(frame), sha256: "c".repeat(64), name: "crossing.png" };
    const preparer = createPhotoPreparer(() => {});
    const at = (fieldOfView: number) => preparer.run({ kind: "depth", photo,
      recipe: { version: 3, modelId: "depthpro2-s-fp32", backend: "webgpu", inputSide: 672, fieldOfView, refinement: null } });
    const narrow = await at(40);
    const wide = await at(80);
    preparer.dispose();
    const metadata = preparedMetadata(narrow);
    const [occX, occY] = letterboxOccupancy(narrow, metadata);
    // The band's samples, both runs, where both saw a distance.
    const y0 = Math.ceil((1 - occY) * narrow.height / 2 - 0.5), y1 = Math.floor((1 + occY) * narrow.height / 2 - 0.5);
    const ratios: number[] = [];
    for (let y = y0; y <= y1; y += 1) for (let x = 0; x < narrow.width; x += 1) {
      const a = narrow.values[y * narrow.width + x]!, b = wide.values[y * wide.width + x]!;
      if (a > 0 && b > 0) ratios.push(b / a);
    }
    ratios.sort((p, q) => p - q);
    return {
      size: [narrow.width, narrow.height], occ: [occX, occY], metadata, wideRange: preparedMetadata(wide).range,
      finite: [...narrow.values, ...wide.values].every(Number.isFinite),
      samples: ratios.length, band: (y1 - y0 + 1) * narrow.width,
      ratio: { p05: ratios[Math.floor(ratios.length * 0.05)]!, median: ratios[Math.floor(ratios.length / 2)]!, p95: ratios[Math.floor(ratios.length * 0.95)]! },
    };
  }, { preparation: "/src/app/photo-preparation.ts", preparedMap: "/src/runtime/media/prepared-map.ts" });
  expect(result.size).toEqual([672, 384]);
  // 1280 × 720 is 1.778 against the box's 1.75: full width, 98.4 % of the height.
  expect(result.occ[0]).toBe(1);
  expect(result.occ[1]).toBeCloseTo(1.75 / (16 / 9), 12);
  expect(result.metadata).toMatchObject({ kind: "depth", semantics: "inverse-metric", registration: "letterbox", stage: "native",
    inputSide: 672, recipe: { modelId: "depthpro2-s-fp32", fieldOfView: 40 } });
  expect(result.finite).toBe(true);
  // Street scale: the nearest surface 20.4 m away at 40° on 2026-11-22, sky at 0.
  expect(result.metadata.range.low).toBe(0);
  expect(1 / result.metadata.range.high).toBeGreaterThan(5);
  expect(1 / result.metadata.range.high).toBeLessThan(60);
  // Most of the band saw a distance in both runs (84 % measured; the rest is sky).
  expect(result.samples).toBeGreaterThan(result.band * 0.5);
  /* The field of view reaches the model, and the model scales its metres by the focal
     length and nothing else: every pixel at 80° reads nearer by f(40°)/f(80°) =
     tan(40°)/tan(20°) = 2.3054. Measured 2.305407 at the 5th, 50th and 95th percentiles
     alike (spread 4e-7), so a field of view lost on the way pins the ratio at 1. */
  const focalRatio = Math.tan((40 * Math.PI) / 180) / Math.tan((20 * Math.PI) / 180);
  for (const ratio of [result.ratio.p05, result.ratio.median, result.ratio.p95]) expect(ratio).toBeCloseTo(focalRatio, 5);
});
