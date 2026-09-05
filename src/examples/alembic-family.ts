import { nodeGpuHost } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * THE ALEMBIC FAMILY'S SHARED MEASURING KIT (T1171).
 *
 * E58 Alembic and E59-E62 are five documents over ONE shader module. §T1171 shipped the four
 * alternate looks as their own catalogue entries — the catalogue is the product surface, and
 * a look that exists only as a row in a table is reachable rather than shown — under one
 * hard constraint: **do not duplicate what made E58 good**. One shader, imported not copied;
 * one long explanation, in E58's doc and deferred to by the others; and one measuring kit,
 * here, rather than five copies of the same `shoot()` in five claims files.
 *
 * What is NOT shared is the claim. Each file asserts the thing that distinguishes it from
 * its siblings — Vault that low `twist` makes the fold piecewise flat, Snarl that its vessel
 * has no eye, Skein that its fold elongates, Rake that depth drives the phase — because
 * "far from every other row" is already asserted once, in E58's own claims, and asserting it
 * five more times would be five tests for one fact.
 *
 * Every statistic below is scale-free: divided by the frame's OWN contrast, or a share of
 * its own gradient energy. Five looks whose exposures span 0.0035 to 0.02 cannot be compared
 * on any absolute quantity, and a statistic that moved with the ramp would be measuring the
 * palette rather than the geometry.
 */

/** The probe size for every claim in the family. 16:9, the shipped aspect. */
export const FAMILY_WIDTH = 320;
export const FAMILY_HEIGHT = 180;
/** One second in — settled, and the frame the gallery card is sourced from (§T794). */
export const FAMILY_FRAME = 60;

export interface FamilyShot {
  readonly data: Uint8Array;
  readonly luma: Float64Array;
}

/**
 * Renders one shipped file of the family with `alembic1` overridden, at the family probe
 * size. The overrides are the CONTROL: every claim here is stated against the same document
 * with one knob moved, so what is measured is that knob and not the file.
 */
export async function shootFamily(
  fileName: string,
  overrides: Record<string, unknown> = {},
  frame: number = FAMILY_FRAME,
): Promise<FamilyShot> {
  const entry = listExamples().find((file) => file.fileName === fileName);
  if (entry === undefined) throw new Error(`${fileName} is not shipped`);
  const { document } = requireExample(entry);
  const graph = structuredClone(document.graph) as GraphDocument;
  Object.assign(graph.nodes["alembic"]!.parameters as Record<string, unknown>, overrides);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { width: FAMILY_WIDTH, height: FAMILY_HEIGHT } },
    frames: frame + 1,
    capture: [frame],
    animate: true,
    fps: 60,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  // T497/§V436: `frameIndex` here is the KEY a captured frame is looked up BY, not a clock
  // anything animates from — the same case as `thumbnail.ts`, and declared alongside it in
  // `shipped-clock-audit.test.ts`. Nothing in this file moves on it; the shader's own motion
  // reads `absTime`, the clock that does NOT wrap. Copying this line is safe; copying it
  // into a shader, where `absTime` is the one you want, is not.
  const captured = result.frames.find((entry_) => entry_.frameIndex === frame);
  if (captured === undefined) throw new Error(`no captured frame ${frame}`);
  const space = result.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    {
      width: captured.width,
      height: captured.height,
      format: captured.format,
      bytes: captured.bytes,
      rowStride: captured.width * (BYTES_PER_PIXEL[captured.format] ?? 8),
    },
    { space },
  );
  const luma = new Float64Array(FAMILY_WIDTH * FAMILY_HEIGHT);
  for (let p = 0; p < luma.length; p += 1) {
    const at = p * 4;
    luma[p] =
      (0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0)) / 255;
  }
  return { data: image.data, luma };
}

const sample = (shot: FamilyShot, x: number, y: number): number =>
  shot.luma[
    Math.min(FAMILY_HEIGHT - 1, Math.max(0, y)) * FAMILY_WIDTH + Math.min(FAMILY_WIDTH - 1, Math.max(0, x))
  ] ?? 0;

/** p999 − p001 of the frame's luma: its contrast, the divisor every gradient below uses. */
export function contrastRange(shot: FamilyShot): number {
  const sorted = [...shot.luma].sort((a, b) => a - b);
  return (sorted[Math.floor(0.999 * (sorted.length - 1))] ?? 0) - (sorted[Math.floor(0.001 * (sorted.length - 1))] ?? 0);
}

/** |∇luma| per pixel, divided by the frame's own contrast so exposure cannot move it. */
function gradients(shot: FamilyShot): Float64Array {
  const scale = Math.max(contrastRange(shot), 1e-6);
  const out = new Float64Array(FAMILY_WIDTH * FAMILY_HEIGHT);
  for (let y = 0; y < FAMILY_HEIGHT; y += 1) {
    for (let x = 0; x < FAMILY_WIDTH; x += 1) {
      const dx = (sample(shot, x + 1, y) - sample(shot, x - 1, y)) * 0.5;
      const dy = (sample(shot, x, y + 1) - sample(shot, x, y - 1)) * 0.5;
      out[y * FAMILY_WIDTH + x] = Math.hypot(dx, dy) / scale;
    }
  }
  return out;
}

/**
 * p99 over median of the normalised gradient — HOW PIECEWISE-CONSTANT the frame is.
 *
 * A picture made of planes has almost no gradient over most of its area and a great deal
 * along a few creases, so the tail sits far above the middle. Fibre has gradient everywhere
 * and the ratio collapses. This is E59 Vault's statistic and it is a ratio of two quantiles
 * of the same frame, so neither the exposure nor the ramp can move it.
 */
export function edgeTail(shot: FamilyShot): number {
  const sorted = [...gradients(shot)].sort((a, b) => a - b);
  const median = sorted[Math.floor(0.5 * (sorted.length - 1))] ?? 0;
  return (sorted[Math.floor(0.99 * (sorted.length - 1))] ?? 0) / Math.max(median, 1e-9);
}

/** Share of the frame whose normalised gradient is under `threshold` — how much is FLAT. */
export function flatShare(shot: FamilyShot, threshold = 0.004): number {
  const g = gradients(shot);
  let count = 0;
  for (const value of g) if (value < threshold) count += 1;
  return count / g.length;
}

/**
 * Mean structure-tensor coherence, weighted by local gradient energy — HOW ELONGATED the
 * local structure is. One direction winning consistently inside a 7x7 window is a ribbon;
 * no direction winning is fibre or noise. E61 Skein's statistic.
 *
 * Weighted by the local energy rather than averaged flat: an empty region has a coherence,
 * it is just meaningless, and letting the black half of a frame vote would measure the
 * exposure. The weighting is what makes the number about the structure that is visible.
 */
export function elongation(shot: FamilyShot, window = 3): number {
  const gx = new Float64Array(FAMILY_WIDTH * FAMILY_HEIGHT);
  const gy = new Float64Array(FAMILY_WIDTH * FAMILY_HEIGHT);
  for (let y = 0; y < FAMILY_HEIGHT; y += 1) {
    for (let x = 0; x < FAMILY_WIDTH; x += 1) {
      gx[y * FAMILY_WIDTH + x] = (sample(shot, x + 1, y) - sample(shot, x - 1, y)) * 0.5;
      gy[y * FAMILY_WIDTH + x] = (sample(shot, x, y + 1) - sample(shot, x, y - 1)) * 0.5;
    }
  }
  let anisotropy = 0;
  let energy = 0;
  for (let y = window; y < FAMILY_HEIGHT - window; y += 1) {
    for (let x = window; x < FAMILY_WIDTH - window; x += 1) {
      let jxx = 0;
      let jyy = 0;
      let jxy = 0;
      for (let dy = -window; dy <= window; dy += 1) {
        for (let dx = -window; dx <= window; dx += 1) {
          const i = (y + dy) * FAMILY_WIDTH + (x + dx);
          const a = gx[i] ?? 0;
          const b = gy[i] ?? 0;
          jxx += a * a;
          jyy += b * b;
          jxy += a * b;
        }
      }
      const trace = jxx + jyy;
      if (trace <= 1e-9) continue;
      anisotropy += Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy);
      energy += trace;
    }
  }
  return energy === 0 ? 0 : anisotropy / energy;
}

/**
 * Mean luma of a centred disc over the mean of the whole frame — IS THERE AN EYE?
 *
 * Below 1 the middle of the picture is darker than the picture, which is a hole; above 1 it
 * is brighter, which is not. E60 Snarl's statistic, and the only one in the kit that is
 * about where light IS rather than about the shape of an edge.
 */
export function eyeRatio(shot: FamilyShot, radiusFraction = 0.18): number {
  const cx = (FAMILY_WIDTH - 1) / 2;
  const cy = (FAMILY_HEIGHT - 1) / 2;
  const r2 = (radiusFraction * FAMILY_HEIGHT) ** 2;
  let inside = 0;
  let insideCount = 0;
  let total = 0;
  for (let y = 0; y < FAMILY_HEIGHT; y += 1) {
    for (let x = 0; x < FAMILY_WIDTH; x += 1) {
      const value = sample(shot, x, y);
      total += value;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
        inside += value;
        insideCount += 1;
      }
    }
  }
  if (insideCount === 0) return 0;
  return inside / insideCount / (total / (FAMILY_WIDTH * FAMILY_HEIGHT));
}

/**
 * Share of the frame's gradient energy that runs ACROSS the rays from the frame centre —
 * HOW COMBED ALONG THE RAYS the picture is. E62 Rake's statistic.
 *
 * A streak lying along a ray has its gradient perpendicular to that ray, so the tangential
 * share rises above 0.5 exactly when structure is drawn out toward the vanishing point. The
 * innermost eighth of the frame is skipped: the radial direction is undefined at the centre
 * and numerically useless near it.
 *
 * The frame centre is the right origin and that is geometry rather than convenience: the
 * shader builds `ndc` as `(uv − 0.5) * (2*aspect, −2)`, so the direction from the frame
 * centre in PIXELS is the direction from the ray fan's axis in ndc, for any aspect.
 */
export function radialAlignment(shot: FamilyShot): number {
  const cx = (FAMILY_WIDTH - 1) / 2;
  const cy = (FAMILY_HEIGHT - 1) / 2;
  let tangential = 0;
  let radial = 0;
  for (let y = 1; y < FAMILY_HEIGHT - 1; y += 1) {
    for (let x = 1; x < FAMILY_WIDTH - 1; x += 1) {
      const px = x - cx;
      const py = -(y - cy);
      const length = Math.hypot(px, py);
      if (length < 0.12 * FAMILY_HEIGHT) continue;
      const rx = px / length;
      const ry = py / length;
      const gx = (sample(shot, x + 1, y) - sample(shot, x - 1, y)) * 0.5;
      const gy = -(sample(shot, x, y + 1) - sample(shot, x, y - 1)) * 0.5;
      const alongRadius = gx * rx + gy * ry;
      const acrossRadius = -gx * ry + gy * rx;
      radial += alongRadius * alongRadius;
      tangential += acrossRadius * acrossRadius;
    }
  }
  const total = tangential + radial;
  return total === 0 ? 0 : tangential / total;
}

/** Mean absolute luma difference between two shots. */
export function familyMeanAbsDelta(a: FamilyShot, b: FamilyShot): number {
  let sum = 0;
  for (let p = 0; p < a.luma.length; p += 1) sum += Math.abs((a.luma[p] ?? 0) - (b.luma[p] ?? 0));
  return sum / a.luma.length;
}
