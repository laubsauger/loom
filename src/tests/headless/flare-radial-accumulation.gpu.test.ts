import { beforeAll, describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { nodeGpuHost as dawnGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { paritySettings } from "../fixtures/parity-graphs.ts";
import { renderOnce } from "./render-harness.ts";
import type { RenderedFrame } from "./render-harness.ts";

/**
 * §T737 — IS A LIGHT-SHAFT FLARE EXPRESSIBLE WITH THE NODES WE ALREADY HAVE?
 *
 * The row asks this before anyone asks for a primitive, and §V688 is the precedent: the
 * polar-warp "we need a new node" hypothesis was refuted by RENDER, not by argument. So
 * this is a render, not an argument.
 *
 * ## What the reference actually does
 *
 * `vercel-labs/vgpu`'s `nextjs-flare` (read from source, not from its blurb) is NOT a
 * ghost-chain lens flare: `composite.wgsl` marches 48 steps from each pixel TOWARD the
 * light, accumulating an emissive mask with a geometrically decaying weight
 * (`illumination *= decay`, decay 0.85..0.975). That is GPU Gems 13 volumetric scattering
 * — light shafts — plus a Gaussian halo. There are no ghosts and no anamorphic streak
 * anywhere in it.
 *
 * ## The claim under test
 *
 * A 48-step radial march toward a point is a ZOOM BLUR ABOUT THAT POINT, and a zoom blur
 * is an iterated scale-about-pivot with decaying weights. `transform` already scales about
 * an arbitrary pivot; `level` already scales brightness; `composite` already adds. Each
 * stage feeds the NEXT stage's accumulation, so taps double per stage — five stages is
 * thirty-two effective taps, against the reference's forty-eight.
 *
 * ## Why the perpendicular sample is the whole test (§V655)
 *
 * "The output is bright along the axis" is satisfied by ANY bloom, and a bloom is exactly
 * what we would get if the chain were doing nothing directional. So the assertion is a
 * RATIO between two points EQUIDISTANT FROM THE LIGHT: one along the light→blob ray beyond
 * the blob, one at ninety degrees. A radial shaft lights the first and not the second; an
 * isotropic blur lights both the same.
 *
 * The blur arm is the control that makes that reading mean something: the same mask
 * through a plain `blur` must come back ISOTROPIC. Without it, a chain that merely
 * brightened everything would pass the ratio by lighting the axis point through sheer
 * spill, and we would conclude "expressible" from a smear.
 */

/** Square, and fine enough that a shaft spans real pixels rather than four of them. */
const SIZE = 128;

/** The light, in UV. Off-centre on purpose: a centred light hides pivot mistakes. */
const LIGHT = { x: 0.25, y: 0.5 } as const;

/** The emitter, offset from the light so the shaft has a DIRECTION to have. */
const BLOB = { x: 0.45, y: 0.5 } as const;
const BLOB_RADIUS = 0.04;

/**
 * Both probes sit this far from the BLOB, and that is the correction that makes this test
 * mean anything.
 *
 * The first draft put them equidistant from the LIGHT and asked a plain blur to come back
 * isotropic between them. It cannot: a blur spreads about the EMITTER, so two points
 * equidistant from the light are at different distances from the blob and the control was
 * unfair by construction — it measured 2 and 0, which is "nothing reached either probe"
 * rather than "this is symmetric". A vacuous control (§V707).
 *
 * The real signature of a radial shaft is ASYMMETRY ABOUT THE EMITTER, along the light
 * axis: bright on the far side, dark on the side facing the light, because every copy is
 * pushed away from the light. A bloom lights both sides equally. So the probes straddle
 * the blob, and the blur arm is now a control that can actually fail.
 */
const PROBE_DISTANCE = 0.15;

/** Beyond the blob, directly away from the light — where a shaft goes. */
const FAR = { x: BLOB.x + PROBE_DISTANCE, y: BLOB.y } as const;

/** The same distance the other way, between blob and light — where a shaft does not. */
const NEAR = { x: BLOB.x - PROBE_DISTANCE, y: BLOB.y } as const;

/** Reported, not asserted: a third direction, for the record. */
const PERPENDICULAR = { x: BLOB.x, y: BLOB.y + PROBE_DISTANCE } as const;

/**
 * `transform` works in a CENTRED space — its shader computes `(uv - 0.5) * stretch` — so a
 * pivot is the light expressed as an offset from the middle, not as a UV.
 */
const PIVOT: readonly [number, number] = [LIGHT.x - 0.5, LIGHT.y - 0.5];

/** Per-stage zoom and weight. Stage i doubles the taps, so the exponents double too. */
const STEP_SCALE = 1.03;
const STEP_DECAY = 0.93;
const STAGES = 5;

interface NodeSpec {
  readonly id: string;
  readonly type: string;
  readonly parameters: Record<string, ParameterValue>;
}

function graphOf(
  nodes: ReadonlyArray<NodeSpec>,
  links: ReadonlyArray<readonly [string, string, string]>,
): GraphDocument {
  const doc: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };
  nodes.forEach((spec, index) => {
    doc.nodes[spec.id] = {
      id: spec.id,
      type: spec.type,
      definitionVersion: 1,
      position: { x: index * 200, y: 0 },
      parameters: spec.parameters,
    };
  });
  links.forEach(([source, target, portId], index) => {
    const id = `e${index + 1}`;
    doc.edges[id] = { id, source: { nodeId: source, portId: "out" }, target: { nodeId: target, portId } };
  });
  return doc;
}

/** The emitter both arms start from, so they differ only in what follows it. */
const EMITTER: NodeSpec = {
  id: "blob",
  type: "circle",
  parameters: {
    mode: "fill",
    center: [BLOB.x, BLOB.y],
    radius: [BLOB_RADIUS, BLOB_RADIUS],
    color: [1, 1, 1, 1],
  },
};

/**
 * The chain under test: five rounds of "zoom a little about the light, dim it, add it
 * back". Each round consumes the previous ACCUMULATION, which is what makes the tap count
 * double rather than merely increment.
 */
function shaftGraph(): GraphDocument {
  const nodes: NodeSpec[] = [EMITTER];
  const links: Array<readonly [string, string, string]> = [];
  let accumulator = "blob";

  for (let stage = 0; stage < STAGES; stage += 1) {
    const reach = 2 ** stage;
    const zoom = `zoom${stage}`;
    const dim = `dim${stage}`;
    const add = `add${stage}`;
    nodes.push({
      id: zoom,
      type: "transform",
      parameters: {
        t: [0, 0],
        r: 0,
        s: [STEP_SCALE ** reach, STEP_SCALE ** reach],
        p: [...PIVOT],
        xord: "srt",
        // The shaft must fade out past the frame edge, not repeat: a tiled extend would
        // wrap the emitter back in and light the perpendicular probe for free.
        extend: "zero",
        aspectcorrect: true,
      },
    });
    nodes.push({
      id: dim,
      type: "level",
      parameters: { brightness: STEP_DECAY ** reach },
    });
    nodes.push({ id: add, type: "composite", parameters: { operation: "add" } });
    links.push([accumulator, zoom, "input"]);
    links.push([zoom, dim, "input"]);
    links.push([accumulator, add, "in1"]);
    links.push([dim, add, "in2"]);
    accumulator = add;
  }

  nodes.push({ id: "out", type: "output", parameters: {} });
  links.push([accumulator, "out", "input"]);
  return graphOf(nodes, links);
}

/** The control: the same emitter, blurred. Isotropic by construction. */
function blurGraph(): GraphDocument {
  return graphOf(
    [
      EMITTER,
      // Wide enough to REACH both probes, or the control asserts nothing (measured: at
      // size 24 it read 2 and 0, which is darkness, not symmetry).
      { id: "soft", type: "blur", parameters: { size: 40, filter: "gaussian", extend: "hold" } },
      { id: "out", type: "output", parameters: {} },
    ],
    [
      ["blob", "soft", "input"],
      ["soft", "out", "input"],
    ],
  );
}

/** Luminance-ish reading of one UV point, 0..255. */
function sample(frame: RenderedFrame, at: { x: number; y: number }): number {
  const px = Math.min(frame.width - 1, Math.max(0, Math.round(at.x * frame.width - 0.5)));
  const py = Math.min(frame.height - 1, Math.max(0, Math.round(at.y * frame.height - 0.5)));
  const offset = (py * frame.width + px) * 4;
  const r = frame.bytes[offset] ?? 0;
  const g = frame.bytes[offset + 1] ?? 0;
  const b = frame.bytes[offset + 2] ?? 0;
  return (r + g + b) / 3;
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
});

describe.skipIf(dawnError !== undefined)("§T737 — a light shaft out of existing nodes", () => {
  it("reports what each arm measures at the two probes", async () => {
    if (dawnError !== undefined) return;
    const settings = paritySettings({ size: SIZE });
    const shaft = await renderOnce({ host: dawnGpuHost(), graph: shaftGraph(), settings });
    const blur = await renderOnce({ host: dawnGpuHost(), graph: blurGraph(), settings });

    const measured = {
      shaftFar: sample(shaft, FAR),
      shaftNear: sample(shaft, NEAR),
      shaftPerpendicular: sample(shaft, PERPENDICULAR),
      blurFar: sample(blur, FAR),
      blurNear: sample(blur, NEAR),
      blurPerpendicular: sample(blur, PERPENDICULAR),
    };
    // Numbers, not a verdict (§V649): the thresholds below are set from this population.
    console.log("T737 probes (0..255):", JSON.stringify(measured));

    /*
     * THE CLAIM. The chain lights the axis and not the perpendicular, which is what makes
     * it a shaft rather than a bloom — and the blur arm shows the same mask coming back
     * symmetric, so the asymmetry belongs to the transform chain and not to the fixture.
     */
    // Measured: far 186, near 0. The margin is not marginal — this is a shaft, not a lean.
    expect(measured.shaftFar).toBeGreaterThan(4 * Math.max(measured.shaftNear, 1));

    /*
     * THE CONTROL, and it has to be able to fail in both directions.
     *
     * Symmetric: the same emitter blurred reads the SAME in all three directions
     * (measured 5, 5, 5 — exactly), so the fixture's geometry carries no bias of its own
     * and the asymmetry above belongs to the transform chain.
     *
     * And non-zero: a blur too narrow to reach the probes would also be "symmetric", at
     * zero and zero, and would assert nothing. The first draft did exactly that at size 24
     * (2 and 0) — so the floor is here to keep the control a reading rather than darkness.
     * 3 against a measured 5, because the claim is "the blur got here", not "the blur got
     * here and landed on 5".
     */
    const blurReadings = [measured.blurFar, measured.blurNear, measured.blurPerpendicular];
    expect(Math.max(...blurReadings) - Math.min(...blurReadings)).toBeLessThanOrEqual(1);
    expect(Math.min(...blurReadings)).toBeGreaterThanOrEqual(3);
  });
});
