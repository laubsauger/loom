// T1339: explicit pinned-source acquisition; no SDK installer or signing changes.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactDigest, verifyArtifact } from './build-cache.mjs';

const revision = '71351d4b484cd2d1917867f7846a5cdca724552d';
const sha256 = '9196aceb663bc87a3d9981fb993135cafb23a7df7a832d4cac5138925b6bbb1d';
const url = `https://codeload.github.com/Syphon/Syphon-Framework/tar.gz/${revision}`;
export function ensureSyphonFramework() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('This build targets macOS Apple Silicon only.');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const cache = join(root, '.cache', `syphon-${revision}`);
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, 'source.tar.gz');
  function run(command, args, stdio = 'inherit') {
    const result = spawnSync(command, args, { stdio, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: status=${result.status}, signal=${result.signal}`);
    return result.stdout?.trim();
  }
  if (!existsSync(archive)) {
    const download = join(mkdtempSync(join(cache, 'download-')), 'source.tar.gz');
    run('curl', ['--fail', '--location', '--show-error', '--silent', url, '--output', download]);
    const digest = createHash('sha256').update(readFileSync(download)).digest('hex');
    if (digest !== sha256) throw new Error(`Syphon archive checksum mismatch: ${digest}`);
    renameSync(download, archive);
  }
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (digest !== sha256) throw new Error(`Cached Syphon archive checksum mismatch: ${digest}`);

  const xcode = run('xcodebuild', ['-version'], 'pipe');
  const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], 'pipe');
  const key = createHash('sha256').update(JSON.stringify({ sha256, xcode, sdk, architecture: 'arm64', recipe: 1 })).digest('hex');
  const cachedManifest = join(cache, `artifact-${key}.json`);
  if (existsSync(cachedManifest)) {
    const manifest = JSON.parse(readFileSync(cachedManifest, 'utf8'));
    if (manifest.sha256 !== sha256 || manifest.xcode !== xcode || manifest.sdk !== sdk
      || !manifest.framework.startsWith(`${cache}/run-`)) throw new Error('Invalid Syphon cache manifest');
    return verifyArtifact(manifest);
  }
  // One verified build per pinned source/toolchain. Do not accumulate full
  // DerivedData trees on each Electron launch.
  const buildRoot = mkdtempSync(join(cache, 'run-'));
  run('tar', ['-xzf', archive, '-C', buildRoot]);
  const source = join(buildRoot, `Syphon-Framework-${revision}`);
  const derived = join(buildRoot, 'build');
  const log = join(buildRoot, 'xcodebuild.log');
  const logFd = openSync(log, 'wx');
  console.error(`Building pinned Syphon ${revision}; log: ${log}`);
  try {
    run('xcodebuild', ['-project', join(source, 'Syphon.xcodeproj'), '-scheme', 'Syphon',
      '-configuration', 'Release', '-destination', 'generic/platform=macOS',
      '-derivedDataPath', derived, 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES',
      'CODE_SIGNING_ALLOWED=NO', 'build'], ['ignore', logFd, logFd]);
  } finally {
    closeSync(logFd);
    for (const part of ['Build/Intermediates.noindex', 'ModuleCache.noindex', 'SDKStatCaches.noindex']) {
      const target = join(derived, part);
      if (existsSync(target)) rmSync(target, { recursive: true });
    }
  }
  const framework = join(derived, 'Build/Products/Release/Syphon.framework');
  const architecture = run('lipo', ['-archs', join(framework, 'Syphon')], 'pipe');
  if (architecture !== 'arm64') throw new Error(`Unexpected architecture: ${architecture}`);
  for (const path of ['Headers/SyphonMetalServer.h', 'Headers/SyphonMetalClient.h', 'Resources/default.metallib']) {
    if (!existsSync(join(framework, path))) throw new Error(`Missing framework artifact: ${path}`);
  }
  // Keep upstream root terms beside the binary; source and public headers retain
  // their per-file copyright/license notices too (not all use identical wording).
  const license = join(buildRoot, 'Syphon-License.txt');
  copyFileSync(join(source, 'License.txt'), license);
  const manifest = { revision, sha256, url, architecture, framework,
    headers: join(framework, 'Headers'), source, license, log,
    xcode, sdk, artifactDigest: artifactDigest(framework) };
  writeFileSync(join(buildRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(cachedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(manifest, null, 2));
  return framework;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node src/devices/native/syphon-build.mjs');
  ensureSyphonFramework();
}
