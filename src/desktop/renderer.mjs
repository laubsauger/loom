import { build, createServer, preview } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtures = {
  output: 'src/desktop/testing/output-fixture.ts',
  input: 'src/desktop/testing/input-fixture.ts',
  vision: 'src/desktop/testing/vision-graph-fixture.ts',
};

export function rendererBuildOptions(root, outDir, smoke) {
  return {
    outDir, emptyOutDir: true, manifest: true,
    rollupOptions: {
      // Smoke entry exports are called by Playwright, not another bundled module.
      preserveEntrySignatures: 'strict',
      input: Object.fromEntries([
        ['app', 'index.html'], ['output', 'src/desktop/output.html'],
        ['inference', 'src/desktop/inference.html'],
        ...(smoke ? Object.entries(fixtures).map(([name, path]) => [`fixture-${name}`, path]) : []),
      ].map(([name, path]) => [name, join(root, path)])),
    },
  };
}

export function rendererFixtureModules(manifest) {
  return Object.fromEntries(Object.entries(fixtures).map(([name, path]) => {
    if (manifest === undefined) return [name, `/${path}`];
    const entry = manifest[path];
    if (!entry?.isEntry || typeof entry.file !== 'string') throw new Error(`Missing compiled desktop fixture: ${path}`);
    return [name, `/${entry.file}`];
  }));
}

export async function startDesktopRenderer({ root, smoke, production, signal }) {
  const network = { host: '127.0.0.1', port: smoke ? 5188 : 5187, strictPort: true };
  let directory;
  let closeServer;
  const close = async () => {
    try { await closeServer?.(); }
    finally { if (directory) await rm(directory, { recursive: true }); }
  };
  try {
    signal.throwIfAborted();
    let server;
    let fixtureModules;
    if (production) {
      directory = await mkdtemp(join(tmpdir(), 'loom-desktop-renderer-'));
      const buildOptions = rendererBuildOptions(root, directory, smoke);
      await build({ root, build: buildOptions });
      signal.throwIfAborted();
      if (smoke) fixtureModules = rendererFixtureModules(JSON.parse(await readFile(join(directory, '.vite/manifest.json'), 'utf8')));
      server = await preview({ root, build: buildOptions, preview: network });
      closeServer = () => new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    } else {
      server = await createServer({ root, server: { ...network, ...(smoke ? { watch: null, hmr: false } : {}) } });
      closeServer = () => server.close();
      await server.listen();
      if (smoke) fixtureModules = rendererFixtureModules();
    }
    const address = server.httpServer.address();
    if (!address || typeof address !== 'object') throw new Error('Desktop renderer did not bind a TCP port');
    return { url: `http://127.0.0.1:${address.port}/`, fixtureModules, close };
  } catch (error) {
    await close();
    throw error;
  }
}
