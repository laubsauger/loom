/* global window, performance */
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';

/** Shared source isolates publisher scaling; receiver readbacks stay outside timing. */
export async function verifyMultiOutputs({ app, page, receive, emptyProject, receiveSeconds = 0 }) {
  const load = async text => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('project-open').click();
    await (await chooser).setFiles({ name: 'multi-output.loom.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  };
  const measurements = [];
  for (const count of [1, 2, 4]) {
    const names = Array.from({ length: count }, (_, index) => `Loom scaling ${count}-${index + 1}`);
    const fixture = await page.evaluate(async names => {
      const { nativeOutputFixture } = await import(window.loomDesktopFixtureModules.output);
      return nativeOutputFixture(undefined, false, names);
    }, names);
    await load(fixture.text);
    await expect.poll(() => page.getByTestId('viewer-output-select').locator('option').evaluateAll(options => options.map(option => option.value)))
      .toContain(fixture.b);
    // Document loading and publisher creation are asynchronous. A window count
    // alone can describe the outgoing document instead of the requested one.
    await expect.poll(() => page.evaluate(async names => (await window.loomDesktop.input.list())
      .filter(source => names.includes(source.name)).length, names)).toBe(count);
    const outputs = () => app.windows().filter(window => !window.isClosed() && window.url().includes('/output.html?'));
    await expect.poll(() => outputs().length).toBe(count);
    const windows = outputs();
    const sessions = await Promise.all(windows.map(window => window.evaluate(() => window.name)));
    const snapshot = () => page.evaluate(async sessions => ({
      time: performance.now(),
      outputs: await Promise.all(sessions.map(name => window.loomDesktop.status(name))),
    }), sessions);
    await expect.poll(async () => (await snapshot()).outputs.every(output => output.copied >= 3 && output.size?.[0] === 1920 && output.size?.[1] === 1080)).toBe(true);
    const preflight = await Promise.allSettled(names.map(name => receive(3, name)));
    const preflightFailure = preflight.find(result => result.status === 'rejected');
    if (preflightFailure) throw preflightFailure.reason;
    const received = preflight.map(result => result.value);
    for (let index = 0; index < received.length; index++) {
      const result = received[index];
      assert.equal(result.server.name, names[index]);
      assert.equal(result.ok, true); assert.equal(result.gpuDrained, true);
      for (const frame of result.frames) {
        assert.equal(frame.width, 1920); assert.equal(frame.height, 1080);
        assert.deepEqual(frame.samples.slice(0, 2).map(sample => sample.rgba), [[0, 0, 255, 255], [0, 0, 255, 255]]);
        assert.deepEqual(frame.samples.slice(2, 4).map(sample => sample.rgba), [[0, 128, 0, 255], [0, 128, 0, 255]]);
      }
    }
    const samples = [await snapshot()];
    for (let index = 0; index < 10; index++) {
      await page.waitForTimeout(1000);
      samples.push(await snapshot());
    }
    const first = samples[0], last = samples.at(-1);
    const seconds = (last.time - first.time) / 1000;
    const streams = sessions.map((_, index) => {
      const intervals = samples.slice(1).map((sample, step) =>
        (sample.outputs[index].copied - samples[step].outputs[index].copied) * 1000 / (sample.time - samples[step].time)).sort((a, b) => a - b);
      for (const sample of samples) assert.equal(sample.outputs[index].error, null);
      return { published: last.outputs[index].copied - first.outputs[index].copied,
        fps: (last.outputs[index].copied - first.outputs[index].copied) / seconds,
        lowestOneSecondFps: intervals[0], medianOneSecondFps: intervals[Math.floor(intervals.length / 2)],
        busyDropped: last.outputs[index].dropped - first.outputs[index].dropped };
    });
    const measurement = { count, size: [1920, 1080], sharedSource: true, seconds, streams,
      aggregateFps: streams.reduce((sum, stream) => sum + stream.fps, 0) };
    measurements.push(measurement);
    console.log('LOOM_MULTI_OUTPUT_MEASUREMENT', JSON.stringify(measurement));
    if (receiveSeconds) {
      const before = await snapshot();
      const memory = [];
      let finished = false;
      // Await every bounded receiver even on failure; do not strand siblings
      // while unwinding the publisher graph or its temporary native binaries.
      const receiving = Promise.allSettled(names.map(name => receive({ seconds: receiveSeconds }, name)))
        .then(results => { finished = true; return results; });
      let results;
      try {
        while (!finished) {
          await page.waitForTimeout(1000);
          const sample = await snapshot();
          for (const output of sample.outputs) assert.equal(output.error, null);
          memory.push(await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
            pid: metric.pid, type: metric.type, memory: metric.memory,
          }))));
          if (memory.length % 10 === 0) console.log('LOOM_MULTI_RECEIVE_PROGRESS', JSON.stringify({ count, elapsed: (sample.time - before.time) / 1000 }));
        }
      } finally { results = await receiving; }
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const receivers = results.map(result => result.value);
      for (let index = 0; index < receivers.length; index++) {
        const result = receivers[index];
        assert.equal(result.server.name, names[index]);
        assert.equal(result.ok, true); assert.equal(result.gpuDrained, true);
        assert.ok(result.frameCount >= 3); assert.equal(result.frames.length, 2);
        assert.ok(result.elapsedSeconds >= receiveSeconds);
        assert.ok(result.receiveFps > 0); assert.ok(result.intervalP95Ms >= result.intervalP50Ms);
        for (const frame of result.frames) {
          assert.equal(frame.width, 1920); assert.equal(frame.height, 1080);
          assert.deepEqual(frame.samples.slice(0, 2).map(sample => sample.rgba), [[0, 0, 255, 255], [0, 0, 255, 255]]);
          assert.deepEqual(frame.samples.slice(2, 4).map(sample => sample.rgba), [[0, 128, 0, 255], [0, 128, 0, 255]]);
        }
      }
      const after = await snapshot();
      console.log('LOOM_MULTI_RECEIVE_MEASUREMENT', JSON.stringify({ count, requestedSeconds: receiveSeconds,
        size: [1920, 1080], staticSharedSource: true, oraclePixelReadback: true,
        publisherWindowSeconds: (after.time - before.time) / 1000,
        publishers: after.outputs.map((output, index) => ({ published: output.copied - before.outputs[index].copied,
          busyDropped: output.dropped - before.outputs[index].dropped, error: output.error })),
        receivers, memoryFirst: memory[0], memoryLast: memory.at(-1) }));
    }
    await load(emptyProject);
    await expect.poll(() => windows.every(window => window.isClosed())).toBe(true);
  }
  return measurements;
}
