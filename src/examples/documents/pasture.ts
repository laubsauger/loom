import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";

/* ═══ E32 — PASTURE (T621) ═══════════════════════════════════════════════════════════
 *
 * THE FIRST EXAMPLE IN THE CATALOGUE WHERE THE POINTS WRITE THE FIELD THAT STEERS THEM.
 *
 * Everything shipped before this is one-directional. E24 is a field that makes a picture;
 * E16 and E31 are points that make a picture. No example lets the two halves talk. Here
 * they are one system, and the cycle is the whole idea:
 *
 *     herd1 (agents) ─► sow1 (draw into a 640x360 texture) ─► sowin1 ─► pack1
 *          ▲                                                              │
 *          │                                          state1 ◄────────────┘  (by name)
 *          │                                             │
 *          └── herd1.field ◄─ smell1 (blur) ◄─ rd1 (Gray-Scott) ◄┘
 *
 * As a sentence: the animals DEPOSIT where they walk, the deposit REACTS, and the reaction
 * is what the animals smell on the next lap. The middle step is what keeps this from being
 * a Physarum clone. A Physarum trail only blurs and decays, so the picture can never be
 * more than the paths that were walked. A Gray-Scott deposit SPOTS, BRANCHES and MITOSES
 * on its own — a trail the herd laid twenty seconds ago is still inventing structure while
 * the herd is somewhere else entirely, and the herd then comes back and eats it.
 */
const PASTURE_AGENTS = 5_000;

/**
 * SEMANTICS OF THE SCHEMA, because three of these four numbers are read by nodes that are
 * not this kernel (§V471.2 — the kernel WRITES data for downstream selection):
 *
 *   position  clip space, z unused. The renderer splats at `position.xy` directly and
 *             `fieldAt` maps the same xy to the field's texels (T477/T512), so ONE
 *             coordinate system spans the herd, the picture and the simulation.
 *   velocity  the heading, as a unit vector in SCREEN units. Not a velocity in the E16
 *             sense — there is no inertia here; an animal turns and walks.
 *   graze.x   FED: a short lag of the reaction rate under its feet. `graze1` draws these.
 *   graze.y   FAMINE: seconds since the last mouthful, over a six-second scale. `scout1`
 *             draws these AND the kernel reads it back as its own exploration policy.
 *   graze.z   FOUND: 1 on the step a long-starved animal eats, decaying after. `find1`
 *             draws these — the pioneers, marking where the colony is about to be.
 *   graze.w   the grazer's SIZE in pixels, so `graze1` maps sprite size per point (T286)
 *             instead of taking one number for the whole layer.
 */
const PASTURE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "graze", type: "vec4f", default: [0, 0, 0, 0] },
]);

const PASTURE_KERNEL = `/* A clip unit is 640 px across x and 360 px across y on this 16:9 frame, so every
   displacement is squashed in x to make walking ISOTROPIC ON SCREEN. One constant, and it
   is the only thing in this kernel that knows the output's shape. */
const PX: vec2f = vec2f(0.5625, 1.0);
/* The pasture, in clip space: the same disc \`bowl1\` cuts out of the chemistry map, and the
   ONE number stated in two coordinate systems in this file. bowl1.center is uv with v DOWN;
   this is clip with y UP, so (0.40, 0.54) uv is (-0.20, -0.08) clip (T512's mapping,
   uv.y = 0.5 - y*0.5). Move one and move the other. There is deliberately NO radius here to
   match \`bowl1\`'s: an animal does not know the shape of the coastline, only that it is
   hungry and which way the middle is. Which side of the coast it is standing on it finds out
   by starving. */
const HOME: vec2f = vec2f(-0.2, -0.08);
/* T657: 0.60, where it was 0.42. The roost's circuit is the piece's disturbance and the
   outskirts were outside it — a lattice is what a Gray-Scott field does when nothing
   arrives to disturb it, and nothing did. A wider circuit sweeps the grazed clearing
   through most of the pasture over its 83-second lap, so a region that is lattice now was
   torn open a minute ago and will be again. This is the half of the fix that MOVES; the
   chemistry gradient is the half that VARIES. */
const RANGE: f32 = 0.60;

/* WHAT AN ANIMAL SMELLS: the reaction RATE, not a concentration. U*V*V is Gray-Scott's own
   reaction term, and it is largest exactly on a GROWING front — zero in empty plate (V=0)
   and small inside a saturated blob (U already eaten). Steering on it puts the herd on the
   living edge and nowhere else, which is why the swarm never piles onto a dead spot and
   never has to be told not to. The field arrives BLURRED (\`smell1\`): fieldAt is a
   textureLoad, NEAREST and unfiltered by construction (§V57), and a Gray-Scott V is
   near-binary (§V427), so an unblurred difference of it is mostly quantisation. */
fn forage(spot: vec2f) -> f32 {
  let f = fieldAt(vec3f(spot, 0.0));
  return f.r * f.g * f.g;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T510: firstRun is 1u on exactly the dispatches whose storage was just created or
     cleared — the seeding signal, and the only honest one (frameIndex == 0 is a timeline
     lap, not a fresh buffer). Scatter once, deterministically: pointRand is a hash of the
     identity, not a stream, so the same seed lays the same herd on any device (§V45). */
  if (ctx.firstRun == 1u) {
    /* ON THE PASTURE, not across the frame. A uniform scatter walks a fifth of the herd
       through the dead ground before the spring gathers it, and every one of them seeds a
       spot out there that then persists for the rest of the run — measured: the first build
       to get this far had the empty four fifths covered in stray colonies laid in the first
       two seconds. sqrt() on the radius is what makes the disc UNIFORM rather than
       centre-heavy; without it the middle is seeded four times as hard as the rim. */
    let a = pointRand(ctx.index, 37u) * 6.2831853;
    let r = sqrt(pointRand(ctx.index, 11u)) * 0.8;
    let h = pointRand(ctx.index, 23u) * 6.2831853;
    q.position = vec3f(HOME + vec2f(cos(a), sin(a)) * r * PX, 0.0);
    q.velocity = vec3f(cos(h), sin(h), 0.0);
    q.graze = vec4f(0.0, 0.0, 0.0, 0.0);
    return q;
  }

  let pos = q.position.xy;
  let dir = normalize(select(vec2f(1.0, 0.0), q.velocity.xy, dot(q.velocity.xy, q.velocity.xy) > 1e-8));
  let nrm = vec2f(-dir.y, dir.x);

  /* THREE SENSORS, not a finite difference — and this is the cheaper of the two ways to
     get a direction out of a field. The alternative is to make the reaction shader encode
     its own gradient into spare channels, and there are none spare (b is the chemistry
     map, a is the kernel's initialised flag), so it would cost a second full-field pass:
     230 400 texels. Three taps per animal costs 72 000 loads for the whole herd — a third
     of that, with no extra node and no channel budget. Sensing scales with the HERD; a
     field encoding scales with the FIELD, and the field is the bigger of the two.
     ctx.value2 is the audio on the reach: the hats make the herd look further ahead. */
  let reach = ctx.value2;
  let sway = 0.62;
  let leftDir = dir * cos(sway) + nrm * sin(sway);
  let rightDir = dir * cos(sway) - nrm * sin(sway);
  let ahead = forage(pos + dir * reach * PX);
  let left = forage(pos + leftDir * reach * PX);
  let right = forage(pos + rightDir * reach * PX);

  /* A FIXED TURN TOWARD THE BETTER SIDE — Physarum's rule — and NOT a proportional
     controller on (left - right)/total, which is what this kernel had for six builds and
     which measured as doing nothing at all. The reason is worth keeping: a gain small
     enough that a saturated sensor does not spin the animal is also too small to turn it
     onto a feature ten pixels wide before it has walked past. ABLATION, at gain 3.6: the
     reaction rate under the herd was 1.56x the pasture's average with steering on and
     1.71x with the term deleted entirely. A term you can delete without the measurement
     moving is not a mechanism, however good the sentence describing it is.
     The 1e-4 guard is the other half: on bare ground all three sensors read zero, the
     comparison is meaningless, and an animal that turns on noise never travels. */
  var steer = 0.0;
  if (max(left, right) > ahead + 1e-4) {
    steer = select(-9.5, 9.5, left > right);
  }

  /* HUNGER RANDOMISES, and this is the line that makes \`graze.y\` a POLICY rather than a
     colour. A fed animal walks its front; a starving one loses the plot and random-walks,
     which is the only thing in the file that ever finds the NEXT colony. The picture reads
     the same number as "scouts", so what you see streaming out of the cluster is literally
     the search. The gain is 2.4 and not 7: at 7 a starved animal spins fast enough that it
     cannot hold a heading long enough to follow a gradient at all, so hunger became a TRAP
     — measured, the starving fraction saturated at famine 1.0 and never recovered, and the
     "found" caste below rendered nothing, ever. Exploration has to stay navigable. */
  steer = steer + (pointRand(ctx.index, 5u) - 0.5) * (0.45 + 2.4 * q.graze.y);

  /* E16's spring — but keyed to HUNGER rather than to distance, and that one change is
     what stops the picture being a circle. A distance spring draws a disc: every animal is
     equally pulled wherever it is, so the flock fills a round region whatever the field is
     doing underneath it, and the pasture's shape stops mattering. Gated on famine instead,
     a WELL-FED animal is not homing at all — it stays where the food is — and only an
     animal that has gone hungry turns back toward the middle. The flock's outline is
     therefore drawn by the FOOD, it migrates as it eats a region down, and E16's sentence
     still holds: the murmuration never abandons the sphere. The second term is the frame's
     fence and nothing else: past 0.95 of a half-height from home, everything turns back. */
  /* WHERE HOME IS THIS MINUTE. A fixed spring has a FIXED POINT, and a flock sitting on
     its own fixed point eats one spot to the ground and stays there forever — measured, a
     blown-out core in the same place at frames 300, 900 and 1500 with the rest of the
     pasture untouched. §V532 is the same sentence about an expanding loop; this is the herd
     saying it. So the roost walks a slow circle: ctx.value4 is an 83-second SAW on an
     ANGLE, which is the one wave whose wrap is continuous once you take its cosine, and the
     flock makes a circuit of its range, grazing it down behind and finding it regrown by
     the time it comes round again. It is the piece's longest cycle and it is in the
     ANIMALS, not in the grade. */
  let home = HOME + vec2f(cos(ctx.value4), sin(ctx.value4)) * RANGE * PX;
  let toHome = (home - pos) / PX;
  let away = length(toHome);
  let sinHome = (dir.x * toHome.y - dir.y * toHome.x) / max(away, 1e-5);
  steer = steer + sinHome * (5.5 * q.graze.y + 9.0 * smoothstep(0.8, 1.2, away));

  /* §V481(b) ON THE HERD, which is the half of that invariant nobody had a place to put.
     An envelope on the turn rate is a DC term: it bends every animal the same way for as
     long as it is up, which is a drift, not an event. A beat arrives as an ANGLE instead —
     one frame, a different kick per animal — and because the HEADING IS STATE the swarm
     carries the consequence for seconds afterwards. It is E24's seeded plate said in the
     other half of the loop: the impulse is instant and the consequence is not. It is an
     ANGLE and not a rate, and deliberately NOT multiplied by ctx.delta: a trigger has no
     duration, so scaling it by time would be scaling an event by how long it did not last
     (§V509). */
  let burst = (pointRand(ctx.index, 9u) - 0.5) * ctx.value3;

  let ang = atan2(dir.y, dir.x) + steer * ctx.delta + burst;
  let walk = vec2f(cos(ang), sin(ang));
  var nextPos = pos + walk * ctx.value1 * ctx.delta * PX;
  /* A fence, not a mechanism — the spring above is what actually holds the herd. Anything
     that reaches this has been pushed by a burst on the far side of the frame. */
  nextPos = clamp(nextPos, vec2f(-1.02), vec2f(1.02));

  q.velocity = vec3f(walk, 0.0);
  q.position = vec3f(nextPos, 0.0);

  /* WHAT THE ANIMAL KNOWS ABOUT ITSELF — three numbers the picture then slices on. */
  /* THE GAIN IS MEASURED, not chosen: over the blurred field the reaction rate is 0 at the
     median and 0.136 at the ninth decile, so x14 saturates on roughly the richest tenth of
     the pasture and reads zero on the half of it that is bare. */
  let meal = clamp(forage(nextPos) * 14.0, 0.0, 1.0);
  /* A SHORT lag, 1/12 s — long enough to smooth the crossing of a single texel, short
     enough to actually REACH what it is tracking. At 1/5 s it never did: an animal crosses
     a front in about six frames, the lag only closes 8% of the gap per frame, and the value
     equilibrated near the duty cycle instead of near the value — measured, it never passed
     0.45 for any animal in the herd, so every threshold above it was dead. */
  let fed = q.graze.x + (meal - q.graze.x) * clamp(ctx.delta * 12.0, 0.0, 1.0);
  /* FAMINE RESETS ON A PROPER MOUTHFUL, NOT ON A BRUSH PAST ONE, and that
     one number is the difference between a live mechanism and a decorative attribute.
     Reset at 0.20 and every animal brushes enough structure to keep its clock at zero: the
     scout caste renders ONE sprite in the whole frame and the hunger term in the steering
     above multiplies by zero — an idea the file states and never delivers, which is the
     exact failure §V471.8 records in Corona's hue drift. Measured at both settings. */
  let famine = select(min(1.0, q.graze.y + ctx.delta / 1.6), 0.0, fed > 0.45);
  let found = select(0.0, 1.0, q.graze.y > 0.20 && fed > 0.40);
  /* .w is the grazer's own size in pixels: a per-point pscale (T286), so \`graze1\` is not
     one sprite size for a whole layer but every animal drawn at how much it is eating. */
  /* T671: the decay was 0.8 and is now 0.45. \`found\` is a hard threshold and the caste
     that reads it (\`find1\`, group p.graze.z > 0.30) POPS when a point dithers across the
     line — E34's lesson in the other example, that a binary verdict wants a slower state
     under it rather than a filter over the picture. 2.2 s instead of 1.25 s keeps a point
     on one side long enough to stop flickering, and the caste still empties. */
  q.graze = vec4f(fed, famine, max(found, q.graze.z * exp(-ctx.delta * 0.45)), 0.7 + 1.4 * fed);
  return q;
}`;

/**
 * THE REACTION. It is E2's kernel in shape — a nine-tap Laplacian and two coupled rate
 * equations, with the feed/kill pair read PER PIXEL out of the state's blue channel — and
 * it is NOT E2's kernel, for two measured reasons.
 *
 * ## 1. THE BAND, and the correction it forced
 *
 * §V474 says the HIGH corner of a Gray-Scott feed/kill band is spots and mitosis and the
 * LOW corner is the labyrinth, and E2's own docstring says both ends stay alive. Both are
 * claims about E2's SPECIFIC constants and neither survives being pointed at. MEASURED, by
 * driving E2's band with a horizontal 0..1 ramp and running 4800 steps: the imported band
 * is DENSE WORMS at 0, OPEN WORMS at 1, and labyrinth at every point between. There is no
 * spot regime in it and, more to the point here, NO DEAD CORNER — so an example that wants
 * empty field cannot get it by pushing E2's coordinate to either end. E24's black four
 * fifths comes from its colour inversion, not from a chemistry that stopped.
 *
 * (The arithmetic that made both claims look safe is also wrong, and worth naming so the
 * next person does not redo it: F >= 4(F+k)^2 is the condition for a non-trivial
 * HOMOGENEOUS steady state, and Gray-Scott's whole interesting region — self-replicating
 * spots included — lives OUTSIDE it. A pattern is not a fixed point.)
 *
 * So this band is chosen against Pearson's map rather than inherited, and it travels:
 *   chemistry 0.0  ->  F 0.037, k 0.060   dense worms, the pasture at its richest
 *   chemistry 0.5  ->  F 0.0205, k 0.069  self-replicating spots — trails that MITOSE
 *   chemistry 1.0  ->  F 0.004, k 0.078   dead: no feed to grow on, and V starves out
 * which is the range the example needs, because "a trail can branch and divide on its own"
 * is the sentence that separates this from a Physarum clone, and "there is empty field to
 * walk across" is the one that separates it from a carpet.
 *
 * ## 2. THE PLATE STARTS EMPTY, because the herd is the seed
 *
 * E2 answers a cleared pair with a sprinkled starting plate. Here that would be the one
 * thing in the file the herd did not do. Alpha below 0.5 still means "history is gone" and
 * still re-seeds — with U = 1 and V = 0, a field full of food and nothing growing in it —
 * so a reset is a bare pasture and EVERY structure on screen from then on was deposited by
 * an animal. It also makes the coupling test trivial to state: turn the herd off and the
 * frame stays empty forever.
 */
const PASTURE_REACTION_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

const FEED_LOW: f32 = 0.037;
const KILL_LOW: f32 = 0.0600;
const FEED_HIGH: f32 = 0.002;
const KILL_HIGH: f32 = 0.0860;

const DIFFUSE_U: f32 = 0.2097;
const DIFFUSE_V: f32 = 0.105;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(inputTexture));

  let centre = textureSample(inputTexture, inputSampler, uv);
  let west = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, 0.0)).rg;
  let east = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, 0.0)).rg;
  let south = textureSample(inputTexture, inputSampler, uv + vec2f(0.0, -texel.y)).rg;
  let north = textureSample(inputTexture, inputSampler, uv + vec2f(0.0, texel.y)).rg;
  let sw = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, -texel.y)).rg;
  let se = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, -texel.y)).rg;
  let nw = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, texel.y)).rg;
  let ne = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, texel.y)).rg;

  // b is a 0..1 coordinate the GRAPH paints per pixel; the band it walks is above.
  let chemistry = clamp(centre.b, 0.0, 1.0);
  let feed = mix(FEED_LOW, FEED_HIGH, chemistry);
  let kill = mix(KILL_LOW, KILL_HIGH, chemistry);

  let state = centre.rg;
  let laplacian =
    ((west + east + south + north) * 0.2) + ((sw + se + nw + ne) * 0.05) - state;

  let reaction = state.x * state.y * state.y;
  let stepped = clamp(
    vec2f(
      state.x + ((DIFFUSE_U * laplacian.x) - reaction + (feed * (1.0 - state.x))),
      state.y + ((DIFFUSE_V * laplacian.y) + reaction - ((kill + feed) * state.y)),
    ),
    vec2f(0.0),
    vec2f(1.0),
  );

  // alpha < 0.5 == the pair was cleared: a BARE pasture, not a seeded plate.
  let next = select(vec2f(1.0, 0.0), stepped, centre.a >= 0.5);
  return vec4f(next, 0.0, 1.0);
}`;

/**
 * E32 — Pasture (T621).
 *
 * ## What is inherited, named
 *
 * FROM E16-MURMURATION: local rules producing global structure. The herd has no neighbour
 * reads and no global plan — three field samples, a random turn scaled by hunger, and one
 * weak spring toward home (E16's, verbatim in intent). Everything that looks like a
 * decision in this frame is those four lines meeting a field.
 *
 * FROM E31-CORONA (§V471, the calibration file): ONE CLOUD READ FOUR WAYS by group
 * predicate on kernel-written attributes (.1/.2), and one of the four is not a picture at
 * all — `sow1` is the simulation's INPUT. Gain and bias per band (.3), nine of them, each
 * one band to one property, with the bias as the rest state and the gain as the swing
 * (§V477). A ramp that goes somewhere (.6). A long cycle (.8) — and note that §V471.8 is
 * marked INERT in Corona itself because `lfoValue` returns `offset + amplitude*wave` in the
 * TARGET's units and 0.35 on a degrees parameter is a tenth of a percent of a turn. The
 * amplitude here is 24, which is 24 degrees, which travels.
 *
 * FROM E24: the field as a living substrate with real REGIMES rather than one chemistry
 * everywhere (§V474 — the HIGH corner of the feed/kill band is spots and mitosis, and that
 * is where empty field lives), and the off-centre composition (§V532). The reaction shader
 * is E2's, imported rather than re-derived.
 *
 * ## Where the audio goes, and the answer is BOTH HALVES
 *
 * Five of the nine driven properties are inside the simulation and four are on the picture.
 * On the herd: `pace1` is walking speed, `reach1` is how far ahead an animal smells, and
 * `burst1` is a scatter angle on the raw trigger. On the field: `drop1` is how much
 * chemistry a footstep leaves, `warm1` walks the chemistry map's white point through the
 * feed/kill band so whole regions change regime. Only then the picture: `grade1` on the
 * palette scale, `spark1` on the pioneers' size, `glow1` on the bloom, `trail1` on the
 * persistence. A beat is therefore visible three ways at three timescales — the herd
 * scatters THIS frame, the deposit that scatter lays becomes structure over the next few
 * seconds, and the regime it lands in was set by the bar before.
 *
 * ## T671 — a lattice needs a stationary substrate, so deny it one
 *
 * The owner looked at the T657 build and said the field still "consists of all these
 * very regular dots with no interesting motion and things happening outside the absolute
 * nucleus". T657 removed the cause of ONE regime everywhere (§V623); it did not answer
 * why a uniform regime packs regularly, which is simply what Gray-Scott does when the
 * medium under the pattern holds still. Three of the four changes are that one idea:
 *
 *  - ADVECTION (§V626). `flow1` displaces the whole state along a slow flow between the
 *    feedback and the reaction, while `pack1` repaints the chemistry AFTER the reaction —
 *    so the field moves and its parameters do not, which SHEARS. A rigid rotation would
 *    have turned the lattice and left it a lattice.
 *  - WEATHER. `front1` is a fertile ring expanding on the herd's own 83-second lap,
 *    multiplying the chemistry down as it passes, so a region is walked out of the
 *    lattice band and back — the owner's "across screen, at least occasionally".
 *  - THE CAMERA (§V625). A sway on the same clock, a SINE rather than `range1`'s saw
 *    because a saw snaps a rotation once a lap, outside the trail loop.
 *
 * And the fourth, the blink, which is temporal and was measured rather than judged:
 * `env1`'s lag and the `found` caste's decay, both named at their sites.
 *
 * MEASURED, on the shipped file. Blob-area spread in the outskirts 0.872 → 1.132 and
 * mean blob area 60.6 → 106.0 — the outskirts carry worms, dashes, rings, open cells and
 * aligned striations instead of one texture. Negative space not paid for: dark fraction
 * 26.8% → 31.7%. Nucleus hard-flip rate 23.28% → 18.68%. AND THE LOOP IS UNCHANGED,
 * which was the owner's own constraint: deposit off → mean V 0.00000 with zero texels
 * above 0.05; steering on 1.079× the frame mean against a field the herd cannot write,
 * steering deleted 0.996× — chance — versus 1.080× / 0.994× before. A prettier Pasture
 * with a dead stigmergy loop would have been a failure that photographs well.
 *
 * ## The two traps this file paid attention to rather than rediscovering
 *
 * §V533: the loop is pinned. `state1`, `rd1`, `sowin1`, `pack1`, `sow1`, `bowl1`,
 * `terrain1` and `smell1` are all fixed at 640x360, so NOTHING about the simulation rides
 * the output resolution — including the herd's render, which is a `project`-resolution node
 * by policy and would otherwise have splatted its deposit at 192x108 under the liveness
 * probe. `look1` is where the picture leaves the simulation's grid, explicitly.
 *
 * §V509/§V481(b): the trigger is raw. `trig1` reaches `burst1` with no lag between them,
 * because a one-pole answers a single-frame impulse with 1-exp(-dt/tau) — 0.047 at 0.35 s
 * — and a trigger through an envelope-sized smoother is a trigger you deleted.
 *
 * ## SUBSTEPS ARE STRUCTURALLY UNAVAILABLE HERE, and the reason is the example itself
 *
 * A feedback loop's substep body is "every node on a current-frame path from a consumer of
 * the Feedback's output back into the Feedback" (`compiler/substeps.ts`). The herd reads
 * `rd1` and writes `pack1`, so THE HERD IS IN THE LOOP — structurally, not by choice, and
 * that sentence is the whole example. It also means the point kernel's own ping-pong swaps
 * (`swap:scratch:herd:position` and its two siblings) sit inside the span the substep
 * repartition would reorder across, and §V288's guard in `applySubstepLoops` refuses that
 * rather than land a swap on the wrong side of the passes that bind it. Measured, not
 * reasoned: `state1.substeps = 12` compiles to
 *
 *     warning compiler/substeps-refused: Node "state" asked for 12 substeps, but another
 *     temporal pair swaps inside the loop; it runs one step per frame.
 *
 * and the rendered frames came back byte-identical to one step. A shipped example may raise
 * no diagnostic of any severity (T521/T545), so the reaction's speed comes from a CHAIN of
 * eight `customWgsl` nodes instead — the same arithmetic with the count visible in the
 * graph rather than hidden in a parameter, and every one of the eight is a real pass doing
 * a real Laplacian.
 *
 * WORTH KNOWING FOR THE NEXT PERSON: `renderHeadless` reports BACKEND diagnostics only. The
 * substeps refusal lives on `plan.diagnostics`, which a look harness printing
 * `result.diagnostics` never sees — this file ran three builds believing substeps worked.
 */
export const pastureDocument = document(
  "e32-pasture",
  "E32 Pasture",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 21, previewFps: 20 }),
  graph(
    [
      // ---- the sound: pattern or your track, exclusively (T504's shape) --------------
      node("beat", "audioPattern", [-2860, 1320], { bpm: 104, amount: 1 }, { label: "beat1" }),
      node("track", "audioFileIn", [-2860, 1540], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-2600, 1320], { index: 0 }, { label: "source1" }),
      /* ONE lag and ONE trigger, which is the smallest honest set. 0.07 s is short enough
         that a kick is an event and long enough that the bands stop jittering; the trigger
         is the instant, and §V509 is why nothing stands between it and what it drives. */
      /* T671: 0.16 s, where it was 0.07. Four frames of lag still let a high band arrive
         as a per-frame pulse on two sprite castes' SIZE, which is what "blinky" was.
         MEASURED on the nucleus alone, thresholded at display 205 so it is the core and
         not the field, at the project's full 1280×720 (§V627 — an additive points
         document read at half res is a different exposure): hard-flip rate 23.28% →
         15.42%, mean frame-to-frame delta 38.25 → 32.91. The TRIGGER is untouched — it
         reaches `burst1` on its own wire from `source1` and never through this lag, so
         §V509 still holds and a beat is still an event rather than a drift. */
      /* T686/T701 — THE ASYMMETRIC FOLLOWER. One symmetric lag either lags the attack or
         passes the flicker; this is the standard envelope shape instead: fast attack
         (max of a 45ms and a 400ms lag) measured AGAINST the source's own 5s average,
         floored at zero. Under music it took the nucleus hard-flip rate 1.839 → 0.853 —
         landing ON the pattern's own 0.869, so the two sources finally behave alike.
         `env`'s id and label live on the FLOOR node so all fourteen downstream edges and
         the nine re-derived biases (now in the deviation domain: rest IS zero) are
         untouched by construction. */
      node("envFast", "valueLag", [-3120, 1100], { lag: 0.045 }, { label: "envfast1" }),
      node("envMid", "valueLag", [-3120, 1320], { lag: 0.4 }, { label: "envmid1" }),
      node("envSlow", "valueLag", [-3120, 1540], { lag: 5 }, { label: "envslow1" }),
      node("envPeak", "valueMath", [-2860, 880], { operation: "maximum" }, { label: "envpeak1" }),
      node("envDiff", "valueMath", [-2600, 880], { operation: "subtract" }, { label: "envdiff1" }),
      node("env", "valueLimit", [-2340, 880], { minimum: 0, maximum: 4 }, { label: "env1" }),
      node("trig", "valueTrigger", [-2340, 1540], { threshold: 0.5 }, { label: "trig1" }),

      /* ---- THE HERD'S THREE BANDS. These reach ctx.value1..3 (T479), which is the only
         way audio has ever been able to change what a point kernel DOES rather than what
         it is scaled by — E31 had to smuggle its one number in through `radius`. */
      /* Walking speed, in clip units per second: 0.06 at rest, 0.40 flat out. */
      node("paceG", "valueMath", [-2080, 880], { operation: "multiply", operand: 1.1372 }, { label: "paceg1" }),
      node("pace", "valueMath", [-1820, 880], { operation: "add", operand: 0.2208 }, { label: "pace1" }),
      /* Sensor reach, in the same units: 6.5 px at rest, 26 px on the hats. */
      node("reachG", "valueMath", [-2080, 1100], { operation: "multiply", operand: 0.0931 }, { label: "reachg1" }),
      node("reach", "valueMath", [-1820, 1100], { operation: "add", operand: 0.0648 }, { label: "reach1" }),
      /* The scatter, in RADIANS and off the raw trigger: +-0.01 rad at rest (nothing),
         +-1.2 rad on the frame a beat lands. §V477 read as far as it goes — at rest this
         term does not exist, so the beat is not a change of degree in something already
         happening, it is the only time it happens at all. */
      node("burstG", "valueMath", [-2080, 1320], { operation: "multiply", operand: 3.4 }, { label: "burstg1" }),
      node("burst", "valueMath", [-1820, 1320], { operation: "add", operand: 0.02 }, { label: "burst1" }),

      /* ---- THE FIELD'S TWO BANDS ---------------------------------------------------- */
      /* How much chemistry a footstep leaves. Rest 0.035 is a whisper; 0.135 on a loud
         passage is a herd that paints. */
      node("dropG", "valueMath", [-2080, 1540], { operation: "multiply", operand: 0.14 }, { label: "dropg1" }),
      node("drop", "valueMath", [-1820, 1540], { operation: "add", operand: 0.1758 }, { label: "drop1" }),
      /* HOW BIG A MOUTHFUL IS, in pixels of the simulation's own grid. Rest 1.6 px is a
         nibble; 3.4 px on a loud passage strips the ground bare — and this is the one number
         that keeps the pasture from becoming a carpet, so it is on the kick rather than
         left static. */
      node("gnawG", "valueMath", [-2080, 1980], { operation: "multiply", operand: 6.6897 }, { label: "gnawg1" }),
      node("gnaw", "valueMath", [-1820, 1980], { operation: "add", operand: 2.24 }, { label: "gnaw1" }),
      /* The chemistry map's white point, hard against the band where the pattern survives.
         T562's lesson is the fence: the map's Level sits on a narrow window fitted to the
         noise's measured spread, so the same fractional swing needs a narrow fence too. */
      /* T657: the swing widens 0.05 → 0.14 with the rest state at 0.55, because the
         window it moves is now three times as wide — the same gain on a wider window is a
         smaller gesture (§V471.3, §V477: the bias is the rest state, the gain is the
         swing). Achievable span 0.55…0.69 against a declared −1…4 (T545). */
      node("warmG", "valueMath", [-2080, 1760], { operation: "multiply", operand: 0.4171 }, { label: "warmg1" }),
      node("warm", "valueMath", [-1820, 1760], { operation: "add", operand: 0.571 }, { label: "warm1" }),

      /* ---- AND ONLY THEN THE PICTURE ------------------------------------------------ */
      node("gradeG", "valueMath", [-1560, 880], { operation: "multiply", operand: 1.6083 }, { label: "gradeg1" }),
      node("grade", "valueMath", [-1300, 880], { operation: "add", operand: 0.98 }, { label: "grade1" }),
      node("sparkG", "valueMath", [-1560, 1100], { operation: "multiply", operand: 2.3275 }, { label: "sparkg1" }),
      node("spark", "valueMath", [-1300, 1100], { operation: "add", operand: 1.32 }, { label: "spark1" }),
      node("glowG", "valueMath", [-1560, 1320], { operation: "multiply", operand: 0.24 }, { label: "glowg1" }),
      node("glow", "valueMath", [-1300, 1320], { operation: "add", operand: 0.1571 }, { label: "glow1" }),
      node("trailG", "valueMath", [-1560, 1540], { operation: "multiply", operand: 0.22 }, { label: "trailg1" }),
      node("trail", "valueMath", [-1300, 1540], { operation: "add", operand: 0.6249 }, { label: "trail1" }),

      // ---- THE HERD -----------------------------------------------------------------
      node("herd", "pointKernel", [780, 0], {
        capacity: PASTURE_AGENTS, seed: 21, group: "",
        attributes: PASTURE_ATTRIBUTES,
        kernel: PASTURE_KERNEL,
      }, {
        label: "herd1",
        parameters: {
          value1: drivenSlot("pace1:low", 0.28),
          value2: drivenSlot("reach1:high", 0.08),
          value3: drivenSlot("burst1:onsetCount", 0.02),
          /* The roost's bearing — see the kernel's `home`. */
          value4: drivenSlot("range1", 0),
        },
      }),

      /* ---- ONE CLOUD, FOUR READINGS (§V471.1) — and the first one is not a picture ---
       *
       * `sow1` is the DEPOSIT: every animal, no predicate, white, drawn into the
       * simulation's own 640x360 grid rather than the frame's. It is the input to the
       * reaction, and it is also (through the state, one node later) most of what you see
       * of the herd — so the swarm's body is visible as CHEMISTRY and only its castes are
       * visible as sprites. §V533 is why the resolution is pinned: renderPoints is a
       * `project`-resolution node by policy, so at T521's 192x108 liveness probe this
       * would otherwise have splatted the whole herd's deposit into a tenth of the grid
       * the reaction runs on. */
      node("sow", "renderPoints", [1040, 220], {
        /* ALPHA, not additive, and this is the one blend decision in the file that is not
           taste. A deposit answers "is there spore on this texel", which is bounded; two
           animals standing together cannot leave twice as much. Additive, they do: five
           thousand sprites in the opening frame's disc overlapped three deep, the screen
           below took V straight to 1 across the whole herd, and the first frame rendered as
           a solid white disc — invisible at 1280 wide, where the specks are separated, and
           the entire picture at T521's 192x108 probe, where they merge. */
        count: PASTURE_AGENTS, blend: "alpha", accumulate: false,
        /* GREEN, AND THAT IS THE WHOLE DIFFERENCE BETWEEN AN ECOLOGY AND A COLLAPSE.
           The state is (U = substrate, V = autocatalyst), and a WHITE deposit screens both
           of them toward 1 — so a footprint hands the animal back everything its own sensor
           multiplies together, U*V*V goes maximal exactly where the herd already is, and the
           flock converges to a point and stays there. Measured: a blown-out core at the
           spring's centre by frame 900, the rest of the pasture untouched.
           An animal deposits SPORE, not SOIL. Green touches V only; U is the pasture's to
           give, and it is depleted by the reaction that the spore starts. So a patch the
           herd has worked is rich in V and BARE of U, its reaction rate falls, and the herd
           has to move on to eat — which is the negative feedback the picture is made of. */
        color: [0, 1, 0, 1], sizePixels: 3, group: "",
      }, { label: "sow1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* The three castes, each a predicate on a number THE KERNEL WROTE (§V471.2): who is
         starving, who is eating, and who has just found something. */
      node("scout", "renderPoints", [1040, -440], {
        count: PASTURE_AGENTS, blend: "additive", accumulate: false,
        color: [0.03, 0.07, 0.24, 1], sizePixels: 0.9,
        group: "p.graze.y > 0.45",
      }, { label: "scout1", resolution: { mode: "fixed", width: 1280, height: 720 } }),
      node("graze", "renderPoints", [1300, -440], {
        count: PASTURE_AGENTS, blend: "additive", accumulate: false,
        color: [0.62, 0.2, 0.03, 1], group: "p.graze.x > 0.30",
      }, {
        label: "graze1",
        resolution: { mode: "fixed", width: 1280, height: 720 },
        parameters: {
          /* T286's pscale: the sprite size is a PER-POINT attribute, so a grazer is drawn
             at how much it is eating rather than at one number for the whole layer. */
          sizePixels: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 2.2 },
              map: { kind: "map", attribute: "graze", channel: "w" },
            },
          },
        },
      }),
      /* THE FIFTH READING, and the one that makes this an ECOLOGY rather than a paint
         program. Everything above ADDS to the field; without a negative term a deposit that
         grows into a colony stays a colony, the pasture fills the disc and the composition
         freezes into a carpet — measured, by frame 900 of the build before this one. So the
         animals that are EATING (the same predicate `graze1` draws in amber) are drawn a
         second time into a mask that is MULTIPLIED out of the state. An animal that finds
         food takes it, the ground behind the herd goes bare, and the reaction grows it back
         from the edges: that is the whole reason the frame never settles.
         The sprite is nearly twice the deposit's, so a grazer removes more than it lays and
         a well-fed patch cannot run away. */
      /* THE DEPTH OF ONE MOUTHFUL IS THE SPRITE'S COLOUR, 0.45, and the SIZE of it is the
         audio. Both of those are decisions this node had to be talked into. Level applies
         `brightness` AFTER `invert` — `(1 - x) * b`, not `1 - b*x` — so putting the depth on
         the mask's brightness multiplies the ENTIRE simulation by b every frame instead of
         only under a grazer, and the field collapses to nothing in about a second. Measured,
         and it looked exactly like a chemistry that would not ignite. Composite's own
         `opacity` cannot hold the depth either: multiply is `front * back` with opacity
         scaling the FRONT, so it dims the whole state the same way. */
      node("bite", "renderPoints", [1040, 440], {
        count: PASTURE_AGENTS, blend: "alpha", accumulate: false,
        color: [0.55, 0.55, 0.55, 1], group: "p.graze.x > 0.30",
      }, { label: "bite1",
        resolution: { mode: "fixed", width: 640, height: 360 },
        parameters: { sizePixels: drivenSlot("gnaw1:low", 2.6) },
      }),
      /* Exactly 1 - coverage, and nothing else: every number here is at its identity so the
         mask cannot quietly become a gain on the simulation. */
      node("chew", "level", [1300, 440], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 1, brightness: 1, opacity: 1,
      }, { label: "chew1" }),
      node("find", "renderPoints", [1560, -440], {
        count: PASTURE_AGENTS, blend: "additive", accumulate: false,
        color: [0.2, 0.55, 0.75, 1], group: "p.graze.z > 0.30",
      }, {
        label: "find1",
        resolution: { mode: "fixed", width: 1280, height: 720 },
        parameters: { sizePixels: drivenSlot("spark1:high", 1.5) },
      }),

      // ---- THE CHEMISTRY MAP, and where the pasture is allowed to exist -------------
      /*
       * T657 — THE OUTSKIRTS WERE STATIC BECAUSE A COMPOSITE DELETED THEIR VARIATION, and
       * that is one step further down than "nothing disturbs them". `terrain1` is already
       * spatially varied and already drifting; `screen(coast1, shape1)` then threw it
       * away, because `screen(1, anything) = 1` and this disc's background was WHITE.
       * MEASURED by rendering `dish1` straight to the output: median 0.9989, and p90, p99
       * and p999 all 0.9989 as well — the chemistry map was ONE NUMBER across the whole
       * frame outside the disc, so every region ran the same regime for ever and a
       * Gray-Scott field with nothing to distinguish one place from another packs
       * hexagonally. The lattice was not the chemistry's fault; it was the falloff's.
       *
       * §V554 obeyed rather than inherited: this file's own band, driven end to end with a
       * 0..1 ramp for 2400 steps, is LABYRINTH below ~0.15, worms breaking into segments
       * 0.15–0.35, rings and irregular blobs 0.35–0.60, the REGULAR SPOT LATTICE 0.60–0.85,
       * and dying above ~0.85. The outskirts sat at 0.999. Widening the falloff walks them
       * back down through the interesting part of that band instead, and because `terrain1`
       * drifts, WHICH region is in which regime keeps changing.
       *
       * The author's constraint was the real brief — break it up WITHOUT costing the
       * negative space — so the two aggressive versions were tried and REJECTED by
       * measurement: pinning the far outskirts on the death line (background 0.86, then
       * 0.92) took the dark fraction from 46.4% to 38.6% and the blob-area spread from
       * 0.483 to 0.449, i.e. it cost negative space AND came back more regular. The
       * gradient keeps both: dark fraction 46.2% → 46.4% early and 28.4% → 26.8% at frame
       * 3000, blob-area CV in the outskirts 0.757 → 0.872.
       */
      /* §V474 and §V532 in one pair of nodes. `bowl1` is a disc painted BLACK INSIDE and
         WHITE OUTSIDE — already the inversion E24 needed a second node for — so screening
         it into the map pins the coordinate at the band's HIGH corner everywhere outside.
         There (feed 0.042, kill 0.068) Gray-Scott's existence condition F < 4(F+k)^2 fails
         — 0.042 against 0.0484 — so V has no non-trivial steady state at all and decays to
         nothing. The dark part of this frame is the simulation being genuinely empty, not
         a matte over a full-frame carpet, and the soft edge is a gradient THROUGH the
         band, so the pasture frays into spots before it stops. T657 made that gradient
         WIDE, which is the whole fix: a narrow one put almost everything on the far side
         of it at a single saturated value. Off-centre
         because the composition wants it there and because §V532 is the record of what
         happens to material sitting on a loop's own fixed point. */
      /* T657: radius 0.26 and softness 0.42, where it was 0.29 and 0.24. The disc is
         slightly smaller and its falloff nearly TWICE as wide, so the ramp through the band
         occupies most of the frame instead of a narrow ring — the outskirts become a
         REGIME GRADIENT, and only the far corners still pin at 1.0. The background stays
         white on purpose: that is what keeps the negative space, and it is the half of
         this the two rejected variants gave away. */
      node("bowl", "circle", [-2860, -440], {
        mode: "fill", center: [0.4, 0.54], radius: [0.26, 0.26], softness: 0.42,
        fillcolor: [0, 0, 0, 1], bgcolor: [1, 1, 1, 1], aspectcorrect: true,
      }, { label: "bowl1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* THE COASTLINE. A circle is a shape nobody chose, and a pasture with a circular
         boundary reads as a mask over a simulation rather than as a place. Warping the disc
         by a slow two-channel noise gives it bays and peninsulas — and because the noise is
         ANIMATED at 0.02 (a fifty-second lap), the coast itself creeps, so the herd is
         forever losing ground on one side and gaining it on the other. That is the piece's
         slowest timescale and it costs two nodes.
         MONO IS OFF, which is the whole difference between a coast and a shove: `displace`
         reads x from red and y from green, and a monochrome field has red == green, so
         every pixel of the disc would slide along the SAME 45-degree diagonal and the
         circle would simply move. */
      node("swell", "noise", [-2860, -220], {
        type: "perlin4d", seed: 41, period: 0.55, harmon: 2, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: false, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.035,
      }, { label: "swell1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* T657: 0.30 rather than 0.15, and the swell drifting at 0.035 rather than 0.02.
         The coastline is now the width of the falloff it is warping, so the regime bands
         are ragged and interlocking rather than concentric — a wide smooth ramp warped a
         little is still visibly a ring. */
      node("coast", "displace", [-2600, -440], {
        weight: [0.30, 0.30], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold",
      }, { label: "coast1" }),
      node("terrain", "noise", [-2600, -220], {
        type: "perlin4d", seed: 5, period: 0.18, harmon: 4, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1.25, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        /* T657: 0.06 rather than 0.04. The regime map is what "evolves" means here —
           which patch of the pasture is lattice and which is worms is now visibly a
           function of time, not just of place. The PERIOD is deliberately left at 0.18:
           tried at 0.34 the patches grew larger than the frame, which reads as uniform
           again from inside one of them. */
        t4d: 0.37, s4d: 1, speed: 0.06,
      }, { label: "terrain1", resolution: { mode: "fixed", width: 640, height: 360 } }),
      /* THE WINDOW IS T562's AND THE BRIGHTNESS IS THIS FILE'S OWN FINDING. Gray-Scott has
         a non-trivial steady state only where F >= 4(F+k)^2, and over the imported band
         that is chemistry BELOW about 0.16: at 0 (F 0.028, k 0.0545) it is 0.028 against
         0.0272 and alive, at 0.5 it is 0.035 against 0.0371 and already dead. So a map
         spanning the whole 0..1 coordinate spends four fifths of itself in a regime with
         nothing in it — which is what killed the first build of this file stone dead by
         frame 800. RE-MEASURED for T657, because the earlier note here was too coarse to
         act on: driving this file's own band with a 0..1 ramp gives LABYRINTH below ~0.15,
         worms breaking into segments 0.15–0.35, rings and irregular blobs 0.35–0.60, the
         REGULAR SPOT LATTICE 0.60–0.85, and death only above ~0.85. Which of those a
         region is in is the difference between "the outskirts are interesting" and "the
         outskirts are a hex grid", so the boundary that matters is 0.60, not the death
         line. `brightness: 0.72` therefore
         puts the pasture across the whole living part of the band and a little way past it,
         so a few patches inside the disc are bare ground the herd has to cross, while
         `bowl1` pins everything outside at 1.0, which is well clear of the boundary rather
         than balanced on it. §V474 read one level down: the "high corner" where empty field
         lives is high RELATIVE TO WHAT SURVIVES, not the top of whatever coordinate the
         graph happens to hand over — and where that boundary is, is a measurement. */
      /* T657: the black point drops 0.45 → 0.36, which is where a four-harmonic perlin
         sum's LINEAR band actually starts (§V587's measurement, reused). At 0.45 against a
         white point of ~0.54 the window was a sliver of that band and `shape1` was very
         nearly BINARY — the terrain contributed an on/off mask rather than a landscape, so
         even where the screen did not saturate there were only two regimes to be in. The
         window now spans the band and the audio drive widens with it. */
      node("shape", "level", [-2340, -220], {
        blacklevel: 0.36, contrast: 1, brightness: 0.72, gamma1: 1.25, invert: 0, opacity: 1,
      }, { label: "shape1", parameters: { whitelevel: drivenSlot("warm1:lowMid", 0.62) } }),
      node("dish", "screen", [-2080, -440], { opacity: 1 }, { label: "dish1" }),
      /*
       * T671 — WEATHER. A fertile front, expanding on the herd's own 83-second lap.
       * Multiplying the chemistry map DOWN in a moving ring walks that ring's regime
       * from the lattice band (0.60–0.85) back toward worms and coral, and then releases
       * it: the owner's "more effect on the field all across screen, at least
       * occasionally". `range1` is the piece's clock and this is its second consequence,
       * so the front and the grazing circuit are in step by construction rather than by
       * two numbers that happen to agree.
       *
       * The ×0.30 is a RANGE fit, not a taste knob: `range1` spans ±π and `phase` is
       * declared −1…1, so the raw channel would clamp (T545). ±0.94 fills the parameter
       * and leaves a margin.
       *
       * Verified TRAVELLING rather than assumed — a driven parameter that never arrives
       * is §V471.8's exact failure. Rendering `front1` alone, its median walks
       * 0.9989 → 0.9967 → 0.8364 → 0.9989 across frames 0 / 600 / 1200 / 1800.
       */
      node("sweepG", "valueMath", [-2600, 1760], { operation: "multiply", operand: 0.30 }, { label: "sweepg1" }),
      node("front", "ramp", [-2340, -640], {
        type: "radial", interp: "smooth", period: 2.2,
        stops: [
          { position: 0.0, color: [1, 1, 1, 1] },
          { position: 0.40, color: [1, 1, 1, 1] },
          { position: 0.62, color: [0.55, 0.55, 0.55, 1] },
          { position: 0.84, color: [1, 1, 1, 1] },
          { position: 1.0, color: [1, 1, 1, 1] },
        ],
      }, {
        label: "front1", definitionVersion: 2,
        resolution: { mode: "fixed", width: 640, height: 360 },
        parameters: { phase: drivenSlot("sweepg1", 0) },
      }),
      node("weather", "multiply", [-2080, -652], { opacity: 1 }, {
        label: "weather1", resolution: { mode: "fixed", width: 640, height: 360 },
      }),
      /*
       * T671 — ADVECTION, and it is the one that kills the lattice. §V626: to break a
       * pattern you move the MEDIUM; rotating the pattern turns a lattice and leaves it a
       * lattice. One `displace` between the feedback and the reaction nudges the whole
       * state along `swell1`'s slow two-channel flow every frame, and the chemistry map
       * does NOT move with it — `pack1` repaints b from the map AFTER the reaction — so
       * this is advection THROUGH a static parameter field, which shears.
       *
       * 0.0025 is the DENSITY knob and it is a real trade, stated rather than discovered:
       * at 0.006 the dark fraction reaches 71% and the pasture visibly shrinks, because
       * the flow carries V away faster than a low-feed regime can regrow it. Turn it up
       * for wilder and emptier, down for denser and more regular.
       */
      node("flow", "displace", [-1690, -260], {
        weight: [0.0025, 0.0025], offset: [0.5, 0.5], sourcex: "red", sourcey: "green", extend: "hold",
      }, { label: "flow1", resolution: { mode: "fixed", width: 640, height: 360 } }),

      // ---- THE REACTION -------------------------------------------------------------
      node("state", "feedback", [-1820, 0], {
        source: "pack1", persistence: 1, clearColor: [0, 0, 0, 0], reset: false, substeps: 1,
      }, {
        label: "state1",
        resolution: { mode: "fixed", width: 640, height: 360 },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      /* EIGHT REACTION STEPS BETWEEN ONE LOOK AND THE NEXT, as eight nodes — see the
         header for why this is not `substeps`. The shader is E2's, imported rather than
         re-derived: a nine-tap Laplacian, two coupled rate equations, and a feed/kill band
         the GRAPH paints per pixel through the state's blue channel. */
      node("rd", "customWgsl", [-1560, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd1" }),
      node("rd2", "customWgsl", [-1300, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd2" }),
      node("rd3", "customWgsl", [-1040, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd3" }),
      node("rd4", "customWgsl", [-780, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd4" }),
      node("rd5", "customWgsl", [-520, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd5" }),
      node("rd6", "customWgsl", [-260, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd6" }),
      node("rd7", "customWgsl", [0, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd7" }),
      node("rd8", "customWgsl", [260, 0], { [SHADER_SOURCE_PARAMETER]: PASTURE_REACTION_WGSL }, { label: "rd8" }),
      /* WHAT THE HERD SMELLS. §V427 is the reason this node exists: `fieldAt` is a
         textureLoad — NEAREST, unfiltered — and a Gray-Scott V is near-binary, so the
         difference between two adjacent texels of it is mostly quantisation and a herd
         steering on that jitters instead of turning. Five pixels of blur is a field the
         three sensors can actually answer, and it costs one pass on a 640x360 texture.
         It reads rd8 rather than sowin1 ON PURPOSE: the animals smell what the REACTION
         made, never their own footprint one node earlier — which is the difference between
         this and a trail-follower, and it is also what keeps the graph a DAG. */
      node("smell", "blur", [520, 0], { size: 8, filter: "gaussian", extend: "hold" }, {
        label: "smell1", resolution: { mode: "fixed", width: 640, height: 360 },
      }),
      /* THE DEPOSIT ENTERS. Screen is the operator this wants and not a convenience:
         1-(1-a)(1-b) takes U and V toward 1 where a footstep is, and (U=1, V=1) in a small
         patch is LITERALLY the reaction kernel's own `seededState` — the classic
         Gray-Scott starting plate. So an animal does not brighten the picture, it drops new
         chemistry into it and the reaction spends the next second growing what the animal
         put there. The DEPOSIT IS THE FRONT (§V510's shape): Composite's opacity scales the
         front only, so `drop1` reads as "how much chemistry a footstep leaves" on the node
         that does the depositing, with no extra node to hold it. */
      node("sowIn", "screen", [1300, 0], {}, {
        label: "sowin1",
        resolution: { mode: "fixed", width: 640, height: 360 },
        parameters: { opacity: drivenSlot("drop1:level", 0.2) },
      }),
      /* AND THE DEPOSIT IS EATEN BACK. `chew1` is 1 everywhere and 1-depth under a
         grazer, so this is the herd's mouth. */
      node("eat", "multiply", [1560, 0], { opacity: 1 }, {
        label: "eat1", resolution: { mode: "fixed", width: 640, height: 360 },
      }),
      /* r = U, g = V, b = the chemistry coordinate the map paints, a = the INITIALISED
         FLAG — and it is written as a CONSTANT ONE rather than carried through. Alpha below
         0.5 is the reaction kernel's "history is gone, re-seed" signal, and `eat1`
         multiplies alpha by the bite mask like every other channel: carried through, a
         grazer's own footprint would read as a cleared pair and re-seed the pixel it stood
         on. `one` here means only a genuinely cleared feedback pair (project load, reset,
         resize) can ever re-seed, which is what the flag is for. */
      node("pack", "reorder", [1820, 0], {
        outr: "in1r", outg: "in1g", outb: "in2lum", outa: "one",
      }, { label: "pack1", resolution: { mode: "fixed", width: 640, height: 360 } }),

      // ---- COLOUR, then TIME --------------------------------------------------------
      /* §V511: V is NEAR-BINARY, so a Gray-Scott picture visits exactly TWO stops of any
         ramp unless something continuous is added to the index first. The chemistry map is
         that something, read a SECOND time (§V471.1) and inverted for the same reason E24
         inverts it: `dish1` is pinned at 1 outside the disc, so reading it straight would
         lift the empty four fifths of the frame onto the ramp and give the whole frame a
         ground colour. Inverted, the dead field contributes exactly zero and the ground is
         the ramp's own first stop. Inside, the sense is also the better one — a region
         running the LOW (labyrinth) chemistry is the dense one and gets the warmer base. */
      node("chem", "level", [1560, 220], {
        blacklevel: 0, whitelevel: 1, contrast: 1, gamma1: 1, invert: 1,
        brightness: 0.26, opacity: 0,
      }, { label: "chem1" }),
      /* WHERE THE PICTURE LEAVES THE SIMULATION'S GRID — and it lands on a SECOND fixed
         resolution rather than on the project's, which is §V533 pushed one step further
         than E24 needed to push it. Two things in this file are measured in OUTPUT PIXELS
         and would otherwise ride whatever resolution the host asks for: `sizePixels` on the
         three caste renders, and `halo1`'s blur radius. At 1280 wide a 0.9 px scout is a
         speck and an 18 px bloom is a soft edge; at T521's 192x108 probe the same numbers
         are a six-pixel blob and a bloom nine percent of the frame across, and the herd
         renders as one saturated white mass — measured, p90 0.99 at frame 0.
         Pinning here (and on the three caste renders above, which are `project`-policy
         nodes) makes the whole picture resolution-independent: the Output node scales a
         finished 1280x720 frame instead of re-deciding what a pixel means. The simulation
         upstream is pinned at 640x360 for the same reason and neither number is the
         other's. */
      node("look", "add", [2080, 0], { opacity: 1 }, {
        label: "look1", resolution: { mode: "fixed", width: 1280, height: 720 },
      }),
      node("palette", "ramp", [2080, 440], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* SEVEN STOPS THAT TRAVEL (§V471.6), and they cross hue as well as brightness:
           near-black, teal-black, dark teal, jade, moss, gold, cream. The bulk of the frame
           lives in the first three and only a front reaches the gold, which is §V477 stated
           as a palette rather than as a gain. */
        stops: [
          { position: 0, color: [0.004, 0.007, 0.016, 1] },
          { position: 0.16, color: [0.02, 0.05, 0.1, 1] },
          { position: 0.34, color: [0.03, 0.2, 0.32, 1] },
          { position: 0.52, color: [0.06, 0.45, 0.44, 1] },
          { position: 0.7, color: [0.35, 0.66, 0.42, 1] },
          { position: 0.86, color: [0.95, 0.72, 0.3, 1] },
          { position: 1, color: [1, 0.97, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("tint", "lookup", [2340, 0], { channel: "green", row: 0.5, offset: 0 }, {
        label: "tint1",
        /* §V471.7 — the grade BREATHES. Rest 1.15 puts the fronts in the jade and leaves
           the moss and the gold as somewhere for a loud passage to reach. */
        parameters: { scale: drivenSlot("grade1:highMid", 1.15) },
      }),
      /* The three castes go on top of the graded field, coldest first. Screen rather than
         add: an animal on an already-bright front should not double it. */
      node("liftScout", "screen", [2600, 0], { opacity: 1 }, { label: "liftscout1" }),
      node("liftGraze", "screen", [2860, 0], { opacity: 1 }, { label: "liftgraze1" }),
      node("liftFind", "screen", [3120, 0], { opacity: 1 }, { label: "liftfind1" }),
      node("halo", "blur", [3120, 220], { size: 18, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      /* The bloom's WEIGHT is the audio (§V471.3): the blurred copy is the front here, so
         one number says how much halo, and it rests low. */
      node("burn", "add", [3380, 0], {}, {
        label: "burn1",
        parameters: { opacity: drivenSlot("glow1:level", 0.17) },
      }),
      /* §V471.5 — THE TRAILS CLOSE ON THE FINAL OUTPUT. `hue1` is the last node before the
         Output, so what smears is the graded, hue-drifted picture rather than the raw
         render, and the persistence is on the audio: louder means longer memory. */
      node("loop", "feedback", [3380, 220], {
        source: "hue1", clearColor: [0, 0, 0, 1], reset: false, substeps: 1,
      }, { label: "loop1", parameters: { persistence: drivenSlot("trail1:level", 0.7) } }),
      node("mixTrail", "screen", [3640, 0], { opacity: 1 }, { label: "mixtrail1" }),
      /* §V471.8 — A LONG CYCLE, with the amplitude in the TARGET'S UNITS. 0.028 Hz is a
         36-second lap and `hueoffset` is DEGREES on a -180..180 range, so 24 is 24 degrees
         and the piece actually travels. Corona's own 0.35 on the same parameter is a tenth
         of a percent of a turn, which is why T574 exists. Free-running (§V436, B98). */
      /* THE TRANSHUMANCE. 0.012 Hz is an 83-second circuit — three times slower than the
         hue drift, and the slowest thing in the piece. SAW rather than sine because it
         drives an ANGLE: the wrap from +pi to -pi is invisible once you take its cosine,
         where a sine would make the flock swing back and forth along one line instead of
         going round. Free-running (§V436, B98): a timeline lap must not put the herd back
         where it started. */
      node("range", "lfo", [-2340, 1980], {
        shape: "saw", frequency: 0.012, amplitude: 3.14159, offset: 0, phase: 0,
      }, { label: "range1" }),
      node("drift", "lfo", [3640, 220], {
        shape: "sine", frequency: 0.028, amplitude: 24, offset: 0, phase: 0,
      }, { label: "drift1" }),
      node("hue", "hsv", [3900, 0], { saturation: 1.06, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift1", 0) },
      }),
      /*
       * T671 — THE CAMERA, the owner's "rotate camera lerpy on bar or whatever". A slow
       * sway on the piece's OWN 83-second lap, the same clock the herd's circuit walks.
       *
       * §V625: a SINE at `range1`'s frequency, not `range1` itself. That saw is right for
       * an angle the herd WALKS — its wrap from +π to −π is invisible once you take the
       * cosine — and wrong for a rotation, where the same wrap snaps the frame back once
       * a lap. Same clock, same period, re-shaped rather than re-used. No audio: a
       * gesture this slow must not acquire a live-device dependency.
       *
       * OUTSIDE the trail loop, which closes on `hue1`. §V481(a) is exactly about a
       * transform inside a feedback loop; a rotation in there would spiral the trails
       * instead of swaying the picture. The 1.12 scale is the cover for ±4.5°.
       */
      node("sway", "lfo", [3900, 400], {
        shape: "sine", frequency: 0.012, amplitude: 4.5, offset: 0, phase: 0,
      }, { label: "sway1" }),
      node("spin", "transform", [4160, 0], {
        t: [0, 0], s: [1.12, 1.12], p: [0, 0], xord: "srt", extend: "hold", aspectcorrect: true,
      }, { label: "spin1", parameters: { r: drivenSlot("sway1", 0) } }),
      node("out", "output", [4420, 0], {}, { label: "out1" }),
    ],
    [
      // sound: both sources reach the Switch, exactly one leaves it (T504/T508).
      edge("e-beat-source", ["beat", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-envfast", ["source", "out"], ["envFast", "in"]),
      edge("e-source-envmid", ["source", "out"], ["envMid", "in"]),
      edge("e-source-envslow", ["source", "out"], ["envSlow", "in"]),
      edge("e-envfast-envpeak", ["envFast", "out"], ["envPeak", "a"]),
      edge("e-envmid-envpeak", ["envMid", "out"], ["envPeak", "b"]),
      edge("e-envpeak-envdiff", ["envPeak", "out"], ["envDiff", "a"]),
      edge("e-envslow-envdiff", ["envSlow", "out"], ["envDiff", "b"]),
      edge("e-envdiff-env", ["envDiff", "out"], ["env", "in"]),
      edge("e-source-trig", ["source", "out"], ["trig", "in"]),
      // the herd's three bands
      edge("e-env-paceg", ["env", "out"], ["paceG", "a"]),
      edge("e-paceg-pace", ["paceG", "out"], ["pace", "a"]),
      edge("e-env-reachg", ["env", "out"], ["reachG", "a"]),
      edge("e-reachg-reach", ["reachG", "out"], ["reach", "a"]),
      edge("e-trig-burstg", ["trig", "out"], ["burstG", "a"]),
      edge("e-burstg-burst", ["burstG", "out"], ["burst", "a"]),
      // the field's two
      edge("e-env-dropg", ["env", "out"], ["dropG", "a"]),
      edge("e-dropg-drop", ["dropG", "out"], ["drop", "a"]),
      edge("e-env-warmg", ["env", "out"], ["warmG", "a"]),
      edge("e-warmg-warm", ["warmG", "out"], ["warm", "a"]),
      edge("e-env-gnawg", ["env", "out"], ["gnawG", "a"]),
      edge("e-gnawg-gnaw", ["gnawG", "out"], ["gnaw", "a"]),
      // the picture's four
      edge("e-env-gradeg", ["env", "out"], ["gradeG", "a"]),
      edge("e-gradeg-grade", ["gradeG", "out"], ["grade", "a"]),
      edge("e-env-sparkg", ["env", "out"], ["sparkG", "a"]),
      edge("e-sparkg-spark", ["sparkG", "out"], ["spark", "a"]),
      edge("e-env-glowg", ["env", "out"], ["glowG", "a"]),
      edge("e-glowg-glow", ["glowG", "out"], ["glow", "a"]),
      edge("e-env-trailg", ["env", "out"], ["trailG", "a"]),
      edge("e-trailg-trail", ["trailG", "out"], ["trail", "a"]),

      // the chemistry map: a disc that decides where the pasture is, over a noise
      edge("e-terrain-shape", ["terrain", "out"], ["shape", "input"]),
      edge("e-bowl-coast", ["bowl", "out"], ["coast", "source"]),
      edge("e-swell-coast", ["swell", "out"], ["coast", "disp"]),
      edge("e-coast-dish", ["coast", "out"], ["dish", "in1"]),
      edge("e-shape-dish", ["shape", "out"], ["dish", "in2"], 0),

      // THE LOOP, both directions of it.
      // outward: the state reacts four times, and the herd smells the result.
      edge("e-state-flow", ["state", "out"], ["flow", "source"]),
      edge("e-swell-flow", ["swell", "out"], ["flow", "disp"], 0),
      edge("e-flow-rd", ["flow", "out"], ["rd", "input"]),
      edge("e-rd1-rd2", ["rd", "out"], ["rd2", "input"]),
      edge("e-rd2-rd3", ["rd2", "out"], ["rd3", "input"]),
      edge("e-rd3-rd4", ["rd3", "out"], ["rd4", "input"]),
      edge("e-rd4-rd5", ["rd4", "out"], ["rd5", "input"]),
      edge("e-rd5-rd6", ["rd5", "out"], ["rd6", "input"]),
      edge("e-rd6-rd7", ["rd6", "out"], ["rd7", "input"]),
      edge("e-rd7-rd8", ["rd7", "out"], ["rd8", "input"]),
      edge("e-rd8-smell", ["rd8", "out"], ["smell", "input"]),
      edge("e-smell-herd", ["smell", "out"], ["herd", "field"]),
      // inward: the herd deposits, and the deposit is screened back into the state.
      edge("e-herd-sow", ["herd", "out"], ["sow", "points"]),
      edge("e-sow-sowin", ["sow", "out"], ["sowIn", "in1"]),
      edge("e-rd8-sowin", ["rd8", "out"], ["sowIn", "in2"], 0),
      edge("e-herd-bite", ["herd", "out"], ["bite", "points"]),
      edge("e-bite-chew", ["bite", "out"], ["chew", "input"]),
      edge("e-chew-eat", ["chew", "out"], ["eat", "in1"]),
      edge("e-sowin-eat", ["sowIn", "out"], ["eat", "in2"], 0),
      edge("e-eat-pack", ["eat", "out"], ["pack", "in1"]),
      edge("e-range-sweepg", ["range", "out"], ["sweepG", "a"]),
      edge("e-dish-weather", ["dish", "out"], ["weather", "in1"]),
      edge("e-front-weather", ["front", "out"], ["weather", "in2"], 0),
      edge("e-weather-pack", ["weather", "out"], ["pack", "in2"]),

      // the same cloud, three more times
      edge("e-herd-scout", ["herd", "out"], ["scout", "points"]),
      edge("e-herd-graze", ["herd", "out"], ["graze", "points"]),
      edge("e-herd-find", ["herd", "out"], ["find", "points"]),

      // colour
      edge("e-dish-chem", ["dish", "out"], ["chem", "input"]),
      edge("e-chem-look", ["chem", "out"], ["look", "in1"]),
      edge("e-eat-look", ["eat", "out"], ["look", "in2"], 0),
      edge("e-look-tint", ["look", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-liftscout", ["tint", "out"], ["liftScout", "in1"]),
      edge("e-scout-liftscout", ["scout", "out"], ["liftScout", "in2"], 0),
      edge("e-liftscout-liftgraze", ["liftScout", "out"], ["liftGraze", "in1"]),
      edge("e-graze-liftgraze", ["graze", "out"], ["liftGraze", "in2"], 0),
      edge("e-liftgraze-liftfind", ["liftGraze", "out"], ["liftFind", "in1"]),
      edge("e-find-liftfind", ["find", "out"], ["liftFind", "in2"], 0),
      edge("e-liftfind-halo", ["liftFind", "out"], ["halo", "input"]),
      edge("e-halo-burn", ["halo", "out"], ["burn", "in1"]),
      edge("e-liftfind-burn", ["liftFind", "out"], ["burn", "in2"], 0),
      edge("e-burn-mixtrail", ["burn", "out"], ["mixTrail", "in1"]),
      edge("e-loop-mixtrail", ["loop", "out"], ["mixTrail", "in2"], 0),
      edge("e-mixtrail-hue", ["mixTrail", "out"], ["hue", "input"]),
      edge("e-hue-spin", ["hue", "out"], ["spin", "input"]),
      edge("e-spin-out", ["spin", "out"], ["out", "input"]),
    ],
  ),
);
