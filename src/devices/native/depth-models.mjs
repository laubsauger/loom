import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, unlink } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { promisify } from 'node:util';

// T1818b: Depth Pro 2 on Core ML. Apple's pinned first-party packages are fetched
// only when the renderer asks (after the person consents in the notice strip),
// verified byte for byte against depth-model-manifest.json, and compiled ONCE into
// the native cache. Probing and opening never download or compile anything.
const MARKER = '.loom-depth-ready.json';
const CHUNK_BYTES = 1024 * 1024;
const RESERVE_BYTES = 1024 ** 3;
const ID = /^depthpro2-[a-z]+-coreml$/;
const PACKAGE = /^depthpro2-[a-z]+_w4\.mlpackage$/;
const FUNCTION = /^res_(\d+)x(\d+)$/;
const { AbortController } = globalThis;

/** Darwin 24 is macOS 15, the first with MLState and Core ML function names. */
export function depthSupport({ platform = process.platform, arch = process.arch, release = osRelease() } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64')
    return { supported: false, reason: 'Depth Pro 2 on Core ML needs the Loom desktop app on a Mac with Apple Silicon.' };
  if (!(Number.parseInt(release, 10) >= 24)) return { supported: false, reason: 'Depth Pro 2 on Core ML needs macOS 15 or later.' };
  return { supported: true };
}

/** A function name's own input box, width × height, or undefined when it is not one. */
export function depthFunctionSize(name) {
  const match = typeof name === 'string' ? FUNCTION.exec(name) : null;
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.incomplete'));
}
function validDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

export function validateDepthManifest(value) {
  if (!value || value.version !== 1 || typeof value.revision !== 'string' || !/^[a-f0-9]{40}$/.test(value.revision) ||
    !Array.isArray(value.functions) || !value.functions.length || value.functions.some(name => !depthFunctionSize(name)) ||
    !Array.isArray(value.models) || !value.models.length)
    throw new Error('Invalid trusted Depth Pro 2 manifest');
  const ids = new Set();
  for (const model of value.models) {
    if (!model || !ID.test(model.id) || ids.has(model.id) || typeof model.label !== 'string' || !model.label ||
      !PACKAGE.test(model.package) || !Array.isArray(model.files) || !model.files.length ||
      !Number.isSafeInteger(model.totalBytes) || model.totalBytes !== model.files.reduce((sum, file) => sum + file?.bytes, 0))
      throw new Error('Invalid trusted Depth Pro 2 model manifest');
    ids.add(model.id);
    const paths = new Set();
    for (const file of model.files) {
      if (!safePath(file.path) || !file.path.startsWith(`${model.package}/`) || paths.has(file.path) ||
        typeof file.url !== 'string' || new URL(file.url).protocol !== 'https:' || !file.url.includes(value.revision) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !validDigest(file.sha256))
        throw new Error('Invalid trusted Depth Pro 2 file manifest');
      paths.add(file.path);
    }
  }
  return JSON.parse(JSON.stringify(value));
}

async function fileInfo(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Depth Pro 2 cache entry is not a regular file: ${path}`);
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
/** Every component below `root` is a real directory, so no cached path leads elsewhere. */
async function within(root, path) {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}
async function ownedDirectory(path) {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Depth Pro 2 cache directory is not an owned directory: ${path}`);
}
async function digest(path, signal, hash = createHash('sha256')) {
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES, signal })) hash.update(chunk);
  return hash;
}
async function writeAll(handle, bytes) {
  for (let offset = 0; offset < bytes.byteLength;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten < 1) throw new Error('Depth Pro 2 cache write made no progress');
    offset += bytesWritten;
  }
}
/** Regular files below `directory`, relative to `root`; a link anywhere refuses the tree. */
async function listFiles(root, directory) {
  const files = [];
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Compiled Depth Pro 2 model contains a link: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) { const info = await lstat(join(root, path)); files.push({ path, size: info.size, mtimeMs: info.mtimeMs }); }
    else throw new Error(`Compiled Depth Pro 2 model contains a special file: ${path}`);
  }
  return files;
}

/** Main-process owner of the Depth Pro 2 cache; no renderer, GPU or worker imports. */
export function createDepthModels({ directory, manifest: input, compiler, library, fetch: fetchFn = globalThis.fetch,
  run = (file, args, options) => promisify(execFile)(file, args, options),
  platform = process.platform, arch = process.arch, release = osRelease() }) {
  const manifest = validateDepthManifest(input);
  if (![directory, compiler, library].every(path => typeof path === 'string' && isAbsolute(path)))
    throw new Error('Depth Pro 2 models require trusted absolute owner paths');
  directory = resolve(directory);
  const active = new Set();
  const support = () => depthSupport({ platform, arch, release });
  const model = id => {
    const found = manifest.models.find(candidate => candidate.id === id);
    if (!found) throw new Error('Unknown Depth Pro 2 model');
    return found;
  };
  const compiledName = entry => entry.package.replace(/\.mlpackage$/, '.mlmodelc');

  async function unchanged(root, entry) {
    if (!entry || !safePath(entry.path) || !await within(root, entry.path)) return false;
    const info = await fileInfo(join(root, entry.path));
    return !!info && info.size === entry.size && info.mtimeMs === entry.mtimeMs;
  }
  /** The compiled model's path when its marker still describes the bytes on disk. */
  async function ready(entry) {
    const root = join(directory, entry.id);
    let marker;
    try {
      const info = await fileInfo(join(root, MARKER));
      if (!info || info.size > CHUNK_BYTES) return null;
      marker = JSON.parse(await readFile(join(root, MARKER), 'utf8'));
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null; throw error; }
    if (!marker || marker.version !== 1 || marker.modelId !== entry.id || marker.revision !== manifest.revision ||
      !Array.isArray(marker.package) || marker.package.length !== entry.files.length ||
      !Array.isArray(marker.compiled) || !marker.compiled.length) return null;
    for (const [index, file] of entry.files.entries()) {
      const cached = marker.package[index];
      if (cached?.path !== file.path || cached.sha256 !== file.sha256 || cached.size !== file.bytes || !await unchanged(root, cached)) return null;
    }
    const prefix = `compiled/${compiledName(entry)}/`;
    for (const cached of marker.compiled) if (!cached?.path?.startsWith(prefix) || !await unchanged(root, cached)) return null;
    return join(root, 'compiled', compiledName(entry));
  }
  async function built() {
    for (const path of [compiler, library]) {
      try { if (!(await lstat(path)).isFile()) return false; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    return true;
  }
  async function download(root, file, done, total, onProgress, signal) {
    const path = join(root, file.path), partial = `${path}.incomplete`;
    const existing = await fileInfo(partial);
    let received = existing?.size ?? 0, reported = -Infinity;
    if (received > file.bytes) throw new Error(`Incomplete Depth Pro 2 download is longer than its pinned file: ${file.path}`);
    const hash = createHash('sha256');
    if (existing) { onProgress({ phase: 'verifying' }); await digest(partial, signal, hash); }
    const report = () => {
      if (received - reported < CHUNK_BYTES && received !== file.bytes) return;
      reported = received; onProgress({ phase: 'downloading', received: done + received, total });
    };
    report();
    if (received < file.bytes) {
      const response = await fetchFn(file.url, { signal, headers: { 'Accept-Encoding': 'identity',
        ...(received ? { Range: `bytes=${received}-${file.bytes - 1}` } : {}) } });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const length = response.headers.get('content-length');
      if ((received ? response.status !== 206 || !range || Number(range[1]) !== received ||
          Number(range[2]) !== file.bytes - 1 || Number(range[3]) !== file.bytes : response.status !== 200) ||
        (length !== null && Number(length) !== file.bytes - received)) {
        await response.body?.cancel();
        throw new Error(`Depth Pro 2 download of ${file.path} was refused (HTTP ${response.status}) or does not match its pinned length`);
      }
      const handle = await open(partial, existing ? 'a' : 'wx', 0o600);
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          if (received + chunk.byteLength > file.bytes) throw new Error(`Depth Pro 2 download exceeds its pinned length: ${file.path}`);
          await writeAll(handle, chunk);
          hash.update(chunk); received += chunk.byteLength; report();
        }
        await handle.sync();
      } finally { await handle.close(); }
    }
    signal.throwIfAborted();
    onProgress({ phase: 'verifying' });
    if (received !== file.bytes || hash.digest('hex') !== file.sha256) {
      // Our own download, provably wrong: nothing of it may be published or resumed.
      await rm(partial, { force: true });
      throw new Error(`Depth Pro 2 download failed verification and was discarded: ${file.path}`);
    }
    await link(partial, path); // never overwrites a file published meanwhile
    await unlink(partial);
  }

  return {
    ids: manifest.models.map(entry => entry.id),
    functions: [...manifest.functions],
    /** Never downloads, compiles or starts a process. */
    async probe() {
      const models = await Promise.all(manifest.models.map(async entry =>
        ({ id: entry.id, bytes: entry.totalBytes, cached: (await ready(entry)) !== null })));
      const capability = support();
      if (!capability.supported) return { available: false, reason: capability.reason, models };
      if (!await built()) return { available: false, models,
        reason: 'The native Depth Pro 2 service is not built in this desktop app. Restart Loom with pnpm desktop:dev.' };
      return { available: true, models };
    },
    /** The verified compiled model, or a refusal: opening never acquires. */
    async compiled(id) {
      const entry = model(id);
      const capability = support();
      if (!capability.supported) throw new Error(capability.reason);
      if (!await built()) throw new Error('The native Depth Pro 2 service is not built in this desktop app.');
      const path = await ready(entry);
      if (!path) throw new Error(`${entry.label} is not downloaded on this Mac yet.`);
      return path;
    },
    async prepare(id, onProgress = () => {}, signal = new AbortController().signal) {
      const entry = model(id);
      if (active.has(entry.id)) throw new Error(`${entry.label} is already being prepared`);
      active.add(entry.id);
      try {
        const capability = support();
        if (!capability.supported) throw new Error(capability.reason);
        if (!await built()) throw new Error('The native Depth Pro 2 service is not built in this desktop app.');
        if (await ready(entry)) return;
        const root = join(directory, entry.id);
        await ownedDirectory(directory); await ownedDirectory(root);
        let needed = 0;
        for (const file of entry.files) {
          if (!await fileInfo(join(root, file.path)))
            needed += file.bytes - ((await fileInfo(join(root, `${file.path}.incomplete`)))?.size ?? 0);
        }
        const disk = await statfs(directory, { bigint: true });
        // The compiled copy is about as large as the package.
        if (disk.bavail * disk.bsize < BigInt(needed + entry.totalBytes) + BigInt(RESERVE_BYTES))
          throw new Error(`${entry.label} needs ${Math.ceil((needed + entry.totalBytes) / 1024 ** 2)} MB plus 1 GB of free disk space.`);
        const verified = [];
        let done = 0;
        for (const file of entry.files) {
          signal.throwIfAborted();
          let current = root;
          for (const part of file.path.split('/').slice(0, -1)) { current = join(current, part); await ownedDirectory(current); }
          const path = join(root, file.path);
          const info = await fileInfo(path);
          if (info) {
            onProgress({ phase: 'verifying' });
            if (info.size !== file.bytes || (await digest(path, signal)).digest('hex') !== file.sha256)
              throw new Error(`Cached ${entry.label} file is corrupt; remove it before retrying: ${path}`);
          } else await download(root, file, done, entry.totalBytes, onProgress, signal);
          const final = await fileInfo(path);
          verified.push({ path: file.path, sha256: file.sha256, size: final.size, mtimeMs: final.mtimeMs });
          done += file.bytes;
        }
        signal.throwIfAborted();
        onProgress({ phase: 'compiling' });
        // Compiled output is derived from the verified package: a stale one is ours to replace.
        for (const name of await readdir(root)) if (name === 'compiled' || name.startsWith('compiling-'))
          await rm(join(root, name), { recursive: true, force: true });
        const staging = join(root, `compiling-${randomUUID()}`);
        await mkdir(staging);
        try {
          const { stdout } = await run(compiler, [join(root, entry.package), join(staging, compiledName(entry))],
            { signal, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 });
          let reply;
          try { reply = JSON.parse(String(stdout).trim()); } catch { reply = null; }
          if (reply?.kind !== 'compiled' || JSON.stringify(reply.functions) !== JSON.stringify(manifest.functions))
            throw new Error(`${entry.label} compiled without the pinned stream functions`);
          await rename(staging, join(root, 'compiled'));
        } finally { await rm(staging, { recursive: true, force: true }); }
        const compiled = await listFiles(root, `compiled/${compiledName(entry)}`);
        const markerPath = join(root, `${MARKER}.${randomUUID()}`);
        const handle = await open(markerPath, 'wx', 0o600);
        try {
          await writeAll(handle, Buffer.from(JSON.stringify({ version: 1, modelId: entry.id, revision: manifest.revision,
            package: verified, compiled })));
          await handle.sync();
        } finally { await handle.close(); }
        try { await rename(markerPath, join(root, MARKER)); } finally { await rm(markerPath, { force: true }); }
      } finally { active.delete(entry.id); }
    },
  };
}
