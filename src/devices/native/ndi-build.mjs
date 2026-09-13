import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

// Development only: link the explicitly approved external SDK, never copy it.
export function ndiOutputMode(value = 'staged') {
  if (value !== 'staged' && value !== 'direct') throw new Error('LOOM_NDI_OUTPUT_MODE must be staged or direct');
  return value;
}

export function buildNativeNdi(directory, sdkRoot, { outputMode = 'staged' } = {}) {
  ndiOutputMode(outputMode);
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Native NDI currently requires Apple Silicon macOS');
  if (typeof sdkRoot !== 'string' || !isAbsolute(sdkRoot) || !isAbsolute(directory))
    throw new Error('Native NDI requires absolute SDK and build directory paths');
  const sdk = realpathSync(sdkRoot);
  const destination = realpathSync(directory);
  const library = join(sdk, 'lib/macOS');
  const runtime = join(library, 'libndi.dylib');
  for (const path of [join(sdk, 'include/Processing.NDI.Lib.h'), runtime])
    if (!statSync(path).isFile()) throw new Error(`Native NDI SDK file required: ${path}`);
  if (!statSync(destination).isDirectory()) throw new Error('Native NDI build destination must be a directory');
  const addon = join(destination, 'ndi-video.node');
  const result = spawnSync('clang++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-fobjc-arc',
    `-DLOOM_NDI_DIRECT_OUTPUT=${outputMode === 'direct' ? 1 : 0}`,
    '-shared', '-undefined', 'dynamic_lookup', '-I', join(dirname(process.execPath), '../include/node'),
    '-I', join(sdk, 'include'), '-framework', 'Foundation', '-framework', 'IOSurface',
    fileURLToPath(new URL('./ndi-video.mm', import.meta.url)), runtime,
    `-Wl,-rpath,${library}`, '-o', addon], { stdio: 'inherit', timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native NDI build failed: ${result.status ?? result.signal}`);
  return addon;
}
