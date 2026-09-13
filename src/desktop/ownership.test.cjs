/* global require, __dirname, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('startup smoke scope cannot silently become a development launch or combine with self-input', () => {
  for (const args of [['--startup'], ['--smoke', '--startup', '--self-input']]) {
    const result = spawnSync(process.execPath, [join(__dirname, 'run.mjs'), ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: pnpm desktop:dev/);
  }
});

test('desktop startup and native build do not depend on experimental code', () => {
  const directories = [__dirname, join(__dirname, '../devices/native')];
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!/\.(cjs|mjs|ts)$/.test(name) || name.includes('.test.')) continue;
      const source = readFileSync(join(directory, name), 'utf8');
      assert.doesNotMatch(source, /['"`][^'"`\n]*experiments\//, name);
    }
  }
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(pkg.scripts['desktop:dev'], 'node src/desktop/run.mjs');
  assert.equal(pkg.scripts['desktop:preview'], 'node src/desktop/run.mjs --production');
  assert.equal(pkg.scripts['desktop:test'], 'node src/desktop/run.mjs --smoke');
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});

test('native pixel readback is compiled only for the explicit export oracle', () => {
  const source = readFileSync(join(__dirname, '../devices/native/syphon-output.mm'), 'utf8');
  const production = source.replace(/#ifdef LOOM_EXPORT_ORACLE\n[\s\S]*?(?:#else\n([\s\S]*?))?#endif/g, '$1');
  assert.doesNotMatch(production, /toBuffer:oracle|"inspect"/);
  assert.match(production, /"publish"/);
});

test('Vision surface provider has no CPU pixel-copy or readback path', () => {
  const source = readFileSync(join(__dirname, '../devices/native/vision-surface.mm'), 'utf8');
  assert.doesNotMatch(source, /CVPixelBufferGetBaseAddress|IOSurfaceGetBaseAddress|IOSurfaceLock|memcpy|replaceRegion|getBytes/);
  assert.match(source, /CVPixelBufferCreateWithIOSurface/);
  assert.match(source, /waitUntilCompleted/);
  const production = source.replace(/#ifdef LOOM_VISION_TEST_ORACLE\n[\s\S]*?#endif/g, '');
  assert.doesNotMatch(production, /loom_vision_test_mask/);
});

test('Vision IPC transports capabilities and preserves the provider thread boundary', () => {
  const source = readFileSync(join(__dirname, '../devices/native/vision-service.mm'), 'utf8');
  assert.doesNotMatch(source, /CVPixelBufferGetBaseAddress|IOSurfaceGetBaseAddress|IOSurfaceLock|memcpy|oracle_|dispatch_main\(/);
  assert.match(source, /IOSurfaceLookupFromXPCObject/);
  assert.match(source, /IOSurfaceCreateXPCObject/);
  assert.match(source, /CFRunLoopRun\(\)/);
  assert.match(source, /dispatch_get_main_queue\(\)/);
  assert.match(source, /xpc_connection_get_euid/);
});

test('Vision main-process client never blocks IPC or reads image bytes', () => {
  const source = readFileSync(join(__dirname, '../devices/native/vision-client.mm'), 'utf8');
  assert.doesNotMatch(source, /dispatch_semaphore_wait|send_message_with_reply_sync|napi_create_async_work|IOSurfaceGetBaseAddress|CVPixelBufferGetBaseAddress|oracle_/);
  assert.match(source, /napi_create_threadsafe_function/);
  assert.match(source, /napi_tsfn_nonblocking/);
  assert.match(source, /uncertain leases retained/);
});
