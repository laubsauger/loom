import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E9 — Ember (T322, T323, T339, T510/T579, T511).
 *
 * A FIRE FRONT: twenty-four vents along the floor of the frame, breathing out of phase,
 * and everything above them is an ember that was born, is cooling, and will die. The
 * whole point lifecycle, running as weather.
 *
 * ## What this was, and why it changed (T511)
 *
 * It was E9-Particle-Fountain: one pinned emitter, a ballistic spray of four thousand
 * identical blue dots, gravity and a floor test. The owner's verdict was "a bit silly",
 * and they were right — a fountain is the hello-world of particle systems and this one
 * was shipped as a showcase. Every mechanism it demonstrated is still here, unchanged
 * and still the only shipped file that demonstrates any of them. What changed is that
 * the mechanisms are now pointed at something worth looking at.
 *
 * ## ONE SOURCE, THREE READINGS (§V471.1) — and the split is the LIFECYCLE
 *
 * `bed1`, `body1` and `spark1` are three `renderPoints` over the SAME cloud, differing
 * only in a group predicate, a colour and a size:
 *
 * | | predicate | colour | reads as |
 * | --- | --- | --- | --- |
 * | `bed1` | (none — every ember) | deep red, largest | the dying bed and its glow |
 * | `body1` | `p.velocity.z > 0.30` | orange | the burning column |
 * | `spark1` | `p.velocity.z > 0.72` | white-gold, smallest | the newest sparks only |
 *
 * E31 splits its cloud on how CREASED a point is; this one splits on how OLD it is, and
 * age is a thing that only exists because points are born. The three draws are additive
 * and stacked, so an ember carries all three where it qualifies: a fresh one is a small
 * white core inside an orange middle inside a red halo — a black-body gradient PER
 * PARTICLE, out of selection alone, with no per-point colour attribute anywhere. As it
 * cools it drops out of `spark1`, then out of `body1`, and ends as one dim red dot.
 * Watching a single ember fall down the table is watching it die.
 *
 * ## HEAT RIDES IN `velocity.z`, and the binding budget is why (§V471.2)
 *
 * A lifecycle kernel USED TO spend 2·(n−1)+2 storage bindings for n attributes incl. flags
 * (T1076 packed them into one buffer per half and the count stopped growing with n),
 * and baseline WebGPU guarantees 8 per compute stage — so the default schema
 * (position, velocity, id, flags) lands EXACTLY at the limit and one more attribute
 * busts it silently. The simulation is 2D, so `velocity.z` is free, and heat rides
 * there. That is E31's idea (`q.velocity = vec3f(field, creases, drive)`) arrived at
 * from the other direction: not a flourish, an arithmetic constraint with a name.
 *
 * It is also what the group predicates read. The kernel writes the number the draws
 * select on, which is the whole shape of §V471.2.
 *
 * ## A CURL FIELD, because a simulation is not noise (§V427)
 *
 * The draught is the CURL of a moving scalar field, and the curl of anything is
 * divergence-free: it can shear the plume, fold it and shed eddies off it, and it can
 * never squeeze it into a knot. The embers do not follow it — they are accelerated by
 * it against their own drag, so the picture is the field INTEGRATED through inertia,
 * which is the thing three octaves of noise cannot give you. Buoyancy is proportional
 * to heat, so an ember stops rising as it cools and the column leans over and comes
 * apart near the top instead of leaving the frame as a bar.
 *
 * ## THE SEEDING SIGNAL (T510/T579, §V495, §V507)
 *
 * The kernel seeds on `ctx.firstRun == 1u` — "my storage was just created or cleared" —
 * and NOT on `ctx.frameIndex == 0u`, which is the same event only if you never lap. A lap
 * keeps its buffers, so a simulation must survive it; a seek and a document load clear
 * them, and it must not. Measured on Dawn: a seek re-seeds this file to ~7,000 embers and
 * a fresh open seeds the same, which is the half the old design got right and which does
 * not regress.
 *
 * MEASURED AND NOT FIXED, stated here rather than discovered later: the kernel's own guard
 * is now correct and the LIFECYCLE GLUE AROUND IT IS NOT. Four generated passes still
 * infer "my storage is fresh" from `frameIndex == 0` — the kernel's live-count guard
 * (`codegen.ts`), the dead-tail clear, and the two spawn-id passes (`lifecycle.ts`) — so
 * at a lap the guard opens to the full capacity, codegen forces `alive = 1u` on load, and
 * the dead tail is resurrected. Isolated on a 64-point synthetic kernel that reads no
 * clock at all: 12 live before the lap, 64 after, and it never comes back down. The old
 * `frameIndex == 0` seed guard was MASKING that, by killing the resurrected tail on the
 * same frame it appeared. §V495's lesson is one layer deeper than T510 reached, and this
 * example cannot deliver the owner's fix until those four sites take the same signal.
 *
 * A firstRun seed is also a WARM START — eleven thousand embers already spread through
 * the column, heat falling with height — rather than a single lit vent. Two reasons, and
 * neither is decoration: a gallery thumbnail is frame 0 (T535), and a file whose first
 * second is an empty frame filling up is a file whose card is black. The seeded
 * generation is entirely replaced by births within about four seconds; everything after
 * that is the lifecycle.
 *
 * ## STILL PLAYABLE (T367, §V363)
 *
 * `ctx.pointer` is a GUST: a Gaussian shove that scatters embers out of the draught and
 * lets them fall back into it. A cutoff radius reads as a bug and a falloff reads as
 * air, which is the same argument the old file made and the one thing about it that was
 * never in question. The pointer costs the other examples nothing — a kernel that does
 * not name it generates the text it generated before the member existed (§V309).
 *
 * Determinism is unchanged in the sense §V45 means it: nothing reads a wall clock, the
 * RNG is still hash(seed, id, frame), and the fire is a function of the POINTER STREAM
 * as well as the seed, exactly as E12's stirring force is.
 *
 * If spawning, compaction, the counted indirect draw or the hook's newborn-range guard
 * regress, this file is still where it shows: a fire that freezes at frame zero's
 * census, doubles endlessly, or emits identical embers.
 */
/** Allocation bound. Steady state is ~11k (16 vents × ~2 births a frame × a ~210-frame
 *  life), so the headroom is a little over 2× — enough that a synchronised flare across
 *  every vent cannot saturate the emitter and start dropping births. */
const EMBER_CAPACITY = 16384;

const EMBER_KERNEL = `const VENTS: u32 = 16u;
/* The WARM START's size: near steady state, so frame 0 is the fire already burning
   rather than an empty frame filling up. A gallery thumbnail is frame 0 (T535). */
const SEEDED: u32 = 7000u;
const TAU: f32 = 6.28318530717958647692;

/** The DRAUGHT, as a stream function: three moving terms at three scales. What the
    embers actually feel is its CURL, below — and the curl of any scalar field is
    divergence-free by construction, so this can shear the plume, fold it and shed
    eddies off it, and can never squeeze it into a knot. */
fn draught(pos: vec2f, t: f32) -> f32 {
  let broad = sin(pos.x * 3.1 + t * 0.61) * cos(pos.y * 2.3 - t * 0.44);
  let mid = sin((pos.x + pos.y * 1.3) * 5.7 - t * 0.83) * 0.42;
  let fine = cos(pos.x * 8.3 - t * 1.17) * sin(pos.y * 7.1 + t * 0.93) * 0.17;
  return broad + mid + fine;
}

fn curl(pos: vec2f, t: f32) -> vec2f {
  let e = 0.04;
  let dx = draught(pos + vec2f(e, 0.0), t) - draught(pos - vec2f(e, 0.0), t);
  let dy = draught(pos + vec2f(0.0, e), t) - draught(pos - vec2f(0.0, e), t);
  return vec2f(dy, -dx) / (2.0 * e);
}

/** Everything an ember feels except the pointer, as ACCELERATION. One function because
    it is integrated in two places: once per frame below, and once more as the warm
    start's pre-roll — and a warm start computed by different arithmetic from the
    simulation is a warm start that opens on a picture the piece never shows. */
fn forces(pos: vec2f, vel: vec2f, heat: f32, t: f32) -> vec2f {
  /* Scaled by heat: cold ash drifts where hot gas whips. */
  let swirl = curl(pos, t) * (0.30 + 0.70 * heat) * 0.34;
  /* Buoyancy IS heat, which is why the column leans over and comes apart near the top
     rather than leaving the frame as a bar: an ember stops rising when it stops being
     hot. */
  let lift = vec2f(0.0, 1.55 * heat);
  /* At the vents this is a BED, not a spray — a weak inward pull that has faded out by
     a quarter of the way up, so the spreading higher up reads as spreading. */
  let gather = vec2f(-pos.x * 0.9 * (1.0 - smoothstep(-0.87, -0.45, pos.y)), 0.0);
  /* Drag. Embers are ACCELERATED by the draught, never teleported along it, so the
     picture is the field INTEGRATED through inertia — which is the whole of §V427:
     noise is smooth at every scale and a simulation is not. */
  return swirl + lift + gather - vel * 1.55;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* THE SEEDING GUARD — \`ctx.firstRun\`, and the whole of T510/T579 is in that choice.
     (The glue passes around this kernel have NOT been converted — see the note above the
     document. This guard is right; the machinery it sits in is not, yet.)
     It means "my storage was just created or cleared" and NOTHING else. The number it
     replaced, ctx dot frameIndex equals zero, meant that AND "the timeline lapped to the
     in point", and one token carrying two meanings is why the owner's fountain restarted
     at every loop (§V495): a lap KEEPS its buffers, so a simulation must survive it,
     while a seek and a document load CLEAR them and it must not. The absolute frame
     counter is no better from the other side — it counts straight through a seek, so on
     it the fire would never be rebuilt at all. (§V507: this is computed per dispatch from
     fresh allocations plus pending buffer clears, and use-detected — a kernel that does
     not name it emits byte-identical WGSL, §V309.) */
  if (ctx.firstRun == 1u) {
    /* Identity is the SLOT, once and only here. From now on a point IS its id: compaction
       moves survivors down the buffer every frame and nothing may depend on where they
       land (§V73). */
    q.id = ctx.index;
    q.spawnCount = 0u;
    if (ctx.index >= VENTS) {
      if (ctx.index >= SEEDED) {
        q.alive = 0u; /* headroom for births */
        return q;
      }
      /* THE WARM START, and it is not a scatter. Each ember is given the same BIRTH the
         spawn hook gives one, and then the same integration is RUN FORWARD by its own
         age — so frame 0 is a state this simulation genuinely reaches, filaments and
         negative space and all, instead of a cloud of confetti the first second has to
         clear away. A gallery thumbnail is frame 0 (T535), and the first thing anyone
         sees of a file is its card.

         The age is a uniform fraction of the ember's OWN lifetime, which is the age
         distribution a constant birth rate actually produces — so the seeded generation
         is not merely plausible, it is correctly proportioned, and it dies off on
         exactly the schedule a born one does. Within about four seconds nothing seeded
         here is still alive and everything on screen was born. */
      let lean = pointRand(ctx.index, 1u) - 0.5;
      let rise = pointRand(ctx.index, 2u);
      let hot = pointRand(ctx.index, 3u);
      let vent = pointRand(ctx.index, 12u);
      let cool = 0.45 + pointRand(ctx.index, 4u) * 1.15;
      let age = pointRand(ctx.index, 11u) * (3.3 / cool);
      var sp = vec2f(-0.84 + vent * 1.68 + lean * 0.1, -0.87 + rise * 0.05);
      var sv = vec2f(lean * 0.6, 0.26 + rise * 0.5);
      var sh = 0.84 + hot * 0.16;
      /* Bounded so a long-lived ember cannot cost 150 iterations; the step stays well
         inside the drag's stability limit (2/1.55) either way. */
      let steps = min(u32(age * 24.0) + 1u, 96u);
      let sdt = age / f32(steps);
      for (var step = 0u; step < steps; step = step + 1u) {
        sh = sh * exp(-cool * sdt);
        sv = sv + forces(sp, sv, sh, ctx.absTime) * sdt;
        sp = sp + sv * sdt;
      }
      q.position = vec3f(sp, 0.0);
      q.velocity = vec3f(sv, sh);
      return q;
    }
  }

  if (q.id < VENTS) {
    /* A VENT. Pinned, immortal, and the only thing in the file that spawns. Each one
       BREATHES at its own rate and phase off the free-running clock (§V436), so the fire
       flares along its length instead of pulsing as one bar — which is the difference
       between a fire and a row of jets. */
    let seat = f32(q.id) / f32(VENTS - 1u);
    q.position = vec3f(-0.84 + seat * 1.68, -0.87, 0.0);
    q.velocity = vec3f(0.0, 0.0, 0.0);
    let rate = 0.5 + pointRand(q.id, 7u) * 0.95;
    let flare = 0.5 + 0.5 * sin(ctx.absTime * rate + pointRand(q.id, 8u) * TAU);
    q.spawnCount = 1u + u32(flare * 2.99);
    return q;
  }

  /* AN EMBER. Heat rides in \`velocity.z\` — the simulation is 2D so the component is
     free, and a fifth attribute would bust the 8-storage-buffer budget outright. It is
     also what the three draws select on (§V471.2). */
  var heat = q.velocity.z;
  /* Per-ember cooling rate, deterministic per id (§V73): identical lifetimes would make
     the plume a moving edge. Death is at 0.03, so a life is 2.1s to 7.5s — and the SPREAD is what
     puts tongues of still-hot gas high in the frame instead of a level band. */
  heat = heat * exp(-(0.45 + pointRand(q.id, 4u) * 1.15) * ctx.delta);

  let pos = q.position.xy;
  var vel = q.velocity.xy;

  /* T367: the GUST. \`ctx.pointer\` is the same four numbers the value graph's Mouse node
     publishes and every fragment shader reads (§V182) — viewer-normalised, v DOWN
     (§V236) — and the one conversion into this graph's clip space is written HERE,
     because a kernel cannot see how it will be viewed. Gaussian, not a cutoff radius: a
     hard edge reads as a bug and a fading shove reads as air. */
  let cursor = vec2f(ctx.pointer.x * 2.0 - 1.0, 1.0 - ctx.pointer.y * 2.0);
  let away = pos - cursor;
  let reach = max(length(away), 0.0001);
  let gust = (away / reach) * (8.0 * exp(-(reach * reach) / 0.055));

  vel = vel + (forces(pos, vel, heat, ctx.absTime) + gust) * ctx.delta;
  q.velocity = vec3f(vel, heat);
  q.position = vec3f(pos + vel * ctx.delta, 0.0);

  if (heat < 0.03 || q.position.y > 1.14 || abs(q.position.x) > 1.4) {
    q.alive = 0u;
  }
  return q;
}`;

const EMBER_SPAWN = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var q = child;
  /* The child arrives as a COPY OF ITS VENT, position included, so everything that makes
     it an individual is drawn here from its own fresh id (§V73/§V74). Delete this hook
     and every ember born in a frame is the same ember, launched from the same point at
     the same speed with the same heat — twenty-four hard lines instead of a fire. */
  let lean = pointRand(q.id, 1u) - 0.5;
  let rise = pointRand(q.id, 2u);
  let hot = pointRand(q.id, 3u);
  q.position = q.position + vec3f(lean * 0.1, rise * 0.05, 0.0);
  q.velocity = vec3f(lean * 0.6, 0.26 + rise * 0.5, 0.84 + hot * 0.16);
  return q;
}`;

export const emberDocument = document(
  "e9-ember",
  "E9 Ember",
  settings({ randomSeed: 13 }),
  graph(
    [
      node(
        "sim",
        "pointKernelAdvanced",
        [-900, 0],
        {
          capacity: EMBER_CAPACITY,
          seed: 13,
          attributes: "",
          group: "",
          kernel: EMBER_KERNEL,
          spawn: EMBER_SPAWN,
        },
        { label: "fire1" },
      ),

      // ---- ONE cloud, THREE readings, split on AGE (§V471.1) -------------------------
      /* The SPENT half, and the only one of the three that is COLD. It reads as the
         smoke a fire makes of itself: hot gas emits and cold ash scatters, so the top of
         the frame is what is LEFT of the bottom of it. Large and very dim — the job is
         tone, not shape. The bands overlap between 0.22 and 0.34 rather than butting up
         against each other, because a seam in a group predicate is a visible line. */
      node(
        "bed",
        "renderPoints",
        [-560, -280],
        {
          count: EMBER_CAPACITY,
          sizePixels: 3,
          color: [0.11, 0.17, 0.3, 1],
          blend: "additive",
          accumulate: false,
          group: "p.velocity.z < 0.34",
        },
        { label: "bed1" },
      ),
      /* The kernel wrote heat into velocity.z (§V471.2), so this predicate reads "only
         where the fire is still burning" — a selection on AGE, not on position. */
      node(
        "body",
        "renderPoints",
        [-560, 0],
        {
          count: EMBER_CAPACITY,
          sizePixels: 2,
          color: [1, 0.42, 0.08, 1],
          blend: "additive",
          accumulate: false,
          group: "p.velocity.z > 0.22",
        },
        { label: "body1" },
      ),
      /* The newest few percent only. Smallest and brightest: a spark is a POINT of light,
         and a big bright sprite is a blob. */
      node(
        "spark",
        "renderPoints",
        [-560, 280],
        {
          count: EMBER_CAPACITY,
          sizePixels: 1.4,
          color: [1, 0.95, 0.84, 1],
          blend: "additive",
          accumulate: false,
          group: "p.velocity.z > 0.62",
        },
        { label: "spark1" },
      ),

      node("stack", "add", [-240, -140], {}, { label: "stack1" }),
      node("fuse", "add", [40, 0], {}, { label: "fuse1" }),

      // ---- the post, one job per stage (§V471.4) -------------------------------------
      node("halo", "blur", [320, -280], { size: 30, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node(
        "haloLvl",
        "level",
        [600, -280],
        { blacklevel: 0.01, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1, brightness: 1.4 },
        { label: "halolvl1" },
      ),
      node("burn", "add", [880, 0], {}, { label: "burn1" }),
      /* The trail closes on the FINAL output (§V471.5), so what smears is the picture
         with its glow already on it. `screen` rather than `add` on purpose: the loop is
         where a mistake compounds sixty times a second (§V481), and screen saturates
         where add runs away. Nothing raises contrast inside the loop, and the persistence
         is a constant — an embered streak, not an accumulator. */
      node(
        "loop",
        "feedback",
        [880, 280],
        { source: "ash1", clearColor: [0, 0, 0, 1], reset: false, substeps: 1, persistence: 0.62 },
        { label: "loop1" },
      ),
      node("mix", "screen", [1160, 0], {}, { label: "mix1" }),
      node("ash", "null", [1440, 0], {}, { label: "ash1" }),
      node("out", "output", [1720, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-sim-bed", ["sim", "out"], ["bed", "points"]),
      edge("e-sim-body", ["sim", "out"], ["body", "points"]),
      edge("e-sim-spark", ["sim", "out"], ["spark", "points"]),

      edge("e-bed-stack", ["bed", "out"], ["stack", "in1"]),
      edge("e-body-stack", ["body", "out"], ["stack", "in2"], 0),
      edge("e-stack-fuse", ["stack", "out"], ["fuse", "in1"]),
      edge("e-spark-fuse", ["spark", "out"], ["fuse", "in2"], 0),

      edge("e-fuse-halo", ["fuse", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-fuse-burn", ["fuse", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),

      edge("e-burn-mix", ["burn", "out"], ["mix", "in1"]),
      edge("e-loop-mix", ["loop", "out"], ["mix", "in2"], 0),
      edge("e-mix-ash", ["mix", "out"], ["ash", "in"]),
      edge("e-ash-out", ["ash", "out"], ["out", "input"]),
    ],
  ),
);
