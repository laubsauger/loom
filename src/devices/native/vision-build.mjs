import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

export function buildNativeVision(directory) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native Vision requires Apple Silicon macOS');
  const source = name => fileURLToPath(new URL(name, import.meta.url));
  const build = args => {
    const result = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', ...args], { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native Vision build failed: ${result.status}`);
  };
  const library = join(directory, 'vision-service.dylib');
  const addon = join(directory, 'vision-client.node');
  build(['-dynamiclib', ...['Foundation', 'Vision', 'CoreVideo', 'Metal', 'IOSurface'].flatMap(name => ['-framework', name]),
    source('vision-surface.mm'), source('vision-service.mm'), '-o', library]);
  build(['-shared', '-undefined', 'dynamic_lookup', '-I', join(dirname(process.execPath), '../include/node'),
    '-framework', 'Foundation', '-framework', 'IOSurface', '-framework', 'CoreVideo', source('vision-client.mm'), '-o', addon]);
  return { library, addon };
}
