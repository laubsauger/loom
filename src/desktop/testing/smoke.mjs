/* global window, navigator, Blob, URL, Worker, document, Image, setTimeout, clearTimeout */
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { verifyMultiOutputs } from './multi-output-smoke.mjs';
import { verifySelfInput } from './self-input-smoke.mjs';

export async function verifyDesktop({ executable, main, env }) {
  const app = await _electron.launch({ executablePath: executable, args: [main], env, timeout: 30000 });
  let mainErrors = '';
  app.process().stderr.on('data', chunk => {
    mainErrors += String(chunk);
    console.error('ELECTRON_STDERR', String(chunk));
  });
  app.process().stdout.on('data', chunk => console.log('ELECTRON_STDOUT', String(chunk)));
  try {
    app.on('window', output => output.on('pageerror', error => console.log('LOOM_OUTPUT_PAGE_ERROR', error.message)));
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => {
      // Electron's will-prevent-unload gate owns this decision. Playwright's
      // automatic acceptance races its cancellation ("No dialog is showing")
      // and would bypass the lifetime ordering this smoke is proving.
      if (dialog.type() === 'beforeunload') return;
      errors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`);
      void dialog.dismiss().catch(error => errors.push(error.message));
    });
    await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    const capabilities = await page.evaluate(async () => {
      if (!window.crossOriginIsolated) throw new Error('App is not cross-origin isolated');
      const bytes = new SharedArrayBuffer(4);
      const source = URL.createObjectURL(new Blob([`onmessage = ({ data }) => {
        Atomics.store(new Int32Array(data), 0, 42);
        postMessage({ isolated: crossOriginIsolated });
      };`], { type: 'text/javascript' }));
      const worker = new Worker(source);
      let timer;
      try {
        const reply = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Shared worker-memory test timed out')), 10000);
          worker.onmessage = event => resolve(event.data);
          worker.onerror = () => reject(new Error('SAB worker failed'));
          worker.postMessage(bytes);
        });
        if (!reply.isolated || Atomics.load(new Int32Array(bytes), 0) !== 42) throw new Error('Worker memory is not shared');
      } finally {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(source);
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter');
      return { isolated: window.crossOriginIsolated, sharedWorkerValue: Atomics.load(new Int32Array(bytes), 0),
        userAgent: navigator.userAgent, nodeAccess: typeof window.require,
        vendor: adapter.info.vendor, architecture: adapter.info.architecture };
    });
    assert.equal(capabilities.nodeAccess, 'undefined');
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);

    const canvas = page.getByTestId('viewer-canvas');
    await expect(canvas).toBeVisible();
    // Screenshot is the compositor output, not a WebGPU canvas CPU-readback guess.
    await expect.poll(async () => {
      const shot = await canvas.screenshot();
      return page.evaluate(async base64 => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const copy = document.createElement('canvas');
        copy.width = image.width; copy.height = image.height;
        const context = copy.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
        let low = 255; let high = 0;
        for (let i = 0; i < pixels.length; i += 4) { low = Math.min(low, pixels[i]); high = Math.max(high, pixels[i]); }
        return high - low;
      }, shot.toString('base64'));
    }, { timeout: 10000, message: 'Starter viewer did not show nonuniform rendered pixels' }).toBeGreaterThan(32);

    const popupPromise = app.waitForEvent('window');
    assert.equal(await page.evaluate(() => window.open('', 'loom-smoke', 'popup=yes,width=400,height=300') !== null), true);
    const popup = await popupPromise;
    assert.equal(await page.evaluate(() => {
      const child = window.open('', 'loom-smoke');
      child.document.body.textContent = 'Same-origin pane';
      return child.document.body.textContent;
    }), 'Same-origin pane');
    assert.equal(await popup.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => window.open('https://example.com', 'external') === null), true);
    await popup.close();
    assert.deepEqual(errors, []);
    if (env.LOOM_DESKTOP_SELF_INPUT === '1') {
      await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }));
      await page.evaluate(() => Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }));
      for (let cycle = 0; cycle < 3; cycle++) {
        await verifySelfInput({ app, page });
        console.log('LOOM_SELF_INPUT_RELOAD_CYCLE_PASS', cycle + 1);
      }
      await verifySelfInput({ app, page, shutdown: true });
      assert.deepEqual(errors, []);
      assert.doesNotMatch(mainErrors, /loom-native-input-(?:poll|close)|Native input .*Error:/,
        'Native input lifecycle logged an error during the self-loop/reload proof');
      console.log('LOOM_DESKTOP_SELF_INPUT_SMOKE_PASS', JSON.stringify(capabilities));
      return;
    }
    if (env.LOOM_NATIVE_OUTPUT_ADDON) {
      const fixture = await page.evaluate(async () => {
        const { nativeOutputFixture } = await import('/src/desktop/testing/output-fixture.ts');
        Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
        return nativeOutputFixture();
      });
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('project-open').click();
      await (await chooser).setFiles({ name: 'native-output-smoke.loom.json', mimeType: 'application/json', buffer: Buffer.from(fixture.text) });
      await expect(page.getByTestId('viewer-output-select').locator('option', { hasText: 'Native A:out' })).toHaveCount(1);
      await page.getByTestId('viewer-output-select').selectOption(fixture.a);
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
      const nativeWindow = app.waitForEvent('window');
      await page.getByTestId('native-output-toggle').click();
      const output = await nativeWindow;
      output.on('console', message => { if (message.type() === 'error') console.error('NATIVE_OUTPUT_RENDERER_ERROR', message.text()); });
      output.on('pageerror', error => console.error('NATIVE_OUTPUT_RENDERER_ERROR', error.message));
      await output.waitForURL('**/src/desktop/output.html?**');
      try { await output.waitForFunction(() => window.name.startsWith('loom-native-output-')); }
      catch (error) {
        console.error('NATIVE_OUTPUT_UI_STATUS', await page.getByTestId('native-output-toggle').getAttribute('data-native-output-status'));
        throw error;
      }
      await expect(page.getByTestId('native-output-toggle')).toHaveAttribute('data-native-output-ready', 'true', { timeout: 15000 });
      const toolbar = page.getByTestId('native-output-toggle').locator('..');
      const priorWidth = await toolbar.evaluate(element => {
        const previous = element.style.width; element.style.width = '320px'; return previous;
      });
      try {
        const layout = await toolbar.evaluate(element => {
          const bar = element.getBoundingClientRect();
          const controls = [...element.children].map(child => child.getBoundingClientRect());
          return { height: bar.height, fits: controls.every(rect => rect.left >= bar.left && rect.right <= bar.right + 1),
            overlaps: controls.some((rect, index) => index > 0 && rect.left < controls[index - 1].right),
            text: element.textContent };
        });
        assert.equal(layout.fits, true, 'Native toolbar overflows at 320px');
        assert.equal(layout.overlaps, false, 'Native toolbar controls overlap');
        assert.ok(layout.height <= 32, `Native toolbar grew to ${layout.height}px`);
        assert.ok(!layout.text.includes('Native GPU:'), 'Native counters leaked into toolbar');
        await page.mouse.move(0, 0);
        await toolbar.screenshot({ path: fileURLToPath(new URL('../../.cache/native-output-toolbar.png', import.meta.url)) });
        console.log('LOOM_NATIVE_TOOLBAR_PASS', JSON.stringify(layout));
      } finally { await toolbar.evaluate((element, width) => { element.style.width = width; }, priorWidth); }
      const name = await output.evaluate(() => window.name);
      if (!name.startsWith('loom-native-output-')) throw new Error(`Unexpected output window name: ${name}`);
      console.log('LOOM_NATIVE_WINDOW_DIAGNOSTIC', JSON.stringify(await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), size: w.getContentSize(),
          offscreen: w.webContents.isOffscreen(), painting: w.webContents.isPainting(),
          preferences: w.webContents.getLastWebPreferences() })))));
      console.log('LOOM_NATIVE_CANVAS_DIAGNOSTIC', JSON.stringify(await output.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return { ready: document.readyState, visibility: document.visibilityState, viewport: [window.innerWidth, window.innerHeight], size: canvas ? [canvas.width, canvas.height] : null,
          rect: canvas?.getBoundingClientRect().toJSON(), opener: !!window.opener };
      })));
      await expect.poll(async () => {
        const status = await page.evaluate(name => window.loomDesktop.status(name), name);
        if (status.error) throw new Error(status.error);
        console.log('NATIVE_OUTPUT_PROGRESS', JSON.stringify({ ...status,
          ui: await page.getByTestId('native-output-toggle').getAttribute('data-native-output-status'),
          received: await output.locator('canvas').getAttribute('data-received-frames') }));
        return status.copied;
      }, { timeout: 15000, message: 'Actual app did not publish native Syphon frames' }).toBeGreaterThanOrEqual(3);
      const mainWindow = await app.browserWindow(page);
      const beforeHidden = await page.evaluate(async name => (await window.loomDesktop.status(name)).copied, name);
      try {
        await mainWindow.evaluate(window => window.hide());
        await expect.poll(() => page.evaluate(async name => (await window.loomDesktop.status(name)).copied, name), {
          timeout: 5000, message: 'Hiding the editor stopped native publication',
        }).toBeGreaterThan(beforeHidden + 2);
      } finally { await mainWindow.evaluate(window => window.show()); }
      const nativeStatus = await page.evaluate(name => window.loomDesktop.status(name), name);
      const receive = (count = 3, publisherName = name) => new Promise((resolve, reject) => {
        const receiver = spawn(env.LOOM_SYPHON_RECEIVER, [publisherName, String(count), '15000'], { timeout: 20000, killSignal: 'SIGKILL' });
        let text = '';
        receiver.stdout.on('data', chunk => { text += chunk; });
        receiver.stderr.on('data', chunk => { text += chunk; });
        receiver.once('error', reject);
        receiver.once('exit', (code, signal) => {
          if (code !== 0) { reject(new Error(`Independent Syphon receiver failed ${code}/${signal}: ${text}`)); return; }
          try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
        });
      });
      for (const selection of [{ key: fixture.a, width: 1280, height: 720, color: [255, 0, 0, 255] },
        { key: fixture.b, width: 1920, height: 1080, color: [0, 0, 255, 255] },
        { key: fixture.a, width: 1280, height: 720, color: [255, 0, 0, 255] }]) {
        await page.getByTestId('viewer-output-select').selectOption(selection.key);
        await expect.poll(() => output.locator('canvas').evaluate(canvas => [canvas.width, canvas.height])).toEqual([selection.width, selection.height]);
        await expect.poll(() => page.evaluate(async name => (await window.loomDesktop.status(name)).size, name),
          { message: 'Native publication did not complete the selected resize' }).toEqual([selection.width, selection.height]);
        const metric = () => output.locator('canvas').evaluate(canvas => ({
          frames: Number(canvas.dataset.receivedFrames), ms: Number(canvas.dataset.presentationMs), time: window.performance.now() }));
        const before = await metric();
        const count = selection.width === 1920 ? 120 : 3;
        const received = await receive(count);
        const after = await metric();
        if (selection.width === 1920) {
          const input = await page.evaluate(async name => {
            const { verifyNativeInput } = await import('/src/desktop/testing/input-fixture.ts');
            return verifyNativeInput(name);
          }, name);
          assert.equal(input.frames, 3);
          console.log('LOOM_NATIVE_INPUT_ROUND_TRIP_PASS', JSON.stringify(input));
        }
        assert.equal(received.ok, true); assert.equal(received.gpuDrained, true);
        assert.equal(received.server.name, name); assert.equal(received.frames.length, count);
        for (const frame of received.frames) {
          assert.equal(frame.width, selection.width); assert.equal(frame.height, selection.height);
          assert.equal(frame.format, 'bgra8unorm');
          assert.deepEqual(frame.samples.slice(0, 2).map(sample => sample.rgba), [selection.color, selection.color]);
          assert.deepEqual(frame.samples.slice(2, 4).map(sample => sample.rgba), [[0, 128, 0, 255], [0, 128, 0, 255]]);
        }
        console.log('LOOM_SYPHON_RECEIVER_PASS', JSON.stringify({ ...received, frames: [received.frames[0], received.frames.at(-1)] }));
        console.log('LOOM_NATIVE_PRESENTATION_MEASUREMENT', JSON.stringify({ width: selection.width, height: selection.height,
          frames: after.frames - before.frames, elapsedMs: after.time - before.time,
          meanHandlerCpuMs: (after.ms - before.ms) / (after.frames - before.frames) }));
      }
      const finalStatus = await page.evaluate(name => window.loomDesktop.status(name), name);
      assert.equal(finalStatus.allocation.queuesCreated, 1, 'Publisher recreated a Metal queue per frame');
      assert.equal(finalStatus.allocation.publishers, 1);
      console.log('LOOM_NATIVE_OUTPUT_SMOKE_PASS', JSON.stringify({ name, ...nativeStatus }));
      await page.getByTestId('native-output-toggle').click();
      await expect.poll(() => output.isClosed()).toBe(true);
      const directory = dirname(env.LOOM_NATIVE_INPUT_ADDON);
      const publisher = spawn(executable, [fileURLToPath(new URL('./input-publisher.cjs', import.meta.url)),
        join(directory, 'input-fixture.node'), join(directory, 'publisher-profile')], { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => publisher.once('exit', resolve));
      try {
        const uuid = await new Promise((resolve, reject) => {
          let text = '';
          const timer = setTimeout(() => reject(new Error('Native publisher startup timed out')), 10000);
          publisher.once('error', reject);
          publisher.stdout.on('data', chunk => {
            text += String(chunk);
            const match = /LOOM_INPUT_PUBLISHER (\S+)/.exec(text);
            if (match) { clearTimeout(timer); resolve(match[1]); }
          });
        });
        const inputProject = await page.evaluate(async uuid => {
          const { nativeOutputFixture } = await import('/src/desktop/testing/output-fixture.ts');
          return nativeOutputFixture(uuid, true);
        }, uuid);
        const inputChooser = page.waitForEvent('filechooser');
        await page.getByTestId('project-open').click();
        await (await inputChooser).setFiles({ name: 'native-input.loom.json', mimeType: 'application/json', buffer: Buffer.from(inputProject.text) });
        await expect.poll(() => page.getByTestId('viewer-output-select').locator('option').evaluateAll(options => options.map(option => option.value)))
          .toContain(inputProject.native);
        const centerPixel = async () => {
          const shot = await page.getByTestId('viewer-canvas').screenshot();
          return page.evaluate(async base64 => {
            const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
            return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
          }, shot.toString('base64'));
        };
        await page.getByTestId('viewer-output-select').selectOption(inputProject.a);
        // The current graph/display pipeline maps this blue code to 16 even for
        // a graph-generated checker. Compare native transport against that control,
        // not an assumed identity display transform. No tolerance added.
        await expect.poll(centerPixel, { timeout: 15000 }).toEqual([73, 31, 16, 255]);
        const reference = await centerPixel();
        await page.getByTestId('viewer-output-select').selectOption(inputProject.native);
        await expect(page.getByLabel('Resolved output')).toContainText('1920 × 1080');
        await expect.poll(centerPixel, { timeout: 15000, message: 'Syphon In differs from the equivalent graph color control' }).toEqual(reference);
        console.log('LOOM_SYPHON_GRAPH_INPUT_PASS', JSON.stringify({ uuid, nested: true, size: [1920, 1080], rgba: reference }));
      // Exercise main-process retirement independently of React cleanup: navigation
      // drains the owner while BOTH native directions still have live sources.
      const reloadOutputPromise = app.waitForEvent('window');
      await page.getByTestId('native-output-toggle').click();
      const reloadOutput = await reloadOutputPromise;
      const reloadName = new URL(reloadOutput.url()).searchParams.get('name');
      try {
        await expect.poll(() => page.evaluate(async name => (await window.loomDesktop.status(name)).copied, reloadName))
          .toBeGreaterThan(0);
      } catch (error) {
        console.error('LOOM_RELOAD_OUTPUT_NOT_READY', await reloadOutput.evaluate(() => ({
          received: document.querySelector('canvas')?.dataset.receivedFrames,
          bridge: typeof window.loomNativeSurface, text: document.body.innerText,
        })), await page.getByTestId('native-output-toggle').getAttribute('data-native-output-status'));
        throw error;
      }
      // Keep the smoke's in-memory upload route across reload. Native file-system
      // handles cannot refer to Playwright's synthetic File payloads.
      await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }));
      await page.reload();
      await expect.poll(() => reloadOutput.isClosed()).toBe(true);
      // This function executes in Electron main, not in the browser or test process.
      await expect.poll(() => app.evaluate(() => {
        // eslint-disable-next-line no-undef
        const addon = process.env.LOOM_NATIVE_OUTPUT_ADDON;
        // Playwright's main-process evaluation has process but no CommonJS require.
        // eslint-disable-next-line no-undef
        const load = process.getBuiltinModule('node:module').createRequire(addon);
        return load(addon).stats().publishers;
      })).toBe(0);
      console.log('LOOM_NATIVE_OUTPUT_RELOAD_PASS', JSON.stringify({ publishers: 0, windowClosed: true }));
      } finally { publisher.kill('SIGTERM'); await exited; }
      const graphPublisher = 'Loom graph smoke';
      const outputProject = await page.evaluate(async name => {
        const { nativeOutputFixture } = await import('/src/desktop/testing/output-fixture.ts');
        return nativeOutputFixture(undefined, false, name);
      }, graphPublisher);
      const graphWindowPromise = app.waitForEvent('window').catch(async error => {
        console.error('LOOM_SYPHON_GRAPH_OUTPUT_FAILURE', await page.locator('body').innerText());
        throw error;
      });
      const graphChooser = page.waitForEvent('filechooser');
      await page.getByTestId('project-open').click();
      await (await graphChooser).setFiles({ name: 'syphon-output.loom.json', mimeType: 'application/json', buffer: Buffer.from(outputProject.text) });
      const graphWindow = await graphWindowPromise;
      const graphReceived = await receive(12, graphPublisher);
      for (const frame of graphReceived.frames) {
        assert.equal(frame.width, 1920); assert.equal(frame.height, 1080);
        assert.deepEqual(frame.samples.slice(0, 2).map(sample => sample.rgba), [[0, 0, 255, 255], [0, 0, 255, 255]]);
      }
      assert.equal(graphReceived.server.name, graphPublisher);
      // Loading a document without the node retires its publisher.
      const clearChooser = page.waitForEvent('filechooser');
      await page.getByTestId('project-open').click();
      await (await clearChooser).setFiles({ name: 'no-syphon-output.loom.json', mimeType: 'application/json', buffer: Buffer.from(fixture.text) });
      await expect.poll(() => graphWindow.isClosed()).toBe(true);
      console.log('LOOM_SYPHON_GRAPH_OUTPUT_PASS', JSON.stringify({ frames: graphReceived.frames.length, size: [1920, 1080], publisherName: graphPublisher, retired: true }));
      await verifyMultiOutputs({ app, page, receive, emptyProject: fixture.text });
      await verifySelfInput({ app, page });
    }
    console.log('LOOM_DESKTOP_SMOKE_PASS', JSON.stringify(capabilities));
  } finally {
    await app.close();
    assert.doesNotMatch(mainErrors, /LOOM_NATIVE_UNLOAD_FAILED|LOOM_NATIVE_INPUT_PENDING_SHUTDOWN/,
      'Native shutdown failed or retained unproven GPU leases');
  }
}
