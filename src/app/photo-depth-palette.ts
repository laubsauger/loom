import { COLORMAPS, colormapRgb, type ColormapId } from "@domain/color/colormaps.ts";

/* Owner 2026-11-22: depth reads better red (near) to blue (far). The shared maps are the
   node previews' own (`colormaps.ts`), so the photo surface and a Depth node's tile agree;
   their `stops` here are samples for the legend, the table is computed from the map itself. */
const SHARED = COLORMAPS.map((map) => ({
  id: map.id, label: map.label,
  stops: Array.from({ length: 9 }, (_, index) => colormapRgb(map.id, index / 8).map((value) => Math.round(value * 255)) as [number, number, number]),
}));

export const DEPTH_PALETTES = [
  ...SHARED,
  { id: "grayscale", label: "Grayscale", stops: [[0, 0, 0], [255, 255, 255]] },
  { id: "ocean", label: "Ocean", stops: [[12, 20, 55], [22, 85, 133], [30, 167, 163], [149, 224, 174], [245, 249, 206]] },
  { id: "heat", label: "Heat", stops: [[16, 8, 35], [90, 27, 113], [184, 54, 100], [245, 126, 61], [252, 245, 190]] },
] as const;

export type DepthPalette = ColormapId | "grayscale" | "ocean" | "heat";

/** What a depth view starts in: the node previews' default for depth. */
export const DEFAULT_DEPTH_PALETTE: DepthPalette = "turbo";

/** Display-only colour table. Input is already normalized near brightness. */
export function depthPaletteLut(palette: DepthPalette): Uint8ClampedArray {
  const scheme = DEPTH_PALETTES.find(item => item.id === palette);
  if (scheme === undefined) throw new Error(`Unknown depth palette: ${palette}`);
  const table = new Uint8ClampedArray(256 * 3);
  if (COLORMAPS.some((map) => map.id === palette)) {
    for (let index = 0; index < 256; index++) {
      const rgb = colormapRgb(palette as ColormapId, index / 255);
      for (let channel = 0; channel < 3; channel++) table[index * 3 + channel] = Math.round(rgb[channel]! * 255);
    }
    return table;
  }
  for (let index = 0; index < 256; index++) {
    const position = index / 255 * (scheme.stops.length - 1);
    const segment = Math.min(scheme.stops.length - 2, Math.floor(position));
    const weight = position - segment;
    for (let channel = 0; channel < 3; channel++) {
      const low = scheme.stops[segment]![channel]!;
      const high = scheme.stops[segment + 1]![channel]!;
      table[index * 3 + channel] = Math.round(low + (high - low) * weight);
    }
  }
  return table;
}
