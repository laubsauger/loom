import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/** One ball, centred at `cx` on the row: the grid's (u, v) folded onto a sphere. */
const SPHERE_KERNEL = (cx: number): string => `
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = (p.position.x * 0.5) + 0.5;
  let v = (p.position.y * 0.5) + 0.5;
  let theta = u * 6.2831853;
  let phi = v * 3.14159265;
  let r = 0.85;
  q.position = vec3f(
    ${String(cx)} + (r * sin(phi) * cos(theta)),
    0.95 + (r * cos(phi)),
    r * sin(phi) * sin(theta),
  );
  return q;
}
`;

/**
 * E69 — BURNISH (T1290). The renderer's flagship material, in a shipped document at last.
 *
 * §T1284 found that `materialPbr` was in ZERO of 59 shipped examples — the material the
 * whole engine-first ruling was about, rendered by nothing. That is this project's dominant
 * bug class in the art direction rather than in the wiring, and it is not academic: the
 * §V960 twin hid in §T1284 for exactly that reason. The shader side and the binding side
 * spelled the same rule six times independently, T1284 changed one of them, and no shipped
 * frame rendered the path that would have shown it.
 *
 * ⚑ SO THIS FILE IS A GATE THAT LOOKS LIKE AN EXAMPLE, and it is deliberately the PLAINEST
 * honest thing that exercises the BRDF rather than a second showcase competing with E68.
 * Four spheres and a plate under a coloured sky. If the metallic-roughness path breaks, a
 * picture in the catalogue breaks with it.
 *
 *   plate1 ─┐
 *   mirror1 · brushed1 · rough1 · glass1 ─┴► shot1(render) ─► out1
 *                                   sky1(ramp) ─► shot1.environment
 *
 * ## What the four spheres are for
 *
 * They are a reading of the two knobs, left to right, and each one is a claim someone can
 * check by looking:
 *
 *  - MIRROR — metallic 1, roughness 0.05. The environment arrives sharp: the sky's own
 *    gradient and its horizon band, legible in the surface.
 *  - BRUSHED — metallic 1, roughness 0.42. The SAME environment, BLURRED. Before §T1289
 *    this sphere would have been the mirror's picture dimmed rather than softened, which is
 *    the single largest gap there was between what this renderer shipped and what "PBR"
 *    means to somebody looking at it.
 *  - ROUGH — metallic 1, roughness 0.92. Almost no structure left in the reflection and
 *    still bright: a rough metal is SOFT, never dark. That is the T1289 claim stated as a
 *    picture.
 *  - DIELECTRIC — metallic 0, roughness 0.3. A body colour with a weak specular that rises
 *    at grazing, and a diffuse half the metals do not have, because `(1 − metallic)` is a
 *    hard zero on the only term the albedo multiplies.
 *
 * ## Why an environment rather than more lights
 *
 * A metal has no diffuse lobe, so a metal lit only by point sources is four highlights on
 * black — which is what a BRDF test looks like when it is testing the BRDF and not the
 * renderer. The environment is what gives a metal something to reflect, and the reflection
 * is where GGX's roughness actually lives. The sky is a `ramp`, so it is a TOP like any
 * other and nothing here is an asset.
 *
 * ## Rasterised on purpose
 *
 * E68 took the marcher's path and gave up MSAA and this material to get volumetrics. This
 * file takes the other side of that trade deliberately: the scene node family, so it gets
 * the real BRDF, real shadow maps with PCF, and MSAA free — and so the two pieces together
 * cover both renderers rather than twice covering one.
 */
export const burnishDocument = document(
  "burnish",
  "E69 Burnish",
  settings({ randomSeed: 69, outputResolution: { width: 1280, height: 720 } }),
  graph(
    [
      /* THE PLATE. A wide, nearly flat grid: the spheres need something to sit on and to
         cast onto, and a dielectric floor is also the one surface here with a diffuse half
         worth looking at. */
      node("platePts", "pointGrid", [-1400, 40], { cols: 48, rows: 36, count: 1728, sizeX: 16, sizeY: 12 }, { label: "platepts1" }),
      node("plateLay", "pointKernel", [-1160, 40], {
        capacity: 1728,
        seed: 69,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: `
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // The grid arrives in XY; the floor is XZ, so the plane is turned once here rather than
  // every consumer having to know which way a grid lies.
  q.position = vec3f(p.position.x, 0.0, p.position.y);
  return q;
}
`,
      }, { label: "platelay1" }),
      node("plate", "geometry", [-900, 40], { mode: "surface", material: "matplate1" }, { label: "plate1" }),

      /* THE FOUR SPHERES, one geometry each because a material belongs to a geometry and
         the whole point of the file is that the four materials differ. */
      /* ⚑ THE SPHERES ARE A GRID FOLDED INTO A BALL, and the two obvious routes are both
         closed. `geometry` in INSTANCE mode offers quad, box and octahedron — no sphere —
         and a faceted solid is the worst possible subject for a roughness ladder, because
         its own facets do what roughness is supposed to do. `pointGenerator` at shape
         `sphere` emits no analytic grid topology, so the surface renderer cannot build a
         surface from it at all (only grid, tube and torus carry one).
         What does work is the oldest route: a `pointGrid`, which carries topology by
         construction, mapped to a sphere in a kernel. The surface renderer takes its
         normals from central differences on that grid, so the reflections belong to the
         material rather than to the mesh. */
      node("ballPts", "pointGrid", [-1400, 500], { cols: 64, rows: 48, count: 3072, sizeX: 2, sizeY: 2 }, { label: "ballpts1" }),
      node("atMirror", "pointKernel", [-1160, 240], {
        capacity: 3072,
        seed: 69,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: SPHERE_KERNEL(-3.3),
      }, { label: "atmirror1" }),
      node("atBrushed", "pointKernel", [-1160, 480], {
        capacity: 3072,
        seed: 69,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: SPHERE_KERNEL(-1.1),
      }, { label: "atbrushed1" }),
      node("atRough", "pointKernel", [-1160, 720], {
        capacity: 3072,
        seed: 69,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: SPHERE_KERNEL(1.1),
      }, { label: "atrough1" }),
      node("atGlass", "pointKernel", [-1160, 960], {
        capacity: 3072,
        seed: 69,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: SPHERE_KERNEL(3.3),
      }, { label: "atglass1" }),

      node("mirror", "geometry", [-900, 240], { mode: "surface", material: "matmirror1" }, { label: "mirror1" }),
      node("brushed", "geometry", [-900, 480], { mode: "surface", material: "matbrushed1" }, { label: "brushed1" }),
      node("rough", "geometry", [-900, 720], { mode: "surface", material: "matrough1" }, { label: "rough1" }),
      node("glass", "geometry", [-900, 960], { mode: "surface", material: "matglass1" }, { label: "glass1" }),

      /* ⚑ THE FOUR MATERIALS, AND THEY DIFFER IN EXACTLY TWO NUMBERS. Same base colour on
         the three metals, same everything else: the only things that move are `metallic`
         and `roughness`, so anything you can see between them is the BRDF and not a tint. */
      node("matMirror", "materialPbr", [-620, 240], { color: [0.92, 0.9, 0.86, 1], metallic: 1, roughness: 0.05 }, { label: "matmirror1" }),
      node("matBrushed", "materialPbr", [-620, 480], { color: [0.92, 0.9, 0.86, 1], metallic: 1, roughness: 0.42 }, { label: "matbrushed1" }),
      node("matRough", "materialPbr", [-620, 720], { color: [0.92, 0.9, 0.86, 1], metallic: 1, roughness: 0.92 }, { label: "matrough1" }),
      /* The dielectric: metallic 0, so it keeps the diffuse half the metals have none of. */
      node("matGlass", "materialPbr", [-620, 960], { color: [0.22, 0.4, 0.52, 1], metallic: 0, roughness: 0.3 }, { label: "matglass1" }),
      node("matPlate", "materialPbr", [-620, 40], { color: [0.16, 0.16, 0.18, 1], metallic: 0, roughness: 0.65 }, { label: "matplate1" }),

      /* THE SKY. A `ramp` and nothing else — the environment is any TOP, so a reflection
         here costs no asset pipeline. The band at the horizon is deliberate: a gradient
         with an edge in it is what makes a mirror legible as a mirror, because a smooth
         sky reflects as a smooth nothing and says nothing about roughness. */
      node("sky", "ramp", [-620, 1200], {
        type: "vertical",
        interp: "linear",
        phase: 0,
        period: 1,
        stops: [
          { position: 0, color: [0.05, 0.08, 0.16, 1] },
          { position: 0.4, color: [0.3, 0.42, 0.6, 1] },
          { position: 0.5, color: [1, 0.82, 0.55, 1] },
          { position: 0.58, color: [0.24, 0.16, 0.14, 1] },
          { position: 1, color: [0.05, 0.04, 0.05, 1] },
        ],
      }, { label: "sky1", definitionVersion: 2 }),

      /* A slow drift across the row, so the reflections MOVE — a still mirror and a still
         rough ball differ less than a moving pair, because what roughness does to a
         reflection is most legible when the reflection is travelling. */
      node("drift", "lfo", [-340, 520], { shape: "sine", frequency: 0.02, amplitude: 1.6, offset: 0, phase: 0 }, { label: "drift1" }),
      node("cam", "camera", [-340, 40], { lookAt: [0, 0.75, 0], fov: 38 }, {
        label: "cam1",
        parameters: {
          "eye.x": drivenSlot("drift1", 0),
          "eye.y": 1.9,
          "eye.z": 8.4,
        },
      }),
      node("key", "light", [-340, 260], {
        kind: "directional", color: [1, 0.94, 0.86, 1], intensity: 1.1,
        direction: [-0.6, -0.8, -0.45],
        shadows: true, shadowExtent: 7,
      }, { label: "key1" }),
      node("shot", "render", [-60, 40], {
        scenes: "plate1 mirror1 brushed1 rough1 glass1",
        camera: "cam1",
        lights: "key1",
        ambientColor: [0.45, 0.55, 0.8, 1],
        ambientIntensity: 0.18,
        background: [0.03, 0.035, 0.05, 1],
        environmentIntensity: 1,
        /* T1289's tap count, at its shipped default: the cone that makes roughness blur. */
        environmentTaps: 8,
        /* E68 could not have this: MSAA is free on the rasterised path and unavailable to
           a marcher, and a sphere's silhouette is exactly where it shows. */
        antialias: "msaa",
      }, { label: "shot1" }),
      node("out", "output", [220, 40], { toneMap: "filmic" }, { label: "out1" }),
    ],
    [
      edge("e-platepts-lay", ["platePts", "out"], ["plateLay", "in"]),
      edge("e-platelay-plate", ["plateLay", "out"], ["plate", "points"]),
      edge("e-ballpts-mirror", ["ballPts", "out"], ["atMirror", "in"]),
      edge("e-ballpts-brushed", ["ballPts", "out"], ["atBrushed", "in"]),
      edge("e-ballpts-rough", ["ballPts", "out"], ["atRough", "in"]),
      edge("e-ballpts-glass", ["ballPts", "out"], ["atGlass", "in"]),
      edge("e-atmirror-mirror", ["atMirror", "out"], ["mirror", "points"]),
      edge("e-atbrushed-brushed", ["atBrushed", "out"], ["brushed", "points"]),
      edge("e-atrough-rough", ["atRough", "out"], ["rough", "points"]),
      edge("e-atglass-glass", ["atGlass", "out"], ["glass", "points"]),
      edge("e-sky-shot", ["sky", "out"], ["shot", "environment"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);
