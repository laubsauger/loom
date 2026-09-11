import { settings, node, edge, graph, document } from "./builders.ts";
import { SANCTUM_WGSL } from "../shaders/sanctum.wgsl.ts";

/**
 * E68 — SANCTUM (T1283). The showcase the owner commissioned, and it is a DELIBERATE
 * OUTLIER rather than a budget failure.
 *
 * The brief: *"triple AAA alien technology / temple visuals. with proper pbr materials,
 * reflections, specular, structured textures, lights, and camera moves, details in scene
 * driven by audio."* The feasibility read offered three directions and recommended the
 * rasterised one; the owner chose the RAYMARCHED one with its price in front of them —
 * 25–35 ms @720 against E13's 3.6 ms datum — and then removed the ceiling entirely:
 * "make it look right". Both choices are theirs, made twice, and they are why this file
 * sits beside E67 rather than beside E13.
 *
 *   sky1(solid) ─► temple1(customWgsl: the nave marcher) ─► out1(output)
 *
 * ## The shape of the piece
 *
 * A slow dolly down the nave of a buried temple. Eroded stone, a colonnade that recedes,
 * a doorway at the far end that is the only cold light in the picture, and inlay channels
 * cut into the columns that are still powered.
 *
 * ## What this file does NOT have, stated rather than discovered
 *
 * It is a marcher, so it owns its own shading: **no `materialPbr`**, and none of the
 * GGX/Smith BRDF or the prefiltered environment that §T1284 and §T1289 landed the same
 * night. Those are the scene node family's, and a full-screen `customWgsl` never touches
 * them. It also **cannot MSAA** — that is free on the rasterised path and unavailable
 * here, which is why the anti-aliasing is FXAA (§T1276's component) rather than the 1.69×
 * supersample the owner refused on E67. The renderer's flagship material ships in the
 * SMALLER PBR EXAMPLE that follows this one (§T1290), not in the temple.
 *
 * ## Built in measured stages, and the stages are in the record
 *
 * Each idea was costed before the next went in, at 1280×720, as GPU extent — trimmed
 * means over 240 of 300 frames rather than medians, because Dawn quantizes timestamps to
 * 65 536 ns and a median lands ON the quantum (§B211):
 *
 *   stage 1  the bare march: stone, erosion, one key        2.94 ms
 *   stage 2  + the inlay, its channels and its spill        3.57 ms
 *
 * The resolution is set EXPLICITLY on the document rather than inherited, so the piece and
 * its claims agree about what it was designed for.
 */
export const sanctumDocument = document(
  "sanctum",
  "E68 Sanctum",
  settings({ randomSeed: 68, outputResolution: { width: 1280, height: 720 } }),
  graph(
    [
      /* The marcher writes every pixel, so its input is a formality — but a `customWgsl`
         node takes one, and a black solid is the honest "nothing comes in here". */
      node("sky", "solid", [-600, 0], { color: [0, 0, 0, 1] }, { label: "sky1" }),
      /* §V920/§T1184: every reflected value is STORED rather than inherited from the
         shader's own `// @default` lines. A declared default is a fallback for a node
         somebody just placed; a shipped example that leans on one moves the day the
         shader is retuned, and nothing would say so. */
      node("temple", "customWgsl", [-300, 0], {
        source: SANCTUM_WGSL,
        dollySpeed: 0.55,
        eyeHeight: 1.62,
        pitch: -7,
        lens: 1.7,
        bay: 4.4,
        aisle: 3.6,
        columnRadius: 0.62,
        columnFlare: 0.22,
        ceiling: 7.2,
        erosion: 0.115,
        erosionScale: 4.6,
        erosionBands: 0.62,
        inlayRows: 1.15,
        inlayVeins: 9,
        inlayRings: 0.34,
        inlayDepth: 0.035,
        inlayWidth: 0.16,
        inlayColor: [0.16, 1, 0.82, 1],
        inlayEmission: 0.85,
        inlaySpill: 4.2,
        inlayDensity: 0.4,
        stoneColor: [0.29, 0.27, 0.25, 1],
        keyColor: [0.52, 0.62, 0.78, 1],
        keyIntensity: 1.35,
        ambient: 0.16,
        fog: 0.055,
        fogColor: [0.045, 0.05, 0.062, 1],
        exposure: 1.35,
        dust: 0.032,
        dustSteps: 22,
        dustFloor: 2.6,
        shaft: 0.55,
        polish: 0.55,
        reflectSteps: 34,
        reflectFade: 12,
        steps: 96,
      }, { label: "temple1" }),
      node("out", "output", [0, 0], { toneMap: "filmic" }, { label: "out1" }),
    ],
    [
      edge("e-sky-temple", ["sky", "out"], ["temple", "input"]),
      edge("e-temple-out", ["temple", "out"], ["out", "input"]),
    ],
  ),
);
