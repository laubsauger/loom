/* global window, navigator, Blob, URL, Worker, document, Image, setTimeout, clearTimeout */
import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { verifyMultiOutputs } from './multi-output-smoke.mjs';
import { verifyAnimatedOutput } from './animated-output-smoke.mjs';
import { verifySelfInput } from './self-input-smoke.mjs';
import { receiveSyphon } from './syphon-receiver.mjs';
import { verifyMediaPermissions } from './media-permission-smoke.mjs';
import { verifyNdiInput, verifyNdiOutput } from './ndi-input-smoke.mjs';
import { ndiReceiveSeconds, ndiReceiveCounts } from './ndi-roundtrip.mjs';
import { ndiOutputMode } from '../../devices/native/ndi-build.mjs';

export async function verifyDesktop({ executable, main, env, startupOnly = false, fixtureModules, onStarted }) {
  const mediaConsent = env.LOOM_DESKTOP_MEDIA_CONSENT_TEST === '1';
  const ndiInput = env.LOOM_DESKTOP_NDI_TEST === '1';
  const ndiSeconds = ndiReceiveSeconds(env.LOOM_DESKTOP_NDI_RECEIVE_SECONDS);
  const outputMode = ndiOutputMode(env.LOOM_NDI_OUTPUT_MODE);
  const ndiCounts = ndiReceiveCounts(env.LOOM_DESKTOP_NDI_STREAM_COUNT);
  if (env.LOOM_DESKTOP_NDI_STREAM_COUNT !== undefined && !ndiInput)
    throw new Error('NDI stream selection requires LOOM_DESKTOP_NDI_TEST=1');
  const ndiCpuMeasurement = env.LOOM_DESKTOP_NDI_CPU_MEASUREMENT === '1';
  if (env.LOOM_DESKTOP_NDI_CPU_MEASUREMENT !== undefined && !ndiCpuMeasurement)
    throw new Error('LOOM_DESKTOP_NDI_CPU_MEASUREMENT must be 1 when supplied');
  if (ndiCpuMeasurement && !ndiSeconds) throw new Error('NDI CPU measurement requires an explicit receive duration');
  if (ndiSeconds && !ndiInput) throw new Error('NDI receive duration requires LOOM_DESKTOP_NDI_TEST=1');
  if (ndiInput && (mediaConsent || startupOnly || env.LOOM_DESKTOP_SELF_INPUT || env.LOOM_DESKTOP_VISION_PHOTO || env.LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS))
    throw new Error('NDI input smoke cannot combine with other native measurement scopes');
  if (ndiInput && (!env.LOOM_NATIVE_NDI_ADDON || !env.LOOM_NDI_TEST_SENDER))
    throw new Error('NDI input smoke requires the explicitly configured local SDK and sender');
  if (mediaConsent && (startupOnly || env.LOOM_DESKTOP_SELF_INPUT || env.LOOM_DESKTOP_VISION_PHOTO || env.LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS))
    throw new Error('Media consent smoke cannot combine with other native measurement scopes');
  const receiveSeconds = env.LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS === undefined ? 0 : Number(env.LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS);
  if (env.LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS !== undefined && (!Number.isInteger(receiveSeconds) || receiveSeconds < 1 || receiveSeconds > 600))
    throw new Error('LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS must be an integer from 1 to 600');
  if (receiveSeconds && (startupOnly || env.LOOM_DESKTOP_SELF_INPUT || env.LOOM_DESKTOP_VISION_PHOTO))
    throw new Error('Receiver measurement requires the full Syphon smoke, not startup, self-input-only or Vision mode');
  if (receiveSeconds && !env.LOOM_NATIVE_OUTPUT_ADDON)
    throw new Error('Receiver measurement requires macOS native video addons');
  if (startupOnly && !env.LOOM_NATIVE_OUTPUT_ADDON) throw new Error('Native startup smoke requires macOS native video addons');
  const entry = fileURLToPath(new URL('./electron-entry.cjs', import.meta.url));
  const app = await _electron.launch({ executablePath: executable,
    args: [...(mediaConsent ? ['--use-fake-device-for-media-stream'] : []), entry], env, timeout: 30000 });
  onStarted(app.process());
  let mainErrors = '';
  app.process().stderr.on('data', chunk => {
    mainErrors += String(chunk);
    console.error('ELECTRON_STDERR', String(chunk));
  });
  app.process().stdout.on('data', chunk => console.log('ELECTRON_STDOUT', String(chunk)));
  try {
    app.on('window', output => output.on('pageerror', error => console.log('LOOM_OUTPUT_PAGE_ERROR', error.message)));
    const page = await app.firstWindow();
    await page.addInitScript(modules => { window.loomDesktopFixtureModules = modules; }, fixtureModules);
    await page.evaluate(modules => { window.loomDesktopFixtureModules = modules; }, fixtureModules);
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
    if (mediaConsent) {
      await verifyMediaPermissions({ app, page, fixtureModules });
      assert.deepEqual(errors, []);
      return;
    }
    if (ndiInput) {
      await verifyNdiInput({ app, page, fixtureModules, senderExecutable: env.LOOM_NDI_TEST_SENDER });
      for (const count of ndiCounts)
        await verifyNdiOutput({ app, page, receiverExecutable: env.LOOM_NDI_TEST_SENDER, count, seconds: ndiSeconds, cpuMeasurement: ndiCpuMeasurement, outputMode });
      assert.deepEqual(errors, []);
      assert.doesNotMatch(mainErrors, /MaxListenersExceededWarning|LOOM_NATIVE_OUTPUT_PUBLISH_FAILED|LOOM_NATIVE_UNLOAD_FAILED/);
      return;
    }
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

    if (env.LOOM_DESKTOP_VISION_PHOTO) {
      const photo = `data:image/jpeg;base64,${(await readFile(env.LOOM_DESKTOP_VISION_PHOTO)).toString('base64')}`;
      await page.exposeFunction('visionVerifyCapture', async expected => {
        const windows = app.windows().filter(page => page.url().includes('/inference.html?'));
        assert.equal(windows.length, 1);
        await windows[0].evaluate(base64 => {
          const source = document.querySelector('canvas');
          const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
          const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
          const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const expected = window.atob(base64);
          for (let index = 0; index < expected.length; index++) {
            const pixel = Math.floor(index / 3), channel = index % 3;
            if (actual[pixel * 4 + channel] !== expected.charCodeAt(index))
              throw new Error(`Native capture input byte ${index} changed: ${actual[pixel * 4 + channel]} != ${expected.charCodeAt(index)}`);
            if (actual[pixel * 4 + 3] !== 255) throw new Error('Native packed capture lost opaque alpha');
          }
        }, expected);
      });
      const result = await page.evaluate(async photo => {
        const { verifyVisionGraph } = await import(window.loomDesktopFixtureModules.vision);
        return verifyVisionGraph(photo, window.visionVerifyCapture);
      }, photo);
      assert.deepEqual(errors, []);
      console.log('LOOM_NATIVE_VISION_GRAPH_PASS', JSON.stringify(result));
      await page.exposeFunction('visionInspectSessions', () => app.evaluate((_electron, path) => {
        // eslint-disable-next-line no-undef
        return process.getBuiltinModule('node:module').createRequire(path)(path).nativeInferenceDiagnostics();
      }, main));
      const concurrent = await page.evaluate(async photo => {
        const { verifyConcurrentVisionGraph } = await import(window.loomDesktopFixtureModules.vision);
        return verifyConcurrentVisionGraph(photo, window.visionInspectSessions);
      }, photo);
      console.log('LOOM_NATIVE_VISION_CONCURRENT_PASS', JSON.stringify(concurrent));
      const { verifyVisionUI } = await import('./vision-ui-smoke.mjs');
      await verifyVisionUI({ app, page, photo, soakSeconds: Number(env.LOOM_DESKTOP_VISION_SOAK_SECONDS ?? 0),
        profileMemory: env.LOOM_DESKTOP_VISION_MEMORY_PROFILE === '1' });
      return;
    }

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
        const { nativeOutputFixture } = await import(window.loomDesktopFixtureModules.output);
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
        await toolbar.screenshot({ path: fileURLToPath(new URL('../../../.cache/native-output-toolbar.png', import.meta.url)) });
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
        const hiddenTicks = await page.evaluate(() => new Promise(resolve => {
          let ticks = 0;
          let request;
          const tick = () => { ticks++; request = window.requestAnimationFrame(tick); };
          request = window.requestAnimationFrame(tick);
          setTimeout(() => { window.cancelAnimationFrame(request); resolve(ticks); }, 2000);
        }));
        assert.ok(hiddenTicks > 2, `Hidden editor producer stopped: ${hiddenTicks} animation frames in two seconds`);
        await expect.poll(() => page.evaluate(async name => (await window.loomDesktop.status(name)).copied, name), {
          timeout: 5000, message: 'Hiding the editor stopped native publication',
        }).toBeGreaterThan(beforeHidden + 2);
      } finally { await mainWindow.evaluate(window => window.show()); }
      const nativeStatus = await page.evaluate(name => window.loomDesktop.status(name), name);
      const receive = async (count = 3, publisherName = name) => {
        try { return await receiveSyphon(env.LOOM_SYPHON_RECEIVER, publisherName, count); }
        catch (error) {
          let timer;
          try {
            const state = await Promise.race([
              Promise.allSettled([
                app.evaluate((_electron, path) => {
                  // eslint-disable-next-line no-undef
                  const load = process.getBuiltinModule('node:module').createRequire(path);
                  return load(path).nativeOutputDiagnostics();
                }, main),
                page.evaluate(() => ({ visibility: document.visibilityState, text: document.body.innerText,
                  toggle: document.querySelector('[data-testid="native-output-toggle"]')?.dataset,
                })),
                app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
                  id: window.id, url: window.webContents.getURL(), visible: window.isVisible(),
                  painting: window.webContents.isPainting(), size: window.getContentSize(),
                }))),
                Promise.allSettled(app.windows().filter(window => window.url().includes('/output.html?')).map(async output => {
                  const surface = await output.evaluate(() => ({ session: window.name, visibility: document.visibilityState,
                    canvas: document.querySelector('canvas') ? { width: document.querySelector('canvas').width,
                      height: document.querySelector('canvas').height, ...document.querySelector('canvas').dataset } : null }));
                  return { ...surface, native: await page.evaluate(session => window.loomDesktop.status(session), surface.session) };
                })),
              ]),
              new Promise(resolve => { timer = setTimeout(() => resolve({ diagnosticError: 'Receiver failure-state capture timed out' }), 5000); }),
            ]);
            console.error('LOOM_RECEIVER_FAILURE_STATE', JSON.stringify({ publisherName, state },
              (_key, value) => value instanceof Error ? { message: value.message } : value));
          } finally { clearTimeout(timer); }
          throw error;
        }
      };
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
            const { verifyNativeInput } = await import(window.loomDesktopFixtureModules.input);
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
      // The real export command must retire viewer publishers as well as graph
      // sinks. Encode a two-frame take; cancel only the final file picker.
      await page.getByLabel('Out point', { exact: true }).fill('1');
      await page.getByLabel('Out point', { exact: true }).press('Enter');
      await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true, value: async () => {
          document.body.dataset.offlineViewerActive = document.querySelector('[data-testid="native-output-toggle"]')?.getAttribute('aria-pressed');
          throw new window.DOMException('Smoke cancels saving the encoded take', 'AbortError');
        },
      }));
      await page.getByRole('button', { name: 'Render the range', exact: true }).click();
      await expect(page.locator('body')).toHaveAttribute('data-offline-viewer-active', 'false', { timeout: 15000 });
      await expect.poll(() => output.isClosed()).toBe(true);
      await expect(page.getByTestId('native-output-toggle')).toHaveAttribute('data-native-output-ready', 'false');
      await expect(page.getByRole('button', { name: 'Render the range', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      console.log('LOOM_NATIVE_VIEWER_OFFLINE_PREFLIGHT_PASS');
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
          const { nativeOutputFixture } = await import(window.loomDesktopFixtureModules.output);
          return nativeOutputFixture(uuid, true);
        }, uuid);
        const inputChooser = page.waitForEvent('filechooser');
        await page.getByTestId('project-open').click();
        // The export check changed this synthetic project's range through the UI.
        await page.getByTestId('unsaved-changes-dialog').getByRole('button', { name: 'Discard', exact: true }).click();
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
      let reloadOutput;
      for (let attempt = 0; attempt < 5; attempt++) {
        const reloadOutputPromise = app.waitForEvent('window');
        await page.getByTestId('native-output-toggle').click();
        reloadOutput = await reloadOutputPromise;
        const reloadName = new URL(reloadOutput.url()).searchParams.get('name');
        try {
          await expect.poll(() => page.evaluate(async name => (await window.loomDesktop.status(name)).copied, reloadName))
            .toBeGreaterThan(0);
        } catch (error) {
          console.error('LOOM_RELOAD_OUTPUT_NOT_READY', await reloadOutput.evaluate(() => ({
            received: document.querySelector('canvas')?.dataset.receivedFrames,
            bridge: typeof window.loomNativeSurface, text: document.body.innerText,
            canvas: !!document.querySelector('canvas'), readyState: document.readyState, name: window.name,
            resources: window.performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration })),
          })), await page.getByTestId('native-output-toggle').getAttribute('data-native-output-status'),
          { attached: await page.getByTestId('native-output-toggle').getAttribute('data-native-output-ready') },
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
            url: window.webContents.getURL(), loading: window.webContents.isLoading(), workers: window.webContents.getAllSharedWorkers(),
          }))));
          throw error;
        }
        if (attempt < 4) {
          await page.getByTestId('native-output-toggle').click();
          await expect.poll(() => reloadOutput.isClosed()).toBe(true);
        }
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
      if (startupOnly) {
        assert.deepEqual(errors, []);
        console.log('LOOM_DESKTOP_STARTUP_SMOKE_PASS', JSON.stringify(capabilities));
        return;
      }
      const graphPublisher = 'Loom graph smoke';
      const outputProject = await page.evaluate(async name => {
        const { nativeOutputFixture } = await import(window.loomDesktopFixtureModules.output);
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
      await verifyMultiOutputs({ app, page, receive, emptyProject: fixture.text, receiveSeconds });
      await verifyAnimatedOutput({ app, page, receive, emptyProject: fixture.text, main });
      await verifySelfInput({ app, page });
    }
    console.log('LOOM_DESKTOP_SMOKE_PASS', JSON.stringify(capabilities));
  } finally {
    await app.close();
    assert.doesNotMatch(mainErrors, /LOOM_NATIVE_UNLOAD_FAILED|LOOM_NATIVE_INPUT_PENDING_SHUTDOWN/,
      'Native shutdown failed or retained unproven GPU leases');
  }
}
