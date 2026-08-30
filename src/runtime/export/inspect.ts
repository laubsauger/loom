import type { ExportInterface } from "./types.ts";
import type { OutputRef } from "../../domain/types/ids.ts";
import { decodeToLinear } from "./image.ts";

/**
 * `describe_output` (T291, §V144-adjacent): a texture summarised as NUMBERS — the cheap
 * look. An agent iterating on a graph asks "is node X basically black? clipped? flat?"
 * far more often than it needs pixels, and a stats record costs ~a hundred tokens where
 * a thumbnail costs thousands. Pixels stay available (`render_preview`); this is the
 * tool an agent should reach for FIRST.
 *
 * Stats are computed on the LINEAR plane (§V56 — the working space, so numbers agree
 * with what shaders computed, not with an encoding), per channel: min, max, mean.
 */

export interface ChannelStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

export interface OutputStats {
  readonly ref: OutputRef;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly channels: { readonly r: ChannelStats; readonly g: ChannelStats; readonly b: ChannelStats; readonly a: ChannelStats };
}

export async function describeOutputStats(api: ExportInterface, ref: OutputRef): Promise<OutputStats> {
  const image = await api.read(ref, { reason: "export" });
  const plane = decodeToLinear(image);

  const totals = [0, 0, 0, 0];
  const mins = [Infinity, Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity, -Infinity];
  const pixels = plane.width * plane.height;
  for (let index = 0; index < pixels; index += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      const value = plane.rgba[index * 4 + channel] ?? 0;
      totals[channel] = (totals[channel] ?? 0) + value;
      if (value < (mins[channel] ?? Infinity)) mins[channel] = value;
      if (value > (maxs[channel] ?? -Infinity)) maxs[channel] = value;
    }
  }
  const stats = (channel: number): ChannelStats => ({
    min: pixels === 0 ? 0 : (mins[channel] ?? 0),
    max: pixels === 0 ? 0 : (maxs[channel] ?? 0),
    mean: pixels === 0 ? 0 : (totals[channel] ?? 0) / pixels,
  });

  return {
    ref,
    width: image.width,
    height: image.height,
    format: image.format,
    channels: { r: stats(0), g: stats(1), b: stats(2), a: stats(3) },
  };
}
