// Run with Electron, passing explicit input-addon and fixture-addon paths.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require('electron');
const assert = require('node:assert/strict');
const console = require('node:console');
const process = require('node:process');
const { setTimeout, clearTimeout } = require('node:timers');
const { resolve } = require('node:path');
const [inputPath, fixturePath] = process.argv.slice(2);
let stage = 'startup';
const timeout = setTimeout(() => { console.error(`Syphon input test watchdog: ${stage}`); app.exit(1); }, 20000);
const delay = () => new Promise(done => setTimeout(done, 20));
app.whenReady().then(async () => {
  const input = require(resolve(inputPath));
  const fixture = require(resolve(fixturePath));
  let assertions = 0;
  try {
    assert.throws(() => input.open('missing-uuid'), /unavailable/); assertions++;
    assert.throws(() => input.close('missing-session'), /Unknown/); assertions++;
    assert.throws(() => input.release('missing-lease'), /Unknown/); assertions++;
    const uuid = fixture.start();
    stage = 'discovery';
    while (!input.list().some(server => server.id === uuid)) await delay();
    const session = input.open(uuid);
    // Connection establishment is asynchronous; publish until a frame is acquired.
    let frame;
    stage = 'initial frame';
    while (!frame) { fixture.publish(73); await delay(); frame = await input.acquire(session); }
    assert.equal(frame.width, 1280); assert.equal(frame.height, 720); assertions += 2;
    assert.deepEqual([...fixture.sample(frame.handle)], [73,31,17,255]); assertions++;
    assert.throws(() => input.acquire(session), /unreleased lease/); assertions++;
    fixture.publish(199); await delay();
    assert.deepEqual([...fixture.sample(frame.handle)], [73,31,17,255]); assertions++;
    input.release(frame.leaseId);
    let newer;
    stage = 'updated frame';
    while (!newer) { await delay(); newer = await input.acquire(session); }
    assert.deepEqual([...fixture.sample(newer.handle)], [199,31,17,255]); assertions++;
    assert.equal(newer.sequence, frame.sequence + 1); assertions++;
    input.release(newer.leaseId);
    assert.equal(await input.acquire(session), null); assertions++;
    fixture.resize1080(); fixture.publish(113); await delay();
    frame = null;
    stage = 'resized frame';
    while (!frame) { await delay(); frame = await input.acquire(session); }
    assert.equal(frame.width, 1920); assert.equal(frame.height, 1080); assertions+=2;
    input.close(session);
    assert.deepEqual([...fixture.sample(frame.handle)], [113,31,17,255]); assertions++;
    input.release(frame.leaseId);
    assert.throws(() => input.release(frame.leaseId), /already released/); assertions++;
    assert.throws(() => input.acquire(session), /closed/); assertions++;

    const next = input.open(uuid);
    assert.notEqual(next, session); assertions++;
    let pending;
    stage = 'close in flight';
    while (!pending) {
      fixture.publish(91); await delay();
      const candidate = input.acquire(next);
      // Immediately close before async completion; a null result is harmless and retried.
      let overlap = false;
      try { input.acquire(next); } catch (error) { overlap = /acquisition/.test(error.message); }
      if (overlap) { pending = candidate; assertions++; }
      else await candidate;
    }
    const rejection = assert.rejects(pending, /closed during acquisition/);
    input.close(next);
    await rejection; assertions++;
    const lost = input.open(uuid);
    fixture.stop();
    stage = 'directory retirement';
    while (input.list().some(server => server.id === uuid)) await delay();
    stage = 'disconnect';
    assert.throws(() => input.acquire(lost), /disconnected/);
    assertions++;
    input.close(lost);
    console.log(JSON.stringify({ ok: true, assertions, uuid }));
  } finally {
    fixture.stop(); clearTimeout(timeout);
  }
}).then(() => app.exit(0), error => { console.error(error); clearTimeout(timeout); app.exit(1); });
