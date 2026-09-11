/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

async function harness() {
  const handlers = {};
  const exits = [];
  const scripts = [];
  let ready;
  let watchdog;
  let releases = 0;
  let nativeFailure = false;
  let deferredInspection;
  const wc = {
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    setWindowOpenHandler() {}, on(name, callback) { handlers[name] = callback; },
    async loadURL() {}, async executeJavaScript(script) { scripts.push(script); },
  };
  const app = {
    enableSandbox() {}, setPath() {},
    whenReady: () => ({ then(callback) { ready = Promise.resolve().then(callback); return ready; } }),
    exit(code) { exits.push(code); },
  };
  runInNewContext(readFileSync(join(__dirname, 'export-main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? { app, BrowserWindow: class { webContents = wc; } }
      : { async inspect(samples) { if (nativeFailure) throw new Error('Invalid layout'); if (deferredInspection) await deferredInspection; return samples; } },
    process: { env: {}, versions: { electron: 'test' }, pid: 1 },
    console: { log() {}, error() {} },
    setTimeout(callback) { watchdog = callback; return 1; }, clearTimeout() {},
  });
  await ready;
  return {
    exits, scripts, timeout: () => watchdog(), failNative: () => { nativeFailure = true; },
    hold() { let resolve; deferredInspection = new Promise(done => { resolve = done; }); return () => resolve(); },
    get releases() { return releases; },
    paint(blue = false, pixelFormat = 'bgra') {
      const samples = [0, 1, 2, 3].flatMap(i => [blue ? 0 : 255, i < 2 ? 0 : 188, blue ? 255 : 0, 255]);
      return handlers.paint({ texture: { textureInfo: { pixelFormat, handle: { ioSurface: samples } }, release() { releases++; } } });
    },
    noTexture() { return handlers.paint({}); },
  };
}

test('export requires A/B/A pixels; stale frames release without advancing', async () => {
  const h = await harness();
  await h.paint(); await h.paint();
  assert.equal(h.scripts.filter(s => s.includes('select(1)')).length, 1);
  assert.deepEqual(h.exits, []);
  await h.paint(true); await h.paint();
  await Promise.resolve();
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.releases, 4);
});

test('missing shared texture fails explicitly, without a bitmap path', async () => {
  const h = await harness();
  await h.noTexture();
  assert.deepEqual(h.exits, [1]);
});

test('unsupported format and native inspection failure release leases and cannot pass later', async () => {
  for (const native of [false, true]) {
    const h = await harness();
    if (native) h.failNative();
    await h.paint(false, native ? 'bgra' : 'rgbaf16');
    await h.paint(); await h.paint(true); await h.paint();
    assert.deepEqual(h.exits, [1]);
    assert.equal(h.releases, 4);
  }
});

test('timeout stays terminal despite late valid frames', async () => {
  const h = await harness();
  h.timeout(); await h.paint(); await h.paint(true); await h.paint();
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.releases, 3);
});

test('one native GPU lease stays held until completion; excess frames are released', async () => {
  const h = await harness();
  const resume = h.hold();
  const first = h.paint();
  assert.equal(h.releases, 0);
  await h.paint();
  assert.equal(h.releases, 1);
  h.timeout();
  resume();
  await first;
  assert.equal(h.releases, 2);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.scripts.filter(s => s.includes('select(1)')).length, 0);
});
