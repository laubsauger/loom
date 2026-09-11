import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E69 BURNISH — THE GATE THE BRDF NEVER HAD.
 *
 * §T1284 gave `materialPbr` a real GGX/Smith lobe and §T1289 made roughness blur the
 * environment instead of dimming it, and until this file NOTHING SHIPPED RENDERED EITHER —
 * zero of 59 examples used the material. That is not a coverage statistic, it is how the
 * §V960 twin hid: the shader declared `environmentMap` while five separate sites decided
 * whether to bind it, T1284 moved one of them, and no shipped frame could show the
 * disagreement.
 *
 * So these claims are chosen for what would break SILENTLY rather than for what is easy to
 * measure, and each names the defect it is for.
 */

function e69() {
  const file = listExamples().find((entry) => entry.fileName === "E69-Burnish.loom.json");
  if (file === undefined) throw new Error("E69-Burnish.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

interface Frame {
  readonly w: number;
  readonly h: number;
  readonly d: Uint8Array | Uint8ClampedArray;
}

async function shoot(mutate: (graph: GraphDocument) => void = () => {}): Promise<Frame> {
  const { document, result } = e69();
  const graph = structuredClone(document.graph) as GraphDocument;
  mutate(graph);
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: document.settings,
    frames: 1,
    capture: [0],
    animate: true,
    outputNodeId: "out",
    ...(result.components ? { components: result.components } : {}),
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  const space = rendered.plan.outputs.find((output) => output.nodeId === "out")?.space ?? "linear";
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
  return { w: image.width, h: image.height, d: image.data };
}

const luma = (frame: Frame, pixel: number): number =>
  0.2126 * (frame.d[pixel * 4] ?? 0) + 0.7152 * (frame.d[pixel * 4 + 1] ?? 0) + 0.0722 * (frame.d[pixel * 4 + 2] ?? 0);

/**
 * A window per ball, as a fraction of the frame so the claims survive a resolution change.
 *
 * ⚑ THE CENTRES ARE SOLVED FROM THE CAMERA, NOT GUESSED. The balls sit at x = −3.3, −1.1,
 * 1.1, 3.3 with the eye at z = 8.4 and a 38° vertical fov, so on a 16:9 frame the
 * horizontal half-angle is atan(tan(19°) × 16/9) and each ball lands at
 * 0.5 ± tan(atan(x / 8.4)) / tan(that). My first cut eyeballed them at 0.235 / 0.41 and the
 * windows straddled the balls' edges, which put BACKGROUND in the sample — and background
 * is high-contrast, so the brushed ball measured MORE varied than the mirror and the ladder
 * came out non-monotonic. A statistic taken through the wrong window is not a weak claim,
 * it is a claim about something else.
 */
function ballStats(frame: Frame, index: number): { mean: number; cv: number } {
  const cx = Math.floor((BALL_CENTRES[index] ?? 0.5) * frame.w);
  const cy = Math.floor(frame.h * 0.46);
  const radius = Math.floor(frame.w * 0.03);
  const values: number[] = [];
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      values.push(luma(frame, y * frame.w + x));
    }
  }
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return { mean, cv: Math.sqrt(variance) / Math.max(mean, 1e-6) };
}

/** Solved from the camera: see `ballStats`. */
const BALL_CENTRES = [0.179, 0.393, 0.607, 0.821];

const MIRROR = 0;
const BRUSHED = 1;
const ROUGH = 2;

describe("E69 Burnish — the BRDF, rendered by something shipped (T1290)", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /**
   * §V960's TWIN, CAUGHT: a pbr material with an environment wired RECEIVES it.
   *
   * The defect this is for is precise. The shader generator decides whether to DECLARE
   * `environmentMap`; `scene.ts` decides, at five separate sites, whether to BIND it. Both
   * spelled the same rule independently, §T1284 changed one of them, and the mismatch could
   * not surface because no shipped example rendered a pbr material with an environment.
   *
   * Cutting the environment's intensity has to change a metal, and by a lot: a metal has no
   * diffuse lobe, so with the environment gone there is nothing left but one directional
   * highlight. If the binding is ever lost again, the wired and unwired arms become the same
   * picture and this fails.
   */
  it("a pbr metal loses most of its light when the environment is cut", async () => {
    const wired = await shoot();
    const unwired = await shoot((graph) => {
      const shot = graph.nodes["shot"];
      if (shot === undefined) throw new Error("E69 has no `shot` node");
      (shot.parameters as Record<string, unknown>)["environmentIntensity"] = 0;
    });
    const litMirror = ballStats(wired, MIRROR).mean;
    const darkMirror = ballStats(unwired, MIRROR).mean;
    expect(litMirror).toBeGreaterThan(darkMirror * 2);
  }, 300_000);

  /**
   * §T1289's CLAIM, AS A PICTURE: roughness BLURS the reflection, it does not DIM it.
   *
   * Three balls, same base colour, same metallic, same everything — only `roughness` moves.
   * The shipped behaviour before T1289 multiplied the environment term by `(1 − roughness)`,
   * so the rough ball would have been the mirror's picture SCALED. That fails here in both
   * directions at once, which is why both are asserted:
   *
   *  - the STRUCTURE collapses: the mirror carries the sky's horizon band and the rough one
   *    does not, so its coefficient of variation is far lower;
   *  - the LIGHT survives: a blur redistributes energy rather than removing it, where a dim
   *    takes the rough ball to near black.
   */
  it("the roughness ladder blurs rather than dims", async () => {
    const frame = await shoot();
    const mirror = ballStats(frame, MIRROR);
    const brushed = ballStats(frame, BRUSHED);
    const rough = ballStats(frame, ROUGH);

    // The mirror has structure to lose: it is reflecting a sky with an edge in it.
    // Measured 0.327 against the rough ball's 0.062.
    expect(mirror.cv).toBeGreaterThan(0.25);
    // And it goes, monotonically, as roughness rises.
    expect(brushed.cv).toBeLessThan(mirror.cv);
    expect(rough.cv).toBeLessThan(brushed.cv);
    /* THE HALF A DIMMER FAILS. A `(1 − roughness)` scale would put the rough ball at
       roughly a tenth of the mirror's brightness; a blur keeps it in the same range. */
    expect(rough.mean).toBeGreaterThan(mirror.mean * 0.45);
  }, 300_000);

  /**
   * `metallic` MEANS SOMETHING, and it is only legible as a comparison.
   *
   * The dielectric carries a diffuse half that the metals do not, because `(1 − metallic)`
   * is a hard zero on the only term the albedo multiplies — that is the energy split
   * §T1284 added, and this is the one frame in the catalogue where it can be seen.
   * Asserted through its own base colour rather than through brightness: the dielectric is
   * blue and the metals are near-white, so a diffuse half means the blue channel leads.
   */
  it("the dielectric keeps a diffuse half the metals have none of", async () => {
    const frame = await shoot();
    const sample = (index: number): { r: number; b: number } => {
      const cx = Math.floor((BALL_CENTRES[index] ?? 0.5) * frame.w);
      const cy = Math.floor(frame.h * 0.46);
      const at = (cy * frame.w + cx) * 4;
      return { r: frame.d[at] ?? 0, b: frame.d[at + 2] ?? 0 };
    };
    const dielectric = sample(3);
    const metal = sample(ROUGH);
    // The body colour shows: blue leads red on the dielectric.
    expect(dielectric.b).toBeGreaterThan(dielectric.r);
    // And it does not on a near-white metal, whose colour is the environment's.
    expect(metal.b - metal.r).toBeLessThan(dielectric.b - dielectric.r);
  }, 300_000);
});
