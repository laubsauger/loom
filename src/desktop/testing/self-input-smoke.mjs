/* global window, Image, document */
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { fileURLToPath, URL } from 'node:url';

export async function verifySelfInput({ app, page, shutdown = false }) {
  const publisherName = 'Loom self-input smoke';
  const fixture = await page.evaluate(async name => {
    const { nativeOutputFixture } = await import(window.loomDesktopFixtureModules.output);
    return nativeOutputFixture('', false, name);
  }, publisherName);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('project-open').click();
  await (await chooser).setFiles({ name: 'self-input.loom.json', mimeType: 'application/json', buffer: Buffer.from(fixture.text) });
  await expect.poll(() => app.windows().filter(window => window.url().includes('/output.html?')).length).toBe(1);
  const publisherWindow = app.windows().find(window => window.url().includes('/output.html?'));
  const discover = () => page.evaluate(async name => (await window.loomDesktop.input.list()).filter(source => source.name === name), publisherName);
  try { await expect.poll(async () => (await discover()).length).toBe(1); }
  catch (error) {
    console.log('LOOM_OUTPUT_STARTUP_FAILURE', publisherWindow.isClosed() ? 'output closed' : await publisherWindow.evaluate(() => ({
      text: document.body.innerText, canvas: document.querySelector('canvas')?.dataset.receivedFrames,
      bridge: typeof window.loomNativeSurface,
    })));
    console.log('LOOM_OUTPUT_STARTUP_OWNER', await page.locator('body').innerText());
    throw error;
  }
  const uuid = (await discover())[0].id;
  const inputId = fixture.native.slice(0, -4); // Fixture key is `${nodeId}:out`.
  await page.locator(`.react-flow__node[data-id="${inputId}"]`).click();
  await expect.poll(() => page.getByLabel('Syphon source', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value))).toContain(uuid);
  await page.getByLabel('Syphon source', { exact: true }).selectOption(uuid);
  const graph = JSON.parse(fixture.text).graph;
  const outputId = Object.values(graph.nodes).find(node => node.type === 'syphonOut').id;
  await expect(page.getByTestId(`node-preview-${outputId}`)).toBeVisible();
  await expect(page.getByTestId(`node-preview-${outputId}`).locator('[data-preview-state]'))
    .toHaveAttribute('data-preview-state', 'live');
  try { await page.getByTestId('viewer-output-select').selectOption(fixture.native); }
  catch (error) {
    console.log('LOOM_SELF_INPUT_SELECTION_FAILURE', await page.evaluate(() => ({
      options: [...document.querySelectorAll('[data-testid="viewer-output-select"] option')].map(option => ({ value: option.value, text: option.textContent })),
      nodes: [...document.querySelectorAll('.react-flow__node')].map(node => ({ id: node.dataset.id, text: node.textContent })),
    })));
    throw error;
  }
  const pixels = async () => {
    const screenshot = await page.getByTestId('viewer-canvas').screenshot();
    return page.evaluate(async base64 => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return [0.1, 0.9].map(y => [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * y), 1, 1).data]);
    }, screenshot.toString('base64'));
  };
  const sizes = [[1920, 1080], [1280, 720], [1920, 1080]];
  for (let stage = 0; stage < sizes.length; stage++) {
    const [width, height] = sizes[stage];
    if (stage) {
      await page.locator(`.react-flow__node[data-id="${fixture.b.slice(0, -4)}"]`).click();
      await page.getByRole('tab', { name: 'Common', exact: true }).click();
      for (const [label, value] of [['Width', width], ['Height', height]]) {
        const input = page.getByRole('spinbutton', { name: label, exact: true });
        await input.dblclick(); await input.fill(String(value)); await input.press('Enter');
      }
    }
    await page.getByTestId('viewer-output-select').selectOption(fixture.b);
    let reference;
    await expect(async () => {
      reference = await pixels();
      assert.ok(reference[0][2] > 240 && reference[0][1] < 40, 'Direct source is not the blue checker region');
      assert.ok(reference[1][1] > 100 && reference[1][2] < 10, 'Direct source is not the green checker region');
    }).toPass({ timeout: 15000 });
    await page.getByTestId('viewer-output-select').selectOption(fixture.native);
    await expect(page.locator('dl[aria-label="Resolved output"]')).toContainText(`${width} × ${height}`, { timeout: 15000 });
    console.log('LOOM_SYPHON_SELF_INPUT_COLOR_CONTROL', JSON.stringify({ reference,
      output: await publisherWindow.evaluate(() => {
        const source = document.querySelector('canvas');
        const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
        const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
        return { receivedFrames: source.dataset.receivedFrames,
          pixels: [0.1, 0.9].map(y => [...context.getImageData(Math.floor(source.width / 2), Math.floor(source.height * y), 1, 1).data]) };
      }) }));
    for (let frame = 0; frame < 3; frame++) {
      try {
        // Resizing can replace the canvas between locator resolution and capture.
        // Retry the complete capture/assertion, with the same deadline and pixels.
        await expect(async () => {
          expect(await pixels(), 'Graph self-input differs from the direct source view').toEqual(reference);
        }).toPass({ timeout: 15000 });
      } catch (failure) {
        console.log('LOOM_SELF_INPUT_FAILURE_OUTPUT', JSON.stringify(await publisherWindow.evaluate(() => {
          const source = document.querySelector('canvas');
          const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
          const context = canvas.getContext('2d'); context.drawImage(source, 0, 0);
          return { receivedFrames: source.dataset.receivedFrames, size: [source.width, source.height],
            pixels: [0.1, 0.9].map(y => [...context.getImageData(Math.floor(source.width / 2), Math.floor(source.height * y), 1, 1).data]) };
        })));
        if (stage === 0) {
          const diagnostic = await page.evaluate(async name => {
            const { verifyNativeInput } = await import(window.loomDesktopFixtureModules.input);
            try { return { raw: await verifyNativeInput(name) }; }
            catch (error) { return { rawError: String(error) }; }
          }, publisherName);
          console.log('LOOM_SELF_INPUT_FAILURE_RAW', JSON.stringify(diagnostic));
          console.log('LOOM_SELF_INPUT_FAILURE_UI', await page.locator('body').innerText());
        }
        throw failure;
      }
    }
    if (stage === 0) {
      const raw = await page.evaluate(async name => {
        const { verifyNativeInput } = await import(window.loomDesktopFixtureModules.input);
        return verifyNativeInput(name);
      }, publisherName);
      console.log('LOOM_SYPHON_SELF_INPUT_RAW', JSON.stringify(raw));
    }
    assert.equal((await discover())[0].id, uuid, 'Source resizing recreated the publisher identity');
    console.log('LOOM_SYPHON_SELF_INPUT_STAGE_PASS', JSON.stringify({ size: [width, height], uuid, samples: 3 }));
  }
  if (shutdown) {
    const mainWindow = await app.browserWindow(page);
    const closed = page.waitForEvent('close', { timeout: 20000 });
    await mainWindow.evaluate(window => window.close());
    await closed;
    await expect.poll(() => publisherWindow.isClosed()).toBe(true);
    console.log('LOOM_SYPHON_SELF_INPUT_CLOSE_PASS', JSON.stringify({ sizes, windowRetired: true }));
    return;
  }
  await page.reload();
  await expect.poll(() => publisherWindow.isClosed()).toBe(true);
  await expect.poll(() => app.evaluate((_electron, mainPath) => {
    // eslint-disable-next-line no-undef
    const load = process.getBuiltinModule('node:module').createRequire(mainPath);
    return load(mainPath).nativeInputDiagnostics();
  }, fileURLToPath(new URL('../main.cjs', import.meta.url))), {
    timeout: 15000, message: 'Reload left native input acquisitions or GPU leases alive',
  }).toEqual([]);
  console.log('LOOM_SYPHON_SELF_INPUT_PASS', JSON.stringify({ graphNodes: true, sizes, stablePublisher: true, windowRetired: true }));
}
