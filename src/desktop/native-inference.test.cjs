/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installNativeInference } = require('./native-inference.cjs');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => require('node:timers').setImmediate(resolve));
function harness() {
  const handlers = new Map(), calls = [], windows = [], callbacks = [];
  const owner = new EventEmitter();
  owner.mainFrame = {}; owner.isDestroyed = () => false;
  owner.getURL = () => 'http://127.0.0.1:5187/';
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const worker = {
    infer: async () => ({ handle: {}, sequence: 7, width: 1920, height: 1080, coverage: 0.2 }),
    release: async sequence => { calls.push(['release', sequence]); },
    close: async () => { calls.push(['close']); },
  };
  const workers = { open: async () => worker };
  class Window extends EventEmitter {
    constructor() {
      super(); this.dead = false; this.contents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: {}, stopPainting() {}, startPainting() {},
        invalidate() { throw new Error('GPU capture must not invalidate a CPU backing bitmap'); } });
      windows.push(this);
    }
    get webContents() { if (this.dead) throw new Error('Object has been destroyed'); return this.contents; }
    isDestroyed() { return this.dead; }
    async loadURL() {}
    close() { this.dead = true; this.emit('closed'); }
    destroy() { this.close(); }
  }
  const sharedTexture = {
    importSharedTexture(options) {
      callbacks.push(options.allReferencesReleased);
      return { release() { calls.push(['main-release']); } };
    },
    async sendSharedTexture(options, metadata) { calls.push(['send', metadata]); },
  };
  const adapter = installNativeInference({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    BrowserWindow: Window, workers, sharedTexture, origin: 'http://127.0.0.1:5187' });
  const name = 'loom-native-vision-12345678-1234-1234-1234-123456789abc';
  const invoke = (method, ...args) => handlers.get(`loom-native-vision-${method}`)(event, ...args);
  const open = () => invoke('open', name, 512, 512, 1920, 1080);
  const frame = (index = 0) => {
    const sender = windows[index].webContents;
    return handlers.get('loom-native-vision-frame')({ sender, senderFrame: sender.mainFrame });
  };
  const paint = () => windows[0].webContents.emit('paint', { texture: {
    textureInfo: { pixelFormat: 'bgra', codedSize: { width: 512, height: 683 }, handle: { ioSurface: {} } },
    release() { calls.push(['input-release']); },
  } });
  const count = key => calls.filter(call => call[0] === key).length;
  return { adapter, worker, workers, sharedTexture, event, owner, windows, callbacks, calls, name, invoke, open, frame, paint, count };
}

test('frame credit and shutdown wait for GPU release, not send completion', async () => {
  const h = harness(); await h.open();
  let delivered = false, closed = false;
  const frame = h.frame().then(() => { delivered = true; }); h.paint(); await tick();
  assert.equal(h.count('input-release'), 1); assert.equal(h.count('main-release'), 1);
  assert.equal(h.count('release'), 0); assert.equal(delivered, false);
  const closing = h.invoke('close', h.name).then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(h.count('close'), 0);
  h.callbacks[0](); await frame; await closing;
  assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', 7]);
  assert.equal(h.count('close'), 1); assert.deepEqual(h.adapter.diagnostics(), []);
  assert.equal(h.owner.listenerCount('destroyed'), 0);
});

test('retirement during worker acquisition creates no capture window', async () => {
  const h = harness(), acquisition = deferred(); h.workers.open = () => acquisition.promise;
  const opening = h.open(); const closing = h.adapter.retireOwner(h.owner);
  acquisition.resolve(h.worker); await opening; await closing;
  assert.equal(h.windows.length, 0); assert.equal(h.count('close'), 1);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('a destroyed capture awaiting GPU release cannot break another session frame', async () => {
  const h = harness(); await h.open();
  const first = h.frame(); h.paint(); await tick();
  h.windows[0].destroy();
  const secondName = h.name.replace('123456789abc', '123456789abd');
  await h.invoke('open', secondName, 512, 512, 1920, 1080);
  try {
    const second = h.frame(1);
    await h.invoke('close', secondName); assert.deepEqual(await second, { kind: 'closed' });
  } finally {
    h.callbacks[0](); await first; await h.adapter.retireOwner(h.owner);
  }
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('closing an unsubmitted capture is normal cancellation, with no fabricated result or lease', async () => {
  const h = harness(); await h.open();
  const frame = h.frame(); await h.invoke('close', h.name);
  assert.deepEqual(await frame, { kind: 'closed' });
  assert.equal(h.count('release'), 0); assert.equal(h.count('input-release'), 0);
  assert.equal(h.count('close'), 1); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('a stalled capture times out before submission and can retire without inventing GPU ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await h.open();
  const failed = assert.rejects(h.frame(), /capture timed out before submission/);
  t.mock.timers.tick(15000); await failed;
  await h.invoke('close', h.name);
  assert.equal(h.count('release'), 0); assert.equal(h.count('close'), 1);
});

test('retirement during inference releases the completed result without importing it', async () => {
  const h = harness(), inference = deferred(); h.worker.infer = () => inference.promise;
  await h.open(); const frame = h.frame(); h.paint();
  const closing = h.invoke('close', h.name);
  inference.resolve({ sequence: 9 }); await frame; await closing;
  assert.equal(h.callbacks.length, 0); assert.equal(h.count('input-release'), 1);
  assert.deepEqual(h.calls.find(call => call[0] === 'release'), ['release', 9]);
});

test('uncertain completion retains input and refuses shutdown', async () => {
  const h = harness(); h.worker.infer = async () => { throw Object.assign(new Error('worker timeout'), { code: 'VISION_COMPLETION_UNCERTAIN' }); };
  await h.open(); const frame = h.frame(); const failed = assert.rejects(frame, /worker timeout/); h.paint(); await failed; await tick();
  assert.equal(h.count('input-release'), 0);
  await assert.rejects(h.invoke('close', h.name), /worker timeout/);
  assert.equal(h.count('close'), 0); assert.equal(h.adapter.diagnostics()[0].inputHeld, true);
});

test('explicit refusal returns input ownership and permits complete retirement', async () => {
  const h = harness(); h.worker.infer = async () => { throw Object.assign(new Error('request refused'), { code: 'VISION_REQUEST_REFUSED' }); };
  await h.open(); const frame = h.frame(); const failed = assert.rejects(frame, /request refused/); h.paint(); await failed;
  await h.invoke('close', h.name);
  assert.equal(h.count('input-release'), 1); assert.equal(h.count('close'), 1);
});

test('other owners and subframes cannot submit or close a session', async () => {
  const h = harness(); await h.open();
  h.event.senderFrame = {};
  assert.throws(() => h.invoke('close', h.name), /main frame/);
  await assert.rejects(h.open(), /main frame/);
  h.event.senderFrame = h.owner.mainFrame;
  h.owner.mainFrame = {}; h.event.senderFrame = h.owner.mainFrame;
  assert.throws(() => h.invoke('close', h.name), /not owned/);
  await h.adapter.retireOwner(h.owner);
});
