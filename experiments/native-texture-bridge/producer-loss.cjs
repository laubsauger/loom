/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const native = require(process.env.SHADERLOOM_TEXTURE_ADDON);
async function run() {
  native.prepare(0, 0);
  const { producerPid } = native.status();
  assert.ok(producerPid > 0 && producerPid !== process.pid);
  process.kill(producerPid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while (!native.status().terminal && Date.now() < deadline) await delay(10);
  assert.equal(native.status().terminal, true, 'Producer death must terminate the session');
  assert.throws(() => native.release(), /Producer connection lost; new session required/);
  assert.throws(() => native.prepare(0, 0), /Producer connection lost; new session required/);
  native.abort();
  console.log('NATIVE_TEXTURE_PRODUCER_LOSS_PASS', JSON.stringify({ producerPid, consumerPid: process.pid }));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
