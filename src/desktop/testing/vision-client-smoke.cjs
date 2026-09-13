/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { setInterval, clearInterval } = require('node:timers');
const console = require('node:console');
const { app } = require('electron');
const { Buffer } = require('node:buffer');

async function main() {
  const [addon, fixturePath, service, token, photo, profile, scenario] = process.argv.slice(2);
  app.setPath('userData', profile);
  await app.whenReady();
  const native = require(addon);
  const fixture = require(fixturePath);
  if (scenario === 'worker-host') {
    const { createVisionWorkers, retireVisionServices } = await import('../../devices/native/vision-workers.mjs');
    const { dirname, join } = require('node:path');
    const { readdir } = require('node:fs/promises');
    const directory = dirname(addon);
    const workers = createVisionWorkers({ native, directory, library: join(directory, 'vision-service.dylib'), python: token });
    const worker = await workers.open();
    try {
      for (const blank of [false, true, false]) {
        await worker.reset();
        const input = fixture.input(photo, blank), packed = fixture.pack(input);
        try {
          const result = await worker.infer(packed.handle, [packed.width, packed.height], [1920, 1080]);
          const coverage = fixture.verifyExpanded(result.handle);
          assert.equal(result.coverage, coverage);
          assert.ok(blank ? coverage === 0 : coverage > 0.01);
          await worker.release(result.sequence);
        } finally { fixture.releasePacked(packed.handle); fixture.release(input); }
      }
      await worker.close();
      assert.equal((await readdir(directory)).filter(name => /^vision-worker-.*\.plist$/.test(name)).length, 0);
      console.log('LOOM_VISION_WORKER_HOST_PASS', JSON.stringify({ consumer: process.pid, frames: 3, width: 1920, height: 1080 }));
    } finally {
      // Production parent normally runs this AFTER Electron exit. Here all test
      // oracle references are gone; cleanup is still mandatory on assertion failure.
      await retireVisionServices(directory);
    }
    return;
  }
  const session = native.open(service, token);
  assert.throws(() => native.release(session, 0), /No Vision result/);
  await native.reset(session);
  assert.throws(() => native.infer(session, Buffer.alloc(7)), /handle length/);
  const refused = native.open(service, 'invalid-token');
  await assert.rejects(native.reset(refused), { code: 'VISION_REQUEST_REFUSED', message: /Unauthorized/ });
  native.disconnect(refused);
  const empty = Array.from({ length: 7 }, () => native.open(service, token));
  assert.throws(() => native.open(service, token), /session cap/);
  for (const id of empty) native.disconnect(id);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const frames = [];
  try {
    for (let sequence = 0; sequence < 3; sequence++) {
      const blank = sequence === 2;
      if (blank) await native.reset(session);
      const input = fixture.input(photo, blank);
      let inputReleased = false;
      try {
        const before = ticks;
        const pending = native.infer(session, input);
        assert.ok(pending instanceof Promise);
        assert.throws(() => native.infer(session, input), /already in flight/);
        assert.throws(() => native.close(session), /already in flight/);
        assert.throws(() => native.disconnect(session), /pending work/);
        const output = await pending;
        const heartbeat = ticks - before;
        assert.ok(heartbeat > 0, 'Electron main thread did not advance during inference');
        assert.equal(output.sequence, sequence);
        assert.equal(output.format, 'rgba16float');
        assert.ok(output.producerPid > 0 && output.producerPid !== process.pid);
        const coverage = fixture.verify(output.handle);
        assert.ok(blank ? coverage < 0.01 : coverage > 0.01);
        assert.throws(() => native.infer(session, input), /Release Vision result/);
        assert.throws(() => native.reset(session), /Release Vision result/);
        assert.throws(() => native.close(session), /Release Vision result/);
        assert.throws(() => native.disconnect(session), /retained leases/);
        if (sequence > 0) assert.throws(() => native.release(session, sequence - 1), /Stale or invalid/);
        assert.equal(fixture.verify(output.handle), coverage);
        // Test oracle has finished reading. App wiring must wait for Electron's
        // allReferencesReleased callback before this same release operation.
        await native.release(session, output.sequence);
        assert.throws(() => native.release(session, sequence), /Stale or invalid/);
        assert.throws(() => native.release(session, sequence + 1), /No Vision result/);
        frames.push({ sequence, width: output.width, height: output.height, heartbeat, coverage });
        if (scenario === 'async-timeout') {
          // Stop only the authenticated worker belonging to this isolated test.
          // A real request now cannot complete; the client must remain live and
          // must not authorize reusing its uncertain input after the timeout.
          fixture.release(input);
          inputReleased = true;
          const frozenInput = fixture.input(photo, false);
          process.kill(output.producerPid, 'SIGSTOP');
          try {
            const beforeTimeout = ticks;
            await assert.rejects(native.infer(session, frozenInput), {
              code: 'VISION_COMPLETION_UNCERTAIN', message: /timeout; uncertain leases retained/,
            });
            assert.ok(ticks - beforeTimeout > 100, 'Electron stalled during timeout');
            assert.throws(() => native.close(session), /terminal/);
            assert.throws(() => native.disconnect(session), /retained leases/);
            console.log('LOOM_VISION_ASYNC_TIMEOUT_PASS', JSON.stringify({ consumer: process.pid, heartbeat: ticks - beforeTimeout }));
          } finally {
            process.kill(output.producerPid, 'SIGCONT');
            fixture.release(frozenInput);
          }
          return;
        }
      } finally {
        if (!inputReleased) fixture.release(input);
      }
    }
    await native.close(session);
    assert.throws(() => native.reset(session), /Unknown Vision session/);
    console.log('LOOM_VISION_ASYNC_PASS', JSON.stringify({ electron: process.versions.electron, consumer: process.pid, frames }));
  } finally {
    clearInterval(timer);
  }
}
main().then(() => app.quit(), error => { console.error(error); app.exit(1); });
