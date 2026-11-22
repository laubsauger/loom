import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDepthModels, depthSupport, validateDepthManifest } from './depth-models.mjs';

const { Response, ReadableStream, AbortController } = globalThis;
const shipped = createRequire(import.meta.url)('./depth-model-manifest.json');
const REVISION = shipped.revision;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const FILES = [
  { path: 'depthpro2-s_w4.mlpackage/Manifest.json', data: Buffer.from('{"manifest":true}') },
  { path: 'depthpro2-s_w4.mlpackage/Data/com.apple.CoreML/weights/weight.bin', data: Buffer.alloc(3 * 1024 * 1024 + 7, 9) },
];
const manifest = { ...shipped, models: [{ id: 'depthpro2-s-coreml', label: 'Depth Pro 2 S', package: 'depthpro2-s_w4.mlpackage',
  totalBytes: FILES.reduce((sum, file) => sum + file.data.length, 0),
  files: FILES.map(file => ({ path: file.path, url: `https://models.example/${REVISION}/${file.path}`, bytes: file.data.length,
    sha256: digest(file.data) })) }] };

async function fixture(t, { serve = file => file.data, built = true, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'loom-depth-models-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compiler = join(root, 'bin/depth-compile'), library = join(root, 'bin/depth-service.dylib');
  if (built) { await mkdir(join(root, 'bin')); await writeFile(compiler, ''); await writeFile(library, ''); }
  const fetches = [], compiles = [];
  const fetch = async (url, init) => {
    fetches.push({ url, range: init.headers.Range });
    const file = FILES.find(candidate => url.endsWith(candidate.path));
    assert.ok(file, `fetches only pinned URLs: ${url}`);
    const bytes = serve(file, init);
    const start = init.headers.Range ? Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]) : 0;
    const body = bytes.subarray(start);
    return new Response(body, { status: start ? 206 : 200, headers: { 'content-length': String(body.length),
      ...(start ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) } });
  };
  // The real compiler writes an .mlmodelc directory and reports the functions it opened.
  const run = options.run ?? (async (file, args) => {
    compiles.push(args);
    assert.equal(file, compiler);
    await mkdir(join(args[1], 'weights'), { recursive: true });
    await writeFile(join(args[1], 'model.mil'), 'program');
    await writeFile(join(args[1], 'weights/weight.bin'), 'compiled');
    return { stdout: `${JSON.stringify({ kind: 'compiled', functions: manifest.functions })}\n` };
  });
  const cache = join(root, 'cache');
  const models = createDepthModels({ directory: cache, manifest, compiler, library, fetch, run,
    platform: 'darwin', arch: 'arm64', release: '24.1.0', ...options });
  return { root, cache, models, fetches, compiles };
}
const id = 'depthpro2-s-coreml';
const collect = () => { const events = []; return { events, push: progress => events.push(progress) }; };

test('the shipped manifest pins Apple\'s revision for exactly S and B and the five stream functions', () => {
  const value = validateDepthManifest(shipped);
  assert.deepEqual(value.models.map(model => model.id), ['depthpro2-s-coreml', 'depthpro2-b-coreml']);
  assert.deepEqual(value.functions, ['res_640x360', 'res_854x480', 'res_896x512', 'res_1138x640', 'res_1280x720']);
  for (const model of value.models) for (const file of model.files)
    assert.ok(file.url.startsWith(`https://huggingface.co/apple/DepthPro2-coreml/resolve/${REVISION}/${model.package}/`));
  assert.throws(() => validateDepthManifest({ ...shipped, models: [{ ...shipped.models[0],
    files: [{ ...shipped.models[0].files[0], url: shipped.models[0].files[0].url.replace(REVISION, 'main') }, ...shipped.models[0].files.slice(1)] }] }),
  /file manifest/, 'an unpinned revision would let the bytes behind a hash-free name change');
  assert.throws(() => validateDepthManifest({ ...shipped, models: [{ ...shipped.models[0], totalBytes: 1 }] }), /model manifest/);
});

test('probe never fetches or compiles, and says why the route is unavailable', async t => {
  for (const [options, reason] of [[{ arch: 'x64' }, /Apple Silicon/], [{ platform: 'linux' }, /Apple Silicon/],
    [{ release: '23.6.0' }, /macOS 15 or later/], [{ built: false }, /not built/]]) {
    const h = await fixture(t, options);
    const probe = await h.models.probe();
    assert.equal(probe.available, false);
    assert.match(probe.reason, reason);
    assert.deepEqual(probe.models, [{ id, bytes: manifest.models[0].totalBytes, cached: false }]);
    await assert.rejects(h.models.prepare(id), reason);
    await assert.rejects(h.models.compiled(id), reason, 'an open on an unsupported Mac says why, not a worker crash');
    assert.equal(h.fetches.length + h.compiles.length, 0);
  }
  assert.deepEqual(depthSupport({ platform: 'darwin', arch: 'arm64', release: '24.0.0' }), { supported: true });
  assert.equal(depthSupport({ platform: 'darwin', arch: 'arm64', release: '25.6.0' }).supported, true, 'macOS 26 is Darwin 25');
});

test('prepare downloads the pinned bytes, compiles once, and a cached model is never touched again', async t => {
  const h = await fixture(t), progress = collect();
  assert.equal((await h.models.probe()).models[0].cached, false);
  await assert.rejects(h.models.compiled(id), /not downloaded/, 'opening never acquires');
  await h.models.prepare(id, progress.push);
  assert.deepEqual(h.fetches.map(f => f.url), manifest.models[0].files.map(file => file.url));
  assert.equal(h.compiles.length, 1);
  for (const file of FILES) assert.deepEqual(await readFile(join(h.cache, id, file.path)), file.data);
  const downloading = progress.events.filter(event => event.phase === 'downloading');
  assert.ok(downloading.every((event, i) => event.total === manifest.models[0].totalBytes &&
    (i === 0 || event.received >= downloading[i - 1].received)));
  assert.equal(downloading.at(-1).received, manifest.models[0].totalBytes);
  assert.equal(progress.events.at(-1).phase, 'compiling');
  const probe = await h.models.probe();
  assert.deepEqual(probe, { available: true, models: [{ id, bytes: manifest.models[0].totalBytes, cached: true }] });
  assert.equal(await h.models.compiled(id), join(h.cache, id, 'compiled/depthpro2-s_w4.mlmodelc'));
  const again = collect();
  await h.models.prepare(id, again.push);
  assert.deepEqual(again.events, []);
  assert.equal(h.fetches.length, FILES.length); assert.equal(h.compiles.length, 1);
});

test('bytes that fail verification are discarded and never compiled or reported cached', async t => {
  const h = await fixture(t, { serve: file => file.path.endsWith('weight.bin') ? Buffer.alloc(file.data.length, 8) : file.data });
  await assert.rejects(h.models.prepare(id), /failed verification and was discarded/);
  const weights = join(h.cache, id, FILES[1].path);
  await assert.rejects(stat(weights), { code: 'ENOENT' });
  await assert.rejects(stat(`${weights}.incomplete`), { code: 'ENOENT' }, 'a provably wrong partial is not resumed');
  assert.equal(h.compiles.length, 0);
  assert.equal((await h.models.probe()).models[0].cached, false);
});

test('an interrupted download resumes with an exact range, and a server that ignores it is refused', async t => {
  const h = await fixture(t);
  const weights = join(h.cache, id, FILES[1].path);
  await mkdir(dirname(weights), { recursive: true });
  await writeFile(`${weights}.incomplete`, FILES[1].data.subarray(0, 1024));
  await h.models.prepare(id);
  assert.equal(h.fetches.find(f => f.url.endsWith('weight.bin')).range, `bytes=1024-${FILES[1].data.length - 1}`);
  assert.deepEqual(await readFile(weights), FILES[1].data);

  // A server answering a range with the whole file would splice two copies into one.
  const ignoring = await fixture(t, { fetch: async url => new Response(FILES.find(file => url.endsWith(file.path)).data, { status: 200 }) });
  const partial = join(ignoring.cache, id, `${FILES[1].path}.incomplete`);
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(partial, FILES[1].data.subarray(0, 1024));
  await assert.rejects(ignoring.models.prepare(id), /refused \(HTTP 200\)/);
  assert.equal(ignoring.compiles.length, 0);
});

test('an aborted acquisition stops, keeps its verified partial, and the next prepare resumes it', async t => {
  const chunked = bytes => new ReadableStream({ start() { this.offset = 0; }, pull(controller) {
    if (this.offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(new Uint8Array(bytes.subarray(this.offset, this.offset += 65536)));
  } });
  const h = await fixture(t, { fetch: async (url, init) => {
    const file = FILES.find(candidate => url.endsWith(candidate.path));
    const start = init.headers.Range ? Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]) : 0;
    return new Response(chunked(file.data.subarray(start)), { status: start ? 206 : 200, headers: start
      ? { 'content-range': `bytes ${start}-${file.data.length - 1}/${file.data.length}` } : {} });
  } });
  const abort = new AbortController();
  // The document leaves after a megabyte of the weights has been written.
  await assert.rejects(h.models.prepare(id, progress => {
    if (progress.phase === 'downloading' && progress.received > FILES[0].data.length + 1024 * 1024) abort.abort(new Error('document left'));
  }, abort.signal), /document left/);
  const kept = (await stat(join(h.cache, id, `${FILES[1].path}.incomplete`))).size;
  assert.ok(kept > 1024 * 1024 && kept < FILES[1].data.length, `kept ${kept}`);
  await assert.rejects(stat(join(h.cache, id, FILES[1].path)), { code: 'ENOENT' });
  assert.equal(h.compiles.length, 0);
  await h.models.prepare(id);
  assert.deepEqual(await readFile(join(h.cache, id, FILES[1].path)), FILES[1].data);
  assert.equal(h.compiles.length, 1);
});

test('a failed compile leaves nothing cached and the retry compiles without downloading again', async t => {
  let fail = true;
  const compiles = [];
  const h = await fixture(t, { run: async (file, args) => {
    compiles.push(args);
    await mkdir(args[1], { recursive: true });
    await writeFile(join(args[1], 'model.mil'), 'program');
    if (fail) return { stdout: JSON.stringify({ kind: 'compiled', functions: ['res_854x480'] }) };
    return { stdout: JSON.stringify({ kind: 'compiled', functions: manifest.functions }) };
  } });
  await assert.rejects(h.models.prepare(id), /without the pinned stream functions/);
  assert.equal((await h.models.probe()).models[0].cached, false);
  assert.deepEqual((await readdir(join(h.cache, id))).filter(name => name.startsWith('compil')), [], 'no half-made model is left to open');
  fail = false;
  await h.models.prepare(id);
  assert.equal(h.fetches.length, FILES.length, 'verified package files are re-hashed, not re-downloaded');
  assert.equal(compiles.length, 2);
  assert.equal((await h.models.probe()).models[0].cached, true);
});

test('a cache changed after preparation is not ready: it is refused to open and its corrupt package refuses to prepare', async t => {
  const h = await fixture(t);
  await h.models.prepare(id);
  const compiledFile = join(h.cache, id, 'compiled/depthpro2-s_w4.mlmodelc/weights/weight.bin');
  await writeFile(compiledFile, 'tampered!');
  assert.equal((await h.models.probe()).models[0].cached, false);
  await assert.rejects(h.models.compiled(id), /not downloaded/);
  await h.models.prepare(id);
  assert.equal(h.compiles.length, 2, 'a stale compiled model is derived data and is rebuilt');
  assert.equal((await h.models.probe()).models[0].cached, true);
  const weights = join(h.cache, id, FILES[1].path);
  await writeFile(weights, Buffer.alloc(FILES[1].data.length, 1));
  const time = new Date(Date.now() - 60000);
  await utimes(weights, time, time);
  assert.equal((await h.models.probe()).models[0].cached, false);
  await assert.rejects(h.models.prepare(id), /corrupt; remove it before retrying/);
  assert.equal(h.compiles.length, 2);
});

test('unknown models and concurrent preparation of one model are refused', async t => {
  const h = await fixture(t);
  await assert.rejects(h.models.prepare('depthpro2-l-coreml'), /Unknown Depth Pro 2 model/);
  await assert.rejects(h.models.compiled('depthpro2-l-coreml'), /Unknown Depth Pro 2 model/);
  const first = h.models.prepare(id);
  await assert.rejects(h.models.prepare(id), /already being prepared/);
  await first;
});
