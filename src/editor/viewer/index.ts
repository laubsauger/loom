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

export { NodePreview, lensMarker } from "./node-preview.tsx";
export type { NodePreviewFacts, NodePreviewProps, NodePreviewState } from "./node-preview.tsx";

export { NodePreviewSlot } from "./node-preview-slot.tsx";
export type { NodePreviewSlotProps } from "./node-preview-slot.tsx";

export { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
export type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";
export { createPreviewOrbitStore } from "./preview-orbit-store.ts";
export type { PreviewOrbitStore } from "./preview-orbit-store.ts";

/**
 * T892 — the camera toggle, drawn on the bottom-right corner of the tile it drives.
 *
 * A PANE-level layer rather than node chrome, and that is not a stylistic choice: the
 * shared preview surface composites over every pixel inside a node's preview slot, so a
 * control drawn there is invisible exactly when it is useful. The reasoning is written
 * out in `preview-inspect-overlay.tsx`.
 */
export { PreviewInspectOverlays } from "./preview-inspect-overlay.tsx";
export type { PreviewInspectOverlaysProps } from "./preview-inspect-overlay.tsx";

/**
 * T935 — the DRAGGABLE POINT, generalising T692's camera gizmo from *the camera* to *a
 * point in space*. A handle is a world-space `vec3` parameter drawn where the tile's own
 * camera puts it; dragging it writes that parameter through the bus, so a gizmo edit is
 * indistinguishable from a typed one (§V29/§V30). The refusal, the depth constraint and
 * the reason the graph pane hosts it are written out in the three modules.
 */
export { PreviewGizmoOverlays } from "./preview-gizmo-overlay.tsx";
export type { PreviewGizmoOverlaysProps, PreviewGizmoTile } from "./preview-gizmo-overlay.tsx";
export { GIZMO_LOCKED_REASON, createVec3GizmoStore, gizmoHandlesFor } from "./vec3-gizmo-store.ts";
export type {
  GizmoHandle,
  GizmoParameterFacts,
  Vec3GizmoEditor,
  Vec3GizmoStore,
} from "./vec3-gizmo-store.ts";
export { handleScreenPoint, pointerToPlane, tileCamera } from "./gizmo-projection.ts";
export type { HandlePoint, PictureRect, TileCamera } from "./gizmo-projection.ts";

/**
 * The preview LENS (T336) — channel isolation, exposure and the tonemap, on the preview path
 * only (§V255, §V70a). The store is transient session state, never document state; the reason
 * is written down in `preview-view-store.ts` and it is a deliberate call, not an omission.
 */
export { createPreviewViewStore, previewViewStoreFor } from "./preview-view-store.ts";
export type { PreviewViewSource, PreviewViewStore } from "./preview-view-store.ts";

export {
  MAX_EXPOSURE_STOPS,
  RESET_PREVIEW_VIEW_COMMAND,
  SET_PREVIEW_VIEW_COMMAND,
  previewViewTargetFor,
  registerPreviewViewCommands,
  usePreviewViews,
} from "./preview-view-command.ts";
export type { PreviewViewTargetHolder } from "./preview-view-command.ts";

export { READOUT_INTERVAL_MS, usePixelReadout } from "./use-pixel-readout.ts";
export type { PixelReadout, PixelReadoutOptions } from "./use-pixel-readout.ts";
export { createPreviewInterestStore } from "./preview-interest.ts";
export type { PreviewInterestStore } from "./preview-interest.ts";
