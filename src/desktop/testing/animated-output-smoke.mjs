/* global window, document */
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';

/** Decode actual rendered frame IDs, not repeated compositor publications. */
export async function verifyAnimatedOutput({ app, page, receive, emptyProject, main }) {
  const snapshot = () => app.evaluate((_electron, path) => {
    // eslint-disable-next-line no-undef
    return process.getBuiltinModule('node:module').createRequire(path)(path).nativeOutputDiagnostics();
  }, main);
  const load = async text => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('project-open').click();
    await (await chooser).setFiles({ name: 'animated-output.loom.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  };
  const measurements = [];
  for (const count of [1, 2, 4]) {
    const names = Array.from({ length: count }, (_, index) => `Loom animated ${count}-${index + 1}`);
    const fixture = await page.evaluate(async names => {
      const { nativeOutputFixture } = await import(window.loomDesktopFixtureModules.output);
      return nativeOutputFixture(undefined, false, names, true);
    }, names);
    await load(fixture.text);
    await expect.poll(() => page.evaluate(async names => (await window.loomDesktop.input.list())
      .filter(source => names.includes(source.name)).length, names)).toBe(count);
    const mainWindow = await app.browserWindow(page);
    const phases = [];
    try {
      for (const phase of ['visible', 'hidden', 'restored']) {
        await mainWindow.evaluate((window, hidden) => hidden ? window.hide() : window.show(), phase === 'hidden');
        const state = await mainWindow.evaluate(window => ({ visible: window.isVisible(),
          backgroundThrottling: window.webContents.getBackgroundThrottling() }));
        assert.equal(state.visible, phase !== 'hidden');
        const before = await snapshot();
        assert.equal(before.length, count);
        // Settle every child before unwinding graph/GPU ownership on any failure.
        const results = await Promise.allSettled(names.map(name => receive({ seconds: 10, animated: true }, name)));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        const after = await snapshot();
        assert.equal(after.length, count);
        const documentVisibility = await page.evaluate(() => document.visibilityState);
        for (const [index, settled] of results.entries()) {
          const result = settled.value;
          const publisherBefore = before.find(output => output.publisherName === names[index]);
          const publisherAfter = after.find(output => output.publisherName === names[index]);
          assert.ok(publisherBefore && publisherAfter);
          assert.equal(publisherAfter.frameReady, true);
          assert.equal(publisherAfter.closed, false);
          assert.equal(publisherAfter.error, null);
          assert.equal(result.server.name, names[index]);
          assert.equal(result.ok, true); assert.equal(result.gpuDrained, true);
          for (const frame of result.frames) {
            assert.equal(frame.width, 1920); assert.equal(frame.height, 1080);
          }
          const measurement = { count, phase, ...state, documentVisibility,
            publisherFrames: publisherAfter.copied - publisherBefore.copied,
            publisherBusyDrops: publisherAfter.dropped - publisherBefore.dropped, ...result };
          phases.push(measurement);
          console.log('LOOM_ANIMATED_OUTPUT_MEASUREMENT', JSON.stringify(measurement));
          assert.ok(result.lastFrameId > result.firstFrameId, `${phase}: output repeated a frozen frame`);
          assert.ok(result.uniqueFps > 0, `${phase}: no unique animation received`);
        }
      }
    } finally { await mainWindow.evaluate(window => window.show()); }
    await load(emptyProject);
    await expect.poll(() => page.evaluate(async names => (await window.loomDesktop.input.list())
      .some(source => names.includes(source.name)), names)).toBe(false);
    measurements.push(...phases);
  }
  return measurements;
}
