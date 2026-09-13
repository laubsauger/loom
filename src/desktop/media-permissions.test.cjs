/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMediaPermissions } = require('./media-permissions.cjs');
const tick = () => new Promise(resolve => require('node:timers').setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function harness() {
  const origin = 'http://127.0.0.1:5188', prompts = [], os = [], reports = [], notifications = [];
  const contents = new EventEmitter();
  contents.mainFrame = {}; contents.getURL = () => `${origin}/`; contents.isDestroyed = () => false;
  const actions = { confirm: async () => true, system: async () => true };
  const policy = createMediaPermissions({ origin, notify: sender => notifications.push(policy.snapshot(sender)),
    confirm: async (sender, options) => { prompts.push(options); return actions.confirm(sender, options); },
    requestSystemAccess: async type => { os.push(type); return actions.system(type); }, report: value => reports.push(value) });
  const request = (type = 'video', overrides = {}, permission = type === 'speaker' ? 'speaker-selection' : 'media') => {
    const results = [];
    policy.request(contents, permission, value => results.push(value), {
      requestingUrl: `${origin}/`, isMainFrame: true, mediaTypes: [type], ...overrides,
    });
    return results;
  };
  const check = (type = 'video', details = {}) => policy.check(contents,
    type === 'speaker' ? 'speaker-selection' : 'media', origin, { isMainFrame: true, mediaType: type, ...details });
  return { policy, contents, origin, prompts, os, reports, notifications, actions, request, check };
}
test('first-use consent precedes OS access; grants and denials are type scoped', async () => {
  const h = harness(), prompt = deferred(); h.actions.confirm = () => prompt.promise;
  assert.equal(h.check(), false);
  const video = h.request(); await tick(); assert.deepEqual(h.os, []);
  prompt.resolve(true); await tick(); assert.deepEqual(video, [true]); assert.deepEqual(h.os, ['camera']);
  assert.equal(h.check(), true); assert.equal(h.check('audio'), false); assert.equal(h.check('speaker'), false);
  h.actions.confirm = async () => false;
  const audio = h.request('audio'); await tick(); assert.deepEqual(audio, [false]);
  assert.deepEqual(h.os, ['camera']);
  const again = h.request('audio'); await tick(); assert.deepEqual(again, [false]); assert.equal(h.prompts.length, 2);
  h.actions.confirm = async () => true;
  const speaker = h.request('speaker'); await tick(); assert.deepEqual(speaker, [true]);
  assert.equal(h.check('speaker'), true); assert.deepEqual(h.os, ['camera']);
});

test('native NDI consent is independent, coalesced and never impersonates camera OS access', async () => {
  const h = harness(), prompt = deferred(); h.actions.confirm = () => prompt.promise;
  const first = h.policy.requestNdi(h.contents), second = h.policy.requestNdi(h.contents);
  await tick();
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].message, /local network for NDI/);
  assert.equal(h.policy.snapshot(h.contents).find(entry => entry.id === 'ndi').decision, 'pending');
  prompt.resolve(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(h.os, []);
  assert.equal(h.check('video'), false);
  assert.equal(h.policy.handles('ndi'), false);
  assert.equal(h.policy.snapshot(h.contents).find(entry => entry.id === 'ndi').decision, 'allowed');
  h.contents.emit('did-navigate');
  h.actions.confirm = async () => false;
  assert.equal(await h.policy.requestNdi(h.contents), false);
  assert.equal(h.policy.snapshot(h.contents).find(entry => entry.id === 'ndi').decision, 'denied');
});

test('navigation during NDI consent denies the pending native operation', async () => {
  const h = harness(), prompt = deferred(); h.actions.confirm = () => prompt.promise;
  const pending = h.policy.requestNdi(h.contents);
  await tick(); h.contents.emit('did-start-navigation');
  assert.equal(await pending, false);
  prompt.resolve(true); await tick();
  assert.notEqual(h.policy.snapshot(h.contents).find(entry => entry.id === 'ndi').decision, 'allowed');
  h.contents.getURL = () => 'https://foreign.test/';
  assert.equal(await h.policy.requestNdi(h.contents), false);
});

test('serialized URL security origins accept the same origin without widening document access', async () => {
  const h = harness();
  const allowed = h.request('video', { securityOrigin: `${h.origin}/` });
  await tick();
  assert.deepEqual(allowed, [true]);
  assert.equal(h.check('video', { securityOrigin: `${h.origin}/` }), true);
  assert.equal(h.policy.check(h.contents, 'media', `${h.origin}/`, { isMainFrame: true, mediaType: 'video' }), true);
  assert.deepEqual(h.request('audio', { securityOrigin: 'not a URL' }), [false]);
  assert.deepEqual(h.request('audio', { securityOrigin: `${h.origin}.foreign.test/` }), [false]);
});
test('OS refusal and rejected permission work deny without granting checks', async () => {
  const h = harness(); h.actions.system = async () => false;
  const denied = h.request(); await tick(); assert.deepEqual(denied, [false]); assert.equal(h.check(), false);
  assert.equal(h.policy.snapshot(h.contents).find(entry => entry.id === 'camera').decision, 'allowed');
  const deniedAgain = h.request(); await tick(); assert.deepEqual(deniedAgain, [false]);
  h.actions.confirm = async () => { throw new Error('dialog unavailable'); };
  const failure = h.request('audio'); await tick(); assert.deepEqual(failure, [false]); assert.match(h.reports[0], /dialog unavailable/);
});
test('foreign, subframe and malformed requests/checks are denied', async () => {
  const h = harness();
  for (const details of [{ isMainFrame: false }, { isMainFrame: undefined }, { requestingUrl: `${h.origin}/other` },
    { securityOrigin: 'https://foreign.test' }, { mediaTypes: [] }, { mediaTypes: ['unknown'] },
    { mediaTypes: ['speaker'] }, { mediaTypes: undefined }]) assert.deepEqual(h.request('video', details), [false]);
  assert.deepEqual(h.request('video', {}, 'notifications'), [false]);
  h.contents.getURL = () => 'https://foreign.test/'; assert.deepEqual(h.request(), [false]);
  h.contents.getURL = () => `${h.origin}/`; const grant = h.request(); await tick(); assert.deepEqual(grant, [true]);
  for (const details of [{ isMainFrame: false }, { isMainFrame: undefined }, { mediaType: undefined },
    { mediaType: 'unknown' }, { securityOrigin: 'https://foreign.test' }, { requestingUrl: `${h.origin}/child` }])
    assert.equal(h.check('video', details), false);
  assert.equal(h.policy.check(h.contents, 'media', 'https://foreign.test', { isMainFrame: true, mediaType: 'video' }), false);
});
test('simultaneous same-type requests coalesce; different types serialize', async () => {
  const h = harness(), prompt = deferred(); h.actions.confirm = () => prompt.promise;
  const first = h.request(), second = h.request(), audio = h.request('audio');
  await tick(); assert.equal(h.prompts.length, 1); assert.deepEqual(audio, []);
  prompt.resolve(true); await tick();
  assert.deepEqual(first, [true]); assert.deepEqual(second, [true]); assert.deepEqual(audio, [true]);
  assert.equal(h.prompts.length, 2); assert.deepEqual(h.os, ['camera', 'microphone']);
});
test('navigation before prompt start cancels immediately and a new document asks again', async () => {
  const h = harness(), first = h.request(); h.contents.emit('did-start-navigation');
  assert.deepEqual(first, [false]); await tick(); assert.equal(h.prompts.length, 0);
  const next = h.request(); await tick(); assert.deepEqual(next, [true]); assert.equal(h.check(), true);
  h.contents.emit('did-start-navigation'); assert.equal(h.check(), true);
  h.contents.emit('did-navigate'); assert.equal(h.check(), false);
  const third = h.request(); await tick(); assert.deepEqual(third, [true]); assert.equal(h.prompts.length, 2);
});
test('navigation during prompt denies queued requests and prevents late OS requests', async () => {
  const h = harness(), prompt = deferred(); h.actions.confirm = () => prompt.promise;
  const first = h.request(), queued = h.request('audio'); await tick();
  h.contents.emit('did-start-navigation'); assert.deepEqual(first, [false]); assert.deepEqual(queued, [false]);
  const next = h.request(); await tick(); assert.equal(h.prompts.length, 1);
  prompt.resolve(true); await tick(); assert.deepEqual(next, [true]);
  assert.deepEqual(first, [false]); assert.deepEqual(h.os, ['camera']); assert.equal(h.prompts.length, 2);
});
test('destruction or navigation during OS permission denies once, even on late success', async () => {
  for (const event of ['destroyed', 'did-start-navigation']) {
    const h = harness(), system = deferred(); h.actions.system = () => system.promise;
    const first = h.request(); await tick(); assert.deepEqual(h.os, ['camera']);
    if (event === 'destroyed') h.contents.isDestroyed = () => true;
    h.contents.emit(event); assert.deepEqual(first, [false]);
    system.resolve(true); await tick(); assert.deepEqual(first, [false]); assert.equal(h.check(), false);
    assert.equal(h.contents.listenerCount('destroyed'), event === 'destroyed' ? 0 : 1);
  }
});

test('cancelled provisional navigation retains granted and denied document choices', async () => {
  const h = harness(); h.request(); await tick();
  h.actions.confirm = async () => false; h.request('audio'); await tick();
  const before = h.policy.snapshot(h.contents);
  h.contents.emit('did-start-navigation');
  assert.equal(h.check(), true); assert.deepEqual(h.policy.snapshot(h.contents), before);
  assert.deepEqual(h.notifications.at(-1), before);
  const again = h.request(); await tick(); assert.deepEqual(again, [true]); assert.equal(h.prompts.length, 2);
  h.contents.emit('did-navigate'); assert.equal(h.check(), false);
  assert.ok(h.policy.snapshot(h.contents).every(entry => entry.decision === 'not-requested'));
  assert.equal(h.contents.listenerCount('did-start-navigation'), 0);
});

test('cancelled prompt cannot remove a replacement pending request or publish late consent', async () => {
  const h = harness(), old = deferred(), replacement = deferred();
  h.actions.confirm = () => h.prompts.length === 1 ? old.promise : replacement.promise;
  const first = h.request(); await tick();
  h.contents.emit('did-start-navigation'); assert.deepEqual(first, [false]);
  const second = h.request();
  old.resolve(true); await tick();
  assert.equal(h.prompts.length, 2); assert.deepEqual(h.os, []);
  assert.equal(h.policy.snapshot(h.contents)[0].decision, 'pending');
  const coalesced = h.request(); await tick(); assert.equal(h.prompts.length, 2);
  replacement.resolve(true); await tick();
  assert.deepEqual(second, [true]); assert.deepEqual(coalesced, [true]); assert.deepEqual(first, [false]);
  assert.equal(h.notifications.at(-1)[0].decision, 'allowed');
  assert.deepEqual(h.notifications.map(entries => entries[0].decision), ['pending', 'not-requested', 'pending', 'allowed']);
});

test('renderer loss retires grants and pending work; destruction sends no late notification', async () => {
  const h = harness(); h.request(); await tick();
  const prompt = deferred(); h.actions.confirm = () => prompt.promise;
  const pending = h.request('audio'); await tick();
  h.contents.emit('render-process-gone'); assert.deepEqual(pending, [false]); assert.equal(h.check(), false);
  assert.ok(h.notifications.at(-1).every(entry => entry.decision === 'not-requested'));
  const notificationCount = h.notifications.length;
  h.contents.isDestroyed = () => true; h.contents.emit('destroyed');
  prompt.resolve(true); await tick(); assert.equal(h.notifications.length, notificationCount);
  assert.deepEqual(h.os, ['camera']);
});
