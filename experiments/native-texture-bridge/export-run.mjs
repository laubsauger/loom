import { createServer } from 'vite';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { buildNativeOutput } from '../../src/devices/native/build-native.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Export proof requires Apple Silicon macOS');
const executable = process.argv[2];
if (!executable || process.argv.length !== 3) throw new Error('Usage: node experiments/native-texture-bridge/export-run.mjs /absolute/path/to/Electron');
await access(executable);
if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('Unset ELECTRON_RUN_AS_NODE');
const here = dirname(fileURLToPath(import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'loom-export-proof-'));
let server;
try {
const addon = buildNativeOutput(profile, { oracle: true });
server = await createServer({ root: join(here, '../..'), server: { host: '127.0.0.1', port: 5190, strictPort: true } });
  await server.listen();
  const child = spawn(executable, [join(here, 'export-main.cjs')], { stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL',
    env: { ...process.env, LOOM_EXPORT_ADDON: addon, LOOM_EXPORT_PROFILE: profile,
      LOOM_EXPORT_URL: 'http://127.0.0.1:5190/experiments/native-texture-bridge/export.html' } });
  const stop = () => child.kill('SIGKILL');
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Export failed: ${code}, ${signal}`)));
    });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
} finally {
  try { await server?.close(); }
  finally { await rm(profile, { recursive: true }); }
}
