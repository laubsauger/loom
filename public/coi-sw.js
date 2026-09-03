/**
 * T1048 — the header shim that makes the HOSTED build cross-origin isolated.
 *
 * ## Why this file exists at all
 *
 * `SharedArrayBuffer` — and therefore multi-threaded wasm in `onnxruntime-web` — is gated
 * on cross-origin isolation, which is delivered by two response headers on the DOCUMENT:
 * `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
 * require-corp`. The dev server sends both (`vite.config.ts`). **GitHub Pages sends no
 * custom headers and never will**, so the hosted build was un-isolated and every model ran
 * on ONE wasm thread — measured through the real inference worker, MODNet 512²: 1030 ms
 * hosted against 250 ms isolated, 4.1× (§T1041).
 *
 * A service worker is the only lever a static host leaves: it sits in front of the
 * navigation, refetches the document and hands back a copy carrying the two headers. The
 * page that REGISTERS a service worker is not controlled by it, so the first visit has to
 * reload once before the shim can take effect — see `src/app/cross-origin-isolation.ts`,
 * which owns that dance and the proof it runs at most once.
 *
 * ## ⚠ WORKER SCRIPTS NEED THE HEADER TOO, AND FAIL SILENTLY WITHOUT IT
 *
 * The first version of this file stamped navigations only, on the reasoning that COOP/COEP
 * are DOCUMENT policies. That reasoning is wrong, and wrong in the worst available
 * direction: it isolates the page and then breaks the model runtime.
 *
 * Measured 2026-09-03 in Playwright's Chromium, on a page carrying a real `require-corp`
 * (`crossOriginIsolated === true`), loading a same-origin worker script over the network:
 *
 * | worker script response          | classic `new Worker` | `{ type: "module" }` |
 * | ------------------------------- | -------------------- | -------------------- |
 * | no `Cross-Origin-Embedder-Policy` | `error` event, message `undefined` | `error` event, message `undefined` |
 * | `Cross-Origin-Embedder-Policy: require-corp` | loads, `crossOriginIsolated: true`, `new SharedArrayBuffer(8)` works | same |
 *
 * A dedicated worker's own script response must carry a COEP compatible with its owner's,
 * and the failure arrives as an `error` event with NO message, NO filename and NO console
 * entry — indistinguishable from a syntax error in a file that is in fact fine. The dev
 * server never showed this because it stamps the headers on *every* response, worker
 * scripts included. On GitHub Pages, a navigation-only shim would have isolated the page
 * and killed `inference.worker.ts` outright: every model node dead, in the hosted build
 * only. That is strictly worse than being four times slower.
 *
 * So this worker stamps documents AND worker scripts — which is exactly the set of
 * responses that carry an embedder policy of their own, and nothing else.
 *
 * ## Everything else is left alone, and that IS a measurement
 *
 * The widely-copied `coi-serviceworker` intercepts EVERY response and stamps
 * `Cross-Origin-Resource-Policy: cross-origin` on all of them, because under
 * `require-corp` a cross-origin subresource needs CORP *or* CORS. This app's only
 * cross-origin subresources are the Hugging Face model downloads, and they are plain
 * CORS-mode `fetch()` calls. Measured 2026-09-03 in Chrome, from a document with a real
 * `require-corp` header, against the pinned MoveNet artefact: the response arrives with
 * `access-control-allow-origin: *`, **no `Cross-Origin-Resource-Policy` header at all**,
 * and the fetch SUCCEEDS — 2,598,245 bytes, response type `cors`. A CORS-mode fetch
 * satisfies `require-corp` on its own; the same URL fetched with `mode: "no-cors"` is
 * blocked, with or without this worker.
 *
 * So there is nothing to do for a subresource, and nothing is done: the 4 MB bundle, the
 * 27 MB onnxruntime `.wasm`, the fonts and the example thumbnails never enter this
 * worker's `fetch` at all. They are same-origin, which `require-corp` already permits.
 *
 * ⚠ If a cross-origin resource is ever added that CANNOT be fetched in CORS mode (a
 * `<script>` or `<img>` without `crossorigin`, an opaque `no-cors` fetch), it will be
 * blocked under isolation and this worker will not save it. Fix it at the call site by
 * making it a CORS request; do not turn this into a blanket proxy without measuring what
 * that costs every response.
 */

self.addEventListener("install", () => {
  // Take over as soon as the bytes are in: without this a shim update sits in `waiting`
  // until every tab closes, which on a single-page app is "never".
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * The responses that carry an embedder policy of their own: documents (top-level and
 * framed) and worker scripts. Everything else is a subresource, which has no COEP and
 * needs none.
 *
 * `destination` rather than a URL pattern, because the app's worker is
 * `new Worker(new URL("./inference.worker.ts", import.meta.url), { type: "module" })` —
 * the built filename is a rollup hash nobody can match on. A blob-URL worker (which is how
 * onnxruntime spawns its own pthread workers) never reaches a service worker at all and
 * needs no help: a local scheme INHERITS its creator's policy.
 */
function needsEmbedderPolicy(request) {
  return (
    request.mode === "navigate" ||
    request.destination === "worker" ||
    request.destination === "sharedworker"
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Not this worker's business. Returning without calling `respondWith` hands the request
  // straight back to the browser's own network stack — no extra fetch, no copy, not in
  // the critical path.
  if (!needsEmbedderPolicy(request)) return;

  event.respondWith(
    fetch(request).then((response) => {
      // A navigation request carries `redirect: "manual"`, so a redirecting server yields
      // an OPAQUE REDIRECT: status 0, unreadable headers, `new Response` impossible. Hand
      // it back untouched — the browser follows it and the next navigation comes through
      // here again, this time to a real document. (GitHub Pages redirects `/loom` →
      // `/loom/`, so this is a live path, not a hypothetical.)
      if (response.status === 0) return response;

      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      // No `.catch`: a failed navigation fetch must stay a failed navigation. Swallowing
      // it here would replace the browser's own offline page with a blank one.
    }),
  );
});
