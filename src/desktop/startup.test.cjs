/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

function loadMain() {
  const calls = [];
  const module = { exports: {} };
  const app = { on() {}, setPath() { calls.push('profile'); }, enableSandbox() { calls.push('sandbox'); },
    whenReady() { calls.push('ready'); return new Promise(() => {}); } };
  const load = name => {
    if (name === 'electron') return { app };
    if (name === 'node:path') return require(name);
    if (name === './policy.cjs') return { validateOrigin: () => 'http://127.0.0.1:5188', webPreferences: {} };
    if (name === './file-permissions.cjs' || name === './unload-gate.cjs') return {};
    throw new Error(`Unexpected startup dependency: ${name}`);
  };
  runInNewContext(readFileSync(join(__dirname, 'main.cjs'), 'utf8'), {
    module, require: load, process: { env: { LOOM_DESKTOP_PROFILE: '/test-profile' } },
    setTimeout() { return 1; }, clearTimeout() {}, __dirname,
  });
  return { calls, host: module.exports };
}

test('normal entry starts immediately after profile/sandbox setup', () => {
  const { calls, host } = loadMain();
  runInNewContext(readFileSync(join(__dirname, 'entry.cjs'), 'utf8'), { require: () => host });
  assert.deepEqual(calls, ['profile', 'sandbox', 'ready']);
});

test('automation can defer windows without deferring sandbox/profile setup', () => {
  const { calls, host } = loadMain();
  assert.deepEqual(calls, ['profile', 'sandbox']);
  const context = { module: { exports: {} }, require: () => host };
  runInNewContext(readFileSync(join(__dirname, 'testing/electron-entry.cjs'), 'utf8'), context);
  assert.deepEqual(calls, ['profile', 'sandbox']);
  context.__playwright_run();
  assert.deepEqual(calls, ['profile', 'sandbox', 'ready']);
  assert.equal(context.module.exports, host);
  assert.throws(() => context.__playwright_run(), /only once/);
});

async function permissionHost(platform = 'darwin') {
  const handlers = new Map(), preloads = [], opened = [], failures = [];
  const module = { exports: {} };
  let openError = '';
  const origin = 'http://127.0.0.1:5188';
  const electron = {
    app: { on() {}, setPath() {}, enableSandbox() {}, whenReady: async () => {}, exit: code => failures.push(code) },
    BrowserWindow: class { async loadURL() {} },
    session: { defaultSession: { registerPreloadScript: script => preloads.push(script) } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    systemPreferences: { getMediaAccessStatus: type => {
      assert.ok(type === 'camera' || type === 'microphone');
      return type === 'camera' ? 'denied' : 'granted';
    } },
    shell: { openPath: async path => { opened.push(path); return openError; } },
  };
  runInNewContext(readFileSync(join(__dirname, 'main.cjs'), 'utf8'), {
    module, __dirname, process: { platform, env: { LOOM_DESKTOP_PROFILE: '/test-profile' }, versions: {} },
    setTimeout() {}, clearTimeout() {}, console: { log() {}, error: error => failures.push(error) },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:path') return require(name);
      if (name === './policy.cjs') return { validateOrigin: () => origin, webPreferences: {} };
      if (name === './unload-gate.cjs') return {};
      if (name === './file-permissions.cjs') return { installFilePermissions: () => ({
        snapshot: () => ['camera', 'microphone', 'speaker', 'ndi'].map(id => ({ id, decision: 'allowed' })),
      }) };
      throw new Error(`Unexpected startup dependency: ${name}`);
    },
  });
  await module.exports.startDesktop();
  assert.deepEqual(failures, []);
  const frame = {};
  const event = { sender: { mainFrame: frame, getURL: () => `${origin}/` }, senderFrame: frame };
  return { handlers, event, opened, preloads, failOpen: message => { openError = message; } };
}

test('permission IPC requires the exact editor main frame and keeps app/OS status separate', async () => {
  const h = await permissionHost();
  assert.equal(h.preloads.length, 1);
  assert.equal(h.preloads[0].type, 'frame');
  assert.equal(h.preloads[0].filePath, join(__dirname, 'permissions-preload.cjs'));
  const list = h.handlers.get('loom-permissions-list');
  const statuses = list(h.event);
  assert.equal(statuses[0].decision, 'allowed');
  assert.equal(statuses[0].system, 'denied');
  assert.equal(statuses[2].system, 'managed-by-browser');
  assert.equal(statuses[3].system, 'managed-by-os');
  assert.throws(() => list({ ...h.event, senderFrame: {} }), /main frame/);
  assert.throws(() => list({ ...h.event, sender: { ...h.event.sender, getURL: () => 'http://127.0.0.1:5188/output.html' } }), /main frame/);
  const open = h.handlers.get('loom-permissions-system-settings');
  await assert.rejects(open({ ...h.event, senderFrame: {} }), /main frame/);
  assert.deepEqual(h.opened, []);
  await open(h.event, '/arbitrary/path');
  assert.deepEqual(h.opened, ['/System/Applications/System Settings.app']);
  h.failOpen('Launch failed');
  await assert.rejects(open(h.event), /Cannot open System Settings: Launch failed/);
});

test('non-Mac status does not invent OS grants or launch a Mac settings path', async () => {
  const h = await permissionHost('win32');
  assert.ok(h.handlers.get('loom-permissions-list')(h.event)
    .every(entry => entry.system === (entry.id === 'ndi' ? 'managed-by-os' : 'managed-by-browser')));
  await assert.rejects(h.handlers.get('loom-permissions-system-settings')(h.event), /not implemented on this platform/);
  assert.deepEqual(h.opened, []);
});
