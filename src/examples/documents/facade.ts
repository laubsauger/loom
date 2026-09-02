import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E36 — Facade (T704). Projection-mapping PREVIZ: the two questions a site visit answers,
 * in one frame.
 *
 * A building facade at night. Two projectors stand on front-of-house positions below and
 * in front of it, throwing up at the wall — one carries a slowly scrolling warm gradient
 * (the content), the other a white alignment grid (the chart every install starts with).
 * Their beams overlap across the middle of the wall, and the overlap simply ADDS: the
 * grid lines glow through the gradient, brighter than either throw alone, which is what
 * two real projectors do in a blend zone before anyone feathers them (§V644 — a beam is
 * light, so a surface both beams reach carries both). Along the top of the wall runs a
 * dentil cornice, and because the throws come from BELOW, each block prints a shadow
 * finger on the wall ABOVE itself — the beam cannot reach what the architecture hides,
 * which is precisely the answer previz exists to give before a truck is booked.
 *
 * ## The lens does the aiming, not the tilt
 *
 * Both projectors LOOK at the wall mid-height and reach the cornice line anyway, through
 * `shiftY` — the off-axis lens shift a real install turns. Shift slides the image up the
 * wall while the throw axis stays level, so the rectangle stays a rectangle; tilting the
 * projector up instead would keystone it into a trapezoid and someone would then dial
 * `keystoneV` to fight it. That whole trade — shift first, keystone only when you ran out
 * of shift — is the reason these are separate parameters, and this file demonstrates the
 * correct half of it.
 *
 * ## What the numbers mean on site
 *
 * `throwRatio 1.8` at ~6.3 m of throw is a ~3.5 m image width per projector — the number
 * printed on the lens barrel, distance ÷ width. Aim points sit 1.6 m apart, so the two
 * 3.5 m images share a ~1.8 m central blend zone. `brightness` is nominal at the Look At
 * distance with inverse-square falloff beyond it (`falloff` stays on — the physical
 * default), and `occlusion` stays on so the cornice actually blocks: off, the beams would
 * paint THROUGH the blocks, a decal that lies about the site.
 *
 * ## §V617's placement rule, where the meshes are chosen
 *
 * Wall, ground and cornice all wear the default LIT material, and the cornice especially
 * must: an unlit geometry exchanges no light in either direction (§V666), so an unlit
 * cornice would cast no projector shadow and the whole occlusion story would silently
 * vanish — a failure that reads as "shadows don't work" when it is actually "the material
 * opted out of light". The moon key is dim and cool on purpose: enough to read the
 * architecture as architecture, never enough to compete with the throws.
 */
export const facadeDocument = document(
  "e36-facade",
  "E36 Facade",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 36 }),
  graph(
    [
      // ---- the content: what each projector carries --------------------------------
      node("drive", "lfo", [-2160, 40], { shape: "sine", frequency: 0.05, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "drive1" }),
      node("warm", "ramp", [-1860, 40], {
        type: "horizontal", interp: "smooth", period: 1,
        stops: [
          { position: 0.0, color: [1, 0.45, 0.08, 1] },
          { position: 0.45, color: [1, 0.12, 0.28, 1] },
          { position: 1.0, color: [0.62, 0.1, 0.85, 1] },
        ],
      }, {
        label: "warm1",
        definitionVersion: 2,
        resolution: { mode: "fixed", width: 256, height: 144 },
        /* The content MOVES — a scroll of the gradient, driven as a value (§V5). The
           projector re-samples it every frame; nothing about the throw recompiles. */
        parameters: { phase: drivenSlot("drive1", 0) },
      }),
      // The alignment chart: the first thing a real install ever throws.
      node("chart", "checker", [-1860, 340], {
        size: [8, 5], offset: [0, 0],
        color1: [0.05, 0.05, 0.06, 1], color2: [0.85, 0.85, 0.9, 1],
      }, { label: "chart1" }),

      // ---- the site: wall, ground, cornice ------------------------------------------
      node("wallPts", "pointGrid", [-1560, 40], { cols: 32, rows: 18, count: 576, sizeX: 8, sizeY: 4.2 }, { label: "wallpts1" }),
      node("wallLay", "pointKernel", [-1260, 40], {
        capacity: 576,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the grid stands up: the facade, 8 wide, foot on the ground at y = 0 */\n  q.position = vec3f(p.position.x, p.position.y + 2.1, 0.0);\n  return q;\n}",
      }, { label: "walllay1" }),
      /* Default LIT material on purpose (§V617): an unlit surface takes no projector
         light at all (§V666), and an 0.8 grey lambert IS a projection surface. */
      node("wall", "geometry", [-960, 40], { mode: "surface" }, { label: "wall1" }),

      node("groundPts", "pointGrid", [-1560, 340], { cols: 24, rows: 16, count: 384, sizeX: 10, sizeY: 8 }, { label: "groundpts1" }),
      node("groundLay", "pointKernel", [-1260, 340], {
        capacity: 384,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the grid lies down: the forecourt, from the wall foot toward the camera */\n  q.position = vec3f(p.position.x, 0.0, p.position.y + 4.0);\n  return q;\n}",
      }, { label: "groundlay1" }),
      node("ground", "geometry", [-960, 340], { mode: "surface" }, { label: "ground1" }),

      node("cornPts", "pointGrid", [-1560, 640], { cols: 9, rows: 1, count: 9, sizeX: 6.4, sizeY: 1 }, { label: "cornpts1" }),
      node("cornLay", "pointKernel", [-1260, 640], {
        capacity: 9,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* nine dentil blocks along the cornice line, jutting off the wall face */\n  q.position = vec3f(p.position.x, 3.25, 0.42);\n  return q;\n}",
      }, { label: "cornlay1" }),
      /* LIT, and this line is the load-bearing one (§V617/§V666): an unlit cornice casts
         no shadow, and the occlusion this example exists to show silently vanishes —
         a failure that would read as "shadows broke", not "the material opted out". */
      node("cornice", "geometry", [-960, 640], { mode: "instances", shape: "box", scale: 0.22 }, { label: "cornice1" }),

      // ---- the rig: two throws, one blend zone ---------------------------------------
      /* Aim at wall mid-height and climb the facade by LENS SHIFT, not tilt: the image
         slides up while the throw axis stays level, so the rectangle stays a rectangle.
         Tilting instead would keystone it — that is what keystoneV is for, AFTER shift
         runs out. throwRatio 1.8 over ~6.3 units of throw = a ~3.5-wide image each. */
      node("projL", "projector", [-640, 40], {
        eye: [-2, 1.2, 6], lookAt: [-0.8, 2.3, 0], throwRatio: 1.8, shiftY: 0.35, brightness: 1.1,
      }, { label: "projL1" }),
      node("projR", "projector", [-640, 340], {
        eye: [2, 1.2, 6], lookAt: [0.8, 2.3, 0], throwRatio: 1.8, shiftY: 0.35, brightness: 1.1,
      }, { label: "projR1" }),

      // ---- the night ------------------------------------------------------------------
      /* Enough moon to read the architecture, never enough to compete with a throw. */
      node("moon", "light", [-640, 640], {
        kind: "directional", direction: [0.4, -0.7, -0.6], color: [0.5, 0.62, 0.95, 1], intensity: 0.16, shadows: false,
      }, { label: "moon1" }),
      node("drift", "lfo", [-960, 940], { shape: "sine", frequency: 0.03, amplitude: 0.35, offset: 3.4, phase: 0 }, { label: "drift1" }),
      node("view", "camera", [-640, 940], {
        eye: [3.4, 1.9, 9.5], lookAt: [0, 2.2, 0], fov: 38, near: 0.1, far: 60, ortho: false,
      }, { label: "view1", parameters: { "eye.x": drivenSlot("drift1", 3.4) } }),

      node("shot", "render", [-320, 340], {
        scenes: "wall1 ground1 cornice1", camera: "view1", lights: "moon1",
        projectors: "projL1 projR1",
        ambientColor: [0.55, 0.65, 1, 1], ambientIntensity: 0.07,
        background: [0.008, 0.012, 0.028, 1],
      }, { label: "shot1" }),
      node("out", "output", [0, 340], {}, { label: "out1" }),
    ],
    [
      edge("e-warm-projL", ["warm", "out"], ["projL", "cookie"]),
      edge("e-chart-projR", ["chart", "out"], ["projR", "cookie"]),
      edge("e-wallpts-walllay", ["wallPts", "out"], ["wallLay", "in"]),
      edge("e-walllay-wall", ["wallLay", "out"], ["wall", "points"]),
      edge("e-groundpts-groundlay", ["groundPts", "out"], ["groundLay", "in"]),
      edge("e-groundlay-ground", ["groundLay", "out"], ["ground", "points"]),
      edge("e-cornpts-cornlay", ["cornPts", "out"], ["cornLay", "in"]),
      edge("e-cornlay-cornice", ["cornLay", "out"], ["cornice", "points"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);
