/* global AbortController */
import { startDesktopRenderer } from './renderer.mjs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { buildNativeOutput } from '../devices/native/build-native.mjs';
import { buildNativeVision } from '../devices/native/vision-build.mjs';
import { buildNativeNdi } from '../devices/native/ndi-build.mjs';
import { retireVisionServices } from '../devices/native/vision-workers.mjs';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const main = fileURLToPath(new URL('./main.cjs', import.meta.url));
const entry = fileURLToPath(new URL('./entry.cjs', import.meta.url));
const selfInput = process.argv.includes('--self-input');
const startupOnly = process.argv.includes('--startup');
const production = process.argv.includes('--production');
const args = process.argv.slice(2).filter(value => value !== '--' && value !== '--self-input' && value !== '--startup' && value !== '--production');
const smoke = args[0] === '--smoke';
const executableArg = args[smoke ? 1 : 0];
if (args.length > (smoke ? 2 : 1) || ((selfInput || startupOnly) && !smoke) || (selfInput && startupOnly)) {
  throw new Error('Usage: pnpm desktop:dev [absolute Electron path] [--production] (or pnpm desktop:test [absolute Electron path] [--production] [--self-input | --startup])');
}
// Use the exact package dependency by default; an explicit path remains available
// for deliberate runtime comparisons, never an automatic version fallback.
const executable = executableArg ?? createRequire(import.meta.url)('electron');
await access(executable);
const profile = smoke ? await mkdtemp(join(tmpdir(), 'loom-desktop-smoke-')) : join(root, '.cache/electron-dev');
let nativeDirectory;
let server;
let child;
let childClosed;
let interrupted = false;
const startupAbort = new AbortController();
let killTimer;
const stop = () => {
  interrupted = true;
  startupAbort.abort(new Error('Desktop startup interrupted'));
  if (!child || killTimer || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
};
const ownChild = value => {
  child = value;
  childClosed = new Promise(resolve => child.once('close', resolve));
  child.once('exit', () => { clearTimeout(killTimer); });
  if (interrupted) stop();
};
// Keep ownership through asynchronous compilation as well as the app lifetime.
// An interrupted build finishes its current operation, then cleanup runs without
// launching Electron. Do not exit the parent while native services still exist.
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
await mkdir(profile, { recursive: true });
nativeDirectory = process.platform === 'darwin' && process.arch === 'arm64'
  ? await mkdtemp(join(tmpdir(), 'loom-native-output-')) : undefined;
const nativeAddon = process.platform === 'darwin' && process.arch === 'arm64'
  ? buildNativeOutput(nativeDirectory, { receiver: smoke }) : undefined;
if (nativeDirectory) buildNativeVision(nativeDirectory);
if (process.env.LOOM_NDI_SDK && !nativeDirectory) throw new Error('NDI development currently requires the Apple Silicon desktop host');
if (process.env.LOOM_NDI_OUTPUT_MODE !== undefined && !process.env.LOOM_NDI_SDK)
  throw new Error('NDI output mode requires the explicitly configured external SDK');
const ndiAddon = process.env.LOOM_NDI_SDK ? buildNativeNdi(nativeDirectory, process.env.LOOM_NDI_SDK,
  { outputMode: process.env.LOOM_NDI_OUTPUT_MODE }) : undefined;
server = await startDesktopRenderer({ root, smoke, production, signal: startupAbort.signal });
  if (interrupted) throw new Error('Desktop startup interrupted; owned artifacts retired');
  const env = { ...process.env, LOOM_DESKTOP_URL: server.url, LOOM_DESKTOP_PROFILE: profile };
  if (selfInput) env.LOOM_DESKTOP_SELF_INPUT = '1';
  if (nativeAddon) env.LOOM_NATIVE_OUTPUT_ADDON = nativeAddon;
  if (nativeAddon) env.LOOM_NATIVE_INPUT_ADDON = join(nativeDirectory, 'native-input.node');
  if (nativeDirectory) env.LOOM_NATIVE_VISION_DIRECTORY = nativeDirectory;
  if (ndiAddon) env.LOOM_NATIVE_NDI_ADDON = ndiAddon;
  if (smoke && env.LOOM_DESKTOP_NDI_TEST === '1') {
    if (!ndiAddon) throw new Error('NDI app smoke requires an explicit LOOM_NDI_SDK');
    const { buildNdiProof } = await import('./testing/ndi-roundtrip.mjs');
    env.LOOM_NDI_TEST_SENDER = buildNdiProof(process.env.LOOM_NDI_SDK, nativeDirectory).executable;
  }
  if (nativeAddon && smoke) env.LOOM_SYPHON_RECEIVER = join(nativeAddon, '..', 'syphon-receiver');
  // A caller's Electron-as-Node setting must not turn the app launch into a Node process.
  if (env.ELECTRON_RUN_AS_NODE) throw new Error('Unset ELECTRON_RUN_AS_NODE before launching the desktop app');
  console.log('LOOM_DESKTOP_START', JSON.stringify({ url: env.LOOM_DESKTOP_URL, profile, smoke, production }));
  if (smoke) {
    const { verifyDesktop } = await import('./testing/smoke.mjs');
    await verifyDesktop({ executable, main, env, startupOnly, fixtureModules: server.fixtureModules, onStarted: ownChild });
  } else {
    const launched = spawn(executable, [entry], { env, stdio: 'inherit' });
    const exited = new Promise((resolve, reject) => {
      launched.once('error', reject);
      launched.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Electron exited: code=${code}, signal=${signal}`)));
    });
    ownChild(launched);
    await exited;
  }
} finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) stop();
    await childClosed;
    try { await server?.close(); }
    finally {
      if (nativeDirectory) {
        await retireVisionServices(nativeDirectory);
        await rm(nativeDirectory, { recursive: true });
      }
      if (smoke) await rm(profile, { recursive: true });
    }
  }
  finally {
    clearTimeout(killTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
