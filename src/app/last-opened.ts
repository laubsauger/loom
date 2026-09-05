/**
 * WHAT THIS BROWSER LAST OPENED ON PURPOSE — a pointer, never a snapshot (T1164, §T1123).
 *
 * ## The report this exists to answer
 *
 * The owner: *"the example that we're loading by default now, which is actually kinda
 * weird — because if I just loaded another thing and then refresh, I wouldn't want to end
 * up here."* And every rule §T1123 wrote fired exactly as designed to produce that:
 * opening an example and not editing it commits nothing (`GraphStore` takes its graph at
 * CONSTRUCTION, and `useAutosave` writes only from a committed mutation, §V33), so the
 * next boot correctly finds no autosave and correctly loads the starter. The rules model
 * EDITED WORK. The missing concept is DELIBERATE INTENT — opening something is an explicit
 * act, and a refresh should not discard it.
 *
 * ## Why this is not "autosave on open", which is the obvious fix and the wrong one
 *
 * §T1123 refused that deliberately and its reasoning still holds: a document that is
 * autosaved because it was OPENED becomes the user's work without them doing anything. The
 * next boot restores it as theirs, the starter preference silently stops meaning anything
 * (an autosave now exists on every boot forever), and the restore prompt starts offering
 * people files they never authored. A "this is only a starter" marker over an evening's
 * work is worse than the bug.
 *
 * So what is stored here is a NAME AND A KIND, and no document bytes at all:
 *
 *   - it cannot become the user's work, because it is not work;
 *   - it cannot go stale over an edit, because an edit produces an autosave and
 *     `useStarterProject` reads that FIRST — an existing autosave still always wins;
 *   - the worst a corrupt or outdated entry can do is name an example that is no longer
 *     shipped, which falls back to the starter.
 *
 * ## The three answers, and why "other" is one of them
 *
 * A shipped example can be reopened: its bytes are in the app chunk. A document opened
 * from disk cannot — this holds no bytes, and asking for the file again would be a
 * permission prompt on a boot. That case is still recorded, as `other`, because the honest
 * boot for it is an EMPTY CANVAS rather than the starter: the user opened something on
 * purpose, and answering a refresh with a document they did not choose is the whole of the
 * complaint above. File → New records the same thing for the same reason — it is a request
 * for an empty canvas, and §T1123 already made it stick for the rest of the session.
 *
 * Absent means absent: this browser has never opened anything, which is the genuinely
 * first visit the starter was built for.
 */

export type LastOpened =
  /** Nothing has ever been opened here — a first visit, and the starter's whole case. */
  | { readonly kind: "never" }
  /** A shipped example, by file name. Reopenable, because its bytes ship with the app. */
  | { readonly kind: "example"; readonly fileName: string }
  /** Something deliberate this cannot reproduce: a file from disk, or File → New. */
  | { readonly kind: "other" };

export const NEVER_OPENED: LastOpened = { kind: "never" };

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
export const LAST_OPENED_STORAGE_KEY = "shaderloom.project.lastOpened.v1";

/**
 * The stored form of `other`.
 *
 * A sentinel rather than a second key, and it cannot collide with the other branch: every
 * shipped example is named `<something>.loom.json`, which is also the check that reads a
 * corrupt entry back as `other` rather than as an example nobody can find.
 */
const OTHER = "-";

/** The suffix every shipped example carries — the whole of "is this stored name openable". */
const EXAMPLE_SUFFIX = ".loom.json";

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LastOpenedStore {
  /** Read once, at the boot decision. Never a subscription — nothing re-asks. */
  get(): LastOpened;
  /** A shipped example was opened, and it is this one. */
  rememberExample(fileName: string): void;
  /** Something deliberate that cannot be reopened: a file from disk, or File → New. */
  rememberOther(): void;
}

function defaultStorage(): PreferenceStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Safari private mode and hardened embedders throw on access. Same degradation as
    // `starter-preference.ts`: a blocked store reads as the default, never as a broken
    // session — here that means "never opened anything", i.e. the starter, which is the
    // behaviour this browser had before the key existed.
    return null;
  }
}

export function createLastOpenedStore(
  storage: PreferenceStorage | null = defaultStorage(),
): LastOpenedStore {
  const write = (value: string): void => {
    try {
      storage?.setItem(LAST_OPENED_STORAGE_KEY, value);
    } catch {
      // Quota or a blocked store. Losing this costs one wrong document on one future
      // boot; it is never a reason to fail the open the user just asked for.
    }
  };
  return {
    get: () => {
      let raw: string | null = null;
      try {
        raw = storage?.getItem(LAST_OPENED_STORAGE_KEY) ?? null;
      } catch {
        /* see defaultStorage */
      }
      if (raw === null || raw === "") return NEVER_OPENED;
      if (raw.endsWith(EXAMPLE_SUFFIX)) return { kind: "example", fileName: raw };
      // `OTHER`, and anything corrupt. Both mean "do not start this person on the
      // starter", which is the safe reading: the alternative is handing somebody a
      // document they did not choose on the strength of a byte nobody can parse.
      return { kind: "other" };
    },
    rememberExample: (fileName) => {
      // A name that could not be read back as an example would silently become `other`
      // on the next boot; recording it as `other` NOW makes the two agree.
      write(fileName.endsWith(EXAMPLE_SUFFIX) ? fileName : OTHER);
    },
    rememberOther: () => write(OTHER),
  };
}

/**
 * One store for the app.
 *
 * The same per-person singleton argument `starterPreferenceStore()` makes, and for a
 * sharper version of the same reason: the surfaces that WRITE this (the example library,
 * File → New, the file picker) and the one that READS it (the boot decision) are as far
 * apart as two parts of this tree get. `localStorage` is already a per-person singleton;
 * a second identity over one key would only be a way for the writers and the boot to
 * disagree about what happened.
 */
let shared: LastOpenedStore | null = null;

export function lastOpenedStore(): LastOpenedStore {
  shared ??= createLastOpenedStore();
  return shared;
}
