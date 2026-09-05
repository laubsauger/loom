import { settings, node, edge, graph, document } from "./builders.ts";
import { FOREST_WGSL, FOREST_DOF_WGSL } from "../shaders/forest.wgsl.ts";

/**
 * E57 — Forest (T1156). A WEBSITE HERO UNIT, AND THE BUDGET IS THE BRIEF.
 *
 * The owner's ask: a misty, foggy, mystical, creepy forest where the camera feels like it is
 * infinitely slowly but surely going forward through a procedurally generated forest —
 * foggy, interesting light, walking infinitely towards the full moon. Very moody, nice and
 * adjustable, with a cool way to generate reasonably pretty procedural trees.
 *
 *   veil1(noise) ─► forest1(customWgsl: the walking DDA raymarcher)
 *                   ─► dof1(customWgsl: the near-field defocus) ─► out1(output)
 *
 * T1170 DEEPENED IT, on the owner's reading that it was "a little bit lame, a little bit
 * repetitive" and wanted depth of field. Four changes and the section at the bottom of this
 * block says what each one cost and what was refused instead.
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
 *   E57 Forest (T1156)             6.6 ms      3.3 ms   <- ships at 720
 *   E55 Reactor (the other one)   24.3 ms     13.5 ms
 *
 * The E55 row is the calibration: it agrees with the number §T1150 recorded independently,
 * so the instrument is measuring the thing it claims to.
 *
 * ⚑ AND THAT TABLE IS NOW A RECORD RATHER THAN A READING (T1170). The same instrument on
 * the same machine reported this file at 3.53 and 5.51 ms in two runs an hour apart, and
 * E13 at 3.11 and 4.38 — the absolute numbers move with whatever else is on the machine and
 * two identical configurations differed by 0.56 ms in a loud window. So T1170 measured
 * nothing in absolutes: every reading below is a DELTA against the T1156 file rendered in
 * the SAME alternating run, and the budget is stated as a ratio to E13 measured beside it.
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
 * Whether a cell carries a stem at all is a low-frequency FIELD over the cell index rather
 * than a constant probability (T1170), which is what stops the repeat reading as a lattice.
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
 * ## T1170 — THE DEEPENING, AND WHAT IT COST
 *
 * The owner on the shipped T1156 file: "it's good, but it's a little bit lame, a little bit
 * repetitive... could get some more detail, some more work, and some effects, whatever is
 * gonna make that more believable that we're actually walking through this forest" — plus
 * depth of field by name. Four changes went in. Every number here is a DELTA against the
 * T1156 file alternated through the same run.
 *
 * **1. THE DENSITY IS A FIELD (`clumping`), and this was the whole of "repetitive".** Every
 * tree already differed and it had not helped: one tree per cell at a CONSTANT probability
 * is a lattice however varied the individuals are, and in fog the trunks reduce to an evenly
 * spaced rhythm of verticals. A low-frequency value noise over the cell index now sets how
 * many cells in a neighbourhood carry a stem — thickets and clearings — and it is the
 * contrast between them the eye reads as depth. The gate is BINARY and a pure function of
 * the cell index; see the shader's own warning about what happens if it is not.
 *
 * **2. THE SHORT STEMS ARE BROKEN, NOT YOUNG (`snags`), and the owner found the first
 * version.** The first draft made a share of the cells SAPLINGS — a mature tree at a quarter
 * scale, same proportions, same branch pattern — and the reply was that the trees were
 * "growing". They were: a quarter-size copy of the tree beside it is exactly the picture of
 * a tree that has not finished growing, and nothing was animating. The fix was a change of
 * FORM: a snag keeps the full trunk radius of the tree it was, carries no branches, and ends
 * BLUNT where it snapped. Three differences, none of them scale.
 *
 * **3. THE GROUND ROLLS (`relief`), for the price of a noise already paid.** Everything
 * stood on one flat plane, so every trunk met the mist at the same altitude and the eye read
 * a dead horizontal floor line. Trunk feet and the eye now ride the STAND FIELD ITSELF. The
 * ground plane does NOT roll and that is a refusal: intersecting a height field needs a
 * march, and the floor of every frame in this file is haze — nobody ever sees it.
 *
 * **4. THE NEAR FIELD IS OUT OF FOCUS (`dof1`).** Half of depth of field was already here:
 * fog attenuates with distance, and a far blur would only argue with it. What fog cannot do
 * is soften what is too CLOSE, and a trunk sliding past at arm's length out of focus is the
 * difference between walking through a wood and looking at one. A separate pass, not lens
 * sampling in the march — N rays a pixel is N times the DDA and the budget above dies at
 * N = 2 — reading a depth the forest pass writes into its alpha channel.
 *
 * MEASURED, two independent eight-round runs at 1280x720, alternated, minimum of each kept,
 * the T1156 file in the same run (they agree to a few hundredths):
 *
 *   T1156 file, the control                                       4.00   4.10 ms
 *   this file                                                     4.29   4.29
 *   this file with the defocus pass removed                       4.03   4.03
 *   this file, field and swell off, density matched to the field  4.72      —
 *   E13 Prism, same run                                           2.73   2.63
 *
 * The deepening costs about +0.25 ms, six percent of the frame, and THE DEFOCUS PASS IS
 * ESSENTIALLY ALL OF IT (+0.26). The field, the snags, the swell and the gait come to zero
 * within the instrument's noise, and against the same code with an EVEN field at the same
 * mean density they SAVE 0.43 ms — a clearing walks the same cells with nothing in them to
 * march. That was the prediction the design was made on and it held.
 *
 * THE BUDGET STILL HOLDS, and it is worth restating what it is: not "cheaper than E13 at the
 * same size", which it never was, but that E57's 720p frame is cheaper than the 1080p frame
 * E13 ran behind a real page. Same run: 4.29 against E13's 5.45 at 1080p, a 21% margin.
 *
 * ⚑ AND ONE CORRECTION THE TIGHTER INSTRUMENT FORCED. At 16/48 frames the 720p ratio to E13
 * read 1.19x; at 32/192 the same control reads 1.56x. That is the ESTIMATOR, not the file —
 * E13's cost is mostly fixed setup and the narrower difference was leaving more of it in the
 * per-frame number. The 1.19 in the table above is an artefact of how it was measured.
 *
 * Plus a GAIT: the bob was a fixed 1.6 rad/s, four cycles a minute, which is breathing. It
 * is now the walk's own stride rate, with a lateral roll at half of it — the 2:1 phase
 * relation is the cue. Both terms are TRANSLATIONS, which is what let it in at all: the
 * camera still never turns, so the veil and the headline are untouched. Heading drift was
 * REFUSED for exactly that reason.
 *
 * ## WHAT T1170 REFUSED
 *
 *   - HEADING DRIFT and any camera rotation. The screen-space cloud veil is only correct
 *     because the per-pixel sky direction is constant, and a headline needs the moon and the
 *     quiet zone to hold still. A gate asserts it: with no trees and no haze the sky is
 *     byte-identical with the gait and the swell on and off.
 *   - A FAR-FIELD BLUR. It duplicates the fog and then competes with it for the same pixels.
 *     `focus` is one-sided and there is no far knob (§V146).
 *   - A ROLLING GROUND PLANE, above — a march to render something the mist swallows.
 *   - FOLIAGE, again and for the same reasons T1156 refused it three times. "More" here
 *     means more contrast BETWEEN PLACES, not more objects everywhere.
 *   - WIND IN THE BRANCHES. It is the one item on the owner's list not attempted, and the
 *     honest word is DEFERRED rather than refused: the branch table is rebuilt on every
 *     bound a ray enters, so a time term in it is trig per branch per bound and the budget
 *     was already spent. It has not been measured, so nobody should quote this as a finding.
 *
 * ## THE KNOBS ARE THE SHADER'S `struct Params` (T880)
 *
 * There is no project-level publish surface in this build (§T1143), so the top level is
 * `forest1`'s own page: thirty-nine fields, each reflecting into a named, typed control
 * with the shader's own trailing comment as its description (T1053). Every one moves the
 * picture (§V146) — the walk, the grid, the tree's character, the air, the moon, the
 * composition. `veil1` is the cloud field the sky and the moon are seen through, and it is
 * load-bearing rather than decorative: the camera never turns, so the per-pixel sky
 * direction is constant and a screen-space veil is exactly correct here. `dof1` carries two
 * more of its own — `focus` in metres and `blur` — and `blur` at 0 passes the frame straight
 * through, which makes it the third cost lever in the file.
 *
 * ## LIVELINESS IS STRUCTURAL, AND THE MOTION BUDGET BELONGS ENTIRELY TO THE WALK
 *
 * E13 states that its motion budget belongs entirely to the pointer. This one's belongs
 * entirely to the walk: `absTime * walkSpeed` is a free-running translation with no fixed
 * point BY CONSTRUCTION — there is nothing for it to settle into — and the sway, the bob
 * and the cloud drift are offsets on the same clock. No envelope, no LFO, nothing that
 * rests. A second motion source added later would be fighting the walk — which is why the
 * T1170 gait is DERIVED from `walkSpeed` rather than added beside it, and why the eye's rise
 * and fall over the ground swell is a function of where the walk has got to rather than of
 * the clock.
 *
 * There are NO DRIVEN PARAMETERS in this file and that is a decision, not an omission: a
 * hero background has no audio and no pointer, so a drive lane would be a lane that never
 * fires (§V903's own failure mode), and §V914 has nothing to catch because every value here
 * IS its retained value.
 *
 * ## MEASURED, on the shipped file
 *
 * MOTION (§V913). Per FRAME, averaged over four pairs spread across the first sixteen
 * seconds and four across the last fifteen: 7.977e-4 opening, 7.855e-4 closing — 98% of the
 * pace after a full minute, and with the walk cut the closing figure reads 6.130e-7,
 * thirteen hundred times down.
 *
 * ⚑ TWO DRAFTS OF THAT CLAIM WERE WRONG AND BOTH REDS WERE EARNED.
 * (T1156) "Frames 3599 and 3600 differ" passes over a camera FROZEN after eight seconds,
 * because the cloud veil drifts on its own clock. Byte inequality is not evidence of motion
 * in a file that has a second, slower clock in it.
 * (T1170) Its replacement compared ONE pair at the start with ONE at the end, and the
 * deepening broke it honestly: the gait puts a 1.18 Hz oscillation into the per-frame delta
 * and the clumped field puts a thicket-or-a-clearing into each frame, so a single pair now
 * reads anywhere from 2.9e-4 to 1.35e-3 — a factor of four on phase and stand alone. It
 * failed at 0.54 of the opening pace and it was RIGHT to: it was measuring one draw. Four
 * pairs a side is several gait cycles and several clumps each.
 *
 * LOOK BASELINE: motion 0.02013, range 0.7132, f0max 0.7466, cardFloor 0.0009 — down 4.3%,
 * 1.0%, 0.7% and a third of a thousandth from T1156's row, because a clumped wood puts less
 * of itself in the average frame than an even one does.
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
      node("veil", "noise", [-900, 0], {
        type: "perlin4d", period: 0.42, harmon: 3, spread: 2, gain: 0.55, rough: 0.5,
        exp: 1, amp: 1.15, offset: 0.5, mono: true, speed: 0.014,
      }, { label: "veil1" }),

      node("forest", "customWgsl", [-600, 0], {
        source: FOREST_WGSL,
        /* The walk — the entire motion budget of this file. */
        walkSpeed: 0.85,
        sway: 0.5,
        bob: 0.045,
        eyeHeight: 1.7,
        pitch: 7,
        lens: 1.45,
        /* The grid. `spacing` is the ceiling on how wide a tree may grow, because a tree
           that left its cell would break the DDA's hit ordering. `clumping` is the one
           that stops the stand reading as a lattice, and `understory` is the one that
           puts a second scale of vertical in the frame (T1170). */
        spacing: 5.2,
        density: 1,
        clumping: 0.85,
        relief: 1.4,
        snags: 0.28,
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

      /* THE NEAR FIELD, OUT OF FOCUS (T1170). Fog already does the far half of depth of
         field, so a far blur would only argue with it; what fog cannot do is soften what
         is too CLOSE, and a trunk passing at arm's length out of focus is the difference
         between walking through a wood and looking at one. `focus` is in metres and reads
         the depth the forest pass wrote into its alpha; `blur` at 0 passes the frame
         through untouched and is the third cost lever in the file. */
      node("dof", "customWgsl", [-300, 0], {
        source: FOREST_DOF_WGSL,
        focus: 8.5,
        blur: 0.016,
      }, { label: "dof1" }),

      node("out", "output", [0, 0], { toneMap: "filmic" }, { label: "out1" }),
    ],
    [
      edge("e-veil-forest", ["veil", "out"], ["forest", "input"]),
      edge("e-forest-dof", ["forest", "out"], ["dof", "input"]),
      edge("e-dof-out", ["dof", "out"], ["out", "input"]),
    ],
  ),
);
