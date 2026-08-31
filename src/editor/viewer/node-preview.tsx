import type { PreviewLens, PreviewOutputRef, SuspendReason } from "@runtime/previews/index.ts";
import { isDefaultLens, previewKey } from "@runtime/previews/index.ts";
import { cx } from "@ui/cx.ts";
import styles from "./viewer.module.css";

/**
 * A node's inline preview slot (T34, doc §12.2 step 4).
 *
 * This element paints nothing when the preview is live: it is a HOLE through the node chrome,
 * and the shared preview surface composites the tile behind it. Filling it with a canvas would
 * be the per-node-context design the design note rejects, and filling it with a background
 * would hide the picture.
 *
 * It renders text only when there is no picture — which is a real requirement, not a nicety.
 * §V28 suspends previews for good reasons, and a suspended preview that looks identical to a
 * broken one turns a working optimisation into a bug report.
 */

export type NodePreviewState =
  | { readonly kind: "live" }
  | { readonly kind: "suspended"; readonly reason: SuspendReason }
  | { readonly kind: "idle" }
  /**
   * Switched off by the user (T353, §V297). Distinct from `suspended`, which the
   * scheduler decides and undoes on its own, and from `idle`, which means the compiler
   * has resolved nothing yet: this one is a choice, and it is the only state in which the
   * node is deliberately costing nothing.
   */
  | { readonly kind: "off" };

/** Resolved size/format (§V100) — a node's preview NEVER goes blank just because the
 *  tile isn't drawing right now; it shows what compiled, which is real data, not prose. */
export interface NodePreviewFacts {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export interface NodePreviewProps {
  /** Named `output`, not `ref`: React 19 treats a `ref` prop as an element ref. */
  readonly output: PreviewOutputRef;
  readonly state: NodePreviewState;
  readonly facts?: NodePreviewFacts | undefined;
  /** The lens this preview is being shown through (T336). Default = no marker at all. */
  readonly lens?: PreviewLens | undefined;
}

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

const SUSPEND_LABELS: Readonly<Record<SuspendReason, string>> = {
  collapsed: "collapsed",
  occluded: "hidden",
  offscreen: "off-screen",
  "too-small": "zoom in",
  "not-visible": "paused",
  budget: "over budget",
};

export function NodePreview({ output, state, facts, lens }: NodePreviewProps) {
  const live = state.kind === "live";
  const marker = lensMarker(lens);
  const reason =
    state.kind === "suspended"
      ? SUSPEND_LABELS[state.reason]
      : state.kind === "off"
        ? "preview off"
        : live
          ? "live"
          : "no signal";
  // §V100/T197 — not-live does not mean empty: the compiler already resolved this output,
  // so the slot shows it rather than nothing.
  //
  // §V303 — but it shows the STATE as well, and that is not decoration. A canvas keeps its
  // last presented pixels, so a tile that stops being scheduled leaves a frozen picture
  // behind it that looks exactly like a live one. The slot's opaque background is what
  // actually covers those pixels (`.slotLive` is the only transparent case); this line is
  // what tells the reader WHY the picture is gone. Facts alone made "off", "off-screen"
  // and "over budget" render the same sentence — three different states, one label.
  const factsText = facts === undefined ? null : `${facts.width} × ${facts.height} · ${facts.format}`;
  return (
    <div
      className={cx(styles.slot, live && styles.slotLive)}
      data-testid={`preview-slot-${previewKey(output)}`}
      data-preview-state={state.kind}
      role="img"
      aria-label={`Preview of ${previewKey(output)}: ${reason}${marker === null ? "" : ` — lens ${marker}`}`}
      title={live ? undefined : reason}
    >
      {live ? null : (
        <span className={styles.slotStatus}>
          <span className={styles.slotReason}>{reason}</span>
          {factsText === null ? null : <span className={styles.slotFacts}>{factsText}</span>}
        </span>
      )}
      {/*
        T685 — the lens marker USED to be drawn here, over the picture, and that is exactly
        where it could not be seen: the shared preview surface composites the live tile
        across this whole box (§V633), so §V70a's "this is not the node's output" warning
        was legible only on previews that were not live. It is in the node header now
        (`nodes/node-view.tsx`, `previewLens`). What stays here is the ACCESSIBLE name
        below, which never depended on paint.
      */}
    </div>
  );
}
