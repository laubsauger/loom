/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { EventEmitter } = require('node:events');

function harness() {
  const ipc = new EventEmitter(), calls = [];
  let api;
  ipc.invoke = async (...args) => { calls.push(args); return 'result'; };
  runInNewContext(readFileSync(join(__dirname, 'permissions-preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) {
        assert.equal(name, 'loomPermissions'); api = value;
      } } };
    },
  });
  return { api, ipc, calls };
}
test('permissions bridge exposes only fixed operations without forwarding caller arguments', async () => {
  const { api, calls } = harness();
  assert.deepEqual(Object.keys(api).sort(), ['list', 'openSystemSettings', 'subscribe']);
  assert.equal(await api.list('foreign'), 'result');
  assert.equal(await api.openSystemSettings('/arbitrary/path'), 'result');
  assert.deepEqual(calls, [['loom-permissions-list'], ['loom-permissions-system-settings']]);
});
test('permission notifications never expose IPC events and unsubscribe removes the listener', () => {
  const { api, ipc } = harness();
  assert.throws(() => api.subscribe(null), /requires a callback/);
  const received = [];
  const unsubscribe = api.subscribe((...args) => received.push(args));
  ipc.emit('loom-permissions-changed', { sender: 'privileged' }, 'untrusted');
  assert.deepEqual(received, [[]]);
  unsubscribe(); unsubscribe();
  assert.equal(ipc.listenerCount('loom-permissions-changed'), 0);
  ipc.emit('loom-permissions-changed');
  assert.equal(received.length, 1);
});
