import { settings, node, edge, graph, document } from "./builders.ts";
import { FOREST_WGSL } from "../shaders/forest.wgsl.ts";

/**
 * E57 — Forest (T1156). A WEBSITE HERO UNIT, AND THE BUDGET IS THE BRIEF.
 *
 * The owner's ask: a misty, foggy, mystical, creepy forest where the camera feels like it is
 * infinitely slowly but surely going forward through a procedurally generated forest —
 * foggy, interesting light, walking infinitely towards the full moon. Very moody, nice and
 * adjustable, with a cool way to generate reasonably pretty procedural trees.
 *
 *   veil1(noise) ─► forest1(customWgsl: the walking DDA raymarcher) ─► out1(output)
 *
 * ## THE BUDGET, AND WHERE THE NUMBER CAME FROM
 *
 * A hero background runs behind somebody's page, competing with their layout, fonts and
 * scripts, so cheap is a requirement rather than a preference. The reference is not a
 * number anybody invented: E13 Prism is the example in this catalogue that actually did
 * this job in the wild, so E13 IS the ceiling.
 *
 * THE INSTRUMENT (`scratchpad/t1156/ab.ts`) — and it took three attempts, because the
 * first two were measuring the machine rather than the file. Render N frames and 2N,
 * capturing only the last of each so setup and readback appear in both and cancel; but a
 * PAIRED difference is worthless when another session is running a twelve-worker suite
 * (readings came back negative, and E13 read anywhere from 3.0 to 44 ms). So every
 * configuration is alternated through short runs at both counts, many times, and the
 * MINIMUM of each cell is kept: a contended run can only be slower, and alternating means
 * no configuration owns a quiet window the others did not get.
 *
 * MEASURED, Dawn/Metal, whole graph, on an idle machine:
 *
 *                              1920x1080     1280x720
 *   E46 Lantern (one 2D pass)      1.6 ms          —
 *   E13 Prism  (the datum)         3.6 ms      2.8 ms
 *   E57 Forest (this file)         6.6 ms      3.3 ms   <- ships at 720
 *   E55 Reactor (the other one)   24.3 ms     13.5 ms
 *
 * The E55 row is the calibration: it agrees with the number §T1150 recorded independently,
 * so the instrument is measuring the thing it claims to.
 *
 * ⚑ AND THE HONEST READING OF THAT TABLE, because the ratio is not one number. E13's cost
 * is mostly FIXED — 33 nodes, six geometries, four point kernels — and only about 1.5 ms of
 * its 3.6 is per-pixel; this file is the opposite, almost all per-pixel. So at 1080p E57
 * costs 1.8x E13, at 720p 1.19x, and PER PIXEL it is about four times dearer. What the
 * table actually licenses is the FRAME, not the pixel: at 1280x720 this file's frame is
 * cheaper than the frame E13 shipped and ran behind a real page, which is the comparison
 * the budget was set in. It ships at 720 for that reason and because a hero background is
 * legitimately rendered at a fraction of viewport size — a volumetric is low-frequency and
 * the upscale is invisible on fog, which is a real property of the picture rather than an
 * excuse. Anybody who wants 1080p can have it at 6.6 ms and the .md says so.
 *
 * WHERE THE 6.6 GOES, and the two levers in order: the shafts are 0.25 ms (they were the
 * expensive half before the analytic split and the importance sampling), the branches about
 * 2.4, and the rest is the grid walk and the trunks. Raising `fog` from 0.03 to 0.09 takes
 * the frame from 6.58 to 5.92 WITHOUT touching a quality knob, because the reach is solved
 * from the fog — which is the design note "the fog is the performance budget" turned into a
 * number.
 *
 * ## THE THREE DECISIONS THAT BUY IT
 *
 * **The world repeats, so walking forever is free.** One tree per cell of an infinite XZ
 * grid, every property of it a hash of the cell index, and the camera translating through.
 * No loop point, no seam, no wrap — a different forest every metre for the cost of one tree.
 *
 * **The geometry is a DDA, not a sphere trace.** A forest of vertical trunks is the worst
 * case for sphere tracing, because the distance to the nearest trunk axis is small
 * everywhere and the marcher crawls through empty air. Here the ray walks the grid cell by
 * cell and pays ONE quadratic per cell — the tree's bounding cylinder — and a short local
 * sphere trace runs only on a bound hit. Exact, because a tree's bound is clamped to fit
 * inside its own cell, so the DDA's cell order is hit order.
 *
 * **The fog is the budget, and it performs the culling it licenses.** The march's reach is
 * SOLVED from the fog — the distance at which transmittance falls to 7%, past which a tree
 * cannot change its pixel by a display step through this haze — so raising `fog` runs fewer
 * cells and the frame gets cheaper, measured above. Trees past `spacing * 3.4` lose their
 * branches and past `spacing * 1.5` lose the bend in them. The volumetric — the money shot —
 * is seven samples importance-sampled by transmittance with ONE stochastic trunk probe each,
 * sparse and soft, which is what fog wants; `shafts` at 0 skips it outright.
 *
 * ⚑ **AND ONE MEASUREMENT THAT REDIRECTED THE WHOLE OPTIMISATION.** The first draft ran at
 * 11 ms and an EMPTY grid — no trees at all — ran at 12, which is the shape of a cull that
 * is not culling: the bound has to contain the branches, so it fills most of a cell and a
 * near-horizontal ray enters four cells in five. What actually separates a cheap ray from a
 * dear one is HEIGHT, so a second, much tighter bound around the stem serves every ray that
 * passes below the lowest branch — which is most of the lower half of the frame.
 *
 * ## THE QUIET ZONE (the hero requirement nobody states until it is wrong)
 *
 * Text goes on top. The moon sits upper-right (`moonAzimuth` 14 degrees, `moonHeight` 24)
 * and `quiet` opens a mist bank lower-left at `quietAt`, mixing the picture toward the
 * far-field fog colour it was already converging to — so trunks dissolve into haze there
 * rather than sitting behind a rectangle. Both are parameters; the claims measure the local
 * contrast inside the zone against the rest of the frame, and measure that it MOVES.
 *
 * ## THE KNOBS ARE THE SHADER'S `struct Params` (T880)
 *
 * There is no project-level publish surface in this build (§T1143), so the top level is
 * `forest1`'s own page: thirty-six fields, each reflecting into a named, typed control
 * with the shader's own trailing comment as its description (T1053). Every one moves the
 * picture (§V146) — the walk, the grid, the tree's character, the air, the moon, the
 * composition. `veil1` is the cloud field the sky and the moon are seen through, and it is
 * load-bearing rather than decorative: the camera never turns, so the per-pixel sky
 * direction is constant and a screen-space veil is exactly correct here.
 *
 * ## LIVELINESS IS STRUCTURAL, AND THE MOTION BUDGET BELONGS ENTIRELY TO THE WALK
 *
 * E13 states that its motion budget belongs entirely to the pointer. This one's belongs
 * entirely to the walk: `absTime * walkSpeed` is a free-running translation with no fixed
 * point BY CONSTRUCTION — there is nothing for it to settle into — and the sway, the bob
 * and the cloud drift are offsets on the same clock. No envelope, no LFO, nothing that
 * rests. A second motion source added later would be fighting the walk.
 *
 * There are NO DRIVEN PARAMETERS in this file and that is a decision, not an omission: a
 * hero background has no audio and no pointer, so a drive lane would be a lane that never
 * fires (§V903's own failure mode), and §V914 has nothing to catch because every value here
 * IS its retained value.
 *
 * ## MEASURED, on the shipped file
 *
 * MOTION (§V913 — the row AND the whole minute, through the look instrument's own
 * arithmetic at 192x108 with its 120-frame gaps, because the recorded row samples frames
 * 60 to 180 and by construction cannot see anything the motion does afterwards):
 *   recorded row f60->f180      0.0210
 *   whole minute, 29 gaps       mean 0.0255, min 0.0184, max 0.0346
 *   LAST gap f3480->f3600       0.0225   — above the row
 * And per FRAME, which is the measure that catches a decay the gap-based one can hide:
 * 8.577e-4 at f59->60, 1.169e-3 at f1799->1800, 9.155e-4 at f3599->3600 — 107% of the
 * opening pace after a full minute. With the walk cut the same measure reads 5.010e-7.
 *
 * ⚑ THE FIRST DRAFT OF THAT CLAIM WAS VACUOUS AND THE RED-VERIFY CAUGHT IT: "frames 3599
 * and 3600 differ" passes over a camera FROZEN after eight seconds, because the cloud veil
 * drifts on its own clock. Byte inequality is not evidence of motion in a file that has a
 * second, slower clock in it. The shipped claim measures the pace instead.
 *
 * LOOK BASELINE: motion 0.02103, range 0.7206, f0max 0.7520, cardFloor 0.0012.
 *
 * DUTY (§V903) and RETAINED VALUES (§V914): nothing to report, and that is a decision
 * rather than an omission — there are NO driven parameters in this file. A hero background
 * has no audio and no pointer, so a drive lane would be a lane that never fires, and every
 * value here is its own retained value.
 */
export const forestDocument = document(
  "e57-forest",
  "E57 Forest",
  settings({ randomSeed: 57, previewFps: 30 }),
  graph(
    [
      /* THE CLOUD VEIL. The camera never turns, so every pixel's sky direction is constant
         for ever — which is what makes a screen-space cloud field correct here rather than
         a cheat, and it is the only reason this node is a `noise` and not a hash inside the
         shader. Perlin 4D at a very low `speed` so the cover drifts over minutes: more
         motion that cannot settle, for one texture read. */
      node("veil", "noise", [-600, 0], {
        type: "perlin4d", period: 0.42, harmon: 3, spread: 2, gain: 0.55, rough: 0.5,
        exp: 1, amp: 1.15, offset: 0.5, mono: true, speed: 0.014,
      }, { label: "veil1" }),

      node("forest", "customWgsl", [-300, 0], {
        source: FOREST_WGSL,
        /* The walk — the entire motion budget of this file. */
        walkSpeed: 0.85,
        sway: 0.5,
        bob: 0.045,
        eyeHeight: 1.7,
        pitch: 7,
        lens: 1.45,
        /* The grid. `spacing` is the ceiling on how wide a tree may grow, because a tree
           that left its cell would break the DDA's hit ordering. */
        spacing: 5.2,
        density: 0.85,
        /* The tree. Crude on purpose (design note 2): tapered capsules, a leaning
           three-segment trunk, whorled branches on the golden angle, a dented crown. In
           this much mist the viewer reads shapes, not bark. */
        treeHeight: 14,
        heightVary: 0.55,
        trunkWidth: 0.26,
        lean: 0.8,
        branches: 5,
        branchSpread: 0.4,
        branchRise: 0.15,
        gnarl: 0.65,
        barkColor: [0.13, 0.125, 0.12, 1],
        groundColor: [0.11, 0.12, 0.11, 1],
        /* The air. `fog` is the aerial perspective AND the cost lever; `mist` pools on the
           ground so the trunk feet vanish and the crowns float, which is the picture. */
        fog: 0.03,
        mist: 0.17,
        fogHeight: 3.4,
        fogColor: [0.038, 0.048, 0.068, 1],
        shafts: 0.85,
        skyColor: [0.01, 0.016, 0.032, 1],
        cloud: 0.55,
        /* The moon: upper-right, so the quiet zone can have the lower-left. */
        moonSize: 3.2,
        moonHeight: 24,
        moonAzimuth: 14,
        moonColor: [0.74, 0.82, 0.98, 1],
        moonGain: 1,
        ambient: 0.5,
        /* The headline's patch. */
        quiet: 0.7,
        quietAt: [0.3, 0.58],
        quietSize: 0.4,
        vignette: 0.55,
        exposure: 0.85,
      }, { label: "forest1" }),

      node("out", "output", [0, 0], { toneMap: "filmic" }, { label: "out1" }),
    ],
    [
      edge("e-veil-forest", ["veil", "out"], ["forest", "input"]),
      edge("e-forest-out", ["forest", "out"], ["out", "input"]),
    ],
  ),
);
