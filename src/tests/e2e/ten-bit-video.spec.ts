import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * T1741b — A 10-BIT TAKE IS 10-BIT IN THE FILE, AND THE 8-BIT ONE BANDS.
 *
 * The owner's "blotchy" LED content is 8-bit quantisation of dark gradients: a dark ramp
 * spans a few dozen 8-bit codes, and each becomes a flat band. This spec renders ONE dark
 * grey ramp from a float (rgba16float, display-encoded) Output twice, through the app's own
 * take path (`renderFrameRange`, the WebCodecs encoder, the MP4 muxer), and decodes both files
 * with ffmpeg, which knows nothing about Loom:
 *
 *  - HEVC Main 10 (readback of the float Output, `toI420P10`): ffprobe must say hevc / Main
 *    10 / yuv420p10le in an `hvc1` sample entry, and the decoded luma must follow the ramp
 *    with ~3.4x the levels of the 8-bit file (one 8-bit step is 876/255 = 3.4 limited-range
 *    10-bit codes) and land on the codes BT.709 limited range derives from the ramp.
 *  - H.264, the shipped default (canvas capture): the same ramp decodes as 8-bit bands.
 *
 * ## Which browser
 *
 * HEVC Main 10 needs an encoder Chrome ships switched OFF (measured 2026-11-08: Chrome 157 and
 * Chromium 151 on macOS refuse `hvc1.2.4` in `isConfigSupported`; Chrome 157 launched with
 * `--enable-features=PlatformHEVCHbdEncoderSupport` encodes it; Chromium 151 does not even
 * then). So the 10-bit lane launches the INSTALLED Google Chrome (`channel: "chrome"`) with
 * that switch (its own `chromium.launch`, since `channel` is a worker option), headless, on
 * the real GPU like the rest of `chromium-gpu`. A machine without Chrome fails at launch,
 * loudly; it never skips.
 *
 * The second describe runs the lane's own Chromium, unswitched, and pins what a user gets by
 * default: Main 10 refused with the sentence naming the switch, H.264 High available. If a
 * Chrome update enables the encoder by default, that test fails, and the default format
 * (`DEFAULT_VIDEO_FORMAT`, kept on H.264 for exactly this reason) is worth revisiting.
 */

const WIDTH = 512;
const HEIGHT = 128;
/** Display-encoded grey from LOW at the left edge to LOW + SPAN at the right. */
const LOW = 0.04;
const SPAN = 0.08;

interface Take {
  readonly base64: string;
  readonly mimeType: string;
  readonly frames: number;
  readonly readbacks: number;
  readonly diagnostics: readonly string[];
}

async function renderRamp(page: Page, format: "hevc-main10" | "h264"): Promise<Take> {
  await page.goto("/experiments/canvas-export/");
  return page.evaluate(async ({ format, width, height, low, span }) => {
    const backendPath = "/src/runtime/backend/index.ts";
    const wgslPath = "/src/runtime/backend/wgsl.ts";
    const exportsPath = "/src/runtime/export/index.ts";
    const capturePath = "/src/app/render-canvas-capture.ts";
    const rangePath = "/src/app/render-range.ts";
    const { createVgpuBackend, browserGpuHost } = await import(/* @vite-ignore */ backendPath) as typeof import("../../runtime/backend/index.ts");
    const { wgsl } = await import(/* @vite-ignore */ wgslPath) as typeof import("../../runtime/backend/wgsl.ts");
    const { createExportInterface, readbackSourceFromBackend, loadVideoEncoder } = await import(/* @vite-ignore */ exportsPath) as typeof import("../../runtime/export/index.ts");
    const { createRenderCanvasCapture } = await import(/* @vite-ignore */ capturePath) as typeof import("../../app/render-canvas-capture.ts");
    const { renderFrameRange } = await import(/* @vite-ignore */ rangePath) as typeof import("../../app/render-range.ts");
    const backend = createVgpuBackend({ host: browserGpuHost() });
    const diagnostics: string[] = [];
    backend.onDiagnostic(d => { if (d.severity === "error") diagnostics.push(d.message); });
    await backend.initialize({});
    // One pass into a float target: the Output of a project whose working format is rgba16float.
    const plan = await backend.compile({
      resources: [{ kind: "target", id: "output", size: [width, height], format: "rgba16float" }],
      passes: [{
        kind: "effect", id: "ramp", nodeId: "node-ramp", target: "output",
        shader: wgsl`@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
          let v = ${String(low)} + uv.x * ${String(span)};
          return vec4f(v, v, v, 1.0);
        }`,
      }],
      diagnostics: [],
    });
    const output = { ref: { nodeId: "out", portId: "out" }, resourceId: "output", width, height,
      format: "rgba16float" as const, space: "encoded" as const };
    const api = createExportInterface({ source: readbackSourceFromBackend(backend), outputs: () => [output], isPlaying: () => false });
    let current = 0;
    const at = () => ({ frame: { frameIndex: current, timeSeconds: current / 30, deltaSeconds: 1 / 30,
      mode: "offline" as const, randomSeed: 1 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height] as const });
    const step = () => { backend.render(plan, at()); return at(); };
    const transport = { isPlaying: () => false, togglePlay() {}, resetAbsoluteClock() {},
      resetState() { backend.resetTemporalHistory(undefined, { buffers: true }); },
      seek(index: number) { current = index; step(); return current; },
      stepOnce() { current++; return step(); }, latestFrame: at };
    // The production split (`use-render-range.ts`): 8-bit formats capture the canvas, a
    // 10-bit format reads the Output back at full precision.
    const capture = format === "h264" ? createRenderCanvasCapture(backend, output) : null;
    const readbacksBefore = backend.status.readbacks;
    try {
      const encoder = await loadVideoEncoder({ format, ...(capture === null ? {} : { captureFrame: capture.captureFrame }) });
      if (!encoder) throw new Error("WebCodecs unavailable");
      const take = await renderFrameRange({ api, ref: output.ref, encoder, transport, timelineFps: 30, outputFps: 30, range: { start: 0, end: 5 } });
      const blob = take.bytes instanceof Blob ? take.bytes : new Blob([new Uint8Array(take.bytes)]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await take.dispose?.();
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      return { base64: btoa(binary), mimeType: take.mimeType, frames: take.report.frames,
        readbacks: backend.status.readbacks - readbacksBefore, diagnostics };
    } finally {
      capture?.dispose();
      backend.dispose();
    }
  }, { format, width: WIDTH, height: HEIGHT, low: LOW, span: SPAN });
}

interface Decoded {
  readonly stream: Record<string, string>;
  /** Luma of frame 3, averaged down each column over the middle rows, in 10-bit limited codes. */
  readonly column: readonly number[];
}

function decode(path: string): Decoded {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,codec_tag_string,profile,pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_frames",
    "-of", "json", path]).toString()) as { streams: Array<Record<string, string>> };
  // Decoded to 10-bit limited-range luma whatever the source depth, so both files are read on one scale.
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "select=eq(n\\,3)", "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-color_range", "tv", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const column: number[] = [];
  for (let x = 0; x < WIDTH; x += 1) {
    let sum = 0;
    for (let y = 32; y < HEIGHT - 32; y += 1) sum += raw.readUInt16LE((y * WIDTH + x) * 2);
    column.push(sum / (HEIGHT - 64));
  }
  return { stream: probe.streams[0]!, column };
}

/** Distinct luma levels across the ramp, away from the left and right edges. */
function levels(column: readonly number[]): number {
  return new Set(column.slice(16, WIDTH - 16).map(Math.round)).size;
}

/** The widest run of adjacent columns on one level: the width of a band. */
function widestBand(column: readonly number[]): number {
  const rounded = column.slice(16, WIDTH - 16).map(Math.round);
  let widest = 1;
  let run = 1;
  for (let index = 1; index < rounded.length; index += 1) {
    run = rounded[index] === rounded[index - 1] ? run + 1 : 1;
    widest = Math.max(widest, run);
  }
  return widest;
}

test.describe("Chrome with its HEVC 10-bit encoder switched on", () => {
  test("a dark float ramp records as true 10-bit HEVC Main 10, and as 8-bit bands through H.264", async ({ playwright, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    // A browser of its own: `channel` is a worker option, and this one test needs the
    // installed Chrome with the switch while the rest of the lane runs its own Chromium.
    const browser = await playwright.chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--mute-audio", "--enable-features=PlatformHEVCHbdEncoderSupport"],
    });
    let tenBit: Take;
    let eightBit: Take;
    try {
      const page = await (await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) })).newPage();
      tenBit = await renderRamp(page, "hevc-main10");
      eightBit = await renderRamp(page, "h264");
    } finally {
      await browser.close();
    }
    const tenPath = testInfo.outputPath("ramp-hevc-main10.mp4");
    const eightPath = testInfo.outputPath("ramp-h264.mp4");
    writeFileSync(tenPath, Buffer.from(tenBit.base64, "base64"));
    writeFileSync(eightPath, Buffer.from(eightBit.base64, "base64"));

    // The take paths: 10-bit read every frame back at full precision; 8-bit read nothing.
    expect(tenBit.frames).toBe(6);
    expect(eightBit.frames).toBe(6);
    expect(tenBit.readbacks).toBe(6);
    expect(eightBit.readbacks).toBe(0);
    expect([...tenBit.diagnostics, ...eightBit.diagnostics]).toEqual([]);
    expect(tenBit.mimeType).toMatch(/^video\/mp4; codecs="hvc1\.2\.4\.L\d+\.B0"$/);

    const ten = decode(tenPath);
    const eight = decode(eightPath);
    // What ffprobe, a decoder that is not Loom, reads out of the file.
    expect(ten.stream).toMatchObject({
      codec_name: "hevc", codec_tag_string: "hvc1", profile: "Main 10", pix_fmt: "yuv420p10le",
      color_range: "tv", color_space: "bt709", color_primaries: "bt709", color_transfer: "iec61966-2-1", nb_frames: "6",
    });
    expect(eight.stream).toMatchObject({ codec_name: "h264", codec_tag_string: "avc1", nb_frames: "6" });
    expect(eight.stream.pix_fmt).toMatch(/^yuvj?420p$/);

    // The 10-bit file follows the ramp Y = 64 + 876 · (LOW + SPAN · u) closer than any 8-bit
    // source can: quantised to bytes, some column is always half an 8-bit step off, which is
    // 876 / 255 / 2 = 1.72 codes. Measured 2026-11-08: HEVC Main 10 0.89, H.264 3.73.
    const expected = Array.from({ length: WIDTH }, (_value, x) => 64 + 876 * (LOW + (SPAN * (x + 0.5)) / WIDTH));
    const worst = (column: readonly number[]): number =>
      Math.max(...column.slice(16, WIDTH - 16).map((value, index) => Math.abs(value - expected[index + 16]!)));
    expect(worst(ten.column)).toBeLessThanOrEqual(1.5);
    expect(worst(eight.column)).toBeGreaterThan(1.72);

    // Banding: the ramp crosses 0.08 · 876 ≈ 70 10-bit codes but only 0.08 · 255 ≈ 20 8-bit
    // ones, so an 8-bit source can show at most ~21 levels. Measured: 66 against 18.
    const tenLevels = levels(ten.column);
    const eightLevels = levels(eight.column);
    testInfo.annotations.push({ type: "levels", description: `HEVC Main 10 ${String(tenLevels)}, H.264 ${String(eightLevels)}; widest band ${String(widestBand(ten.column))} px vs ${String(widestBand(eight.column))} px` });
    expect(tenLevels).toBeGreaterThanOrEqual(50);
    expect(eightLevels).toBeLessThanOrEqual(24);
    expect(tenLevels).toBeGreaterThanOrEqual(2.5 * eightLevels);
    // An 8-bit band is ~25 columns wide here (512 / 20.4); a 10-bit level ~7. Measured: 12 against 48.
    expect(widestBand(ten.column)).toBeLessThanOrEqual(18);
    expect(widestBand(eight.column)).toBeGreaterThanOrEqual(24);
  });
});

test.describe("the lane's own Chromium, as a user's browser is by default", () => {
  test("refuses HEVC Main 10 with the sentence that names the switch, and offers H.264 High", async ({ page }) => {
    await page.goto("/experiments/canvas-export/");
    const result = await page.evaluate(async () => {
      const exportsPath = "/src/runtime/export/index.ts";
      const { probeVideoEncoderSupport } = await import(/* @vite-ignore */ exportsPath) as typeof import("../../runtime/export/index.ts");
      const config = { width: 1920, height: 1080, fps: 60 };
      return {
        hevc: await probeVideoEncoderSupport(config, { format: "hevc-main10" }),
        high: await probeVideoEncoderSupport(config, { format: "h264-high" }),
        compatible: await probeVideoEncoderSupport(config, { format: "h264" }),
      };
    });
    expect(result.hevc).toMatchObject({ supported: false, codec: "hvc1.2.4.L123.B0" });
    expect(result.hevc.reason).toContain("--enable-features=PlatformHEVCHbdEncoderSupport");
    expect(result.high).toEqual({ supported: true, codec: "avc1.64002a", reason: null });
    expect(result.compatible).toEqual({ supported: true, codec: "avc1.42002a", reason: null });
  });
});
