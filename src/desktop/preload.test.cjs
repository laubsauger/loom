/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
function harness({ ndi = false } = {}) {
  let api, receive, handler = async name => name.endsWith('open') ? 'session' : { kind: 'sent' };
  const calls = [];
  const listeners = new Map();
  runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    process: { argv: ndi ? ['--loom-ndi-input'] : [] },
    Event: class { constructor(type) { this.type = type; } },
    window: { addEventListener(name, callback) { listeners.set(name, callback); }, dispatchEvent(event) { listeners.get(event.type)?.(event); } },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { assert.ok(receive); api = value; } },
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
  await h.api.input.prepareForUnload();
  assert.equal(h.beforeunload().prevented, true);
  h.api.input.commitUnload();
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
  await h.api.input.prepareForUnload();
  assert.equal(h.beforeunload().prevented, true);
  await assert.rejects(h.api.input.open('uuid', () => {}), /retiring/);
  h.api.input.commitUnload();
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
  const preparation = h.api.input.prepareForUnload().then(() => { prepared = true; });
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
  const preparation = h.api.input.prepareForUnload().then(() => { prepared = true; });
  await Promise.resolve();
  assert.equal(prepared, false);
  deny(new Error('NDI local-network access denied'));
  await rejected;
  await preparation;
  assert.equal(h.beforeunload().prevented, true, 'Preparation is not proof of native drainage');
  await assert.rejects(h.api.ndiInput.open('Host (Feed)', () => {}), /retiring/);
  h.api.input.commitUnload();
  assert.equal(h.beforeunload().prevented, false);
});

test('NDI output is explicit, namespaced and participates in document unload', async () => {
  assert.equal(harness().api.ndiOutput, undefined);
  const h = harness({ ndi: true }); let finish;
  h.handle(() => new Promise(resolve => { finish = resolve; }));
  const opened = h.api.ndiOutput.open('output', 1920, 1080, 'Test');
  assert.deepEqual(h.calls[0], ['loom-ndi-output-open', 'output', 1920, 1080, 'Test']);
  assert.equal(h.beforeunload().prevented, true);
  let prepared = false;
  const preparing = h.api.input.prepareForUnload().then(() => { prepared = true; });
  await Promise.resolve(); assert.equal(prepared, false);
  finish(); await opened; await preparing;
  assert.equal(h.beforeunload().prevented, true);
  await assert.rejects(h.api.ndiOutput.open('new', 1920, 1080, 'New'), /retiring/);
  h.api.input.commitUnload(); assert.equal(h.beforeunload().prevented, false);
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
