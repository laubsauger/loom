/** Viewer surface (T36) and the node preview slot (T34). */

export { ViewerPane } from "./viewer-pane.tsx";
export type { ViewerOutput, ViewerPaneProps, ViewerPreviewRequest } from "./viewer-pane.tsx";

export { NodePreview } from "./node-preview.tsx";
export type { NodePreviewFacts, NodePreviewProps, NodePreviewState } from "./node-preview.tsx";

export { NodePreviewSlot } from "./node-preview-slot.tsx";
export type { NodePreviewSlotProps } from "./node-preview-slot.tsx";

export { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
export type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";

export { READOUT_INTERVAL_MS, usePixelReadout } from "./use-pixel-readout.ts";
export type { PixelReadout, PixelReadoutOptions } from "./use-pixel-readout.ts";
