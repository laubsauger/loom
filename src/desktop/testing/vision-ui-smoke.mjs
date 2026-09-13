/* global window, document, navigator, Image, requestAnimationFrame */
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { fileURLToPath, URL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
const execute = promisify(execFile);

export async function verifyVisionUI({ app, page, photo, soakSeconds = 0, profileMemory = false }) {
  if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 3600) throw new Error('Vision soak must be 0..3600 seconds');
  // Test-only camera, never a product fallback. The app still owns getUserMedia,
  // video playback/resizing, graph evaluation and the complete Vision hook.
  await page.evaluate(async photo => {
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
    const image = new Image(); image.src = photo; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const context = canvas.getContext('2d');
    let empty = false;
    window.visionFixtureCamera = value => { empty = value; };
    const paint = () => {
      if (empty) { context.fillStyle = 'black'; context.fillRect(0, 0, canvas.width, canvas.height); }
      else context.drawImage(image, 0, 0, canvas.width, canvas.height);
      requestAnimationFrame(paint);
    };
    paint();
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
  }, photo);
  const fixture = await page.evaluate(async () => (await import(window.loomDesktopFixtureModules.vision)).nativeVisionFixture());
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('project-open').click();
  await (await chooser).setFiles({ name: 'vision.loom.json', mimeType: 'application/json', buffer: Buffer.from(fixture.text) });
  await page.getByTestId('viewer-output-select').selectOption(`${fixture.maskId}:out`);
  const status = () => app.evaluate((_electron, path) => {
    // eslint-disable-next-line no-undef
    return process.getBuiltinModule('node:module').createRequire(path)(path).nativeInferenceDiagnostics();
  }, fileURLToPath(new URL('../main.cjs', import.meta.url)));
  const coverage = async () => {
    const screenshot = await page.getByTestId('viewer-canvas').screenshot();
    return page.evaluate(async base64 => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let foreground = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 128) foreground++;
      return foreground / (canvas.width * canvas.height);
    }, screenshot.toString('base64'));
  };
  const stages = [];
  try {
    for (const empty of [false, true, false]) {
      await page.evaluate(empty => window.visionFixtureCamera(empty), empty);
      let measured;
      await expect(async () => {
        const sessions = await status();
        assert.equal(sessions.length, 1); assert.equal(sessions[0].error, null);
        measured = await coverage();
        assert.ok(empty ? measured === 0 : measured > 0.01, `Unexpected camera coverage ${measured}`);
      }).toPass({ timeout: 20000 });
      stages.push({ empty, coverage: measured });
    }
    if (soakSeconds) {
      const mainWindow = await app.browserWindow(page);
      await mainWindow.evaluate(window => { window.webContents.setBackgroundThrottling(false); window.hide(); });
      const cdp = await page.context().newCDPSession(page);
      const startSampling = async () => {
        await cdp.send('Memory.startSampling', { samplingInterval: 65536 });
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 65536 });
      };
      if (profileMemory) await startSampling();
      const allocationProfile = async stage => {
        if (!profileMemory) return;
        const { profile } = await cdp.send('Memory.getSamplingProfile');
        console.log('LOOM_NATIVE_VISION_ALLOCATIONS', JSON.stringify({ stage, modules: profile.modules,
          samples: [...profile.samples].sort((a, b) => b.total - a.total).slice(0, 20) }));
        const { profile: js } = await cdp.send('HeapProfiler.getSamplingProfile');
        const retained = [];
        const visit = (node, stack) => {
          const path = [...stack, node.callFrame];
          if (node.selfSize) retained.push({ size: node.selfSize, stack: path });
          node.children.forEach(child => visit(child, path));
        };
        visit(js.head, []);
        console.log('LOOM_NATIVE_VISION_JS_ALLOCATIONS', JSON.stringify({ stage,
          samples: retained.sort((a, b) => b.size - a.size).slice(0, 20) }));
      };
      const samples = [];
      let elapsed = 0, previousFrames = -1;
      while (elapsed < soakSeconds) {
        const wait = Math.min(10, soakSeconds - elapsed);
        await setTimeout(wait * 1000); elapsed += wait;
        const sessions = await status();
        assert.equal(sessions.length, 1); assert.equal(sessions[0].error, null);
        assert.ok(sessions[0].frames > previousFrames, 'Native inference stopped producing results');
        previousFrames = sessions[0].frames;
        const pid = sessions[0].producerPid;
        assert.ok(Number.isInteger(pid) && pid > 0);
        const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'rss='], { timeout: 5000 });
        const pythonRssKiB = Number(stdout.trim()); assert.ok(pythonRssKiB > 0);
        const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(entry => ({ pid: entry.pid, type: entry.type, memory: entry.memory })));
        const heap = await cdp.send('Runtime.getHeapUsage');
        const timingMeasures = await page.evaluate(() => window.performance.getEntriesByType('measure').length);
        const sample = { elapsed, frames: previousFrames, producerPid: pid, pythonRssKiB, processes, heap, timingMeasures };
        samples.push(sample); console.log('LOOM_NATIVE_VISION_SOAK_SAMPLE', JSON.stringify(sample));
      }
      console.log('LOOM_NATIVE_VISION_SOAK_PASS', JSON.stringify({ seconds: soakSeconds, samples: samples.length,
        first: samples[0], last: samples.at(-1) }));
      await allocationProfile('native');
      if (profileMemory) {
        await cdp.send('Memory.stopSampling'); await cdp.send('HeapProfiler.stopSampling'); await startSampling();
      }
      const bypass = page.locator(`.react-flow__node[data-id="${fixture.maskId}"]`).getByRole('button', { name: 'Bypass', exact: true });
      await bypass.click();
      await expect.poll(status).toEqual([]);
      for (let elapsed = 0; elapsed <= 60; elapsed += 10) {
        if (elapsed) await setTimeout(10000);
        const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(entry => ({ pid: entry.pid, type: entry.type, memory: entry.memory })));
        console.log('LOOM_NATIVE_VISION_BYPASS_SAMPLE', JSON.stringify({ elapsed, processes, heap: await cdp.send('Runtime.getHeapUsage') }));
      }
      // Diagnostic only, AFTER the unmodified run and bypass comparison. Never
      // force collection in product code or count it as natural memory stability.
      await allocationProfile('bypassed');
      await cdp.send('HeapProfiler.collectGarbage');
      console.log('LOOM_NATIVE_VISION_POST_GC', JSON.stringify({ heap: await cdp.send('Runtime.getHeapUsage'),
        processes: await app.evaluate(({ app }) => app.getAppMetrics().map(entry => ({ pid: entry.pid, type: entry.type, memory: entry.memory }))) }));
      await allocationProfile('bypassed-after-gc');
      if (profileMemory) { await cdp.send('Memory.stopSampling'); await cdp.send('HeapProfiler.stopSampling'); }
      await cdp.detach();
      await bypass.click();
      await expect.poll(async () => (await status()).length).toBe(1);
      await mainWindow.evaluate(window => window.showInactive());
    }
    await page.getByLabel('Out point', { exact: true }).fill('1');
    await page.getByLabel('Out point', { exact: true }).press('Enter');
    await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true, value: async () => {
        document.body.dataset.visionTakeEncoded = 'true';
        throw new window.DOMException('Smoke cancels saving the encoded take', 'AbortError');
      },
    }));
    await page.getByRole('button', { name: 'Render the range', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('data-vision-take-encoded', 'true', { timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Render the range', exact: true })).toBeEnabled();
    console.log('LOOM_NATIVE_VISION_OFFLINE_TAKE_PASS');
    // The synthetic project has an unsaved range edit, not a filesystem handle.
    // Discard it explicitly before testing navigation retirement.
    await page.getByLabel('Out point', { exact: true }).fill('599');
    await page.getByLabel('Out point', { exact: true }).press('Enter');
    await page.reload();
    await expect.poll(status, { timeout: 20000 }).toEqual([]);
    console.log('LOOM_NATIVE_VISION_UI_PASS', JSON.stringify({ stages, reloadRetired: true }));
  } catch (error) {
    console.log('LOOM_NATIVE_VISION_UI_FAILURE', JSON.stringify({ sessions: await status(), text: await page.locator('body').innerText() }));
    throw error;
  }
}
