/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
function harness({ ndi = false, video = true } = {}) {
  let api, receive, handler = async name => name.endsWith('open') ? 'session' : { kind: 'sent' };
  const calls = [];
  const listeners = new Map();
  runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    process: { argv: [...(video ? ['--loom-native-video'] : []), ...(ndi ? ['--loom-ndi-input'] : [])] },
    Event: class { constructor(type) { this.type = type; } },
    window: { addEventListener(name, callback) { listeners.set(name, callback); }, dispatchEvent(event) { listeners.get(event.type)?.(event); } },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { assert.equal(Boolean(receive), video); api = value; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return handler(...args); } },
      sharedTexture: { setSharedTextureReceiver(callback) { receive = callback; } },
    }),
  });
  let framesClosed = 0, importsReleased = 0;
  const frame = { close() { framesClosed++; } };
  return { api, calls, pagehide: () => listeners.get('pagehide')(),
    beforeunload: () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; listeners.get('beforeunload')(event); return event; },
    handle(fn) { handler = fn; },
    deliver() { return receive({ importedSharedTexture: {
      getVideoFrame() { return frame; }, release() { importsReleased++; },
    } }, { session: 'session', sequence: 1, width: 1920, height: 1080 }); },
    get closed() { return framesClosed; }, get released() { return importsReleased; },
  };
}
test('receiver is registered first; references survive asynchronous consumption and close', async () => {
  const h = harness(); let finish;
  const id = await h.api.input.open('uuid', () => new Promise(resolve => { finish = resolve; }));
  const delivery = h.deliver();
  assert.equal(h.closed, 0); assert.equal(h.released, 0);
  await h.api.input.close(id);
  assert.equal(h.released, 0);
  finish(); await delivery;
  assert.equal(h.closed, 1); assert.equal(h.released, 1);
  await assert.rejects(h.api.input.poll(id), /closed or unknown/);
});

test('NDI capability is explicit and its sessions cannot be used through the Syphon bridge', async () => {
  assert.equal(harness().api.ndiInput, undefined);
  const h = harness({ ndi: true });
  h.handle(async name => name.includes('ndi') ? 'ndi-session' : 'syphon-session');
  const syphon = await h.api.input.open('uuid', () => {});
  const ndi = await h.api.ndiInput.open('Host (Feed)', () => {});
  await assert.rejects(h.api.ndiInput.poll(syphon), /transport does not own/);
  await assert.rejects(h.api.input.close(ndi), /transport does not own/);
  await h.api.ndiInput.close(ndi);
  assert.ok(h.calls.some(call => call[0] === 'loom-ndi-input-open'));
  assert.ok(h.calls.some(call => call[0] === 'loom-ndi-input-close'));
  await h.api.lifecycle.prepareForUnload();
  assert.equal(h.beforeunload().prevented, true);
  h.api.lifecycle.commitUnload();
  assert.equal(h.beforeunload().prevented, false);
});

test('preparation-only Spout nodes do not advertise an unimplemented desktop transport', () => {
  for (const options of [{}, { ndi: true }]) {
    const h = harness(options);
    assert.equal(h.api.spoutInput, undefined);
    assert.equal(h.api.spoutOutput, undefined);
    assert.equal(h.calls.length, 0);
  }
});
test('active inputs block unload until explicit preparation and native-drain commit', async () => {
  const h = harness();
  assert.equal(h.beforeunload().prevented, false);
  await h.api.input.open('uuid', () => {});
  assert.equal(h.beforeunload().prevented, true);
  await h.api.lifecycle.prepareForUnload();
  assert.equal(h.beforeunload().prevented, true);
  await assert.rejects(h.api.input.open('uuid', () => {}), /retiring/);
  h.api.lifecycle.commitUnload();
  assert.equal(h.beforeunload().prevented, false);
});
test('terminal poll result forgets the retired preload session without another IPC close', async () => {
  const h = harness(), id = await h.api.input.open('uuid', () => {});
  h.handle(async () => ({ kind: 'closed' }));
  assert.equal((await h.api.input.poll(id)).kind, 'closed');
  const calls = h.calls.length;
  await assert.rejects(h.api.input.poll(id), /closed or unknown/);
  await assert.rejects(h.api.input.close(id), /closed or unknown/);
  assert.equal(h.calls.length, calls);
  assert.equal(h.beforeunload().prevented, true, 'forgotten renderer record does not prove native GPU drainage');
});
test('unload preparation waits for an opening input and prevents new sessions', async () => {
  const h = harness(); let finish;
  h.handle(() => new Promise(resolve => { finish = resolve; }));
  const opening = h.api.input.open('uuid', () => {});
  assert.equal(h.beforeunload().prevented, true);
  let prepared = false;
  const preparation = h.api.lifecycle.prepareForUnload().then(() => { prepared = true; });
  await Promise.resolve();
  assert.equal(prepared, false);
  await assert.rejects(h.api.input.open('another', () => {}), /retiring/);
  finish('session'); await opening; await preparation;
  await assert.rejects(h.api.input.poll('session'), /closed or unknown/);
  assert.equal(h.beforeunload().prevented, true);
});
test('denied NDI open during unload preserves its error but does not bypass or prevent native drainage', async () => {
  const h = harness({ ndi: true }); let deny;
  h.handle(() => new Promise((_resolve, reject) => { deny = reject; }));
  const opening = h.api.ndiInput.open('Host (Feed)', () => {});
  const rejected = assert.rejects(opening, /NDI local-network access denied/);
  let prepared = false;
  const preparation = h.api.lifecycle.prepareForUnload().then(() => { prepared = true; });
  await Promise.resolve();
  assert.equal(prepared, false);
  deny(new Error('NDI local-network access denied'));
  await rejected;
  await preparation;
  assert.equal(h.beforeunload().prevented, true, 'Preparation is not proof of native drainage');
  await assert.rejects(h.api.ndiInput.open('Host (Feed)', () => {}), /retiring/);
  h.api.lifecycle.commitUnload();
  assert.equal(h.beforeunload().prevented, false);
});

// VN132: only a literal alpha:true crosses to the main process; anything else opens opaque.
test('output open forwards a literal alpha flag and nothing looser', async () => {
  const h = harness({ ndi: true });
  await h.api.ndiOutput.open('alpha', 1920, 1080, 'Alpha', { alpha: true });
  await h.api.ndiOutput.open('loose', 1920, 1080, 'Loose', { alpha: 'yes' });
  assert.deepEqual(h.calls[0], ['loom-ndi-output-open', 'alpha', 1920, 1080, 'Alpha', true]);
  assert.deepEqual(h.calls[1], ['loom-ndi-output-open', 'loose', 1920, 1080, 'Loose']);
});

test('NDI output is explicit, namespaced and participates in document unload', async () => {
  assert.equal(harness().api.ndiOutput, undefined);
  const h = harness({ ndi: true }); let finish;
  h.handle(() => new Promise(resolve => { finish = resolve; }));
  const opened = h.api.ndiOutput.open('output', 1920, 1080, 'Test');
  assert.deepEqual(h.calls[0], ['loom-ndi-output-open', 'output', 1920, 1080, 'Test']);
  assert.equal(h.beforeunload().prevented, true);
  let prepared = false;
  const preparing = h.api.lifecycle.prepareForUnload().then(() => { prepared = true; });
  await Promise.resolve(); assert.equal(prepared, false);
  finish(); await opened; await preparing;
  assert.equal(h.beforeunload().prevented, true);
  await assert.rejects(h.api.ndiOutput.open('new', 1920, 1080, 'New'), /retiring/);
  h.api.lifecycle.commitUnload(); assert.equal(h.beforeunload().prevented, false);
});
test('pagehide releases a suspended consumer frame/import once, even when completion arrives later', async () => {
  const h = harness(); let finish;
  await h.api.input.open('uuid', () => new Promise(resolve => { finish = resolve; }));
  const delivery = h.deliver();
  h.pagehide();
  assert.equal(h.closed, 1); assert.equal(h.released, 1);
  finish(); await delivery;
  assert.equal(h.closed, 1); assert.equal(h.released, 1);
});

test('consumer failure releases both references and surfaces through poll', async () => {
  const h = harness();
  const id = await h.api.input.open('uuid', () => { throw new Error('consumer failed'); });
  await h.deliver();
  assert.equal(h.closed, 1); assert.equal(h.released, 1);
  await assert.rejects(h.api.input.poll(id), /consumer failed/);
  await h.api.input.close(id);
});
test('concurrent polls are rejected and late delivery after close is released without consumption', async () => {
  const h = harness(); let finish; let consumed = 0;
  const id = await h.api.input.open('uuid', () => { consumed++; });
  h.handle(name => name.endsWith('poll') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
  const poll = h.api.input.poll(id);
  await assert.rejects(h.api.input.poll(id), /already in flight/);
  await h.api.input.close(id);
  await h.deliver();
  assert.equal(consumed, 0); assert.equal(h.released, 1);
  finish({ kind: 'sent' }); await poll;
  await assert.rejects(h.api.input.poll(id), /closed or unknown/);
});

test('preparation-only desktop exposes no video transport or shared-texture receiver', async () => {
  const h = harness({ video: false, ndi: true });
  for (const name of ['vision', 'nativeOutput', 'open', 'close', 'resize', 'status', 'ndiInput', 'ndiOutput'])
    assert.equal(h.api[name], undefined);
  assert.equal(h.api.input, undefined);
  assert.equal(typeof h.api.lifecycle.prepareForUnload, 'function');
  assert.equal(typeof h.api.lifecycle.commitUnload, 'function');
  assert.equal(h.beforeunload().prevented, false);
  h.handle(async () => ({ available: false, reason: 'Worker not installed' }));
  assert.equal((await h.api.preparation.probe()).available, false);
  assert.equal(h.calls[0][0], 'loom-preparation-probe');
  assert.equal(h.beforeunload().prevented, false, 'A probe owns no worker');
});

test('static preparation routes bounded payload and status/cancel/close through its own IPC', async () => {
  const h = harness({ video: false }), request = { rgba: new ArrayBuffer(4) };
  h.handle(async name => name.endsWith('start') ? 'job1' : { kind: 'cancelled' });
  const id = await h.api.preparation.start(request);
  assert.deepEqual(h.calls[0], ['loom-preparation-start', request]);
  assert.equal(h.beforeunload().prevented, true);
  assert.equal((await h.api.preparation.status(id)).kind, 'cancelled');
  await h.api.preparation.cancel(id);
  await h.api.preparation.close(id);
  assert.deepEqual(h.calls.map(call => call[0]), ['loom-preparation-start', 'loom-preparation-status',
    'loom-preparation-cancel', 'loom-preparation-close']);
  assert.throws(() => h.api.preparation.status(id), /closed or unknown/);
  assert.throws(() => h.api.preparation.cancel(id), /closed or unknown/);
  assert.equal(h.beforeunload().prevented, true, 'Only main retirement authorizes unload');
  h.api.lifecycle.commitUnload(); assert.equal(h.beforeunload().prevented, false);
});

test('static unload awaits pending start then process retirement and refuses new starts', async () => {
  const h = harness({ video: false }); let finishStart, finishClose;
  h.handle(name => new Promise(resolve => {
    if (name.endsWith('start')) finishStart = resolve;
    else if (name.endsWith('close')) finishClose = resolve;
    else throw new Error('Unexpected preparation method');
  }));
  const started = h.api.preparation.start({});
  let prepared = false;
  const preparing = h.api.lifecycle.prepareForUnload().then(() => { prepared = true; });
  await Promise.resolve(); assert.equal(prepared, false);
  await assert.rejects(h.api.preparation.start({}), /retiring/);
  finishStart('job1'); await started;
  await new Promise(resolve => require('node:timers').setImmediate(resolve));
  assert.equal(typeof finishClose, 'function'); assert.equal(prepared, false);
  const simultaneousClose = h.api.preparation.close('job1');
  assert.equal(h.calls.filter(call => call[0] === 'loom-preparation-close').length, 1);
  finishClose(); await simultaneousClose; await preparing;
  assert.equal(h.beforeunload().prevented, true);
  h.api.lifecycle.commitUnload(); assert.equal(h.beforeunload().prevented, false);
});

test('failed static close propagates and retains its job instead of authorizing unload', async () => {
  const h = harness({ video: false });
  h.handle(async name => { if (name.endsWith('start')) return 'job1'; throw new Error('Worker still alive'); });
  await h.api.preparation.start({});
  await assert.rejects(h.api.lifecycle.prepareForUnload(), /Worker still alive/);
  assert.equal(h.beforeunload().prevented, true);
  await assert.rejects(h.api.preparation.close('job1'), /Worker still alive/);
  assert.equal(h.calls.filter(call => call[0] === 'loom-preparation-close').length, 1);
});

test('failed pending static start preserves its error while main retirement remains authoritative', async () => {
  const h = harness({ video: false }); let deny;
  h.handle(() => new Promise((_resolve, reject) => { deny = reject; }));
  const started = h.api.preparation.start({});
  const rejected = assert.rejects(started, /Preparation refused/);
  const preparing = h.api.lifecycle.prepareForUnload();
  deny(new Error('Preparation refused')); await rejected; await preparing;
  assert.equal(h.calls.length, 1);
  assert.equal(h.beforeunload().prevented, true);
  h.api.lifecycle.commitUnload(); assert.equal(h.beforeunload().prevented, false);
});
