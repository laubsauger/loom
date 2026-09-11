/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate } = require('node:timers/promises');
const { installUnloadGate } = require('./unload-gate.cjs');
function harness() {
  const window = new EventEmitter(), contents = new EventEmitter(), calls = [], errors = [];
  window.webContents = contents;
  window.close = () => calls.push('close');
  contents.executeJavaScript = async script => { calls.push(script); };
  contents.reload = () => { calls.push('reload'); };
  let resolve, reject;
  const drained = new Promise((yes, no) => { resolve = yes; reject = no; });
  installUnloadGate({ window, inputs: { retireOwner: owner => {
    assert.equal(owner, contents); calls.push('drain'); return drained;
  } }, onError: error => errors.push(String(error)) });
  return { window, contents, calls, errors, resolve, reject };
}
test('reload resumes only after renderer preparation and confirmed GPU drainage', async () => {
  const h = harness();
  h.contents.emit('will-prevent-unload'); h.contents.emit('will-prevent-unload');
  await setImmediate();
  assert.deepEqual(h.calls, ['window.loomDesktop.input.prepareForUnload()', 'drain']);
  h.resolve(); await setImmediate();
  assert.deepEqual(h.calls.slice(2), ['window.loomDesktop.input.commitUnload()', 'reload']);
  assert.deepEqual(h.errors, []);
});
test('close is resumed as close, never changed into reload', async () => {
  const h = harness(); h.window.emit('close'); h.contents.emit('will-prevent-unload');
  await setImmediate(); h.resolve(); await setImmediate();
  assert.equal(h.calls.at(-1), 'close');
});
test('failed drainage cannot authorize unload', async () => {
  const h = harness(); h.window.emit('close'); h.contents.emit('will-prevent-unload');
  await setImmediate(); h.reject(new Error('retained GPU lease')); await setImmediate();
  assert.deepEqual(h.calls, ['window.loomDesktop.input.prepareForUnload()', 'drain']);
  assert.match(h.errors[0], /retained GPU lease/);
});
