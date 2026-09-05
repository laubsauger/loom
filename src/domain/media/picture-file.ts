import type { ParameterValue } from "../types/parameters.ts";

/**
 * WHAT KIND OF PICTURE A FILE IS (T1223).
 *
 * Movie File In's description opened *"Plays a video or still image file"* since T493 and
 * the loader only ever built a `<video>` — `use-media-sources`' `openFile` called
 * `document.createElement("video")` and nothing else, so a still produced a black node and
 * NO diagnostic. This module is the classification the node needed to have all along, and
 * it lives in the domain rather than in the app because THREE surfaces read it and they
 * must not drift:
 *
 *  - the PICKER's `accept` — what the file dialog offers at all (the owner's first
 *    symptom: *"I can't even select an image as of now"*);
 *  - the LOADER — which door to open, `<video>` or `createImageBitmap`;
 *  - the TRANSPORT's `inactiveWhen` — a still has no clock, so Play, Speed, Cue, Trim and
 *    At End are unread (the §T1190 treatment, applied to the second set of dead controls).
 *
 * ## OFFERED and ATTEMPTED are different questions, deliberately
 *
 * `PICTURE_FILE_ACCEPT` lists what we are CONFIDENT the browser decodes, because an
 * `accept` that admits a file we then refuse is worse than one that never offered it.
 * `pictureFileKind` is more generous: anything that is plainly a still is ATTEMPTED, and
 * `createImageBitmap` refuses it BY NAME if the engine cannot decode it (HEIC in Chrome,
 * TIFF anywhere). That is not a lie in either direction — a static "unsupported" list
 * would be, since Safari decodes HEIC and Chrome does not.
 *
 * ## HDR IS NAMED, NOT SILENTLY 8-BIT (T1222)
 *
 * EXR and Radiance `.hdr` classify as `hdr` and the loader REFUSES them with the format in
 * the sentence. Decoding an HDR image into the existing `rgba8unorm-srgb` external texture
 * would hand back a very expensive JPEG — accepting a format and quietly throwing away its
 * range is the failure mode this task exists to close, not one to add. They need the float
 * texture path, which is §T1222's, and they move from `hdr` to `still` when it lands.
 */

/** What the loader must do with a file, decided from its name alone. */
export type PictureFileKind = "video" | "still" | "hdr";

/**
 * Stills we OFFER in the picker and know `createImageBitmap` decodes everywhere we run.
 * The accept string is derived from this list, so the dialog cannot drift from the loader.
 */
const OFFERED_STILL_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/bmp",
];

/**
 * The file input's `accept` for a `picture` asset — a video OR a still, which is the one
 * file slot TouchDesigner's Movie File In has and the shape the owner asked for.
 *
 * `video/*` is a wildcard because every container the engine plays is playable through the
 * same `<video>`; the stills are enumerated because the honest list is shorter than
 * `image/*` — `image/*` would offer `.exr`, and an EXR is refused today (see above).
 */
export const PICTURE_FILE_ACCEPT = ["video/*", ...OFFERED_STILL_TYPES].join(",");

/**
 * The same list in words, for the picker's tooltip — the one place a person reads BEFORE
 * they open the dialog (§V403). It lives here, beside the accept string it describes, so
 * the two cannot drift: a sentence in the .tsx would also trip §V90's copy guard, and
 * rightly, since this is a fact about the format list rather than chrome prose.
 */
export const PICTURE_FILE_TAKES =
  "Takes a video file or a still image (PNG, JPEG, WebP, AVIF, GIF, BMP). EXR and Radiance .hdr need the float texture path and are refused by name.";

/**
 * Stills we ATTEMPT. A superset of what we offer: a file that arrives by another door — a
 * saved project, an agent writing the parameter, a picker's "All Files" — is still tried,
 * and a decode failure names it rather than being pre-judged by this list.
 */
const STILL_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "jfif", "webp", "avif", "gif", "bmp", "ico",
  "heic", "heif", "tif", "tiff",
]);

/** High dynamic range stills. Refused by name until the float texture path lands (T1222). */
const HDR_EXTENSIONS = new Set(["exr", "hdr", "rgbe", "pic"]);

/** Human name for the refusal sentence: ".exr" reads worse than "EXR". */
const HDR_LABELS: Readonly<Record<string, string>> = {
  exr: "OpenEXR",
  hdr: "Radiance HDR",
  rgbe: "Radiance HDR",
  pic: "Radiance HDR",
};

/** What a node's `file` parameter holds. Stored by whatever UI wrote it, so read widely. */
export function pictureFileUrl(value: ParameterValue | unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "";
}

/**
 * The file's own name, which is the only thing a `blob:` URL carries about it.
 *
 * The picker appends `#<encoded file name>` to the object URL precisely so the field can
 * display something a human recognises (T434) — and that fragment is also the ONLY place
 * the extension survives, since `blob:` URLs are opaque. So the fragment is read first and
 * the path second.
 */
export function pictureFileName(url: string): string {
  const hash = url.indexOf("#");
  if (hash >= 0 && hash < url.length - 1) {
    const fragment = url.slice(hash + 1);
    try {
      return decodeURIComponent(fragment);
    } catch {
      // A malformed escape is not a reason to lose the name; the raw fragment still
      // carries the extension, which is all this module reads.
      return fragment;
    }
  }
  const path = url.split("#")[0]?.split("?")[0] ?? "";
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Lower-case extension without the dot, or "" when the name carries none. */
export function pictureFileExtension(url: string): string {
  const name = pictureFileName(url);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * VIDEO IS THE DEFAULT, and that is a decision rather than an oversight.
 *
 * An unknown or absent extension goes to the `<video>` door: it is the node's historical
 * behaviour, it is what the node is named after, and the element's own `error` event turns
 * a wrong guess into the diagnostic that already exists ("The file … could not be
 * played"). The alternative — try video, then silently retry as an image — is the
 * speculative fallback this codebase forbids, and it would swallow the real failure.
 */
export function pictureFileKind(url: string): PictureFileKind {
  const extension = pictureFileExtension(url);
  if (HDR_EXTENSIONS.has(extension)) return "hdr";
  if (STILL_EXTENSIONS.has(extension)) return "still";
  return "video";
}

/** True when the node's `file` value names a still — the transport's gate reads this. */
export function isStillPictureFile(value: ParameterValue | unknown): boolean {
  const url = pictureFileUrl(value);
  if (url === "") return false;
  return pictureFileKind(url) === "still";
}

/**
 * Why an HDR still is refused, with the format named (§V338, §V403: an absence we report
 * must name what would make it go away). Null when the file is not one.
 */
export function hdrPictureRefusal(url: string): string | null {
  const extension = pictureFileExtension(url);
  if (!HDR_EXTENSIONS.has(extension)) return null;
  const label = HDR_LABELS[extension] ?? extension.toUpperCase();
  return `${pictureFileName(url)} is a ${label} high-dynamic-range image. This node uploads into an 8-bit texture, and decoding an HDR file into it would throw away the range that makes it HDR (T1222 builds the float path). Convert it to PNG or JPEG, or use a video file.`;
}
