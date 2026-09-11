/* global window, performance */
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';

/** Shared source isolates publisher scaling; receiver readbacks stay outside timing. */
export async function verifyMultiOutputs({ app, page, receive, emptyProject }) {
  const load = async text => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('project-open').click();
    await (await chooser).setFiles({ name: 'multi-output.loom.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  };
  const measurements = [];
  for (const count of [1, 2, 4]) {
    const names = Array.from({ length: count }, (_, index) => `Loom scaling ${count}-${index + 1}`);
    const fixture = await page.evaluate(async names => {
      const { nativeOutputFixture } = await import('/src/desktop/testing/output-fixture.ts');
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
    const received = await Promise.all(names.map(name => receive(3, name)));
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
    await load(emptyProject);
    await expect.poll(() => windows.every(window => window.isClosed())).toBe(true);
  }
  return measurements;
}
