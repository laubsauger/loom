import {
  readExampleLink,
  withoutExampleLink,
} from "@editor/library/example-link.ts";
import { isolationReloadPending } from "./cross-origin-isolation.ts";

/**
 * THE ADDRESS BAR, for the shareable-example link (T1278).
 *
 * `@editor/library/example-link.ts` is the contract — what a name looks like in a URL and
 * what it resolves to. This is the half that touches the browser: reading the link off
 * THIS load, and taking it back out afterwards so a later refresh does not snap back to a
 * document somebody else chose. It is in `src/app` because it needs the boot's other
 * browser fact — whether the cross-origin-isolation reload is still coming — and nothing
 * under `src/editor` may know about that.
 *
 * Both entry points take the address as a VALUE with an injectable default rather than
 * reaching for `location`/`history` at module scope: the default is evaluated per call, so
 * importing this module does nothing, and a test can drive a whole link lifecycle without
 * navigating jsdom.
 */

/** The two things this needs of a browser: where we are, and how to rewrite it. */
export interface AddressBar {
  readonly href: string;
  readonly search: string;
  /** `history.replaceState` — never `pushState`: consuming a link is not a navigation. */
  replace(href: string): void;
}

function browserAddress(): AddressBar {
  return {
    get href() {
      return globalThis.location.href;
    },
    get search() {
      return globalThis.location.search;
    },
    replace(href: string) {
      globalThis.history.replaceState(globalThis.history.state, "", href);
    },
  };
}

/**
 * The example this load was linked to, by name, or null.
 *
 * Read ONCE at mount by the composition root and frozen, for the same reason
 * `last-opened.ts` is: the app rewrites its own address as part of consuming the link, and
 * a live read would let the boot answer its own question.
 */
export function currentExampleLink(address: AddressBar = browserAddress()): string | null {
  return readExampleLink(address.search);
}

/**
 * Takes the link back out of the address bar. Reports whether it actually did.
 *
 * Called once the boot has TAKEN RESPONSIBILITY for the link — opened it, refused it as
 * unknown, or put the confirmation in front of the user — rather than once the document is
 * on screen. A refresh is then a plain refresh: the normal ladder (autosave, where they
 * were, the starter) answers it, and nobody is stuck reopening somebody else's example
 * every time they reload.
 *
 * Except while the hosted build's one-time isolation reload is still pending (T1048), when
 * it declines and says so — see `isolationReloadPending`. That reload preserves the query,
 * so leaving the link in place is precisely what lets it survive; the load after the reload
 * finds it again and strips it then.
 */
export function consumeExampleLink(
  address: AddressBar = browserAddress(),
  reloadPending: () => boolean = isolationReloadPending,
): boolean {
  if (reloadPending()) return false;
  const stripped = withoutExampleLink(address.href);
  if (stripped === null) return false;
  address.replace(stripped);
  return true;
}
