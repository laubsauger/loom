/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const { installNativeInput } = require('./native-input.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  const handlers = new Map(), calls = [], callbacks = [], errors = [];
  let nativeId = 0, sequence = 0;
  const owner = new EventEmitter();
  owner.mainFrame = { id: 'frame-a' };
  owner.getURL = () => 'http://127.0.0.1:5187/';
  owner.isDestroyed = () => false;
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const frame = () => ({ handle: Buffer.alloc(8), leaseId: `lease-${++sequence}`,
    width: 1920, height: 1080, sequence });
  const native = {
    list: () => [{ id: 'exact-uuid', name: 'Source', app: 'Fixture' }],
    open(uuid) { calls.push(['open', uuid]); return `native-${++nativeId}`; },
    acquire(id) { calls.push(['acquire', id]); return Promise.resolve(frame()); },
    release(id) { calls.push(['release', id]); },
    close(id) { calls.push(['close', id]); },
  };
  const sharedTexture = {
    importSharedTexture(options) {
      calls.push(['import', options.textureInfo]); callbacks.push(options.allReferencesReleased);
      return { release() { calls.push(['main-release']); } };
    },
    async sendSharedTexture(options, metadata) { calls.push(['send', options, metadata]); },
  };
  const adapter = installNativeInput({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    native, sharedTexture, origin: 'http://127.0.0.1:5187', onError: error => errors.push(error), ...options,
  });
  const invoke = (name, ...args) => handlers.get(`${options.transport === 'ndi' ? 'loom-ndi-input' : 'loom-native-input'}-${name}`)(event, ...args);
  const count = name => calls.filter(call => call[0] === name).length;
  return { handlers, calls, callbacks, errors, owner, event, native, sharedTexture, adapter, invoke, count, frame };
}

test('a reported source failure does not block unload after complete native retirement', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.native.acquire = async () => { throw new Error('Syphon source disconnected'); };
  await assert.rejects(h.invoke('poll', session), /source disconnected/);
  await h.adapter.retireOwner(h.owner);
  assert.deepEqual(h.adapter.diagnostics(), []);
  assert.match(h.errors[0], /source disconnected/);
});

test('exact UUID discovery/open and frame metadata; no pointer in invoke reply', async () => {
  const h = harness();
  assert.deepEqual(h.invoke('list'), [{ id: 'exact-uuid', name: 'Source', app: 'Fixture' }]);
  const session = await h.invoke('open', 'exact-uuid');
  assert.deepEqual(h.calls[0], ['open', 'exact-uuid']);
  assert.deepEqual(await h.invoke('poll', session), { kind: 'sent', width: 1920, height: 1080, sequence: 1 });
  const send = h.calls.find(call => call[0] === 'send');
  assert.equal(send[1].frame, h.owner.mainFrame);
  assert.deepEqual(send[2], { session, sequence: 1, width: 1920, height: 1080 });
  assert.equal(h.count('main-release'), 1);
  assert.equal(h.count('release'), 0);
  assert.deepEqual(await h.invoke('poll', session), { kind: 'busy' });
  assert.equal(h.count('acquire'), 1);
  h.callbacks[0]();
  assert.equal(h.count('release'), 1);
  await h.invoke('poll', session);
  assert.equal(h.count('acquire'), 2);
  h.callbacks[1](); h.invoke('close', session);
  assert.deepEqual(h.adapter.diagnostics(), []);
  assert.equal(h.owner.listenerCount('destroyed'), 0);
});

test('subframes, wrong origin and another owner cannot access the adapter/session', async () => {
  const h = harness();
  const session = await h.invoke('open', 'exact-uuid');
  h.event.senderFrame = {};
  for (const name of ['list', 'open', 'close']) assert.throws(() => h.invoke(name, session), /main frame/);
  await assert.rejects(h.invoke('poll', session), /main frame/);
  h.event.senderFrame = h.owner.mainFrame;
  h.owner.getURL = () => 'https://untrusted.test/';
  assert.throws(() => h.invoke('list'), /main frame/);
  const other = harness();
  assert.throws(() => h.handlers.get('loom-native-input-close')(other.event, session), /not owned/);
  h.owner.getURL = () => 'http://127.0.0.1:5187/';
  h.owner.mainFrame = {}; h.event.senderFrame = h.owner.mainFrame;
  await assert.rejects(h.invoke('poll', session), /not owned/);
});

test('invalid UUID is rejected without opening any native session', async () => {
  const h = harness();
  for (const uuid of ['', null, 'abc\0def', 'x'.repeat(4097)]) assert.throws(() => h.invoke('open', uuid), /Invalid/);
  assert.equal(h.count('open'), 0);
});

test('empty frames release acquire credit; overlapping acquire is bounded', async () => {
  const h = harness(), work = deferred();
  h.native.acquire = () => work.promise;
  const session = await h.invoke('open', 'exact-uuid');
  const first = h.invoke('poll', session);
  assert.deepEqual(await h.invoke('poll', session), { kind: 'busy' });
  work.resolve(null);
  assert.deepEqual(await first, { kind: 'empty' });
  assert.equal(h.adapter.diagnostics()[0].acquiring, false);
  assert.equal(h.count('import'), 0);
});

test('offline NDI retains one receiver without a GPU lease and resumes that session', async () => {
  const h = harness({ transport: 'ndi', beforeAccess: async () => {} });
  const session = await h.invoke('open', 'exact-uuid');
  h.native.acquire = async () => ({ kind: 'offline' });
  for (let index = 0; index < 3; index++)
    assert.deepEqual(await h.invoke('poll', session), { kind: 'offline' });
  assert.equal(h.count('open'), 1); assert.equal(h.count('close'), 0);
  assert.equal(h.count('import'), 0); assert.equal(h.count('release'), 0);
  assert.equal(h.adapter.diagnostics()[0].offline, true);
  assert.equal(h.adapter.diagnostics()[0].retainedLease, false);
  h.native.acquire = async () => h.frame();
  assert.equal((await h.invoke('poll', session)).kind, 'sent');
  assert.equal(h.adapter.diagnostics()[0].offline, false);
  assert.equal(h.adapter.diagnostics()[0].receivedFrames, 1);
  h.callbacks[0](); await h.invoke('close', session);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('closing an offline NDI acquire retires without importing or releasing a frame', async () => {
  const h = harness({ transport: 'ndi', beforeAccess: async () => {} }), work = deferred();
  const session = await h.invoke('open', 'exact-uuid');
  h.native.acquire = () => work.promise;
  const poll = h.invoke('poll', session);
  await h.invoke('close', session);
  work.resolve({ kind: 'offline' });
  assert.deepEqual(await poll, { kind: 'closed' });
  assert.equal(h.count('import'), 0); assert.equal(h.count('release'), 0);
  assert.equal(h.count('close'), 1); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('close during acquire releases unimported returned lease and cannot send stale frame', async () => {
  const h = harness(), work = deferred();
  h.native.acquire = () => work.promise;
  const session = await h.invoke('open', 'exact-uuid');
  const pending = h.invoke('poll', session);
  assert.equal(h.invoke('close', session).acquiring, true);
  assert.equal(h.adapter.diagnostics().length, 1);
  work.resolve(h.frame());
  assert.deepEqual(await pending, { kind: 'closed' });
  assert.equal(h.count('release'), 1); assert.equal(h.count('send'), 0);
  assert.equal(h.count('close'), 1); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('close during rejected native acquire retires without fabricated lease release', async () => {
  const h = harness(), work = deferred(); h.native.acquire = () => work.promise;
  const session = await h.invoke('open', 'exact-uuid'), pending = h.invoke('poll', session);
  h.invoke('close', session); work.reject(new Error('native acquisition retired'));
  assert.deepEqual(await pending, { kind: 'closed' });
  assert.equal(h.count('release'), 0); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('close after send retains lease and capacity until all references release', async () => {
  const h = harness({ maxSessions: 1 }), session = await h.invoke('open', 'exact-uuid');
  await h.invoke('poll', session);
  assert.equal(h.invoke('close', session).retainedLease, true);
  assert.throws(() => h.invoke('open', 'exact-uuid'), /cap reached/);
  assert.equal(h.count('release'), 0);
  h.callbacks[0](); assert.deepEqual(h.adapter.diagnostics(), []);
  assert.notEqual(await h.invoke('open', 'exact-uuid'), session);
});
test('owner drainage waits for the final GPU callback without force-releasing its lease', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  await h.invoke('poll', session);
  let done = false;
  const drained = h.adapter.retireOwner(h.owner).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false); assert.equal(h.count('release'), 0);
  h.callbacks[0](); await drained;
  assert.equal(done, true); assert.deepEqual(h.adapter.diagnostics(), []);
});
test('owner drainage rejects a quarantined release instead of authorizing unload', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  await h.invoke('poll', session);
  const drained = h.adapter.retireOwner(h.owner);
  h.native.release = () => { throw new Error('release refused'); };
  h.callbacks[0]();
  await assert.rejects(drained, /release refused/);
  assert.equal(h.adapter.diagnostics()[0].retainedLease, true);
});

test('send failure releases main reference but does not prematurely release native lease', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.sendSharedTexture = async () => { throw new Error('receiver timeout'); };
  await assert.rejects(h.invoke('poll', session), /receiver timeout/);
  assert.equal(h.count('main-release'), 1); assert.equal(h.count('release'), 0);
  await assert.rejects(h.invoke('poll', session), /receiver timeout/);
  h.invoke('close', session); h.callbacks[0]();
  assert.equal(h.count('release'), 1); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('import exception quarantines uncertain lease and reserves cap; callback can retire it', async () => {
  const h = harness({ maxSessions: 1 }), session = await h.invoke('open', 'exact-uuid');
  let released;
  h.sharedTexture.importSharedTexture = options => { released = options.allReferencesReleased; throw new Error('import failed'); };
  await assert.rejects(h.invoke('poll', session), /import failed/);
  assert.equal(h.count('release'), 0); assert.equal(h.count('main-release'), 0);
  assert.equal(h.invoke('close', session).quarantined, true);
  assert.throws(() => h.invoke('open', 'exact-uuid'), /cap reached/);
  released(); assert.equal(h.count('release'), 1); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('invalid frame is released before entering import, and stops session reuse', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.native.acquire = async () => ({ ...h.frame(), width: 0 });
  await assert.rejects(h.invoke('poll', session), /Malformed/);
  assert.equal(h.count('import'), 0); assert.equal(h.count('release'), 1);
  await assert.rejects(h.invoke('poll', session), /Malformed/);
});

test('reentrant all-reference release from main release is safe and exactly once', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.importSharedTexture = options => ({ release: options.allReferencesReleased });
  await h.invoke('poll', session);
  assert.equal(h.count('release'), 1); assert.equal(h.adapter.diagnostics()[0].retainedLease, false);
  h.invoke('close', session); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('close during pending send retains lease through late transfer completion', async () => {
  const h = harness(), sending = deferred(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.sendSharedTexture = () => sending.promise;
  const pending = h.invoke('poll', session); await Promise.resolve();
  h.invoke('close', session); sending.resolve();
  assert.deepEqual(await pending, { kind: 'closed' });
  assert.equal(h.count('main-release'), 1); assert.equal(h.count('release'), 0);
  h.callbacks[0](); assert.deepEqual(h.adapter.diagnostics(), []);
});

for (const kind of ['destroyed', 'render-process-gone', 'did-navigate']) {
  test(`${kind} retires only owned sessions and keeps imported leases until release`, async () => {
    const h = harness(), session = await h.invoke('open', 'exact-uuid');
    await h.invoke('poll', session);
    h.owner.emit(kind, { url: 'https://elsewhere.test/', isSameDocument: false, isMainFrame: true });
    assert.equal(h.count('close'), 1); assert.equal(h.count('release'), 0);
    h.callbacks[0](); assert.deepEqual(h.adapter.diagnostics(), []);
  });
}

test('same-document/subframe navigation does not close app session', async () => {
  const h = harness(); await h.invoke('open', 'exact-uuid');
  h.owner.emit('did-start-navigation', { url: 'http://127.0.0.1:5187/#x', isSameDocument: true, isMainFrame: true });
  h.owner.emit('did-start-navigation', { url: 'https://elsewhere.test/', isSameDocument: false, isMainFrame: false });
  assert.equal(h.count('close'), 0);
});

test('provisional or cancelled navigation keeps the current document input usable until commit', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.owner.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true });
  assert.equal(h.count('close'), 0);
  assert.equal((await h.invoke('poll', session)).kind, 'sent');
  h.callbacks[0]();
  h.owner.emit('did-navigate');
  assert.equal(h.count('close'), 1);
  assert.deepEqual(h.adapter.diagnostics(), []);
  await assert.rejects(h.invoke('poll', session), /not owned/);
});

test('dispose removes handlers but preserves retained lease diagnostics and late callbacks', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid'); await h.invoke('poll', session);
  assert.equal(h.adapter.dispose()[0].retainedLease, true); assert.equal(h.handlers.size, 0);
  h.adapter.dispose(); assert.equal(h.count('close'), 1);
  h.callbacks[0](); assert.deepEqual(h.adapter.dispose(), []);
});

test('release failures remain explicit, retained and never retried', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.native.release = id => { h.calls.push(['release', id]); throw new Error('native release failed'); };
  await h.invoke('poll', session); h.callbacks[0](); h.callbacks[0]();
  assert.equal(h.count('release'), 1); assert.equal(h.adapter.diagnostics()[0].retainedLease, true);
  assert.equal(h.adapter.diagnostics()[0].quarantined, true);
  assert.match(h.errors.join('\n'), /native release failed/);
});

test('retirement does not hide a failed GPU reference release', async () => {
  const h = harness(), sending = deferred(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.importSharedTexture = () => ({ release() { throw new Error('release failed after retirement'); } });
  h.sharedTexture.sendSharedTexture = () => sending.promise;
  const poll = h.invoke('poll', session); await Promise.resolve();
  h.invoke('close', session); sending.reject(new Error('receiver destroyed'));
  await assert.rejects(poll, /release failed after retirement/);
  assert.equal(h.adapter.diagnostics()[0].quarantined, true);
  assert.equal(h.count('release'), 0);
});

test('main-reference release failure rejects poll and leaves lease quarantined', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.importSharedTexture = () => ({ release() { throw new Error('main release failed'); } });
  await assert.rejects(h.invoke('poll', session), /main release failed/);
  assert.equal(h.adapter.diagnostics()[0].quarantined, true); assert.equal(h.count('release'), 0);
});

test('reentrant navigation during import cannot send to the now-retired owner frame', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.importSharedTexture = options => {
    h.owner.emit('did-navigate');
    return { release: options.allReferencesReleased };
  };
  assert.deepEqual(await h.invoke('poll', session), { kind: 'closed' });
  assert.equal(h.count('send'), 0); assert.equal(h.count('release'), 1);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('native close failure is reported as incomplete and still counts against cap', async () => {
  const h = harness({ maxSessions: 1 }), session = await h.invoke('open', 'exact-uuid');
  h.native.close = () => { throw new Error('native close failed'); };
  const closed = h.invoke('close', session);
  assert.equal(closed.complete, false); assert.equal(closed.nativeClosed, false);
  assert.match(closed.error, /native close failed/);
  assert.throws(() => h.invoke('open', 'exact-uuid'), /cap reached/);
});

test('native release failure inside synchronous final-reference callback rejects current poll', async () => {
  const h = harness(), session = await h.invoke('open', 'exact-uuid');
  h.sharedTexture.importSharedTexture = options => ({ release: options.allReferencesReleased });
  h.native.release = () => { throw new Error('native release failed'); };
  await assert.rejects(h.invoke('poll', session), /native release failed/);
  assert.equal(h.adapter.diagnostics()[0].quarantined, true);
});

test('owner destruction during native open closes the newly created native session', async () => {
  const h = harness();
  h.native.open = () => { h.owner.isDestroyed = () => true; return 'native-race'; };
  await assert.rejects(h.invoke('open', 'exact-uuid'), /closed or navigated during open/);
  assert.deepEqual(h.calls, [['close', 'native-race']]);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('one owner closing cannot retire another owner on the same installed adapter', async () => {
  const h = harness(), first = await h.invoke('open', 'exact-uuid');
  const other = new EventEmitter();
  other.mainFrame = {}; other.getURL = h.owner.getURL; other.isDestroyed = () => false;
  const otherEvent = { sender: other, senderFrame: other.mainFrame };
  const second = await h.handlers.get('loom-native-input-open')(otherEvent, 'second-uuid');
  await h.invoke('poll', first);
  h.owner.emit('destroyed'); h.callbacks[0]();
  assert.deepEqual(h.calls.filter(call => call[0] === 'close'), [['close', 'native-1']]);
  assert.deepEqual(h.adapter.diagnostics().map(item => [item.session, item.closed]), [[second, false]]);
  h.handlers.get('loom-native-input-close')(otherEvent, second);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('NDI requires consent and uses a separate fixed channel/session namespace', async () => {
  assert.throws(() => harness({ transport: 'other' }), /transport/);
  assert.throws(() => harness({ transport: 'ndi' }), /permission callback/);
  let requests = 0;
  const h = harness({ transport: 'ndi', beforeAccess: async () => { requests++; } });
  assert.equal(h.handlers.has('loom-native-input-open'), false);
  assert.deepEqual(await h.invoke('list'), [{ id: 'exact-uuid', name: 'Source', app: 'Fixture' }]);
  const session = await h.invoke('open', 'exact-uuid');
  assert.match(session, /^loom-ndi-input-/);
  assert.equal(requests, 2);
  h.invoke('close', session);
});

test('denied permission never calls native discovery/open and releases reserved capacity', async () => {
  const h = harness({ transport: 'ndi', maxSessions: 1,
    beforeAccess: async () => { throw new Error('LAN access denied'); } });
  h.native.list = () => { throw new Error('must not discover'); };
  await assert.rejects(h.invoke('list'), /LAN access denied/);
  await assert.rejects(h.invoke('open', 'exact-uuid'), /LAN access denied/);
  assert.equal(h.count('open'), 0);
  assert.deepEqual(h.adapter.diagnostics(), []);
  assert.equal(h.owner.listenerCount('did-navigate'), 0);
});

test('discovery reauthorizes after consent even when a committed document keeps the URL/frame', async () => {
  const permission = deferred();
  const h = harness({ transport: 'ndi', beforeAccess: () => permission.promise });
  h.native.list = () => { throw new Error('must not discover'); };
  const listing = h.invoke('list');
  h.owner.emit('did-navigate');
  permission.resolve();
  await assert.rejects(listing, /navigated during permission/);
  assert.equal(h.owner.listenerCount('did-navigate'), 0);
});

test('opening credit and navigation ownership are reserved before permission', async () => {
  const permission = deferred();
  const h = harness({ transport: 'ndi', maxSessions: 1, beforeAccess: () => permission.promise });
  const opening = h.invoke('open', 'exact-uuid');
  assert.equal(h.adapter.diagnostics()[0].opening, true);
  assert.deepEqual(await h.invoke('poll', h.adapter.diagnostics()[0].session), { kind: 'busy' });
  assert.equal(h.count('acquire'), 0);
  assert.throws(() => h.invoke('open', 'exact-uuid'), /cap reached/);
  h.owner.emit('did-navigate');
  let done = false;
  const drained = h.adapter.retireOwner(h.owner).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  permission.resolve();
  await assert.rejects(opening, /navigated during open/);
  await drained;
  assert.equal(h.count('open'), 0); assert.equal(h.count('close'), 0);
  assert.deepEqual(h.adapter.diagnostics(), []);
});

for (const retirement of ['navigation', 'dispose', 'close']) {
  test(`pending native open survives ${retirement} only long enough to await one native close`, async () => {
    const h = harness({ maxSessions: 1 }), opening = deferred(), closing = deferred();
    h.native.open = () => opening.promise;
    h.native.close = id => { h.calls.push(['close', id]); return closing.promise; };
    const pending = h.invoke('open', 'exact-uuid');
    const rejected = assert.rejects(pending, /navigated during open/);
    assert.throws(() => h.invoke('open', 'exact-uuid'), /cap reached/);
    if (retirement === 'navigation') h.owner.emit('did-navigate');
    else if (retirement === 'dispose') h.adapter.dispose();
    else h.invoke('close', h.adapter.diagnostics()[0].session);
    let done = false;
    const drained = h.adapter.retireOwner(h.owner).then(() => { done = true; });
    opening.resolve('native-late');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.count('close'), 1);
    assert.equal(h.adapter.diagnostics()[0].nativeClosed, false);
    assert.equal(done, false);
    closing.resolve();
    await rejected; await drained;
    assert.deepEqual(h.adapter.diagnostics(), []);
    assert.equal(h.count('close'), 1);
  });
}

test('native open rejection removes owned credit and listeners without closing a nonexistent session', async () => {
  const h = harness({ maxSessions: 1 });
  h.native.open = async () => { throw new Error('discovery failed'); };
  await assert.rejects(h.invoke('open', 'exact-uuid'), /discovery failed/);
  assert.deepEqual(h.adapter.diagnostics(), []);
  assert.equal(h.count('close'), 0);
  assert.equal(h.owner.listenerCount('did-navigate'), 0);
});

test('async native close and GPU lease must both finish before owner drainage', async () => {
  const h = harness(), closing = deferred(), session = await h.invoke('open', 'exact-uuid');
  h.native.close = () => closing.promise;
  await h.invoke('poll', session);
  let done = false;
  const drained = h.adapter.retireOwner(h.owner).then(() => { done = true; });
  h.callbacks[0]();
  await Promise.resolve(); assert.equal(done, false);
  assert.equal(h.adapter.diagnostics()[0].nativeClosed, false);
  closing.resolve(); await drained;
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('async close rejection is quarantined, blocks drainage/cap and is never retried', async () => {
  const h = harness({ maxSessions: 1 }), closing = deferred(), session = await h.invoke('open', 'exact-uuid');
  h.native.close = id => { h.calls.push(['close', id]); return closing.promise; };
  const closed = assert.rejects(h.invoke('close', session), /native worker close failed/);
  const drained = h.adapter.retireOwner(h.owner);
  closing.reject(new Error('native worker close failed'));
  await assert.rejects(drained, /native worker close failed/);
  await closed;
  assert.equal(h.adapter.diagnostics()[0].quarantined, true);
  assert.equal(h.adapter.diagnostics()[0].nativeClosed, false);
  assert.throws(() => h.invoke('open', 'exact-uuid'), /cap reached/);
  h.adapter.dispose(); assert.equal(h.count('close'), 1);
});

test('reported source failure still drains after asynchronous native close', async () => {
  const h = harness(), closing = deferred(), session = await h.invoke('open', 'exact-uuid');
  h.native.acquire = async () => { throw new Error('source disconnected'); };
  await assert.rejects(h.invoke('poll', session), /source disconnected/);
  h.native.close = () => closing.promise;
  const drained = h.adapter.retireOwner(h.owner);
  closing.resolve(); await drained;
  assert.deepEqual(h.adapter.diagnostics(), []);
});

test('IPC close awaits asynchronous native teardown without claiming GPU lease release', async () => {
  const h = harness(), closing = deferred(), session = await h.invoke('open', 'exact-uuid');
  await h.invoke('poll', session);
  h.native.close = () => closing.promise;
  let done = false;
  const closed = h.invoke('close', session).then(result => { done = true; return result; });
  await Promise.resolve(); assert.equal(done, false);
  closing.resolve();
  const result = await closed;
  assert.equal(result.nativeClosed, true);
  assert.equal(result.retainedLease, true);
  assert.equal(result.complete, false);
  h.callbacks[0](); assert.deepEqual(h.adapter.diagnostics(), []);
});

test('pending discovery cannot return sources after disposal', async () => {
  const h = harness({ transport: 'ndi', beforeAccess: async () => {} }), discovery = deferred();
  h.native.list = () => discovery.promise;
  const listing = h.invoke('list');
  await Promise.resolve();
  h.adapter.dispose(); discovery.resolve([]);
  await assert.rejects(listing, /disposed/);
  assert.equal(h.owner.listenerCount('did-navigate'), 0);
});
