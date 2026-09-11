import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { ensureSyphonFramework } from './syphon-build.mjs';

export function buildNativeOutput(directory, { receiver = false, oracle = false } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native output build currently requires Apple Silicon macOS');
  const framework = ensureSyphonFramework();
  const addon = join(directory, 'native-output.node');
  const source = fileURLToPath(new URL('./syphon-output.mm', import.meta.url));
  const result = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    ...(oracle ? ['-DLOOM_EXPORT_ORACLE=1'] : []),
    '-I', join(dirname(process.execPath), '../include/node'), '-F', dirname(framework),
    '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'Metal', '-framework', 'Syphon',
    '-Wl,-rpath,' + dirname(framework), source, '-o', addon], { stdio: 'inherit', timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native output build failed: ${result.status}`);
  const inputSource = fileURLToPath(new URL('./syphon-input.mm', import.meta.url));
  const input = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-I', join(dirname(process.execPath), '../include/node'), '-F', dirname(framework),
    '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'Metal', '-framework', 'Syphon',
    '-Wl,-rpath,' + dirname(framework), inputSource, '-o', join(directory, 'native-input.node')], { stdio: 'inherit', timeout: 60000 });
  if (input.error) throw input.error;
  if (input.status !== 0) throw new Error(`Native input build failed: ${input.status}`);
  if (receiver) {
    const fixtureSource = fileURLToPath(new URL('../../desktop/testing/syphon-input-fixture.mm', import.meta.url));
    const fixture = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
      '-I', join(dirname(process.execPath), '../include/node'), '-F', dirname(framework),
      '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'Metal', '-framework', 'Syphon',
      '-Wl,-rpath,' + dirname(framework), fixtureSource, '-o', join(directory, 'input-fixture.node')], { stdio: 'inherit', timeout: 60000 });
    if (fixture.error) throw fixture.error;
    if (fixture.status !== 0) throw new Error(`Syphon input fixture build failed: ${fixture.status}`);
    const receiverSource = fileURLToPath(new URL('../../desktop/testing/syphon-receiver.mm', import.meta.url));
    const build = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-F', dirname(framework),
      '-framework', 'Foundation', '-framework', 'Cocoa', '-framework', 'Metal', '-framework', 'Syphon',
      '-Wl,-rpath,' + dirname(framework), receiverSource, '-o', join(directory, 'syphon-receiver')], { stdio: 'inherit', timeout: 60000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Syphon receiver build failed: ${build.status}`);
  }
  return addon;
}
