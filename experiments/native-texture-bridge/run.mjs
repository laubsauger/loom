import { mkdtemp, access, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';

const here = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This proof requires macOS Apple Silicon; Windows is not implemented.');
}
const electron = process.argv[2];
const python = process.argv[3];
const check = process.argv[4] ?? 'pixels';
if (!['pixels', 'protocol', 'consumer-exit', 'producer-loss', 'renderer-loss', 'gpu-loss', 'early-release'].includes(check)) throw new Error(`Unknown check: ${check}`);
const needsElectron = ['pixels', 'renderer-loss', 'gpu-loss', 'early-release'].includes(check);
if (!electron || !python) throw new Error('Usage: node experiments/native-texture-bridge/run.mjs /path/to/Electron /absolute/path/to/python3');
await access(electron);
await access(python);
const headers = resolve(dirname(process.execPath), '../include/node');
await access(join(headers, 'node_api.h'));
const build = await mkdtemp(join(tmpdir(), 'shaderloom-texture-proof-'));
const addon = join(build, 'surface.node');
const library = join(build, 'producer.dylib');
function checked(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 30000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: status=${result.status}, signal=${result.signal}`);
}
checked('clang++', ['-std=c++17', '-fobjc-arc', '-shared',
  '-undefined', 'dynamic_lookup', '-I', headers, '-framework', 'Foundation',
  '-framework', 'IOSurface', join(here, 'surface.mm'), '-o', addon]);
checked('clang++', ['-std=c++17', '-fobjc-arc', '-dynamiclib',
  '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'Metal',
  '-framework', 'CoreVideo', join(here, 'producer.mm'), '-o', library]);
const service = `com.loom.texture-proof.${randomUUID()}`;
const token = randomUUID();
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${service}`;
const plist = join(build, 'producer.plist');
const log = join(build, 'producer.log');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(service)}</string>
<key>ProgramArguments</key><array>${[python, '-B', join(here, 'producer.py'), library, service, token].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>MachServices</key><dict><key>${xml(service)}</key><true/></dict>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>3</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`, { mode: 0o600 });
const startedAt = new Date().toISOString();
console.log('NATIVE_TEXTURE_PROOF_START', JSON.stringify({ startedAt, build, service, cleanup: `launchctl bootout ${target}` }));
checked('launchctl', ['bootstrap', domain, plist]);
let failure;
try {
  const child = spawn(needsElectron ? electron : process.execPath,
    [join(here, needsElectron ? 'main.cjs' : `${check}.cjs`)], {
    stdio: 'inherit', timeout: 90000, killSignal: 'SIGKILL',
    env: { ...process.env, SHADERLOOM_TEXTURE_ADDON: addon, SHADERLOOM_PROOF_DATA: build,
      SHADERLOOM_PROOF_SERVICE: service, SHADERLOOM_PROOF_TOKEN: token, SHADERLOOM_PROOF_CHECK: check },
  });
  // Keep the runner alive to remove the service even on Ctrl-C/termination.
  const stop = () => child.kill('SIGKILL');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const result = await new Promise((resolveRun, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => resolveRun({ status, signal }));
    });
    console.log('NATIVE_TEXTURE_PROOF_EXIT', JSON.stringify({ startedAt,
      endedAt: new Date().toISOString(), pid: child.pid, ...result }));
    if (result.signal) throw new Error(`Electron terminated by ${result.signal} (pid ${child.pid})`);
    if (result.status === null) throw new Error('Electron returned no exit status');
    const expected = check === 'consumer-exit' ? 17 : 0;
    if (result.status !== expected) throw new Error(`${check}: expected exit ${expected}, got ${result.status}`);
    process.exitCode = 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
} catch (error) {
  failure = error;
}
try {
  checked('launchctl', ['bootout', target]);
  const inspect = spawnSync('launchctl', ['print', target], { encoding: 'utf8', timeout: 5000 });
  if (inspect.error || inspect.status === 0 || !inspect.stderr.includes('Could not find service')) {
    throw new Error(`Service cleanup not verified: ${target}`);
  }
  console.log('NATIVE_TEXTURE_PROOF_SERVICE_REMOVED', service);
  if (!existsSync(log)) throw new Error('Producer log absent: service did not start.');
  const producerLog = await readFile(log, 'utf8');
  console.log(producerLog);
  const expectedLog = check === 'consumer-exit' ? 'released=0 finished=0'
    : ['renderer-loss', 'gpu-loss'].includes(check) ? 'released=1 finished=0' : 'released=24 finished=1';
  if (!failure && check !== 'producer-loss' && !producerLog.includes(expectedLog))
    throw new Error(`Missing producer shutdown proof: ${expectedLog}`);
  if (!failure && producerLog.split('PYTHON_PRODUCER pid=').length !== 2)
    throw new Error('Expected exactly one producer launch; restart is not allowed');
} catch (error) {
  failure = failure ? new AggregateError([failure, error], 'Run and cleanup failed') : error;
}
if (failure) throw failure;
