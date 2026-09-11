import { createServer } from 'vite';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { buildNativeOutput } from '../devices/native/build-native.mjs';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const main = fileURLToPath(new URL('./main.cjs', import.meta.url));
const selfInput = process.argv.includes('--self-input');
const args = process.argv.slice(2).filter(value => value !== '--' && value !== '--self-input');
const smoke = args[0] === '--smoke';
const executableArg = args[smoke ? 1 : 0];
if (args.length > (smoke ? 2 : 1) || (selfInput && !smoke)) {
  throw new Error('Usage: pnpm desktop:dev [absolute Electron path] (or pnpm desktop:test [absolute Electron path] [--self-input])');
}
// Use the exact package dependency by default; an explicit path remains available
// for deliberate runtime comparisons, never an automatic version fallback.
const executable = executableArg ?? createRequire(import.meta.url)('electron');
await access(executable);
const profile = smoke ? await mkdtemp(join(tmpdir(), 'loom-desktop-smoke-')) : join(root, '.cache/electron-dev');
let nativeDirectory;
let server;
try {
await mkdir(profile, { recursive: true });
nativeDirectory = process.platform === 'darwin' && process.arch === 'arm64'
  ? await mkdtemp(join(tmpdir(), 'loom-native-output-')) : undefined;
const nativeAddon = process.platform === 'darwin' && process.arch === 'arm64'
  ? buildNativeOutput(nativeDirectory, { receiver: smoke }) : undefined;
server = await createServer({ root, server: { host: '127.0.0.1', port: smoke ? 5188 : 5187, strictPort: true,
  ...(smoke ? { watch: null, hmr: false } : {}) } });
  await server.listen();
  const address = server.httpServer.address();
  if (typeof address !== 'object' || !address) throw new Error('Vite did not bind a TCP port');
  const env = { ...process.env, LOOM_DESKTOP_URL: `http://127.0.0.1:${address.port}/`, LOOM_DESKTOP_PROFILE: profile };
  if (selfInput) env.LOOM_DESKTOP_SELF_INPUT = '1';
  if (nativeAddon) env.LOOM_NATIVE_OUTPUT_ADDON = nativeAddon;
  if (nativeAddon) env.LOOM_NATIVE_INPUT_ADDON = join(nativeDirectory, 'native-input.node');
  if (nativeAddon && smoke) env.LOOM_SYPHON_RECEIVER = join(nativeAddon, '..', 'syphon-receiver');
  // A caller's Electron-as-Node setting must not turn the app launch into a Node process.
  if (env.ELECTRON_RUN_AS_NODE) throw new Error('Unset ELECTRON_RUN_AS_NODE before launching the desktop app');
  console.log('LOOM_DESKTOP_START', JSON.stringify({ url: env.LOOM_DESKTOP_URL, profile, smoke }));
  if (smoke) {
    const { verifyDesktop } = await import('./testing/smoke.mjs');
    await verifyDesktop({ executable, main, env });
  } else {
    const child = spawn(executable, [main], { env, stdio: 'inherit' });
    let killTimer;
    const stop = () => {
      if (killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Electron exited: code=${code}, signal=${signal}`)));
      });
    } finally {
      clearTimeout(killTimer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
} finally {
  try { await server?.close(); }
  finally {
    if (nativeDirectory) await rm(nativeDirectory, { recursive: true });
    if (smoke) await rm(profile, { recursive: true });
  }
}
