/* global queueMicrotask */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers';
import { receiveSyphon } from './testing/syphon-receiver.mjs';
import { ndiProofCommands, runNdiRoundtrip, receiveNdiOutput, ndiReceiveSeconds, ndiReceiveCounts } from './testing/ndi-roundtrip.mjs';
import { ndiOutputContractCommand, runNdiOutputContract } from './testing/ndi-output-contract.mjs';
import { ndiOutputMode } from '../devices/native/ndi-build.mjs';

test('receiver waits for stdio closure before parsing its final report', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  let settled = false;
  const result = receiveSyphon('/test-receiver', 'sender', 3, () => child).finally(() => { settled = true; });
  child.stdout.emit('data', '{"ok":');
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.emit('data', 'true}\n');
  child.emit('close', 0, null);
  assert.deepEqual(await result, { ok: true });
});

test('duration receiver has a bounded native deadline and parent watchdog', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = receiveSyphon('/test-receiver', 'sender', { seconds: 60 }, (executable, args, options) => {
    assert.equal(executable, '/test-receiver');
    assert.deepEqual(args, ['sender', '--seconds', '60', '75000']);
    assert.deepEqual(options, { timeout: 80000, killSignal: 'SIGKILL' });
    return child;
  });
  child.stderr.emit('data', 'receiver watchdog expired');
  child.emit('close', 1, null);
  await assert.rejects(result, /receiver watchdog expired/);
});

test('animated receiver explicitly selects barcode validation', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const result = receiveSyphon('/test-receiver', 'sender', { seconds: 10, animated: true }, (_, args) => {
    assert.deepEqual(args, ['sender', '--animated-seconds', '10', '25000']);
    return child;
  });
  child.stdout.emit('data', '{"ok":true}');
  child.emit('close', 0, null);
  assert.deepEqual(await result, { ok: true });
});
test('NDI proof binds only an explicitly selected SDK and bounds both child processes', () => {
  const commands = ndiProofCommands('/approved SDK', '/owned temp', '/source.cpp', 'unique sender');
  assert.equal(commands[0].executable, 'clang++');
  assert.ok(commands[0].args.includes('/approved SDK/lib/macOS/libndi.dylib'));
  assert.ok(commands[0].args.includes('-Wl,-rpath,/approved SDK/lib/macOS'));
  assert.equal(commands[0].timeout, 60000);
  assert.deepEqual(commands[1], { executable: '/owned temp/ndi-roundtrip', args: ['--send', 'unique sender'], timeout: 30000 });
  assert.throws(() => ndiProofCommands('relative', '/owned', '/source.cpp', 'name'), /absolute/);
});

test('NDI cancellation stops the owned receiver and awaits sender drainage before cleanup', async () => {
  const cancellation = { interrupted: false, stop: undefined };
  const children = [], signals = [];
  let acquired;
  const receiving = new Promise(resolve => { acquired = resolve; });
  const spawn = (_file, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null,
      kill(signal) { signals.push([args[0], signal]); this.signalCode = signal; queueMicrotask(() => this.emit('close', null, signal)); },
    });
    children.push(child);
    if (args[0] === '--send') {
      queueMicrotask(() => child.stdout.write('{"name":"exact synthetic source"}\n'));
      child.stdin.on('data', data => {
        assert.equal(data.toString(), 'STOP\n');
        queueMicrotask(() => {
          child.stdout.write('{"drained":true}\n');
          child.exitCode = 0; child.emit('close', 0, null);
        });
      });
    } else {
      assert.deepEqual(args, ['--receive', 'exact synthetic source']);
      acquired();
    }
    return child;
  };
  const result = runNdiRoundtrip({ executable: '/owned/proof', args: ['--send', 'unique'], timeout: 30000 }, cancellation, spawn);
  const rejected = assert.rejects(result, /NDI receiver failed: SIGTERM/);
  await receiving;
  cancellation.interrupted = true;
  cancellation.stop();
  await rejected;
  assert.deepEqual(signals, [['--receive', 'SIGTERM']]);
  assert.equal(children[0].exitCode, 0);
  assert.equal(cancellation.stop, undefined);
});

test('NDI receiver error cannot complete cleanup before receiver stdio closes', async () => {
  const sender = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, kill() {},
  });
  const receiver = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
  sender.stdin.on('data', () => {
    sender.stdout.write('{"drained":true}\n');
    sender.exitCode = 0; sender.emit('close', 0, null);
  });
  let settled = false, acquired;
  const receiving = new Promise(resolve => { acquired = resolve; });
  const result = runNdiRoundtrip({ executable: '/owned/proof', args: ['--send', 'unique'], timeout: 30000 },
    { interrupted: false }, (_file, args) => {
      if (args[0] === '--send') {
        queueMicrotask(() => sender.stdout.write('{"name":"exact source"}\n'));
        return sender;
      }
      acquired(); return receiver;
    }).finally(() => { settled = true; });
  const rejected = assert.rejects(result, /receiver transport error/);
  await receiving;
  receiver.emit('error', new Error('receiver transport error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sender.exitCode, 0);
  assert.equal(settled, false);
  receiver.emit('close', 1, null);
  await rejected;
});

test('NDI app consumer failure still drains its sole sender before rejecting', async () => {
  const sender = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null, kill() {},
  });
  let stopped, settled = false, spawns = 0;
  const stopping = new Promise(resolve => { stopped = resolve; });
  sender.stdin.on('data', data => { assert.equal(data.toString(), 'STOP\n'); stopped(); });
  const cancellation = {};
  const result = runNdiRoundtrip({ executable: '/owned/proof', args: ['--send', 'unique'], timeout: 30000 },
    cancellation, () => {
      spawns++;
      queueMicrotask(() => sender.stdout.write('{"name":"exact source"}\n'));
      return sender;
    }, async source => {
      assert.equal(source.name, 'exact source');
      throw new Error('App pixel mismatch');
    }).finally(() => { settled = true; });
  const rejected = assert.rejects(result, /App pixel mismatch/);
  await stopping;
  assert.equal(spawns, 1);
  assert.equal(settled, false);
  sender.stdout.write('{"drained":true}\n');
  sender.exitCode = 0; sender.emit('close', 0, null);
  await rejected;
  assert.equal(cancellation.stop, undefined);
});

test('independent NDI app receiver validates the final report only after process closure', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  let done = false;
  const result = receiveNdiOutput('/owned/receiver', 'Exact source', (executable, args, options) => {
    assert.equal(executable, '/owned/receiver');
    assert.deepEqual(args, ['--receive-app', 'Exact source']);
    assert.equal(options.timeout, 20000);
    return child;
  }).finally(() => { done = true; });
  child.stdout.emit('data', '{"ok":true,"unique":120,"width":1920,');
  child.emit('exit', 0, null);
  await Promise.resolve(); assert.equal(done, false);
  child.stdout.emit('data', '"height":1080,"first120Ms":2000}');
  child.emit('close', 0, null);
  assert.equal((await result).unique, 120);
});

test('independent NDI receiver error cannot release its executable before close', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  let done = false;
  const result = receiveNdiOutput('/owned/receiver', 'Exact source', () => child).finally(() => { done = true; });
  const rejected = assert.rejects(result, /spawn failed/);
  child.emit('error', new Error('spawn failed'));
  await Promise.resolve(); assert.equal(done, false);
  child.emit('close', -1, null); await rejected;
});

test('NDI sustained duration is explicit and bounded without changing the default smoke', () => {
  assert.equal(ndiReceiveSeconds(undefined), 0);
  assert.equal(ndiReceiveSeconds('60'), 60);
  assert.equal(ndiReceiveSeconds('600'), 600);
  for (const value of ['', '0', '-1', '601', '1.5', 'Infinity', ' 60 ', '1e2', NaN])
    assert.throws(() => ndiReceiveSeconds(value), /integer from 1 to 600/);
});

test('NDI stream selection scopes measurements without weakening the default matrix', () => {
  assert.deepEqual(ndiReceiveCounts(undefined), [1, 2, 4]);
  for (const count of [1, 2, 4]) assert.deepEqual(ndiReceiveCounts(String(count)), [count]);
  for (const value of ['', '0', '3', '5', '1,2', ' 4 ', '4.0'])
    assert.throws(() => ndiReceiveCounts(value), /must be 1, 2 or 4/);
});

test('NDI direct publication is an explicit experiment, never an automatic fallback', () => {
  assert.equal(ndiOutputMode(undefined), 'staged');
  assert.equal(ndiOutputMode('direct'), 'direct');
  for (const value of ['', 'auto', 'DIRECT', '1']) assert.throws(() => ndiOutputMode(value), /staged or direct/);
  const command = ndiOutputContractCommand('/owned/addon', '/owned/fixture', 'direct');
  assert.equal(command.outputMode, 'direct');
  assert.equal(command.args.at(-1), 'direct');
});

test('NDI sustained receiver requires continuous coverage and retains its child until close', async () => {
  for (const activeSeconds of [undefined, 2, 60]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    let done = false;
    const result = receiveNdiOutput('/owned/receiver', 'Exact source', (_executable, args, options) => {
      assert.deepEqual(args, ['--receive-app', 'Exact source', '60']);
      assert.equal(options.timeout, 80000);
      return child;
    }, 60).finally(() => { done = true; });
    const checked = activeSeconds === 60 ? result : assert.rejects(result, /continuous interval/);
    child.stdout.emit('data', JSON.stringify({ ok: true, unique: 3600, width: 1920, height: 1080,
      requestedSeconds: 60, activeSeconds, gpuSurfaceSamplesPerFrame: 66, first120Ms: 2000 }));
    child.emit('exit', 0, null);
    await Promise.resolve(); assert.equal(done, false);
    child.emit('close', 0, null);
    await checked;
  }
});

test('NDI CPU measurement cannot silently replace the default GPU proof', async () => {
  assert.throws(() => receiveNdiOutput('/owned/receiver', 'source', undefined, 0, true), /explicit duration/);
  for (const gpuSurfaceSamplesPerFrame of [0, 66]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const result = receiveNdiOutput('/owned/receiver', 'source', (_executable, args) => {
      assert.deepEqual(args, ['--receive-app-cpu', 'source', '60']);
      return child;
    }, 60, true);
    const checked = gpuSurfaceSamplesPerFrame === 0 ? result : assert.rejects(result, /wrong measurement oracle/);
    child.stdout.emit('data', JSON.stringify({ ok: true, unique: 3600, width: 1920, height: 1080,
      requestedSeconds: 60, activeSeconds: 60, gpuSurfaceSamplesPerFrame, first120Ms: 2000 }));
    child.emit('close', 0, null);
    await checked;
  }
});

test('NDI receiver cannot report success when its 120th frame completes past the startup deadline', async () => {
  for (const first120Ms of [undefined, 0, 15000, 15001]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const result = receiveNdiOutput('/owned/receiver', 'source', () => child);
    const checked = assert.rejects(result, /initial 120-frame deadline/);
    child.stdout.emit('data', JSON.stringify({ ok: true, unique: 120, width: 1920, height: 1080, first120Ms }));
    child.emit('close', 0, null);
    await checked;
  }
});

test('native NDI contract pins one worker and awaits child close after spawn failure', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, kill() {},
  });
  const command = ndiOutputContractCommand('/owned/addon.node', '/owned/fixture.node');
  assert.equal(command.timeout, 15000);
  assert.throws(() => ndiOutputContractCommand('relative', '/owned/fixture.node'), /absolute/);
  let done = false;
  const cancellation = {};
  const result = runNdiOutputContract(command, cancellation, (_file, _args, options) => {
    assert.equal(options.env.UV_THREADPOOL_SIZE, '1');
    return child;
  }).finally(() => { done = true; });
  const rejected = assert.rejects(result, /spawn failed/);
  child.emit('error', new Error('spawn failed'));
  await Promise.resolve(); assert.equal(done, false);
  child.emit('close', -1, null); await rejected;
  assert.equal(cancellation.stop, undefined);
});
