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
  const handlers = new Map(), calls = [], windows = [], callbacks = [], sent = [];
  const owner = new EventEmitter();
  owner.mainFrame = {}; owner.isDestroyed = () => false;
  owner.send = (...args) => sent.push([owner, ...args]);
  owner.getURL = () => 'http://127.0.0.1:5187/';
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const worker = {
    infer: async () => { calls.push(['infer']); return { handle: {}, sequence: 7, width: 1920, height: 1080, coverage: 0.2 }; },
    reset: async () => { calls.push(['reset']); },
    release: async sequence => { calls.push(['release', sequence]); },
    close: async () => { calls.push(['close']); },
  };
  const workers = { open: async () => worker };
  // T1818b: the depth kind. A model is openable only once a consented prepare made it so.
  const prepared = new Set(), prepares = [], depthOpens = [];
  const models = { ids: ['depthpro2-s-coreml', 'depthpro2-b-coreml'],
    functions: ['res_640x360', 'res_854x480', 'res_896x512', 'res_1138x640', 'res_1280x720'],
    probe: async () => ({ available: true, models: [] }),
    compiled: async id => {
      if (!prepared.has(id)) throw new Error('Depth Pro 2 S is not downloaded on this Mac yet.');
      return `/cache/${id}/compiled/depthpro2_w4.mlmodelc`;
    },
    prepare: (id, onProgress, signal) => {
      const job = { id, onProgress, signal, ...deferred() };
      prepares.push(job);
      signal.addEventListener('abort', () => job.reject(signal.reason));
      return job.promise;
    } };
  const depth = { models, workers: { open: async args => { depthOpens.push(args); return worker; } } };
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
    BrowserWindow: Window, workers, depth, sharedTexture, origin: 'http://127.0.0.1:5187' });
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
  const depthName = 'loom-native-depth-12345678-1234-1234-1234-123456789abc';
  const depthInvoke = (method, ...args) => handlers.get(`loom-native-depth-${method}`)(event, ...args);
  const paintDepth = (index = 0) => windows[index].webContents.emit('paint', { texture: {
    textureInfo: { pixelFormat: 'bgra', codedSize: { width: 854, height: 640 }, handle: { ioSurface: {} } },
    release() { calls.push(['input-release']); },
  } });
  return { adapter, worker, workers, sharedTexture, event, owner, windows, callbacks, calls, name, invoke, open, frame, paint, count,
    handlers, prepared, prepares, depthOpens, depthName, depthInvoke, paintDepth, sent };
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

test('depth opens only a prepared model, at its function\'s own input size, and opening never acquires one', async () => {
  const h = harness(), open = (...args) => h.depthInvoke('open', ...args);
  await assert.rejects(open(h.name, 'depthpro2-s-coreml', 'res_854x480', 854, 480, 1920, 1080), /Invalid native depth name/);
  await assert.rejects(open(h.depthName, 'depthpro2-l-coreml', 'res_854x480', 854, 480, 1920, 1080), /Unknown native depth model/);
  await assert.rejects(open(h.depthName, 'depthpro2-s-coreml', 'res_100x100', 100, 100, 1920, 1080), /Unknown native depth model function/);
  await assert.rejects(open(h.depthName, 'depthpro2-s-coreml', 'res_854x480', 640, 360, 1920, 1080), /function's own size/);
  await assert.rejects(open(h.depthName, 'depthpro2-s-coreml', 'res_854x480', 854, 480, 1920, 1080), /not downloaded/);
  assert.equal(h.prepares.length, 0, 'an unprepared model is refused, never downloaded behind the person\'s back');
  assert.deepEqual(h.depthOpens, []);
  h.prepared.add('depthpro2-s-coreml');
  assert.equal(await open(h.depthName, 'depthpro2-s-coreml', 'res_854x480', 854, 480, 1920, 1080), h.depthName);
  assert.deepEqual(h.depthOpens, [['/cache/depthpro2-s-coreml/compiled/depthpro2_w4.mlmodelc', 'res_854x480']]);
  assert.equal(h.windows.length, 1);
  const frame = h.frame(); h.paintDepth(); await tick();
  assert.equal(h.count('main-release'), 1);
  h.callbacks[0](); assert.deepEqual(await frame, { kind: 'completed' });
  assert.equal(h.adapter.diagnostics()[0].kind, 'depth');
  // Kinds do not cross: the Person Mask IPC cannot reach a depth session.
  assert.throws(() => h.invoke('status', h.depthName), /not owned/);
  assert.throws(() => h.invoke('close', h.depthName), /not owned/);
  assert.deepEqual(h.depthInvoke('status', h.depthName), { frames: 1, busy: false, error: null });
  await h.depthInvoke('close', h.depthName);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('a depth reset restarts the stream at the next captured frame, never inside the frame in flight', async () => {
  const h = harness(), inference = deferred();
  h.prepared.add('depthpro2-s-coreml');
  await h.depthInvoke('open', h.depthName, 'depthpro2-s-coreml', 'res_854x480', 854, 480, 1920, 1080);
  h.worker.infer = () => { h.calls.push(['infer']); return inference.promise; };
  const first = h.frame(); h.paintDepth(); await tick();
  h.depthInvoke('reset', h.depthName);
  assert.throws(() => h.invoke('reset', h.depthName), /No handler|not a function/);
  assert.equal(h.count('reset'), 0, 'the frame already submitted keeps the stream it was submitted to');
  inference.resolve({ handle: {}, sequence: 7, width: 1920, height: 1080, coverage: 0.5 }); await tick();
  h.callbacks[0](); await first;
  h.worker.infer = async () => { h.calls.push(['infer']); return { handle: {}, sequence: 8, width: 1920, height: 1080, coverage: 0.5 }; };
  const second = h.frame(); h.paintDepth(); await tick();
  assert.deepEqual(h.calls.filter(call => call[0] === 'reset' || call[0] === 'infer'), [['infer'], ['reset'], ['infer']]);
  h.callbacks[1](); await second;
  const third = h.frame(); h.paintDepth(); await tick();
  assert.equal(h.count('reset'), 1, 'one reset is one new stream, not a reset per frame');
  h.callbacks[2](); await third;
  await h.adapter.retireOwner(h.owner);
  assert.throws(() => h.depthInvoke('reset', h.depthName), /not owned/);
});

test('one acquisition per model: progress reaches every waiting job, and a leaving document abandons only what nobody else awaits', async () => {
  const h = harness();
  await assert.rejects(h.depthInvoke('prepare', 'job 1', 'depthpro2-s-coreml'), /Invalid native depth preparation job/);
  await assert.rejects(h.depthInvoke('prepare', 'depth-1', 'depthpro2-l-coreml'), /Unknown native depth model/);
  const first = h.depthInvoke('prepare', 'depth-1', 'depthpro2-s-coreml');
  const second = h.depthInvoke('prepare', 'depth-2', 'depthpro2-s-coreml');
  await tick();
  assert.equal(h.prepares.length, 1, 'two nodes asking for one model download it once');
  h.prepares[0].onProgress({ phase: 'downloading', received: 5, total: 10 });
  assert.deepEqual(h.sent.map(([, ...message]) => message), [
    ['loom-native-depth-progress', 'depth-1', { phase: 'downloading', received: 5, total: 10 }],
    ['loom-native-depth-progress', 'depth-2', { phase: 'downloading', received: 5, total: 10 }]]);
  h.prepares[0].resolve(); await first; await second;
  // Another document still waiting keeps the download alive when this one leaves.
  const other = new EventEmitter(), sent = [];
  other.mainFrame = {}; other.isDestroyed = () => false; other.getURL = () => 'http://127.0.0.1:5187/';
  other.send = (...args) => sent.push(args);
  const mine = h.depthInvoke('prepare', 'depth-3', 'depthpro2-b-coreml');
  const theirs = h.handlers.get('loom-native-depth-prepare')({ sender: other, senderFrame: other.mainFrame }, 'depth-1', 'depthpro2-b-coreml');
  await tick();
  assert.equal(h.prepares.length, 2);
  await h.adapter.retireOwner(h.owner);
  assert.equal(h.prepares[1].signal.aborted, false);
  h.prepares[1].onProgress({ phase: 'compiling' });
  assert.deepEqual(sent, [['loom-native-depth-progress', 'depth-1', { phase: 'compiling' }]]);
  assert.equal(h.sent.filter(([, , job]) => job === 'depth-3').length, 0, 'a retired job receives no more progress');
  const abandoned = h.adapter.retireOwner(other);
  await assert.rejects(theirs);
  await abandoned;
  assert.equal(h.prepares[1].signal.aborted, true, 'nobody awaits it any more: the download stops');
  await mine.catch(() => undefined);
});

test('probe passes through only for the app main frame', async () => {
  const h = harness();
  assert.deepEqual(await h.depthInvoke('probe'), { available: true, models: [] });
  h.event.senderFrame = {};
  assert.throws(() => h.depthInvoke('probe'), /main frame/);
});
