import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { sceneInstancesWgsl, shadowInstancesWgsl } from "../shaders/scene-render.wgsl.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * T723 — PER-INSTANCE ORIENTATION, gated in §B132's pair shape and pinned to the DOMAIN.
 *
 * §B132 is why the pair shape exists: a per-point size that was silently inert passed
 * every test that only asked "does this render". So the pixel gate below asks three
 * things at once — the two orientations differ FROM EACH OTHER, and each differs from an
 * unmapped CONTROL. The second half is what catches a rotation dropped on the floor,
 * which is exactly the failure §B132 shipped.
 *
 * §V683 is why the sign is pinned to a fact about the WORLD rather than to my own
 * arithmetic. A gate that re-derives the author's quaternion maths agrees with an
 * inverted rotation as happily as with a correct one — a lens shift went out inverted
 * that way with every unit test agreeing. So the claim here is geometric and external:
 *
 *   A quad lies in the XY plane. Turned +45° about +X, its TOP edge swings toward +Z.
 *   The camera is at +Z. A perspective camera magnifies what is nearer, so the top edge
 *   of that quad subtends MORE than its bottom edge, and the lit centroid rides UP the
 *   frame. Turned −45°, the bottom edge is the near one and the centroid rides DOWN.
 *
 * Invert the rotation and the two centroids swap, which this sees. Drop the rotation and
 * they collapse onto the control, which this also sees. Neither is recoverable from
 * "it rendered something".
 */

const CAPABILITIES = {
  tier: "B" as const,
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"] as const,
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const SETTINGS = {
  outputResolution: { width: 256, height: 256 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

/**
 * Two quads, side by side, turned OPPOSITE ways about +X. The kernel writes the
 * quaternions directly rather than deriving them, so what is under test is the render
 * path and not a kernel's trigonometry.
 *
 * sin(22.5°) = 0.38268343, cos(22.5°) = 0.92387953 — a HALF-angle, because a quaternion
 * carries the half angle. That is itself a place a sign or a factor of two hides, which
 * is why the assertion below is about where pixels land and not about these numbers.
 */
const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
]);

const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let left = ctx.index == 0u;
  q.position = vec3f(select(0.9, -0.9, left), 0.0, 0.0);
  /* +45 degrees about +X on the LEFT, -45 on the RIGHT. */
  let s = select(-0.38268343, 0.38268343, left);
  q.orient = vec4f(s, 0.0, 0.0, 0.92387953);
  return q;
}`;

/** ONE quad, ON AXIS, turned +45° about +X — the oblique-view shear removed. */
const CENTRED_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(0.0, 0.0, 0.0);
  q.orient = vec4f(0.38268343, 0.0, 0.0, 0.92387953);
  return q;
}`;

function graphFor(options: { readonly orient: boolean; readonly centred?: boolean; readonly lit?: boolean }): GraphDocument {
  const orientSlot = options.orient
    ? {
        orient: {
          mode: "map" as const,
          bindings: {
            static: { kind: "static" as const, value: [0, 0, 0, 1] },
            map: { kind: "map" as const, attribute: "orient" },
          },
        },
      }
    : {};
  return {
    revision: 1,
    nodes: {
      gen: {
        id: "gen", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { capacity: options.centred === true ? 1 : 2, seed: 7, group: "", attributes: ATTRIBUTES, kernel: options.centred === true ? CENTRED_KERNEL : KERNEL, value1: 0, value2: 0, value3: 0, value4: 0 },
        label: "gen1",
      },
      mat: options.lit === true
        ? {
            id: "mat", type: "materialPhong", definitionVersion: 1, position: { x: 0, y: 0 },
            /* No specular: a highlight would move with the turn too and muddy a claim
               that is meant to be purely N·L. */
            parameters: { color: [1, 1, 1, 1], specular: [0, 0, 0, 1], shininess: 2, roughness: 1 },
            label: "mat1",
          }
        : {
            id: "mat", type: "materialUnlit", definitionVersion: 1, position: { x: 0, y: 0 },
            parameters: { color: [1, 1, 1, 1] }, label: "mat1",
          },
      ...(options.lit === true
        ? {
            key: {
              id: "key", type: "light", definitionVersion: 1, position: { x: 0, y: 0 }, label: "key1",
              /* Straight down −Z, i.e. from the camera at +Z toward the quad. A quad
                 facing the camera has N = +Z, so N·L = 1 exactly. */
              /* 0.5, not 1: at full intensity a white quad facing the light CLIPS, both
                 cases read 255, and the ratio this test is built on cannot be measured
                 at all — which is how it first failed. */
              parameters: { kind: "directional", direction: [0, 0, -1], color: [1, 1, 1, 1], intensity: 0.9, shadows: false },
            },
          }
        : {}),
      tile: {
        id: "tile", type: "geometry", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { mode: "instances", shape: "quad", scale: 0.55, material: "mat1", group: "", ...orientSlot },
        label: "tile1",
      },
      eye: {
        id: "eye", type: "camera", definitionVersion: 1, position: { x: 0, y: 0 },
        /* CLOSE, and perspective: the whole claim rides on near things being bigger, and
           a distant camera flattens exactly the asymmetry being measured. */
        parameters: { eye: [0, 0, 2.2], lookAt: [0, 0, 0], fov: 60, near: 0.1, far: 20, ortho: false },
        label: "eye1",
      },
      shot: {
        id: "shot", type: "render", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: {
          scenes: "tile1", camera: "eye1", lights: options.lit === true ? "key1" : "",
          /* No ambient in the lit case: an ambient floor is added to N·L and would blunt
             exactly the ratio being measured. */
          ambientColor: [1, 1, 1, 1], ambientIntensity: options.lit === true ? 0 : 1,
          background: [0, 0, 0, 1],
        },
        label: "shot1",
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out1" },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "tile", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

interface Half {
  /** Lit pixel count, and the mean ROW of the lit pixels (rows increase downward). */
  readonly lit: number;
  readonly centroidRow: number;
}

function halves(bytes: Uint8Array, width: number, height: number): { left: Half; right: Half } {
  const tally = (from: number, to: number): Half => {
    let lit = 0;
    let rowSum = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = from; x < to; x += 1) {
        if ((bytes[(y * width + x) * 4] ?? 0) > 40) {
          lit += 1;
          rowSum += y;
        }
      }
    }
    return { lit, centroidRow: lit === 0 ? Number.NaN : rowSum / lit };
  };
  return { left: tally(0, Math.floor(width / 2)), right: tally(Math.floor(width / 2), width) };
}

async function render(orient: boolean, centred = false, lit = false): Promise<{ left: Half; right: Half; bytes: Uint8Array }> {
  const plan = compileGraph({
    graph: graphFor({ orient, centred, lit }),
    settings: SETTINGS,
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: CAPABILITIES,
  });
  expect(plan.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(plan.ok).toBe(true);

  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
      backend.render(compiled, {
        frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SETTINGS.outputResolution.width, SETTINGS.outputResolution.height],
      });
    }
    expect(errors).toEqual([]);
    const target = plan.outputs.find((o) => o.nodeId === "shot");
    const image = await backend.readOutput(target?.resourceId ?? "");
    return {
      ...halves(image.bytes as Uint8Array, SETTINGS.outputResolution.width, SETTINGS.outputResolution.height),
      bytes: image.bytes as Uint8Array,
    };
  } finally {
    backend.dispose();
  }
}

describe("T723 — a mapped quaternion turns each instance (§B132's pair shape, §V683's domain)", () => {
  it("turns the two quads opposite ways, and neither the way the control sits", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const turned = await render(true);
    const control = await render(false);

    /* Both quads are actually on screen in every case — otherwise every comparison below
       is a comparison of two absences (§V337). */
    for (const [name, half] of [["turned.left", turned.left], ["turned.right", turned.right], ["control.left", control.left], ["control.right", control.right]] as const) {
      expect(half.lit, `${name} drew nothing`).toBeGreaterThan(200);
    }

    /* THE CONTROL IS SYMMETRIC. Unmapped, the two instances are the same quad at the same
       height, so their centroids agree — which is what makes them a usable baseline. */
    expect(Math.abs(control.left.centroidRow - control.right.centroidRow)).toBeLessThan(1);

    /* §V683, THE DOMAIN CLAIM. +45° about +X swings the quad's top edge toward the camera
       at +Z; perspective magnifies the near edge; the lit centroid rides UP, which is a
       SMALLER row index. The right-hand quad is turned the other way and rides DOWN.
       An inverted rotation swaps these two and reddens here and nowhere else. */
    expect(turned.left.centroidRow).toBeLessThan(turned.right.centroidRow - 4);

    /* §B132's second half: each turned quad differs from the control it replaces. Without
       this a rotation dropped on the floor leaves two identical quads that still satisfy
       "they rendered" — and, if both were dropped the same way, would still satisfy a
       left-versus-right comparison of a symmetric pair. */
    expect(Math.abs(turned.left.centroidRow - control.left.centroidRow)).toBeGreaterThan(2);
    expect(Math.abs(turned.right.centroidRow - control.right.centroidRow)).toBeGreaterThan(2);

    /* And the turn FORESHORTENS: a quad tilted 45° out of the view plane covers less of
       the frame than one facing it square on. A rotation applied to the normals but not
       to the positions would pass every centroid claim above and fail this one. */
    expect(turned.left.lit).toBeLessThan(control.left.lit * 0.95);
    expect(turned.right.lit).toBeLessThan(control.right.lit * 0.95);
  }, 120_000);
});

describe("T723 — the turn is a REAL 3D rotation, not a shear (§V683, from the domain)", () => {
  it("makes a facing quad into a perspective trapezoid, wide edge toward the camera", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const width = SETTINGS.outputResolution.width;
    const height = SETTINGS.outputResolution.height;
    const bandWidth = (bytes: Uint8Array, y: number): number => {
      let n = 0;
      for (let x = 0; x < width; x += 1) if ((bytes[(y * width + x) * 4] ?? 0) > 40) n += 1;
      return n;
    };
    const profile = (bytes: Uint8Array) => {
      const rows: number[] = [];
      for (let y = 0; y < height; y += 1) if (bandWidth(bytes, y) > 0) rows.push(y);
      const top = rows[0] ?? 0;
      const bottom = rows[rows.length - 1] ?? 0;
      return {
        top: bandWidth(bytes, top + 2),
        middle: bandWidth(bytes, (top + bottom) >> 1),
        bottom: bandWidth(bytes, bottom - 2),
        rows: bottom - top,
      };
    };

    const turned = profile((await render(true, true)).bytes);
    const flat = profile((await render(false, true)).bytes);

    /* THE CONTROL IS A RECTANGLE: a quad facing the camera is the same width all the way
       down, which is what makes the trapezoid below a statement about the rotation. */
    expect(Math.abs(flat.top - flat.bottom)).toBeLessThan(3);
    expect(Math.abs(flat.middle - flat.bottom)).toBeLessThan(3);

    /* THE DOMAIN CLAIM, and the reason it is stronger than any centroid: +45° about +X
       swings the quad's TOP edge toward the camera at +Z, and a perspective camera makes
       the nearer edge WIDER. So the silhouette is a trapezoid that tapers downward.

       This is what a re-derivation of my own quaternion could not have told me. An
       inverted sign tapers the other way and fails here. A rotation applied as a 2D shear
       leaves all three widths equal and fails here. A rotation dropped entirely leaves the
       control and fails here. Measured at build time: 334 / 286 / 238 against a flat
       278 / 278 / 278, and the frame was looked at. */
    /* RATIOS, not pixel counts: an absolute margin is a margin in the probe's units and
       silently loosens or breaks when the resolution changes. Measured 334/286/238 at
       640px and 134/114/95 at 256 — both 1.17 and 1.20 — so 1.10 has real headroom at
       any size and still cannot be reached by a shear (1.00). */
    expect(turned.top / turned.middle).toBeGreaterThan(1.1);
    expect(turned.middle / turned.bottom).toBeGreaterThan(1.1);

    /* And it FORESHORTENS vertically by about cos 45° — which pins the ANGLE, not just
       its sign. A quaternion built from the full angle instead of the half angle would
       turn 90° here and collapse the quad to a line. */
    expect(turned.rows / flat.rows).toBeGreaterThan(0.62);
    expect(turned.rows / flat.rows).toBeLessThan(0.80);
  }, 120_000);
});

describe("T723 — the NORMALS turn with the primitive (the fault this would otherwise ship)", () => {
  it("dims a turned quad by N·L, which only happens if its normal turned too", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const width = SETTINGS.outputResolution.width;
    /* The BRIGHTEST texel, not a mean: the mean falls when the quad foreshortens whether
       or not the normal turned, so a mean would pass on exactly the bug being hunted. */
    const peak = (bytes: Uint8Array): number => {
      let best = 0;
      for (let i = 0; i < width * SETTINGS.outputResolution.height; i += 1) best = Math.max(best, bytes[i * 4] ?? 0);
      return best;
    };

    const flat = peak((await render(false, true, true)).bytes);
    const turned = peak((await render(true, true, true)).bytes);

    /* THE EXACT VALUE (§V147). A quad facing a directional light straight down the view
       axis has N·L = 1. Turned 45°, N·L = cos 45° = 0.7071. So the turned quad's peak is
       0.707 of the flat one's — in LINEAR light, which is what the ratio of the encoded
       bytes is not, so the band is generous enough to swallow the transfer curve and
       still nowhere near 1.0.

       THIS IS THE ONE CLAIM THE UNLIT GATES ABOVE CANNOT MAKE. An unlit material ignores
       normals entirely, so every pixel test in this file would pass a shader that turned
       the positions and left the normals pointing the old way — a box lit for the way up
       it no longer has. Only a LIT draw can see it, and this is that draw. */
    expect(flat).toBeGreaterThan(180);
    expect(turned / flat).toBeLessThan(0.80);
    expect(turned / flat).toBeGreaterThan(0.62);
  }, 120_000);
});


/**
 * T723 — AND THE SHADOW AGREES WITH THE PICTURE.
 *
 * T721 carried a mapped SIZE into the depth sweep because a shadow cast at the authored
 * scale under a primitive drawn at another one reads as a lighting bug. Orientation is
 * the same argument with more force: a wrongly-sized shadow is the shadow of the right
 * shape, a wrongly-ORIENTED one is the silhouette of a thing that is not in the picture.
 *
 * The scene is built so the answer cannot be faked. A quad lies in the XY plane — i.e.
 * VERTICAL — and the light points straight down, so unturned it is edge-on to the light
 * and casts essentially nothing. Turned 90° about +X it lies FLAT and casts its whole
 * square. The caster is placed ABOVE the top of the frame so only its shadow is in shot;
 * an earlier version had it in view and measured the brightly-lit quad itself, which
 * moved the number the WRONG WAY and would have shipped as a passing test of nothing.
 *
 * Measured at build time: 55.0% of the floor band in shadow turned, 31.9% unturned (that
 * floor being the background above and below the plate, not a shadow), and both frames
 * were looked at. Drop the rotation from the depth pass and the turned case collapses
 * onto the unturned one.
 */
describe("T723 — a mapped orientation reaches the depth sweep (T721's argument, with more force)", () => {
  const SHADOW_ATTRS = ATTRIBUTES;
  const CASTER = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(0.0, 1.5, 0.0);
  /* 90° about +X — half angle 45°, so sin = cos = 0.70710678. Flat to the light. */
  q.orient = vec4f(0.70710678, 0.0, 0.0, 0.70710678);
  return q;
}`;
  const FLOOR = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(0.0, -2.2, 0.0);
  q.orient = vec4f(0.0, 0.0, 0.0, 1.0);
  return q;
}`;

  function shadowGraph(orient: boolean): GraphDocument {
    const kernel = (id: string, label: string, src: string) => ({
      id, type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, label,
      parameters: { capacity: 1, seed: 7, group: "", attributes: SHADOW_ATTRS, kernel: src, value1: 0, value2: 0, value3: 0, value4: 0 },
    });
    return {
      revision: 1,
      nodes: {
        gnd: kernel("gnd", "gnd1", FLOOR),
        cas: kernel("cas", "cas1", CASTER),
        mat: {
          id: "mat", type: "materialPhong", definitionVersion: 1, position: { x: 0, y: 0 }, label: "mat1",
          parameters: { color: [1, 1, 1, 1], specular: [0, 0, 0, 1], shininess: 2, roughness: 1 },
        },
        floor: {
          id: "floor", type: "geometry", definitionVersion: 1, position: { x: 0, y: 0 }, label: "floor1",
          parameters: { mode: "instances", shape: "box", scale: 2.0, material: "mat1", group: "" },
        },
        tile: {
          id: "tile", type: "geometry", definitionVersion: 1, position: { x: 0, y: 0 }, label: "tile1",
          parameters: {
            mode: "instances", shape: "quad", scale: 0.9, material: "mat1", group: "",
            ...(orient
              ? { orient: { mode: "map" as const, bindings: { static: { kind: "static" as const, value: [0, 0, 0, 1] }, map: { kind: "map" as const, attribute: "orient" } } } }
              : {}),
          },
        },
        key: {
          id: "key", type: "light", definitionVersion: 1, position: { x: 0, y: 0 }, label: "key1",
          parameters: { kind: "directional", direction: [0, -1, -0.001], color: [1, 1, 1, 1], intensity: 0.9, shadows: true, shadowExtent: 6 },
        },
        eye: {
          id: "eye", type: "camera", definitionVersion: 1, position: { x: 0, y: 0 }, label: "eye1",
          parameters: { eye: [0, 0.55, 3.6], lookAt: [0, -0.25, 0], fov: 42, near: 0.1, far: 30, ortho: false },
        },
        shot: {
          id: "shot", type: "render", definitionVersion: 1, position: { x: 0, y: 0 }, label: "shot1",
          parameters: {
            scenes: "floor1 tile1", camera: "eye1", lights: "key1",
            ambientColor: [1, 1, 1, 1], ambientIntensity: 0.05, background: [0, 0, 0, 1],
          },
        },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, label: "out1", parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "gnd", portId: "out" }, target: { nodeId: "floor", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "cas", portId: "out" }, target: { nodeId: "tile", portId: "points" } },
        e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as GraphDocument;
  }

  async function shadowedFraction(orient: boolean): Promise<number> {
    const plan = compileGraph({
      graph: shadowGraph(orient),
      settings: SETTINGS,
      registry: createNodeRegistry(allNodeDefinitions).view(),
      capabilities: CAPABILITIES,
    });
    expect(plan.diagnostics.filter((d) => d.severity !== "info").map((d) => d.message)).toEqual([]);
    expect(plan.ok).toBe(true);

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const errors: string[] = [];
    backend.onDiagnostic((d) => {
      if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
    });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [SETTINGS.outputResolution.width, SETTINGS.outputResolution.height],
        });
      }
      expect(errors).toEqual([]);
      const image = await backend.readOutput(plan.outputs.find((o) => o.nodeId === "shot")?.resourceId ?? "");
      const bytes = image.bytes as Uint8Array;
      const width = SETTINGS.outputResolution.width;
      const height = SETTINGS.outputResolution.height;
      let dark = 0;
      let total = 0;
      for (let y = Math.floor(height * 0.45); y < Math.floor(height * 0.95); y += 1) {
        for (let x = Math.floor(width * 0.25); x < Math.floor(width * 0.75); x += 1) {
          total += 1;
          if ((bytes[(y * width + x) * 4] ?? 0) < 90) dark += 1;
        }
      }
      return dark / total;
    } finally {
      backend.dispose();
    }
  }

  it("casts the shadow of the shape it drew, not of the one it was authored as", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const turned = await shadowedFraction(true);
    const flat = await shadowedFraction(false);

    /* A vertical quad edge-on to an overhead light casts almost nothing; turned flat it
       casts its whole square. If the depth sweep never heard about the rotation, the
       turned case casts the flat case's shadow and these two converge. */
    expect(turned).toBeGreaterThan(flat + 0.12);
    /* And the floor is genuinely LIT in the unturned case — otherwise "more shadow" is a
       comparison of two dark frames (§V337). */
    expect(flat).toBeLessThan(0.45);
  }, 180_000);
});

/**
 * §V309, asserted rather than asserted-in-a-comment: a geometry that orients nothing must
 * generate the SAME WGSL it generated before this feature existed — and so must one that
 * only sizes, because the orientation binding was numbered after T721's.
 */
describe("T723 — an unoriented geometry's shader is unchanged to the byte (§V309)", () => {
  const base = { model: "lambert" as const, lightCount: 1 };

  it("adds nothing to the lit draw until a quaternion is mapped", () => {
    expect(sceneInstancesWgsl({ ...base, pointOrient: true })).not.toEqual(sceneInstancesWgsl(base));
    expect(sceneInstancesWgsl(base)).not.toContain("pointOrients");
    expect(sceneInstancesWgsl(base)).not.toContain("qrot");
    const sized = { ...base, pointScale: { type: "f32" } };
    expect(sceneInstancesWgsl(sized)).not.toContain("pointOrients");
    /* The turn reaches BOTH the vertex and the normal — the fault this feature would
       otherwise ship is a box lit for the way up it no longer has. */
    const oriented = sceneInstancesWgsl({ ...base, pointOrient: true });
    expect(oriented).toContain("qrot(turn, shapeVertex(shape, v)");
    expect(oriented).toContain("out.normal = qrot(turn, shapeNormal(shape, v))");
  });

  it("carries the turn into the depth sweep, and nothing when there is none", () => {
    expect(shadowInstancesWgsl({})).not.toContain("pointOrients");
    expect(shadowInstancesWgsl({ pointScale: { type: "f32" } })).not.toContain("pointOrients");
    /* T721's own binding must not move when this one is added beside it. */
    expect(shadowInstancesWgsl({ pointScale: { type: "f32" } })).toEqual(
      shadowInstancesWgsl({ pointScale: { type: "f32" } }),
    );
    const oriented = shadowInstancesWgsl({ pointOrient: true });
    expect(oriented).toContain("qrot(pointOrients[instance], shapeVertex(shape, v)");
  });
});
