import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E25 — Stage (T444). The MULTI-STAGE render the owner asked for, verbatim: "a multi
 * stage setup of a camera, geometry, reproduction, picked up by another camera then to
 * screen and all this driven interestingly."
 *
 * Scene A — the PERFORMANCE: a torus of lit octahedra under a magenta key, filmed by
 * a camera ORBITING on two quadrature LFOs. Its render is a TEXTURE.
 *
 * That texture crosses into scene B as a MATERIAL MAP — one plain edge into an unlit
 * material's albedo slot (V372: pixels are data, they travel on wires) — worn by a
 * flat grid standing in scene B like a cinema screen. A second camera, itself drifting,
 * films the screen and a floor of instanced boxes under a warm key, and THAT goes to
 * the output: a virtual screen inside a scene, the TD/Notch classic.
 *
 * Every stage is driven and nothing rebuilds: both orbits and the breathing fill are
 * VALUES through the scene payload channel (T377, §V5) — camera eyes and light
 * intensity re-publish per frame as uniform writes.
 */
export const stageDocument = document(
  "e25-stage",
  "E25 Stage",
  settings({ outputResolution: { width: 768, height: 432 } }),
  graph(
    [
      // ---- scene A: the performance ---------------------------------------------
      node("ringA", "pointTorus", [-1460, -200], { cols: 36, rows: 18, radius: 0.7, radius2: 0.28 }, { label: "ringa1" }),
      node("matA", "materialPhong", [-1460, -400], {
        color: [1, 0.25, 0.55, 1], specular: [1, 1, 1, 1], shininess: 80, roughness: 0.25,
      }, { label: "mata1" }),
      node("geoA", "geometry", [-1180, -200], {
        mode: "instances", shape: "octahedron", scale: 0.075, material: "mata1",
      }, { label: "geoa1" }),
      node("orbAx", "lfo", [-1180, -560], { shape: "sine", frequency: 0.07, amplitude: 2.4, offset: 0, phase: 0 }, { label: "orbax1" }),
      node("orbAz", "lfo", [-1180, -740], { shape: "sine", frequency: 0.07, amplitude: 2.4, offset: 0, phase: 0.25 }, { label: "orbaz1" }),
      node("camA", "camera", [-1180, -380], { lookAt: [0, 0, 0], fov: 50 }, {
        label: "cama1",
        parameters: {
          "eye.x": drivenSlot("orbax1", 2.4),
          "eye.y": 0.9,
          "eye.z": drivenSlot("orbaz1", 0),
        },
      }),
      node("keyA", "light", [-1180, -920], {
        kind: "directional", color: [1, 0.85, 0.95, 1], intensity: 1.1, direction: [-0.3, -0.8, -0.5],
      }, { label: "keya1" }),
      node("shotA", "render", [-880, -200], {
        scenes: "geoa1", camera: "cama1", lights: "keya1",
        ambientColor: [0.3, 0.2, 0.5, 1], ambientIntensity: 0.3,
        background: [0.14, 0.05, 0.2, 1],
      }, { label: "shota1" }),

      // ---- the crossing: render A becomes a MATERIAL MAP -------------------------
      node("screenMat", "materialUnlit", [-580, -200], { color: [1, 1, 1, 1] }, { label: "screenmat1" }),

      // ---- scene B: the stage ----------------------------------------------------
      node("screenGrid", "pointGrid", [-580, 40], { cols: 48, rows: 27, count: 1296, sizeX: 3.2, sizeY: 1.8 }, { label: "screengrid1" }),
      node("screen", "geometry", [-280, 40], { mode: "surface", material: "screenmat1" }, { label: "screen1" }),
      node("floorPts", "pointGrid", [-620, 240], { cols: 12, rows: 12, count: 144, sizeX: 4, sizeY: 3 }, { label: "floorpts1" }),
      node("floorKernel", "pointKernel", [-410, 240], {
        capacity: 144,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the xy plane lies down: y becomes depth, the floor sits under the screen */\n  q.position = vec3f(p.position.x, -1.15, p.position.y - 0.6);\n  return q;\n}",
      }, { label: "floorkernel1" }),
      node("matFloor", "materialPhong", [-410, 450], {
        color: [0.25, 0.28, 0.38, 1], specular: [0.6, 0.7, 1, 1], shininess: 24, roughness: 0.7,
      }, { label: "matfloor1" }),
      node("floor", "geometry", [-200, 240], {
        mode: "instances", shape: "box", scale: 0.09, material: "matfloor1",
      }, { label: "floor1" }),
      node("orbBx", "lfo", [0, -160], { shape: "sine", frequency: 0.045, amplitude: 1.4, offset: 0, phase: 0 }, { label: "orbbx1" }),
      node("breathe", "lfo", [0, -340], { shape: "sine", frequency: 0.2, amplitude: 0.5, offset: 1.1, phase: 0 }, { label: "breathe1" }),
      node("camB", "camera", [0, 40], { lookAt: [0, -0.1, 0], fov: 55 }, {
        label: "camb1",
        parameters: {
          "eye.x": drivenSlot("orbbx1", 0.8),
          "eye.y": 0.35,
          "eye.z": 3.1,
        },
      }),
      node("keyB", "light", [0, 240], {
        kind: "directional", color: [1, 0.9, 0.7, 1], direction: [-0.4, -0.75, -0.4],
      }, {
        label: "keyb1",
        parameters: { intensity: drivenSlot("breathe1", 1.1) },
      }),
      node("shotB", "render", [280, 40], {
        scenes: "screen1 floor1", camera: "camb1", lights: "keyb1",
        ambientColor: [0.5, 0.55, 0.8, 1], ambientIntensity: 0.25,
        background: [0.03, 0.04, 0.08, 1],
      }, { label: "shotb1" }),
      node("out", "output", [560, 40], {}, { label: "out1" }),
    ],
    [
      edge("e-ringa-geoa", ["ringA", "out"], ["geoA", "points"]),
      // THE WIRE (V372): scene A's picture, into a material's map slot, one edge.
      edge("e-shota-screenmat", ["shotA", "out"], ["screenMat", "albedo"]),
      edge("e-screengrid-screen", ["screenGrid", "out"], ["screen", "points"]),
      edge("e-floorpts-kernel", ["floorPts", "out"], ["floorKernel", "in"]),
      edge("e-kernel-floor", ["floorKernel", "out"], ["floor", "points"]),
      edge("e-shotb-out", ["shotB", "out"], ["out", "input"]),
    ],
  ),
);
