/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { EventEmitter } = require('node:events');

function harness(ready = true, options = {}) {
  const prefix = options.transport === 'ndi' ? 'loom-ndi-output' : 'loom-native-output';
  const ipc = {}; const events = {}; const closers = []; let resume;
  let released = 0; let stopped = 0; let calls = 0; const publishedNames = [], stoppedNames = [];
  const owner = new EventEmitter();
  owner.mainFrame = {};
  owner.getURL = () => 'http://127.0.0.1:5187/';
  const native = { publish(_surface, name) { calls++; publishedNames.push(name); return new Promise(resolve => { resume = resolve; }); }, stop(name) { stopped++; stoppedNames.push(name); }, stats() { return { publishers: 1, queuesCreated: 1 }; } };
  const module = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, 'native-output.cjs'), 'utf8'), {
    module, __dirname, require: name => name === 'node:path' ? { join }
      : name === 'node:buffer' ? require(name) : ({ ipcMain: { handle(name, fn) { ipc[name] = fn; } } }),
  });
  const contents = new EventEmitter();
  contents.mainFrame = {};
  let painting = true;
  contents.startPainting = () => { painting = true; };
  contents.stopPainting = () => { painting = false; };
  contents.on('newListener', (name, fn) => { events[name] = fn; });
  let closed = false, strictDestroyedClose = false;
  const window = { get webContents() {
    if (closed) throw new TypeError('Object has been destroyed');
    return contents;
  }, isDestroyed: () => closed, once(_name, fn) { closers.push(fn); }, setContentSize() {}, close() {
    if (closed) {
      if (strictDestroyedClose) throw new Error('Object has been destroyed');
      return;
    }
    closed = true;
    closers.forEach(fn => fn());
  } };
  const adapter = module.exports.installNativeOutput(native, 'http://127.0.0.1:5187', options);
  adapter.attach(owner, window, 'test', 'Test publisher');
  const markReady = (sender = contents, senderFrame = contents.mainFrame) =>
    ipc[`${prefix}-frame-ready`]({ sender, senderFrame });
  if (ready) markReady();
  const event = sender => ({ sender, senderFrame: owner.mainFrame });
  return {
    paint: () => events.paint({ texture: { textureInfo: { pixelFormat: 'bgra', codedSize: { width: 1280, height: 720 }, handle: { ioSurface: {} } }, release() { released++; } } }),
    close: () => window.close(), resume: () => resume(), contents, markReady,
    emptyPaint: () => events.paint({}), get painting() { return painting; },
    status: sender => ipc[`${prefix}-status`](event(sender), 'test'), owner,
    closeIpc: sender => ipc[`${prefix}-close`](event(sender), 'test'),
    invoke: (command, request) => ipc[`${prefix}-${command}`](request, 'test', 1280, 720),
    reattach: (name = 'test') => adapter.attach(owner, window, name, name === 'test' ? 'Test publisher' : name),
    publishedNames, stoppedNames,
    diagnostics: () => adapter.diagnostics(),
    open: (publisherName, suffix = '0') => ipc[`${prefix}-open`](event(owner), `loom-native-output-00000000-0000-0000-0000-00000000000${suffix}`, 1920, 1080, publisherName),
    stopWith: callback => { native.stop = callback; },
    strictClose: () => { strictDestroyedClose = true; },
    retireOwner: () => adapter.retireOwner(owner),
    get released() { return released; }, get stopped() { return stopped; }, get calls() { return calls; },
  };
}
test('main-only diagnostics identify pending publishers and contain no native ownership objects', async () => {
  const h = harness(false);
  const initial = h.diagnostics()[0];
  assert.deepEqual(Object.keys(initial).sort(), ['name', 'publisherName', 'frameReady', 'busy', 'closed', 'copied', 'dropped', 'error', 'size'].sort());
  assert.equal(initial.publisherName, 'Test publisher');
  assert.equal(initial.frameReady, false); assert.equal(initial.busy, false);
  h.markReady();
  const painting = h.paint();
  assert.equal(h.diagnostics()[0].frameReady, true);
  assert.equal(h.diagnostics()[0].busy, true);
  h.resume(); await painting;
  const completed = h.diagnostics()[0];
  assert.equal(completed.busy, false); assert.equal(completed.copied, 1);
  completed.size[0] = 1;
  assert.equal(h.diagnostics()[0].size[0], 1280);
  h.close();
  assert.equal(h.diagnostics().length, 0);
});
test('output preload exposes only a no-argument readiness notification', async () => {
  let exposed;
  const calls = [];
  runInNewContext(readFileSync(join(__dirname, 'output-preload.cjs'), 'utf8'), {
    process: { argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'loomNativeSurface'); exposed = api; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } },
    }),
  });
  assert.deepEqual(Object.keys(exposed), ['frameReady']);
  await exposed.frameReady();
  assert.deepEqual(calls, [['loom-native-output-frame-ready']]);
});
test('initial window paints cannot publish before an authenticated graph-frame handshake', async () => {
  const h = harness(false);
  assert.equal(h.painting, false);
  await h.emptyPaint();
  assert.equal(h.status(h.owner).error, null);
  await h.paint();
  assert.equal(h.calls, 0); assert.equal(h.released, 1);
  assert.throws(() => h.markReady(h.owner), /owning output/);
  assert.throws(() => h.markReady(h.contents, {}), /owning output/);
  h.markReady();
  assert.equal(h.painting, true);
  const paint = h.paint();
  assert.equal(h.calls, 1);
  h.resume(); await paint;
});
test('native output bounds GPU work and drains before publisher stop', async () => {
  const h = harness(); const first = h.paint();
  await h.paint();
  assert.equal(h.calls, 1); assert.equal(h.released, 1);
  assert.equal(h.status(h.owner).dropped, 1);
  h.close(); assert.equal(h.stopped, 0);
  h.resume(); await first;
  assert.equal(h.released, 2); assert.equal(h.stopped, 1);
});
for (const event of ['destroyed', 'render-process-gone', 'navigation', 'output-crash']) {
  test(`${event} retires publication without releasing an in-flight GPU lease early`, async () => {
    const h = harness();
    const pending = h.paint();
    if (event === 'navigation') h.owner.emit('did-navigate');
    else if (event === 'output-crash') h.contents.emit('render-process-gone', {});
    else h.owner.emit(event, {});
    assert.throws(() => h.status(h.owner), /not owned/);
    assert.equal(h.stopped, 0);
    assert.equal(h.released, 0);
    await h.paint();
    assert.equal(h.calls, 1);
    assert.equal(h.released, 1);
    h.resume(); await pending;
    assert.equal(h.stopped, 1);
    assert.equal(h.released, 2);
    assert.equal(h.owner.eventNames().length, 0);
    assert.equal(h.contents.listenerCount('render-process-gone'), 0);
    h.close();
    assert.equal(h.stopped, 1);
  });
}
test('same-document and subframe navigation do not retire output', () => {
  const h = harness();
  h.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  h.owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  h.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(h.status(h.owner).copied, 0);
  assert.equal(h.stopped, 0);
  h.close();
  assert.equal(h.stopped, 1);
  assert.equal(h.owner.eventNames().length, 0);
});
test('retired publication reserves its name until GPU completion; close remains idempotent', async () => {
  const h = harness();
  const pending = h.paint();
  h.close();
  h.closeIpc(h.owner);
  assert.throws(() => h.closeIpc({}), /main frame/);
  assert.throws(() => h.reattach(), /Duplicate/);
  h.resume(); await pending;
  assert.equal(h.stopped, 1);
  h.closeIpc(h.owner);
});
test('close acknowledgment waits for the last GPU publication and native stop', async () => {
  const h = harness();
  const pending = h.paint();
  const closing = h.closeIpc(h.owner);
  assert.equal(h.closeIpc(h.owner), closing);
  let acknowledged = false;
  closing.then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.equal(h.stopped, 0);
  h.resume(); await pending; await closing;
  assert.equal(acknowledged, true);
  assert.equal(h.released, 1);
  assert.equal(h.stopped, 1);
});
test('another renderer cannot inspect or control an output', () => {
  const h = harness();
  assert.throws(() => h.status({ ...h.owner }), /not owned/);
  h.close();
  assert.throws(() => h.status(h.owner), /not owned/);
});
test('all control requests reject subframes and wrong origins', () => {
  const h = harness();
  for (const command of ['status', 'close', 'resize']) {
    assert.throws(() => h.invoke(command, { sender: h.owner, senderFrame: {} }), /main frame/);
  }
  h.owner.getURL = () => 'https://untrusted.test/';
  for (const command of ['status', 'close', 'resize']) {
    assert.throws(() => h.invoke(command, { sender: h.owner, senderFrame: h.owner.mainFrame }), /main frame/);
  }
  h.close();
});
test('size describes completed publication, not a pending paint', async () => {
  const h = harness();
  const paint = h.paint();
  assert.equal(h.status(h.owner).size, null);
  h.resume(); await paint;
  assert.deepEqual(Array.from(h.status(h.owner).size), [1280, 720]);
  assert.equal(h.status(h.owner).copied, 1);
  h.close();
  assert.deepEqual(h.publishedNames, ['Test publisher']);
  assert.deepEqual(h.stoppedNames, ['Test publisher']);
});
test('invalid and duplicate publisher names are rejected before creating a window', async () => {
  const h = harness();
  for (const name of ['', ' ', null, 'x\0y', 'x'.repeat(257)]) await assert.rejects(h.open(name), /Invalid Syphon/);
  await assert.rejects(h.open('Test publisher'), /already in use/);
  assert.equal(h.calls, 0); h.close();
});

test('asynchronous SDK stop retains its slot and close acknowledgment until drainage', async () => {
  const h = harness(); let finish;
  h.stopWith(() => new Promise(resolve => { finish = resolve; }));
  const closing = h.closeIpc(h.owner);
  let done = false; closing.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false); assert.equal(h.diagnostics().length, 1);
  assert.throws(() => h.reattach(), /Duplicate/);
  finish(); await closing;
  assert.equal(done, true); assert.equal(h.diagnostics().length, 0);
});

test('failed SDK stop rejects closure and owner retirement without reusing the publisher', async () => {
  const h = harness();
  h.strictClose();
  h.stopWith(async () => { throw new Error('SDK drain failed'); });
  await assert.rejects(h.closeIpc(h.owner), /SDK drain failed/);
  assert.match(h.diagnostics()[0].error, /SDK drain failed/);
  assert.throws(() => h.reattach(), /Duplicate/);
  await assert.rejects(h.retireOwner(), /SDK drain failed/);
});

test('NDI denial rejects before a window or publisher can be created', async () => {
  const h = harness(true, { transport: 'ndi', beforeAccess: async () => { throw new Error('Network denied'); } });
  await assert.rejects(h.open('Denied'), /Network denied/);
  assert.equal(h.calls, 0); assert.equal(h.diagnostics().length, 1);
  h.close();
});

test('NDI validates its UTF8 byte bound before requesting network consent', async () => {
  let prompts = 0;
  const h = harness(true, { transport: 'ndi', beforeAccess: async () => { prompts++; } });
  await assert.rejects(h.open('é'.repeat(65)), /128 UTF8 bytes/);
  assert.equal(prompts, 0); assert.equal(h.calls, 0); h.close();
});

test('NDI rejects SDK-normalized publisher names before consent or window creation', async () => {
  let prompts = 0;
  const h = harness(true, { transport: 'ndi', beforeAccess: async () => { prompts++; } });
  for (const reserved of ['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
    await assert.rejects(h.open(`Loom${reserved}Camera`), /reserved characters/);
  assert.equal(prompts, 0); assert.equal(h.calls, 0); h.close();
});

test('NDI permission waits reserve capacity and cannot open after owner retirement', async () => {
  let allow;
  const gate = new Promise(resolve => { allow = resolve; });
  const h = harness(true, { transport: 'ndi', beforeAccess: () => gate });
  const requests = ['1', '2', '3'].map(id => h.open(`Pending ${id}`, id));
  const rejected = requests.map(request => assert.rejects(request, /owner retired/));
  await assert.rejects(h.open('Pending 1', '4'), /already in use/);
  await assert.rejects(h.open('Over capacity', '4'), /limit/);
  let retired = false;
  const retirement = h.retireOwner().then(() => { retired = true; });
  await Promise.resolve(); assert.equal(retired, false);
  allow(); await Promise.all(rejected); await retirement;
  assert.equal(h.calls, 0); assert.equal(h.diagnostics().length, 0);
  assert.equal(h.owner.eventNames().length, 0);
});

test('NDI navigation during consent cannot create a late publisher', async () => {
  let allow;
  const h = harness(true, { transport: 'ndi', beforeAccess: () => new Promise(resolve => { allow = resolve; }) });
  const opened = h.open('Pending');
  h.owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  allow(); await assert.rejects(opened, /owner retired/);
  assert.equal(h.calls, 0); h.close();
});

test('multiple outputs share one owner subscription and remove it after the last close', () => {
  const h = harness();
  for (const name of ['second', 'third', 'fourth']) h.reattach(name);
  for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation', 'did-navigate'])
    assert.equal(h.owner.listenerCount(event), 1);
  assert.equal(h.diagnostics().length, 4);
  h.close();
  assert.equal(h.diagnostics().length, 0); assert.equal(h.owner.eventNames().length, 0);
});
