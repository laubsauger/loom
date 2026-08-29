import type { PreviewOutputRef, SuspendReason } from "@runtime/previews/index.ts";
import { previewKey } from "@runtime/previews/index.ts";
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
  | { readonly kind: "idle" };

export interface NodePreviewProps {
  /** Named `output`, not `ref`: React 19 treats a `ref` prop as an element ref. */
  readonly output: PreviewOutputRef;
  readonly state: NodePreviewState;
}

const SUSPEND_LABELS: Readonly<Record<SuspendReason, string>> = {
  collapsed: "collapsed",
  occluded: "hidden",
  offscreen: "off-screen",
  "too-small": "zoom in",
  "not-visible": "paused",
  budget: "over budget",
};

export function NodePreview({ output, state }: NodePreviewProps) {
  const live = state.kind === "live";
  const label =
    state.kind === "suspended" ? SUSPEND_LABELS[state.reason] : live ? "live" : "no signal";
  return (
    <div
      className={cx(styles.slot, live && styles.slotLive)}
      data-testid={`preview-slot-${previewKey(output)}`}
      data-preview-state={state.kind}
      role="img"
      aria-label={`Preview of ${previewKey(output)}: ${label}`}
    >
      {live ? null : <span className={styles.slotStatus}>{label}</span>}
    </div>
  );
}
