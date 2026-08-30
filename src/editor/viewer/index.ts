/**
 * The node preview slot (T34) and the pieces the VIEWER borrows (T36).
 *
 * There is no `ViewerPane` here any more. There were two of them — this one, with T36's
 * channel masks, tonemap toggle, pixel readout and keyboard probe, mounted nowhere; and
 * `app/side-panes.tsx`, which owns the real canvas and is what the app ships. Two
 * components with one name and different capability is a product decision disguised as a
 * duplicate (§V242), and the ruling was to FOLD rather than switch: canvas ownership is the
 * hard part and it already worked, so T36's readout and keyboard cursor moved to the
 * mounted pane and this module stopped pretending to be a pane (T329, B34).
 *
 * `usePixelReadout` stays because it is a hook, not a pane, and the mounted viewer uses it.
 */

export { NodePreview } from "./node-preview.tsx";
export type { NodePreviewFacts, NodePreviewProps, NodePreviewState } from "./node-preview.tsx";

export { NodePreviewSlot } from "./node-preview-slot.tsx";
export type { NodePreviewSlotProps } from "./node-preview-slot.tsx";

export { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
export type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";

export { READOUT_INTERVAL_MS, usePixelReadout } from "./use-pixel-readout.ts";
export type { PixelReadout, PixelReadoutOptions } from "./use-pixel-readout.ts";
