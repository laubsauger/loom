import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { GRAY_SCOTT_WGSL } from "../shaders/gray-scott.wgsl.ts";

/**
 * E24 — Audio-Reactive Reaction-Diffusion (T425). The CAPSTONE.
 *
 * E2's rebuilt chemistry, played like an instrument. The owner supplied a TouchDesigner
 * walkthrough as the brief; this file is its mapping onto OUR machinery, node by node:
 *
 *  · AUDIO → SUBSTEPS. The bass envelope multiplies iterations per frame (T425's whole
 *    reason: the count is a per-frame VALUE), so the pattern physically ACCELERATES on
 *    the beat — not brighter, FASTER. The value chain caps it (valueLimit 1..34) before
 *    it ever reaches the plan, and expandLoops clamps again at encode: two fences, one
 *    contract — a loud passage cannot spike frame time unboundedly.
 *  · AUDIO → CHEMISTRY, RANGE-MAPPED WITH SAFE BOUNDS. The tutorial's own warning is
 *    the teaching: lowMid drives the map-shaping Level's white point, but through
 *    multiply → add → valueLimit into [0.62, 0.80] — the band where the pattern keeps
 *    breaking and reforming. Unclamped, one loud moment drives feed/kill out of the
 *    regime where the simulation survives, the pattern dies, and SILENCE DOES NOT
 *    BRING IT BACK — dead state is a fixed point. The clamp is not tuning; it is what
 *    makes the instrument recoverable.
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
 *    channels: substeps rest at their base, the chemistry sits mid-band, the palette
 *    breathes on its own LFO — the example ANIMATES (T402) with no track bound, and
 *    binding one adds the instrument on top.
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
 * The fix is §V471 transplanted from E31, which drives EIGHT properties and most of them
 * respond in the frame they are given: a SECOND, fast lag (`snap1`, 0.04 s) beside the
 * slow one, and one band to one property with its own gain and bias —
 *   low     → the broad lens weight     (the picture swells)
 *   lowMid  → the mid lens weight       (the fronts sway)
 *   high    → the fine lens weight      (the ridges shiver)
 *   highMid → the palette's scale       (§V471.7 — the ramp breathes)
 *   level   → the output Level's gain   (a one-frame lift over everything)
 * and, on the trigger, a SEED into the simulation state (below). §V477 governs every
 * pair: the bias is where silence sits and the gain is the swing, so all five rest LOW.
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
      /* ---- TWO LAGS AND A TRIGGER, because the piece has three timescales -------------
       *
       * E31 smooths once at the source and drives everything from that one Lag, and its
       * comment gives the reason: the bands are noisy, so one Lag means every driven
       * property agrees about what "now" is. That is right when every property is doing
       * the same JOB. Here they are not (T560/T562): the chemistry and the substep count
       * are STRUCTURE and want the beat blurred into a swell, while the lenses, the
       * palette and the output gain are EVENTS and want the transient intact. One Lag
       * cannot be both, and the shipped file only had the slow one — which is most of why
       * a beat was invisible.
       *
       * `trig1` is the third: not a timescale at all but an INSTANT, and the seeding
       * below reads it raw. §V481(b) says light a persistent loop with a trigger rather
       * than a level, and the arithmetic says the same thing from the other end — the
       * shipped file put this pulse through a 0.35 s Lag, which answers a one-frame
       * impulse with 0.047 of it.
       */
      node("env", "valueLag", [-1440, 450], { lag: 0.12 }, { label: "env1" }),
      node("snap", "valueLag", [-1440, 1200], { lag: 0.04 }, { label: "snap1" }),
      node("trig", "valueTrigger", [-1440, 1900], { threshold: 0.5 }, { label: "trig1" }),

      // ---- SLOW: structure ------------------------------------------------------------
      // Substeps: low band, scaled 0..20 over a base of 14, fenced 1..34.
      node("sgain", "valueMath", [-980, 340], { operation: "multiply", operand: 66.897 }, { label: "sgain1" }),
      node("sbase", "valueMath", [-740, 419], { operation: "add", operand: -31.2246 }, { label: "sbase1" }),
      node("scap", "valueLimit", [-500, 419], { minimum: 1, maximum: 34 }, { label: "steps1" }),
      /* Chemistry: lowMid moves the map's white point, hard-fenced to the band where the
         pattern SURVIVES (the tutorial's "so the pattern doesn't disappear"). T562 moved
         the fence with the window below: the map's Level now sits on a much narrower
         window (see `shape1`), so the same fractional swing needs a much narrower fence —
         0.62..0.80 around a white point of 0.543 would have been the whole picture. */
      node("wgain", "valueMath", [-980, 613], { operation: "multiply", operand: 0.1788 }, { label: "wgain1" }),
      node("wbase", "valueMath", [-740, 692], { operation: "add", operand: 0.445 }, { label: "wbase1" }),
      node("wcap", "valueLimit", [-500, 676], { minimum: 0.528, maximum: 0.566 }, { label: "wlevel1" }),

      /* ---- FAST: events. §V471.3's idiom — one band, one property, its own gain+bias ---
       *
       * Five pairs off `snap1`, and the numbers are MEASURED against the Beat pattern
       * rather than intended: on that source `low` rests near 0.14 and peaks near 0.55
       * through this Lag, `lowMid` 0.15/0.45, `highMid` 0.10/0.23, `high` 0.06/0.19 and
       * `level` 0.12/0.36. §V477 is the rule every bias here obeys — the bias is the REST
       * state and the gain is the SWING, so silence sits at the bottom of each range and
       * a hit has somewhere to travel to. Biasing into the interesting part is what made
       * E31 read as permanently peaking, and it is the failure that is easy to ship.
       */
      // The three lens weights (T507). Coarse lens on the kick, mid on the snare, fine on
      // the hats — the same split the three noises were BUILT with, now audible.
      node("lagain", "valueMath", [-980, 900], { operation: "multiply", operand: 0.669 }, { label: "lagain1" }),
      node("lena", "valueMath", [-740, 965], { operation: "add", operand: -0.4342 }, { label: "lena1" }),
      node("lbgain", "valueMath", [-980, 1173], { operation: "multiply", operand: 0.3128 }, { label: "lbgain1" }),
      node("lenb", "valueMath", [-740, 1238], { operation: "add", operand: -0.1537 }, { label: "lenb1" }),
      node("lcgain", "valueMath", [-980, 1446], { operation: "multiply", operand: 0.1396 }, { label: "lcgain1" }),
      node("lenc", "valueMath", [-740, 1511], { operation: "add", operand: -0.046 }, { label: "lenc1" }),
      /* T738 — THE THREE LENS WEIGHTS GET THE FENCE THE OTHER CHAINS ALREADY HAD.
       *
       * §V544's rule is stated above and obeyed by `steps1`, `wlevel1` and `grade1`: a
       * gain+bias pair is range-checked against its TARGET or the idiom ships a clamp.
       * These three pairs never got theirs, and under real music that omission INVERTS a
       * lens. Measured on three recorded tracks (N=2400 each): `warpc1.weight` runs
       * negative for 20.2% / 32.7% / 99.9% of the track — on the bass-heavy one its
       * median is -0.0454, i.e. negative for effectively the WHOLE piece.
       *
       * A negative displace weight is not a quiet lens, it is an INVERTED one: the picture
       * is pushed the other way. Note the fence lives HERE and not on the parameter —
       * `displace.weight` is declared -2..2 on purpose and E12-Fluid's `advect1` USES
       * weight -1 for backward advection, so the signed range is correct and narrowing it
       * would break fluid silently. "Never negative" is true of THIS chain, not of the
       * node, so it is declared where this chain lives (§V544's "legible in the graph
       * rather than silently clipped at the parameter").
       *
       * The bounds are a RANGE STATEMENT, not a taste knob: floor 0 because a lens at
       * rest is OFF, ceiling = gain + bias, which is exactly what the chain emits when
       * its band saturates at 1.0. So the ceiling never clips anything the chain can
       * legitimately produce — it states the chain's full travel in the graph.
       *
       * What this does NOT fix: on material with no top end the fine lens now RESTS OFF
       * for the whole track instead of running inverted. Off is honest and inverted is a
       * wrong picture, but it is a missing effect, not a working one — the md says so
       * plainly, and the cause (a bias tuned against a pattern whose p01 equals its
       * median) is §T766's, not this fence's.
       */
      node("acap", "valueLimit", [-500, 965], { minimum: 0, maximum: 0.2348 }, { label: "lenswa1" }),
      node("bcap", "valueLimit", [-500, 1238], { minimum: 0, maximum: 0.1591 }, { label: "lenswb1" }),
      node("ccap", "valueLimit", [-500, 1511], { minimum: 0, maximum: 0.0936 }, { label: "lenswc1" }),
      /* §V471.7 — THE PALETTE SCALE ITSELF IS DRIVEN, so the ramp breathes instead of
         being a fixed grade. The third fence is T544's amendment and E31's scar: a
         gain+bias pair has to be range-checked against its TARGET or the idiom ships a
         clamp. ×4.2 over a 0..1 band spans 1.83..6.03 against a Lookup Scale declared
         -4..4, so the Limit is what keeps the value legible in the graph rather than
         silently clipped at the parameter. */
      node("ggain", "valueMath", [-980, 1719], { operation: "multiply", operand: 6.7547 }, { label: "ggain1" }),
      node("gadd", "valueMath", [-740, 1784], { operation: "add", operand: -1.5095 }, { label: "gadd1" }),
      node("grade", "valueLimit", [-500, 1784], { minimum: 1.2, maximum: 3.2 }, { label: "grade1" }),
      // The whole picture lifts for a frame. Rest 0.86 — DARKER than unity on purpose, so
      // the calm state has headroom and the hit is a lift rather than a clip.
      node("bgain", "valueMath", [-980, 1992], { operation: "multiply", operand: 1.35 }, { label: "bgain1" }),
      node("bright", "valueMath", [-740, 2057], { operation: "add", operand: 0.93 }, { label: "bright1" }),

      /* ---- EVENT: the seed, and it is the one thing that makes a beat legible ---------
       *
       * A beat that nudges a rate is a rate change. A beat that SPAWNS STRUCTURE is an
       * event, and Gray-Scott is unusually good at it: drop V into the plate and the
       * reaction grows it for the next second on its own. So the trigger does not light
       * anything — it opens a Threshold for exactly one frame and the simulation keeps
       * the consequence. §V481(b) is the general form; this is the version where the loop
       * is a chemistry rather than a trail.
       *
       * The trigger drives the Threshold's CUT rather than a brightness, so the mask is a
       * clean 0..1 and a closed gate is EXACTLY zero. A Level would have gone negative
       * below its black point, and a negative through `screen` brightens — a DC term in a
       * persistent loop, which is the failure §V481(b) is about.
       * Rest 2.0: nothing in a 0..1 field is above 2.0, so between hits the gate is shut.
       */
      /* T598 — TWO MORE PROPERTIES, and the pair of them is the reference's whole verb.
         `flash1` is the stamp: the trigger, ungathered by any lag, straight onto `crest1`'s
         opacity. Rest 0.02 and hit 0.62 is §V477 read as far as it will go — at rest
         almost nothing enters the loop, so a beat is not a change of degree in a thing
         already happening, it is the only time anything happens at all. §V509 is why it
         hangs off `trig1` and not off `snap1`: a one-pole answers a single-frame impulse
         with 1-exp(-dt/tau), which at 0.04 s is 0.31 and at 0.35 s is 0.047 — a trigger
         through a smoother is a trigger you have deleted.
         `xspeed1` is E29's lurch: the kick opens the magnification from 1.012 to 1.029 per
         pass and `env1` closes it again over the beat, so the whole field surges outward
         and settles. Both fences are ARITHMETIC and not a clamp — the band is 0..1, so the
         pair cannot reach 1.0 (where the loop stops expanding and piles up into white) nor
         pass ~1.03 (where the corridor outruns the eye). A `valueLimit` here would be a
         fence around a range the gain already cannot leave. */
      node("fgain", "valueMath", [-980, 2538], { operation: "multiply", operand: 0.53 }, { label: "fgain1" }),
      node("flash", "valueMath", [-740, 2603], { operation: "add", operand: 0.02 }, { label: "flash1" }),
      node("xgain", "valueMath", [-980, 2811], { operation: "multiply", operand: 0.0569 }, { label: "xgain1" }),
      node("xspeed", "valueMath", [-740, 2876], { operation: "add", operand: 0.9736 }, { label: "xspeed1" }),
      node("seedamt", "valueMath", [-980, 2265], { operation: "multiply", operand: -1.28 }, { label: "seedamt1" }),
      node("seedcut", "valueMath", [-740, 2330], { operation: "add", operand: 2 }, { label: "seedcut1" }),

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
        parameters: { whitelevel: drivenSlot("wlevel1:lowMid", 0.543) },
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
        parameters: { substeps: drivenSlot("steps1:low", 14) },
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
      node("rd", "customWgsl", [-200, 120], { [SHADER_SOURCE_PARAMETER]: GRAY_SCOTT_WGSL }, { label: "rd1" }),

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
        parameters: { threshold: drivenSlot("seedcut1:onsetCount", 2) },
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
          scale: drivenSlot("grade1:highMid", 2.25),
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
       * `grow1`'s scale is on the audio (`low`), which is E29's lurch: the whole field
       * SURGES outward on the kick and settles over the beat. Both fences are arithmetic
       * rather than a clamp — the band is 0..1 and the pair spans 1.012…1.029, so it can
       * neither stop expanding (which piles up into white) nor outrun the eye.
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
          "s.x": drivenSlot("xspeed1:low", 1.012),
          "s.y": drivenSlot("xspeed1:low", 1.012),
        },
      }),
      node("fade", "level", [1360, 1120], {
        blacklevel: 0.0005, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 0.98, opacity: 1,
      }, { label: "dim1" }),
      node("born", "add", [1620, 1120], {}, {
        label: "crest1",
        parameters: { opacity: drivenSlot("flash1:onsetCount", 0.02) },
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
       * T560 — AND ALL THREE AMOUNTS ARE NOW ON THE AUDIO, one band each, which is the
       * whole T507 structure finally being audible. They were built at genuinely
       * different scales and rates; driving them from ONE envelope would have collapsed
       * that back into a single pump. Coarse on `low` (the picture swells on the kick),
       * mid on `lowMid` (the fronts sway with the snare), fine on `high` (the ridges
       * shiver with the hats). The retained values below are the shipped weights, so
       * every host without the channel attached still gets the picture T507 tuned.
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
          "weight.x": drivenSlot("lenswa1:low", 0.062),
          "weight.y": drivenSlot("lenswa1:low", 0.062),
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
          "weight.x": drivenSlot("lenswb1:lowMid", 0.024),
          "weight.y": drivenSlot("lenswb1:lowMid", 0.024),
        },
      }),
      node("warpC", "displace", [2660, 380], {
        offset: [0, 0], sourcex: "red", sourcey: "green", extend: "mirror",
      }, {
        label: "warpc1",
        parameters: {
          "weight.x": drivenSlot("lenswc1:high", 0.011),
          "weight.y": drivenSlot("lenswc1:high", 0.011),
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
      /* T560 — THE ONE-FRAME LIFT. The fastest path in the file: `level` on the finished
         picture, its Brightness on the `level` band through the fast Lag. Nothing
         integrates it, so it is up and down inside the beat. Rest 1.08 against a hit at 1.44 is
         §V477 again — the calm state is deliberately UNDER unity so the hit is a lift
         rather than a clip, and the picture has a floor to come back to. */
      node("glow", "level", [3700, 600], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "glow1", parameters: { brightness: drivenSlot("bright1:level", 1.08) } }),
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
      // three timescales off ONE switch: slow structure, fast events, instant seeding.
      edge("e-source-env", ["source", "out"], ["env", "in"]),
      edge("e-source-snap", ["source", "out"], ["snap", "in"]),
      edge("e-source-trig", ["source", "out"], ["trig", "in"]),
      edge("e-env-sgain", ["env", "out"], ["sgain", "a"]),
      edge("e-sgain-sbase", ["sgain", "out"], ["sbase", "a"]),
      edge("e-sbase-scap", ["sbase", "out"], ["scap", "in"]),
      edge("e-env-wgain", ["env", "out"], ["wgain", "a"]),
      edge("e-wgain-wbase", ["wgain", "out"], ["wbase", "a"]),
      edge("e-wbase-wcap", ["wbase", "out"], ["wcap", "in"]),
      // five fast pairs, one band each (§V471.3)
      edge("e-snap-lagain", ["snap", "out"], ["lagain", "a"]),
      edge("e-lagain-lena", ["lagain", "out"], ["lena", "a"]),
      edge("e-snap-lbgain", ["snap", "out"], ["lbgain", "a"]),
      edge("e-lbgain-lenb", ["lbgain", "out"], ["lenb", "a"]),
      edge("e-snap-lcgain", ["snap", "out"], ["lcgain", "a"]),
      edge("e-lcgain-lenc", ["lcgain", "out"], ["lenc", "a"]),
      edge("e-lena-acap", ["lena", "out"], ["acap", "in"]),
      edge("e-lenb-bcap", ["lenb", "out"], ["bcap", "in"]),
      edge("e-lenc-ccap", ["lenc", "out"], ["ccap", "in"]),
      edge("e-snap-ggain", ["snap", "out"], ["ggain", "a"]),
      edge("e-ggain-gadd", ["ggain", "out"], ["gadd", "a"]),
      edge("e-gadd-grade", ["gadd", "out"], ["grade", "in"]),
      edge("e-snap-bgain", ["snap", "out"], ["bgain", "a"]),
      edge("e-bgain-bright", ["bgain", "out"], ["bright", "a"]),
      // the seed gate: raw trigger, no lag between it and the Threshold's cut.
      edge("e-trig-seedamt", ["trig", "out"], ["seedamt", "a"]),
      edge("e-seedamt-seedcut", ["seedamt", "out"], ["seedcut", "a"]),
      // T598: the stamp is the raw trigger too; the expansion rate rides the envelope.
      edge("e-trig-fgain", ["trig", "out"], ["fgain", "a"]),
      edge("e-fgain-flash", ["fgain", "out"], ["flash", "a"]),
      edge("e-env-xgain", ["env", "out"], ["xgain", "a"]),
      edge("e-xgain-xspeed", ["xgain", "out"], ["xspeed", "a"]),
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
      edge("e-stamp-born", ["stamp", "out"], ["born", "in1"]),
      edge("e-fade-born", ["fade", "out"], ["born", "in2"], 0),
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
