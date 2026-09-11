/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { EventEmitter } = require('node:events');

function harness(ready = true) {
  const ipc = {}; const events = {}; const closers = []; let resume;
  let released = 0; let stopped = 0; let calls = 0; const publishedNames = [], stoppedNames = [];
  const owner = new EventEmitter();
  owner.mainFrame = {};
  owner.getURL = () => 'http://127.0.0.1:5187/';
  const native = { publish(_surface, name) { calls++; publishedNames.push(name); return new Promise(resolve => { resume = resolve; }); }, stop(name) { stopped++; stoppedNames.push(name); }, stats() { return { publishers: 1, queuesCreated: 1 }; } };
  const module = { exports: {} };
  runInNewContext(readFileSync(join(__dirname, 'native-output.cjs'), 'utf8'), {
    module, __dirname, require: name => name === 'node:path' ? { join } : ({ ipcMain: { handle(name, fn) { ipc[name] = fn; } } }),
  });
  const contents = new EventEmitter();
  contents.mainFrame = {};
  let painting = true;
  contents.startPainting = () => { painting = true; };
  contents.stopPainting = () => { painting = false; };
  contents.on('newListener', (name, fn) => { events[name] = fn; });
  let closed = false;
  const window = { get webContents() {
    if (closed) throw new TypeError('Object has been destroyed');
    return contents;
  }, once(_name, fn) { closers.push(fn); }, setContentSize() {}, close() {
    if (closed) return;
    closed = true;
    closers.forEach(fn => fn());
  } };
  const adapter = module.exports.installNativeOutput(native, 'http://127.0.0.1:5187');
  adapter.attach(owner, window, 'test', 'Test publisher');
  const markReady = (sender = contents, senderFrame = contents.mainFrame) =>
    ipc['loom-native-output-frame-ready']({ sender, senderFrame });
  if (ready) markReady();
  const event = sender => ({ sender, senderFrame: owner.mainFrame });
  return {
    paint: () => events.paint({ texture: { textureInfo: { pixelFormat: 'bgra', codedSize: { width: 1280, height: 720 }, handle: { ioSurface: {} } }, release() { released++; } } }),
    close: () => window.close(), resume: () => resume(), contents, markReady,
    emptyPaint: () => events.paint({}), get painting() { return painting; },
    status: sender => ipc['loom-native-output-status'](event(sender), 'test'), owner,
    closeIpc: sender => ipc['loom-native-output-close'](event(sender), 'test'),
    invoke: (command, request) => ipc[`loom-native-output-${command}`](request, 'test', 1280, 720),
    reattach: () => adapter.attach(owner, window, 'test', 'Test publisher'),
    publishedNames, stoppedNames,
    open: publisherName => ipc['loom-native-output-open'](event(owner), 'loom-native-output-00000000-0000-0000-0000-000000000000', 1920, 1080, publisherName),
    get released() { return released; }, get stopped() { return stopped; }, get calls() { return calls; },
  };
}
test('output preload exposes only a no-argument readiness notification', async () => {
  let exposed;
  const calls = [];
  runInNewContext(readFileSync(join(__dirname, 'output-preload.cjs'), 'utf8'), {
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
