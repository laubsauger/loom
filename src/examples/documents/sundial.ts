import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/** Every example, in the order they are meant to be read. */
/**
 * E28 — Sundial (T484).
 *
 * A hard shadow travelling across a floor — the owner's bar, stated as a shot. One warm
 * directional key rakes in low from the west with `shadows` on (T481); a single amber
 * octahedron rides two quadrature LFOs in a slow circle above a stone floor; its shadow
 * sweeps the ground and climbs over three standing cubes like the hand of a clock. The
 * sky is a Ramp worn as the render's ENVIRONMENT (T482): a dusk gradient the stones'
 * specular lobes pick up as a cool sheen, so the unlit side of everything still reads.
 *
 * Why the composition is what it is:
 *
 * - The CASTER moves, the light does not. An orbiting light changes the whole frame's
 *   exposure every second; an orbiting object under a fixed key changes only the one
 *   thing the eye is meant to follow. The shadow is the performer.
 * - The orbit is two LFOs into the kernel's VALUE SLOTS (T479) — `ctx.value1/value2`
 *   re-publish per frame as uniform writes, nothing rebuilds (§V5). The same channel
 *   drives a slow camera drift, because a locked-off camera reads as a screenshot.
 * - `shadowExtent` is set to 5 BY HAND to hug the floor (V426): nothing knows the
 *   scene's bounds, and the tighter the volume, the more of the r32float map's
 *   resolution the shot actually spends on the floor the shadow lives on.
 * - The floor is a pointGrid LAID FLAT by a kernel (xy → xz at y = 0) and rendered as a
 *   SURFACE — grid topology survives a kernel, so central-difference normals give the
 *   floor its even lambert falloff. The stones are one instanced geometry: a box's
 *   vertices are ±1 × scale, so `scale: 0.4` cubes SIT on the floor at y = 0.4 exactly.
 *
 * ## T503 — THE ANTIALIASING, and why it is SUPERSAMPLING rather than analytic coverage
 *
 * Say the tempting thing first and then rule it out: analytic coverage from a distance
 * field — `smoothstep` over `fwidth(d)` — is nearly always the better answer, because it
 * costs one extra instruction and gives an exact 1-pixel filter width instead of a
 * quantised approximation. **It does not apply here, because there is no distance field in
 * this graph.** Every edge in this frame comes from a RASTERISER: triangle silhouettes of
 * an octahedron and three boxes, and the depth comparison against a shadow map. A fragment
 * shader cannot recover an analytic coverage term for a triangle edge it was never told
 * about, and the shadow test is a discrete comparison — there is no `d` to take `fwidth`
 * of. Reaching for `fwidth` here would have been the right tool on the wrong image.
 *
 * So this renders at 2× and lets the present resample it: `shot1` carries a per-node
 * resolution override (§V50) of 1536×864 over a 768×432 project, and the output's blit
 * downsamples it. At exactly 2:1 each destination pixel's sample lands on the corner
 * between four source texels, so a bilinear read returns their exact mean — a true 4×
 * box-filtered SSAA rather than a blur that happens to soften.
 *
 * THE COST, STATED, because 4× fragment work is not free: this frame is four boxes' worth
 * of triangles over a 768-point floor at 1.3 megapixels, which is nothing. The reason it
 * is worth paying twice over is that the SHADOW MAP scales with the render (`scratch`
 * entries are `scale: 2` of the node's own size), so the same one change takes the map
 * from 1536×864 to 3072×1728 — and the blocky staircase along the shadow's leading edge
 * was always the worse of the two aliases. Both go away for one parameter. 3072 stays
 * under `maxResolution` (4096) with room, which is the reason it is 2× and not 3×.
 */
export const sundialDocument = document(
  "e28-sundial",
  "E28 Sundial",
  settings({ outputResolution: { width: 768, height: 432 } }),
  graph(
    [
      // ---- the floor: a grid laid flat, worn as a lit surface ---------------------
      node("floorPts", "pointGrid", [-1460, 40], { cols: 32, rows: 24, count: 768, sizeX: 13, sizeY: 10 }, { label: "floorpts1" }),
      node("floorLay", "pointKernel", [-1180, 40], {
        capacity: 768,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the grid lies down: xy becomes xz, the floor is the world's ground plane */\n  q.position = vec3f(p.position.x, 0.0, p.position.y);\n  return q;\n}",
      }, { label: "floorlay1" }),
      node("ground", "geometry", [-880, 40], { mode: "surface", material: "matground1" }, { label: "ground1" }),

      // ---- three standing stones: the sundial's fixed marks -----------------------
      node("stonePts", "pointGrid", [-1460, 340], { cols: 3, rows: 1, count: 3, sizeX: 3, sizeY: 1 }, { label: "stonepts1" }),
      node("stoneLay", "pointKernel", [-1180, 340], {
        capacity: 3,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* three marks, placed off-axis so no two shadows ever agree */\n  if (ctx.index == 0u) { q.position = vec3f(-1.5, 0.4, -0.9); }\n  else if (ctx.index == 1u) { q.position = vec3f(0.5, 0.4, -1.5); }\n  else { q.position = vec3f(1.7, 0.4, 0.3); }\n  return q;\n}",
      }, { label: "stonelay1" }),
      node("stones", "geometry", [-880, 340], { mode: "instances", shape: "box", scale: 0.4, material: "matstone1" }, { label: "stones1" }),

      // ---- the caster: one octahedron on a slow circular orbit --------------------
      node("sunPt", "pointGrid", [-1460, 660], { cols: 1, rows: 1, count: 1, sizeX: 1, sizeY: 1 }, { label: "sunpt1" }),
      node("orbX", "lfo", [-1460, 900], { shape: "sine", frequency: 0.04, amplitude: 1.7, offset: 0, phase: 0 }, { label: "orbx1" }),
      node("orbZ", "lfo", [-1460, 1080], { shape: "sine", frequency: 0.04, amplitude: 1.7, offset: 0, phase: 0.25 }, { label: "orbz1" }),
      node("sunOrbit", "pointKernel", [-1180, 660], {
        capacity: 1,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* two quadrature LFOs, in through the value slots (T479): values, never rebuilds */\n  q.position = vec3f(ctx.value1, 0.85, ctx.value2);\n  return q;\n}",
      }, {
        label: "sunorbit1",
        parameters: {
          value1: drivenSlot("orbx1", 1.7),
          value2: drivenSlot("orbz1", 0),
        },
      }),
      node("sun", "geometry", [-880, 660], { mode: "instances", shape: "octahedron", scale: 0.34, material: "matsun1" }, { label: "sun1" }),

      // ---- materials and the sky ---------------------------------------------------
      node("matGround", "materialPhong", [-580, 40], {
        color: [0.36, 0.37, 0.42, 1], specular: [0.25, 0.28, 0.35, 1], shininess: 10, roughness: 0.85,
      }, { label: "matground1" }),
      node("matStone", "materialPhong", [-580, 300], {
        color: [0.58, 0.52, 0.44, 1], specular: [0.8, 0.85, 1, 1], shininess: 60, roughness: 0.3,
      }, { label: "matstone1" }),
      node("matSun", "materialPhong", [-580, 560], {
        color: [1, 0.55, 0.2, 1], specular: [1, 0.9, 0.7, 1], shininess: 40, roughness: 0.35,
      }, { label: "matsun1" }),
      node("sky", "ramp", [-580, 820], {
        type: "vertical",
        interp: "linear",
        phase: 0,
        period: 1,
        /* v = acos(R.y)/π (T482): 0 is the zenith, 1 the nadir. Deep blue overhead,
           a hot amber band AT the horizon, dark below it. */
        stops: [
          { position: 0, color: [0.06, 0.13, 0.34, 1] },
          { position: 0.42, color: [0.42, 0.5, 0.68, 1] },
          { position: 0.52, color: [1, 0.55, 0.28, 1] },
          { position: 0.62, color: [0.2, 0.12, 0.1, 1] },
          { position: 1, color: [0.08, 0.06, 0.06, 1] },
        ],
      }, { label: "sky1", definitionVersion: 2 }),

      // ---- the shot ---------------------------------------------------------------
      node("drift", "lfo", [-280, 560], { shape: "sine", frequency: 0.03, amplitude: 0.5, offset: 0.4, phase: 0 }, { label: "drift1" }),
      node("cam", "camera", [-280, 40], { lookAt: [0, 0.15, -0.4], fov: 40 }, {
        label: "cam1",
        parameters: {
          "eye.x": drivenSlot("drift1", 0.4),
          "eye.y": 1.25,
          "eye.z": 4.9,
        },
      }),
      node("key", "light", [-280, 300], {
        kind: "directional", color: [1, 0.88, 0.72, 1], intensity: 1.4,
        /* low and from the west: the raking angle IS the long shadow */
        direction: [-1, -0.45, 0.25],
        shadows: true, shadowExtent: 3.6,
      }, { label: "key1" }),
      node("shot", "render", [0, 40], {
        scenes: "ground1 stones1 sun1", camera: "cam1", lights: "key1",
        ambientColor: [0.4, 0.5, 0.95, 1], ambientIntensity: 0.3,
        background: [0.05, 0.06, 0.12, 1],
        environmentIntensity: 1,
      }, {
        label: "shot1",
        /* T503 — the whole antialiasing fix, and it is one field. EXACTLY 2× the project's
           768×432 (§V50): at any other ratio the downsample is an interpolation with
           unequal weights, and at this one it is a box filter. See the note above for why
           analytic coverage is not available on a rasterised silhouette. */
        resolution: { mode: "fixed", width: 1536, height: 864 },
      }),
      node("out", "output", [280, 40], {}, { label: "out1" }),
    ],
    [
      edge("e-floorpts-lay", ["floorPts", "out"], ["floorLay", "in"]),
      edge("e-floorlay-ground", ["floorLay", "out"], ["ground", "points"]),
      edge("e-stonepts-lay", ["stonePts", "out"], ["stoneLay", "in"]),
      edge("e-stonelay-stones", ["stoneLay", "out"], ["stones", "points"]),
      edge("e-sunpt-orbit", ["sunPt", "out"], ["sunOrbit", "in"]),
      edge("e-sunorbit-sun", ["sunOrbit", "out"], ["sun", "points"]),
      // THE SKY WIRE (T482, V372): pixels are data — a Ramp worn as the environment.
      edge("e-sky-shot", ["sky", "out"], ["shot", "environment"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);
