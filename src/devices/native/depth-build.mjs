import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { depthSupport } from './depth-models.mjs';

const FRAMEWORKS = ['Foundation', 'CoreML', 'CoreVideo', 'Metal', 'IOSurface'].flatMap(name => ['-framework', name]);

/** T1818b: the Depth Pro 2 worker library and its one-shot compiler, beside the Vision build. */
export function buildNativeDepth(directory) {
  const support = depthSupport();
  if (!support.supported) throw new Error(support.reason);
  const source = name => fileURLToPath(new URL(name, import.meta.url));
  const build = args => {
    const result = spawnSync('clang++', ['-std=c++17', '-fobjc-arc', '-mmacosx-version-min=15.0', ...FRAMEWORKS, ...args],
      { stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native Depth build failed: ${result.status}`);
  };
  const library = join(directory, 'depth-service.dylib');
  const compiler = join(directory, 'depth-compile');
  // The serve loop is Person Mask's own, without its Vision binding.
  build(['-dynamiclib', '-DLOOM_NATIVE_SERVICE_ONLY', source('depth-surface.mm'), source('depth-service.mm'),
    source('vision-service.mm'), '-o', library]);
  build([source('depth-surface.mm'), source('depth-compile.mm'), '-o', compiler]);
  return { library, compiler };
}
