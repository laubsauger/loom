import { useCallback, useState, useSyncExternalStore } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";

/**
 * "Has this document changed since it was last written?" (T189, §V93).
 *
 * §V93 makes OPEN the one library verb that needs a confirmation, and a confirmation
 * needs something true to ask about. Nothing in the app tracked that yet, so this is it,
 * and it is deliberately the smallest true thing: the store's revision only moves when a
 * mutation commits (§V33), so a revision above the last written one IS unsaved work.
 *
 * `markSaved` is the other half — the composition root calls it after `project.save`
 * succeeds. Without that call the hook still errs toward asking, which is the safe
 * direction: an extra confirmation costs a keystroke, a skipped one costs the session.
 *
 * Opening replaces the whole runtime (see `src/app/project-commands.ts`), so a new
 * document arrives with a new store and a fresh mount — clean, with nothing to reset.
 */
export interface DocumentDirty {
  readonly dirty: boolean;
  /** Record the current revision as written. */
  markSaved: () => void;
}

export function useDocumentDirty(bus: ShaderloomBus): DocumentDirty {
  const revision = useSyncExternalStore(
    bus.store.subscribe,
    bus.store.getRevision,
    bus.store.getRevision,
  );
  const [savedAt, setSavedAt] = useState(() => bus.store.getRevision());

  const markSaved = useCallback(() => {
    setSavedAt(bus.store.getRevision());
  }, [bus]);

  return { dirty: revision > savedAt, markSaved };
}
