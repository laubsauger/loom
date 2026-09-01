import { describe, expect, it, vi } from "vitest";
import {
  createModelAcquisition,
  formatBytes,
  progressText,
  type ModelDescriptor,
  type ModelStore,
} from "./model-acquisition.ts";

/**
 * Model acquisition (T383, T715).
 *
 * The shipped model is 99,060,839 bytes. Every test here is about not spending them by
 * accident, not half-spending them, and not spending them twice.
 */

const DEPTH: ModelDescriptor = {
  id: "depth-anything-v2-small",
  label: "Depth Anything V2 Small",
  url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b736/onnx/model.onnx",
  bytes: 8,
  license: "Apache-2.0",
};

function memoryStore(): ModelStore & { readonly held: Map<string, ArrayBuffer> } {
  const held = new Map<string, ArrayBuffer>();
  return {
    held,
    async get(id) {
      return held.get(id);
    },
    async put(id, bytes) {
      held.set(id, bytes);
    },
    async delete(id) {
      held.delete(id);
    },
    async list() {
      return [...held.entries()].map(([id, bytes]) => ({ id, bytes: bytes.byteLength }));
    },
  };
}

/** A fetch that streams `chunks` and honours an abort signal. */
function streamingFetch(chunks: number[][], init: { status?: number; contentLength?: string | null } = {}) {
  return vi.fn(async (_url: string, request: { readonly signal: AbortSignal }) => {
    const signal = request.signal;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted === true) {
          const error = new Error("aborted");
          error.name = "AbortError";
          controller.error(error);
          return;
        }
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunks[index++]!));
      },
    });
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      statusText: init.status === 404 ? "Not Found" : "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length"
            ? init.contentLength === undefined
              ? String(total)
              : init.contentLength
            : null,
      },
      body,
      arrayBuffer: async () => new Uint8Array(chunks.flat()).buffer,
    } as unknown as Response;
  });
}

describe("placing a node must not spend the bytes", () => {
  /**
   * THE one that matters. 94 MB must never leave because someone dropped a node on a
   * canvas to see what it did. `refresh` is the only call a node placement makes, and it
   * has no path to the network at all.
   */
  it("refresh reads the cache and never opens a connection", async () => {
    const fetchSpy = streamingFetch([[1, 2, 3, 4, 5, 6, 7, 8]]);
    const acquisition = createModelAcquisition({ store: memoryStore(), fetch: fetchSpy });

    const state = await acquisition.refresh(DEPTH);

    expect(state).toEqual({ kind: "absent" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports ready from the cache without a connection", async () => {
    const store = memoryStore();
    await store.put(DEPTH.id, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
    const fetchSpy = streamingFetch([[1]]);
    const acquisition = createModelAcquisition({ store, fetch: fetchSpy });

    expect(await acquisition.refresh(DEPTH)).toEqual({ kind: "ready" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("starts as unknown, which is not the same answer as absent", () => {
    // "Not checked yet" and "checked, not there" must not collapse: the first shows no
    // consent prompt, the second does.
    const acquisition = createModelAcquisition({ store: memoryStore(), fetch: streamingFetch([[1]]) });
    expect(acquisition.stateOf(DEPTH.id)).toEqual({ kind: "unknown" });
  });
});

describe("progress is real bytes", () => {
  it("reports each chunk as it arrives, ending at the true total", async () => {
    const seen: Array<{ received: number; total: number | undefined }> = [];
    const acquisition = createModelAcquisition({
      store: memoryStore(),
      fetch: streamingFetch([[1, 2, 3], [4, 5, 6], [7, 8]]),
      onStateChange: (_id, state) => {
        if (state.kind === "downloading") seen.push({ received: state.received, total: state.total });
      },
    });

    await acquisition.acquire(DEPTH);

    expect(seen.map((s) => s.received)).toEqual([0, 3, 6, 8]);
    expect(seen.every((s) => s.total === 8)).toBe(true);
  });

  it("does not invent a denominator when the server sends no length and none is known", async () => {
    // A progress bar that guesses is worse than a byte count that does not.
    const seen: Array<number | undefined> = [];
    const acquisition = createModelAcquisition({
      store: memoryStore(),
      fetch: streamingFetch([[1, 2]], { contentLength: null }),
      onStateChange: (_id, state) => {
        if (state.kind === "downloading") seen.push(state.total);
      },
    });

    await acquisition.acquire({ ...DEPTH, bytes: 0 });

    expect(seen.every((total) => total === undefined)).toBe(true);
    expect(progressText(142_000_000, undefined)).toBe("135 MB");
    expect(progressText(142_000_000, 380_000_000)).toBe("135 MB of 362 MB");
  });
});

describe("the bytes are spent once", () => {
  it("serves a second project from the cache without downloading again", async () => {
    const store = memoryStore();
    const fetchSpy = streamingFetch([[1, 2, 3, 4, 5, 6, 7, 8]]);
    const acquisition = createModelAcquisition({ store, fetch: fetchSpy });

    await acquisition.acquire(DEPTH);
    await acquisition.acquire(DEPTH);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("opens ONE connection when two nodes ask at the same moment", async () => {
    // Two depth nodes in one document must not open two 94 MB connections.
    const fetchSpy = streamingFetch([[1, 2, 3, 4, 5, 6, 7, 8]]);
    const acquisition = createModelAcquisition({ store: memoryStore(), fetch: fetchSpy });

    const [a, b] = await Promise.all([acquisition.acquire(DEPTH), acquisition.acquire(DEPTH)]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a?.byteLength).toBe(8);
    expect(b?.byteLength).toBe(8);
  });
});

describe("a broken download is refused, never cached", () => {
  /**
   * §V147's family. Caching a short read poisons the machine until someone finds the
   * uninstall, and the symptom surfaces far away in the runtime as a parse error that
   * names nothing.
   */
  it("refuses a truncated file and caches nothing", async () => {
    const store = memoryStore();
    const acquisition = createModelAcquisition({
      store,
      fetch: streamingFetch([[1, 2, 3]], { contentLength: "8" }),
    });

    const result = await acquisition.acquire(DEPTH);

    expect(result).toBeUndefined();
    expect(store.held.size).toBe(0);
    const state = acquisition.stateOf(DEPTH.id);
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.reason).toContain("nothing was cached");
  });

  it("names the status when the server refuses", async () => {
    const acquisition = createModelAcquisition({
      store: memoryStore(),
      fetch: streamingFetch([[]], { status: 404 }),
    });

    await acquisition.acquire(DEPTH);

    const state = acquisition.stateOf(DEPTH.id);
    expect(state.kind === "failed" && state.reason).toContain("404");
  });
});

describe("the user stays in control of the bytes", () => {
  it("cancel stops the download, keeps nothing, and is not an error", async () => {
    const store = memoryStore();
    const acquisition = createModelAcquisition({
      store,
      fetch: streamingFetch([[1, 2], [3, 4], [5, 6], [7, 8]]),
      onStateChange: (id, state) => {
        if (state.kind === "downloading" && state.received >= 2) acquisition.cancel(id);
      },
    });

    await acquisition.acquire(DEPTH);

    expect(store.held.size).toBe(0);
    // A deliberate cancel returns to ABSENT, not failed: a red row for a choice the user
    // made is exactly the noise that teaches people to ignore the strip.
    expect(acquisition.stateOf(DEPTH.id)).toEqual({ kind: "absent" });
  });

  it("uninstall frees the space and the next acquire downloads again", async () => {
    // §T383: a cache that only grows and cannot be cleared is a bug with a slow fuse.
    const store = memoryStore();
    const fetchSpy = streamingFetch([[1, 2, 3, 4, 5, 6, 7, 8]]);
    const acquisition = createModelAcquisition({ store, fetch: fetchSpy });

    await acquisition.acquire(DEPTH);
    expect(await acquisition.list()).toEqual([{ id: DEPTH.id, bytes: 8 }]);

    await acquisition.uninstall(DEPTH.id);

    expect(await acquisition.list()).toEqual([]);
    expect(acquisition.stateOf(DEPTH.id)).toEqual({ kind: "absent" });
    await acquisition.acquire(DEPTH);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("byte formatting is honest at the sizes we actually ship", () => {
  it("reads the shipped model's real size the way a person would", () => {
    // Whole numbers once it is big enough to read as one — "142 MB of 380 MB" is what a
    // progress line wants, not "142.4 MB of 380.2 MB". One decimal survives below 10 MB,
    // where the difference between 5.2 and 5 is the difference between two models.
    expect(formatBytes(99_060_839)).toBe("94 MB");
    expect(formatBytes(19_126_267)).toBe("18 MB");
    expect(formatBytes(5_420_454)).toBe("5.2 MB");
    expect(formatBytes(1023)).toBe("1023 B");
  });
});
