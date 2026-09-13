import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { buildNativeNdi, ndiOutputMode } from '../../devices/native/ndi-build.mjs';

const script = fileURLToPath(import.meta.url);
const timingStages = ['queueNs', 'setupNs', 'surfaceLockNs', 'surfaceCopyNs', 'surfaceUnlockNs',
  'sdkSendNs', 'workerOtherNs', 'deliveryNs'];

function assertTiming(timing, samples) {
  assert.deepEqual(Object.keys(timing).sort(), ['samples', ...timingStages, 'totalNs'].sort());
  assert.equal(timing.samples, samples);
  for (const field of [...timingStages, 'totalNs']) {
    assert.ok(Number.isSafeInteger(timing[field]) && timing[field] >= 0, `Invalid ${field}`);
    if (samples === 0) assert.equal(timing[field], 0);
  }
  assert.equal(timing.totalNs, timingStages.reduce((total, field) => total + timing[field], 0));
  if (samples > 0) {
    for (const field of ['queueNs', 'surfaceLockNs', 'surfaceCopyNs', 'surfaceUnlockNs', 'sdkSendNs', 'totalNs'])
      assert.ok(timing[field] > 0, field);
  }
}

export function ndiOutputContractCommand(addon, fixture, outputMode = 'staged') {
  if (!isAbsolute(addon) || !isAbsolute(fixture)) throw new Error('NDI contract requires absolute addon paths');
  ndiOutputMode(outputMode);
  return { executable: process.execPath, args: [script, '--child', addon, fixture, outputMode], timeout: 15000, outputMode };
}

// Always await child close, including spawn errors, timeout, and cancellation,
// before the caller deletes the directory holding its loaded native libraries.
export async function runNdiOutputContract(command, cancellation, spawnProcess = spawn) {
  if (cancellation.interrupted) throw new Error('NDI output contract interrupted');
  const child = spawnProcess(command.executable, command.args, {
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: command.timeout, killSignal: 'SIGKILL',
  });
  let output = '', errors = '', fault;
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  cancellation.stop = stop;
  const closed = new Promise(resolve => {
    child.on('error', error => { fault = error; });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const read = (chunk, errorStream) => {
    if (fault) return;
    if (errorStream) errors += String(chunk); else output += String(chunk);
    if (output.length + errors.length > 65536) {
      fault = new Error('NDI output contract exceeded its diagnostic output limit');
      child.kill('SIGKILL');
    }
  };
  child.stdout.on('data', chunk => read(chunk, false));
  child.stderr.on('data', chunk => read(chunk, true));
  try {
    const result = await closed;
    if (fault) throw fault;
    if (cancellation.interrupted) throw new Error('NDI output contract interrupted');
    if (result.code !== 0) throw new Error(`NDI output contract failed: ${result.code ?? result.signal}: ${errors}`);
    const report = JSON.parse(output);
    const { publicationTiming, mode, ...counters } = report;
    assert.equal(mode, command.outputMode);
    assert.deepEqual(counters, {
      ok: true, workers: 1, publishers: 0, stagingBytes: 0, stagingBuffers: 0,
      bufferAllocations: mode === 'direct' ? 0 : 8, publishedFrames: 4,
    });
    assertTiming(publicationTiming, report.publishedFrames);
    return report;
  } finally { cancellation.stop = undefined; }
}

async function childMain(addon, fixture, outputMode) {
  ndiOutputMode(outputMode);
  if (!isAbsolute(addon) || !isAbsolute(fixture)) throw new Error('NDI contract requires absolute addon paths');
  assert.equal(process.env.UV_THREADPOOL_SIZE, '1');
  const require = createRequire(import.meta.url);
  const { handle } = require(fixture);
  const { output } = require(addon);
  const names = Array.from({ length: 4 }, (_, index) => `Loom arrêt - stop proof ${randomUUID()} ${index}`);
  const invalidNames = Array.from('\\/:*?"<>|', character => `Loom invalid ${randomUUID()} ${character}`);
  const publications = [];
  let settledPublications;
  let failure;
  try {
    const { publicationTiming: initialTiming, mode: initialMode, ...initialCounters } = output.stats();
    assert.equal(initialMode, outputMode);
    assert.deepEqual(initialCounters, {
      publishers: 0, stagingBytes: 0, stagingBuffers: 0, bufferAllocations: 0, publishedFrames: 0,
    });
    assertTiming(initialTiming, 0);
    for (const name of invalidNames) {
      assert.throws(() => {
        // If validation regresses, keep the unexpected publication observed and
        // retire its exact requested name in finally before reporting failure.
        const publication = output.publish(handle, name);
        publications.push(publication);
        settledPublications = Promise.allSettled(publications);
      }, /reserved characters/);
      assert.deepEqual(output.stats(), { mode: initialMode, ...initialCounters, publicationTiming: initialTiming });
    }
    for (const name of names) publications.push(output.publish(handle, name));
    settledPublications = Promise.allSettled(publications);
    assert.throws(() => output.publish(handle, 'over capacity'), /capacity/);
    const stops = names.map(name => output.stop(name));
    for (let index = 0; index < names.length; index++) {
      assert.equal(output.stop(names[index]), stops[index]);
      assert.throws(() => output.publish(handle, names[index]), /in flight/);
    }
    await Promise.all([...publications, ...stops]);
    const { publicationTiming, mode, ...counters } = output.stats();
    assert.equal(mode, outputMode);
    assert.deepEqual(counters, {
      publishers: 0, stagingBytes: 0, stagingBuffers: 0, bufferAllocations: mode === 'direct' ? 0 : 8, publishedFrames: 4,
    });
    assertTiming(publicationTiming, counters.publishedFrames);
    await output.stop(names[0]); // Unknown/already stopped is idempotent.
  } catch (error) { failure = error; }
  finally {
    // Also retire all already-created publishers when an assertion fails early.
    const retirement = await Promise.allSettled([...names, ...invalidNames]
      .map(name => Promise.resolve().then(() => output.stop(name))));
    await (settledPublications ?? Promise.allSettled(publications));
    const failed = retirement.find(result => result.status === 'rejected');
    if (failed) failure = failure
      ? new AggregateError([failure, failed.reason], 'NDI output test and retirement failed') : failed.reason;
  }
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify({ ok: true, workers: 1, ...output.stats() })}\n`);
}

async function main(args) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('NDI output contract requires Apple Silicon macOS');
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--sdk' || !isAbsolute(args[1])
    || (args.length === 4 && args[2] !== '--output-mode'))
    throw new Error('Usage: node src/desktop/testing/ndi-output-contract.mjs --sdk /absolute/approved/SDK [--output-mode staged|direct]');
  const outputMode = ndiOutputMode(args[3]);
  const sdk = await realpath(args[1]);
  const directory = await mkdtemp(join(tmpdir(), 'loom-ndi-output-contract-'));
  const cancellation = { interrupted: false, stop: undefined };
  const interrupt = () => { cancellation.interrupted = true; cancellation.stop?.(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const addon = buildNativeNdi(directory, sdk, { outputMode });
    const fixture = join(directory, 'surface-fixture.node');
    const source = fileURLToPath(new URL('./ndi-output-contract.mm', import.meta.url));
    const build = spawnSync('clang++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-fobjc-arc',
      '-shared', '-undefined', 'dynamic_lookup', '-I', join(dirname(process.execPath), '../include/node'),
      '-framework', 'Foundation', '-framework', 'IOSurface', source, '-o', fixture],
    { stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL' });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`NDI output fixture build failed: ${build.status ?? build.signal}`);
    const report = await runNdiOutputContract(ndiOutputContractCommand(addon, fixture, outputMode), cancellation);
    process.stdout.write(`NDI_OUTPUT_SINGLE_WORKER_DRAIN_PASS ${JSON.stringify(report)}\n`);
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await rm(directory, { recursive: true, force: true }); // Exact mkdtemp-owned artifacts only; SDK remains external.
  }
}

if (process.argv[1] === script) {
  const args = process.argv.slice(2);
  if (args.length === 4 && args[0] === '--child') await childMain(args[1], args[2], args[3]);
  else await main(args);
}
