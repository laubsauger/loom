import { settings, node, edge, graph, document, drivenSlot, expressionSlot } from "./builders.ts";

/**
 * T1201 — the two segments of the palette fit, and the one sweep they share.
 *
 * The bases are the `offset` half of the affine that fits the understudy depth map's
 * MEASURED range to the ramp; the derivation is written out at `palette1` below, beside
 * the numbers it was measured from. They are named here because each appears twice — once
 * as the parameter's static and once inside its expression — and two spellings of one
 * calibration is how a fit drifts by half.
 */
const SUBJECT_BASE = -0.06;
const WALL_BASE = -0.94;
/** One LFO about zero, plus each band's own base: §V920's pair, spelled for two readers. */
const SUBJECT_SWEEP = `${String(SUBJECT_BASE)} + op('cycle1').chan.value`;
const WALL_SWEEP = `${String(WALL_BASE)} + op('cycle1').chan.value`;

/**
 * E47 — Hologram (T956). THE DEPTH → POINT CLOUD COMPONENT, SHOWCASED.
 *
 *   bed1(noise) ─┬─► src1(add) ─┬─► cut1(component:depthCut@1) ─► braid1.in2  (coverage)
 *   orb1(circle)─┘              ├─► flat1(hsv, sat 0) ─► soften1(blur) ─► pick1(switch)
 *                               └─► depth1(depth) ────────── index 1 ──────┘   │
 *                     pick1 ─► holo1.field_2 (depth) ─and─► coat1.source (the heat key)
 *   palette1(ramp) ─► coat1(lookup) ─► braid1(reorder) ─► holo1.field       (colour)
 *   holo1(component:depthPoints@1) ─► zone1(pointRange, inside) ─► dots1 ─┐
 *   src1 ─► flat2 ─► soften2 ─┬─► holo2.field_2                           │
 *                            └─► wcoat1(lookup) ◄─ palette1 ─► holo2.field│
 *   holo2 ─► wall1(pointRange, OUTSIDE) ─► wdots1 ────────────────────────┴► shot1 ─► out1
 *   orbit1(lfo) ┄drives┄► eye1.eye.x     cycle1(lfo) ┄drives┄► both lookups' offset
 *
 * ## What the picture is
 *
 * E44 Sounding carved a heightfield — a relief on a plane. This is the other half the
 * owner asked for by name (§T958 "proper"): the DepthPoints COMPONENT unprojects a depth
 * map through a ray per pixel, so the cloud spreads with distance and hangs in space as
 * a translucent volume of soft additive motes — a hologram of the source, orbited by a
 * slow camera whose parallax is what makes the depth legible (E44/E34's lesson).
 *
 * ## The component is the subject, and the example uses it AS a component
 *
 * `holo1` is an INSTANCE of the DepthPoints library component — the first example to
 * instantiate one — with its published page turned from here: fov 55, near/far as a
 * shallow stage, displace tuned to fill the frame, resolution 144. The chain inside
 * (grid → carve → paint) is the component's own business; this document only feeds two
 * textures and styles the pointset that comes back, which is the whole argument for the
 * component boundary.
 *
 * ## Two depth sources on one switch — the source-agnosticism, demonstrated live
 *
 * The shipped default (`pick1.index = 0`) is an UNDERSTUDY: the source's own luma,
 * desaturated and blurred — bright is close, exactly the inverse encoding the component's
 * `inverseDepth` knob declares. It is deterministic, so every gate and the gallery card
 * see a real carved volume, and the orb visibly POPS toward the viewer because it is the
 * brightest thing in the frame. Flip to index 1 and the SAME component reads `depth1`,
 * the monocular ML model — which follows §T715's rule: without the model it publishes
 * flat mid-grey and the cloud is a visible flat sheet in the orbit, never a failure. One
 * switch, two utterly different depth sources, one component: the boundary earns its
 * name in the graph rather than in a doc comment.
 *
 * ## The orbit
 *
 * `eye.x` swings ±0.9 at 0.03 Hz (a 33-second round trip) at z 3.4 — E44's measured
 * ±16° figure for the same parallax problem. The motes are soft and additive, so the
 * cloud reads as light density, not billboards, and the swing carries the depth even
 * while the understudy holds still.
 *
 * ## The zone and the wall (T983 + §T979)
 *
 * The owner's ask, verbatim: "threshold based on the depth map point cloud … an IN and
 * OUT zone, like a volume", and "the person is in front of a filled in wall of clouds".
 * Both are ONE operator: `zone1` keeps holo1's points INSIDE depthN [0, 0.13] — the
 * subject pops off its background geometrically, on the cloud where depth is exact —
 * and `wall1` keeps a SECOND DepthPoints instance's points OUTSIDE the same range.
 * Same range, two modes: an exact partition (the boundary belongs to inside), which is
 * §T983's design property doing §T979's job.
 *
 * §T979's stronger point is that this REDEEMS the source switch: `holo2` reads the
 * synthetic performer ALWAYS — `src1` for colour, its own luma chain (`flat2` →
 * `soften2`) for depth — so flipping `srcpick1` to the webcam no longer throws the
 * synthetic source away. It becomes the BACKDROP: you, near, in front of a wall of
 * clouds, far — and they separate by REAL depth under the orbit's parallax, which a 2D
 * key cannot do. holo2's published near/far place its stage behind holo1's (2.0–4.4
 * against 0.7–2.6), so the wall is behind the subject in world space, not merely
 * dimmer.
 *
 * ## The cut (§T977) — the model-less 2D spelling, riding the same picture
 *
 * `cut1` (DepthCut) mattes the subject's COLOUR by the active depth map before it
 * becomes paint: everything past the cut plane loses its light entirely (threshold 0.8,
 * feather 0.12 over the understudy's luma), so the backdrop goes DARK and the subject
 * stands alone in its own cloud — the owner's "model-less bg cut … part of the hologram
 * thing" made real. This chain only carries light because the paint kernel honours the
 * map's alpha as premultiplied coverage (the §T977 follow-up fix).
 *
 * B189 — WHY THE NUMBERS ARE WHAT THEY ARE, and the lesson under them. A threshold is
 * only meaningful against the RANGE OF THE MAP IT READS, and this one shipped tuned for
 * a map that does not exist here: 0.6/0.1 sat entirely below the understudy's squashed
 * luma, so the matte never closed on ANY point and the cut was a 2.3% dim that looked
 * exactly like no cut at all. It also looked exactly like no cut in the node's PREVIEW,
 * for a second and unrelated reason — `mask` writes the coverage into ALPHA and leaves
 * rgb untouched (measured: the cut's rgb is byte-identical to its input), while the
 * default preview lens draws `vec4f(rgb, 1.0)`. Three surfaces agreed on a picture that
 * was correct arithmetic and a dead operator. The gate below now asserts the two POINT
 * COHORTS (fully cut, fully kept) rather than only that the extremes differ, because
 * "open vs closed differs" was true throughout the defect.
 *
 * ## The heat map (T1201) — E27 Relief's instrument, keyed on depth
 *
 * The owner: "apply the style that we have in Relief — this kind of heat map pattern —
 * to Hologram, because it just looks much cooler. The one that we have in Hologram is
 * just blue and kind of boring." So E27's `ramp` → `lookup` pair moved here, keyed on the
 * ACTIVE DEPTH MAP rather than on a picture's luminance: `palette1` is E27's contrast
 * ramp verbatim, and both clouds read it — `coat1` off `pick1`, `wcoat1` off the wall's
 * own `soften2` — at the same uv the carve kernel sampled to place each point. So a
 * mote's colour IS its distance, and the two instances become one continuous thermal
 * field: navy and teal far, magenta through orange near, a white crest on the plateau.
 *
 * THREE THINGS WERE BLUE and only one of them was the palette — the carriers were cyan
 * and blue and MULTIPLY the tint, the component's analytic `heat` was reading a depthN
 * band it was never scaled for, and the colour port carried a picture the cut had already
 * emptied. All three are in the per-node notes below, because "which of them was it" is
 * the part worth keeping.
 *
 * `cut1` STILL DECIDES WHAT IS LIT, and only that: `braid1` takes the palette's rgb and
 * the CUT's alpha, so B189's point cohorts are untouched by every line of this. §B189's
 * follow-up (`2e38f74`) gave `mask` an `apply` mode and DepthCut now carves COLOUR too —
 * which this chain deliberately does not read, because the paint kernel already
 * multiplies by coverage and reading a pre-carved rgb would apply the matte twice.
 */
export const hologramDocument = document(
  "e47-hologram",
  "E47 Hologram",
  settings({ randomSeed: 47 }),
  graph(
    [
      // ---- the performer (E44's understudy rig, smaller) ---------------------------
      node("bed", "noise", [-2220, -300], {
        type: "perlin4d", seed: 11, period: 0.2, harmon: 3, spread: 2, gain: 0.3,
        rough: 0.5, exp: 1.6, amp: 1.0, offset: 0.12, mono: true, aspectcorrect: true,
        speed: 0.03, t4d: 0.41, s4d: 1,
      }, { label: "bed1" }),
      node("orb", "circle", [-2220, -20], {
        mode: "fill", center: [0.5, 0.5], radius: [0.15, 0.15], softness: 0.09,
        fillcolor: [1, 0.62, 0.3, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("swayx1", 0.5), "center.y": drivenSlot("swayy1", 0.5) } }),
      node("swayx", "lfo", [-2220, 260], { shape: "sine", frequency: 0.29, amplitude: 0.28, offset: 0.5, phase: 0 }, { label: "swayx1" }),
      node("swayy", "lfo", [-2220, 540], { shape: "sine", frequency: 0.19, amplitude: 0.22, offset: 0.5, phase: 0.25 }, { label: "swayy1" }),
      node("src", "add", [-1920, -160], { opacity: 1 }, { label: "src1" }),
      /* T972 — the SOURCE switch: flip to 1 and the cloud is WHOEVER IS AT THE CAMERA.
         The shipped default stays the deterministic synthetic performer (a webcam
         cannot gate headlessly, §T715's family), and permission is only ever requested
         when the webcam node actually activates — never on load (E27's precedent). With
         the understudy depth this degrades beautifully: webcam + no model still carves
         a moving cloud of your face from its own luma. */
      node("cam", "webcam", [-1920, 140], {}, { label: "cam1" }),
      node("srcpick", "switch", [-1620, -280], { index: 0 }, { label: "srcpick1" }),

      // ---- two depth sources, one switch -------------------------------------------
      /* The understudy: the source's own luma as inverse depth (bright = close), blurred
         so the carve reads a surface rather than film grain. Deterministic — the card
         and every gate see a real volume. */
      node("flat", "hsv", [-1620, 40], { hueoffset: 0, saturation: 0, value: 1 }, { label: "flat1" }),
      node("soften", "blur", [-1320, 40], { size: 14, filter: "gaussian", extend: "hold" }, { label: "soften1" }),
      /* The ML path (§T715): loads and renders without the model — flat mid-grey, a
         visibly flat sheet in the orbit, never a failure. Flip pick1 to 1 to use it. */
      node("depth", "depth", [-1620, 280], { model: "accurate" }, { label: "depth1" }),
      node("pick", "switch", [-1020, 100], { index: 0 }, { label: "pick1" }),

      /* §T977 — the model-less cut, on the COLOUR path: the active depth map mattes the
         subject's picture (soft, luma-thresholded), and the paint kernel now honours
         that alpha as premultiplied coverage. Removes things further away, not
         "not-the-person" — the copy's own distinction. */
      /* B189 — THE THRESHOLD IS CALIBRATED TO THE MAP IT ACTUALLY GETS, and it was not.
         The understudy depth is the source's own blurred luma, and that luma is SQUASHED:
         measured over the shipped animation it occupies [0.555, 1.0] with 84% of pixels
         inside [0.60, 0.65] (the bed) and the top 7.3% at 1.0 (the orb). Against that map
         the old 0.6/0.1 window [0.5, 0.7] sits entirely BELOW the bed, so the matte's
         floor was coverage ~0.65 and NOT ONE of the cloud's 25600 live points was ever
         fully cut — the whole visible effect was a 2.3% dim, which is exactly the owner's
         "it is not doing a background removal". 0.8/0.12 puts the window at [0.68, 0.92],
         in the empty gap between the bed and the orb: 23092 points publish tint.a exactly
         0, 1509 exactly 1, 999 in the soft rim. Stable to ±1.5% of the frame across the
         orbit — see `hologram-claims.gpu.test.ts`, which holds both cohorts open. */
      node("cut", "component:depthCut@1", [-1020, -280], {
        threshold: 0.8,
        feather: 0.12,
        invert: 0,
      }, { label: "cut1" }),

      // ---- the component, instanced -------------------------------------------------
      node("holo", "component:depthPoints@1", [-720, -60], {
        // The published page (T958), turned from the outside: a shallow stage the orbit
        // can circle, dense enough to read as a volume.
        resolution: 160,
        unproject: 1,
        fov: 55,
        inverseDepth: 1,
        near: 0.7,
        far: 2.6,
        displace: 1.0,
        gain: 0.55,
        /* T1201 — ZERO, because the heat map moved OUT of the kernel and INTO the colour
           port. §T973's `heat` blends toward an ANALYTIC thermal on the same axis this
           document now paints on, so leaving it up would be two heat maps fighting over
           one number (§V730: one decision, one site) — and the analytic one is the paler
           of the two over the band that survives the cut (depthN [0, 0.112], where
           `thermal()` is near-white). The knob is not deleted: raise it and you get the
           component's own readout back, which is the comparison the boundary is for. */
        heat: 0,
      }, { label: "holo1" }),

      /* T1201 — THE HEAT MAP, AND IT IS E27's INSTRUMENT KEYED ON DEPTH.
         Owner: "apply the style that we have in Relief — this kind of heat map pattern —
         to Hologram… the one we have in Hologram is just blue and kind of boring."

         WHAT WAS ACTUALLY BLUE, measured before anything was copied. Three things were
         each independently capable of eating every warm hue in the frame, and only one
         of them was the palette:
           1. `glowm1`/`wallm1` were a cyan and a blue carrier, and §T478's tint
              MULTIPLIES the material colour per point. A blue carrier cannot produce an
              orange mote whatever the tint says — E27's `phosphor1` is WHITE for exactly
              this reason ("white base means the tint IS the colour"), and that one line
              is the root of the complaint. Both carriers are white now.
           2. the analytic `thermal()` inside the component's paint kernel, at `heat`
              0.45/0.8, was reading a depthN band it was never scaled for: the subject's
              lit points occupy depthN [0, 0.112] (thermal returns near-white there) and
              the wall's [0.166, 0.314] (thermal returns ~(1, 0.55, 0)). Times a blue
              carrier that is a white blob and a dim grey lattice, which is the shipped
              picture exactly.
           3. the colour port carried the SOURCE PICTURE, whose only colour is the orb's
              own warm fill — and the cut removes everything else, so 88% of the cloud
              was drawing a paletteless bed.

         THE MECHANISM COPIED FROM E27 IS `ramp` → `lookup`, NOT THE STOPS. The stops are
         E27's verbatim (a contrast palette: a long dark foot, a short violent climb
         through teal, magenta, orange to a white crest); the thing that makes it a heat
         map is that a `lookup` reads a FIELD through it. E27 keys on the picture's
         luminance because a relief IS its luminance. Here the field is depth.

         WHY DEPTH AND NOT LUMINANCE, given the understudy makes them nearly the same
         number. `pick1` is the ACTIVE depth map — flip it to 1 and it is the ML model —
         so keying the palette there is the choice that survives the switch this example
         exists to demonstrate, and it is the same texture, at the same uv, that the
         carve kernel read to place the point. So palette-index and point-position come
         off one sample: the colour a mote wears IS where it is in Z, which is what makes
         a thermal readout legible rather than decorative. (Luminance of the source would
         have been E27's literal choice and is a different claim — "bright is hot" — that
         goes false the moment a real depth model is selected.)

         B189's LESSON, APPLIED RATHER THAN REPEATED — and it is the whole of the tuning.
         A number read against a map is only meaningful against THAT MAP's range, so the
         range was measured before an index was chosen (`Lookup` computes
         `clamp(channel * scale + offset, 0, 1)`, so scale/offset ARE the fit):

           the understudy depth map, LINEAR, over frames 1/60/180: min 0.498, p10 0.584,
           p50 0.622, p90 0.696, max 1.000 — 80% of the frame inside 0.11 of range, plus
           a hard CLIPPED PLATEAU at 1.000 that is the orb's core.

         Left at `scale 1, offset 0` four fifths of the frame would land between palette
         index 0.58 and 0.70 and read as ONE STOP, which is the same defect class as
         B189's threshold: a knob correct in the abstract and dead against this map.

         THERE ARE TWO FITS BECAUSE THERE ARE TWO BANDS, and they are two segments of ONE
         mapping rather than two palettes. `zone1`/`wall1` already partition the cloud at
         depthN 0.13 — which is map luma 0.72 — and `cut1` zeroes the light of everything
         below 0.68, so the SUBJECT only ever wears map [0.68, 1.00] and the WALL only
         [0.498, 0.72]. A single affine has to spend the whole ramp on one of them: fit it
         to the subject and 80% of the frame crushes into the black foot (measured — that
         version rendered as coloured dust on black), fit it to the wall and the subject
         clips flat at the crest. Two segments, meeting AT the partition, spend the ramp
         on both and stay monotone through the join:

           wall     `wcoat1`  2.25 / -0.94 :  0.498 → 0.18 navy … 0.622 → 0.46 teal …
                                              0.696 → 0.63 … 0.72 → 0.68 magenta
           subject  `coat1`   1.06 / -0.06 :  0.68  → 0.66 magenta … 0.90 → 0.89 orange
                                              … 1.00 → 1.00 white crest

         Brighter is nearer is hotter, continuously, across BOTH clouds — the two rows
         agree to 0.02 of index where the bands touch — which is the property that makes
         this one thermal field rather than two differently-tinted layers.

         BOTH ROWS STAY INSIDE THE KNOBS' OWN TRAVEL (`scale` ±4, `offset` ±1, sweep
         included). That is T823's rule, not fussiness: a shipped value a user cannot drag
         to is a defect, and the first fit that read well needed `offset -1.82`.

         THE PLATEAU GETS THE CREST, AND THAT IS A CHOICE, NOT AN OVERSIGHT. The orb's
         core is clipped flat at 1.000 in the map, so EVERY key lands it on one colour;
         the carve clamps the same sample, so its depth is flat there too. Giving it the
         white crest is the reading that agrees with the geometry (a near plane at the
         near plane). Un-flattening it would mean re-ranging the source — which moves the
         map under `cut1`'s threshold and B189's point cohorts with it, so it is not this
         task's to do.

         AND THE FIT IS STATIC RATHER THAN AUTO-GAINED, which is §V694 read the other way
         round. E27 drives its white point off an `analyze` because its source is a live
         room; here the top is a clipped constant and the part that moves is the FLOOR,
         and §V694 is precisely the rule against driving a subtractive floor from a
         subsampled, one-frame-late reduction. So the fit is a measured constant, written
         down above, and re-measurable. Flip `pick1` to the ML model and both rows want
         retuning, exactly as `cut1`'s threshold does — that is what the knobs are for. */
      node("palette", "ramp", [-1620, -580], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* E27's stops, verbatim — the one thing here that IS a copy. */
        stops: [
          { position: 0, color: [0.004, 0.01, 0.035, 1] },
          { position: 0.34, color: [0.02, 0.13, 0.3, 1] },
          { position: 0.56, color: [0.08, 0.5, 0.62, 1] },
          { position: 0.76, color: [0.86, 0.2, 0.6, 1] },
          { position: 0.9, color: [1, 0.46, 0.32, 1] },
          { position: 1, color: [1, 0.97, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      /* §V920 — THE KEY SET AND WHAT DRIVES IT ARE TAKEN AS A PAIR, and this slot is the
         one the invariant is about. E27 ships `coat1.offset` as a DRIVEN slot whose static
         is 0 and whose driver (`cycle1`) has amplitude 0 — so in E27 that 0 is never the
         number that matters, and lifting the key set alone would have shipped
         `offset: 0`: the un-fitted lookup above, the entire frame inside one stop, the
         palette dead on arrival. Exactly E55's `brightness: 0`, one file over.

         THE SWEEP IS AN EXPRESSION RATHER THAN A BARE CHANNEL, because the two fits above
         have DIFFERENT bases and one LFO cannot carry both. `cycle1` therefore oscillates
         about ZERO and each lookup adds its own base (E51's `expressionSlot` idiom): the
         drive is shared, the calibration is not. A bare `drivenSlot` here would have
         handed both lookups the same offset and silently collapsed the two-band fit into
         one — the same failure as lifting the static, arrived at from the other side. The
         retained value is each lookup's own base, so a host with no channels renders the
         un-swept picture rather than a surprise (§V129, E27's discipline).

         AND UNLIKE E27 THE SWEEP IS LIVE. E27 holds its amplitude at 0 because T809 owed
         byte-identity to a pre-existing baseline; nothing here does. A clamped sweep along
         a monotone table cannot break the mapping the way Ramp's own `phase` would — T809
         measured that (`phase` ends in `fract()` and WRAPS a monotone table into a
         non-monotone one; `offset` CLAMPS) and the finding transfers unchanged. ±0.05 at
         0.037 Hz — a 27-second cycle, incommensurate with the orbit's 0.03 and both orb
         drifts (0.29, 0.19) — walks the frame a fifth of a stop up and down the ramp: the
         ground breathes navy-to-teal and the subject's rim moves through magenta. That
         motion is what separates a thermal field from a tinted picture. */
      node("coat", "lookup", [-1320, -580], {
        channel: "luminance", row: 0.5, scale: 1.06, offset: SUBJECT_BASE,
      }, { label: "coat1", parameters: { offset: expressionSlot(SUBJECT_SWEEP, SUBJECT_BASE) } }),
      node("cycle", "lfo", [-1920, -580], {
        shape: "sine", frequency: 0.037, amplitude: 0.05, offset: 0, phase: 0,
      }, { label: "cycle1" }),
      /* E27's `braid1`, and it is REQUIRED here rather than decorative: `lookup` returns
         the PALETTE's texel whole (`textureSampleLevel(lookupTexture, …)` — the source's
         alpha is not carried), and this document's alpha is the §T977 cut's COVERAGE.
         Lift the palette in without the braid and every point comes back at coverage 1:
         the background returns, B189's cohorts collapse, and the cut is dead again.
         So rgb comes from the palette and ALPHA from `cut1`, byte-for-byte — which is why
         the point cohorts (fully cut / fully kept) are unmoved by this whole change. */
      node("braid", "reorder", [-1020, -580], {
        outr: "in1r", outg: "in1g", outb: "in1b", outa: "in2a",
      }, { label: "braid1" }),

      /* T983 — the subject's zone: keep the near band of the cloud, park the rest. The
         cut happens ON the cloud, where depthN is an exact per-point attribute (§T973),
         not on the texture — the owner's own reasoning ("there we already did all the
         work"). from/to are runtime knobs: drag `to` and the room recedes live. */
      node("zone", "pointRange", [-720, 460], {
        attribute: "depthN", component: "x", from: 0, to: 0.13, mode: "inside",
      }, { label: "zone1" }),

      // ---- the backdrop wall (§T979): the SAME component, instanced twice -----------
      /* The synthetic performer stops being a fallback and becomes a LAYER: holo2 reads
         it ALWAYS (its own luma chain for depth), so flipping srcpick1 to the webcam
         keeps the cloud wall standing behind you instead of throwing it away. */
      node("flat2", "hsv", [-1620, 760], { hueoffset: 0, saturation: 0, value: 1 }, { label: "flat2" }),
      node("soften2", "blur", [-1320, 760], { size: 14, filter: "gaussian", extend: "hold" }, { label: "soften2" }),
      node("holo2", "component:depthPoints@1", [-1020, 760], {
        /* A deeper stage than the subject's (2.0–4.4 against 0.7–2.6): the wall stands
           BEHIND the subject in world space, and the orbit's parallax separates them —
           the thing a 2D key cannot do (§T979). T1201: `heat` 0 for the same reason the
           subject's is — the wall wears the SAME palette, read through `wcoat1` off its
           own depth chain, so the two clouds are one continuous thermal field instead of
           two differently-tinted layers. Its drawn band (depthN 0.166–0.314, the
           complement of the subject's zone) lands in the palette's navy-through-magenta
           foot, so it still reads as an environment rather than a second performer — by
           WHERE IT IS IN Z now, not by having been given a bluer carrier.

           T1201 — AND IT IS DENSE ENOUGH TO BE A WALL NOW (120 → 176, and `wdots1` 0.005
           → 0.007). This is the one change here that is not about colour, and it is here
           because a palette can only paint what is drawn: at 120 the backdrop was 14400
           motes with black between every one of them, and the fitted palette rendered as
           coloured dust on an 85%-black frame (measured side by side at both densities).
           §T979 already asks this layer to be "a filled in wall of clouds" — the owner's
           own words — and 176² = 30976 is inside the component's 192² capacity, so the
           density it was promised costs one knob. */
        resolution: 176,
        unproject: 1,
        fov: 55,
        inverseDepth: 1,
        near: 2.0,
        far: 4.4,
        displace: 1.2,
        gain: 0.62,
        heat: 0,
      }, { label: "holo2" }),
      /* The wall's own read of the same palette (T1201). Keyed on `soften2` — holo2's own
         depth map, never `pick1` — so §T979's rule holds unchanged: the backdrop depends
         on the synthetic performer and on nothing the source switch can take away.
         NO BRAID HERE, and that is measured rather than assumed: the wall has no cut, and
         `src1`'s alpha (an additive composite's sum) already reads >= 1 at every one of
         holo2's live points — all 30976 publish tint.a === 1, before and after — so the
         ramp's opaque alpha is the identical coverage. A reorder here would be a node
         that provably does nothing.

         STRAIGHT ALPHA, both here and at `braid1` (§B189's convention, stated in
         `composite.wgsl.ts`): the ramp's rgb is the colour a fully covered mote wears, NOT
         colour times coverage. The paint kernel is what multiplies by coverage, once. */
      node("wcoat", "lookup", [-1320, 1040], {
        channel: "luminance", row: 0.5, scale: 2.25, offset: WALL_BASE,
      }, { label: "wcoat1", parameters: { offset: expressionSlot(WALL_SWEEP, WALL_BASE) } }),
      /* T983's other mode, SAME range: the wall keeps what the subject's zone drops.
         Inside + outside over one range partition exactly (the boundary belongs to
         inside), so between the two instances no depth band is drawn twice or lost. */
      node("wall", "pointRange", [-720, 760], {
        attribute: "depthN", component: "x", from: 0, to: 0.13, mode: "outside",
      }, { label: "wall1" }),

      // ---- styling and the stage ----------------------------------------------------
      /* T1201 — WHITE, and this is the line the owner's complaint was actually about.
         §T478's per-point tint MULTIPLIES this colour, so a cyan carrier (0.55, 0.85, 1)
         scaled every red channel by 0.55 and could not draw an orange mote at any tint:
         the palette below would have been invisible through it. E27's `phosphor1` is
         white for exactly this reason — a white base means the tint IS the colour. */
      node("glowm", "materialUnlit", [-420, -300], { color: [1, 1, 1, 1] }, { label: "glowm1" }),
      node("dots", "geometry", [-420, -60], {
        mode: "points", scale: 0.0068, soft: 1, spherical: false, blend: "additive",
        material: "glowm1", tint: [1, 1, 1, 1],
      }, { label: "dots1", parameters: {
        /* The component's per-point colour, mapped — without this every mote draws the
           static white and the retexturing is invisible. */
        tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
      } }),
      /* The wall's motes: finer and dimmer — light density behind the subject. T1201:
         white for the same reason as `glowm1`, so the wall's place in the palette is what
         makes it cool, not a carrier that was overriding the paint. Its subordination is
         where it always belonged: `scale` 0.007 against `dots1`'s 0.0068 on a stage
         nearly twice as far away, and holo2's `gain` 0.62 against 0.55. */
      node("wallm", "materialUnlit", [-120, 760], { color: [1, 1, 1, 1] }, { label: "wallm1" }),
      node("wdots", "geometry", [-420, 760], {
        mode: "points", scale: 0.007, soft: 1, spherical: false, blend: "additive",
        material: "wallm1", tint: [1, 1, 1, 1],
      }, { label: "wdots1", parameters: {
        tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
      } }),
      node("eye", "camera", [-420, 180], {
        eye: [0, 0.85, 3.2], lookAt: [0, -0.1, 0], fov: 40, near: 0.1, far: 40, ortho: false,
      }, { label: "eye1", parameters: { "eye.x": drivenSlot("orbit1", 0) } }),
      node("orbit", "lfo", [-420, 420], { shape: "sine", frequency: 0.03, amplitude: 0.9, offset: 0, phase: 0 }, { label: "orbit1" }),
      node("shot", "render", [-120, -60], {
        scenes: "dots1 wdots1", camera: "eye1", lights: "",
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0,
        background: [0.008, 0.01, 0.016, 1],
        /* T939: thin bright motes on black — supersampling shades them. */
        antialias: "ssaa",
      }, { label: "shot1" }),
      node("out", "output", [180, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-src", ["bed", "out"], ["src", "in1"]),
      edge("e-orb-src", ["orb", "out"], ["src", "in2"]),
      edge("e-src-srcpick", ["src", "out"], ["srcpick", "inputs"], 0),
      edge("e-cam-srcpick", ["cam", "out"], ["srcpick", "inputs"], 1),
      edge("e-srcpick-flat", ["srcpick", "out"], ["flat", "input"]),
      edge("e-flat-soften", ["flat", "out"], ["soften", "input"]),
      edge("e-soften-pick", ["soften", "out"], ["pick", "inputs"], 0),
      edge("e-srcpick-depth", ["srcpick", "out"], ["depth", "input"]),
      edge("e-depth-pick", ["depth", "out"], ["pick", "inputs"], 1),
      /* The component's two texture ports (boundary-derived): `field` is the PAINT
         kernel's colour, `field_2` the CARVE kernel's depth — verified against the
         flattened plan's texture bindings, not assumed from the names. */
      /* §T977: the cut's two texture ports (boundary-derived, verified against the
         flattened plan's bindings): `input` is the MATTE's depth map, `input_2` the
         picture being masked. The ACTIVE depth map drives the matte, so the cut follows
         whichever source pick1 selects — understudy or ML. */
      edge("e-pick-cut", ["pick", "out"], ["cut", "input"]),
      edge("e-srcpick-cut", ["srcpick", "out"], ["cut", "input_2"]),
      /* T1201 — the colour port carries the HEAT MAP now, braided with the cut's coverage.
         `coat1` reads the ACTIVE depth map (`pick1`, the same texture at the same uv the
         carve kernel placed the point from) through `palette1`; `braid1` puts that in rgb
         and `cut1`'s alpha in a. Only `cut1`'s ALPHA is read from here on — its rgb was
         the source picture, which the palette has replaced. */
      edge("e-pick-coat", ["pick", "out"], ["coat", "source"]),
      edge("e-palette-coat", ["palette", "out"], ["coat", "lookup"]),
      edge("e-coat-braid", ["coat", "out"], ["braid", "in1"]),
      edge("e-cut-braid", ["cut", "out"], ["braid", "in2"]),
      edge("e-braid-holo", ["braid", "out"], ["holo", "field"]),
      edge("e-pick-holo", ["pick", "out"], ["holo", "field_2"]),
      /* T983: the subject's cloud passes through its zone before it is drawn. */
      edge("e-holo-zone", ["holo", "out"], ["zone", "points"]),
      edge("e-zone-dots", ["zone", "out"], ["dots", "points"]),
      /* §T979: the backdrop reads the synthetic performer ALWAYS — never the switch.
         T1201: it reaches the colour port through the SAME palette, keyed on the wall's
         own depth chain, so one thermal field spans both clouds. */
      edge("e-src-flat2", ["src", "out"], ["flat2", "input"]),
      edge("e-flat2-soften2", ["flat2", "out"], ["soften2", "input"]),
      edge("e-soften2-holo2", ["soften2", "out"], ["holo2", "field_2"]),
      edge("e-soften2-wcoat", ["soften2", "out"], ["wcoat", "source"]),
      edge("e-palette-wcoat", ["palette", "out"], ["wcoat", "lookup"]),
      edge("e-wcoat-holo2", ["wcoat", "out"], ["holo2", "field"]),
      edge("e-holo2-wall", ["holo2", "out"], ["wall", "points"]),
      edge("e-wall-wdots", ["wall", "out"], ["wdots", "points"]),
      edge("e-shot-out", ["shot", "out"], ["out", "input"]),
    ],
  ),
);
