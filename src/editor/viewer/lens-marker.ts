import type { PreviewLens } from "@runtime/previews/index.ts";
import { isDefaultLens } from "@runtime/previews/index.ts";

/**
 * The lens marker a node preview paints over an altered picture (T336). Split out of
 * `node-preview.tsx` by T1315b so that file exports only components and Fast Refresh
 * can swap them.
 */

const LENS_LABEL: Readonly<Record<PreviewLens["lens"], string>> = {
  rgb: "",
  r: "R",
  g: "G",
  b: "B",
  a: "A",
  luminance: "LUM",
};

/**
 * The marker text for a lens, or null when there is nothing to say.
 *
 * This is the §V70a argument applied to the preview path: a display transform that outlives
 * the inspection HIDES WHICH NODE IS WRONG, so a lens that is on says so on the picture it is
 * changing. It costs zero pixels in the ordinary case, which is what keeps it out of §V90's
 * way — there is no ambient badge, only one on a preview somebody has deliberately altered.
 */
export function lensMarker(lens: PreviewLens | undefined): string | null {
  if (lens === undefined || isDefaultLens(lens)) return null;
  const parts: string[] = [];
  const channel = LENS_LABEL[lens.lens];
  if (channel !== "") parts.push(channel);
  if (lens.exposureStops !== 0) {
    parts.push(`${lens.exposureStops > 0 ? "+" : ""}${lens.exposureStops} EV`);
  }
  if (lens.tonemap) parts.push("TM");
  return parts.length === 0 ? null : parts.join(" ");
}
