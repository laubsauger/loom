/* global window, Image, document */
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { runNdiRoundtrip, receiveNdiOutput } from './ndi-roundtrip.mjs';

// Synthetic LAN source only. Consent remains on the production IPC path; the
// test responder controls the native dialog without accessing physical devices.
export async function verifyNdiInput({ app, page, fixtureModules, senderExecutable }) {
  await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 30000 });
  await app.evaluate(({ dialog }) => {
    globalThis.ndiConsentTest = { allow: false, prompts: [] };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.ndiConsentTest.prompts.push(options.message);
      return { response: globalThis.ndiConsentTest.allow ? 1 : 0, checkboxChecked: false };
    };
  });
  const denied = await page.evaluate(async () => {
    try { await window.loomDesktop.ndiInput.list(); return false; }
    catch (error) { return String(error).includes('NDI local-network access denied'); }
  });
  assert.equal(denied, true);
  assert.equal(await page.evaluate(async () => (await window.loomPermissions.list())
    .find(entry => entry.id === 'ndi').decision), 'denied');
  await page.addInitScript(modules => {
    window.loomDesktopFixtureModules = modules;
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
  }, fixtureModules);
  await app.evaluate(() => { globalThis.ndiConsentTest = { allow: true, prompts: [] }; });
  await page.reload();
  await expect(page.getByTestId('project-open')).toBeVisible();
  const load = async (text, discardResizedFixture = false) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('project-open').click();
    // Receiving source dimensions is a real saved graph mutation. The previous
    // synthetic fixture is therefore dirty; exercise its normal discard prompt.
    if (discardResizedFixture) await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await (await chooser).setFiles({ name: 'ndi.loom.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  };
  const diagnostics = () => app.evaluate((_electron, mainPath) => {
    // eslint-disable-next-line no-undef
    return process.getBuiltinModule('node:module').createRequire(mainPath)(mainPath).nativeInputDiagnostics();
  }, fileURLToPath(new URL('../main.cjs', import.meta.url)));
  // This is a multi-phase app/lifecycle budget, not the standalone 120-frame
  // transport timing gate. Each pixel oracle retains its own ten-second bound.
  const publisherName = `Loom app input ${randomUUID()}`;
  await runNdiRoundtrip({ executable: senderExecutable,
    args: ['--send', publisherName], timeout: 90000 }, {}, undefined, async (source, stopSender) => {
    const result = await page.evaluate(async name =>
      (await import(window.loomDesktopFixtureModules.input)).verifyNativeInput(name, 'ndi'), source.name);
    assert.equal(result.frames, 3);
    assert.deepEqual(result.size, [1920, 1080]);
    console.log('LOOM_NDI_CHROMIUM_BACKEND_PASS', JSON.stringify(result));
    const screenshotPixels = (screenshot, marker = false) => page.evaluate(async ({ base64, marker }) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const positions = marker ? [[63 / 64, 1 / 8], [63 / 64, 3 / 8]] : [[0.25, 0.75], [0.75, 0.75]];
      return positions.map(([x, y]) => [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data]);
    }, { base64: screenshot.toString('base64'), marker });
    const checkMarker = async restarted => {
      const pixels = await screenshotPixels(await page.getByTestId('viewer-canvas').screenshot(), true);
      for (const [index, pixel] of pixels.entries()) {
        const expected = Boolean(index) !== restarted ? 255 : 0;
        assert.ok(pixel.slice(0, 3).every(value => Math.abs(value - expected) <= 24),
          `NDI restart marker differs: ${JSON.stringify(pixels)}`);
        assert.equal(pixel[3], 255);
      }
    };
    // Screenshot bytes include this Mac's display conversion. Compare against
    // decoded SDR swatches through that same capture path, not raw GPU bytes.
    await page.evaluate(samples => {
      const canvas = document.createElement('canvas'); canvas.id = 'ndi-test-color-control';
      canvas.width = 192; canvas.height = 108;
      canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:192px;height:108px';
      const context = canvas.getContext('2d');
      for (let index = 0; index < 2; index++) {
        context.fillStyle = `rgb(${samples.slice(8 + index * 4, 11 + index * 4).join(',')})`;
        context.fillRect(index * 96, 0, 96, 108);
      }
      document.body.append(canvas);
    }, result.samples.at(-1));
    let reference;
    try { reference = await screenshotPixels(await page.locator('#ndi-test-color-control').screenshot()); }
    finally { await page.evaluate(() => document.getElementById('ndi-test-color-control').remove()); }
    console.log('LOOM_NDI_DISPLAY_COLOR_CONTROL', JSON.stringify(reference));
    for (const nested of [false, true]) {
      await app.evaluate(() => { globalThis.ndiConsentTest.prompts = []; });
      await page.reload();
      await expect(page.getByTestId('project-open')).toBeVisible();
      assert.equal(await page.evaluate(async () => (await window.loomPermissions.list())
        .find(entry => entry.id === 'ndi').decision), 'not-requested');
      const fixture = await page.evaluate(async ({ source, nested }) =>
        (await import(window.loomDesktopFixtureModules.output)).nativeMediaFixtureDetails('ndiIn', nested, source),
      { source: source.name, nested });
      await load(fixture.text);
      await page.getByTestId('viewer-output-select').selectOption(fixture.native);
      await expect(page.locator('dl[aria-label="Resolved output"]')).toContainText('1920', { timeout: 15000 });
      await expect(page.locator('dl[aria-label="Resolved output"]')).toContainText('1080');
      await expect(async () => {
        const screenshot = await page.getByTestId('viewer-canvas').screenshot();
        const pixels = await screenshotPixels(screenshot);
        for (const [index, expected] of reference.entries()) {
          assert.ok(expected.every((value, channel) => Math.abs(pixels[index][channel] - value) <= 24),
            `NDI visible graph colors differ: ${JSON.stringify(pixels)}`);
          assert.equal(pixels[index][3], 255);
        }
      }).toPass({ timeout: 15000 });
      const nodeConsent = await app.evaluate(() => globalThis.ndiConsentTest);
      assert.equal(nodeConsent.prompts.length, 1);
      assert.match(nodeConsent.prompts[0], /local network/);
      console.log('LOOM_NDI_LOADED_GRAPH_PASS', JSON.stringify({ nested }));
      if (!nested) await load(await page.evaluate(async () =>
        (await (await import(window.loomDesktopFixtureModules.output)).nativeOutputFixture()).text), true);
    }
    const consent = await app.evaluate(() => globalThis.ndiConsentTest);
    assert.equal(consent.prompts.length, 1);
    assert.match(consent.prompts[0], /local network/);
    await expect.poll(async () => (await diagnostics()).length).toBe(1);
    const session = (await diagnostics())[0].session;
    await checkMarker(false);
    const retained = await screenshotPixels(await page.getByTestId('viewer-canvas').screenshot());
    await stopSender();
    await expect.poll(async () => (await diagnostics()).map(record => ({
      session: record.session, offline: record.offline, retainedLease: record.retainedLease,
      closed: record.closed, error: record.error,
    })), { timeout: 15000, message: 'Offline NDI must retain only its reconnecting receiver' })
      .toEqual([{ session, offline: true, retainedLease: false, closed: false, error: null }]);
    assert.deepEqual(await screenshotPixels(await page.getByTestId('viewer-canvas').screenshot()), retained);
    const receivedBeforeRestart = (await diagnostics())[0].receivedFrames;
    await runNdiRoundtrip({ executable: senderExecutable, args: ['--send-restarted', publisherName], timeout: 30000 },
      {}, undefined, async restarted => {
        assert.equal(restarted.name, source.name, 'Restart must preserve exact SDK source identity');
        await expect.poll(async () => {
          const records = await diagnostics();
          assert.equal(records.length, 1); assert.equal(records[0].session, session);
          assert.equal(records[0].error, null);
          return !records[0].offline && records[0].receivedFrames >= receivedBeforeRestart + 3;
        }, { timeout: 15000, message: 'The existing nested graph receiver did not resume' }).toBe(true);
        await expect(() => checkMarker(true)).toPass({ timeout: 10000 });
        assert.deepEqual(await screenshotPixels(await page.getByTestId('viewer-canvas').screenshot()), retained);
        assert.equal((await app.evaluate(() => globalThis.ndiConsentTest)).prompts.length, 1);
        console.log('LOOM_NDI_SAME_SESSION_RECONNECT_PASS', JSON.stringify({ session, source: source.name }));
      });
    await load(await page.evaluate(async () =>
      (await (await import(window.loomDesktopFixtureModules.output)).nativeOutputFixture()).text), true);
    await page.reload();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect.poll(diagnostics, {
      timeout: 15000, message: 'NDI reload retained native sessions or GPU leases',
    }).toEqual([]);
  });
  console.log('LOOM_NDI_INPUT_SMOKE_PASS');
}

/** Graph-owned publisher and receiver: the full local NDI cycle, no second graph. */
export async function verifyNdiOutput({ app, page, receiverExecutable, count = 1, seconds = 0, cpuMeasurement = false, outputMode = 'staged' }) {
  await app.evaluate(() => { globalThis.ndiConsentTest = { allow: true, prompts: [] }; });
  assert.equal(await page.evaluate(async () => (await window.loomPermissions.list())
    .find(entry => entry.id === 'ndi').decision), 'not-requested');
  const publisherNames = Array.from({ length: count }, (_, index) => `Loom graph output ${randomUUID()} ${index}`);
  const fixture = await page.evaluate(async names =>
    (await import(window.loomDesktopFixtureModules.output)).nativeOutputFixture('', false, names, true, 'ndi'), publisherNames);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('project-open').click();
  await (await chooser).setFiles({ name: 'ndi-loop.loom.json', mimeType: 'application/json', buffer: Buffer.from(fixture.text) });
  // The loaded Out node must request access itself, before our discovery probe.
  await expect.poll(() => page.evaluate(async () => (await window.loomPermissions.list())
    .find(entry => entry.id === 'ndi').decision), { timeout: 15000 }).toBe('allowed');
  const discover = () => page.evaluate(async names => (await window.loomDesktop.ndiInput.list())
    .filter(source => names.some(name => source.name.endsWith(`(${name})`))), publisherNames);
  await expect.poll(async () => (await discover()).length, { timeout: 15000 }).toBe(count);
  const sources = await discover();
  const source = sources.find(source => source.name.endsWith(`(${publisherNames[0]})`));
  const inputId = fixture.native.slice(0, -4);
  await page.locator(`.react-flow__node[data-id="${inputId}"]`).click();
  await expect.poll(() => page.getByLabel('NDI source', { exact: true }).locator('option')
    .evaluateAll(options => options.map(option => option.value))).toContain(source.id);
  await page.getByLabel('NDI source', { exact: true }).selectOption(source.id);
  await page.getByTestId('viewer-output-select').selectOption(fixture.native);
  await expect(page.locator('dl[aria-label="Resolved output"]')).toContainText('1920 × 1080', { timeout: 15000 });
  const raw = await page.evaluate(async name =>
    (await import(window.loomDesktopFixtureModules.input)).verifyNativeInput(name, 'ndi'), source.id);
  assert.equal(raw.frames, 3);
  const graph = JSON.parse(fixture.text).graph;
  for (const output of Object.values(graph.nodes).filter(node => node.type === 'ndiOut'))
    await expect(page.getByTestId(`node-preview-${output.id}`).locator('[data-preview-state]'))
      .toHaveAttribute('data-preview-state', 'live');
  assert.equal((await app.evaluate(() => globalThis.ndiConsentTest)).prompts.length, 1);
  const allocation = () => app.evaluate(() => {
    // eslint-disable-next-line no-undef
    const path = process.env.LOOM_NATIVE_NDI_ADDON;
    // eslint-disable-next-line no-undef
    return process.getBuiltinModule('node:module').createRequire(path)(path).output.stats();
  });
  const initialAllocation = await allocation();
  assert.equal(initialAllocation.mode, outputMode);
  const stagingBuffers = outputMode === 'direct' ? 0 : 2;
  assert.equal(initialAllocation.publishers, count);
  assert.equal(initialAllocation.stagingBuffers, count * stagingBuffers);
  assert.equal(initialAllocation.stagingBytes, count * 1920 * 1080 * 4 * stagingBuffers);
  console.log('LOOM_NDI_GRAPH_LOOPBACK_PASS', JSON.stringify({ count, size: raw.size, frames: raw.frames, source: source.id }));
  // Await every child even if one fails, before the runner retires executables.
  const outputs = () => app.evaluate((_electron, mainPath) => {
    // eslint-disable-next-line no-undef
    return process.getBuiltinModule('node:module').createRequire(mainPath)(mainPath).nativeOutputDiagnostics();
  }, fileURLToPath(new URL('../main.cjs', import.meta.url)));
  const memory = () => app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })));
  const renderers = () => Promise.all(app.windows()
    .filter(output => !output.isClosed() && output.url().includes('/output.html?'))
    .map(output => output.locator('canvas').evaluate(canvas => ({ name: window.name,
      receivedFrames: Number(canvas.dataset.receivedFrames), presentationMs: Number(canvas.dataset.presentationMs) }))));
  const outputsBefore = await outputs();
  const renderersBefore = await renderers();
  assert.equal(renderersBefore.length, count);
  assert.ok(renderersBefore.every(renderer => Number.isFinite(renderer.receivedFrames) && renderer.receivedFrames > 0
    && Number.isFinite(renderer.presentationMs)), 'NDI output renderer frame counters are unavailable');
  const memoryBefore = seconds ? await memory() : undefined;
  const received = await Promise.allSettled(sources.map(source => receiveNdiOutput(receiverExecutable, source.id, undefined, seconds, cpuMeasurement)));
  // Capture live owners before failure cleanup destroys the evidence. Snapshot
  // failures remain explicit and cannot replace a receiver's original error.
  const observed = await Promise.allSettled([allocation(), outputs(), seconds ? memory() : Promise.resolve(undefined), renderers()]);
  console.log('LOOM_NDI_PUBLICATION_WINDOW', JSON.stringify({ count, seconds, cpuMeasurement,
    before: { allocation: initialAllocation, outputs: outputsBefore, processes: memoryBefore, renderers: renderersBefore }, after: observed }));
  const failures = [...received, ...observed].filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'NDI concurrent receiver proof failed');
  console.log('LOOM_NDI_INDEPENDENT_APP_OUTPUT_PASS', JSON.stringify({ count, sharedSource: true, cpuMeasurement,
    streams: received.map(result => result.value) }));
  const finalAllocation = observed[0].value;
  assert.equal(finalAllocation.bufferAllocations, initialAllocation.bufferAllocations,
    'Steady NDI publication allocated new staging buffers');
  for (const field of ['publishers', 'stagingBuffers', 'stagingBytes'])
    assert.equal(finalAllocation[field], initialAllocation[field], `Steady NDI publication changed ${field}`);
  if (seconds) console.log('LOOM_NDI_SUSTAINED_RESOURCES', JSON.stringify({ count, seconds,
    initialAllocation, finalAllocation, memoryBefore, memoryAfter: observed[2].value }));
  for (const [width, height] of count === 1 ? [[1280, 720], [1920, 1080]] : []) {
    await page.locator(`.react-flow__node[data-id="${fixture.b.slice(0, -4)}"]`).click();
    await page.getByRole('tab', { name: 'Common', exact: true }).click();
    for (const [label, value] of [['Width', width], ['Height', height]]) {
      const input = page.getByRole('spinbutton', { name: label, exact: true });
      await input.dblclick(); await input.fill(String(value)); await input.press('Enter');
    }
    await page.getByTestId('viewer-output-select').selectOption(fixture.native);
    await expect(page.locator('dl[aria-label="Resolved output"]')).toContainText(`${width} × ${height}`, { timeout: 15000 });
    await expect.poll(async () => (await allocation()).stagingBytes).toBe(width * height * 4 * stagingBuffers);
    assert.equal((await allocation()).stagingBuffers, stagingBuffers);
    assert.ok((await discover()).some(current => current.id === source.id), 'NDI resize replaced its publisher identity');
    console.log('LOOM_NDI_RESIZE_PASS', JSON.stringify({ width, height, allocation: await allocation() }));
  }
  const resized = await page.evaluate(async name =>
    (await import(window.loomDesktopFixtureModules.input)).verifyNativeInput(name, 'ndi'), source.id);
  assert.equal(resized.frames, 3);
  // Reload while input, output and async encode ownership are active.
  await page.reload();
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await expect.poll(() => app.evaluate((_electron, mainPath) => {
    // eslint-disable-next-line no-undef
    const host = process.getBuiltinModule('node:module').createRequire(mainPath)(mainPath);
    return { inputs: host.nativeInputDiagnostics(), outputs: host.nativeOutputDiagnostics() };
  }, fileURLToPath(new URL('../main.cjs', import.meta.url))), { timeout: 15000 }).toEqual({ inputs: [], outputs: [] });
  const drained = await allocation();
  assert.equal(drained.publishers, 0); assert.equal(drained.stagingBytes, 0); assert.equal(drained.stagingBuffers, 0);
  console.log('LOOM_NDI_OUTPUT_SMOKE_PASS', JSON.stringify({ count }));
}
