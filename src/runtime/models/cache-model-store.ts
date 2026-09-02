import type { ModelStore } from "./model-acquisition.ts";

/**
 * The browser's own HTTP cache, used as the model store (T383).
 *
 * The Cache API rather than IndexedDB or OPFS, for one reason that decides it: these ARE
 * cached HTTP responses, so the store that is built for them handles a 94 MB body without
 * being talked into it, survives reloads, and is scoped per ORIGIN — which is what makes
 * the download once per machine rather than once per project.
 *
 * It is unavailable in a non-secure context and in some private modes, and that is a
 * NORMAL outcome rather than an exception: `cacheModelStore` returns `null` and the caller
 * shows a node that cannot acquire, in the same shape as a denied camera. What it must
 * never do is throw during composition.
 */

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
const CACHE_NAME = "shaderloom-models-v1";

export function cacheModelStore(): ModelStore | null {
  const caches = (globalThis as { caches?: CacheStorage }).caches;
  if (caches === undefined) return null;

  const open = () => caches.open(CACHE_NAME);
  // §V813: a storage ADDRESS, not a name — kept through the Loom rename (§T899) so no user state is orphaned.
  const keyOf = (id: string) => `https://models.shaderloom.invalid/${encodeURIComponent(id)}`;

  return {
    async get(id) {
      const cache = await open();
      const hit = await cache.match(keyOf(id));
      return hit === undefined ? undefined : await hit.arrayBuffer();
    },
    async put(id, bytes) {
      const cache = await open();
      await cache.put(
        keyOf(id),
        new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes.byteLength),
          },
        }),
      );
    },
    async delete(id) {
      const cache = await open();
      await cache.delete(keyOf(id));
    },
    async list() {
      const cache = await open();
      const keys = await cache.keys();
      const rows: Array<{ id: string; bytes: number }> = [];
      for (const request of keys) {
        const hit = await cache.match(request);
        // The stored `content-length`, so listing what is held does not read 94 MB back
        // into memory just to measure it.
        const length = hit?.headers.get("content-length");
        const id = decodeURIComponent(request.url.split("/").pop() ?? "");
        if (id.length > 0) rows.push({ id, bytes: length === null || length === undefined ? 0 : Number(length) });
      }
      return rows;
    },
  };
}
