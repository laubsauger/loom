/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

test('timeout remains terminal when app.exit synchronously triggers a late release callback', () => {
  const exits = [];
  let acknowledgments = 0;
  let watchdog;
  let lateRelease;
  const app = {
    setPath() {},
    whenReady: () => ({ then: () => ({ catch() {} }) }),
    exit(code) {
      exits.push(code);
      if (exits.length === 1) lateRelease();
    },
  };
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  runInNewContext(`${source}\n gpuGone = true; deviceLost = true;
    active = { released: false };
    installLateRelease(() => { active.released = true; finishGpuLoss(); });`, {
    require: name => name === 'electron' ? { app } : name === 'node:path' ? { join } : {
      release() { acknowledgments++; }, abort() {},
    },
    process: { env: { SHADERLOOM_PROOF_CHECK: 'gpu-loss' }, pid: 1 },
    console: { log() {}, error() {} },
    setTimeout: callback => { watchdog = callback; return 1; },
    clearTimeout() {},
    installLateRelease: callback => { lateRelease = callback; },
    __dirname,
  });
  watchdog();
  assert.deepEqual(exits, [1]);
  assert.equal(acknowledgments, 0);
});
