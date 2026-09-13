/* global window */
import { expect } from '@playwright/test';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Fake hardware only: Chromium still invokes the actual permission handlers.
// Test-only dialog/TCC responders avoid accessing the user's physical devices.
export async function verifyMediaPermissions({ app, page, fixtureModules }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ dialog, systemPreferences }) => {
    globalThis.mediaConsentTest = { allow: true, prompts: [], os: [] };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.mediaConsentTest.prompts.push(options.message);
      return { response: globalThis.mediaConsentTest.allow ? 1 : 0, checkboxChecked: false };
    };
    systemPreferences.askForMediaAccess = async type => { globalThis.mediaConsentTest.os.push(type); return true; };
  });
  await page.addInitScript(modules => {
    window.loomDesktopFixtureModules = modules;
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
  }, fixtureModules);
  const load = async text => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('project-open').click();
    await (await chooser).setFiles({ name: 'device.loom.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  };
  const reset = async allow => {
    await page.reload();
    await expect(page.getByTestId('project-open')).toBeVisible();
    await app.evaluate((_electron, allow) => {
      globalThis.mediaConsentTest = { allow, prompts: [], os: [] };
    }, allow);
  };
  for (const [type, nested, allow] of [['webcam', false, false], ['webcam', false, true],
    ['webcam', true, true], ['audioIn', false, false], ['audioIn', false, true], ['audioIn', true, true]]) {
    await reset(allow);
    const text = await page.evaluate(async ({ type, nested }) =>
      (await import(window.loomDesktopFixtureModules.output)).nativeMediaFixture(type, nested), { type, nested });
    await load(text);
    const id = type === 'webcam' ? 'camera' : 'microphone';
    await expect.poll(() => page.evaluate(async id => (await window.loomPermissions.list())
      .find(entry => entry.id === id).decision, id), { timeout: 15000 }).toBe(allow ? 'allowed' : 'denied');
    const calls = await app.evaluate(() => globalThis.mediaConsentTest);
    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0], new RegExp(id));
    assert.deepEqual(calls.os, process.platform === 'darwin' && allow ? [id] : []);
    console.log('LOOM_MEDIA_NODE_CONSENT_PASS', JSON.stringify({ type, nested, allow, calls }));
    // Clear device nodes before reload so autosave restoration cannot request
    // the previous case's device before the next case installs its response.
    await load(await page.evaluate(async () =>
      (await (await import(window.loomDesktopFixtureModules.output)).nativeOutputFixture()).text));
  }
  await reset(true);
  await load(await readFile(new URL('../../../examples/E52-Presence.loom.json', import.meta.url), 'utf8'));
  await expect.poll(() => page.evaluate(async () => (await window.loomPermissions.list())
    .find(entry => entry.id === 'camera').decision), { timeout: 15000 }).toBe('allowed');
  const exampleCalls = await app.evaluate(() => globalThis.mediaConsentTest);
  assert.equal(exampleCalls.prompts.length, 1);
  assert.match(exampleCalls.prompts[0], /camera/);
  console.log('LOOM_MEDIA_EXAMPLE_CONSENT_PASS', JSON.stringify({ example: 'E52 Presence', calls: exampleCalls }));
  await page.getByTestId('open-project-settings').click();
  const panel = page.getByRole('region', { name: 'Permissions', exact: true });
  await expect(panel).toContainText('Microphone');
  await expect(panel).toContainText('App: allowed');
  await expect(panel).toContainText('Speaker selection');
  await panel.screenshot({ path: '/tmp/loom-permissions-settings.png' });
  // Run cancelled navigation last: Playwright's action auto-wait tracks this as
  // pending even though Electron prevented it. The original document must survive.
  await page.evaluate(() => { window.location.href = 'http://127.0.0.1:1/blocked'; });
  await expect.poll(() => page.evaluate(async () => (await window.loomPermissions.list())
    .find(entry => entry.id === 'camera').decision)).toBe('allowed');
  assert.deepEqual(errors, []);
  console.log('LOOM_MEDIA_PERMISSIONS_SMOKE_PASS');
}
