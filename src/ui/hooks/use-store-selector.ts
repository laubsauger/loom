import { useRef, useSyncExternalStore } from "react";
import type { Subscribe } from "./use-visible-subscribe.ts";

/**
 * `useSyncExternalStore` with a selector and an equality (T1239, §V939).
 *
 * React re-renders a subscriber when `getSnapshot()` returns something new by `Object.is`.
 * The telemetry hub rebuilds its snapshot object on every tick, so a component that reads
 * the whole snapshot re-renders on every tick even when the one number it shows did not
 * move. This hook keys the re-render on what the component READS: the selection is
 * recomputed only for a new snapshot, and the previous selection is returned while
 * `isEqual` says nothing changed — so React sees the same reference and skips the render.
 *
 * (`use-sync-external-store/with-selector` does the same; it is not a dependency here.)
 */
export function useStoreSelector<S, T>(
  subscribe: Subscribe,
  getSnapshot: () => S,
  select: (snapshot: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ snapshot: S; select: (snapshot: S) => T; selected: T } | null>(null);
  const getSelected = (): T => {
    const snapshot = getSnapshot();
    const previous = cache.current;
    if (previous !== null && previous.snapshot === snapshot && previous.select === select) {
      return previous.selected;
    }
    const selected = select(snapshot);
    const kept = previous !== null && isEqual(previous.selected, selected) ? previous.selected : selected;
    cache.current = { snapshot, select, selected: kept };
    return kept;
  };
  return useSyncExternalStore(subscribe, getSelected, getSelected);
}
