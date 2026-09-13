import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import console from 'node:console';
import { createRequire } from 'node:module';

const asyncClient = process.argv[4] === '--async-client';
const transport = asyncClient || process.argv[4] === '--transport';
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.argv.length !== (transport ? 5 : 4) ||
    !isAbsolute(process.argv[2]) || !isAbsolute(process.argv[3]))
  throw new Error('Usage on Apple Silicon: node src/desktop/testing/vision-surface-smoke.mjs /absolute/path/to/python3 /absolute/path/to/person-image [--transport|--async-client]');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'loom-vision-surface-'));
let activeService;
let failure;
function run(command, args, timeout = 60000) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}/${result.signal}`);
}
function assertNormalLibrary(path) {
  const symbols = spawnSync('nm', ['-gU', path], { encoding: 'utf8', timeout: 10000 });
  if (symbols.error) throw symbols.error;
  assert.equal(symbols.status, 0, symbols.stderr);
  assert.match(symbols.stdout, /_loom_vision_infer/);
  assert.doesNotMatch(symbols.stdout, /loom_vision_test_mask|oracle_/);
}
async function retireService() {
  if (!activeService) return;
  run('launchctl', ['bootout', activeService]);
  const deadline = Date.now() + 5000;
  do {
    const check = spawnSync('launchctl', ['print', activeService], { encoding: 'utf8', timeout: 5000 });
    if (check.error) throw check.error;
    if (check.status !== 0) {
      assert.match(check.stderr, /Could not find service/);
      console.log('VISION_TRANSPORT_SERVICE_REMOVED', activeService);
      activeService = undefined;
      return;
    }
    await setTimeout(50);
  } while (Date.now() < deadline);
  throw new Error(`Service still registered: ${activeService}; retained build: ${directory}`);
}
try {
  const library = join(directory, 'vision-oracle.dylib');
  const source = join(root, 'src/devices/native/vision-surface.mm');
  const frameworks = ['Foundation', 'Vision', 'CoreVideo', 'CoreImage', 'Metal', 'IOSurface'].flatMap(name => ['-framework', name]);
  // Compile both shapes: the normal library must not accidentally require the oracle.
  run('clang++', ['-std=c++17', '-fobjc-arc', '-dynamiclib', ...frameworks, source, '-o', join(directory, 'vision.dylib')]);
  assertNormalLibrary(join(directory, 'vision.dylib'));
  run('clang++', ['-std=c++17', '-fobjc-arc', '-dynamiclib', '-DLOOM_VISION_TEST_ORACLE', ...frameworks,
    source, join(root, 'src/desktop/testing/vision-surface-oracle.mm'), '-o', library]);
  run(process.argv[2], ['-B', join(root, 'src/desktop/testing/vision-surface-smoke.py'), library, process.argv[3]]);
  if (transport) {
    const serviceLibrary = join(directory, 'vision-service.dylib');
    const client = join(directory, 'vision-transport');
    run('clang++', ['-std=c++17', '-fobjc-arc', '-dynamiclib', ...frameworks, source,
      join(root, 'src/devices/native/vision-service.mm'), '-o', serviceLibrary]);
    assertNormalLibrary(serviceLibrary);
    run('clang++', ['-std=c++17', '-fobjc-arc', '-DLOOM_VISION_TEST_ORACLE', ...frameworks, source,
      join(root, 'src/desktop/testing/vision-surface-oracle.mm'),
      join(root, 'src/desktop/testing/vision-transport-oracle.mm'), '-o', client]);
    const addon = join(directory, 'vision-client.node');
    const fixture = join(directory, 'vision-client-fixture.node');
    const profile = join(directory, 'electron-profile');
    if (asyncClient) {
      const nativeFlags = ['-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
        '-I', join(dirname(process.execPath), '../include/node')];
      run('clang++', [...nativeFlags, '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'CoreVideo',
        join(root, 'src/devices/native/vision-client.mm'), '-o', addon]);
      run('clang++', [...nativeFlags, '-DLOOM_VISION_TEST_ORACLE', ...frameworks, source,
        join(root, 'src/desktop/testing/vision-surface-oracle.mm'),
        join(root, 'src/desktop/testing/vision-client-fixture.mm'), '-o', fixture]);
      await mkdir(profile);
    }
    if (asyncClient) {
      const child = spawn(createRequire(import.meta.url)('electron'),
        [join(root, 'src/desktop/testing/vision-client-smoke.cjs'), addon, fixture, 'worker-host', process.argv[2], process.argv[3], profile, 'worker-host'],
        { stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL' });
      try {
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Vision worker host failed: ${code}/${signal}`)));
        });
      } finally {
        const { retireVisionServices } = await import('../../devices/native/vision-workers.mjs');
        await retireVisionServices(directory);
      }
    }
    for (const scenario of ['round-trip', 'disconnect-held', ...(asyncClient ? ['async-client', 'async-timeout'] : [])]) {
      const service = `com.loom.vision-proof.${randomUUID()}`;
      const token = randomUUID();
      const domain = `gui/${process.getuid()}`;
      const plist = join(directory, `${scenario}.plist`);
      const log = join(directory, `${scenario}.log`);
      const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
      const args = [process.argv[2], '-B', join(root, 'src/devices/native/vision-service.py'), serviceLibrary, service, token];
      await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${xml(service)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>MachServices</key><dict><key>${xml(service)}</key><true/></dict>
<key>KeepAlive</key><false/><key>ExitTimeOut</key><integer>3</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>`, { mode: 0o600 });
      // Precreate the exact log, so polling never hides arbitrary read failures.
      await writeFile(log, '', { mode: 0o600 });
      run('launchctl', ['bootstrap', domain, plist]);
      activeService = `${domain}/${service}`;
      console.log('VISION_TRANSPORT_START', JSON.stringify({ scenario, service: activeService, directory }));
      const electronCase = scenario.startsWith('async-');
      const binary = electronCase ? createRequire(import.meta.url)('electron') : client;
      const clientArgs = electronCase
        ? [join(root, 'src/desktop/testing/vision-client-smoke.cjs'), addon, fixture, service, token, process.argv[3], profile, scenario]
        : [service, token, process.argv[3], scenario];
      const child = spawn(binary, clientArgs, { stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL' });
      const stop = () => child.kill('SIGKILL');
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      try {
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Vision client failed: ${code}/${signal}`)));
        });
        // Await actual worker shutdown evidence, not an arbitrary startup sleep.
        const deadline = Date.now() + 5000;
        let contents;
        do {
          contents = await readFile(log, 'utf8');
          if (contents.includes('VISION_SERVICE_EXIT')) break;
          await setTimeout(50);
        } while (Date.now() < deadline);
        const exitProof = scenario === 'disconnect-held' ? /released=0 finished=0 heldAtDisconnect=1/
          : scenario === 'async-timeout' ? /released=1 finished=0 heldAtDisconnect=[01]/
          : /released=3 finished=1 heldAtDisconnect=0/;
        assert.match(contents, exitProof);
        assert.equal(contents.split('PYTHON_VISION_SERVICE pid=').length, 2, 'Worker must not restart');
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        console.log(await readFile(log, 'utf8'));
      }
      await retireService();
    }
  }
} catch (error) {
  failure = error;
}
try {
  // If bootout cannot be verified, preserve files underneath the service.
  await retireService();
  await rm(directory, { recursive: true });
} catch (error) {
  failure = failure ? new AggregateError([failure, error], 'Vision proof and cleanup failed') : error;
}
if (failure) throw failure;
