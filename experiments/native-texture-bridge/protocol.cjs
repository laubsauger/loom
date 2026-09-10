/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const native = require(process.env.SHADERLOOM_TEXTURE_ADDON);
assert.throws(() => native.release(), /No consumer surface/);
assert.throws(() => native.dispose(), /Incomplete consumer stream/);
assert.throws(() => native.prepare(0, 1), /Invalid prepare arguments/);
for (let sequence = 0; sequence < 24; sequence++) {
  const handle = native.prepare(sequence < 12 ? 0 : 1, sequence);
  assert.equal(handle.byteLength, 8);
  assert.throws(() => native.prepare(0, sequence), /Unreleased consumer surface/);
  assert.throws(() => native.dispose(), /Incomplete consumer stream/);
  native.release();
  assert.throws(() => native.release(), /No consumer surface/);
}
const producerPid = native.dispose();
assert.notEqual(producerPid, process.pid);
console.log('NATIVE_TEXTURE_PROTOCOL_PASS', JSON.stringify({ producerPid, consumerPid: process.pid, releases: 24 }));
