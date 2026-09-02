/**
 * The inference thread (T382). A shim — every decision lives in `inference-worker-core`,
 * which is testable without starting a thread.
 *
 * `onnxruntime-web` is imported here rather than on the main thread, so the runtime and
 * its embedded wasm land in the WORKER's chunk: a document with no model node never loads
 * either, and §V585's "a disconnected model node costs zero" survives the move.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §B171 — THE ONE LINE THAT MADE THE WHOLE FEATURE RUN
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `ort.env.wasm.wasmPaths` was set NOWHERE, so onnxruntime guessed. What it guesses is
 * `new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url)` — relative to whatever
 * module the runtime happens to have been bundled into — and the two environments guess
 * differently:
 *
 *   DEV      the module is Vite's pre-bundled dependency at
 *            `/node_modules/.vite/deps/onnxruntime-web.js`, so the guess is
 *            `/node_modules/.vite/deps/ort-wasm-simd-threaded.jsep.wasm`. esbuild's dep
 *            optimiser copies no assets, so nothing is there. MEASURED against a running
 *            `pnpm dev`: that URL answers **200 text/html**, body `<!doctype html>`,
 *            because the dev server falls through to the SPA index. `3c 21 64 6f` in the
 *            owner's `CompileError` is that `<!do`, byte for byte.
 *   BUILT    Vite's asset plugin rewrites the same expression to the hashed emission
 *            (`/assets/ort-wasm-simd-threaded.jsep-<hash>.wasm`) — but only at the one
 *            call site it can see statically; the emscripten glue's own
 *            `scriptDirectory + filename` path is a string concatenation and is not
 *            rewritten, and under `--base=/loom/` a wrong prefix is a 404 the same way.
 *
 * So the guess is not fixed by hoping. The `?url` import below asks VITE for the URL of
 * the very file it will serve, in dev and in a build and under any `base` — the same
 * mechanism, one answer, both environments. It has to be set before the first
 * `InferenceSession.create`, which is why it sits beside the import rather than in a
 * lazy initialiser someone can forget to call.
 *
 * Only `wasm` is overridden, not `mjs`: the default `onnxruntime-web` entry is
 * `ort.bundle.min.mjs`, whose emscripten glue is already INLINED. Pointing `mjs` at a file
 * would make it fetch a second copy of something it is holding.
 */
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import { createWorkerCore } from "./inference-worker-core.ts";
import type { InferenceRequest, InferenceResponse } from "./inference-protocol.ts";

const scope = self as unknown as {
  postMessage(message: InferenceResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: InferenceRequest }) => void): void;
};

/**
 * The runtime module, held after the first load.
 *
 * `createTensor` is synchronous by contract — the core calls it mid-run — so the module
 * has to be resolved by then. It always is: a tensor is only ever built after a session
 * exists, and building a session is what loads this.
 */
let runtime: typeof import("onnxruntime-web") | undefined;

/**
 * Resolve the runtime and point it at the wasm binary Vite is actually serving (§B171).
 *
 * `new URL(wasmUrl, self.location.href)` rather than the bare string: ORT documents
 * `wasmPaths` as needing an ABSOLUTE path, dev hands us a root-relative one
 * (`/node_modules/...`) and a `--base=/loom/` build hands us a prefixed one, and the
 * runtime re-resolves it from inside a blob-URL proxy worker where a relative path has
 * no meaningful base at all.
 */
async function loadRuntime(): Promise<typeof import("onnxruntime-web")> {
  if (runtime !== undefined) return runtime;
  const loaded = await import("onnxruntime-web");
  loaded.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };
  runtime = loaded;
  return loaded;
}

const core = createWorkerCore({
  /**
   * ONE provider per attempt — the ladder is walked by the core so the provider that
   * returns is the provider that ran (§T715/§V672: measure, never echo). Handing ORT
   * `["webgpu", "wasm"]` would let it fall back inside and leave us describing a session
   * we cannot identify.
   */
  createSession: async (weights, provider) => {
    const ort = await loadRuntime();
    return (await ort.InferenceSession.create(new Uint8Array(weights), {
      executionProviders: [provider as "webgpu" | "wasm"],
    })) as never;
  },
  createTensor: (type, data, dims) => {
    if (runtime === undefined) throw new Error("onnxruntime is not loaded");
    return new runtime.Tensor(type as never, data as never, dims as number[]);
  },
  post: (response, transfer) => {
    scope.postMessage(response, transfer);
  },
});

scope.addEventListener("message", (event) => {
  void core.handle(event.data);
});
