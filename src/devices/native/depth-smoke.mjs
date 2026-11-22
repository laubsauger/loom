// T1818b: the real Depth Pro 2 Core ML route on this Mac, through the shipped pieces:
// depth-build (worker library + compiler), depth-models (pinned, hash-verified
// acquisition, compile once), vision-workers (launchd + Python host) and the
// vision-client.node XPC client. Usage (Apple Silicon, macOS 15+):
//
//   node src/devices/native/depth-smoke.mjs [--package-source /abs/dir/holding/the.mlpackage]
//     [--cache /abs/cache] [--model depthpro2-s-coreml] [--frames 12] [--timing res_640x360,...]
//     [--python /abs/python3]
//
// Without --package-source it downloads the pinned package; without --cache it
// prepares into an owned temporary directory and removes it afterwards.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { buildNativeVision } from './vision-build.mjs';
import { buildNativeDepth } from './depth-build.mjs';
import { createDepthModels, depthFunctionSize, depthSupport } from './depth-models.mjs';
import { createVisionWorkers, retireVisionServices } from './vision-workers.mjs';

const { Response, fetch: networkFetch } = globalThis;
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = require('./depth-model-manifest.json');
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const support = depthSupport();
if (!support.supported) throw new Error(support.reason);
const packageSource = option('package-source');
const cacheOption = option('cache');
const python = option('python', 'python3');
const modelId = option('model', 'depthpro2-s-coreml');
const frameCount = Number(option('frames', '12'));
const timing = option('timing', '').split(',').filter(Boolean);
for (const path of [packageSource, cacheOption]) if (path !== undefined && !isAbsolute(path)) throw new Error('Paths must be absolute');
if (!(frameCount >= 6) || timing.some(name => !manifest.functions.includes(name))) throw new Error('Need --frames >= 6 and known --timing functions');
const FUNCTION = 'res_854x480';
const [W, H] = depthFunctionSize(FUNCTION);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** The pinned URLs answered from a local copy, Range included; verification still runs. */
let fetches = 0;
async function fetchPinned(url, options) {
  fetches++;
  if (!packageSource) return networkFetch(url, options);
  const relative = decodeURIComponent(new URL(url).pathname.split(`/resolve/${manifest.revision}/`)[1]);
  const path = join(packageSource, relative);
  const size = (await stat(path)).size;
  const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '');
  const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : size - 1;
  return new Response(Readable.toWeb(createReadStream(path, { start, end })), { status: range ? 206 : 200,
    headers: { 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) } });
}
/** Real frames when ffmpeg exists (the Shibuya clip letterboxed into the box), else a moving gradient. */
function frames(width, height, count) {
  const video = join(root, 'public/media/shibuya-crossing.mp4');
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: width * height * 4 * count + 1, timeout: 60000 });
  if (!decoded.error && decoded.status === 0 && decoded.stdout.length === width * height * 4 * count) {
    return { source: 'shibuya-crossing.mp4', list: Array.from({ length: count },
      (_, i) => decoded.stdout.subarray(i * width * height * 4, (i + 1) * width * height * 4)) };
  }
  return { source: 'synthesized gradient', list: Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      bytes[o] = (x + i * 8) % 256; bytes[o + 1] = (y * 255 / height) | 0; bytes[o + 2] = ((x ^ y) + i) % 256; bytes[o + 3] = 255;
    }
    return bytes;
  }) };
}
/** The contract's un-letterbox: the browser path's occOf + depthPro2ToInverse sampling. */
function expected(values, outputWidth, outputHeight) {
  const aspect = outputWidth / Math.max(outputHeight, 1), box = W / H;
  const [occX, occY] = aspect >= box ? [1, box / aspect] : [aspect / box, 1];
  const out = new Float32Array(outputWidth * outputHeight);
  for (let y = 0; y < outputHeight; y++) {
    const sy = Math.min(H - 1, Math.max(0, Math.floor((((y + 0.5) / outputHeight - 0.5) * occY + 0.5) * H)));
    for (let x = 0; x < outputWidth; x++) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor((((x + 0.5) / outputWidth - 0.5) * occX + 0.5) * W)));
      const v = values[sy * W + sx];
      out[y * outputWidth + x] = Number.isFinite(v) && v > 0 ? v : 0;
    }
  }
  return out;
}
function difference(a, b) {
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); max = Math.max(max, d); sum += d; }
  return { max, mean: sum / a.length };
}

const directory = await mkdtemp(join(tmpdir(), 'loom-depth-smoke-'));
let failure;
try {
  buildNativeVision(directory);
  const { library, compiler } = buildNativeDepth(directory);
  const fixturePath = join(directory, 'depth-smoke-fixture.node');
  const built = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-I', join(dirname(process.execPath), '../include/node'), '-framework', 'Foundation', '-framework', 'IOSurface',
    '-framework', 'CoreVideo', fileURLToPath(new URL('depth-smoke-fixture.mm', import.meta.url)), '-o', fixturePath], { stdio: 'inherit' });
  assert.equal(built.status, 0, 'fixture build');
  const fixture = require(fixturePath);
  const native = require(join(directory, 'vision-client.node'));

  // Acquisition: pinned, verified, compiled once; a second prepare touches nothing.
  const models = createDepthModels({ directory: cacheOption ?? join(directory, 'cache'), manifest, compiler, library, fetch: fetchPinned });
  const before = await models.probe();
  assert.equal(before.available, true, before.reason);
  const phases = [];
  let started = performance.now();
  await models.prepare(modelId, progress => { if (phases.at(-1) !== progress.phase) phases.push(progress.phase); });
  const prepareSeconds = (performance.now() - started) / 1000;
  const after = await models.probe();
  assert.equal(after.models.find(model => model.id === modelId).cached, true);
  const fetchesAfterPrepare = fetches;
  const repeat = [];
  await models.prepare(modelId, progress => repeat.push(progress));
  assert.deepEqual(repeat, [], 'a cached model prepares without verifying, downloading or compiling again');
  assert.equal(fetches, fetchesAfterPrepare);
  const compiled = await models.compiled(modelId);
  console.log('DEPTH_SMOKE_PREPARED', JSON.stringify({ modelId, wasCached: before.models.find(m => m.id === modelId).cached,
    phases, fetches, prepareSeconds: Number(prepareSeconds.toFixed(1)) }));

  const workers = createVisionWorkers({ kind: 'depth', native, directory, library, python });
  const { source, list } = frames(W, H, frameCount);
  const inputs = list.map(bytes => fixture.packed(bytes, W, H));
  try {
    const identity = await workers.open([compiled, FUNCTION]);
    const pillar = await workers.open([compiled, FUNCTION]);
    const run = async (worker, handle, outputWidth, outputHeight) => {
      const t = performance.now();
      const result = await worker.infer(handle, [W, H], [outputWidth, outputHeight]);
      const millis = performance.now() - t;
      try {
        assert.equal(result.format, 'rgba16float');
        assert.deepEqual([result.width, result.height], [outputWidth, outputHeight]);
        const image = fixture.read(result.handle);
        assert.deepEqual([image.width, image.height], [outputWidth, outputHeight]);
        assert.equal(image.channelsExact, true, 'every result pixel is (inverse_depth, 0, 0, 1)');
        let positive = 0;
        for (const v of image.values) { assert.ok(Number.isFinite(v) && v >= 0); if (v > 0) positive++; }
        assert.equal(result.coverage, positive / image.values.length, 'coverage is the fraction of R > 0');
        return { values: image.values, coverage: result.coverage, millis };
      } finally { await worker.release(result.sequence); }
    };
    // A refused request is acknowledged: the session keeps its stream and serves the next frame.
    const wrong = fixture.packed(Buffer.alloc(640 * 360 * 4), 640, 360);
    try {
      await assert.rejects(identity.infer(wrong, [640, 360], [640, 360]),
        { code: 'VISION_REQUEST_REFUSED', message: /function's own size/ });
    } finally { fixture.release(wrong); }

    const stream = [], pillared = [];
    for (const handle of inputs) {
      stream.push(await run(identity, handle, W, H));
      pillared.push(await run(pillar, handle, 640, 480));
    }
    // Same frames, same fresh state: the 640×480 session is the identity session
    // un-letterboxed by the contract's nearest rule, exactly.
    for (const [index, frame] of stream.entries()) {
      const d = difference(expected(frame.values, 640, 480), pillared[index].values);
      assert.equal(d.max, 0, `frame ${index}: un-letterboxed result differs from the contract by ${d.max}`);
    }
    let lo = Infinity, hi = -Infinity;
    for (const frame of stream) for (const v of frame.values) { if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    const coverages = stream.map(frame => frame.coverage);
    assert.ok(coverages.every(c => c > 0 && c <= 1), 'coverage in (0, 1]');
    assert.ok(lo > 0 && hi < 50 && hi > lo, `implausible inverse_depth range [${lo}, ${hi}]`);

    // Temporal state: frame k after a reset (no history) is not frame k in the stream;
    // frame 0 after a reset IS frame 0 of the stream, so reset really starts afresh.
    await identity.reset();
    const fresh0 = await run(identity, inputs[0], W, H);
    await identity.reset();
    const late = Math.min(5, frameCount - 1);
    const freshLate = await run(identity, inputs[late], W, H);
    const restart = difference(stream[0].values, fresh0.values);
    const history = difference(stream[late].values, freshLate.values);
    assert.equal(restart.max, 0, `a reset stream did not reproduce its first frame (max ${restart.max})`);
    assert.ok(history.max > 0 && history.mean > 1e-4, `frame ${late} ignored its stream history (mean ${history.mean})`);
    const warm = stream.slice(2).map(frame => frame.millis), warmPillar = pillared.slice(2).map(frame => frame.millis);
    await identity.close(); await pillar.close();

    const timings = {};
    for (const name of timing) {
      const [w, h] = depthFunctionSize(name);
      const worker = await workers.open([compiled, name]);
      const packed = frames(w, h, 10).list.map(bytes => fixture.packed(bytes, w, h));
      const times = [];
      try {
        for (const handle of packed) {
          const t = performance.now();
          const result = await worker.infer(handle, [w, h], [w, h]);
          times.push(performance.now() - t);
          await worker.release(result.sequence);
        }
      } finally { for (const handle of packed) fixture.release(handle); }
      await worker.close();
      timings[name] = Number(median(times.slice(2)).toFixed(1));
    }
    assert.equal((await readdir(directory)).filter(name => /^depth-worker-.*\.plist$/.test(name)).length, 0);
    console.log('DEPTH_SMOKE_PASS', JSON.stringify({ modelId, function: FUNCTION, frames: frameCount, source,
      inverseDepth: { min: lo, max: hi }, coverage: { min: Math.min(...coverages), max: Math.max(...coverages) },
      stateReuse: { frame: late, maxDifference: history.max, meanDifference: history.mean },
      medianMillis: { [`${FUNCTION}→${W}x${H}`]: Number(median(warm).toFixed(1)), [`${FUNCTION}→640x480`]: Number(median(warmPillar).toFixed(1)),
        ...Object.fromEntries(Object.entries(timings).map(([name, ms]) => [`${name}→identity`, ms])) } }));
  } finally {
    for (const handle of inputs) fixture.release(handle);
    await retireVisionServices(directory);
  }
} catch (error) { failure = error; }
try { await rm(directory, { recursive: true }); }
catch (error) { failure = failure ? new AggregateError([failure, error], 'Depth smoke and cleanup failed') : error; }
if (failure) throw failure;
