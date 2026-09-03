import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * T1048 — the hosted build makes itself cross-origin isolated, in one reload, exactly once.
 *
 * ## Why this spec does not use the suite's dev server
 *
 * Every other spec in this directory runs against `pnpm dev`, and `pnpm dev` sends real
 * `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers — which is the one
 * condition under which this feature does NOTHING. The regime it exists for is GitHub
 * Pages: a static host that sends no custom headers at all. So this spec builds the actual
 * Pages artefact (`vite build --base=/loom/`) and serves it from a deliberately
 * header-less static server mounted at `/loom/`, which is as close to the deployment as
 * anything can get without deploying.
 *
 * The `--base=/loom/` is not cosmetic. It is the part most likely to be wrong: the shim is
 * registered at `${import.meta.env.BASE_URL}coi-sw.js` with that same scope, and a
 * registration pointed at `/coi-sw.js` would 404 on Pages while passing every test run at
 * base `/`.
 *
 * ## What is asserted, and why it is not "the service worker registered"
 *
 * The consumer-visible value is `crossOriginIsolated === true` and a real dedicated worker
 * getting a `SharedArrayBuffer` — that is what `onnxruntime-web` reads to decide whether
 * it may use threads, and what the node info popup reports back (§T1041). A registration
 * that succeeds and isolates nothing is the failure this spec is here to catch, so a
 * registration is never asserted.
 *
 * The per-load record is collected INSIDE the tab, by an init script, because the reload
 * destroys the page's JavaScript context and anything held outside `sessionStorage` with
 * it. That record is also the non-vacuity proof: load 1 must be `false`. If the static
 * server ever started sending the headers itself, load 1 would be `true` and these
 * assertions would fail rather than pass for the wrong reason.
 *
 * ## What this cannot prove
 *
 * That GitHub Pages' own responses (its redirects, its `Cache-Control`, its 404 handling)
 * survive the same treatment. Only a deploy shows that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const OUT_DIR = join(ROOT, "dist-pages");
const BASE_PATH = "/loom/";

/** The one page-served path the app itself does not contain: a same-ORIGIN worker script,
 *  fetched over the network, carrying no COEP header of its own. See the worker test. */
const PROBE_WORKER_PATH = `${BASE_PATH}e2e-isolation-probe.worker.js`;
const PROBE_WORKER_SOURCE = `self.postMessage({
  isolated: self.crossOriginIsolated === true,
  sharedArrayBuffer: (() => { try { return new SharedArrayBuffer(8).byteLength; } catch (e) { return String(e); } })(),
});`;

const MIME: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * A static server that sends NOTHING but content-type — the point of the exercise.
 *
 * Deliberately not `vite preview`: preview sends the isolation headers (see
 * `vite.config.ts`), which would make this whole spec pass without the shim existing.
 */
function serveStatic(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === PROBE_WORKER_PATH) {
      // No `Cross-Origin-Embedder-Policy` here, deliberately — GitHub Pages sends none on
      // a worker script either. Supplying it is the shim's job, and this is where that
      // gets checked.
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(PROBE_WORKER_SOURCE);
      return;
    }

    let pathname = url.pathname.startsWith(BASE_PATH)
      ? url.pathname.slice(BASE_PATH.length - 1)
      : url.pathname;
    if (pathname.endsWith("/")) pathname += "index.html";

    // `normalize` before joining: a `..` in a request path must not escape the build.
    const file = join(root, normalize(pathname));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      done({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * A SECOND origin that answers exactly the way Hugging Face's model CDN was measured to
 * (curl and a live browser fetch, 2026-09-03): `access-control-allow-origin: *`, and no
 * `Cross-Origin-Resource-Policy` header whatsoever.
 *
 * This stands in for the model download because the real one is 25–99 MB of network on
 * every run. The header shape is what decides the outcome under `require-corp`, and the
 * header shape is reproduced exactly; the bytes are not the variable.
 */
function serveCorplessCrossOrigin(): Promise<{ server: Server; origin: string }> {
  const body = Buffer.alloc(4096, 7);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      "access-control-allow-origin": "*",
    });
    response.end(body);
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      done({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

let site: { server: Server; origin: string };
let modelHost: { server: Server; origin: string };
let appUrl: string;

test.beforeAll(async () => {
  // Built here rather than reused: a stale `dist-pages/` would let this spec go green
  // against a bundle that predates the change it is testing, which is the exact shape of
  // dishonest gate this repo keeps banning. ~20 s, once per worker.
  execFileSync("pnpm", ["exec", "vite", "build", "--base=/loom/", "--outDir=dist-pages"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 300_000,
  });
  site = await serveStatic(OUT_DIR);
  modelHost = await serveCorplessCrossOrigin();
  appUrl = `${site.origin}${BASE_PATH}`;
});

test.afterAll(async () => {
  site?.server.close();
  modelHost?.server.close();
});

test.describe.configure({ mode: "serial" });

test("the hosted build isolates itself in one reload, and does not reload again", async ({
  page,
}) => {
  // Runs before any page script, on EVERY document — including the one the shim's reload
  // creates. `crossOriginIsolated` is already correct at this point in the document's
  // life, which is what makes a per-load record possible at all.
  await page.addInitScript(() => {
    const key = "e2e.isolation-per-load";
    const seen: boolean[] = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    seen.push(globalThis.crossOriginIsolated === true);
    sessionStorage.setItem(key, JSON.stringify(seen));
  });

  await page.goto(appUrl);

  // The shim registers, then reloads; poll rather than wait on a single event, because
  // the reload tears down the context the wait would be living in.
  await expect
    .poll(
      () =>
        page
          .evaluate(() => globalThis.crossOriginIsolated === true)
          .catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);

  const read = () =>
    page.evaluate<boolean[]>(() =>
      JSON.parse(sessionStorage.getItem("e2e.isolation-per-load") ?? "[]"),
    );

  // EXACTLY two documents: the un-isolated first hit, then the isolated one. The leading
  // `false` is the non-vacuity check — this server sends no headers, so without the shim
  // both entries would be `false` and nothing here could pass by accident.
  expect(await read()).toEqual([false, true]);

  // A second visit in the same tab. The shim already controls this scope, so the document
  // arrives isolated and there is nothing to reload for: one more entry, not two.
  await page.goto(appUrl);
  await expect.poll(read, { timeout: 10_000 }).toEqual([false, true, true]);

  // And a third, because "reloads once more, later" is a different bug from "reloads
  // twice at the start" and only a repeat can tell them apart.
  await page.goto(appUrl);
  await expect.poll(read, { timeout: 10_000 }).toEqual([false, true, true, true]);
});

test("a dedicated worker on the isolated page gets a real SharedArrayBuffer", async ({ page }) => {
  await page.goto(appUrl);
  await expect
    .poll(
      () => page.evaluate(() => globalThis.crossOriginIsolated === true).catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);

  /*
   * THIS IS THE TEST THAT CHANGED THE DESIGN, so it is worth saying what it caught.
   *
   * `onnxruntime-web` runs in a dedicated worker and reads `self.crossOriginIsolated`
   * THERE — not on the page — to decide whether it may spawn threads. The first version of
   * the shim stamped navigations only, on the reasoning that COOP/COEP are document
   * policies. Measured here, that version did not merely fail to isolate the worker: the
   * worker script would not LOAD AT ALL. Classic and module alike, the constructor fires an
   * `error` event whose `message` and `filename` are both `undefined`, with nothing in the
   * console — a hosted-only failure indistinguishable from a broken bundle. Adding
   * `Cross-Origin-Embedder-Policy: require-corp` to the worker script's own response, and
   * nothing else, turned all four cells green.
   *
   * The dev server hides this completely, because it stamps every response. So this
   * assertion is the guard on the worker-script branch of `public/coi-sw.js`: delete that
   * branch and this goes red on the thing a user actually loses, which is every model node.
   */
  const report = await page.evaluate(async (workerPath) => {
    const worker = new Worker(workerPath);
    try {
      return await new Promise<{ isolated: boolean; sharedArrayBuffer: number | string }>(
        (settle, fail) => {
          worker.onmessage = (event) => settle(event.data);
          worker.onerror = (event) => fail(new Error(String(event.message)));
        },
      );
    } finally {
      worker.terminate();
    }
  }, PROBE_WORKER_PATH);

  expect(report.isolated).toBe(true);
  expect(report.sharedArrayBuffer).toBe(8);
});

test("a CORP-less cross-origin model download still succeeds under require-corp", async ({
  page,
}) => {
  await page.goto(appUrl);
  await expect
    .poll(
      () => page.evaluate(() => globalThis.crossOriginIsolated === true).catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);

  /*
   * The failure mode that would make this whole change net-negative: `require-corp` says a
   * cross-origin subresource needs `Cross-Origin-Resource-Policy` OR CORS, Hugging Face
   * sends `access-control-allow-origin: *` and no CORP, and an isolation shim that
   * silently broke model downloads would be strictly worse than being slow.
   *
   * Measured, here and against the live endpoint: a CORS-mode fetch is enough. The shim
   * therefore proxies nothing. If that ever stops being true this test goes red on the
   * bytes, which is the thing a user would actually lose.
   */
  const result = await page.evaluate(async (origin) => {
    try {
      const response = await fetch(`${origin}/model.bin`);
      const bytes = await response.arrayBuffer();
      return {
        ok: response.ok,
        type: response.type,
        corp: response.headers.get("cross-origin-resource-policy"),
        bytes: bytes.byteLength,
      };
    } catch (error) {
      return { error: String(error) };
    }
  }, modelHost.origin);

  expect(result).toEqual({ ok: true, type: "cors", corp: null, bytes: 4096 });
});
