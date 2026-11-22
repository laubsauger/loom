import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import process from 'node:process';
const execute = promisify(execFile);
// Person Mask (vision) and Depth Pro 2 (depth, T1818b) workers share one launcher and one cleanup.
const NAME = /^(vision|depth)-worker-([a-f0-9-]{36})\.plist$/;
const SERVICE_ARGUMENTS = { vision: 0, depth: 2 };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

async function present(target) {
  try { await execute('launchctl', ['print', target], { timeout: 5000 }); return true; }
  catch (error) {
    if (typeof error.stderr === 'string' && error.stderr.includes('Could not find service')) return false;
    throw error;
  }
}
async function retire(directory, kind, uuid) {
  const target = `gui/${process.getuid()}/com.loom.${kind}.${uuid}`;
  // The manifest is written before bootstrap so even a crash during registration
  // is cleanable. An unregistered manifest is an explicit lifecycle state.
  if (await present(target)) await execute('launchctl', ['bootout', target], { timeout: 10000 });
  const deadline = Date.now() + 10000;
  while (await present(target)) {
    if (Date.now() >= deadline) throw new Error(`Vision service did not retire: ${target}`);
    await setTimeout(50);
  }
  await unlink(join(directory, `${kind}-worker-${uuid}.plist`));
}

/** Parent-runner cleanup, AFTER Electron has exited, including crash/forced-exit paths. */
export async function retireVisionServices(directory) {
  for (const name of await readdir(directory)) {
    const match = NAME.exec(name);
    if (match) await retire(directory, match[1], match[2]);
  }
}

/** One bounded Python model process per demanded native Person Mask (or Depth) instance. */
export function createVisionWorkers({ native, directory, library, python = 'python3', kind = 'vision' }) {
  if (!isAbsolute(directory) || !isAbsolute(library)) throw new Error('Vision worker paths must be absolute');
  if (!Object.hasOwn(SERVICE_ARGUMENTS, kind)) throw new Error('Unknown native worker kind');
  const records = new Map();
  let pythonPath;
  return {
    /** `serviceArguments`: none for vision; the compiled model path and function for depth. */
    async open(serviceArguments = []) {
      if (!Array.isArray(serviceArguments) || serviceArguments.length !== SERVICE_ARGUMENTS[kind] ||
        serviceArguments.some(value => typeof value !== 'string' || !value || value.includes('\0')))
        throw new Error(`Invalid ${kind} worker arguments`);
      if (records.size >= 8) throw new Error('Vision worker cap reached, including pending retirement');
      const uuid = randomUUID(), token = randomUUID();
      const record = { uuid, nativeId: null, closed: false };
      records.set(uuid, record);
      let manifest = false;
      try {
        pythonPath ??= execute(python, ['-c', 'import sys; print(sys.executable)'], { timeout: 10000 })
          .then(({ stdout }) => { const path = stdout.trim(); if (!isAbsolute(path)) throw new Error('Python returned no absolute executable path'); return path; });
        const executable = await pythonPath;
        const service = `com.loom.${kind}.${uuid}`;
        const log = join(directory, `${kind}-worker-${uuid}.log`);
        const args = [executable, '-B', fileURLToPath(new URL(`${kind}-service.py`, import.meta.url)), library, service, token,
          ...serviceArguments];
        const plist = join(directory, `${kind}-worker-${uuid}.plist`);
        await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${service}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>MachServices</key><dict><key>${service}</key><true/></dict><key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>3</integer><key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`, { mode: 0o600 });
        manifest = true;
        await execute('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { timeout: 10000 });
        record.nativeId = native.open(service, token);
        await native.reset(record.nativeId);
        return {
          infer: (handle, inputSize, outputSize) => native.inferPacked(record.nativeId, handle, ...inputSize, ...outputSize),
          release: sequence => native.release(record.nativeId, sequence),
          reset: () => native.reset(record.nativeId),
          async close() {
            if (record.closed) throw new Error('Vision worker already closed');
            // A failed close leaves its record AND manifest. No uncertain GPU
            // lease can be turned into available capacity by killing the worker.
            await native.close(record.nativeId);
            await retire(directory, kind, uuid);
            record.closed = true; records.delete(uuid);
          },
          async diagnostic() { return await readFile(log, 'utf8'); },
        };
      } catch (error) {
        try {
          if (record.nativeId) native.disconnect(record.nativeId);
          if (manifest) await retire(directory, kind, uuid);
          records.delete(uuid);
        } catch (cleanup) { throw new AggregateError([error, cleanup], 'Vision startup and cleanup failed', { cause: cleanup }); }
        throw error;
      }
    },
  };
}
