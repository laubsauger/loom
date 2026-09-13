import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

// Explicit development SDK only. Never install, copy, discover or bundle it.
export function ndiProofCommands(sdk, directory, source, name) {
  if (!isAbsolute(sdk) || !isAbsolute(directory) || !isAbsolute(source))
    throw new Error('NDI proof requires absolute SDK, temporary and source paths');
  const library = join(sdk, 'lib/macOS');
  const executable = join(directory, 'ndi-roundtrip');
  return [
    { executable: 'clang++', args: ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-fobjc-arc',
      '-I', join(sdk, 'include'), source, join(dirname(source), 'ndi-surface-oracle.mm'),
      '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'Metal', join(library, 'libndi.dylib'),
      `-Wl,-rpath,${library}`, '-o', executable], timeout: 60000 },
    { executable, args: ['--send', name], timeout: 30000 },
  ];
}

export function buildNdiProof(sdk, directory) {
  const source = fileURLToPath(new URL('./ndi-roundtrip.cpp', import.meta.url));
  const [command, sender] = ndiProofCommands(sdk, directory, source, `Loom synthetic ${randomUUID()}`);
  const result = spawnSync(command.executable, command.args, {
    stdio: 'inherit', timeout: command.timeout, killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NDI proof failed: ${result.status ?? result.signal}`);
  return sender;
}

export async function runNdiRoundtrip(command, cancellation, spawnProcess = spawn, consume) {
  const sender = spawnProcess(command.executable, command.args, {
    stdio: ['pipe', 'pipe', 'inherit'], timeout: command.timeout, killSignal: 'SIGKILL',
  });
  let fault, receiver, drained = false, records = 0, resolveReady, rejectReady;
  let receiverClosed = Promise.resolve();
  const stop = () => {
    if (receiver && receiver.exitCode === null && receiver.signalCode === null) receiver.kill('SIGTERM');
    if (sender.exitCode === null && sender.signalCode === null && !sender.stdin.destroyed && !sender.stdin.writableEnded)
      sender.stdin.end('STOP\n');
  };
  cancellation.stop = stop;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const lines = createInterface({ input: sender.stdout });
  const fail = error => { fault = error; rejectReady(error); sender.kill('SIGKILL'); };
  sender.stdin.on('error', fail);
  lines.on('line', line => {
    try {
      const record = JSON.parse(line);
      records++;
      if (records === 1) {
        if (typeof record.name !== 'string' || !record.name)
          throw new Error('NDI sender returned no exact source identity');
        resolveReady(record);
      } else if (records === 2 && record.drained === true) {
        drained = true;
        process.stdout.write(`NDI_SENDER_DRAINED ${line}\n`);
      } else throw new Error('Unexpected NDI sender report');
    } catch (error) { fail(error); }
  });
  const closed = new Promise(resolve => {
    sender.on('error', error => { fault = error; rejectReady(error); });
    sender.on('close', (code, signal) => {
      if (!records) rejectReady(fault ?? new Error(`NDI sender closed before identity: ${code ?? signal}`));
      resolve({ code, signal });
    });
  });
  try {
    const source = await ready;
    if (cancellation.interrupted) throw new Error('NDI proof interrupted');
    if (consume) await consume(source, async () => { stop(); await closed; });
    else await new Promise((resolve, reject) => {
      receiver = spawnProcess(command.executable, ['--receive', source.name], {
        stdio: 'inherit', timeout: 20000, killSignal: 'SIGKILL',
      });
      receiverClosed = new Promise(done => receiver.once('close', done));
      receiver.on('error', reject);
      receiver.on('close', (code, signal) => code === 0 ? resolve()
        : reject(new Error(`NDI receiver failed: ${code ?? signal}`)));
    });
  } finally {
    stop();
    await Promise.all([closed, receiverClosed]);
    lines.close();
    cancellation.stop = undefined;
  }
  const result = await closed;
  if (fault) throw fault;
  if (result.code !== 0 || !drained) throw new Error(`NDI sender did not drain: ${result.code ?? result.signal}`);
}

export function ndiReceiveSeconds(value) {
  if (value === undefined) return 0;
  if (!/^[0-9]+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 600)
    throw new Error('LOOM_DESKTOP_NDI_RECEIVE_SECONDS must be an integer from 1 to 600');
  return Number(value);
}

export function ndiReceiveCounts(value) {
  if (value === undefined) return [1, 2, 4];
  if (!/^(1|2|4)$/.test(String(value))) throw new Error('LOOM_DESKTOP_NDI_STREAM_COUNT must be 1, 2 or 4');
  return [Number(value)];
}

export function receiveNdiOutput(executable, source, spawnProcess = spawn, seconds = 0, cpuMeasurement = false) {
  if (seconds !== 0) seconds = ndiReceiveSeconds(seconds);
  if (cpuMeasurement && !seconds) throw new Error('CPU-only NDI measurement requires an explicit duration');
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, [cpuMeasurement ? '--receive-app-cpu' : '--receive-app', source, ...(seconds ? [String(seconds)] : [])], {
      timeout: (seconds + 20) * 1000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '', failure;
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    child.on('error', error => { failure = error; });
    // Even spawn/transport failure does not retire the executable before close.
    child.on('close', (code, signal) => {
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`NDI app receiver failed: ${code ?? signal}: ${errors}`)); return; }
      try {
        const result = JSON.parse(output);
        if (result.ok !== true || (seconds ? !Number.isInteger(result.unique) || result.unique < 120 : result.unique !== 120)
          || result.width !== 1920 || result.height !== 1080)
          throw new Error('NDI app receiver returned an incomplete full-HD proof');
        if (!Number.isFinite(result.first120Ms) || result.first120Ms <= 0 || result.first120Ms >= 15000)
          throw new Error('NDI app receiver missed its initial 120-frame deadline');
        if (seconds && (result.requestedSeconds !== seconds || !Number.isFinite(result.activeSeconds) || result.activeSeconds < seconds))
          throw new Error('NDI app receiver did not cover the requested continuous interval');
        if (seconds && result.gpuSurfaceSamplesPerFrame !== (cpuMeasurement ? 0 : 66))
          throw new Error('NDI app receiver used the wrong measurement oracle');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This NDI transport proof currently targets macOS');
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--sdk' || !isAbsolute(args[1]))
    throw new Error('Usage: pnpm desktop:ndi-test --sdk /absolute/path/to/approved/SDK');
  const sdk = await realpath(args[1]);
  await access(join(sdk, 'include/Processing.NDI.Lib.h'));
  await access(join(sdk, 'lib/macOS/libndi.dylib'));
  const directory = await mkdtemp(join(tmpdir(), 'loom-ndi-proof-'));
  const cancellation = { interrupted: false, stop: undefined };
  const interrupt = () => { cancellation.interrupted = true; cancellation.stop?.(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const sender = buildNdiProof(sdk, directory);
    if (cancellation.interrupted) throw new Error('NDI proof interrupted');
    await runNdiRoundtrip(sender, cancellation);
    if (cancellation.interrupted) throw new Error('NDI proof interrupted');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await rm(directory, { recursive: true, force: true }); // Only the mkdtemp-owned binary directory.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
