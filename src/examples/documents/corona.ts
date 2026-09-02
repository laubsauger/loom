import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

const CORONA_POINTS = 65_536;

const CORONA_KERNEL = `
fn lm_hash(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q = q + vec3f(dot(q, q.zyx + 31.32));
  return fract((q.x + q.y) * q.z);
}

fn lm_noise(x: vec3f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(lm_hash(i + vec3f(0.0, 0.0, 0.0)), lm_hash(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let b = mix(lm_hash(i + vec3f(0.0, 1.0, 0.0)), lm_hash(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let c = mix(lm_hash(i + vec3f(0.0, 0.0, 1.0)), lm_hash(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let d = mix(lm_hash(i + vec3f(0.0, 1.0, 1.0)), lm_hash(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z) * 2.0 - 1.0;
}

fn lm_fbm(x: vec3f, oct: i32) -> f32 {
  var v = 0.0; var a = 0.5; var q = x;
  for (var k: i32 = 0; k < oct; k = k + 1) {
    v = v + a * lm_noise(q);
    q = q * 2.03 + vec3f(17.3, 9.1, 4.7);
    a = a * 0.55;
  }
  return v;
}

// Ridged: 1-|n| squared per octave. Creases and filaments instead of blobs.
fn lm_ridged(x: vec3f, oct: i32) -> f32 {
  var v = 0.0; var a = 0.5; var q = x;
  for (var k: i32 = 0; k < oct; k = k + 1) {
    let n = 1.0 - abs(lm_noise(q));
    v = v + a * n * n;
    q = q * 2.07 + vec3f(11.1, 3.3, 7.7);
    a = a * 0.52;
  }
  return v - 0.62;
}

fn lm_rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}
fn lm_rotX(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let t = ctx.absTime;

  // ---- THE SMOOTH PIPE -------------------------------------------------
  // pointgenerator1.radius is the only drivable number that reaches this
  // kernel, so the sphere's radius is the audio's way in: length is divided
  // straight back out and what survives is a continuous 0..1 control.
  //
  // THESE TWO CONSTANTS ARE swell1's BIAS AND GAIN, and they are a SILENT
  // COUPLING (T554). The radius is driven by swell1 = "lowMid x 1.25 + 0.68",
  // so subtracting the bias and dividing by the gain is the only thing that
  // makes a 0..1 band arrive here as a 0..1 control. They were 1.0 and 0.6 -
  // swell1's values from BEFORE T547 lowered the bias to 0.68 - and the
  // mismatch did not warn, it just quietly stopped delivering: MEASURED on
  // the shipped Beat source, damp1:lowMid spans 0.152..0.327, so the radius
  // spans 0.870..1.088 and the old "(inR - 1.0) / 0.6" yielded fromAudio
  // 0.000..0.147 - CLAMPED FLAT AT ZERO for most of every beat. The eight
  // post-processing pairs kept reacting, so the picture still moved and the
  // severed kernel looked like a style choice. Retune swell1 and you MUST
  // retune these in the same commit.
  let pin = p.position;
  let inR = max(1.0e-4, length(pin));
  let fromAudio = clamp((inR - 0.68) / 1.25, 0.0, 1.0);
  // SILENCE HAS TO BE SILENT (T554, V477 in the kernel rather than in the
  // value chain). This was "0.30 + 0.28 * sin(...)": with no audio at all
  // "drive" still sat a third of the way up its range and swept 0.02..0.58
  // over a 67-second cycle, which is most of the lobes-to-filaments
  // crossfade happening on its own. The bias is the rest state, so it comes
  // down to near zero - but not TO zero: a completely frozen rest state is
  // its own failure (V427), and this keeps a slow shimmer under the
  // rotation and the breath while leaving the EXTENT to the audio.
  let drift = 0.05 + 0.04 * sin(t * 0.093);
  let drive = clamp(fromAudio + drift, 0.0, 1.1);

  var s = normalize(pin);

  s = lm_rotY(s, t * 0.13);
  s = lm_rotX(s, t * 0.081);

  // taffy twist: shear grows with drive, very readable on the silhouette
  s = lm_rotY(s, (0.8 + 2.4 * drive) * s.y + t * 0.05);

  let wf = 1.25 + 0.85 * drive;
  let w = vec3f(
    lm_fbm(s * wf + vec3f(0.0, 0.0, t * 0.13), 4),
    lm_fbm(s * wf + vec3f(5.2, 1.3, t * 0.11), 4),
    lm_fbm(s * wf + vec3f(9.1, 7.7, t * 0.15), 4)
  );

  // two fields, crossfaded by drive: soft lobes -> sharp filaments
  let lobes = lm_fbm(s * 1.9 + w * 1.5 + vec3f(0.0, t * 0.20, 0.0), 5);
  let creases = lm_ridged(s * (2.4 + 2.6 * drive) + w * 1.1 - vec3f(t * 0.17, 0.0, 0.0), 5);
  let field = mix(lobes, creases * 1.15, clamp(drive, 0.0, 1.0));

  let ripple = sin(s.y * 6.0 - t * 1.05);
  let breath = 0.05 * sin(t * 0.60) + 0.03 * sin(t * 1.03 + 1.3);
  let amp = 0.24 + 0.32 * drive;

  // T554 — THE EXTENT, and it is the term that was missing. The base here was
  // a CONSTANT 1.0: "drive" moved "amp" and crossfaded lobes into creases, so
  // the audio changed the creature's ROUGHNESS and CHARACTER and its SIZE
  // never moved at all. No retune of the value chain could reach it, because
  // there was nothing in the arithmetic for a retune to scale.
  //
  // Calibrated against the two ends rather than picked: the slope puts a LOUD
  // passage back at the extent the constant 1.0 used to hold permanently, so
  // nothing is lost at the top - the creature still fills the frame when the
  // music is loud, it simply no longer does so in silence. MEASURED (99% of
  // the luminance mass, as a fraction of half-frame-height): silence 0.47,
  // Beat between hits 0.50, Beat on a hit 0.58, a loud passage 0.72. It was
  // 0.71..0.72 at ALL FOUR before.
  let core = 0.55 + 0.62 * drive;
  let rad = core + breath + amp * field + 0.055 * ripple * (0.25 + drive);
  let p3 = s * rad * 0.90;

  let dcam = 4.5;
  let zc = max(0.05, dcam - p3.z);
  let ff = 3.17;
  let aspect = 16.0 / 9.0;

  q.position = vec3f((p3.x * ff / zc) / aspect, p3.y * ff / zc, 0.5);
  q.velocity = vec3f(field, creases, drive);
  return q;
}
`;

/**
 * E31 — Corona (T538, §V471). **The owner's own working file**, adopted as an example and
 * as the definition of the bar.
 *
 * A luminous organism turning in the dark: sixty-five thousand additive points on a sphere
 * that the audio pulls between two entirely different characters. Quiet, it CONTRACTS to a
 * small dim knot of soft lobes breathing. Loud, it throws itself outward and the same
 * points snap into RIDGED FILAMENTS, the silhouette twists like taffy, orange crests light
 * along the fastest creases and a cyan frost picks out only the sharpest. Bloom, a
 * seven-stop grade, trails and a 29-second hue drift sit on top. Nothing about it is subtle
 * and nothing about it is arbitrary.
 *
 * **Read this file before writing another example.** Eight ideas do the work, and none of
 * them is "add more nodes":
 *
 * ## 1. ONE SOURCE, THREE READINGS — and this is the transferable one
 *
 * `drawbase1`, `drawmid1` and `drawtip1` are three `renderPoints` over the SAME point
 * cloud. They differ only in a GROUP PREDICATE, a colour and a size:
 *
 * | | predicate | colour | reads as |
 * | --- | --- | --- | --- |
 * | `drawbase1` | (none — all 65,536) | deep blue | the body |
 * | `drawmid1` | `p.velocity.y > 0.04` | orange | the lit crests |
 * | `drawtip1` | `p.velocity.y > 0.17` | cyan | the sharpest tips only |
 *
 * Structure comes from SELECTION, not from adding elements. Three draws over one
 * simulation give a picture with three depths in it and cost one more node each — where
 * three separate systems would cost three of everything and still not be registered with
 * each other. This is the answer to "more interesting without overloading".
 *
 * ## 2. THE KERNEL WRITES DATA FOR THE SELECTION TO SLICE
 *
 * `q.velocity = vec3f(field, creases, drive)`. Velocity is not velocity here — it is an
 * ATTRIBUTE CARRIER, and `creases` is the ridged-noise field. So `p.velocity.y > 0.17`
 * means "only where the surface is sharply creased". The kernel and the compositing were
 * designed together; the predicates are not a filter bolted on afterwards, they are
 * reading a channel the kernel wrote for them.
 *
 * ## 3. GAIN AND BIAS PER BAND, NOT ONE REACTIVITY KNOB
 *
 * Eight `valueMath` multiply→add pairs, each mapping ONE band to ONE property with its own
 * scale and offset — `high` × 6 + 0.15 into the cyan band's gain is a completely different
 * curve from `level` × 0.30 + 0.62 into the trail persistence, and it has to be. A single
 * master gain makes everything move together, which reads as one thing pumping. One
 * `valueLag` at 0.09 s sits between the audio and all eight, so nothing jitters.
 *
 * SEVEN of the eight land on a post-processing parameter and take effect directly. The
 * eighth, `swell1`, is different in kind and T554 is the bill for not noticing: it drives
 * the point generator's RADIUS, which exists only so the kernel can divide it back out and
 * recover the band. That makes it a TRANSPORT with a decoder at the far end, and a
 * transport whose two constants are duplicated in a WGSL string is a coupling no gate sees.
 *
 * ## 4. LAYERED POST, EACH STAGE DOING ONE JOB
 *
 * bloom (blur 34 → level → add), grade (lookup ← a seven-stop ramp), two highlight
 * screens, feedback trails, hue drift. Five stages, each legible alone, none of them
 * doing two things.
 *
 * ## 5. THE FEEDBACK CLOSES ON THE FINAL OUTPUT
 *
 * `loop1.source` is `tail1` — the very last node — not the raw render. So the trails carry
 * the GRADED, hue-drifted colour, and a trail looks like it belongs to the image rather
 * than like a ghost of an earlier stage.
 *
 * ## 6. A RAMP THAT GOES SOMEWHERE
 *
 * Seven stops: black → near-black navy → blue → purple → red → gold → white. Every shipped
 * example before this used four or five and most of them travelled less far. The grade is
 * why the same three colours read as a hundred.
 *
 * ## 7. THE GRADE ITSELF BREATHES
 *
 * `coat1.scale` is driven by `highMid`, so the whole image slides along the ramp with the
 * music instead of the ramp being a fixed decision.
 *
 * ## 8. THE SLOWEST THING IS SLOWER THAN YOUR ATTENTION SPAN
 *
 * `hue1`'s LFO runs at 0.035 Hz — a 29-second cycle — and swings ±30 degrees on it. It
 * takes BOTH numbers (T574): `lfoValue`'s amplitude is in the driven parameter's units, so
 * a period this slow with a swing too small to see is a cycle nothing travels through.
 * Together they are most of why it does not get boring: at any moment something is
 * changing that you did not notice start.
 *
 * ## What T538 changed, and it is one thing
 *
 * The owner's file bound their own track. Assets are session-only (§V363), so the shipped
 * version puts the deterministic Beat pattern and an empty `audioFileIn` BOTH into a
 * `valueSwitch` (T508) — index 0 plays on open with no asset, index 1 is your file. Same
 * treatment as E24, and for the same reason: two value sources on one port would merge and
 * one of them would silently vanish (§V457).
 *
 * ## What T554 changed: the audio finally moves the creature's SIZE
 *
 * The owner: *"when there's no source input or very low levels I'd expect the corona to
 * collapse further inwards and vice versa."* Three defects, all in the kernel, and none of
 * them reachable by retuning a value node:
 *
 * 1. **The extent was a CONSTANT.** `rad` started from a literal `1.0`. Audio moved `amp`
 *    and crossfaded lobes into creases, so it owned the creature's ROUGHNESS and CHARACTER
 *    and never its SIZE. A `core` term that rests at 0.55 and travels with `drive` is the
 *    missing arithmetic; the slope is set so a loud passage lands where the constant used
 *    to sit, which means the collapse is bought at no cost to the peak.
 * 2. **Silence was not silent.** `drift` was `0.30 + 0.28·sin(t·0.093)`, so with no audio
 *    at all `drive` sat a third of the way up its range and swept a 67-second sine across
 *    most of the lobes→filaments crossfade. That is §V477 — bias is the rest state — living
 *    in a WGSL string rather than in the value chain where T547 could see it. Now
 *    `0.05 + 0.04·sin`: a shimmer, not a performance.
 * 3. **The decoder had drifted off the encoder.** See the kernel comment: T547 lowered
 *    `swell1`'s bias and the kernel kept subtracting the old one, which clamped the Beat
 *    source's contribution flat at zero for most of every beat. Nothing warned, because the
 *    other seven pairs went on reacting and the picture went on moving.
 *
 * The general lesson, and it is why this belongs in the calibration artefact: **a value
 * chain can only retune what the shader already varies.** Before reaching for gains and
 * biases, check that the quantity you want to move is a term in the arithmetic at all.
 *
 * Already clean and deliberately left alone: the kernel reads `ctx.absTime`, so the
 * rotation survives a timeline lap, and the LFO is free-running (§V436, B98).
 */
export const coronaDocument = document(
  "e31-corona",
  "E31 Corona",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 1, previewFps: 20 }),
  graph(
    [
      // ---- the sound: pattern or your track, exclusively (T504's shape) ------------
      node("beat", "audioPattern", [-1800, 700], { bpm: 124, amount: 1 }, { label: "beat1" }),
      node("track", "audioFileIn", [-1800, 980], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-1520, 840], { index: 0 }, { label: "source1" }),
      /* ONE Lag for all eight mappings. The bands are already noisy; smoothing once at the
         source means every driven property agrees about what "now" is. */
      node("damp", "valueLag", [-1240, 840], { lag: 0.09 }, { label: "damp1" }),

      /* EIGHT multiply -> add PAIRS, one band to one property, each with its own gain and
         bias. This is §V471's third idea and it is the difference between a reactive image
         and an image that pumps: a single master gain moves everything together. */
      /* T547 (§V477) — THE BIAS IS THE REST STATE, THE GAIN IS THE SWING, and the owner's
         file biased every pair INTO the interesting part of its range, so there was nowhere
         to go but up. The bias here was +1.0: rest radius 1.0 is already the full sphere, so
         there was no contracted state to expand FROM and the audio could only ever add.
         0.68 rest / 1.93 peak gives the creature somewhere to come back to, which is what
         makes the expansion read as an expansion rather than as jitter on a still image. */
      node("swellG", "valueMath", [-960, 520], { operation: "multiply", operand: 3.724 }, { label: "swellg1" }),
      node("swell", "valueMath", [-700, 520], { operation: "add", operand: -1.1733 }, { label: "swell1" }),
      node("glowG", "valueMath", [-960, 780], { operation: "multiply", operand: 6.0207 }, { label: "glowg1" }),
      node("glow", "valueMath", [-700, 780], { operation: "add", operand: -3.6202 }, { label: "glow1" }),
      node("dotG", "valueMath", [-960, 1040], { operation: "multiply", operand: 2.2 }, { label: "dotg1" }),
      node("dot", "valueMath", [-700, 1040], { operation: "add", operand: 1.2 }, { label: "dot1" }),
      node("heatG", "valueMath", [-960, 1300], { operation: "multiply", operand: 7.3587 }, { label: "heatg1" }),
      node("heat", "valueMath", [-700, 1300], { operation: "add", operand: -4.7247 }, { label: "heat1" }),
      /* T547 asked whether ×20 was deliberate. It was not: on the Beat source `high` rests
         around 0.2, so ×20 rested at 4 and the Limit below PINNED at its ceiling on every
         loud frame — the cyan band was in blast mode permanently, which is §V477 stated as
         a symptom. ×6 rests near 0.5 and travels to ~3, and the Limit goes back to being a
         fence for a real track rather than the thing setting the level. */
      node("sparkG", "valueMath", [-440, 520], { operation: "multiply", operand: 6.9825 }, { label: "sparkg1" }),
      node("sparkAdd", "valueMath", [-180, 520], { operation: "add", operand: -2.1476 }, { label: "sparkadd1" }),
      /* THE THIRD FENCE, and the pair above is why it has to exist. A gain of 20 is the
         right sensitivity — `high` is a small channel and the cyan tips are the faintest
         thing in the frame, so a quiet passage still has to light them — but ×20 + 0.1 over
         a 0..1 band spanned 0.1..20.1 against a Brightness declared 0..8. §V471's third idea
         (gain and bias per band) is right and INCOMPLETE: the pair has to be range-checked
         against its TARGET, or the idiom ships a clamp. Two fences, E24's shape: the Limit
         holds the value in the graph where you can see it, and T368's clamp is the backstop
         rather than the mechanism. */
      node("spark", "valueLimit", [80, 520], { minimum: 0.05, maximum: 5 }, { label: "spark1" }),
      /* T547 — "colors down, not always in blast mode", and the number is the BIAS again.
         Rest scale was 1.4, which drives the lookup coordinate far up a seven-stop ramp that
         ENDS IN WHITE: the palette sat permanently at its hot end, so a peak had nowhere to
         climb to and the seven stops might as well have been two. Resting near 0.85 puts the
         calm state in the navy and blue and lets a loud passage reach the gold — which is
         §V471's sixth idea finally doing something. */
      node("gradeG", "valueMath", [-440, 780], { operation: "multiply", operand: 4.1815 }, { label: "gradeg1" }),
      node("grade", "valueMath", [-180, 780], { operation: "add", operand: -1.5173 }, { label: "grade1" }),
      /* T538 FOLLOW-UP: this gain was 0.95 in the owner's file, which put persistence at
         0.62..1.57 against a range of 0..1 — so it raised a `parameter.range` problem on any
         moderately loud passage, and T368's clamp was the only thing standing between the
         piece and PERSISTENCE 1.0, which is perfect accumulation: an image that never
         decays. Retuning to 0.30 is a better LOOK, not a compromise for a warning: it keeps
         "louder means longer trails" and tops out at 0.92, where a trail still ends. */
      node("trailG", "valueMath", [-440, 1040], { operation: "multiply", operand: 0.3 }, { label: "trailg1" }),
      node("trail", "valueMath", [-180, 1040], { operation: "add", operand: 0.62 }, { label: "trail1" }),
      node("tipG", "valueMath", [-440, 1300], { operation: "multiply", operand: 10.4737 }, { label: "tipg1" }),
      node("tip", "valueMath", [-180, 1300], { operation: "add", operand: -2.4465 }, { label: "tip1" }),

      // ---- the body ----------------------------------------------------------------
      /* `radius` is the ONLY drivable number that reaches a point kernel, so the owner used
         it as the audio's way in: lowMid maps to radius 0.68..1.93, the kernel divides the
         length straight back out, and what survives is a 0..1 CONTROL rather than a scale.
         T554 NOTE: because the kernel un-does this mapping exactly, this pair is a pure
         TRANSPORT — its gain and bias cancel and cannot change the look. Every extent and
         character decision lives in the kernel. What the pair still owes is the range check
         (it drives a declared parameter) and AGREEMENT with the kernel's two constants. */
      node("gen", "pointGenerator", [-1240, 0], {
        shape: "sphere", cols: 256, rows: 256, count: CORONA_POINTS,
        radius2: 0.25, sizeX: 2, sizeY: 2, sizeZ: 2,
      }, {
        label: "gen1",
        parameters: { radius: drivenSlot("swell1:lowMid", 1.2) },
      }),
      node("shape", "pointKernel", [-960, 0], {
        capacity: CORONA_POINTS, seed: 7, attributes: "", group: "",
        kernel: CORONA_KERNEL,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "shape1" }),

      // ---- ONE cloud, THREE readings (§V471.1) --------------------------------------
      node("drawBase", "renderPoints", [-700, -240], {
        count: CORONA_POINTS, blend: "additive", accumulate: false,
        color: [0.17, 0.27, 0.54, 1], group: "",
      }, {
        label: "drawbase1",
        parameters: { sizePixels: drivenSlot("dot1:level", 1.4) },
      }),
      node("drawMid", "renderPoints", [-700, 20], {
        count: CORONA_POINTS, blend: "additive", accumulate: false,
        color: [1, 0.42, 0.1, 1], sizePixels: 1.3,
        /* The kernel wrote `creases` into velocity.y (§V471.2), so this predicate reads
           "only where the surface is creased" — a selection on SHAPE, not on position. */
        group: "p.velocity.y > 0.04",
      }, { label: "drawmid1" }),
      node("drawTip", "renderPoints", [-700, 280], {
        count: CORONA_POINTS, blend: "additive", accumulate: false,
        color: [0.1, 0.85, 1, 1], group: "p.velocity.y > 0.17",
      }, {
        label: "drawtip1",
        parameters: { sizePixels: drivenSlot("tip1:high", 1.4) },
      }),

      node("base", "null", [-440, -240], {}, { label: "base1" }),
      node("heatLvl", "level", [-440, 20], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "heatlvl1", parameters: { brightness: drivenSlot("heat1:low", 0.8) } }),
      node("sparkLvl", "level", [-440, 280], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "sparklvl1", parameters: { brightness: drivenSlot("spark1:high", 0.6) } }),

      // ---- the post, one job per stage (§V471.4) -------------------------------------
      node("halo", "blur", [-180, -480], { size: 34, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haloLvl", "level", [80, -480], {
        blacklevel: 0.01, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "halolvl1", parameters: { brightness: drivenSlot("glow1:low", 1.1) } }),
      node("burn", "add", [340, -240], {}, { label: "burn1" }),
      node("palette", "ramp", [340, 20], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* SEVEN stops, and they travel (§V471.6): black, a near-black navy, blue, purple,
           red, gold, white. The grade is why three colours read as a hundred. */
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.1, color: [0.01, 0.02, 0.07, 1] },
          { position: 0.3, color: [0.06, 0.13, 0.42, 1] },
          { position: 0.52, color: [0.48, 0.09, 0.64, 1] },
          { position: 0.72, color: [0.98, 0.26, 0.22, 1] },
          { position: 0.89, color: [1, 0.74, 0.3, 1] },
          { position: 1, color: [1, 0.98, 0.93, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("coat", "lookup", [600, -240], {
        channel: "luminance", row: 0.5, offset: 0,
      }, { label: "coat1", parameters: { scale: drivenSlot("grade1:highMid", 1.6) } }),
      node("liftHeat", "screen", [860, -240], {}, { label: "liftheat1" }),
      node("liftSpark", "screen", [1120, -240], {}, { label: "liftspark1" }),
      /* THE TRAILS CLOSE ON THE FINAL OUTPUT (§V471.5), not on the raw render: `tail1` is
         the last node, so what smears is the GRADED, hue-drifted picture. A trail taken
         from an earlier stage looks like a ghost of something else. */
      node("loop", "feedback", [1120, 60], {
        source: "tail1", clearColor: [0, 0, 0, 1], reset: false, substeps: 1,
      }, { label: "loop1", parameters: { persistence: drivenSlot("trail1:level", 0.9) } }),
      node("mixTrail", "screen", [1380, -240], {}, { label: "mixtrail1" }),
      /* 0.035 Hz — a 29-SECOND cycle (§V471.8). The slowest thing in the piece is slower
         than the viewer's attention span, which is most of why an hour of it is watchable.
         Free-running (§V436, B98), so a timeline lap does not restart the drift.

         T574 — AND THE AMPLITUDE IS IN THE TARGET'S UNITS, which is what this file got
         wrong for four rounds. `lfoValue` returns `offset + amplitude·wave` in whatever
         the DRIVEN PARAMETER measures, and `hue1.hueoffset` is DEGREES on a -180..180
         range. So the old `0.35` swung ±0.35 DEGREES — a tenth of a percent of a turn —
         while the .md claimed the drift was most of why the piece does not get boring.
         The period was always right; the travel was ~100x short and no test could see it
         (§T575: the range checker reads an LFO as a default 0..1 span, not its real one,
         so this one is checked BY EYE).

         30 is 30 degrees either side — 60 PEAK-TO-PEAK, a sixth of the wheel. Calibrated
         against E32-Pasture, which runs 24 on this identical `drift1 -> hueoffset` shape
         and reads as genuinely travelling: a quarter more than Pasture, which suits Corona
         being the more colour-forward piece, and nowhere near a rainbow cycle. The palette
         should be somewhere else than it was a moment ago, not somewhere ELSE ENTIRELY. */
      node("drift", "lfo", [1380, 60], { shape: "sine", frequency: 0.035, amplitude: 30, offset: 0, phase: 0 }, { label: "drift1" }),
      node("hue", "hsv", [1640, -240], { saturation: 1.12, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      node("tail", "null", [1900, -240], {}, { label: "tail1" }),
      node("out", "output", [2160, -240], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-source", ["beat", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-damp", ["source", "out"], ["damp", "in"]),
      edge("e-damp-swellg", ["damp", "out"], ["swellG", "a"]),
      edge("e-swellg-swell", ["swellG", "out"], ["swell", "a"]),
      edge("e-damp-glowg", ["damp", "out"], ["glowG", "a"]),
      edge("e-glowg-glow", ["glowG", "out"], ["glow", "a"]),
      edge("e-damp-dotg", ["damp", "out"], ["dotG", "a"]),
      edge("e-dotg-dot", ["dotG", "out"], ["dot", "a"]),
      edge("e-damp-heatg", ["damp", "out"], ["heatG", "a"]),
      edge("e-heatg-heat", ["heatG", "out"], ["heat", "a"]),
      edge("e-damp-sparkg", ["damp", "out"], ["sparkG", "a"]),
      edge("e-sparkg-sparkadd", ["sparkG", "out"], ["sparkAdd", "a"]),
      edge("e-sparkadd-spark", ["sparkAdd", "out"], ["spark", "in"]),
      edge("e-damp-gradeg", ["damp", "out"], ["gradeG", "a"]),
      edge("e-gradeg-grade", ["gradeG", "out"], ["grade", "a"]),
      edge("e-damp-trailg", ["damp", "out"], ["trailG", "a"]),
      edge("e-trailg-trail", ["trailG", "out"], ["trail", "a"]),
      edge("e-damp-tipg", ["damp", "out"], ["tipG", "a"]),
      edge("e-tipg-tip", ["tipG", "out"], ["tip", "a"]),

      edge("e-gen-shape", ["gen", "out"], ["shape", "in"]),
      edge("e-shape-base", ["shape", "out"], ["drawBase", "points"]),
      edge("e-shape-mid", ["shape", "out"], ["drawMid", "points"]),
      edge("e-shape-tip", ["shape", "out"], ["drawTip", "points"]),

      edge("e-base-null", ["drawBase", "out"], ["base", "in"]),
      edge("e-mid-heatlvl", ["drawMid", "out"], ["heatLvl", "input"]),
      edge("e-tip-sparklvl", ["drawTip", "out"], ["sparkLvl", "input"]),

      edge("e-null-halo", ["base", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-null-burn", ["base", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),
      edge("e-burn-coat", ["burn", "out"], ["coat", "source"]),
      edge("e-palette-coat", ["palette", "out"], ["coat", "lookup"]),
      edge("e-coat-liftheat", ["coat", "out"], ["liftHeat", "in1"]),
      edge("e-heatlvl-liftheat", ["heatLvl", "out"], ["liftHeat", "in2"], 0),
      edge("e-liftheat-liftspark", ["liftHeat", "out"], ["liftSpark", "in1"]),
      edge("e-sparklvl-liftspark", ["sparkLvl", "out"], ["liftSpark", "in2"], 0),
      edge("e-liftspark-mixtrail", ["liftSpark", "out"], ["mixTrail", "in1"]),
      edge("e-loop-mixtrail", ["loop", "out"], ["mixTrail", "in2"], 0),
      edge("e-mixtrail-hue", ["mixTrail", "out"], ["hue", "input"]),
      edge("e-hue-tail", ["hue", "out"], ["tail", "in"]),
      edge("e-tail-out", ["tail", "out"], ["out", "input"]),
    ],
  ),
);
