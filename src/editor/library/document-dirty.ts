import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";

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
 * ## Opening replaces the BUS, not the mount — and that used to be got wrong here
 *
 * Opening replaces the whole runtime (see `src/app/project-commands.ts`), and this
 * docblock used to conclude "so a new document arrives with a fresh mount — clean, with
 * nothing to reset". It does not. `setRuntime` swaps a `useState` value inside a component
 * that stays mounted, so this hook keeps running with the SAME `savedAt` while `bus`
 * becomes a different object over a different store.
 *
 * The consequence was measurable and wrong in the obvious direction: every shipped example
 * carries `graph.revision: 1`, so opening one from the library compared 1 against the
 * empty document's 0 and the app claimed unsaved work before the user had touched
 * anything — the next New or Open asked a §V165 question with nothing to lose. Found while
 * wiring the starter network (`src/app/use-starter-project.ts`), which made it fire on
 * every product boot.
 *
 * So the baseline is REKEYED to the bus. A different bus means a different document, and a
 * document nobody has edited since it was opened is clean by definition — which is what
 * the paragraph above always meant, now stated in code rather than in prose. Rebased
 * during render rather than in an effect: an effect would leave one committed render
 * claiming the new document is already dirty, and a confirmation dialog racing a document
 * swap is exactly the wrong thing to be approximate about. See the note on the ref below
 * for why it is a ref and not state adjusted during render — the difference is load-bearing.
 */
export interface DocumentDirty {
  readonly dirty: boolean;
  /** Record the current revision as written. */
  markSaved: () => void;
}

export function useDocumentDirty(bus: LoomBus): DocumentDirty {
  const revision = useSyncExternalStore(
    bus.store.subscribe,
    bus.store.getRevision,
    bus.store.getRevision,
  );
  /**
   * The baseline, rebased on the bus. A REF, and that is not a style choice.
   *
   * The obvious spelling is `useState` adjusted during render, and it is wrong HERE for a
   * reason worth writing down, because it cost a debugging session: a render-phase state
   * update makes React discard the pass and re-run the component, and `useGraphCompile`'s
   * memo writes `lastCompile.current` DURING render. The re-run then classified the second
   * document against itself, `documentBoundary` came back false, and a load stopped
   * clearing temporal history — B106 exactly, reintroduced from four files away
   * (`tests/integration/document-boundary.test.tsx` and `load-history-reset.test.tsx`
   * caught it).
   *
   * A ref assignment costs no extra pass, and it is idempotent: a render that runs twice
   * for any other reason computes the same baseline from the same bus.
   */
  const baseline = useRef({ bus, revision });
  if (baseline.current.bus !== bus) baseline.current = { bus, revision };

  // `markSaved` has to be visible, and a ref alone does not re-render. The counter is
  // only a nudge — `baseline` above is the value everything reads.
  const [, bump] = useState(0);
  const markSaved = useCallback(() => {
    baseline.current = { bus, revision: bus.store.getRevision() };
    bump((count) => count + 1);
  }, [bus]);

  return { dirty: revision > baseline.current.revision, markSaved };
}
