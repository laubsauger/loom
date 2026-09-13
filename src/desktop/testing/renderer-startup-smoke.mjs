import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';

// Real build-interruption regression, without launching another GPU application.
const directory = await mkdtemp(join(tmpdir(), 'loom-renderer-startup-test-'));
let child;
let closed;
let timer;
try {
  child = spawn(process.execPath, [fileURLToPath(new URL('../run.mjs', import.meta.url)),
    '--smoke', '--production', process.execPath], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let interrupted = false;
  closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const collect = chunk => {
    output += String(chunk);
    if (!interrupted && /building[^\n]*production/.test(output)) {
      interrupted = true;
      child.kill('SIGTERM');
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  const result = await closed;
  assert.equal(interrupted, true, output);
  assert.deepEqual(result, { code: 1, signal: null }, output);
  assert.match(output, /Desktop startup interrupted/);
  assert.doesNotMatch(output, /LOOM_DESKTOP_START /);
  assert.deepEqual(await readdir(directory), [], 'Interrupted startup left temporary artifacts');
  console.log('LOOM_RENDERER_STARTUP_CLEANUP_PASS');
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed;
  await rm(directory, { recursive: true });
}
