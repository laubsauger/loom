import type { UniformValues } from "../backend/plan.ts";
import {
  PREVIEW_ALPHA_WGSL,
  PREVIEW_CHANNEL_WGSL,
  PREVIEW_COLOR_WGSL,
  PREVIEW_EXPOSURE_WGSL,
  PREVIEW_NAN_WGSL,
  PREVIEW_SIGNED_WGSL,
} from "./debug-effects.wgsl.ts";
import { ALL_CHANNELS, DEFAULT_PREVIEW_VIEW, PREVIEW_CHANNELS } from "./types.ts";
import type { ChannelMask, PreviewChannel, PreviewModeKind, PreviewView } from "./types.ts";

/**
 * The debug preview effect catalogue (T35).
 *
 * A record keyed by the mode union rather than a switch, so adding a mode without giving it a
 * shader is a type error instead of a runtime hole.
 */
export const PREVIEW_SHADERS: Readonly<Record<PreviewModeKind, string>> = {
  color: PREVIEW_COLOR_WGSL,
  channel: PREVIEW_CHANNEL_WGSL,
  alpha: PREVIEW_ALPHA_WGSL,
  exposure: PREVIEW_EXPOSURE_WGSL,
  nan: PREVIEW_NAN_WGSL,
  signed: PREVIEW_SIGNED_WGSL,
};

export function previewShader(mode: PreviewModeKind): string {
  return PREVIEW_SHADERS[mode];
}

/** WGSL binding names the preview passes declare. The plan descriptor names them by string. */
export const PREVIEW_UNIFORM_BINDING = "params";
export const PREVIEW_SAMPLER_BINDING = "previewSampler";
export const PREVIEW_TEXTURE_BINDING = "previewTexture";

/** Index order fixed by `PREVIEW_CHANNELS`; `pickChannel` in the WGSL agrees with it. */
export function channelIndex(channel: PreviewChannel): number {
  const index = PREVIEW_CHANNELS.indexOf(channel);
  return index < 0 ? 0 : index;
}

function maskVector(mask: ChannelMask): readonly number[] {
  return [mask.r ? 1 : 0, mask.g ? 1 : 0, mask.b ? 1 : 0, mask.a ? 1 : 0];
}

/**
 * Uniform values for a view.
 *
 * Values only — the block's SHAPE is identical for every mode, so nothing here can reach the
 * pipeline-rebuild path (§V5). Exposure is converted from stops to a linear multiplier on the
 * CPU: `pow(2, stops)` per pixel would be the same number computed a million times.
 */
export function previewUniforms(view: PreviewView): UniformValues {
  return {
    mask: maskVector(view.channels),
    exposure: Math.pow(2, view.exposureStops),
    channel: channelIndex(view.channel),
    checkerSize: Math.max(1, view.checkerSize),
    tonemap: view.tonemap ? 1 : 0,
    signedScale: Math.max(1e-6, view.signedScale),
  };
}

function enabledChannels(mask: ChannelMask): PreviewChannel[] {
  return PREVIEW_CHANNELS.filter((channel) => mask[channel]);
}

/**
 * Channel toggles -> preview view (T36).
 *
 * The behaviour every compositor converges on, and worth stating because it is two rules and
 * not one:
 *  - Exactly ONE channel enabled means "isolate": show that channel as grayscale. Showing the
 *    green channel tinted green next to a green image tells the user nothing.
 *  - Two or more means "mask": show colour with the disabled channels zeroed.
 *  - Alpha alone is the special case that gets the checkerboard, because "what does alpha look
 *    like here" is nearly always the coverage question rather than the value question.
 *  - No channels at all is not a state a user can usefully see, so it falls back to colour;
 *    the toggles themselves keep the last-enabled channel latched (see the viewer).
 */
export function viewForChannelMask(
  mask: ChannelMask,
  base: PreviewView = DEFAULT_PREVIEW_VIEW,
): PreviewView {
  const enabled = enabledChannels(mask);
  const only = enabled.length === 1 ? enabled[0] : undefined;
  if (only === undefined) {
    return { ...base, mode: "color", channels: enabled.length === 0 ? ALL_CHANNELS : mask };
  }
  if (only === "a") return { ...base, mode: "alpha", channel: "a", channels: mask };
  return { ...base, mode: "channel", channel: only, channels: mask };
}

/**
 * The viewer's display selection, resolved to a view.
 *
 * `"auto"` derives the mode from the channel toggles, which is what a user who has just
 * clicked "G" expects. Picking a mode explicitly wins over that, so choosing `signed` and then
 * masking a channel keeps showing signed values — the toggles narrow what is shown, they do
 * not silently change what the effect IS.
 */
export function resolvePreviewView(
  selection: PreviewModeKind | "auto",
  mask: ChannelMask,
  base: PreviewView = DEFAULT_PREVIEW_VIEW,
): PreviewView {
  if (selection === "auto") return viewForChannelMask(mask, base);
  const enabled = enabledChannels(mask);
  const only = enabled.length === 1 ? enabled[0] : undefined;
  return {
    ...base,
    mode: selection,
    channels: enabled.length === 0 ? ALL_CHANNELS : mask,
    ...(only === undefined ? {} : { channel: only }),
  };
}
