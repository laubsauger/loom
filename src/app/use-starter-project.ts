import { useEffect, useRef } from "react";
import { listExampleProjects } from "@editor/library/index.ts";
import type { ExampleProject } from "@editor/library/example-catalogue.ts";
import { resolveExampleLink } from "@editor/library/example-link.ts";
import { STARTER_EXAMPLE_FILE } from "./starter-document.ts";
import type { LastOpened } from "./last-opened.ts";

/**
 * THE STARTER NETWORK — something on screen on a boot that has nothing to restore.
 *
 * The owner's ask, in TouchDesigner's idiom: a brand-new user should land on a tiny
 * network that is already moving and already has a slider worth dragging, not on an empty
 * canvas that gives them nothing to react to. With one hard condition attached, which is
 * most of what this module is:
 *
 *   **AN EXISTING AUTOSAVE ALWAYS WINS.** The starter is what happens when there is
 *   nothing to restore. It is never what happens instead of restoring.
 *
 * …and a second one since T1164, which is the first one's blind spot rather than an
 * exception to it:
 *
 *   **AND SO DOES WHERE THE USER WAS.** Opening an example and not editing it commits
 *   nothing — that is this module's own design, three paragraphs down — so the next boot
 *   found no autosave and helpfully replaced the user's chosen document with the starter.
 *   Every rule fired as written and the result was wrong, because the rules model EDITED
 *   WORK and the missing concept was DELIBERATE INTENT. `last-opened.ts` holds that
 *   concept as a POINTER (a file name and a kind, never bytes), so it cannot become the
 *   user's work the way an autosave-on-open would; this module asks it after the autosave
 *   and before the starter.
 *
 * …and one thing that outranks both, since T1278, because it is not from this browser at
 * all:
 *
 *   **A SHAREABLE LINK BEATS THE AUTOSAVE — BUT ASKS WHEN THERE IS WORK TO LOSE.**
 *   `?example=E11-Gradient-Remap` is somebody else's explicit request, clicked a second
 *   ago; the two rules above rank this browser's own history, and the most explicit signal
 *   the app can receive may not lose to the most implicit one. It costs nothing, because
 *   the autosave is OFFERED and not consumed — the restore notice returns over the linked
 *   example — and unsaved work on the canvas still confirms first (§V93). Rule zero in
 *   the effect carries the whole argument; the contract is `example-link.ts`.
 *
 * ## The trap, stated, because it is the whole design
 *
 * A starter that loads and then autosaves BECOMES the user's document. On the next boot
 * it is restored as "their" work, which means (a) the preference below silently stops
 * doing anything, because an autosave now exists on every boot forever, and (b) the
 * restore prompt starts offering people a file they never authored. Worse, a starter that
 * loads over an autosave that already exists destroys real work.
 *
 * Two ways out were on the table: mark the loaded starter as pristine so a later boot can
 * tell it apart, or keep it out of the snapshot ring until the user actually edits it.
 * This takes the second, and not because it is easier — because it is the one the app
 * already enforces STRUCTURALLY rather than by remembering to:
 *
 *   - `GraphStore` takes its graph at CONSTRUCTION (`createAppRuntime({ document })`), so
 *     opening the starter commits nothing;
 *   - `useAutosave` writes only from `store.subscribe` → `notifyChange`, i.e. only from a
 *     committed mutation (§V33).
 *
 * So a starter nobody touches produces no snapshot, and there is no flag anywhere that
 * could be set wrong. A pristine MARKER would have needed a second piece of persisted
 * state whose only job is to describe the first, and a stale one reads as "this is a
 * starter" over a document somebody spent an evening on. `starter-boot.test.tsx` is the
 * gate that keeps the structural property true: it fails if a starter boot ever puts a
 * byte in the snapshot store.
 *
 * The moment the user DOES edit it, the ordinary path takes over and the edited starter
 * is their document, autosaved like anything else. That is why the project id is
 * restamped below.
 *
 * ## Which document, and the bar it had to clear
 *
 * E6 Displacement Stack — six nodes: a checkerboard, a 4D noise field shaped and placed
 * through Level and Transform, a Displace, an Output. It is the owner's own suggestion,
 * it MOVES on frame one (the plate melts, the field turns at 4°/s), and every visible
 * effect has an obvious slider behind it (`warp.weight`, `field.speed`, `plate.size`).
 *
 * The bar that mattered more than the choice: **a first boot may not open a permission
 * dialog or start a download.** Nothing in this graph reaches a camera, a microphone, an
 * audio device or an inference model, and the bytes are already in the app chunk —
 * `example-catalogue.ts` inlines every `examples/*.loom.json` at build time — so opening
 * it costs no request. A `webcam`, `audioFileIn`, `depth` or `inference` node here would
 * have made a new user's first experience a browser prompt, which is the opposite of the
 * point.
 */

export { STARTER_EXAMPLE_FILE };

export interface StarterDocument {
  /** `.loom.json` bytes, ready for `project.open`. */
  readonly text: string;
  /** The example row it came from, for a diagnostic that has to name it. */
  readonly example: ExampleProject;
}

/**
 * The starter's bytes, with the project id RESTAMPED to this browser's own.
 *
 * A shipped example carries its own `projectId` (`example-displacement-stack`), and
 * autosave keys the snapshot ring by project id while the launch lookup asks for the
 * browser-local one (`shaderloom.project.id.v1`). Left alone, edits to the starter would
 * be autosaved into a slot no boot ever looks in: the user drags a slider for ten
 * minutes, reloads, and gets the pristine starter back with no offer to restore anything.
 * Restamping puts the starter in the SAME slot every other document uses, which is what
 * makes "the moment you edit it, it is your document" true rather than a claim.
 *
 * Deliberately only the id. The name rides through, so the top bar and a first save say
 * where this graph came from instead of pretending the user authored it.
 *
 * Returns null rather than throwing when the file is missing or unparseable: a starter is
 * a courtesy, and the honest failure is an empty canvas, not a broken boot. A malformed
 * shipped file is `sync.test.ts`'s finding, not this module's.
 */
export function starterProjectText(
  projectId: string,
  catalogue?: readonly ExampleProject[],
): StarterDocument | null {
  return exampleProjectText(STARTER_EXAMPLE_FILE, projectId, catalogue);
}

/**
 * ANY shipped example, restamped the same way (T1164).
 *
 * `starterProjectText` is this with the starter's file name filled in, rather than the
 * other way round: the restamping argument above is about opening a SHIPPED example into
 * this browser's autosave slot, and it applies word for word to the example the boot
 * decision reopens because it is where the user was. Two copies of it would be two places
 * to get the project id wrong.
 */
export function exampleProjectText(
  fileName: string,
  projectId: string,
  catalogue?: readonly ExampleProject[],
): StarterDocument | null {
  const example = (catalogue ?? listExampleProjects()).find(
    (entry) => entry.fileName === fileName,
  );
  if (example === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(example.text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return { text: JSON.stringify({ ...parsed, projectId }), example };
  } catch {
    return null;
  }
}

/**
 * WHAT THE BOOT DID ABOUT A SHAREABLE LINK (T1278).
 *
 * Reported rather than handled here because three of the four outcomes need a surface —
 * an error somebody can read, or a question somebody can answer — and this module is a
 * decision over facts, with no opinion about how the app talks. The composition root
 * turns each one into a notice and strips the link from the address bar.
 */
export type ExampleLinkOutcome =
  /** Opened. Nothing to say: the document on screen is the whole message. */
  | { readonly kind: "opened"; readonly example: ExampleProject }
  /**
   * There is unsaved work here, so the link ASKS (§V93) — the same rule the example
   * library applies to a click, which the boot path had no equivalent of before T1278.
   * `text` is the restamped document, already resolved, so the answer is one call.
   */
  | { readonly kind: "confirm"; readonly example: ExampleProject; readonly text: string }
  /** No such example ships here. NOTHING was opened — see the ladder below. */
  | { readonly kind: "unknown"; readonly requested: string }
  /** It ships and it did not parse. `sync.test.ts`'s finding, said out loud meanwhile. */
  | { readonly kind: "unreadable"; readonly example: ExampleProject };

export interface StarterProjectOptions {
  /**
   * The app BUILT its own runtime, i.e. this is the product boot (`<App />` in
   * `main.tsx`) and not a caller that handed one in.
   *
   * A caller that constructs the runtime has already decided what document is open —
   * a test's fixture graph, a headless host, an embedder. Replacing it with a starter
   * would be this module overruling the one place that actually knows. `main.tsx` is
   * the only bare `<App />` in the tree; everything else supplies a runtime, so this is
   * the difference between "nobody chose a document yet" and "somebody did".
   */
  readonly selfBooted: boolean;
  /**
   * The document open right now is still the one the app booted with.
   *
   * The launch lookup takes an IndexedDB round trip, and the app is fully usable while it
   * is in flight: a spec — or a fast person — can open an example from the library inside
   * that window. Opening REPLACES the runtime, which re-runs the autosave effect and
   * re-answers the lookup for the new project id, and without this the starter would then
   * land on top of the document they just chose. Found by `e2e/node-box.spec.ts`, which
   * navigates and opens an example in the same breath.
   *
   * `isDirty` does not cover it: an opened document is not modified.
   */
  readonly atBootDocument: boolean;
  /**
   * A save or an open is RUNNING right now (`useProject().busy`).
   *
   * `atBootDocument` catches an open that has already landed; this catches one that has
   * not. Both halves are needed and the gap between them is where the bug lived: clicking
   * an example calls `project.open`, which sets `busy` at once but only calls
   * `setRuntime` after the parse, so there is a real window in which the document has been
   * chosen and `documentIdentity` still says otherwise. `e2e/node-box.spec.ts` navigates
   * and clicks an example inside that window every run, and the starter was landing on top
   * of the example — six nodes on screen where the spec wanted nine.
   */
  readonly openInFlight: boolean;
  /**
   * The persisted preference (`starterPreferenceStore`) — "start on a starter network
   * rather than an empty canvas".
   *
   * T1164: this gates THE STARTER and nothing else. Reopening the example the user was
   * last on is not the starter — it is where they were — and someone who switched off
   * "start me on a demo" has said nothing about whether a refresh should throw their
   * document away.
   */
  readonly enabled: boolean;
  /** `AutosaveWiring.restoreChecked` — the launch lookup has ANSWERED. */
  readonly restoreChecked: boolean;
  /**
   * True when that answer was "there is a snapshot". An autosave beats everything this
   * browser could decide on its own — and, since T1278, loses to one thing it could not:
   * a link somebody sent. See rule zero.
   */
  readonly hasRestore: boolean;
  /** The store's revision has moved: somebody is already working here. */
  readonly isDirty: () => boolean;
  /**
   * WHAT THIS BROWSER LAST OPENED ON PURPOSE (T1164, `last-opened.ts`).
   *
   * Read as a value rather than as a store so this stays a pure decision over facts —
   * the same shape `hasRestore` and `isDirty` already have. It is consulted only after
   * every guard above has passed, so it can never overrule an autosave, an open in
   * flight, or work already on the canvas.
   */
  readonly lastOpened: LastOpened;
  /**
   * THE EXAMPLE THIS LOAD WAS LINKED TO, by name, frozen at mount (T1278).
   *
   * `?example=E11-Gradient-Remap`, read by `example-link-boot.ts`. Null on every ordinary
   * boot, which is why the ladder below is otherwise untouched. It is a NAME and not a
   * resolved row on purpose: an unknown name is one of the outcomes this has to report,
   * so resolving it early would throw away the thing the report is about.
   */
  readonly exampleLink: string | null;
  /** Where an `exampleLink` decision goes. Required whenever a link can arrive. */
  readonly onExampleLink?: ((outcome: ExampleLinkOutcome) => void) | undefined;
  /** The project id the starter is restamped with — the runtime's own. */
  readonly projectId: string;
  /** `useProject().openText`, i.e. `project.open` on the bus (§V29). */
  readonly openText: (text: string) => void;
  /** Test seam. Defaults to the shipped catalogue. */
  readonly catalogue?: readonly ExampleProject[];
}

/**
 * Decides ONCE per session whether to open the starter.
 *
 * "Once" is a ref, not a per-runtime effect, and that is load-bearing: opening the starter
 * REPLACES the runtime, which re-runs the autosave effect and re-answers the launch
 * lookup, so a per-runtime decision would open the starter over and over. It is also what
 * makes File → New stick — a user who explicitly asked for an empty canvas gets one, and
 * does not have a starter reinstalled underneath them a moment later.
 *
 * The decision is recorded before the guards, so "no, because there is a snapshot" is as
 * final as "yes". Nothing here re-opens the question later in the session.
 */
export function useStarterProject(options: StarterProjectOptions): void {
  const {
    selfBooted,
    atBootDocument,
    openInFlight,
    enabled,
    restoreChecked,
    hasRestore,
    isDirty,
    lastOpened,
    exampleLink,
    onExampleLink,
    projectId,
    openText,
    catalogue,
  } = options;

  // Read the volatile halves through a ref so the effect fires on the ANSWER landing and
  // not on a preference toggle or a re-render, and so it reads what is true at that
  // moment rather than at registration.
  const latest = useRef({
    selfBooted,
    atBootDocument,
    openInFlight,
    enabled,
    hasRestore,
    isDirty,
    lastOpened,
    exampleLink,
    onExampleLink,
    projectId,
    openText,
    catalogue,
  });
  latest.current = {
    selfBooted,
    atBootDocument,
    openInFlight,
    enabled,
    hasRestore,
    isDirty,
    lastOpened,
    exampleLink,
    onExampleLink,
    projectId,
    openText,
    catalogue,
  };

  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    // Still in flight, or the lookup failed and cannot say. Either way, not an answer.
    if (!restoreChecked) return;
    decided.current = true;

    const current = latest.current;
    if (!current.selfBooted) return;
    // Somebody already opened something in the window the lookup was in flight — landed,
    // or still running. Nothing below may land on a document a person chose by hand,
    // a link included: they are HERE, and the link is not what they just did.
    if (!current.atBootDocument) return;
    if (current.openInFlight) return;

    /**
     * RULE ZERO (T1278) — A LINK BEATS EVERYTHING BELOW IT, INCLUDING THE AUTOSAVE.
     *
     * Every other rule in this module ranks THIS BROWSER'S own history: an autosave, then
     * where this person was, then the starter. A link is not from this browser at all —
     * somebody sent it, and the recipient clicked it a second ago. Ranking it under an
     * autosave would mean the most explicit request the app can receive loses to the most
     * implicit one, and the person who was sent a link gets whatever they happened to have
     * open instead, with no sign a link was involved.
     *
     * NOTHING IS LOST BY THAT, and the ordering only holds because of it:
     *
     *  - the autosave is OFFERED, not consumed — `findRestoreCandidate` runs again for the
     *    new runtime, so the restore notice comes straight back over the linked example
     *    and the snapshot ring is untouched (`example-link-boot.test.tsx` asserts both);
     *  - the link opens into a FRESH document (`exampleProjectText` restamps the project
     *    id), so following one commits nothing until the recipient edits it;
     *  - and unsaved work on THIS canvas still asks first, which is §V93 — the rule the
     *    library's `choose()` already applies to a click and the boot path had no
     *    equivalent of. `isDirty` is asked below in exactly the same words.
     *
     * An UNKNOWN name returns rather than falling through. Falling through would boot the
     * starter, i.e. hand the recipient a plausible document and no reason to doubt it was
     * the one they were sent — the failure mode this whole row exists to refuse.
     */
    if (current.exampleLink !== null) {
      const catalogue = current.catalogue ?? listExampleProjects();
      const resolution = resolveExampleLink(current.exampleLink, catalogue);
      if (resolution.kind === "unknown") {
        current.onExampleLink?.({ kind: "unknown", requested: resolution.requested });
        return;
      }
      const linked = exampleProjectText(
        resolution.example.fileName,
        current.projectId,
        catalogue,
      );
      if (linked === null) {
        current.onExampleLink?.({ kind: "unreadable", example: resolution.example });
        return;
      }
      if (current.isDirty()) {
        current.onExampleLink?.({ kind: "confirm", example: resolution.example, text: linked.text });
        return;
      }
      current.openText(linked.text);
      current.onExampleLink?.({ kind: "opened", example: resolution.example });
      return;
    }

    // RULE ONE. Restoring the user's work is not something a preference may override.
    if (current.hasRestore) return;
    // The lookup takes an IndexedDB round trip; a fast user can have dropped a node onto
    // the empty canvas before it lands, and that is work too.
    if (current.isDirty()) return;

    /**
     * RULE TWO (T1164) — WHERE THEY WERE BEATS THE STARTER, and it is asked here, after
     * every guard above and before the starter is even considered.
     *
     * `other` is an answer, not a gap: the user opened a file from disk, or asked for an
     * empty canvas. Neither can be reproduced from a pointer, and the honest reply to a
     * refresh is the empty canvas rather than a document they never chose — which is the
     * complaint this row is about, with the starter cast as the intruder.
     *
     * An example that is no longer shipped falls THROUGH to the starter rather than
     * returning: the pointer has gone stale, so there is genuinely nothing to return to,
     * and the starter is what a boot with nothing to restore is for.
     */
    if (current.lastOpened.kind === "other") return;
    if (current.lastOpened.kind === "example") {
      const previous = exampleProjectText(
        current.lastOpened.fileName,
        current.projectId,
        current.catalogue,
      );
      if (previous !== null) {
        current.openText(previous.text);
        return;
      }
    }

    // Nothing was ever opened here, so this is the first visit the starter exists for.
    // The preference is asked HERE and nowhere earlier: it is a preference about the
    // starter, not about whether a refresh may discard a document (see `enabled`).
    if (!current.enabled) return;
    const starter = starterProjectText(current.projectId, current.catalogue);
    if (starter === null) return;
    current.openText(starter.text);
  }, [restoreChecked]);
}
