/**
 * On-demand model acquisition (T383, T715, §V147).
 *
 * This is the FIRST `fetch` in `src/`. Nothing in the app has ever downloaded anything at
 * runtime, so every rule here is being set rather than followed, and the one that matters
 * most is the first:
 *
 * ## Placing a node must not spend 94 MB
 *
 * The shipped depth model is `depth-anything-v2-small/model.onnx` — 99,060,839 bytes,
 * chosen deliberately for quality over size. A download that large must never start
 * because someone dropped a node on a canvas to see what it did. So the surface is split:
 * `refresh` only ever READS the cache, and `acquire` is the only thing that opens a
 * connection. Consent lives above this module, in the notice strip, and this module
 * cannot bypass it because it has no path that fetches without being told to.
 *
 * ## Cached per MACHINE, not per project
 *
 * Keyed by model id in one origin-wide store, so the second project that uses depth pays
 * nothing. §T383 also requires the other direction: an `uninstall` and a `list`, because a
 * cache that only grows and cannot be inspected or cleared is a bug with a slow fuse.
 *
 * ## A truncated download is a FAILURE, not a smaller model
 *
 * The descriptor carries the expected byte count and a short read is refused rather than
 * cached. Without that check a dropped connection caches a corrupt file forever and every
 * later run fails somewhere far away, in the runtime, with a parse error that names
 * nothing — §V147's family exactly: plausible, wrong, and expensive to trace back.
 *
 * ## Progress is REAL bytes
 *
 * Read from the stream as it arrives, not interpolated from a timer. When the server
 * declines to send `content-length` the total falls back to the descriptor's expected
 * size, and if that is unknown the state says how much has arrived and does not invent a
 * denominator — a progress bar that guesses is worse than a byte count that does not.
 */

/** One acquirable model. `bytes` is what the pinned revision actually weighs. */
export interface ModelDescriptor {
  readonly id: string;
  readonly label: string;
  /**
   * REVISION-PINNED, never `main` (§V44's spirit applied to a download). A moving
   * reference would let the bytes under a document change without the document changing,
   * which breaks the record/replay gates and makes "same graph, same picture" untrue in a
   * way no test could catch.
   */
  readonly url: string;
  readonly bytes: number;
  readonly license: string;
  /**
   * T1040 — the artefact's SHA-256, lowercase hex, and it is a different promise from the
   * pinned URL beside it.
   *
   * A pinned revision trusts the HOST to keep serving the same bytes under the same name;
   * a hash checks the bytes that actually arrived. The two failures it catches that a byte
   * COUNT cannot: a same-length substitution, and a proxy or captive portal that answers
   * with something else of a plausible size. Optional because the models that shipped
   * before this have no recorded hash — a row without one keeps the length check alone,
   * and says so rather than pretending to be verified.
   */
  readonly sha256?: string;
  /**
   * Execution providers this artefact is MEASURED not to run on, with the refusal verbatim.
   *
   * §T1040's finding, and the reason this is a declaration rather than a comment: RVM's
   * session CREATES successfully on the WebGPU provider and then every `run` throws. The
   * ladder in `inference-worker-core` walks providers by trying to create one, so without
   * this the node would report "WebGPU" — measured, from a real session — and never
   * produce a frame. That is §V672's echo bug arriving through the one door that was
   * supposed to be measurement-proof, so the fact has to travel with the artefact.
   */
  readonly cannotRun?: ReadonlyArray<{ readonly provider: string; readonly reason: string }>;
}

/**
 * Whether an artefact is known not to run on a provider — the reason, or `undefined`.
 *
 * Read at the two places that need it: the ladder (which drops a known-broken rung) and
 * the Backend chooser (which labels a pinned one rather than hiding it, §V831).
 */
export function refusalFor(
  descriptor: Pick<ModelDescriptor, "cannotRun">,
  provider: string,
): string | undefined {
  return descriptor.cannotRun?.find((row) => row.provider === provider)?.reason;
}

/** Lowercase hex SHA-256 of the bytes, via WebCrypto — present in the browser and in Node 22. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AcquisitionState =
  /** The cache has not been consulted yet. Distinct from `absent`, which is an answer. */
  | { readonly kind: "unknown" }
  /** Not held. Nothing has been downloaded and nothing will be until `acquire` is called. */
  | { readonly kind: "absent" }
  | { readonly kind: "downloading"; readonly received: number; readonly total: number | undefined }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Exactly the slice of `fetch` this module uses — a URL and an abort signal.
 *
 * Narrower than `typeof globalThis.fetch` on purpose: the global is overloaded and a test
 * double cannot satisfy the overloads without lying with a cast, and a cast in a fixture
 * is how a fixture stops matching the thing it stands in for. `globalThis.fetch` is
 * assignable to this; so is a three-line fake.
 */
export type ModelFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Origin-wide bytes. Injectable so a test needs no Cache API and no 94 MB. */
export interface ModelStore {
  get(id: string): Promise<ArrayBuffer | undefined>;
  put(id: string, bytes: ArrayBuffer): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<ReadonlyArray<{ readonly id: string; readonly bytes: number }>>;
}

export interface ModelAcquisition {
  stateOf(id: string): AcquisitionState;
  /** Reads the cache. NEVER opens a connection. Safe to call when a node is placed. */
  refresh(descriptor: ModelDescriptor): Promise<AcquisitionState>;
  /** Downloads if absent. Only ever called after the user has agreed to spend the bytes. */
  acquire(descriptor: ModelDescriptor): Promise<ArrayBuffer | undefined>;
  /** Aborts an in-flight download. Nothing partial is kept. */
  cancel(id: string): void;
  uninstall(id: string): Promise<void>;
  list(): Promise<ReadonlyArray<{ readonly id: string; readonly bytes: number }>>;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const mb = value / 1_048_576;
  if (mb < 1) return `${(value / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** "142 MB of 380 MB", or "142 MB" when the total is genuinely unknown. */
export function progressText(received: number, total: number | undefined): string {
  return total === undefined
    ? formatBytes(received)
    : `${formatBytes(received)} of ${formatBytes(total)}`;
}

export function createModelAcquisition(options: {
  readonly store: ModelStore;
  readonly fetch: ModelFetch;
  /** Fired on every transition, including each progress tick. */
  readonly onStateChange?: (id: string, state: AcquisitionState) => void;
}): ModelAcquisition {
  const states = new Map<string, AcquisitionState>();
  const inFlight = new Map<string, Promise<ArrayBuffer | undefined>>();
  const aborts = new Map<string, AbortController>();

  const set = (id: string, state: AcquisitionState): AcquisitionState => {
    states.set(id, state);
    options.onStateChange?.(id, state);
    return state;
  };

  const download = async (descriptor: ModelDescriptor): Promise<ArrayBuffer | undefined> => {
    const { id } = descriptor;
    const controller = new AbortController();
    aborts.set(id, controller);
    try {
      const response = await options.fetch(descriptor.url, { signal: controller.signal });
      if (!response.ok) {
        set(id, { kind: "failed", reason: `the server answered ${response.status} ${response.statusText}` });
        return undefined;
      }

      const header = response.headers.get("content-length");
      const total = header === null ? (descriptor.bytes > 0 ? descriptor.bytes : undefined) : Number(header);
      const body = response.body;

      let bytes: ArrayBuffer;
      if (body === null) {
        // No stream to read (a test double, or a response type without one). Still
        // correct, just without intermediate progress.
        set(id, { kind: "downloading", received: 0, total });
        bytes = await response.arrayBuffer();
      } else {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        set(id, { kind: "downloading", received, total });
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          const chunk = step.value;
          if (chunk === undefined) continue;
          chunks.push(chunk);
          received += chunk.byteLength;
          set(id, { kind: "downloading", received, total });
        }
        const joined = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bytes = joined.buffer;
      }

      // A short read is a FAILURE. Caching it would poison the machine until someone
      // found the uninstall, and the symptom would surface far away in the runtime.
      if (descriptor.bytes > 0 && bytes.byteLength !== descriptor.bytes) {
        set(id, {
          kind: "failed",
          reason:
            `the download ended at ${formatBytes(bytes.byteLength)} but ` +
            `${descriptor.label} is ${formatBytes(descriptor.bytes)} — nothing was cached`,
        });
        return undefined;
      }

      /*
       * T1040 — and the CHECK is the point, not the record. A hash sitting in a table that
       * nothing verifies is documentation; this is the line that makes it a promise. It
       * runs after the length check because a short read has a better message than "the
       * bytes are not what we expected", and it refuses the same way: nothing is cached.
       *
       * A runtime with no WebCrypto (an insecure origin) cannot verify, and that is said
       * out loud rather than passed silently — an unverifiable download is a weaker
       * promise than a verified one and the difference has to be visible.
       */
      if (descriptor.sha256 !== undefined) {
        const digest = await sha256Hex(bytes);
        if (digest === undefined) {
          console.warn(
            `[loom] ${descriptor.label}: no WebCrypto on this origin, so its recorded ` +
              `SHA-256 could not be checked — the byte count matched.`,
          );
        } else if (digest !== descriptor.sha256) {
          set(id, {
            kind: "failed",
            reason:
              `${descriptor.label} downloaded ${formatBytes(bytes.byteLength)} whose ` +
              `SHA-256 is ${digest}, not the recorded ${descriptor.sha256} — nothing was cached`,
          });
          return undefined;
        }
      }

      await options.store.put(id, bytes);
      set(id, { kind: "ready" });
      return bytes;
    } catch (error) {
      // A cancel returns to ABSENT, not failed: the user chose it, and a red row for a
      // deliberate choice is the noise §V537 warns about. Anything else is a real failure
      // and keeps its reason.
      const aborted = error instanceof Error && error.name === "AbortError";
      set(id, aborted ? { kind: "absent" } : { kind: "failed", reason: describe(error) });
      return undefined;
    } finally {
      aborts.delete(id);
      inFlight.delete(id);
    }
  };

  return {
    stateOf(id) {
      return states.get(id) ?? { kind: "unknown" };
    },

    async refresh(descriptor) {
      const held = await options.store.get(descriptor.id);
      if (held !== undefined) return set(descriptor.id, { kind: "ready" });
      /*
       * A cache MISS must never contradict a transfer that is already running.
       *
       * `refresh` is called on every compile (it is free and it is what turns "unknown"
       * into a consent prompt), so an unguarded miss overwrote `downloading` with
       * `absent` between progress events — the notice alternated between "no model" and
       * the progress bar once per frame. The bytes were arriving the whole time; only
       * the story about them flickered. A cache read answers "is it on disk yet", which
       * during a download is always "not yet" and never news.
       */
      const current = states.get(descriptor.id);
      if (current?.kind === "downloading") return current;
      return set(descriptor.id, { kind: "absent" });
    },

    async acquire(descriptor) {
      const held = await options.store.get(descriptor.id);
      if (held !== undefined) {
        set(descriptor.id, { kind: "ready" });
        return held;
      }
      // One download per model, however many nodes ask. Two depth nodes in a document
      // must not open two 94 MB connections — the seam's own `inFlight` discipline.
      const running = inFlight.get(descriptor.id);
      if (running !== undefined) return running;
      const started = download(descriptor);
      inFlight.set(descriptor.id, started);
      return started;
    },

    cancel(id) {
      aborts.get(id)?.abort();
    },

    async uninstall(id) {
      await options.store.delete(id);
      set(id, { kind: "absent" });
    },

    list() {
      return options.store.list();
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
