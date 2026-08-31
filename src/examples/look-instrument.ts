import type { GraphDocument, ProjectSettings } from "../domain/types/graph.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import { nodeGpuHost } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";

/**
 * THE look instrument (T521, T690) — extracted from `liveness.test.ts` so the liveness
 * floors, the §V643 baselines and the baseline REGENERATOR all measure through one code
 * path. §V618 (the plan's own output space, never assumed) and §V627 (a fixed probe
 * resolution, because additive point density is resolution-dependent) are baked into
 * the instrument rather than remembered at each call site.
 */

export const PROBE_RESOLUTION = { width: 192, height: 108 } as const;

/**
 * Frames 60 and 180 — one second in, three seconds in. Both LATE (past any warm-up) and two
 * seconds apart, which is long enough that even the slowest shipped drift registers.
 */
export const CAPTURE = [0, 60, 180] as const;
export const LAST_CAPTURE = 180;

const lin = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export interface Reading {
  /** Mean |Δ| of linear luma between the two late frames. */
  readonly motion: number;
  /** p999 − p001 of the last frame's linear luma. */
  readonly range: number;
  /** The brightest linear luma anywhere in frame 0. */
  readonly firstFrameMax: number;
}

/**
 * ONE measurement path, and `animate: true` is written into it rather than passed to it.
 *
 * The colour space comes from the PLAN, never from an assumption: the Output node applies
 * the display transform, so its target already holds encoded bytes, and claiming "linear"
 * here re-encodes them — which reads a stop and a half too pale and quietly moves every
 * threshold in this file.
 */
export async function measure(
  graph: GraphDocument,
  settings: ProjectSettings,
  outputNodeId: string,
): Promise<Reading> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...settings, outputResolution: { ...PROBE_RESOLUTION } },
    frames: LAST_CAPTURE + 1,
    capture: [...CAPTURE],
    outputNodeId,
    fps: 60,
    animate: true,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`render reported: ${errors.map((d) => d.message).join("; ")}`);
  }
  const space = result.plan.outputs.find((o) => o.nodeId === outputNodeId)?.space ?? "linear";
  const lumaOf = (index: number): Float64Array => {
    const frame = result.frames[index];
    if (frame === undefined) throw new Error(`no captured frame at index ${index}`);
    const image = toRgba8(
      {
        width: frame.width,
        height: frame.height,
        format: frame.format,
        bytes: frame.bytes,
        rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8),
      },
      { space },
    );
    const out = new Float64Array(image.data.length / 4);
    for (let at = 0, pixel = 0; at < image.data.length; at += 4, pixel += 1) {
      out[pixel] =
        0.2126 * lin(image.data[at] ?? 0) +
        0.7152 * lin(image.data[at + 1] ?? 0) +
        0.0722 * lin(image.data[at + 2] ?? 0);
    }
    return out;
  };

  const first = lumaOf(0);
  const early = lumaOf(1);
  const late = lumaOf(2);

  let sum = 0;
  for (let pixel = 0; pixel < late.length; pixel += 1) {
    sum += Math.abs((late[pixel] ?? 0) - (early[pixel] ?? 0));
  }
  const sorted = Float64Array.from(late).sort();
  const at = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  let firstFrameMax = 0;
  for (const value of first) if (value > firstFrameMax) firstFrameMax = value;

  return {
    motion: sum / Math.max(1, late.length),
    range: at(0.999) - at(0.001),
    firstFrameMax,
  };
}


/** `E4 Bloom` → `E4-Bloom.loom.json`, the same derivation `buildProjectFile` uses. */
export function exampleFileNameOf(name: string): string {
  return `${name.replace(/\s+/g, "-")}.loom.json`;
}
