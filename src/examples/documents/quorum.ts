import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E54 — Quorum (T1070, REWORKED T1138). THREE SLIME MOLDS AND ONE PIECE OF GROUND.
 *
 *   mesh1(pointKernel, 3000 agents) ─┬─► sow1(renderPoints, 288x288) ─► mix1 ─┐
 *          ▲                         │                                        │
 *          │                         └─► bound1(pointRange, the drawn half) ─┬─► web1 ─► links1 ─► webs1 ─► thread1
 *          │                                                                 ├─► dots1 ──────────┐
 *          │                                                                 └─► frontdots1 ─────┴─► nodes1 ─┬─► white1
 *          └── mesh1.field ◄── spread1(blur) ◄── trail1(feedback ◄── mix1 BY NAME)                            └─► haze1 ─► pool1 ◄ neb1 ─► bed1
 *   white1, thread1, bed1 ─► sum1 ─► glow1 ─► lit1 ─► mask1 ◄ iris1 ─► paint1 ─► out1
 *
 * ## The one idea, in two halves that had to be argued into the same file
 *
 * THE MOTION IS A TRAIL SYSTEM. Agents DEPOSIT into a trail field, SENSE it a little way
 * ahead, STEER up the gradient, and the field DECAYS. That is Physarum, and the whole point
 * of choosing it is that IT HAS NO FIXED POINT TO FALL INTO. Corridors form because a path
 * that gets walked gets stronger; they die because a path that stops being walked fades; and
 * both happen at once, forever, because the same agents that thicken one corridor are
 * abandoning another. Nothing here settles, and nothing here has to be shoved to stop it.
 *
 * THE PICTURE IS NODES AND A WEB, which is the half the former operator got right and the
 * first cut of this rework threw away. `web1` is `pointProximity {neighbors: 6}` and
 * `links1` draws every link, so what is on screen is DISCRETE UNITS WITH VISIBLE
 * RELATIONSHIPS between them — and because the units are actually going somewhere, the web
 * genuinely forms and breaks instead of converging. The first cut drew the trail field
 * itself and the owner named exactly what that costs: *"we don't see these networks that
 * are disintegrating and integrating — the different units are like tiny specks now."* He
 * was right; a trail rendered as its own agents has no relationships in it to watch.
 *
 * ⚑ AND THE TWO HALVES WANT OPPOSITE POPULATIONS, WHICH IS THE FINDING THIS FILE COST.
 * A trail system wants MANY agents — below about a thousand the field stops being a medium
 * they can find each other through, and each army collapses to a single thread. A drawn k-NN
 * web wants FEW: agents on a trail sit far closer to each other ALONG it than the corridors
 * sit apart, so all six of a point's nearest are its own immediate line-neighbours and the
 * web renders as a BEAD CHAIN rather than a network. Rendered at 3000, 2400, 900, 600, 420
 * and 250 agents and the two failures meet in the middle: there is no count that is both.
 * So the scales are SEPARATED rather than averaged — three thousand agents deposit and
 * steer, and `bound1` parks all but the half with the lowest `sense.z` (a fixed per-agent
 * draw, so the sample never changes and a node cannot flicker in and out of the picture)
 * before the web is computed. Sampling lifts the spacing between drawn nodes enough that a
 * link reaches ACROSS to the next corridor instead of down its own.
 *
 * THREE ARMIES SHARE ONE FIELD AND GET A CHANNEL EACH — red, green, blue. An agent is drawn
 * to its own channel and pushed away from the other two, and how hard it is pushed is
 * `Envoy`, the phrase knob. So colour is not something an operator has to resolve out of
 * noise: colour IS the channel, territory is where a channel dominates, and two armies
 * merging their ground is simply two channels overlapping. They can merge, split and take
 * ground off each other without any of it costing the palette anything. The nodes go
 * near-white and the armies' colours reach the frame through the HAZE, which is where the
 * former file put them too.
 *
 * ## ⚑ WHAT THIS FILE USED TO BE, AND WHY NINE SESSIONS COULD NOT FIX IT
 *
 * Until T1138 the operator here was A GRAPH LAPLACIAN: one O(N²) loop over 480 points that
 * accumulated a positional pull and a colour average under the same edge weight, so the
 * clusters and their colours were one matrix read twice. It is a good idea and the file
 * proved it. It is also, exactly, GRADIENT DESCENT ON A FIXED ENERGY — so SETTLING WAS NOT
 * ITS BUG, IT WAS ITS PURPOSE. The owner asked nine times for it to keep doing what it does
 * in the first few frames; that is the descent, and asking a minimiser not to find its
 * minimum is not a tuning problem.
 *
 * Everything that was measured against the former operator follows from that one property,
 * and all of it is kept here because it is the reason not to try any of it again:
 *
 *   §V900 — FOUR RESOLVED HUES REQUIRE THE OPERATOR TO BE BLOCK-DIAGONAL, AND A
 *   BLOCK-DIAGONAL OPERATOR HAS NO BOUNDARY. `Contrast` was that ratio with a knob on it,
 *   and sweeping it moved the two requirements MONOTONICALLY IN OPPOSITE DIRECTIONS WITH NO
 *   OVERLAPPING WINDOW: at contrast 18, frontier 0 links, churn 0 of 350, palette margins
 *   +0.158 / +0.394 / +0.153 / +0.387; at 3, frontier 22 and churn STILL 0; at 1, where
 *   membership finally moved, frontier 165 and churn 57 of 350 — and all four margins
 *   negative by then, −0.196 to −0.199. A partition legible AS COLOUR is a partition whose
 *   blocks do not talk, and reorganisation is blocks talking.
 *
 *   T1074 — BOTH GRAPHS WERE FRONTIER-FREE, for mirror-image reasons. The dense field
 *   because every point saw every colony; the drawn six-nearest web because NO point saw
 *   any other colony (0 of 2100 cross-community links at every frame from 900 to 3600, with
 *   the radius cap removed). Label propagation over it was measured five ways: four settle
 *   or monopolise, and the fifth — the only one that genuinely sustains — renders as a
 *   RAINBOW-CONFETTI ANNULUS with all four palette margins negative.
 *
 *   T1079 — THE RING IS THE OPERATOR'S OWN GEOMETRY. A background tie identical for every
 *   pair, plus a Coulomb push, plus a recentre on the centroid, puts equal clusters on a
 *   sphere with the unaffiliated filling the middle — measured the same distance from the
 *   centroid across five repulsions spanning 16x and across four and eight communities.
 *   Reachable by neither the partition nor the knobs.
 *
 *   T1113/T1119/T1127 — the DISTURBANCE worked and could not be seen: it took the drawn web
 *   from 0 cross-community links to 80–95 and back to exactly 0, on a lane that fired three
 *   times a minute with a 29-second hole in it (§V903), while `Coupling` sat clamp-pinned at
 *   0.950000 from f989 to f2979. Both lanes were re-ranged; the file got faster and the
 *   centre stayed empty.
 *
 *   T1133 — AND THE CENTRE WAS EMPTY BECAUSE NOTHING WAS EVER AIMED THROUGH IT. The dust is
 *   a fluid and not a wall (a driven colony crosses the middle at +38 frames and the dust
 *   parts and closes behind it); the shipped pairing's meeting midpoint sat at 71 % of the
 *   shell radius, so the strike was TANGENTIAL. Every aim that opens the middle costs
 *   something: the cheap ones do not change the picture at all (§V912 — one carries 378
 *   cross links against 104 and is VISUALLY INDISTINGUISHABLE), and the only one that empties
 *   the middle and still rests costs 30.5 % of the whole-minute motion (§V913).
 *
 * Nine measurements, one property. §V900 stops binding on this file because THERE IS NO
 * BLOCK-DIAGONAL OPERATOR ANY MORE — and what is deliberately given up with it is stated
 * plainly below.
 *
 * ## What is AUTHORED and what EMERGES
 *
 * AUTHORED: the armies, and nothing else. `foundingOf` is a stochastic block model keyed on
 * IDENTITY alone, deliberately lopsided (§V854): 42 / 34 / 24 % of the population. Which
 * army an agent belongs to never changes.
 *
 * EMERGES: every corridor, every junction, every loop, where the fronts run, which army
 * holds which ground, and how long any of it lasts. None of that is anywhere in this file.
 * Measured: THE POPULATION IS 42/34/24 AND THE TERRITORY IS NEAR-EQUAL — 37/34/29, 30/36/34,
 * 38/32/31, 31/34/35 at frames 900, 1800, 2700 and 3600, with the lead changing hands three
 * times over the minute. The small army holds proportionally more ground per agent, because
 * a trail SATURATES and a crowded one wastes itself on scent that is already there.
 *
 * ⚠ AND WHAT IS DELIBERATELY LOST, said out loud because the previous thesis was good. THE
 * CROSS-SEED COMMUNITY CLAIM IS GONE: there is no operator resolving hues out of a seed
 * field any more, so "change Seed and the same communities condense somewhere else wearing
 * the same colours" is not a sentence this file can say. Colour is now assigned, not found.
 * That is a smaller claim about colour bought for a much larger one about motion, and the
 * trade is the point rather than a regression.
 *
 * ⚠ AND MEMBERSHIP IS FIXED. A converting agent — allegiance as a vector on the simplex,
 * pulled toward whatever trail it stands in and back toward its founding army — was built
 * and measured, and it is cut. Two reasons: with conversion the deposit is a MIXTURE, so
 * every trail goes grey-rainbow and the three armies stop being legible at all; and the
 * balance between converting and returning is exactly the winner-take-all knife-edge T1074
 * and T1119 both fell off. Territory is what the armies take from each other here, and
 * territory turns over completely every two seconds, which is what the lag profile below is.
 *
 * ## THE LOAD-BEARING CLAIM: IT DOES NOT SETTLE, AND HERE IS THE SHAPE OF IT
 *
 * A churn number cannot tell reorganisation from flicker — T1074 shipped a candidate that
 * looked sustained and whose lag profile said 2-CYCLE (12–15 flips at every odd lag, exactly
 * 0 at +2, +4, +8, +16). So the claim is a LAG PROFILE, over TERRITORY: of the texels the
 * trail holds in both frames, how many changed hands. Measured on Dawn from three base
 * frames twenty seconds apart, out to the 3600-frame horizon:
 *
 *   lag       +1    +2    +4    +8   +16   +32   +60  +120  +240  +480  +960
 *   f600     1.7   3.3   6.2  10.8  17.3  22.0  40.3  54.7  67.0  63.6  65.5  %
 *   f1800    1.9   3.7   7.0  13.4  20.8  26.5  33.8  43.2  57.2  67.2  68.5  %
 *   f3000    1.3   2.6   5.2   8.7  11.7  15.5  21.0  28.0  37.8  54.5  47.3  %
 *
 * MONOTONE from +1 to +240 at every base, with no odd/even alternation anywhere — which is
 * the one shape that separates the three things a churn number cannot tell apart: settled
 * (every entry near zero), a 2-cycle (odd lags flicker, EVEN lags read exactly zero), and
 * reorganisation. And the plateau is not an arbitrary number: the territory shares run
 * around 31/34/35 %, so 1 − Σpᵢ² ≈ 0.66, and by four seconds ownership is STATISTICALLY
 * INDEPENDENT of ownership now. Past +240 the profile stops climbing and wanders around that
 * ceiling — it cannot exceed independence — so the tail is asserted as "still decorrelated"
 * rather than as more monotonicity. The former operator's own number, for scale, is 0 of 350
 * membership changes at every lag from f180 to f3600.
 *
 * ## The motion, BOTH numbers (§V905/§V913)
 *
 * §V885's `motion` row samples frames 60–180 and cannot see anything a drive lane does
 * afterwards — it once read −0.3 % on a change that lost 30.5 % of the whole minute. So both
 * are recorded here, and both moved the same way:
 *
 *   row window f60→f180                       0.02956 → 0.05087   (+72.1 %)
 *   whole minute, 29 windows of 120 frames    0.03706 → 0.06468   (+74.5 %)
 *
 * They agree to within three points, which is the point of printing both: §V913's defect is
 * a row that moves one way while the file moves the other, and this is what it looks like
 * when that does not happen. The honest way to read the second: the reworked file's QUIETEST
 * two seconds (0.04884) moves 32 % more than the former file's WHOLE-MINUTE MEAN, and 2.3x
 * its quietest (0.02160). Measured on Dawn, both files loaded from their own shipped bytes
 * in one process — the former out of `git show HEAD`, so "before" is bytes rather than a
 * reconstruction.
 *
 * ## How an agent works, in six lines and one texture
 *
 * Three sensors — ahead, and `Sense Angle` either side at `Sense Distance` — each reading
 * the trail through `fieldAt`, which is a `textureLoad` with the same mapping the renderer
 * splats with, so the agents, the picture and the simulation share ONE coordinate system
 * (T477/T512). The score at a sensor is the trail dotted with what this agent WANTS: its own
 * channel at 1, the other two at `Envoy`. Turn a fixed amount toward the better side — E32
 * measured why this is not a proportional controller, and the sentence holds here too: a
 * gain small enough not to spin a saturated agent is too small to turn it onto a ten-pixel
 * feature before it has walked past. Then walk. That is the whole kernel.
 *
 * AND IT IS CHEAPER THAN WHAT IT REPLACED. The former kernel was 480 points and 230 000 PAIR
 * evaluations a frame; this is 3000 agents and 12 000 texture loads, plus Proximity's own
 * brute-force scan over the parked half. Measured in one process at the §V885 probe
 * resolution, 3601 frames: 6.9 s for the former file against 5.6 s for this one. At the full
 * 1280x720 it renders 3601 frames in 20.9 s — 5.8 ms a frame, with two scene passes, a
 * 288x288 trail loop and a 3000-point proximity scan in each of them.
 *
 * ## Deposit, decay, diffuse — and why the loop is legal
 *
 * `sow1` splats every agent into a 288x288 trail grid in its own army's colour, in ALPHA and
 * not additive: a trail answers "is this path walked", which is bounded, and additive a
 * dozen agents standing together leave a dozen times the scent — a saturated texel has NO
 * GRADIENT left for the three sensors to answer. `trail1` is the Feedback node, which is
 * what makes the cycle a legal DAG: it names `mix1` as its source rather than being wired
 * from it (T350), so the back edge does not exist in `edges` and every agent smells LAST
 * frame's field. `spread1` is the diffusion, and `persistence` is the decay — deliberately
 * SHORT, for a reason measured at its own line.
 *
 * ## ONE CLOUD, FOUR READINGS (§V471.1)
 *
 * `sow1` is the SIMULATION and is never seen. `dots1` is the drawn half as nodes, sized by
 * `sense.w` — how deep the trail under each agent is, which is this system's answer to the
 * former operator's weighted degree. `links1` is the web over exactly the same half, at
 * exactly the radius the kernel senses at (§V349), so the picture cannot show a relationship
 * the simulation is not using. And `frontdots1` is the caste on CONTESTED ground — agents
 * where less than 55 % of the trail underneath is their own army's. §V912's lesson was that
 * a frontier COUNT can rise 3.6x with the picture visually identical; a frontier that is
 * drawn as pixels cannot.
 *
 * ## The instrument (§V471 — this is a VJ file, not a plate)
 *
 * The phrase is `Envoy`. `cstep1` holds a value for four bars, `clag1` eases it in, and the
 * lane lands 83.3 % of its draws in the limiter's interior (§V903 — the number stated as a
 * DUTY CYCLE, because the version of this file that stated it as a RANGE spent thirty-three
 * continuous seconds pinned at maximum). At the floor (−0.55) each army keeps hard to its
 * own network; at the ceiling (−0.05) the fronts interpenetrate. Measured on Dawn against
 * the shipped bytes with the lane detached and pinned at each bound, at f900/1800/2700/3600:
 * the floor holds 59.0k–63.1k live trail texels of which 19.5–33.6 % are contested; the
 * ceiling holds 46.2k–50.6k of which 12.3–17.0 %. HALF AGAIN TO TWICE THE FRONT, AND A
 * QUARTER MORE TRAIL, on one knob.
 *
 * The two-bar step is the DEPOSIT — how much scent a footfall leaves — also at 83.3 %
 * interior. On the beat, the high band drives `Sense Distance`, which is ALSO the web's
 * radius, so a hit both lengthens the agents' reach and thickens the drawn network: the
 * connection density is the music made visible, exactly the use Proximity's own docblock
 * argues for. Nothing else runs on a free clock but the hue, which turns once every 80 s.
 *
 * ⚑ AND NEITHER LANE HAS A SILENT STATE, which is new and is the point. The former file's
 * disturbance was a GATE — clamped to zero on most draws — so its longest silent run was a
 * dead file, and an owner watching for thirty seconds was right to say so. A trail system
 * needs no event to be alive: both ends of both lanes are pictures, so the worst case here
 * is a different picture rather than no picture.
 *
 * Four knobs are left bare for a hand and each range goes somewhere: Envoy toward 0 → the
 * armies stop avoiding each other, share corridors and the field thins; Sense Distance small
 * → a fine mesh of short links, large → a few thick trunks and long ones; Turn small →
 * agents cannot lock onto a corridor at all; Wander large → the network never consolidates.
 */

const QUORUM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "heading", type: "vec3f", qualifier: "direction", default: [1, 0, 0] },
  { name: "banner", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 0, 0, 1] },
  { name: "sense", type: "vec4f", default: [0, 0, 0, 0.3] },
]);

/*
 * SEMANTICS OF THE SCHEMA, because three of these four are read by nodes that are not this
 * kernel (§V471.2 — the kernel WRITES data for downstream selection):
 *
 *   position  clip space, z unused. `sow1` and `dots1` splat at `position.xy` and `fieldAt`
 *             maps the same xy to the field's texels, so one coordinate system spans the
 *             agents, the picture and the simulation (T477/T512).
 *   heading   the unit direction. No inertia — an agent turns and walks.
 *   banner    the army, as a ONE-HOT RGB. It is the deposit colour (`sow1` maps it) and the
 *             agent's own colour (`dots1` maps it), which is why the two can never disagree.
 *   sense.x   how deep the trail under this agent is.
 *   sense.y   how much of that trail is SOMEBODY ELSE'S — `front1` draws these.
 *   sense.w   the agent's own sprite size, so `dots1` maps a per-point size (T286) rather
 *             than taking one number for the whole layer.
 */
const QUORUM_KERNEL = `struct Params {
  speed: f32,      // World units a second an agent walks. Everything else is a turn; this is the only length it travels.
  senseDist: f32,  // How far ahead the three sensors reach — AND the radius the drawn web uses. One number (§V349).
  senseAngle: f32, // Half-angle between the outer two sensors and the middle one.
  turn: f32,       // Radians a second an agent turns toward the better sensor. A FIXED turn, not a gain.
  envoy: f32,      // Weight on the OTHER armies' trail. Negative keeps each to its own network; toward zero the fronts interpenetrate.
  wander: f32,     // Random turn, radians a second — the disorder that stops the network consolidating and stopping.
}

/* ⚑ ONE SPACE, AND IT IS ISOTROPIC END TO END — WHICH IS WHY THE TRAIL GRID IS SQUARE.
   position is WORLD; the camera below is ORTHOGRAPHIC, so a circle in these coordinates is a
   circle on screen and a step is the same length whichever way it points, with no aspect
   constant anywhere in the motion. fieldAt maps x and y each from [-1, 1] onto the wired
   texture, so a 16:9 trail grid would make a world unit 1.78x more texels across than up:
   the three sensors would reach further sideways than forwards-and-back, and the trails
   would BEND TOWARD THE VERTICAL. That was built and rendered before it was understood —
   the whole population strung itself into near-vertical streaks in a narrow band. A SQUARE
   grid removes the constant instead of compensating for it in six places. */

fn idHash(id: u32, salt: u32) -> u32 {
  var h = (id * 2654435761u) ^ (salt * 2246822519u);
  h = (h ^ (h >> 15u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return h ^ (h >> 16u);
}

fn idRand(id: u32, salt: u32) -> f32 {
  return f32(idHash(id, salt)) * (1.0 / 4294967296.0);
}

/* THE ARMIES — the one authored thing in this document, and still a stochastic block model
   keyed on identity alone, deliberately asymmetric (§V854): 42 / 34 / 24 %. Three and not
   four because there are three channels to hold them: an army IS a channel here, so the
   colour cannot fail to resolve and the count is not a style choice either.

   Written with idHash rather than reached for through pointRand because this draw must NOT
   move: pointRand keys on the frame and on this node's Seed as well as on the point (§V74),
   which is right for per-frame randomness and wrong for a fact about an agent that has to be
   identical on frame 0 and frame 4000, at every seed, on every device. */
fn foundingOf(id: u32) -> vec3f {
  let r = idRand(id, 101u);
  if (r < 0.42) { return vec3f(1.0, 0.0, 0.0); }
  if (r < 0.76) { return vec3f(0.0, 1.0, 0.0); }
  return vec3f(0.0, 0.0, 1.0);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T510: firstRun is 1u on exactly the dispatches whose storage was just created or
     cleared — the seeding signal, and the only honest one (frameIndex == 0 is a timeline lap,
     not a fresh buffer). */
  if (ctx.firstRun == 1u) {
    /* THE THREE ARMIES START APART, each in its own disc on a ring, so the opening of the
       piece is three colonies growing networks TOWARD each other and the first thing on
       screen is the meeting. sqrt() on the radius makes each disc uniform rather than
       centre-heavy. */
    let home = foundingOf(ctx.index);
    let slot = home.g * 2.0943951 + home.b * 4.1887902;
    let seat = vec2f(cos(slot + 1.5707963), sin(slot + 1.5707963)) * 0.52;
    let a = pointRand(ctx.index, 37u) * 6.2831853;
    let rr = sqrt(pointRand(ctx.index, 11u)) * 0.30;
    let h = pointRand(ctx.index, 23u) * 6.2831853;
    q.position = vec3f(seat + vec2f(cos(a), sin(a)) * rr, 0.0);
    q.heading = vec3f(cos(h), sin(h), 0.0);
    q.banner = vec4f(home, 1.0);
    q.sense = vec4f(0.0, 0.0, idRand(ctx.index, 77u), 0.45);
    return q;
  }

  let pos = q.position.xy;
  let dir = normalize(select(vec2f(1.0, 0.0), q.heading.xy, dot(q.heading.xy, q.heading.xy) > 1.0e-8));
  let nrm = vec2f(-dir.y, dir.x);

  /* WHAT THIS AGENT WANTS TO SMELL, and it is the whole interaction between the armies in
     one line. Its own channel at 1; the other two at envoy, which is SIGNED. Negative and an
     army is repelled by foreign scent, so it holds its own network and a front forms where
     two of them press; toward zero the fronts interpenetrate. POSITIVE WAS MEASURED AND IS
     NOT IN THE SHIPPED RANGE: at +0.35 every army follows every other, the three networks
     fuse into one rainbow cable, and the field empties — a real fixed point, in the one file
     that is here not to have one. */
  let want = q.banner.rgb + (vec3f(1.0) - q.banner.rgb) * ctx.params.envoy;

  let sway = ctx.params.senseAngle;
  let reach = ctx.params.senseDist;
  let lDir = dir * cos(sway) + nrm * sin(sway);
  let rDir = dir * cos(sway) - nrm * sin(sway);
  let ahead = dot(fieldAt(vec3f(pos + dir * reach, 0.0)).rgb, want);
  let left = dot(fieldAt(vec3f(pos + lDir * reach, 0.0)).rgb, want);
  let right = dot(fieldAt(vec3f(pos + rDir * reach, 0.0)).rgb, want);

  /* A FIXED TURN TOWARD THE BETTER SIDE — Physarum's own rule, and NOT a proportional
     controller on (left - right)/total: a gain small enough that a saturated sensor does not
     spin the agent is also too small to turn it onto a feature ten pixels wide before it has
     walked past. E32 measured that over six builds; it is the same arithmetic here. The
     epsilon is the other half — on bare field all three sensors read zero, the comparison is
     meaningless, and an agent that turns on noise never travels anywhere. */
  var steer = 0.0;
  if (max(left, right) > ahead + 1.0e-5) {
    steer = select(-ctx.params.turn, ctx.params.turn, left > right);
  }
  /* THE DISORDER, and it is load-bearing rather than a garnish. Without it the network
     consolidates onto fewer and fewer trunks and never invents a new one; this is what keeps
     agents leaving good corridors, which is what keeps corridors being abandoned. */
  steer += (pointRand(ctx.index, 5u) - 0.5) * ctx.params.wander;

  /* THE ONLY FENCE, and it is a TURN and not a spring. A spring has a fixed point, and a
     population sitting on its own fixed point is the thing this whole rework exists to stop
     (E32 measured the same failure from the other side: a fixed roost eats one spot to the
     ground and stays there).

     AND IT IS A FIXED TURN RATHER THAN ONE PROPORTIONAL TO THE SINE OF THE BEARING, which is
     a real bug and not a nicety: an agent heading STRAIGHT out has sine zero, so a
     proportional rim applies no torque at all to precisely the agent that is leaving.
     Measured — with the proportional form the whole population slid into the bottom-right
     corner and packed against the hard clamp by frame 1800. */
  let away = length(pos);
  let sinMid = (dir.y * pos.x - dir.x * pos.y) / max(away, 1.0e-5);
  let side = select(-1.0, 1.0, sinMid >= 0.0);
  steer += side * ctx.params.turn * 1.6 * smoothstep(0.86, 1.05, away);

  let ang = atan2(dir.y, dir.x) + steer * ctx.delta;
  let walk = vec2f(cos(ang), sin(ang));
  /* A hard clamp, not a mechanism — the rim turn above is what actually holds the field.
     Anything that reaches this has been pushed by the wander on the far side of the frame. */
  let nextPos = clamp(pos + walk * ctx.params.speed * ctx.delta, vec2f(-1.08), vec2f(1.08));

  /* WHAT THE AGENT KNOWS ABOUT ITSELF, and the picture reads all of it (§V471.2).

     MEMBERSHIP DOES NOT CHANGE. banner is written once, at firstRun, and never touched: an
     agent deposits its founding army's channel for its whole life, so a trail is ONE clean
     colour and territory is the only thing the armies can take off each other. A converting
     agent - allegiance on the simplex - was built and cut, for the two reasons in the
     docblock. */
  let here = fieldAt(vec3f(nextPos, 0.0)).rgb;
  let total = here.r + here.g + here.b;
  let depth = clamp(total * 0.5, 0.0, 1.0);
  let own = dot(here, q.banner.rgb) / max(total, 1.0e-5);

  q.heading = vec3f(walk, 0.0);
  q.position = vec3f(nextPos, 0.0);
  /* x = how deep the trail under this agent is, y = how much of it belongs to SOMEBODY ELSE
     (the contest, and the caste the front layer draws), z = spare, w = THE NODE'S DRAWN SIZE,
     which dots1 maps: an agent standing on a trunk draws as a hub and one out in the open
     draws small. This is the trail system's answer to the former operator's weighted degree,
     and it is measured in the same loop that steers. */
  q.sense = vec4f(depth, 1.0 - own, idRand(ctx.index, 77u), 0.45 + 1.15 * depth);
  return q;
}`;

const AGENTS = 3000;
/* The fraction of the population the PICTURE draws — see `bound1`. */
const DRAWN_SHARE = 0.5;

export const quorumDocument = document(
  "e54-quorum",
  "E54 Quorum",
  settings({ randomSeed: 54 }),
  graph(
    [
      // ---- the clock, and the three drives ------------------------------------------
      /* E45's clock seam: every lane reads `clock1`, never `beat1`, so the tempo source is
         one node to exchange for a real track's analysis. At index 0 it is the deterministic
         pattern, which is what ships (§V44/§V45 — no device on load). */
      node("beat", "audioPattern", [-2560, 700], { bpm: 116, amount: 1 }, { label: "beat1" }),
      node("clock", "valueSwitch", [-2260, 700], { index: 0 }, { label: "clock1" }),
      /* HIGH band -> how far ahead the agents look. Rest subtracted first (T701), then one
         envelope so the network breathes on strikes rather than flickering on every analyser
         frame (T824). 0.038 clip at rest is a 7-pixel sensor and a fine mesh; 0.073 on a hit
         is 13 pixels and a few thick trunks. */
      node("hsub", "valueMath", [-1960, 700], { operation: "add", operand: -0.381 }, { label: "hsub1" }),
      node("henv", "valueLag", [-1660, 700], { lag: 0.04, releaseRatio: 8 }, { label: "henv1" }),
      node("rgain", "valueMath", [-1360, 700], { operation: "multiply", operand: 0.10 }, { label: "rgain1" }),
      node("reach", "valueMath", [-1060, 700], { operation: "add", operand: 0.20 }, { label: "reach1" }),
      /* THE PHRASE, on `Envoy`: how hard each army is pushed off the other two's scent, held
         four bars and eased in so a change of régime is a swell and not a snap.

         ⚑ §V903 — STATED AS A DUTY CYCLE AND NOT A RANGE, because the version of this file
         that stated it as a range spent thirty-three continuous seconds pinned at maximum and
         read as dead. `0.60·r − 0.60` spans [−0.600, 0.000] into a clamp [−0.55, −0.05] that
         is 0.500 wide — 1.20 clamp-widths, so 83.3 % of draws land in the interior and the
         8.3 % on each bound are symmetric. AND NEITHER BOUND IS SILENCE: the floor is three
         hard-edged networks and the ceiling is three interpenetrating ones, so the worst case
         this lane can produce is a different picture rather than no picture. That is the part
         the former file could not say. */
      node("cstep", "valueStep", [-1960, 940], { every: 4, minimum: 0, maximum: 1, seed: 330 }, { label: "cstep1" }),
      node("cmul", "valueMath", [-1660, 940], { operation: "multiply", operand: 0.6 }, { label: "cmul1" }),
      node("csub", "valueMath", [-1360, 940], { operation: "add", operand: -0.6 }, { label: "csub1" }),
      node("clim", "valueLimit", [-1060, 940], { minimum: -0.55, maximum: -0.05 }, { label: "clim1" }),
      node("clag", "valueLag", [-760, 940], { lag: 0.9, releaseRatio: 3 }, { label: "clag1" }),
      /* THE DEPOSIT LANE, two bars against the phrase's four so the two never line up: how
         much scent a footfall leaves, which is the balance against `trail1`'s decay and so
         how bold the network draws. [0.395, 0.875] into a clamp [0.44, 0.84] is the same 1.20
         clamp-widths and the same 83.3 % interior. It gets its own step rather than reading
         `cstep1` because a threshold on the phrase's draw would fire in step with the phrase
         instead of across it. */
      node("dstep", "valueStep", [-1360, 1420], { every: 2, minimum: 0.395, maximum: 0.875, seed: 82 }, { label: "dstep1" }),
      node("dlim", "valueLimit", [-1060, 1420], { minimum: 0.44, maximum: 0.84 }, { label: "dlim1" }),
      node("dlag", "valueLag", [-760, 1420], { lag: 0.7, releaseRatio: 2 }, { label: "dlag1" }),
      /* The only free-running clock in the file, and it turns once every 80 seconds. */
      node("hue", "lfo", [-1960, 1180], { shape: "sine", frequency: 0.0125, amplitude: 150, offset: 0, phase: 0 }, { label: "hue1" }),

      // ---- the agents ----------------------------------------------------------------
      /* 120 000 agents, and the count is a density rather than a flourish: one agent per two
         trail texels is what makes a corridor get re-walked often enough to survive its own
         decay. The kernel is O(N) with four texture loads each, so this is CHEAPER per frame
         than the 480-point O(N²) operator it replaces was at 230 000 pair evaluations. */
      node("mesh", "pointKernel", [-1960, -320], {
        capacity: AGENTS,
        seed: 54,
        group: "",
        attributes: QUORUM_ATTRIBUTES,
        kernel: QUORUM_KERNEL,
        speed: 0.4,
        senseAngle: 0.42,
        turn: 25,
        wander: 2,
      }, {
        label: "mesh1",
        parameters: {
          senseDist: drivenSlot("reach1:high", 0.24),
          envoy: drivenSlot("clag1:bar", -0.3),
        },
      }),

      // ---- the trail field: the SIMULATION, and nothing you can see ------------------
      /* THE DEPOSIT. Every agent, no predicate, in its OWN army's colour — `banner` is a
         one-hot RGB so a footfall lands on exactly one channel and a trail is never a
         mixture. Drawn into the simulation's own 320x180 grid rather than the frame's
         (§V533: renderPoints is a project-policy node, so at the 192x108 look probe this
         would otherwise splat the whole population into a third of the grid the sim runs on).

         ⚑ THE FIELD IS NEVER SHOWN. It is a coupling medium: it exists so that an agent can
         smell where the others have been, and the PICTURE is the nodes and the web drawn over
         it. That is the split this file arrived at the hard way — the first build of this
         rework drew the trail directly and lost every readable relationship in it, which the
         owner named exactly: "the different units are like tiny specks now".

         ⚑ ALPHA AND NOT ADDITIVE, and this is the one blend decision here that is not taste.
         A trail answers "is this path walked", which is BOUNDED — a dozen agents standing
         together cannot leave a dozen times the scent. Additive they do, and the consequence
         is mechanical rather than cosmetic: a saturated texel has NO GRADIENT, so the three
         sensors of every agent crossing a busy trunk read the same number and the steering
         rule has nothing left to answer. */
      node("sow", "renderPoints", [-1360, 120], {
        count: AGENTS, blend: "alpha", accumulate: false,
        color: [1, 1, 1, 1], sizePixels: 5, group: "",
      }, {
        label: "sow1",
        resolution: { mode: "fixed", width: 288, height: 288 },
        parameters: {
          color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "banner" } } },
        },
      }),
      /* THE ONE-FRAME BOUNDARY, and what makes the cycle a legal graph. Feedback NAMES its
         source (T350) instead of being wired from it, so `edges` stays a DAG, the back edge
         shows as a dashed line, and every agent smells LAST frame's field — which is the same
         Jacobi reading the former operator's `pointAt` gave it, arrived at a different way.

         ⚑ AND `persistence` IS 0.72, WHICH IS SHORT FOR A PHYSARUM, DELIBERATELY AND
         MEASURED. At 0.85 and 0.95, across deposits from 0.02 to 0.22 and wander from 2 to
         25, every setting coarsens within a minute to a handful of thick cables: a corridor's
         pull is its traffic times its memory, so the busier corridor is proportionally
         stronger and nothing stops it taking the rest. Renders opened at each. The memory
         this file actually runs on is WHERE THE AGENTS ARE, which the lag profile measures in
         seconds; the field is the coupling medium, not the archive. */
      node("trail", "feedback", [-1660, 320], {
        source: "mix1", persistence: 0.72, clearColor: [0, 0, 0, 0], reset: false, substeps: 1,
      }, {
        label: "trail1",
        resolution: { mode: "fixed", width: 288, height: 288 },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      /* THE DIFFUSION, and the reason it is a real node: `fieldAt` is a textureLoad — NEAREST
         and unfiltered by construction (§V57) — so an undiffused splat field is a set of
         isolated texels and the difference between two adjacent sensor readings is mostly
         quantisation. Three pixels of blur is a gradient the three sensors can answer. */
      node("spread", "blur", [-1360, 320], { size: 4, filter: "gaussian", extend: "hold" }, {
        label: "spread1",
        resolution: { mode: "fixed", width: 288, height: 288 },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      /* THE DEPOSIT ENTERING THE FIELD, and the port order is load-bearing — see the edge
         list. Composite's opacity scales THE FRONT LAYER, which is `in1`, so the deposit has
         to be `in1` for `dlag1` to mean "how much scent a footfall leaves" rather than "how
         much of last frame the field keeps". */
      node("mix", "add", [-1060, 320], { opacity: 0.6 }, {
        label: "mix1",
        resolution: { mode: "fixed", width: 288, height: 288 },
        format: { mode: "fixed", format: "rgba16float" },
        parameters: { opacity: drivenSlot("dlag1:bar", 0.6) },
      }),

      // ---- the draw: NODES AND A WEB, which is what a network looks like --------------
      /* ⚑ ONE REACH, TWO CONSUMERS (§V349), AND HERE IT IS THE SAME SENTENCE TWICE OVER: the
         kernel's `senseDist` and `web1`'s Radius are THE SAME NUMBER, both reading `reach1`.
         So a drawn link is exactly a pair close enough for one to smell the other — the
         picture draws the agents' own sensing neighbourhood, and cannot show a relationship
         the simulation is not using.

         §T1074 measured this file's drawn 6-NN web as FRONTIER-FREE — 0 of 2100 cross-
         community links at every frame from 900 to 3600 — and that finding does not carry
         over, because it was a property of a SETTLED layout under an operator whose colonies
         sat eight times further apart than any point's sixth-nearest. These agents are never
         at rest and never that separated; the frontier is re-measured in the claims. */
      /* ⚑ THE PICTURE DRAWS A SAMPLE OF THE CROWD, AND THAT IS THE WHOLE RECONCILIATION
         BETWEEN THE TWO HALVES OF THIS FILE — measured, after several builds that could not
         have both.

         A trail system wants MANY agents: a corridor only survives if it is re-walked often
         enough to outrun its own decay, and below about a thousand agents the field stops
         being a medium they can find each other through. A drawn k-NN web wants FEW: agents
         on a trail sit far closer to each other ALONG it than the corridors sit apart, so
         every one of a point's six nearest is its own immediate line-neighbour and the web
         renders as a bead chain rather than a network. Rendered at 3000, 2400, 900, 600, 420
         and 250 agents, the two failures meet in the middle and there is no count that is
         both.

         So the two scales are separated instead of averaged: THREE THOUSAND agents deposit
         and steer, and the half with the lowest `sense.z` — a fixed per-agent
         draw, so the sample never changes and a node cannot flicker in and out of the
         picture — are the ones drawn and linked. Sampling multiplies the spacing between
         drawn nodes by about 1.4, which is what lifts a link off its own filament and lets
         the web reach ACROSS to the next one. §V788's park, not a compaction: the other half
         keep their slots and go on laying the trail the visible ones are walking. */
      node("bound", "pointRange", [-1660, 20], {
        attribute: "sense", component: "z", from: 0, to: DRAWN_SHARE, mode: "inside",
      }, { label: "bound1" }),
      node("web", "pointProximity", [-1660, -180], { neighbors: 6, falloff: 3 }, {
        label: "web1",
        parameters: { radius: drivenSlot("reach1:high", 0.24) },
      }),
      node("ink", "materialUnlit", [-1660, -560], { color: [1, 1, 1, 1] }, { label: "ink1" }),
      /* Beams, additive and soft: many filaments crossing one cluster must SUM into light
         rather than fight a depth buffer (T917). Taper 0 pinches each link at its origin so
         six links leaving one node do not fuse into a wedge. Proximity writes a WHITE tint
         whose alpha is the link's strength, so the web is pale by construction — the colour
         in this picture belongs to the nodes. */
      node("links", "geometry", [-1360, -180], {
        mode: "beam", endpoint: "tip", material: "ink1",
        scale: 0.0022, taper: 0, soft: 0.9, blend: "additive",
      }, {
        label: "links1",
        parameters: {
          /* Proximity's OWN `tint` — white with the link's strength in alpha — not the
             agents' `banner`: the link set is a different pointset and does not carry it,
             and the web is meant to be pale anyway. The colour belongs to the nodes. */
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      /* THE NODES. Scale in Map mode MULTIPLIES by `sense.w`, which the kernel wrote from the
         depth of the trail under each agent — so a node on a trunk draws as a hub and one out
         in the open draws small, and nothing here decides how big a hub is. That is the trail
         system's answer to the former operator's weighted degree. */
      node("dots", "geometry", [-1360, -440], {
        mode: "points", material: "ink1", soft: 0.75, blend: "additive", scale: 0.009,
      }, {
        label: "dots1",
        parameters: {
          scale: { mode: "map", bindings: { static: { kind: "static", value: 0.009 }, map: { kind: "map", attribute: "sense", channel: "w" } } },
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "banner" } } },
        },
      }),
      /* ⚑ THE FRONTIER, AS PIXELS. The caste is a predicate on a number the kernel wrote
         (§V471.2): agents where less than 55 % of the trail underneath is their own army's —
         which is exactly "standing on contested ground". Nine sessions measured this file's
         frontier as a COUNT over pairs and §V912 is what came of it: a count can rise 3.6x
         with the picture visually identical, because a pair sitting where the picture already
         had ink adds a number and no pixel. Drawn, it cannot. */
      node("frontdots", "geometry", [-1360, -700], {
        mode: "points", material: "ink1", soft: 0.6, blend: "additive", scale: 0.016,
        group: "p.sense.y > 0.45",
      }, { label: "frontdots1" }),
      /* ⚑ ORTHOGRAPHIC, AND THAT IS WHAT PUTS THE SIMULATION AND THE PICTURE IN ONE SPACE.
         With Ortho Height 2 a world unit is half the frame height in both axes, so the disc
         the kernel's rim fence holds the agents inside renders as a CIRCLE, and an agent's
         step is the same length on screen whichever way it points. A perspective camera would
         have made the two disagree by the perspective factor and nothing in the picture would
         have said so. */
      node("cam", "camera", [-1360, -940], {
        eye: [0, 0, 2], lookAt: [0, 0, 0], fov: 52, ortho: true, orthoHeight: 2.16,
      }, { label: "cam1" }),
      /* Two passes, one camera, each layer graded for its job — blurring ONE render that held
         both would smear the web's filaments over the coloured nodes and the bed would come
         out grey. */
      node("webs", "render", [-1060, -180], {
        scenes: "links1", camera: "cam1", lights: "", ambientIntensity: 0, background: [0, 0, 0, 1],
      }, { label: "webs1" }),
      node("nodes", "render", [-1060, -440], {
        scenes: "dots1 frontdots1", camera: "cam1", lights: "", ambientIntensity: 0, background: [0, 0, 0, 1],
      }, { label: "nodes1" }),

      // ---- the haze: a density field, not a decoration ------------------------------
      /* Blurring the NODES is the density of the nodes, so the haze pools where the network
         is dense because the network is dense there — and it carries each army's own colour
         because that is what was blurred. Nothing paints it. */
      node("haze", "blur", [-760, -440], { size: 44, filter: "gaussian", extend: "hold" }, { label: "haze1" }),
      /* §V880: perlin4d with a real time axis and an OFF-LATTICE t4d, so Speed is a control
         that does something. A 3d variant here would be a static poster wearing a clock. */
      node("neb", "noise", [-1060, 120], {
        type: "perlin4d", seed: 54, period: 0.42, harmon: 3, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1.4, amp: 1, offset: 0.4, mono: true, aspectcorrect: true,
        speed: 0.055, t4d: 0.41, s4d: 1,
      }, { label: "neb1" }),
      node("pool", "multiply", [-460, -300], {}, { label: "pool1" }),
      /* Lifted in saturation and pushed down in value: a haze reads as depth only while it
         stays below the thing it sits behind (§V471). */
      node("bed", "hsv", [-160, -300], { hueoffset: 0, saturation: 1.9, value: 0.42 }, { label: "bed1" }),
      /* The filaments, graded down so the web is structure rather than glare — a network
         reads its links as thread, not as light. */
      node("thread", "level", [-760, -120], { brightness: 0.42, gamma1: 1.3 }, { label: "thread1" }),
      /* THE NODES GO NEAR-WHITE AND THE COLOUR STAYS IN THE HAZE. It is one node in one
         place because of where it sits: `haze1` taps `nodes1` UPSTREAM of this, so the blur
         still sees fully saturated armies and the bed carries each army's own hue, while what
         lands on the FRONT of the frame is desaturated. Value is left at 1 and NOT lifted: in
         HSV, dropping saturation raises the two lower channels to meet the top one, so the
         nodes brighten on their own, and lifting value as well drove `range` and `f0max` to
         exactly 1.0000 — clipping, measured. */
      node("white", "hsv", [-460, -500], { hueoffset: 0, saturation: 0.3, value: 1 }, { label: "white1" }),

      // ---- assemble, glow, iris ------------------------------------------------------
      /* Front is the NODES; the filaments and the bed fold in behind, in that order. */
      node("sum", "add", [140, -300], {}, { label: "sum1" }),
      node("glow", "blur", [440, -140], { size: 16, filter: "gaussian", extend: "hold" }, { label: "glow1" }),
      node("lit", "add", [740, -300], { opacity: 0.45 }, { label: "lit1" }),
      /* The aperture the whole thing is observed through: a radial ramp, open in the middle
         and closed to black before the corners. */
      node("iris", "ramp", [440, 100], {
        type: "radial", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [1, 1, 1, 1] },
          { position: 0.58, color: [1, 1, 1, 1] },
          { position: 1, color: [0, 0, 0, 1] },
        ],
      }, { label: "iris1", definitionVersion: 2 }),
      node("mask", "multiply", [1040, -300], {}, { label: "mask1" }),
      /* The palette turn, last so it colours the whole frame at once. Hue rotation and NOT a
         lookup remap: §V784's lesson is that scrambling tonal ORDER kills a picture whose
         depth cue is ordering, and a hue turn preserves luminance exactly — and here it also
         preserves the RELATIONS, so the three armies stay three distinct hues and contested
         ground stays their mixture whatever the offset is. */
      node("paint", "hsv", [1340, -300], { saturation: 1.5, value: 1 }, {
        label: "paint1",
        parameters: { hueoffset: drivenSlot("hue1", 0) },
      }),
      node("out", "output", [1640, -300], {}, { label: "out1" }),
    ],
    [
      edge("e1", ["beat", "out"], ["clock", "in1"]),
      edge("e2", ["clock", "out"], ["hsub", "a"]),
      edge("e3", ["hsub", "out"], ["henv", "in"]),
      edge("e4", ["henv", "out"], ["rgain", "a"]),
      edge("e5", ["rgain", "out"], ["reach", "a"]),
      edge("e6", ["clock", "out"], ["cstep", "in"]),
      edge("e7", ["cstep", "out"], ["cmul", "a"]),
      edge("e8", ["cmul", "out"], ["csub", "a"]),
      edge("e9", ["csub", "out"], ["clim", "in"]),
      edge("e10", ["clim", "out"], ["clag", "in"]),
      /* The deposit lane hangs off `clock1`, the same seam every other lane reads, so
         swapping the pattern for a real track's analysis moves it with everything else. */
      edge("e10a", ["clock", "out"], ["dstep", "in"]),
      edge("e10b", ["dstep", "out"], ["dlim", "in"]),
      edge("e10c", ["dlim", "out"], ["dlag", "in"]),

      /* THE LOOP, and the only back edge is `trail1`'s source REFERENCE, which is not here. */
      edge("e11", ["spread", "out"], ["mesh", "field"]),
      edge("e12", ["mesh", "out"], ["sow", "points"]),
      edge("e13", ["trail", "out"], ["spread", "input"]),
      /* ⚑ THE DEPOSIT IS `in1` AND THE FIELD IS `in2`, AND THAT ORDER IS THE WHOLE MEANING
         OF `dlag1`. Composite's `opacity` scales THE FRONT LAYER, which is `in1` — so wired
         the other way round (which this file was, for one build) the lane multiplies the
         RETAINED FIELD every frame instead of the footfall, `persistence` becomes very
         nearly inert, and the trail's memory collapses to about a frame. It still renders
         something plausible, which is exactly why it took a claim asserting the field goes
         EXACTLY empty when the deposit is silenced to find it. */
      edge("e14", ["sow", "out"], ["mix", "in1"]),
      edge("e15", ["spread", "out"], ["mix", "in2"], 0),

      edge("e15a", ["mesh", "out"], ["bound", "points"]),
      edge("e16", ["bound", "out"], ["web", "points"]),
      edge("e17", ["web", "out"], ["links", "points"]),
      edge("e18", ["bound", "out"], ["dots", "points"]),
      edge("e18a", ["bound", "out"], ["frontdots", "points"]),
      edge("e19", ["nodes", "out"], ["haze", "input"]),
      edge("e20", ["haze", "out"], ["pool", "in1"]),
      edge("e21", ["neb", "out"], ["pool", "in2"]),
      edge("e22", ["pool", "out"], ["bed", "input"]),
      edge("e22a", ["webs", "out"], ["thread", "input"]),
      edge("e22b", ["nodes", "out"], ["white", "input"]),

      edge("e23", ["white", "out"], ["sum", "in1"]),
      edge("e24", ["thread", "out"], ["sum", "in2"], 0),
      edge("e25", ["bed", "out"], ["sum", "in2"], 1),
      edge("e26", ["sum", "out"], ["glow", "input"]),
      edge("e27", ["glow", "out"], ["lit", "in1"]),
      edge("e28", ["sum", "out"], ["lit", "in2"]),
      edge("e29", ["lit", "out"], ["mask", "in1"]),
      edge("e30", ["iris", "out"], ["mask", "in2"]),
      edge("e31", ["mask", "out"], ["paint", "input"]),
      edge("e32", ["paint", "out"], ["out", "input"]),
    ],
  ),
);
