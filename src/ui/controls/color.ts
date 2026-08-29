/**
 * Colour representation for the colour control (doc §8.1: "Colour values support
 * linear and display colour representations", doc §16.2).
 *
 * A `ColorParameter` declares the space its stored value lives in. `display` values
 * are sRGB-encoded and are what a swatch or a hex field shows directly; `linear`
 * values are scene-referred and must be encoded before they can be shown, or the
 * swatch lies about the colour the user picked.
 *
 * This module is the only place in the kit that produces a CSS colour string, and it
 * does so from *parameter data*, never from theme: §V17 governs the chrome palette,
 * and a user's colour value is content.
 *
 * v17-allow-dynamic-color: the swatch and hex field render a ColorParameter's own
 * value, which cannot come from a token — there is no token for "the colour the user
 * picked". Every chrome colour in the kit still comes from tokens.
 */

export type Rgba = readonly [number, number, number, number];

export type ColorSpace = "linear" | "display";

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/** Tolerant read of a stored parameter value: wrong length or type falls back to opaque black. */
export function toRgba(value: unknown): Rgba {
  if (!Array.isArray(value)) return [0, 0, 0, 1];
  const read = (index: number, fallback: number): number => {
    const entry: unknown = value[index];
    return typeof entry === "number" && Number.isFinite(entry) ? entry : fallback;
  };
  return [read(0, 0), read(1, 0), read(2, 0), read(3, 1)];
}

/** sRGB electro-optical transfer function (display-encoded → linear). */
export function srgbToLinear(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Inverse of `srgbToLinear` (linear → display-encoded). */
export function linearToSrgb(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * The value as the user should *see* it. Alpha is linear in both spaces — it is
 * coverage, not light, and encoding it would make 50% opacity look wrong.
 */
export function toDisplay(value: Rgba, space: ColorSpace): Rgba {
  if (space === "display") return value;
  return [linearToSrgb(value[0]), linearToSrgb(value[1]), linearToSrgb(value[2]), value[3]];
}

/** Inverse of `toDisplay`: a display-space edit converted back into the stored space. */
export function fromDisplay(display: Rgba, space: ColorSpace): Rgba {
  if (space === "display") return display;
  return [srgbToLinear(display[0]), srgbToLinear(display[1]), srgbToLinear(display[2]), display[3]];
}

/**
 * Same value, different representation. This is what the linear/display toggle on the
 * colour control switches: the stored value never moves, only the numbers shown.
 */
export function convertColor(value: Rgba, from: ColorSpace, to: ColorSpace): Rgba {
  if (from === to) return value;
  return fromDisplay(toDisplay(value, from), to);
}

const byteOf = (channel: number): number => Math.round(clamp01(channel) * 255);

/** CSS colour for a swatch. Built from the parameter value, in display encoding. */
export function cssColorFor(value: Rgba, space: ColorSpace): string {
  const display = toDisplay(value, space);
  return `rgb(${byteOf(display[0])} ${byteOf(display[1])} ${byteOf(display[2])} / ${clamp01(display[3])})`;
}

/** `#rrggbb` for the hex field. Alpha is edited separately, so it is not encoded here. */
export function toHex(value: Rgba, space: ColorSpace): string {
  const display = toDisplay(value, space);
  const hex = (channel: number): string => byteOf(channel).toString(16).padStart(2, "0");
  return `#${hex(display[0])}${hex(display[1])}${hex(display[2])}`;
}

/**
 * Parses `#rgb`, `#rrggbb` (with or without the hash) into the parameter's own space,
 * preserving the current alpha. Returns null for anything else — a bad paste must
 * leave the value alone, not zero it.
 */
export function parseHex(text: string, space: ColorSpace, alpha: number): Rgba | null {
  const raw = text.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return null;
  const expanded =
    raw.length === 3
      ? [...raw].map((character) => `${character}${character}`).join("")
      : raw;
  const channel = (offset: number): number =>
    Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
  return fromDisplay([channel(0), channel(2), channel(4), clamp01(alpha)], space);
}

export const COLOR_CHANNEL_LABELS = ["R", "G", "B", "A"] as const;
