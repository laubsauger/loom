/**
 * Preview system surface (T34, T35, T36 support).
 *
 * Everything here is DOM-free and structured-clone safe, so the whole preview path moves into
 * a worker with the rest of the runtime (§V63, Phase 2).
 */

export {
  ALL_CHANNELS,
  DEFAULT_OUTPUT_PORT,
  DEFAULT_PREVIEW_LENS,
  DEFAULT_PREVIEW_VIEW,
  PREVIEW_CHANNELS,
  PREVIEW_LENSES,
  PREVIEW_MODES,
  SUSPEND_REASONS,
  isDefaultLens,
  previewKey,
} from "./types.ts";
export type {
  ChannelMask,
  PreviewChannel,
  PreviewLens,
  PreviewLensKind,
  AllocatedPreview,
  PreviewCompositeTile,
  PreviewFrameCommand,
  PreviewModeKind,
  PreviewOutputRef,
  PreviewProgram,
  PreviewRect,
  PreviewRequest,
  PreviewRuntimeHost,
  PreviewSchedule,
  PreviewView,
  ScheduledPreview,
  SuspendReason,
  SuspendedPreview,
} from "./types.ts";

export {
  MAX_TILE_SCALE,
  MIN_ONSCREEN_LONG_EDGE_CSS,
  TILE_SIZE_LADDER,
  ladderSnap,
  rectArea,
  rectLongEdge,
  rectsIntersect,
  slotScreenRect,
  tileSizeFor,
} from "./geometry.ts";
export type { SlotBox, TileSizeInput, ViewportTransform } from "./geometry.ts";

export {
  PREVIEW_SAMPLER_BINDING,
  PREVIEW_SHADERS,
  PREVIEW_TEXTURE_BINDING,
  PREVIEW_UNIFORM_BINDING,
  channelIndex,
  previewShader,
  previewUniforms,
  resolvePreviewView,
  viewForChannelMask,
  viewForLens,
} from "./debug-effects.ts";

export { TILE_FORMAT, createTileAtlas } from "./tile-atlas.ts";
export type { TileAllocation, TileAtlas, TileRequest } from "./tile-atlas.ts";

export { createPreviewScheduler } from "./schedule.ts";
export type { PreviewScheduler, PreviewSchedulerOptions, ScheduleInput } from "./schedule.ts";

export { PREVIEW_SAMPLER, buildPreviewProgram, previewPassId } from "./program.ts";

export { createPreviewSystem } from "./system.ts";
export type { PreviewSystem, PreviewSystemFrame, PreviewSystemResult } from "./system.ts";

/**
 * Pixel inspection is exported separately and imported by the viewer only. It is NOT part of
 * the scheduling path and must never become so (§V7, §V48).
 */
export { BYTES_PER_PIXEL, decodeHalf, decodePixel } from "./pixel-probe.ts";
export type { PixelProbe, PixelSample, PixelWindow, ReadbackImage } from "./pixel-probe.ts";
