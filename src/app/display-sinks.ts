import type { ActiveSink } from "../compiler/types.ts";
import type { PreviewSinkStore } from "./preview-sinks.ts";

/**
 * The DISPLAY sinks that are shown right now (§T1391b): one per open perform window.
 *
 * A Window Out is a declared sink with `sinkRole: "display"`, and the compiler adds it to
 * the active set only when a caller names it — so a Window Out whose window is closed costs
 * nothing (the owner's ruling). This is that caller's half: the perform windows write the
 * ids they show, and the compile reads them beside the preview sinks. Open and close are
 * rare, so each is one recompile; the set is replaced only when it really changed, so a
 * redundant write notifies nobody.
 */
export interface DisplaySinkStore {
  set(nodeIds: readonly string[]): void;
  get(): readonly ActiveSink[];
  subscribe(listener: () => void): () => void;
}

const NONE: readonly ActiveSink[] = [];

export function createDisplaySinkStore(): DisplaySinkStore {
  let sinks = NONE;
  let key = "";
  const listeners = new Set<() => void>();
  return {
    set(nodeIds) {
      const sorted = [...new Set(nodeIds)].sort();
      const next = sorted.join("\u0000");
      if (next === key) return;
      key = next;
      sinks = sorted.length === 0 ? NONE : sorted.map((nodeId) => ({ nodeId, kind: "output" as const }));
      for (const listener of listeners) listener();
    },
    get: () => sinks,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The compile's one sink list: the preview scheduler's kept set followed by the shown
 * display sinks. Same identity until either half changes, which is what the compile memo
 * keys on (`useSyncExternalStore` + `previous.sinks === scheduledPreviews`).
 */
export function mergeSinkStores(preview: PreviewSinkStore, display: Pick<DisplaySinkStore, "get" | "subscribe">): PreviewSinkStore {
  let lastPreview: readonly ActiveSink[] | undefined;
  let lastDisplay: readonly ActiveSink[] | undefined;
  let merged: readonly ActiveSink[] = NONE;
  const get = (): readonly ActiveSink[] => {
    const previews = preview.get();
    const shown = display.get();
    if (previews !== lastPreview || shown !== lastDisplay) {
      lastPreview = previews;
      lastDisplay = shown;
      merged = shown.length === 0 ? previews : [...previews, ...shown];
    }
    return merged;
  };
  return {
    set: (refs, owner) => preview.set(refs, owner),
    get,
    subscribe(listener) {
      const offPreview = preview.subscribe(listener);
      const offDisplay = display.subscribe(listener);
      return () => {
        offPreview();
        offDisplay();
      };
    },
  };
}
