import type { ExampleProject } from "./example-catalogue.ts";

/**
 * A SHAREABLE LINK THAT NAMES A SHIPPED EXAMPLE (T1278, §V88, §V93).
 *
 * The owner's ask: *"did we implement linking to examples yet so that ui can send a link
 * to one and it will open a new file with that for whomever opens that?"* — one person
 * pastes a URL into chat, whoever opens it lands on that example in a document of their
 * own.
 *
 * This module is the CONTRACT and nothing else: how an example's name is written into a
 * URL, and how a URL is read back into a catalogue row. It holds no browser globals and
 * no decision about the boot — `src/app/example-link-boot.ts` owns the address bar and
 * `use-starter-project.ts` owns what a boot does with the answer. It lives beside the
 * catalogue rather than in `src/app` because BOTH ENDS are here: the example library
 * produces the link (a row's copy action) and only the catalogue can say what a name
 * resolves to. `example-link.test.ts` round-trips producer through consumer in one case,
 * so the two halves cannot drift apart.
 *
 * ## A QUERY, not a path
 *
 * `?example=E11-Gradient-Remap`. The hosted build is GitHub Pages at `--base=/loom/` with
 * no `404.html`, so a path route (`/loom/example/E11`) would 404 for the person the link
 * was sent to — the one thing a shareable link may not do. A query survives both Pages and
 * the one-time cross-origin-isolation reload (T1048), which preserves search and hash.
 *
 * ## WHAT COUNTS AS A NAME, and why three spellings rather than one
 *
 * Case-insensitively, all three of:
 *
 *   - `E11-Gradient-Remap`   — the stem. What `exampleLinkUrl` writes.
 *   - `E11-Gradient-Remap.loom.json` — the full file name. What every other surface that
 *     names an example uses (`project.open`'s `fileName`, `last-opened.ts`, the agent's
 *     `get_example`), so a name copied from one of those works instead of failing.
 *   - `E11`                  — the bare id, which is what a person types or truncates a
 *     link down to. Unambiguous because every shipped file is `E<n>-<title>.loom.json`:
 *     the hyphen separates `E1-` from `E10-`.
 *
 * Anything else is UNKNOWN and the caller is expected to say so out loud. A link that
 * quietly fell through to the starter would tell the recipient the sender was wrong about
 * what they sent, which is the failure this contract exists to prevent — the agent surface
 * already refuses the same way (`example.unknown`, `agent/tools/library.ts`).
 */

/** The query key. One spelling, shared by the producer, the reader and the strip. */
export const EXAMPLE_LINK_PARAM = "example";

/** The extension every shipped example carries — the whole of stem vs. file name here. */
const EXAMPLE_SUFFIX = ".loom.json";

/** `E11`, `E3`, `E60`. Checked before a prefix search so a title cannot masquerade as one. */
const BARE_ID = /^e\d+$/;

/**
 * The name this example is written into a link as: the stem, `E11-Gradient-Remap`.
 *
 * The stem and not the file name because a link is read by people — `.loom.json` in a URL
 * is four characters of implementation detail in the one string that gets pasted into a
 * chat window. `resolveExampleLink` accepts the file name anyway, so nothing is lost.
 */
export function exampleLinkName(fileName: string): string {
  return fileName.endsWith(EXAMPLE_SUFFIX)
    ? fileName.slice(0, -EXAMPLE_SUFFIX.length)
    : fileName;
}

/**
 * The URL to hand somebody.
 *
 * `origin` and `base` are passed rather than read: this module is the contract, not the
 * address bar, and `import.meta.env.BASE_URL` is `/loom/` on Pages and `/` in dev — a
 * hard-coded either would produce a link that works on exactly one of them.
 */
export function exampleLinkUrl(fileName: string, origin: string, base: string): string {
  const params = new URLSearchParams([[EXAMPLE_LINK_PARAM, exampleLinkName(fileName)]]);
  return `${origin}${base}?${params.toString()}`;
}

/**
 * The name a URL's query asks for, or null when it asks for none.
 *
 * A BLANK value (`?example=`) reads as null — absent, not unknown. There is no wrong name
 * to report back, so the honest answer is "this link named no example" and the boot
 * proceeds exactly as it would have without it. Every other malformed value is a name, and
 * `resolveExampleLink` fails it loudly.
 */
export function readExampleLink(search: string): string | null {
  const requested = new URLSearchParams(search).get(EXAMPLE_LINK_PARAM);
  if (requested === null) return null;
  const trimmed = requested.trim();
  return trimmed === "" ? null : trimmed;
}

export type ExampleLinkResolution =
  | { readonly kind: "match"; readonly example: ExampleProject }
  /** Carries the caller's OWN string back, never any shipped document text (§V37). */
  | { readonly kind: "unknown"; readonly requested: string };

/** The three spellings above, against this build's catalogue. Never a partial match. */
export function resolveExampleLink(
  requested: string,
  catalogue: readonly ExampleProject[],
): ExampleLinkResolution {
  const wanted = requested.trim().toLowerCase();
  const stem = wanted.endsWith(EXAMPLE_SUFFIX)
    ? wanted.slice(0, -EXAMPLE_SUFFIX.length)
    : wanted;
  const fileName = `${stem}${EXAMPLE_SUFFIX}`;
  const match =
    catalogue.find((entry) => entry.fileName.toLowerCase() === fileName) ??
    (BARE_ID.test(stem)
      ? catalogue.find((entry) => entry.fileName.toLowerCase().startsWith(`${stem}-`))
      : undefined);
  return match === undefined ? { kind: "unknown", requested } : { kind: "match", example: match };
}

/**
 * `href` with the link removed, or null when there was none to remove.
 *
 * Pure so the caller decides WHEN — the boot must not strip the param before the hosted
 * build's one-time isolation reload has had its chance to fire, or the reload eats the
 * link (`example-link-boot.ts` holds that rule).
 */
export function withoutExampleLink(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(EXAMPLE_LINK_PARAM)) return null;
  url.searchParams.delete(EXAMPLE_LINK_PARAM);
  // Assigning the serialised params drops a now-empty `?`, so a link with nothing else in
  // its query leaves the address reading as it would have without the link at all.
  url.search = url.searchParams.toString();
  return url.toString();
}
