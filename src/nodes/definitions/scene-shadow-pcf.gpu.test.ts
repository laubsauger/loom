import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { srgbToLinear } from "../../runtime/export/pixel-format.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1285 — PCF ON THE SHADOW MAPS, and the claim is a RAMP rather than "it got softer".
 *
 * The thing this gate exists to exclude is the cheap pass: a shadow that is merely DIMMER,
 * or a frame that is merely BLURRIER, reads as "softer" to every eye and to almost every
 * metric. So the fixture is built so that the answer is arithmetic rather than impression,
 * and every number below is derived from the scene, not read off the render:
 *
 *  - The key travels [1, −1, 0], i.e. 45° in the x-y plane, so the shadow map's own "up"
 *    axis is world (0.7071, 0.7071, 0) and its "right" axis is world z. A displacement of
 *    Δ along world x therefore moves 0.7071·Δ across the map's up axis.
 *  - `shadowExtent` 4 (EXPLICIT — §V426, never auto-fit) frames 2·4 = 8 world units across
 *    a map that is `scale: 2` of a 128px render, i.e. 256 texels: ONE SHADOW TEXEL IS
 *    8/256 = 0.03125 world units across the light, = 0.03125/0.7071 = 0.044194 along world x.
 *  - The camera is ORTHOGRAPHIC, straight down, `orthoHeight` 0.5 over 128 pixels: ONE OUTPUT
 *    PIXEL IS 0.5/128 = 0.00390625 world units along x. So one shadow texel is exactly
 *    0.044194/0.00390625 = 11.3137 output pixels — the map is COARSER than the screen here,
 *    which is what makes a texel-wide step visible at all.
 *  - The occluder is a unit box spanning x ∈ [−3, −1], y ∈ [0, 2]. Under a 45° key the
 *    shadow of a point (x, y) lands at x + y, so the shadow's leading edge is cast by the
 *    box's TOP-FRONT edge at (−1, 2): a straight edge parallel to world z, landing at
 *    x = 1, THROWN FROM 2.0 WORLD UNITS ABOVE THE FLOOR IT LANDS ON. The camera frames
 *    x ∈ [0.75, 1.25] with that edge dead centre, and the box itself is off-frame — nothing in
 *    the picture but floor, half of it in shadow.
 *
 * Under that arrangement a (2r+1)² box kernel over the map has an exactly predictable
 * answer, because the edge is perpendicular to the kernel's oy axis: a receiver k texels
 * inside the edge has exactly k of its 2r+1 tap COLUMNS lit, so the shadow term steps
 * through k/(2r+1) for k = 0…2r+1 — 2r intermediate levels, each one texel (11.31 pixels)
 * wide, monotone. The level assertion below pins those fractions to ±0.005 after decoding the
 * output's own transfer, which is a claim NOTHING dimmer-but-still-hard can pass and nothing
 * merely blurred can pass either: a blur would put the levels at a filter's weights, and a
 * dimming would put ONE wrong constant across the whole shadow instead of a staircase.
 *
 * ## The three things asserted beside the ramp, and why each is not optional
 *
 * 1. **The PLATEAUS are bit-identical across every softness.** Fully-lit floor and
 *    fully-occluded floor read the same float at r = 0, 1, 2 and 3 (25/25 and 0/25 are
 *    exactly 1.0 and 0.0). This is the half that separates SOFTNESS from DIMMING: the
 *    shadow did not get lighter and the light did not get darker, the transition between
 *    them got wider. Without it the ramp claim alone would still pass a build that lifted
 *    the shadow floor.
 * 2. **r = 0 is a STEP — zero intermediate pixels in the whole frame.** This is the
 *    red-verify built in rather than performed once and forgotten (§V461's control): pin
 *    the kernel to one tap and the ramp claim has nothing to measure. It also pins the
 *    §V309 promise that Shadow Softness 0 emits the pre-T1285 shader.
 * 3. **NO ACNE — every floor pixel outside the penumbra is exactly one of the two
 *    plateaus.** This is the guard against the cause, and the cause is real and was
 *    measured here: a wider kernel compares the receiver's own depth against stored depths
 *    r texels away, and on a plane those differ by r × the per-texel depth growth. With
 *    T624's slope term left unscaled, r = 2 speckled this floor with 24/25 pixels and r = 3
 *    darkened ALL of it by ~5% — PCF self-shadowing wearing a penumbra's clothes. The fix
 *    scales that term (and only that term) by the kernel's reach r+1; this assertion is
 *    what would notice it being dropped, and the ramp above is the legitimate case it
 *    could otherwise swallow by simply flattening everything to "lit".
 */

const SIZE = 128;

/**
 * The camera frames 0.5 world units square around the edge at x = 1. Deliberately TIGHT:
 * the occluder is a unit box, so its shadow is only 2 units deep in z, and a frame that
 * reached that depth would sample lit taps past the shadow's own z end in its first and
 * last rows — an edge effect of the FIXTURE, not of the kernel, and one that would have
 * to be excused rather than asserted.
 */
const ORTHO_HEIGHT = 0.5;

/** One shadow texel in output pixels — derived in the docblock above, not measured. */
const PIXELS_PER_TEXEL = 0.03125 / Math.SQRT1_2 / (ORTHO_HEIGHT / SIZE);

const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}, label?: string): GraphNode {
  return {
    id,
    type,
    definitionVersion: registry.get(type)?.version ?? 1,
    position: { x: 0, y: 0 },
    parameters,
    ...(label === undefined ? {} : { label }),
  };
}

const ATTRS = '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]';

/** The grid lies down: xy becomes xz, the floor is the world's ground plane (E28's idiom). */
const FLOOR_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, 0.0, p.position.y);
  return q;
}`;

/* One box, centred at (−2, 1, 0) with half-extent 1 — so x ∈ [−3, −1], y ∈ [0, 2], and the
   edge that casts the measured shadow is its top-front one, 2.0 units above the floor. */
const BOX_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(-2.0, 1.0, 0.0);
  return q;
}`;

function graphFor(softness: number): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("fpts", "pointGrid", { cols: 16, rows: 16, count: 256, sizeX: 16, sizeY: 16 }, "fpts1"),
        node("flay", "pointKernel", { capacity: 256, attributes: ATTRS, kernel: FLOOR_KERNEL }, "flay1"),
        node("floor", "geometry", { mode: "surface", material: "mat1" }, "floor1"),
        node("bpt", "pointGrid", { cols: 1, rows: 1, count: 1, sizeX: 1, sizeY: 1 }, "bpt1"),
        node("blay", "pointKernel", { capacity: 1, attributes: ATTRS, kernel: BOX_KERNEL }, "blay1"),
        node("box", "geometry", { mode: "instances", shape: "box", scale: 1, material: "mat1" }, "box1"),
        /* §V617: an UNLIT primitive casts no shadow, so the caster has to be lit. Specular
           is BLACK on purpose — an ortho camera still has a point eye, so a highlight would
           vary along the scan line and every level below would carry a gradient. */
        node("mat", "materialPhong", { color: [1, 1, 1, 1], specular: [0, 0, 0, 1], shininess: 10, roughness: 1 }, "mat1"),
        node("cam", "camera", { eye: [1, 6, 0], lookAt: [1, 0, 0], ortho: true, orthoHeight: 0.5, near: 0.1, far: 40 }, "cam1"),
        node(
          "key",
          "light",
          {
            kind: "directional",
            direction: [1, -1, 0],
            color: [1, 1, 1, 1],
            intensity: 1,
            shadows: true,
            /* §V426: an EXPLICIT volume, and the texel size the whole gate is scaled by. */
            shadowExtent: 4,
            shadowSoftness: softness,
          },
          "key1",
        ),
        node(
          "shot",
          "render",
          {
            scenes: "floor1 box1",
            camera: "cam1",
            lights: "key1",
            ambientColor: [1, 1, 1, 1],
            ambientIntensity: 0.2,
            background: [0, 0, 0, 1],
          },
          "shot1",
        ),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "fpts", portId: "out" }, target: { nodeId: "flay", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "flay", portId: "out" }, target: { nodeId: "floor", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "bpt", portId: "out" }, target: { nodeId: "blay", portId: "in" } },
      e4: { id: "e4", source: { nodeId: "blay", portId: "out" }, target: { nodeId: "box", portId: "points" } },
      e5: { id: "e5", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

/**
 * The frame's red channel, LINEAR. The material is white and the light is white, so red is
 * the whole story; the transfer comes from the PLAN'S OWN declared output space (§V618)
 * rather than being assumed, and the assertion below fails loudly if that space changes —
 * decoding a linear buffer would bend the ramp into a curve and quietly weaken the claim.
 */
async function renderLinear(softness: number): Promise<Float64Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const plan = compileGraph({ graph: graphFor(softness), settings, registry, capabilities });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const output = plan.outputs.find((entry) => entry.nodeId === "out");
    expect(output?.space, "the gate decodes the output's transfer; an unexpected space bends the ramp").toBe(
      "encoded",
    );
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    const image = await backend.readOutput(output?.resourceId ?? "");
    const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    const out = new Float64Array(image.width * image.height);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        out[y * image.width + x] = srgbToLinear(halfFloat(view.getUint16(y * image.rowStride + x * 8, true)));
      }
    }
    return out;
  } finally {
    backend.dispose();
  }
}

/** The scan: the frame's middle row, oriented so it runs FULLY LIT → FULLY OCCLUDED. */
function scanline(frame: Float64Array): number[] {
  const row = Array.from(frame.slice((SIZE / 2) * SIZE, (SIZE / 2 + 1) * SIZE));
  return (row[0] as number) >= (row[SIZE - 1] as number) ? row : row.reverse();
}

describe("T1285: PCF gives the shadow a monotone penumbra, not a dimmer shadow", () => {
  it("steps the edge through the kernel's own coverage fractions, over 2r texels, and leaves both plateaus alone", async () => {
    // Required, never skipped: a skip on a machine without a GPU turns the only test that
    // can see a soft shadow into a green tick.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const frames = new Map<number, Float64Array>();
    for (const softness of [0, 1, 2, 3]) frames.set(softness, await renderLinear(softness));

    const hard = scanline(frames.get(0) as Float64Array);
    const lit = hard[0] as number;
    const dark = hard[SIZE - 1] as number;
    // The fixture is lit at all, and the shadow is a shadow: half the frame each way.
    expect(lit).toBeGreaterThan(dark * 2);

    /* THE CONTROL, and the red-verify that stays in the tree (§V461): with the kernel
       pinned to one tap the edge is a STEP — not one pixel anywhere in the frame sits
       between the two plateaus. Every claim below is about pixels that do not exist here. */
    const between = (frame: Float64Array): number =>
      Array.from(frame).filter((v) => v > dark + (lit - dark) * 0.02 && v < lit - (lit - dark) * 0.02).length;
    expect(between(frames.get(0) as Float64Array), "Shadow Softness 0 must still be a hard edge").toBe(0);

    for (const radius of [1, 2, 3]) {
      const frame = frames.get(radius) as Float64Array;
      const row = scanline(frame);
      const taps = 2 * radius + 1;
      const where = `radius ${radius}`;

      /* SOFTNESS, NOT DIMMING — the two plateaus are the hard render's, bit for bit. A
         kernel that averaged in ambient, lifted the shadow floor or shaded the lit floor
         down would fail here while passing every "the edge is softer" measure there is. */
      expect(row[0], `${where}: the fully-lit floor moved`).toBe(lit);
      expect(row[SIZE - 1], `${where}: the fully-occluded floor moved`).toBe(dark);

      /* The penumbra: the contiguous run that is neither plateau. It must be exactly one
         run — two would mean acne somewhere else in the scan. */
      const inside = row.map((v) => v > dark + (lit - dark) * 0.02 && v < lit - (lit - dark) * 0.02);
      const first = inside.indexOf(true);
      const last = inside.lastIndexOf(true);
      expect(first, `${where}: no penumbra at all`).toBeGreaterThan(0);
      expect(inside.slice(first, last + 1).every(Boolean), `${where}: the penumbra is not contiguous`).toBe(true);

      /* WIDER THAN A TEXEL, and by the derived amount: 2r intermediate texels between the
         plateaus, 11.3137 output pixels each. ±1 pixel for where the quantised tap centre
         falls. A hard edge is 0 here, so "more than one texel" is the floor, not the bar. */
      const width = (last - first + 1) / PIXELS_PER_TEXEL;
      expect(width, `${where}: penumbra ${width.toFixed(2)} texels, expected ${2 * radius}`).toBeGreaterThan(1);
      expect(Math.abs(width - 2 * radius), `${where}: penumbra ${width.toFixed(2)} texels`).toBeLessThan(
        1 / PIXELS_PER_TEXEL + 0.5,
      );

      /* MONOTONE across it — a ramp, in one direction, with no reversal. */
      for (let x = first; x <= last; x += 1) {
        expect(row[x], `${where}: the penumbra reverses at pixel ${x}`).toBeLessThanOrEqual(row[x - 1] as number);
      }

      /* THE LEVELS ARE THE KERNEL'S OWN COVERAGE FRACTIONS. The edge is perpendicular to
         the kernel's oy axis, so a receiver k texels inside it has exactly k of its 2r+1
         tap COLUMNS lit — the shadow term can only be k/(2r+1). Every distinct value in the
         penumbra must be one of those, and all 2r of them must appear: that is the claim a
         blur (a filter's weights) and a dimming (one constant) both fail. */
      const levels = [...new Set(row.slice(first, last + 1).map((v) => (v - dark) / (lit - dark)))].sort(
        (a, b) => a - b,
      );
      const expected = Array.from({ length: taps - 1 }, (_, k) => (k + 1) / taps);
      expect(levels.length, `${where}: ${levels.length} levels, expected ${taps - 1}`).toBe(taps - 1);
      levels.forEach((level, at) => {
        expect(level, `${where}: level ${at} is ${level.toFixed(4)}, expected ${(expected[at] as number).toFixed(4)}`).toBeCloseTo(
          expected[at] as number,
          2,
        );
      });

      /* NO ACNE (see the docblock): the penumbra's pixel count is the ONLY intermediate
         content in the frame. The floor is a plane, so with the slope bias left at its
         r = 0 reach every lit pixel would take occluded taps from its own surface — which
         is what this counted before the reach term went in (r = 2 speckled, r = 3 washed). */
      const rows = frame.length / SIZE;
      expect(between(frame), `${where}: intermediate pixels outside the penumbra — PCF self-shadowing`).toBe(
        (last - first + 1) * rows,
      );
    }
  }, 300_000);
});
