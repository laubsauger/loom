import type { UniformValues } from "../backend/plan.ts";
import type { ColorSpace } from "../../domain/types/ports.ts";
import { previewShaderSource } from "./debug-effects.wgsl.ts";
import { ALL_CHANNELS, DEFAULT_PREVIEW_VIEW, PREVIEW_CHANNELS } from "./types.ts";
import type {
  ChannelMask,
  PreviewChannel,
  PreviewLens,
  PreviewModeKind,
  PreviewView,
} from "./types.ts";

/**
 * The debug preview effect for a mode and the DECLARED space of what it is previewing
 * (T35, T375).
 *
 * `space` is a required argument, not a default (§V272): a tile is a display and always
 * ends display-encoded, so what the shader has to know is whether its source is display
 * values already. Defaulting it would let a caller that never heard of §V57 re-encode an
 * encoded picture and see a plausible, wrong image — B47's exact failure.
 */
export function previewShader(mode: PreviewModeKind, space: ColorSpace): string {
  return previewShaderSource(mode, space);
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
 * The editor's LENS, resolved to a view (T336).
 *
 * The one widening from the small vocabulary a person sets to the full uniform set the pass
 * takes, so there is no second opinion anywhere about what "isolate green" means. It reuses
 * `viewForChannelMask` for the isolating lenses rather than restating its two rules — alpha
 * gets the checkerboard, a single colour channel goes grayscale — and adds only what the mask
 * cannot express: luminance, which is a mode rather than a mask.
 *
 * Note what this does NOT touch: nothing here reaches the present blit. §V70a keeps that a raw
 * copy, and §V255 is the ruling that these belong to the preview path alone — a display
 * transform on the presented canvas hides which node is wrong and double-encodes once the
 * Output node does its job.
 */
export function viewForLens(
  lens: PreviewLens,
  base: PreviewView = DEFAULT_PREVIEW_VIEW,
): PreviewView {
  const graded: PreviewView = {
    ...base,
    exposureStops: lens.exposureStops,
    tonemap: lens.tonemap,
  };
  switch (lens.lens) {
    case "rgb":
      return { ...graded, mode: "color", channels: ALL_CHANNELS };
    case "luminance":
      return { ...graded, mode: "luminance", channels: ALL_CHANNELS };
    default:
      return viewForChannelMask({ ...NO_CHANNELS, [lens.lens]: true }, graded);
  }
}

const NO_CHANNELS: ChannelMask = Object.freeze({ r: false, g: false, b: false, a: false });

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
