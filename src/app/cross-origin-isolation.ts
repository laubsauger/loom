/**
 * T1048 — arming the hosted build's cross-origin isolation, and bounding its one reload.
 *
 * ## What this buys, and what it costs
 *
 * Cross-origin isolation is what gives a page `SharedArrayBuffer`, and `SharedArrayBuffer`
 * is what lets `onnxruntime-web` run wasm on more than one thread. It arrives as two
 * headers on the document response, which the dev server sends and **GitHub Pages cannot**
 * — so the hosted build ran every model single-threaded: MODNet 512² at 1030 ms against
 * the isolated 250 ms, measured through the real inference worker (§T1041).
 *
 * `public/coi-sw.js` puts those headers back. The cost is structural and worth naming: a
 * service worker does not control the page that registered it, so the FIRST visit to the
 * hosted app loads un-isolated, registers, and reloads. Everything below exists to make
 * that reload happen at most once.
 *
 * ## The reload cannot loop, and here is why
 *
 * The only path that reloads is `{ kind: "register" }`, which `decideIsolationStep`
 * returns only when `reloadAttempted` is false — and the flag is written to
 * `sessionStorage` BEFORE `location.reload()` is called, in the same synchronous step.
 * So a tab can take that path at most once per session, whatever happens afterwards:
 *
 * - The shim works → the next load is `isolated` and returns before reaching the flag.
 * - The shim does NOT work (registration failed, a browser that ignores it, headers
 *   stripped) → the next load reads the flag and returns `gave-up`. It does not reload,
 *   and it does not pretend: the page stays un-isolated and the UI keeps reporting the
 *   single-threaded regime it actually measures (§V827).
 * - `sessionStorage` throws (Safari private mode, storage blocked) → `unsupported`, which
 *   never reloads at all. A reload we cannot remember is exactly the reload that loops,
 *   so the inability to remember disables the feature rather than the memory.
 *
 * `cross-origin-isolation.test.ts` walks that table; `src/tests/e2e/cross-origin-
 * isolation.spec.ts` counts the actual document loads against a header-less static server
 * standing in for GitHub Pages.
 *
 * ## Nothing here runs in development
 *
 * `hosted` is `import.meta.env.PROD`. The dev server already sends real headers, so local
 * work must not depend on a service worker, inherit the reload, or leave a registration
 * behind on `localhost` that outlives the branch that installed it.
 */

/** What the boot path should do about isolation, and the reason, which is always stated. */
export type IsolationStep =
  /** Already isolated — real headers, or the shim from an earlier visit is controlling. */
  | { readonly kind: "isolated" }
  /** A dev build. The dev server sends the headers itself; the shim stays out of it. */
  | { readonly kind: "not-hosted" }
  /** Cannot be attempted here. Degrades to today's un-isolated page, not to a broken one. */
  | { readonly kind: "unsupported"; readonly why: string }
  /** Register the shim and reload ONCE. The only branch that ever reloads. */
  | { readonly kind: "register" }
  /** Already tried this session and we are still not isolated. Stop, and say so. */
  | { readonly kind: "gave-up"; readonly why: string };

export interface IsolationEnvironment {
  /** `globalThis.crossOriginIsolated` — MEASURED, never inferred from config. */
  readonly isolated: boolean;
  /** `import.meta.env.PROD`: a built bundle, which is the only thing GitHub Pages serves. */
  readonly hosted: boolean;
  /** Whether `navigator.serviceWorker` exists (absent off a secure context, and in some
   *  private-browsing modes). */
  readonly serviceWorkers: boolean;
  /** Whether `sessionStorage` can be read AND written. See the loop argument above. */
  readonly canRemember: boolean;
  /** Whether this tab session already spent its one reload. */
  readonly reloadAttempted: boolean;
}

export function decideIsolationStep(environment: IsolationEnvironment): IsolationStep {
  if (environment.isolated) return { kind: "isolated" };
  if (!environment.hosted) return { kind: "not-hosted" };
  if (!environment.serviceWorkers) {
    return {
      kind: "unsupported",
      why: "this context exposes no navigator.serviceWorker",
    };
  }
  if (!environment.canRemember) {
    return {
      kind: "unsupported",
      why: "sessionStorage is unavailable, so a reload could not be remembered — and a reload that cannot be remembered is the one that loops",
    };
  }
  if (environment.reloadAttempted) {
    return {
      kind: "gave-up",
      why: "the isolation shim was already registered and reloaded once this session and the page is still not isolated",
    };
  }
  return { kind: "register" };
}

/** One key, one tab session. Named for what it records: the reload was ATTEMPTED. */
const RELOAD_ATTEMPTED_KEY = "loom.cross-origin-isolation.reload-attempted";

/**
 * Reads and writes the flag, and reports whether the store works at all.
 *
 * A `sessionStorage` access THROWS rather than returning null when storage is blocked, so
 * this probe is a write, not a read: a store that reads fine and refuses writes would let
 * the reload through and then forget it.
 */
function probeSessionMemory(): { readonly canRemember: boolean; readonly reloadAttempted: boolean } {
  try {
    const store = globalThis.sessionStorage;
    const attempted = store.getItem(RELOAD_ATTEMPTED_KEY) !== null;
    store.setItem(RELOAD_ATTEMPTED_KEY, attempted ? "1" : "0");
    if (!attempted) store.removeItem(RELOAD_ATTEMPTED_KEY);
    return { canRemember: true, reloadAttempted: attempted };
  } catch {
    return { canRemember: false, reloadAttempted: false };
  }
}

/**
 * Registers `public/coi-sw.js` and reloads once, on the hosted build only.
 *
 * Fire-and-forget from `main.tsx`: nothing downstream waits on it, because on every visit
 * after the first there is nothing to wait FOR — the document already arrived isolated.
 */
export function armCrossOriginIsolation(): void {
  const memory = probeSessionMemory();
  const step = decideIsolationStep({
    isolated: globalThis.crossOriginIsolated === true,
    hosted: import.meta.env.PROD,
    serviceWorkers: "serviceWorker" in navigator,
    canRemember: memory.canRemember,
    reloadAttempted: memory.reloadAttempted,
  });

  switch (step.kind) {
    case "isolated":
    case "not-hosted":
      return;
    case "unsupported":
    case "gave-up":
      // Loud, because the difference is a 4× slowdown that otherwise looks like nothing.
      // The node info popup says the same thing from the worker's own measurement; this
      // line says it at boot, with the reason.
      console.warn(
        `loom: running WITHOUT cross-origin isolation — ${step.why}. ` +
          "SharedArrayBuffer is unavailable, so models run on a single wasm thread.",
      );
      return;
    case "register":
      void registerAndReloadOnce();
      return;
  }
}

async function registerAndReloadOnce(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  try {
    // Scoped to the app's own base, which is `/loom/` on Pages. `navigator.serviceWorker
    // .ready` resolves once the registration has an ACTIVE worker — that worker will
    // control the next navigation into this scope, which is all the reload needs. It is
    // not the same as "controls this page", and deliberately so: waiting for
    // `controllerchange` would hang forever on a browser that never claims.
    await navigator.serviceWorker.register(`${base}coi-sw.js`, { scope: base });
    await navigator.serviceWorker.ready;
  } catch (error) {
    console.warn(
      `loom: the cross-origin isolation shim could not be registered (${String(error)}). ` +
        "Models will run on a single wasm thread.",
    );
    return;
  }

  // WRITE THE FLAG FIRST. This ordering is the whole loop proof: after this line the
  // reload has been recorded whether or not it achieves anything, so the next load takes
  // `gave-up` rather than this branch again.
  try {
    globalThis.sessionStorage.setItem(RELOAD_ATTEMPTED_KEY, "1");
  } catch {
    // The store worked during `probeSessionMemory` and does not now. Refuse the reload
    // rather than fire one nothing can remember.
    return;
  }
  globalThis.location.reload();
}
