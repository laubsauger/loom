/* global AbortController */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rendererBuildOptions, rendererFixtureModules, startDesktopRenderer } from './renderer.mjs';
import { verifyDesktop } from './testing/smoke.mjs';

test('receiver measurement duration rejects malformed and unbounded requests before Electron launch', async () => {
  for (const value of ['', '0', '-1', '1.5', '601', 'NaN']) {
    await assert.rejects(verifyDesktop({ env: { LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS: value } }),
      /must be an integer from 1 to 600/);
  }
});

test('receiver measurement cannot silently be skipped by another smoke scope', async () => {
  for (const scope of [{ startupOnly: true }, { env: { LOOM_DESKTOP_SELF_INPUT: '1' } },
    { env: { LOOM_DESKTOP_VISION_PHOTO: '/test.jpg' } }]) {
    await assert.rejects(verifyDesktop({ ...scope, env: { ...scope.env, LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS: '60' } }),
      /requires the full Syphon smoke/);
  }
  await assert.rejects(verifyDesktop({ env: { LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS: '60' } }),
    /requires macOS native video addons/);
});

test('cancelled startup does not build or bind a renderer server', async () => {
  const cancellation = new AbortController();
  const reason = new Error('test startup interruption');
  cancellation.abort(reason);
  await assert.rejects(startDesktopRenderer({ root: '/must-not-be-read', smoke: true,
    production: true, signal: cancellation.signal }), error => error === reason);
});

test('compiled desktop includes native HTML but excludes smoke fixtures from ordinary preview', () => {
  const production = rendererBuildOptions('/project', '/owned-build', false);
  assert.deepEqual(production.rollupOptions.input, {
    app: '/project/index.html', output: '/project/src/desktop/output.html',
    inference: '/project/src/desktop/inference.html',
  });
  assert.equal(production.outDir, '/owned-build');
  const smoke = rendererBuildOptions('/project', '/owned-build', true);
  assert.equal(Object.keys(smoke.rollupOptions.input).length, 6);
  assert.equal(smoke.rollupOptions.preserveEntrySignatures, 'strict');
});

test('smoke imports explicit development paths or manifest entries, never a guessed fallback', () => {
  const development = rendererFixtureModules();
  const manifest = Object.fromEntries(Object.entries(development).map(([name, path]) => [path.slice(1), {
    isEntry: true, file: `assets/${name}-hash.js`,
  }]));
  assert.deepEqual(rendererFixtureModules(manifest), {
    output: '/assets/output-hash.js', input: '/assets/input-hash.js', vision: '/assets/vision-hash.js',
  });
  delete manifest[development.input.slice(1)];
  assert.throws(() => rendererFixtureModules(manifest), /Missing compiled desktop fixture/);
});
