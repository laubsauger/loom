import { settings, node, edge, graph, document, drivenSlot, expressionSlot } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { GRAY_SCOTT_DEFAULTS, GRAY_SCOTT_WGSL } from "../shaders/gray-scott.wgsl.ts";

/* T1234 — every audio read in this file is one of these two. `lvl1` is AudioAnalysis's
   `levels` bag (envelope → rank → settle, 0..1 by construction, §V952) and `hit1` is its
   `hits` bag (1 ms attack, 250 ms decay). The trigger below is the third read and it is
   not a bag: it is the one-frame instant the seed and the stamp need. */
const LEVELS = (key: string): string => `op('lvl1').chan.${key}`;
const HITS = (key: string): string => `op('hit1').chan.${key}`;
const TRIG = "op('trig1').chan.onsetCount";

/**
 * E24 — Audio-Reactive Reaction-Diffusion (T425). The CAPSTONE.
 *
 * E2's rebuilt chemistry, played like an instrument. The owner supplied a TouchDesigner
 * walkthrough as the brief; this file is its mapping onto OUR machinery, node by node:
 *
 *  · AUDIO → SUBSTEPS. The bass level multiplies iterations per frame (T425's whole
 *    reason: the count is a per-frame VALUE), so the pattern physically ACCELERATES on
 *    the beat — not brighter, FASTER. The expression clamps it (1..34) before it ever
 *    reaches the plan, and expandLoops clamps again at encode: two fences, one
 *    contract — a loud passage cannot spike frame time unboundedly.
 *  · AUDIO → CHEMISTRY, RANGE-MAPPED WITH SAFE BOUNDS. The tutorial's own warning is
 *    the teaching: lowMid drives the map-shaping Level's white point, but over a range
 *    the pattern SURVIVES at both ends of (0.48..0.55 on the map's window). Unbounded,
 *    one loud moment drives feed/kill out of the regime where the simulation survives,
 *    the pattern dies, and SILENCE DOES NOT BRING IT BACK — dead state is a fixed
 *    point. The bound is not tuning; it is what makes the instrument recoverable.
 *  · RGB DELAY, HONESTLY TEMPORAL. TD's RGB Delay is time, not space: three cache
 *    rings tap the coloured output at 2, 5 and 9 frames back, and a Reorder wears one
 *    channel from each — motion fringes into rainbow, stillness stays clean. The naive
 *    per-channel-scaling translation would be chromatic aberration, the wrong effect.
 *  · WIND. A Displace INSIDE the loop (state → wind → rd), advecting the state a hair
 *    per iteration. Substeps multiply it, so the bass literally stirs faster — the T350
 *    reference keeps the loop a name (`source: "pack1"`) while the body grows a node.
 *    T734 changed this node's KIND: it was a Transform rotating 0.02 per iteration, and
 *    §V626 is that rotating a lattice leaves it a lattice. Advection shears it.
 *  · SILENCE IS A PICTURE, NOT A FAILURE (§V329). Unbound audio reads all-zero
 *    channels, and a constant ranks at 0.5 (the normaliser's mid-rank convention), so
 *    every level lane rests in the MIDDLE of its range and every hit lane at zero:
 *    substeps 20, the white point 0.515, the lenses off, the palette breathing on its
 *    own LFO — the example ANIMATES (T402) with no track bound, and binding one adds
 *    the instrument on top.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1234 — ONE ANALYSIS INSTANCE, AND THE LANES ARE EXPRESSIONS
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * This file used to condition the audio itself: two Lags, a trigger and TWENTY-EIGHT
 * `valueMath`/`valueLimit` nodes making thirteen gain-and-bias lanes, each pair of
 * operands MEASURED against the Beat pattern (T560's table: `low` rests near 0.14 and
 * peaks near 0.55 through the fast Lag, and so on). Measured is the problem. A raw
 * band × gain lane is a statement about ONE source's loudness, and the same lane on a
 * quiet clip rests at the bottom of its range for the whole piece — the file's own
 * T738 comment recorded `warpc1.weight` resting OFF on material with no top end and
 * called it §T766's. Measured before this rebuild, 30 s of the Beat pattern put the disc
 * at 21.5% occupancy (fraction of disc pixels with V above 0.5) and 30 s of the shipped
 * clip put it at 5.8%: on the pattern the lanes were pinned at the dense end and the
 * bowl was a solid labyrinth, and on the clip the colony was nearly dead. Same graph,
 * two pictures, neither the one that was tuned.
 *
 * `analysis1` (AudioAnalysis, the E66 idiom) replaces all of it. Its `levels` bag is
 * RANKED — where a band sits in its own recent window, 0..1 whatever the source's
 * gain — and its `hits` bag is the counts with a 1 ms attack and a 250 ms decay. Every
 * lane is now an expression on one of those two bags, and the range each expression
 * spans is the WHOLE statement of the mapping: `a + b * op('lvl1').chan.low` rests at
 * `a` and peaks at `a + b`, and there is no third node to hold a fence the arithmetic
 * already states. §V953 governs the numbers: the normaliser hands 0..1 ranked where the
 * old lanes handed raw band × gain, so every target range was re-tuned by eye against
 * the rendered result, not transcribed from the old operands.
 *
 * WHAT STAYED RAW, AND WHY. `trig1` still thresholds `onsetCount` on the switch
 * directly, and the seed gate and the stamp read IT rather than `hit1`. A hit through
 * `hits` has a 250 ms tail; through `crest1`'s opacity into a persistent expanding
 * loop that tail is §V481(b)'s DC term — fifteen frames of stamping per beat instead of
 * one — and through `gate1`'s cut it is fifteen frames of seeding, which is a wash and
 * not a scatter. Those two mappings are one-frame by design and stay on the instant.
 *
 * AND THE BOWL'S OCCUPANCY IS NO LONGER THE MUSIC'S JOB (T1237, folded in here). The
 * kernel's `morph` (band), `shape` (stencil) and `anisotropy` (grain) are the knobs that
 * change WHAT KIND of pattern the disc grows, and they ride three slow free-running LFOs
 * (80 s, 120 s, 164 s laps) — never a beat. A regime change per beat would be a strobe of
 * unrelated textures; over minutes it is the piece evolving. `anisotropy` swings ±0.3
 * against the 0.35 ceiling T1237 measured: past ±0.5 stripes stay alive in the band's
 * high corner where spots do not, and this file's black is that corner being DEAD
 * outside the disc — so the drive must never reach the regime where it is not.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T560 / T562 — TWO CLOCKS, BECAUSE THE OWNER COULD NOT SEE THE AUDIO AND THE FIELD
 * WAS ONE TEXTURE. Both complaints, and both are measurements before they are opinions.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * "I don't even see the audio reactivity. Maybe some stuttering, but nothing compelling."
 * "The reaction diffusion already felt pretty dense and regular instead of interesting
 *  with sparser regions sprinkled in."
 *
 * ## T560 — every audio path ran through a SLOW INTEGRATOR, so transients vanished
 *
 * Everything the sound touched was either Gray-Scott's feed/kill (a reaction that
 * INTEGRATES a beat into a gradual regime change over dozens of frames) or the substep
 * count (the same, one level up). Measured on the shipped file across the beat at frame
 * 194: p90 luminance moved 0.0599 → 0.0615 and p99 moved 0.4000 → 0.4036. Under one
 * percent. The audio was connected; the MEDIUM ate it.
 *
 * The one path that was supposed to be fast was arithmetically dead. `trig1` (a
 * one-frame pulse) fed a `valueLag` of 0.35 s, and a one-pole smoother answers a
 * single-frame impulse with `1 - exp(-dt/tau)` — 0.047 at 60fps. So the palette's
 * driven scale travelled 2.4000 → 2.4535 on a hit: a 2% swing, sold in the comments as
 * "the kick PUNCHES the lookup's gain". That is §V481(b) from the other side — an
 * impulse into a smoother is an impulse DIVIDED BY THE FRAME RATE — and it is why the
 * seeding below drives from the RAW trigger and nothing lags it.
 *
 * The fix was §V471 transplanted from E31, which drives EIGHT properties and most of them
 * respond in the frame they are given: a SECOND, fast lag (`snap1`, 0.04 s) beside the
 * slow one, and one band to one property with its own gain and bias —
 *   low     → the broad lens weight     (the picture swells)
 *   lowMid  → the mid lens weight       (the fronts sway)
 *   high    → the fine lens weight      (the ridges shiver)
 *   highMid → the palette's scale       (§V471.7 — the ramp breathes)
 *   level   → the output Level's gain   (a one-frame lift over everything)
 * and, on the trigger, a SEED into the simulation state (below). §V477 governs every
 * pair: the bias is where silence sits and the gain is the swing, so all five rest LOW.
 * T1234 kept the one-property-per-band SPLIT and replaced the lags and pairs with
 * `analysis1`'s two bags (above): the lenses now ride the three drum COUNTS through
 * `hits`, which is the split the three noises were built with made literal.
 *
 * ## T562 — the chemistry map was a FIELD in name and a CONSTANT in fact
 *
 * The kernel reads `centre.b` per fragment, so the chemistry coordinate has always been
 * per-pixel — the graph paints it and the Reorder packs it. It just had nothing in it.
 * Measured at frame 322, the shipped map's own histogram: 0.45 … 1.00, median 0.645,
 * with HALF of every frame inside 0.60 … 0.69. Across the band that is feed 0.0364 to
 * 0.0377, and Gray-Scott is famously sensitive at the THOUSANDTH. Every region of the
 * picture was therefore running the same chemistry, which is exactly what "dense and
 * regular" looks like — and worse, `detail1` only ever WARPED `broad1`, so the map had
 * one spatial scale, and that scale (period 0.62) was bigger than the frame. The
 * rendered map was a flat pale cloud.
 *
 * Two changes, both on the map and neither on the shader:
 *   · `broad1` gets a smaller period and a third octave, so the map has REGIONS —
 *     features at roughly 150, 75 and 38 pixels of a 512 frame, which is several
 *     Gray-Scott features per region rather than one region per frame.
 *   · `shape1`'s window is narrowed onto the field's actual spread and its gamma lifts
 *     the midtones, so the map SPANS the band instead of hugging one end of it. §V474
 *     sets the direction and it is the direction that was got wrong once already: the
 *     HIGH corner is spots and mitosis and that is where empty field lives, so the map
 *     rests HIGH and dips into the low (labyrinth) corner in patches. Sparse ground,
 *     dense veins, several regimes in one frame.
 * The smoothed envelope still moves the white point, so the regions BREATHE across the
 * band together while sitting at different points on it.
 *
 * ## The other two asks in the same breath
 *
 *  · ONE SOURCE, SEVERAL READINGS (§V471.1). E31 draws one point cloud three times and
 *    splits it by group predicate. The texture analogue is here: the chemistry map is
 *    read a SECOND time, dimmed, and added to the simulation's V before the palette
 *    lookup — so a region's chemistry sets its base hue while V rides on top of it. The
 *    field was monochrome because V is near-binary and a near-binary coordinate visits
 *    exactly two stops of a five-stop ramp; adding a continuous term is what makes the
 *    middle of the ramp exist.
 *  · COLOUR EVOLUTION OVER TIME. The palette's own LFO stays; a second, SLOWER one
 *    (0.033 Hz — a 30-second lap, §V471.8) drives an HSV hue offset over the finished
 *    picture, so an hour of it never sits in one place. Free-running (§V436, B98).
 */
export const audioRdDocument = document(
  "e24-audio-reaction-diffusion",
  "E24 Audio Reaction-Diffusion",
  settings({ outputResolution: { width: 512, height: 512 } }),
  graph(
    [
      // ---- the sound: two sources, one SWITCH, never both ------------------------
      /*
       * T442 (B74, §V363): the flagship PLAYS on first open. Assets are session-only, so
       * no example can ship a bound audio file — and an audio-reactive graph whose null
       * state is indistinguishable from a broken one demos nothing.
       *
       * T504 — AND YOUR OWN TRACK IS ONE DROP AWAY. Both sources are wired, permanently,
       * into `source1`, and the Switch's `index` picks: 0 is the deterministic pattern,
       * 1 is whatever file you drop on `track1`. Nothing downstream changes, because
       * everything downstream reads `source1`.
       *
       * IT HAS TO BE A SWITCH AND IT CANNOT BE A WIRE. Two value sources landing on ONE
       * port MERGE — `{...prior, ...next}` over sorted edge ids (§V457) — and both of
       * these publish the same channel names, so the later edge would win outright and
       * the other source would silently vanish. That is not "mixing them together", it
       * is worse: it is one of them disappearing with the graph still looking right.
       * `valueSwitch` (T508) is exclusive by construction — the unselected branch is not
       * read into the output at all.
       */
      node("music", "audioPattern", [-2000, 300], { bpm: 112, amount: 1 }, { label: "music1" }),
      /*
       * THE DROP TARGET, and it is placed where you would look for it: directly under the
       * pattern it replaces, wired into the same box, with an empty File parameter waiting.
       * Nothing about the graph has to be read to see where a track goes.
       * T493 gave this node a transport (play mode, speed, cue, trim, volume) — all on its
       * defaults here, which is a timeline-anchored playhead, so bar one of your track
       * lands on the in point and an offline render of it reproduces.
       */
      node("track", "audioFileIn", [-2000, 640], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-1720, 460], {
        /* 0 = the pattern, 1 = the file. The ORDER is the port order (in1, in2), not an
           edge tiebreak — value ports are named, so this is unambiguous by construction
           in a way the texture Switch's variadic port is not (§V131). */
        index: 0,
      }, { label: "source1" }),
      /* ---- ONE ANALYSIS, ONE TRIGGER, THREE SLOW CLOCKS (T1234) ----------------------
       *
       * `analysis1` is the whole conditioning stage. Its `levels` bag is a RANK — where
       * each band sits in its own recent window — so `low` reads 0 on this source's
       * quietest bars and 1 on its loudest whatever the source's gain, and its `hits` bag
       * is the counts with a 1 ms attack and a 250 ms decay (§V952). `lvl1` and `hit1`
       * are Selects at `*` on each bag: they exist so every expression below names a bag
       * rather than a component port, and they pass the bag through unchanged (T1302b).
       * They were `valueLimit 0..1`, the identity only on lanes that live there — the
       * hits bag also carries the tempo claim, and the Limit clipped `bpm` 112 to 1.
       *
       * `trig1` stays, and stays on the RAW switch: the seed gate and the stamp need an
       * INSTANT, and a 250 ms decay into `crest1`'s persistent expanding loop is §V481(b)'s
       * DC term — fifteen frames of stamping per beat where one is the design. §V509 is
       * the other half of the same rule: a one-pole answers a single-frame impulse with
       * 1-exp(-dt/tau), so the trigger goes through nothing at all.
       */
      node("analysis", "component:audioAnalysis@1", [-1440, 460], {
        envelope: 0.08, window: 16, settle: 0.15, hitDecay: 250,
      }, { label: "analysis1" }),
      node("lvl", "valueSelect", [-1160, 380], { channels: "*" }, { label: "lvl1" }),
      node("hit", "valueSelect", [-1160, 560], { channels: "*" }, { label: "hit1" }),
      node("trig", "valueTrigger", [-1440, 760], { threshold: 0.5 }, { label: "trig1" }),
      /* T1237 — WHAT KIND OF PATTERN THE DISC GROWS, on three free-running clocks that
         never share a period. `band1` walks the kernel's `morph` 0..1 (mitosis spots at 0,
         the holes regime — negative spots in a foam, the Voronoi look — at 1) over 80 s;
         `stencil1` walks `shape` -1..1 (diagonal-heavy, isotropic, cross-heavy: rotated
         square, round, lattice square) over 120 s; `grain1` walks `anisotropy` ±0.3 (faster
         diffusion along y, then along x) over 164 s. Three incommensurate laps, so the
         combination never repeats inside a set. Free-running (§V436, B98). The amplitude
         on `grain1` is the one number here that is a FENCE and not a taste: T1237 measured
         stripes surviving where spots die past |0.5|, and the 0.35 ceiling is in the docblock. */
      node("band", "lfo", [-1440, 1000], { shape: "sine", frequency: 0.0125, amplitude: 0.5, offset: 0.5 }, {
        label: "band1",
      }),
      node("stencil", "lfo", [-1440, 1200], { shape: "sine", frequency: 0.0083, amplitude: 1, offset: 0 }, {
        label: "stencil1",
      }),
      node("grain", "lfo", [-1440, 1400], { shape: "sine", frequency: 0.0061, amplitude: 0.3, offset: 0 }, {
        label: "grain1",
      }),
      // ---- the chemistry map (E2's, verbatim in spirit) -------------------------
      /* T535: `t4d` is 0.37, not 0. Zero sits ON a lattice plane of the 4D noise, where the
         gradient basis collapses and amplitude with it — so frame 0 is systematically
         flatter than every later frame, and frame 0 is exactly what a gallery thumbnail
         shows. Starting off-lattice makes the first frame representative of the piece.
         `exp` above 1 is T507's negative space at the SOURCE: a power on a 0..1 field pulls
         the midtones down, so the chemistry map has broad quiet plains with peaks standing
         out of them instead of a uniform mid-grey everywhere. */
      /* T562 — THE MAP NEEDED REGIONS, and period 0.62 with two octaves gave it none: one
         feature bigger than the frame, so the rendered map was a flat pale cloud and every
         part of the picture ran the same chemistry. 0.30 with THREE octaves puts features
         at roughly 150, 75 and 38 pixels of a 512 frame — several Gray-Scott features per
         region, which is the scale at which "this area is spots and that one is labyrinth"
         is a thing the eye can see rather than a statistic. */
      node("broad", "noise", [-1460, -140], {
        type: "perlin4d", seed: 5, period: 0.3, harmon: 3, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1.25, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.05,
      }, { label: "broad1" }),
      node("detail", "noise", [-1460, 117], {
        type: "perlin4d", seed: 19, period: 0.15, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.6, exp: 1.2, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.09,
      }, { label: "detail1" }),
      node("warp", "displace", [-1180, -60], {
        weight: [0.22, 0.22], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, { label: "warp1" }),
      node("shape", "level", [-940, -60], {
        /* T507 — NEGATIVE SPACE. The owner's read was that the dish sat too dense: every
           part of the frame in the labyrinth regime at once, so the reaction-diffusion had
           no empty field to resolve against and the whole thing read as one texture. This
           is the lever, and the DIRECTION is the finding: my first attempt raised
           `blacklevel` to push more of the map to the LOW end of the band, and the frame
           came back DENSER — wall-to-wall labyrinth. Gray-Scott's low corner
           (feed 0.028 / kill 0.0545) is the labyrinth regime; the HIGH corner is spots
           and mitosis, which is where the empty field lives. So negative space here means
           lowering the black point and lifting the midtones (gamma under 1), not raising
           them. Measured at four settings; 0.09 was too sparse to be a picture, 0.46 was
           the fingerprint, and this sits where a coherent organism has a void around it.
           §V427 is the reason to fix it HERE rather than by masking the output: the
           structure is the simulation's, and giving it room is a chemistry decision.

           T562 — AND THE WINDOW WAS THE OTHER HALF OF IT. Measured, the shipped settings
           put the map at median 0.645 with half of every frame inside 0.60..0.69 — one
           twentieth of the band, which across feed/kill is 0.0013 and therefore one
           chemistry everywhere. The warped field's own p10..p90 is 0.465..0.539 — an
           interquartile of 0.039 — so a window of 0.485 was twelve times wider than the
           signal in it and the Level was mostly moving DC around. 0.451..0.543 is fitted
           to the field's MEASURED spread, which is what makes the map span; contrast
           goes back to 1 because a narrow window IS the contrast and two controls doing
           one job is how the first set got so hard to reason about; and gamma 1.25 lifts
           the midtones so the map RESTS in the high (spots, empty ground) corner and dips
           into the low (labyrinth) corner in patches, which is §V474's direction. The
           tails fall OUTSIDE the window on purpose — the kernel clamps the coordinate, so
           the deepest patches sit at the labyrinth end and the airiest at the mitosis end
           rather than everything crowding the middle. */
        blacklevel: 0.451, contrast: 1, brightness: 1, gamma1: 1.25,
      }, {
        label: "shape1",
        /* T1234 — the white point on the lowMid RANK. Measured over 30 s of the pattern with
           the point held static: 0.49 covers 39% of the disc (V above 0.1), 0.55 covers
           68%, 0.60 covers 83% and is the solid labyrinth the owner called blown out.
           0.48..0.55 is rest-sparse to peak-dense with the colony alive at both ends;
           the retained 0.515 is the middle of it. */
        parameters: { whitelevel: expressionSlot(`0.48 + 0.07 * ${LEVELS("lowMid")}`, 0.515) },
      }),

      /* ---- T598: WHERE THE ORGANISM IS ALLOWED TO EXIST ------------------------------
       *
       * The owner's reference is four fifths BLACK, with the living material a small dense
       * cluster off the middle. Every earlier round of this file argued about the TEXTURE
       * and left the COMPOSITION alone, and a wall-to-wall carpet is a composition however
       * beautiful its texture is. Measured on the reference: 77.9% of it is under 0.08
       * displayed luminance and its 90th percentile is 0.127; the shipped E24 measured
       * 65.2% and 0.431. The gap is not a grade, it is where the material is.
       *
       * `bowl1` is that decision as one node — a soft disc, off-centre, and everything
       * about the frame's occupancy is its `center`, `radius` and `softness`. It is read
       * TWICE and never drawn (§V471.1): once inverted, as the chemistry's kill switch,
       * and once straight, as the mask on the beat's seeding. Two readings of one shape is
       * why "where does the material live" is a single number to change.
       *
       * IT IS A CHEMISTRY DECISION AND NOT A MATTE, which is §V427's point and T507's: a
       * matte over the output would leave a full-frame simulation running underneath and
       * cropped, and the edge would be a cut. `rim1` inverts the disc to 1 OUTSIDE, and
       * `dish1` SCREENS that into the map — `1-(1-a)(1-b)` is exactly `mix(map, 1, rim)`
       * for a 0..1 rim, so outside the disc the coordinate is pinned at the band's HIGH
       * corner. §V474: the high corner (feed 0.042, kill 0.068) fails Gray-Scott's own
       * existence condition — `F < 4(F+k)^2`, 0.042 against 0.0484 — so V there does not
       * merely go sparse, it has no non-trivial steady state at all and decays to nothing.
       * The black is the simulation being genuinely empty, and the soft edge of the disc
       * is a gradient THROUGH the band, so the cluster frays into spots before it stops.
       */
      node("bowl", "circle", [-1720, -420], {
        mode: "fill", center: [0.395, 0.635], radius: [0.225, 0.225], softness: 0.055,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "bowl1" }),
      node("rim", "level", [-1720, -160], {
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, invert: 1, opacity: 1,
      }, { label: "rim1" }),
      node("dish", "screen", [-700, -127], { opacity: 1 }, { label: "dish1" }),

      // ---- the simulation loop, with wind ---------------------------------------
      node("state", "feedback", [-680, 162], { source: "pack1", persistence: 1, clearColor: [0, 0, 0, 0] }, {
        resolution: { mode: "fixed", width: 512, height: 512 },
        format: { mode: "fixed", format: "rgba16float" },
        // T1234: 8 at the quietest bar, 32 at the loudest, clamped 1..34 in the expression.
        // Retained 20 is the rank's own mid (a constant input ranks 0.5), i.e. silence.
        parameters: { substeps: expressionSlot(`clamp(8 + 24 * ${LEVELS("low")}, 1, 34)`, 20) },
      }),
      /*
       * THE WIND. A hair of flow per ITERATION, inside the loop — substeps multiply it, so
       * the bass stirs the dish faster, which is the point.
       *
       * T734: this used to be a Transform with `r: 0.02`, a RIGID ROTATION applied 17-24
       * times per frame, and §V626 says exactly what that buys: a rotation turns a lattice
       * and leaves it a lattice. Advecting the state along a slow two-channel flow shears
       * it instead, and it beats the rotation on motion at EVERY age — at frame 1800,
       * motion 0.0462 -> 0.0624 and live spot count 238 -> 907.
       *
       * `mono: false` is load-bearing: one channel means one offset for every texel, which
       * is a translation. The chemistry map is NOT carried along — `pack1` repaints blue
       * from `dish1` after the reaction — so this is advection through a static parameter
       * field, which is the thing that shears.
       */
      node("swell", "noise", [-440, -140], {
        type: "perlin4d", seed: 41, period: 0.55, harmon: 2, spread: 2, gain: 0.55, rough: 0.5,
        exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true, t4d: 0.37, s4d: 1, speed: 0.035,
      }, { label: "swell1", resolution: { mode: "fixed", width: 512, height: 512 } }),
      node("wind", "displace", [-440, 120], {
        weight: [0.0002, 0.0002], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold",
      }, { label: "wind1", resolution: { mode: "fixed", width: 512, height: 512 } }),
      node("rd", "customWgsl", [-200, 120], {
        [SHADER_SOURCE_PARAMETER]: GRAY_SCOTT_WGSL,
        ...GRAY_SCOTT_DEFAULTS,
      }, {
        label: "rd1",
        // T1237: what kind of pattern, on the three slow clocks above. Never on a beat.
        parameters: {
          morph: drivenSlot("band1", 0),
          shape: drivenSlot("stencil1", 0),
          anisotropy: drivenSlot("grain1", 0),
          /* T1269 (B199) — THE SQUARES ARE GROWN, because the stencil alone cannot show them
             here. T1237's `shape` squares a front through the 9-tap Laplacian's lattice error,
             and that only shows on features a few texels wide; E24's spots are 8-10 px on this
             512 plate, where every split of the weights looks round. Measured: `shape` pinned at
             -1 or +1 for a whole run left the colony at f600/1800/3600 looking like the shipped
             one. (Not a false claim in T1237's own Dawn tests: they measure grain-scale effects
             on E2's bench, a scale E24's features never reach.) `facet` makes diffusion depend
             on the FRONT's orientation, 1 + facet·cos4θ, so fronts grow flat faces at any size
             and the colony keeps its density. It rides the same lane as `shape`, so the two
             agree: -1 squares on the grid, +1 turns them 45°, 0 is round. 0.6 is the owner's
             pick from the strength ladder (T1269); past 0.9 the colony dies back. */
          facet: expressionSlot("0.6 * op('stencil1').chan.value", 0),
        },
      }),

      /* ---- T560: THE BEAT SEEDS THE PLATE ---------------------------------------------
       *
       * A sparse field, gated open for exactly the frame the trigger fires, SCREENED into
       * the simulation's state. Screen is the operator this wants and not a convenience:
       * `1-(1-a)(1-b)` takes U and V to 1 where the mask is 1 and leaves them untouched
       * where it is 0, and (U=1, V=1) in a small patch is LITERALLY the kernel's own
       * `seededState` — the classic Gray-Scott starting plate. So a hit does not brighten
       * the picture, it drops new chemistry into it, and the reaction spends the next
       * second growing what the beat put there. That is the difference between an event
       * you can see and a rate you cannot.
       *
       * The lookup reads THIS node rather than `rd1`, so the seed is in the frame it
       * lands on rather than one frame later.
       *
       * `speed: 0.9` is what keeps consecutive beats from seeding the same places: the
       * field has moved most of a feature between hits, so the constellation is new every
       * time. Free-running (§V436) like every other field here.
       */
      node("spark", "noise", [-460, -400], {
        type: "perlin4d", seed: 313, period: 0.035, harmon: 1, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.9,
      }, { label: "spark1" }),
      /* T598 — AND THE SEED IS CONFINED TO THE SAME DISC, by multiplying the field before
         the gate rather than the gate's output after it. Outside `bowl1` the sparse field
         is exactly zero, so it cannot cross the cut however far the cut drops, and no beat
         can strew a one-frame sprinkle across the empty four fifths of the frame. Masking
         the FIELD and not the MASK matters here: the cut is what the trigger drives, and a
         zero field keeps the gate honestly shut instead of shut-then-multiplied-out. */
      node("sow", "multiply", [-700, -416], { opacity: 1 }, { label: "sow1" }),
      node("gate", "threshold", [-200, -400], {
        softness: 0.06, channel: "luminance", compare: "greater",
      }, {
        label: "gate1",
        parameters: { threshold: expressionSlot(`2 - 1.28 * ${TRIG}`, 2) },
      }),
      /* THE MASK IS THE FRONT and the simulation is the back, which looks backwards for a
         commutative operator and is not: Composite's `opacity` scales the FRONT only, so
         wiring it this way turns `opacity` into "how much V a hit drops into the plate" —
         the seed's amplitude, on the node that does the seeding, with no extra node to
         hold it. At 0.5 the strike is strong enough to start a colony and short of the
         saturating V=1 that made every seed read as a white-hot pop for one frame. */
      /* T598 — AND IT CARRIES THE SIMULATION'S OWN RESOLUTION, which is a latent flaw this
         round had to fix before it could measure anything. Composite inherits its size from
         `in1`, and `in1` is the GATE (that is §V510: opacity scales the front, so the mask
         has to be the front). The gate is a `project`-resolution chain, so the loop was
         running 512-square through `rd1`, being DOWNSAMPLED to the output's size here, and
         being resampled back up by `state1` — a low-pass through the whole reaction, once
         per frame. At 512-square output that is a no-op and nothing showed; at T521's
         192x108 probe it wipes Gray-Scott's structure out completely, and with the T598
         disc confining the chemistry to a fifth of the frame there was not enough left to
         survive it: the probe measured range 0.0700 and a colony that DIED by frame 600.
         Pinning the composite to the state's size takes the output resolution out of the
         simulation entirely, which is what it should never have been in. */
      node("inject", "screen", [60, 240], { opacity: 0.6 }, {
        label: "inject1",
        resolution: { mode: "fixed", width: 512, height: 512 },
      }),

      node("pack", "reorder", [320, 120], {
        outr: "in1r", outg: "in1g", outb: "in2lum", outa: "in1a",
      }, { label: "pack1" }),

      // ---- colour, then TIME ----------------------------------------------------
      /* SEVEN STOPS THAT TRAVEL (§V471.6): near-black, near-black navy, blue, violet,
         crimson, gold, cream. E31's arc, and the reason it is worth copying is that it
         crosses HUE as well as brightness — a ramp from navy to cream through nothing
         gives a monochrome picture however many stops it has. The shipped ramp had five
         and was perfectly good; the reason it read as two colours is below, and it is not
         the ramp's fault. */
      node("palette", "ramp", [60, 818], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.004, 0.006, 0.025, 1] },
          { position: 0.16, color: [0.012, 0.025, 0.09, 1] },
          { position: 0.34, color: [0.07, 0.19, 0.5, 1] },
          { position: 0.52, color: [0.44, 0.18, 0.66, 1] },
          { position: 0.7, color: [0.98, 0.36, 0.26, 1] },
          { position: 0.87, color: [1, 0.7, 0.3, 1] },
          { position: 1, color: [1, 0.96, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("cycle", "lfo", [60, 1075], { shape: "sine", frequency: 0.05, amplitude: 0.06, offset: 0 }, {
        label: "lfo1",
      }),
      /* ---- §V471.1: THE CHEMISTRY MAP, READ A SECOND TIME — as COLOUR -----------------
       *
       * E31 gets its richness from drawing ONE point cloud three times and splitting it by
       * group predicate: structure from SELECTION, not from more nodes. The texture
       * analogue is a second reading of a field already in the graph, and the field that
       * earns it is the chemistry map, because it is the thing that differs from region to
       * region.
       *
       * Why it is needed at all: the Lookup's coordinate was V alone, and V in Gray-Scott
       * is NEAR-BINARY — empty plate or front, nothing in between. A near-binary
       * coordinate visits exactly two positions on a ramp however many stops that ramp
       * has, which is why the shipped file was cream fronts on navy and the blue and teal
       * in the middle of its palette were never on screen. Adding a dimmed, CONTINUOUS
       * term moves each region's ground to its own place on the ramp and carries its
       * fronts with it: the hue now says which chemistry you are looking at, and V says
       * how far along the reaction is. Opacity 0 so the add contributes colour and no
       * coverage.
       *
       * T598 — IT NOW READS THE MASKED MAP AND IT IS INVERTED, and both halves are forced
       * by the composition rather than chosen. `dish1` is pinned at 1 outside the disc, so
       * reading it straight would lift the empty four fifths of the frame to ramp position
       * 0.11×2.25 = 0.25 — a navy ground everywhere, which is exactly the wall-to-wall look
       * this round exists to remove. Inverted, the dead field contributes EXACTLY ZERO and
       * the ground is the ramp's own first stop, which is black. Inside the disc the sense
       * is also the better one: a region running the LOW (labyrinth) chemistry is the dense
       * one, and it now gets the warmer base rather than the colder. */
      node("chem", "level", [-200, 700], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 1,
        brightness: 0.17, opacity: 0,
      }, { label: "chem1" }),
      node("blend", "add", [60, 529], {}, { label: "blend1" }),
      node("tint", "lookup", [320, 393], { channel: "green", row: 0.5 }, {
        label: "tint1",
        parameters: {
          offset: drivenSlot("lfo1", 0),
          /* §V471.7 — the grade BREATHES with highMid. Rest at 2.25 puts the FRONTS
             in the crimson and leaves the gold and cream as somewhere for a loud passage
             to reach, while the ground — V is near zero over most of the frame — sits down
             in the navy whatever the music does. The shipped 2.4 rest had the fronts
             already at cream, which is §V477's "always in blast mode" and the reason a hit
             had nowhere to go. */
          scale: expressionSlot(`1.6 + 1.3 * ${LEVELS("highMid")}`, 2.25),
        },
      }),

      /* ═══ T598 — THE OUTWARD DRIVING FORCE, AND THE FEEDBACK THAT CARRIES IT ═══════════
       *
       * The owner's third ask came with a picture: concentric rings propagating outward
       * from a centre, several systems of them at once, and the material carried out with
       * them so a ring TRAVELS rather than sitting there as a moiré. Six nodes, and every
       * one of them is E29-Descent's mechanism rather than a rediscovery of it (§V481).
       *
       * ## What is born, and by WHAT
       *
       * `rings1` is a RADIAL ramp with `period: 6` — one node, six concentric rings, which
       * is the "several ring systems at different scales" of the reference read literally.
       * Its coordinate is `clamp(|uv-0.5|*2, 0, 1)`, so the rings are born inside the
       * frame's inscribed circle and the loop below is what carries them out past the
       * corners. `phase` rides `lfo1` (the palette's own 20-second sine, read a second
       * time) so consecutive beats do not stamp their rings at identical radii and the set
       * never stands still.
       *
       * §V481(b) IS THE WHOLE DESIGN OF `crest1`. Anything added into a persistent loop
       * every frame is a DC term: at persistence 0.972 the loop integrates it about
       * thirty-five fold and the frame goes white — three of E29's thirteen builds died
       * exactly there. So the ring family and the living cluster are added through an
       * `opacity` that is 0.02 at rest and 0.62 for the ONE frame `trig1` fires. A beat
       * STAMPS the current picture and a new set of rings into the loop; between beats
       * nothing enters it at all, and the mean input is a thirtieth of the peak by
       * construction rather than by luck. That is also, exactly, the owner's sentence: a
       * beat sends a ring outward.
       *
       * And it is why the stamp carries `tint1` as well as the rings. The reference's
       * speckle is not one cluster — it is the SAME cluster at three or four sizes, out
       * along the rings, each one older and blurrier than the last. Those are strobed
       * copies of the living material, which is what a magnifying loop does to anything
       * you drop into it once per beat.
       *
       * ## What carries it, and what stops it running away
       *
       * §V481(a), the one that cost E29 four builds: AN EXPANDING LOOP DOES NOT DIM
       * ITSELF. `s > 1` DIVIDES the sampling coordinates, so `grow1` magnifies about the
       * frame's centre and DUPLICATES pixels — nothing leaves, nothing is diluted, and a
       * near-unity gain goes to white in seconds. Every bit of the decay here is
       * deliberate: `echo1`'s persistence, `dim1`'s black point, and `dim1`'s gamma.
       *
       * §V481(c) WITH ITS SIGN CHECKED AGAINST THIS CATALOGUE'S SHADER, which is worth
       * stating because the invariant's word and this node's parameter point opposite
       * ways. Level computes `pow(c, 1.0/gamma1)`. Contractive therefore means gamma1
       * BELOW one: 0.86 is the exponent 1.163, which is under `v` everywhere in [0,1) and
       * so sharpens and shrinks in the same term. A gamma1 ABOVE one in this node is
       * positive feedback, as a Contrast above one would be.
       *
       * `extend: "zero"` on the magnify, not `hold`: with hold, the edge pixels of an
       * expanding image streak outward forever and the corners fill with smeared colour.
       * The quarter-degree of rotation per pass does nothing to the rings — a rotation of
       * a rotationally symmetric figure is invisible, which E29 learned the expensive way
       * — but the STAMPED CLUSTER is not symmetric, so its echoes spiral as they travel
       * and the shells read as depth rather than as a bullseye.
       *
       * `grow1`'s scale is on the audio (the `low` rank), which is E29's lurch: the whole
       * field SURGES outward on a loud bar and settles over the quiet one. Both fences are
       * arithmetic rather than a clamp — the rank is 0..1 and the expression spans
       * 1.008…1.029, so it can neither stop expanding (which piles up into white) nor
       * outrun the eye.
       *
       * ## Where it closes, and where it is read again
       *
       * The loop closes on the GRADED picture (§V471.5): `tint1` is downstream of the
       * palette, so the echoes carry the ramp's own colour instead of raw simulation
       * state. `show1` then puts the LIVE cluster back on top at full strength, which is
       * the second reason the stamp is strobed — the thing you are watching is never the
       * loop's own copy of itself.
       *
       * And `crest1` is read a SECOND time, as the finest lens (§V471.1): the ring field is
       * `warpc1`'s displacement source, so the picture is physically pushed where a ring
       * crosses it. `offset: [0, 0]` there rather than the usual 0.5 — the field is black
       * over most of the frame, and a 0.5 offset would turn "no ring here" into a constant
       * diagonal slide of the whole image. At 0 the displacement is zero where the field
       * is, and only the rings move anything.
       */
      node("rings", "ramp", [320, 1120], {
        type: "radial", interp: "smooth", period: 8,
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.14, color: [0, 0, 0, 1] },
          { position: 0.56, color: [0.075, 0.08, 0.095, 1] },
          { position: 0.83, color: [0.28, 0.3, 0.36, 1] },
          { position: 0.97, color: [0, 0, 0, 1] },
          { position: 1, color: [0, 0, 0, 1] },
        ],
      }, { label: "rings1", definitionVersion: 2, parameters: { phase: drivenSlot("lfo1", 0) } }),
      /* THE PICTURE IS THE FRONT AND THE RINGS ARE BEHIND, which is the opposite of how
         the stack reads and is the only wiring that does the job. `opacity` scales the
         FRONT only, so this one number says "stamp the ring family WHOLE and the living
         picture at a third of itself". Both halves of that are load-bearing. The echoes
         should be a HINT of the material — the reference's outer shells are ghosts of its
         centre, not second copies of it — and it is also what keeps the loop stable: the
         cluster's fronts reach V=1 and the ramp's cream, and a full-strength stamp of THAT
         every beat is the one term in here that can integrate past 1. Wired the other way
         round (measured, and it is an easy mistake because the ring is what you are
         thinking about) the number lands on the rings instead and they go three times too
         faint while the echoes go three times too hot: the frame becomes a bright smear
         with a couple of arcs in the corner of it. */
      node("stamp", "add", [580, 1120], { opacity: 0.32 }, { label: "stamp1" }),
      node("echo", "feedback", [840, 1120], {
        source: "crest1", persistence: 0.987, clearColor: [0, 0, 0, 1],
      }, { label: "echo1" }),
      node("grow", "transform", [1100, 1120], {
        t: [0, 0], r: 0.25, s: [1.012, 1.012], p: [0, 0], xord: "srt", extend: "zero",
        aspectcorrect: true,
      }, {
        label: "grow1",
        parameters: {
          "s.x": expressionSlot(`1.008 + 0.021 * ${LEVELS("low")}`, 1.0185),
          "s.y": expressionSlot(`1.008 + 0.021 * ${LEVELS("low")}`, 1.0185),
        },
      }),
      node("fade", "level", [1360, 1120], {
        blacklevel: 0.0005, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 0.98, opacity: 1,
      }, { label: "dim1" }),
      /* T1234 — THE LOOP IS CAPPED, because the rebuild made it honestly expansive. The
         old `grow1` lane rested at s = 0.9736 + 0.0569 × low, which on the pattern's raw
         band is 0.982: the loop the comments call an expansion was SHRINKING at rest and
         only crossed 1 on the loudest bars, and on a quiet clip never. On the low RANK it
         now runs 1.008..1.029 always, and §V481(c)'s dimming — gamma1 0.98 — is contractive
         only in [0,1): above 1 `pow(v, 1/0.98)` GROWS, and 0.987 × v^1.02 outruns v once v
         passes 1.9. Measured on the clip's loud bars at frame 1800 the top-right corner had
         diverged to inf and rendered as a hard magenta band. A clamp at 1 in the loop is
         the bound the persistence and the gamma cannot supply — bounded input, bounded
         state — and it costs nothing in [0,1] where the loop was already correct. */
      node("cap", "limit", [1490, 1420], { mode: "clamp", low: 0, high: 1 }, { label: "cap1" }),
      node("born", "add", [1620, 1120], {}, {
        label: "crest1",
        parameters: { opacity: expressionSlot(`0.02 + 0.6 * ${TRIG}`, 0.02) },
      }),
      node("show", "add", [1880, 1120], {}, { label: "show1" }),

      /* ---- T507: THREE LENSES, and the point is that they are at different SCALES ----
       *
       * The owner's reference stacked roughly three layers of lens. Stacking is not "turn
       * the displacement up": one strong displacement is a smear, and a smear has no
       * depth in it. Three at genuinely different spatial frequencies and rates read as
       * separated layers of glass — a broad slow swell you feel rather than see, a mid one
       * that gives the fronts their sway, and a fine fast one that is the only thing
       * touching the individual ridges.
       *
       * Each is ~2.5x finer and ~2.5x faster than the one before it, with a third of the
       * weight, so no layer can dominate. The weights come down as the frequency goes up
       * for the same reason a fractal's gain does: equal weight at every scale is white
       * noise, not depth.
       *
       * MONO IS OFF ON ALL THREE, and that is the difference between a lens and a shear.
       * `displace` reads x from red and y from green; a MONOCHROME field has red == green,
       * so every pixel moves along the SAME 45-degree diagonal and the image slides rather
       * than warps. (E24's older `warp1` on the chemistry map is mono and does exactly
       * that — deliberately, because a diagonal shear of a feed/kill map is a fine thing
       * to want; it is not what a lens is.)
       *
       * They sit AFTER the palette and BEFORE the cache rings, so the RGB delay tastes the
       * lens motion: glass that moves disperses, and the fringing follows the warp.
       *
       * T560 — AND ALL THREE AMOUNTS ARE NOW ON THE AUDIO, one drum each, which is the
       * whole T507 structure finally being audible. They were built at genuinely
       * different scales and rates; driving them from ONE envelope would have collapsed
       * that back into a single pump. T1234 made the split literal: coarse on
       * `kickCount` (the picture swells on the kick), mid on `snareCount` (the fronts
       * sway with the snare), fine on `hatCount` (the ridges shiver with the hats), each
       * through `hits`' 250 ms decay, so a lens is OFF between drums and a drum is a
       * swell and not a step. Ceilings 0.14 / 0.06 / 0.02 are the peaks T560 measured the
       * old lanes reaching on the pattern, kept by eye: a first cut at 0.22 / 0.16 / 0.09
       * mirrored the frame's edge into the picture on the clip's loud bars, because a
       * kick and a snare on one frame now ADD where the old lanes shared one band. The
       * retained values below are the shipped weights, so every host without the channel
       * attached still gets the picture T507 tuned.
       *
       * T598 — THE THIRD LENS IS NOW THE RING FIELD, and that is a node REMOVED rather
       * than added. `lensc1` was a fine, fast perlin and it was the one layer with nothing
       * to say: the fastest displacement in the file was uncorrelated with everything else
       * in it. `crest1` is faster, is already in the graph, and is the thing the picture is
       * about — so the finest glass now ripples exactly where a ring is passing.
       */
      node("lensA", "noise", [1880, 860], {
        type: "perlin4d", seed: 71, period: 1.15, harmon: 1, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.018,
      }, { label: "lensa1" }),
      node("warpA", "displace", [2140, 380], {
        offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpa1",
        parameters: {
          "weight.x": expressionSlot(`0.14 * ${HITS("kickCount")}`, 0.062),
          "weight.y": expressionSlot(`0.14 * ${HITS("kickCount")}`, 0.062),
        },
      }),
      node("lensB", "noise", [2140, 860], {
        type: "perlin4d", seed: 137, period: 0.42, harmon: 2, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.046,
      }, { label: "lensb1" }),
      node("warpB", "displace", [2400, 380], {
        offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpb1",
        parameters: {
          "weight.x": expressionSlot(`0.06 * ${HITS("snareCount")}`, 0.024),
          "weight.y": expressionSlot(`0.06 * ${HITS("snareCount")}`, 0.024),
        },
      }),
      node("warpC", "displace", [2660, 380], {
        offset: [0, 0], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpc1",
        parameters: {
          "weight.x": expressionSlot(`0.02 * ${HITS("hatCount")}`, 0.011),
          "weight.y": expressionSlot(`0.02 * ${HITS("hatCount")}`, 0.011),
        },
      }),

      // The RGB delay: three taps into time, one per channel. Full scale — this ring
      // is read for its colour, not just its motion.
      node("tapR", "cache", [2920, 240], { frames: 4, index: 2, scale: 1 }, { label: "tapr1" }),
      node("tapG", "cache", [2920, 500], { frames: 5, index: 4, scale: 1 }, { label: "tapg1" }),
      node("tapB", "cache", [2920, 760], { frames: 8, index: 7, scale: 1 }, { label: "tapb1" }),
      // Reorder is two-input, so the three taps braid in two steps: red-with-green
      // first, then the blue tap joins.
      node("fringeRG", "reorder", [3180, 330], {
        outr: "in1r", outg: "in2g", outb: "in1b", outa: "in1a",
      }, { label: "fringerg1" }),
      node("fringe", "reorder", [3440, 600], {
        outr: "in1r", outg: "in1g", outb: "in2b", outa: "in1a",
      }, { label: "fringe1" }),
      /* T560 — THE LIFT. The fastest path in the file: `level` on the finished picture,
         its Brightness on `onsetCount` through `hits` (T1234: 1 ms up, 250 ms down), so it
         is up on the frame a hit lands and back inside the beat. Rest 0.94 against a hit at
         1.24 is §V477 again — the calm state is deliberately UNDER unity so the hit is a
         lift rather than a clip, and the picture has a floor to come back to. */
      node("glow", "level", [3700, 600], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "glow1", parameters: { brightness: expressionSlot(`0.94 + 0.3 * ${HITS("onsetCount")}`, 0.94) } }),
      /* §V471.8 — A LONG CYCLE. 0.033 Hz is a 30-SECOND lap, slower than anyone's
         attention span, which is most of why an hour of E31 is watchable. The palette's
         own LFO above moves the ramp's offset a hair at 0.05 Hz; this one turns the whole
         graded picture through ±15° of hue, so the piece never sits in one colour.
         Free-running (§V436, B98): a timeline lap must not restart the drift. */
      node("drift", "lfo", [3700, 857], {
        shape: "sine", frequency: 0.033, amplitude: 15, offset: 0, phase: 0,
      }, { label: "drift1" }),
      node("hue", "hsv", [3960, 600], { saturation: 1.08, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      node("out", "output", [4220, 600]),
    ],
    [
      // sound. BOTH sources reach the Switch; exactly one leaves it.
      edge("e-music-source", ["music", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      // T1234: one analysis off the switch, two bags off the analysis, and the raw trigger.
      edge("e-source-analysis", ["source", "out"], ["analysis", "audio"]),
      edge("e-analysis-lvl", ["analysis", "levels"], ["lvl", "in"]),
      edge("e-analysis-hit", ["analysis", "hits"], ["hit", "in"]),
      edge("e-source-trig", ["source", "out"], ["trig", "in"]),
      // chemistry map, and the disc that decides where any of it is allowed to exist
      edge("e-broad-warp", ["broad", "out"], ["warp", "source"]),
      edge("e-detail-warp", ["detail", "out"], ["warp", "disp"]),
      edge("e-warp-shape", ["warp", "out"], ["shape", "input"]),
      edge("e-bowl-rim", ["bowl", "out"], ["rim", "input"]),
      // rim is the FRONT: screen is commutative, but the front is the layer being placed.
      edge("e-rim-dish", ["rim", "out"], ["dish", "in1"]),
      edge("e-shape-dish", ["shape", "out"], ["dish", "in2"], 0),
      edge("e-dish-pack", ["dish", "out"], ["pack", "in2"]),
      // the loop, wind inside it, and the beat's seed screened into the state
      // T734: `wind1` is a displace now, so the state arrives on `source` and the flow
      // field on `disp`. The edge OUT of the slot is unchanged.
      edge("e-state-wind", ["state", "out"], ["wind", "source"]),
      edge("e-swell-wind", ["swell", "out"], ["wind", "disp"], 0),
      edge("e-wind-rd", ["wind", "out"], ["rd", "input"]),
      edge("e-spark-sow", ["spark", "out"], ["sow", "in1"]),
      edge("e-bowl-sow", ["bowl", "out"], ["sow", "in2"], 0),
      edge("e-sow-gate", ["sow", "out"], ["gate", "input"]),
      edge("e-gate-inject", ["gate", "out"], ["inject", "in1"]),
      edge("e-rd-inject", ["rd", "out"], ["inject", "in2"], 0),
      edge("e-inject-pack", ["inject", "out"], ["pack", "in1"]),
      // colour then time. The map is read a SECOND time, as colour (§V471.1).
      edge("e-dish-chem", ["dish", "out"], ["chem", "input"]),
      edge("e-inject-blend", ["inject", "out"], ["blend", "in1"]),
      edge("e-chem-blend", ["chem", "out"], ["blend", "in2"], 0),
      edge("e-blend-tint", ["blend", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      /* T598 — the expansion. The stamp is rings + the graded picture; `crest1` is what the
         loop records, and `show1` puts the LIVE cluster back over its own travelling
         echoes. Nothing here reads a clock: the motion is the loop's own iteration, so a
         timeline lap cannot snap it (T489). */
      edge("e-tint-stamp", ["tint", "out"], ["stamp", "in1"]),
      edge("e-rings-stamp", ["rings", "out"], ["stamp", "in2"], 0),
      edge("e-echo-grow", ["echo", "out"], ["grow", "input"]),
      edge("e-grow-fade", ["grow", "out"], ["fade", "input"]),
      edge("e-fade-cap", ["fade", "out"], ["cap", "input"]),
      edge("e-stamp-born", ["stamp", "out"], ["born", "in1"]),
      edge("e-cap-born", ["cap", "out"], ["born", "in2"], 0),
      edge("e-tint-show", ["tint", "out"], ["show", "in1"]),
      edge("e-born-show", ["born", "out"], ["show", "in2"], 0),
      // three lenses, coarse to fine, in series — the finest one IS the ring field
      edge("e-show-warpa", ["show", "out"], ["warpA", "source"]),
      edge("e-lensa-warpa", ["lensA", "out"], ["warpA", "disp"]),
      edge("e-warpa-warpb", ["warpA", "out"], ["warpB", "source"]),
      edge("e-lensb-warpb", ["lensB", "out"], ["warpB", "disp"]),
      edge("e-warpb-warpc", ["warpB", "out"], ["warpC", "source"]),
      edge("e-born-warpc", ["born", "out"], ["warpC", "disp"]),
      edge("e-warpc-tapr", ["warpC", "out"], ["tapR", "input"]),
      edge("e-warpc-tapg", ["warpC", "out"], ["tapG", "input"]),
      edge("e-warpc-tapb", ["warpC", "out"], ["tapB", "input"]),
      edge("e-tapr-fringerg", ["tapR", "out"], ["fringeRG", "in1"]),
      edge("e-tapg-fringerg", ["tapG", "out"], ["fringeRG", "in2"]),
      edge("e-fringerg-fringe", ["fringeRG", "out"], ["fringe", "in1"]),
      edge("e-tapb-fringe", ["tapB", "out"], ["fringe", "in2"]),
      edge("e-fringe-glow", ["fringe", "out"], ["glow", "input"]),
      edge("e-glow-hue", ["glow", "out"], ["hue", "input"]),
      edge("e-hue-out", ["hue", "out"], ["out", "input"]),
    ],
  ),
);
