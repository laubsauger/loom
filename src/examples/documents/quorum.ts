import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E54 — Quorum (T1070). THE GRAPH LAPLACIAN, DOING BOTH JOBS AT ONCE.
 *
 *   mesh1(pointKernel) ─┬─► bound1(pointRange) ─► web1(pointProximity) ─► links1(geometry)
 *                       │                                                      └─► webs1(render) ─► thread1(level)
 *                       └─► dots1(geometry) ─► nodes1(render) ─┬─► haze1(blur) ─► pool1(multiply ◄ neb1) ─► bed1(hsv)
 *                                                              └──────────────────────────────────────────► sum1(add)
 *   sum1 ─► glow1(blur) ─► lit1(add) ─► mask1(multiply ◄ iris1) ─► paint1(hsv) ─► out1
 *
 * ## The one idea
 *
 * A force-directed layout IS gradient descent on the graph Laplacian: spring attraction
 * along edges minimises xᵀLx, and the low-energy configurations ARE the low eigenvectors.
 * And diffusion over the same operator is power iteration: repeatedly averaging a value with
 * its neighbours drives it toward those same low eigenvectors — which is exactly what
 * "colour by community" means.
 *
 * So this document builds ONE operator and applies it to TWO quantities. `mesh1`'s kernel
 * runs a single loop over every pair; inside it the same weight `w` accumulates a positional
 * pull (the layout) and a colour average (the embedding). The clusters and their colours are
 * not two effects that happen to agree — they are one matrix, read twice.
 *
 * ## The weight, in two terms, and both positive
 *
 * THE BACKGROUND TIE is on every pair at every distance. THE COMMUNITY BOND is added on top,
 * only between two points of the same community and only inside `reach`, falling off
 * linearly. Contrast is the ratio between them, and at 0 they are equal: the operator cannot
 * see the blocks at all and the field can only be one blob. Separation between communities
 * is the COULOMB PUSH's job — over every pair inside the same `reach`, softened near zero —
 * which is also what stops a settled community from contracting to a single point.
 *
 * Both terms being positive is load-bearing rather than tidy. An earlier cut made the
 * between-community weight NEGATIVE to force the clusters apart; it laid out beautifully and
 * destroyed the colour, because a signed operator makes the power iteration anti-align and
 * after clamping the whole field came back grey. Two further cuts are recorded at their
 * lines in the kernel, because each was a plausible design that failed for a stateable
 * reason: an unbounded push (the aggregate of many negligible far pairs blew the field off
 * the frame), and a hard containment sphere (every point the push sent outward piled onto it
 * and the picture wore a wire cage).
 *
 * ## What is AUTHORED and what EMERGES — the honest split
 *
 * AUTHORED: the graph, and nothing else. `communityOf` is a stochastic block model keyed on
 * IDENTITY alone — a hash of the point's id. That is not a cheat, it is the input: a
 * Laplacian is an operator ON a graph, and a graph with no community structure has no
 * communities to find. It is deliberately ASYMMETRIC (§V854) — 26 / 20 / 15 / 11 % of the
 * population in four communities, the remaining 28 % affiliated with nobody — because four
 * equal blocks would settle into a rosette that looks designed, and because the unaffiliated
 * quarter is what puts loose dust across the field: nothing gathers them.
 *
 * EMERGES: everything you can see. Where each community sits, how tightly it holds, which
 * bridges survive between clusters, how large each node draws (its weighted degree in the
 * community graph), and what colour each community settles on. None of those is written
 * anywhere in this file — the seed colours are one independent draw per point per channel,
 * and four coherent hues come out of that noise because the operator puts them there.
 *
 * THE PROOF IS ONE PARAMETER. `mesh1`'s Seed feeds `pointRand`, which scatters the initial
 * dust and nothing else; every fact about the graph comes from `idHash`, which does not read
 * it. So changing Seed starts the same graph from a different place, and the same
 * communities condense out of it somewhere else on the frame, wearing the same colours.
 * `e54-quorum.gpu.test.ts` renders both and asserts exactly that, both ways round.
 *
 * ## How a point sees a neighbour (T1070, and it could not be done yesterday)
 *
 * A point kernel was a PURE PER-POINT FUNCTION — `fn process(p, ctx)`, one point, no way to
 * reach another. The catalogue's only neighbour query is Proximity, whose answer is a
 * drawable link set rather than data a kernel can consume; and a kernel over links cannot
 * scatter back to points, because this project's points machinery has no atomics. So every
 * coupled system in the shipped set is an honest fake and says so: E16's flock is a shared
 * flow field whose birds never see each other, E32's herd couples through a texture.
 *
 * T1070 added `pointAt(slot)` to codegen — the Point in another slot, read from the SAME
 * pre-frame half the wrapper loads `p` from. That last detail is the whole of its
 * correctness: every reader sees last frame's values, whatever order the workgroups ran in,
 * so a coupled update is a JACOBI iteration — order-independent, device-independent, no
 * atomics, no read-write hazard, reproducible frame for frame (§V44).
 *
 * The cost is O(N²) and it is stated rather than hidden: 480 points is 230k pair evaluations
 * a frame, inside the envelope Proximity's own brute-force scan already declares.
 *
 * ## One reach, two consumers (§V349)
 *
 * The kernel's `reach` and `web1`'s Radius are THE SAME NUMBER, both reading `reach1`. A
 * picture that draws links its operator is not using lies about its own mechanism, so every
 * filament on screen is one of the operator's own edges — the six strongest at each node.
 * `bound1` parks the unaffiliated (§V788: z = −1e6, out of every radius and every camera)
 * before the query runs, because the background tie is identical for every pair in the field
 * and therefore carries no structure: it is the field, not a filament. The unaffiliated are
 * still DRAWN — `dots1` reads the full set — as loose points joined to nothing, which is
 * what they are in the graph.
 *
 * ## The instrument (§V471 — this is a VJ file, not a plate)
 *
 * It RESTS AND STRIKES rather than vibrating. The structural move is on the PHRASE: `cstep1`
 * holds a value for four bars and `clag1` eases it into Coupling, so most phrases sit
 * settled and an occasional one lets the whole assembly relax open, communities
 * interpenetrating, before it re-condenses. That is a different picture, not a wobble. The
 * fine motion is on the BEAT: the high band drives `reach1`, so connection density is the
 * music made visible — the web tightens on a hit and thins in the quiet, exactly the use
 * Proximity's own docblock argues for. Nothing else runs on a free clock but the hue, which
 * turns once every 80 seconds, and the nebular bed, which drifts.
 *
 * AND THE STRUCTURAL EVENT IS THE DISTURBANCE (T1113): on about one phrase in three,
 * `dstep1 -> dlim1 -> dlag1` drives the two closest colonies through each other and lets
 * them separate again into a new arrangement. That is the one thing in this document that
 * is not the operator relaxing, it is external to it by construction, and it is why the
 * ring comes back in a different order instead of the same one. Everything else here
 * settles; this is what makes the settling worth watching twice.
 *
 * ⚑ FOUR WAYS TO MAKE IT LIVELIER WERE MEASURED AND REFUSED (T1074), and they are ONE
 * refusal rather than four attempts (§V900): FOUR RESOLVED HUES REQUIRE THE OPERATOR TO BE
 * BLOCK-DIAGONAL, AND A BLOCK-DIAGONAL OPERATOR HAS NO BOUNDARY. A partition that is legible
 * AS COLOUR is a partition whose blocks do not talk, and reorganisation is blocks talking.
 *
 * `Contrast` IS that ratio — community bond over background tie — so it is block-diagonality
 * with a knob on it, and sweeping it (frames 900 to 1500) shows the two requirements moving
 * MONOTONICALLY IN OPPOSITE DIRECTIONS WITH NO OVERLAPPING WINDOW. At contrast 18: frontier 0
 * links, churn 0 of 350, palette margins +0.158 / +0.394 / +0.153 / +0.387. At 8: frontier
 * still 0, churn still 0, margins already going negative. At 3: 22 frontier links, churn
 * STILL 0. At 1, where membership finally moves: frontier 165, churn 57 of 350 — and all four
 * margins are negative by then, −0.196 to −0.199. So the answer is not the reach, not the
 * community count, not the density, and not WHICH GRAPH THE OPERATOR COMPUTES OVER; moving a
 * Laplacian onto a sparse adjacency changes which graph is frontier-free, it does not create a
 * frontier. Before asking an operator to both SHOW a structure and CHANGE it, ask whether the
 * showing is the absence of the changing.
 *
 * That is this file's own thesis read from the other side: `reach` and the weights feed ONE
 * operator that is read twice, so anything that stirs the layout stirs the colour by exactly
 * the same amount. The four attempts below are the evidence, each refused with numbers.
 *
 * A BETWEEN-COMMUNITY BOND, to give the block model the nonzero cross-edge probability it
 * is actually named for and put the reference picture's long filaments on screen — the
 * render is four dense colonies ringing an empty middle with ZERO drawn cross links, and
 * that is not an accident, it is the weights: structureless-global or strictly-local, and
 * nothing between. Refused. At frame 180, where the palette claim is made, the shipped
 * margin (nearest colour gap minus own scatter) is only +0.0031, and every nonzero bond
 * drives it negative: 0.05 — smaller than the background tie's own 0.0526 — already gives
 * −0.019 and 19 % of points sitting nearer a community that is not theirs. At 0.5, where
 * bridges finally appear, Seed stops relocating any community at all. A bridge IS a colour
 * path between communities and the colour claim needs them isolated; both cannot hold.
 * What the picture actually wants is FEWER POINTS PER COMMUNITY — ninety members inside a
 * radius of 0.15 make every node's six nearest its immediate lattice neighbours, so no
 * cross pair at 0.6 can ever compete — and that is a change to the block model, not a
 * weight to add to this one.
 *
 * WIDENING `rgain1`, so the moving reach keeps the layout permanently unsettled: at gain 3
 * the assembly does stay alive (0.0047/frame against 0.0006, sustained past 30 s) and the
 * palette margin goes to −0.043 at every bond strength INCLUDING ZERO. The ceiling sits
 * between gain 0.6 and 1.0, and below it the extra motion is 1.2x, which is not a different
 * picture. The dynamics therefore live on the PHRASE, in Coupling's envelope, which moves
 * the operator's STRENGTH without changing what it measures.
 *
 * ⚑ AND THE POPULATION WAS TRIED TOO (T1074), because the first two refusals both pointed
 * at it: if one operator cannot connect and isolate at once, change the INPUT the two share.
 * The reasoning was that ~90 members inside a radius of 0.15 make every node's six nearest
 * its own lattice neighbours, so no cross pair at 0.6 can compete and web1 draws zero links
 * between communities. That reasoning is CORRECT and the fix still does not pay:
 *
 *   - FEWER MEMBERS PER COMMUNITY (16-22 % affiliated, ~20-40 each, the reference's count)
 *     does buy settled bridges — 0 links between communities becomes 11 to 21 — and it
 *     costs 68 % OF THE MOTION, measured by the look baseline: 0.03393 to 0.01086. Four
 *     fifths of the points become inert dust. The owner's complaint was that this file is
 *     not lively enough, so that is the wrong direction on their own axis. It also needs
 *     Anchor retuned to 0.08 to keep the palette reproducible across Seeds, and the window
 *     is NARROW — 0.05 loses cross-seed reproducibility, 0.10 loses within-community
 *     agreement, and the surviving resolution margin is +0.019.
 *
 *   - MORE COMMUNITIES OF ~20 (eight of them, affiliation kept at 51 % so the motion
 *     survives) reproduces across Seeds perfectly, 8 of 8 — and the palette margin is
 *     NEGATIVE at every Anchor, −0.078 to −0.199. Eight community colours cannot be
 *     resolved in three channels when each carries its own scatter. Four is not a style
 *     choice, it is close to what an RGB embedding can actually separate.
 *
 *   - AND NEITHER TOUCHES THE EMPTY MIDDLE. The communities sit on a RING, every one of
 *     them the same distance from the assembly's centroid: measured spread 0.014-0.032 at
 *     four communities across five Repulsion settings an order of magnitude apart, and
 *     0.053 against a mean of 0.41 at eight. Lowering Repulsion only shrinks the ring and
 *     takes the bridges with it. That geometry belongs to the OPERATOR — a background tie
 *     that is identical for every pair, a Coulomb push, and a recentre on the centroid put
 *     equal clusters on a sphere with the unaffiliated filling the middle — so it is
 *     reachable by neither the partition nor the knobs.
 *
 * The honest reading is that this operator makes COLONIES, and the reference picture's one
 * organism with filaments running through it wants a different graph rather than a different
 * setting of this one. Everything above is measured on Dawn and is recorded so the next
 * reader does not re-derive it. THE DIFFERENT GRAPH WAS THEN TRIED. It is refusals three and
 * four, and it is where §V900 stopped being a guess about this operator and became a sweep.
 *
 * ⚑ THE OPERATOR MOVED ONTO THE DRAWN GRAPH (T1082, measured in T1074) — the fix the owner
 * proposed himself, and the one the paragraph above asks for. `web1` is `pointProximity
 * {neighbors: 6}`, so THE PICTURE IS ALREADY A SPARSE SIX-NEAREST-NEIGHBOUR WEB while the
 * kernel loops every pair inside `reach`: the render shows a frontier the operator does not
 * have, and computing the Laplacian over the adjacency the picture already draws would put
 * the two back on one graph. The claim was that a k-NN adjacency HAS a boundary by
 * construction, a point's six nearest BEING its frontier. IT DOES NOT HOLD FOR THIS FILE.
 * Measured on the shipped document, on Dawn, over its OWN drawn web: cross-community links
 * are 68 of 2100 at frame 180 and 0 of 2100 at every frame from 900 to 3600 (twelve frames,
 * two complete four-bar phrases), and points with even one foreign neighbour are 0 of 350 —
 * computed with the radius cap REMOVED, so that is pure six-nearest rather than a radius
 * artefact. The dense field is frontier-free because every point sees EVERY colony; the
 * sparse graph is frontier-free for the exact mirror reason, because NO point sees ANY other
 * colony. Same cause both times: the dense same-label bond separates the colonies by more
 * than any point's sixth-nearest.
 *
 * Label propagation over it was measured five ways and none survives. Dense bond with a k-NN
 * vote: 0 of 350 label changes after frame 480, and size-normalising the vote does not move
 * it — THE SPARSE BOND, NOT THE SPARSE VOTE, IS THE LOAD-BEARING CHANGE. Label-blind k-NN
 * bond with a plain vote: monopoly, [350, 0, 0, 0] by frame 2100. Label-blind with a
 * size-normalised vote LOOKED sustained, and the lag test says otherwise — 12 to 15 flips at
 * every ODD lag and exactly 0 at +2, +4, +8 and +16, which is a 2-cycle, flicker rather than
 * reorganisation, and it is the one thing a churn metric cannot see. The fifth genuinely
 * sustains (k-NN same-label bond, size-normalised vote): 22-37 % churn in every window to
 * 3600, a monotone lag profile out to 141 of 350 at +480, 132-180 frontier links where this
 * file has 0, motion 0.00194 against 0.00074. Its RENDER is a rainbow-confetti annulus — one
 * continuous hue gradient round a ring, four communities invisible — and the numbers agree:
 * palette margins negative at every community, −0.006 to −0.18, even when the partition is
 * read from the operator's own mutable label, and only 90 of 350 points still carry their
 * founding label at frame 180, so §V854's 26/20/15/11 washes to 88/86/88/88 and the cross-seed
 * claim has no community identity left to be about. That configuration is not a failure, it is
 * a DIFFERENT example's thesis, and T1108 holds the question of whether it becomes one.
 *
 * ⚑ AND RECRUITMENT WITH HYSTERESIS (T1074) — quorum sensing, which is what this file is
 * named for, and the last shape left: a loose point JOINS a community when its neighbour
 * share reaches Q and falls back to dust below L < Q, voting over a k-NN neighbourhood of the
 * WHOLE population so dust can hear a colony, with the community bond kept strictly
 * within-community. It settles ONCE, to [54, 91, 13, 20] with 302 loose, and then reports 0 of
 * 480 label changes at every lag from frame 180 to 3600. The reason is the same one a third
 * time: once the colonies separate, a dust point's six nearest are ALL DUST — there are 302 of
 * them and they fill the middle — so its support is 0 and nobody joins, while a colony member
 * is surrounded by its own so nobody leaves. The symptom does not resist being fixed; it
 * relocates.
 *
 * ⚑⚑ AND THE SCOPE OF ALL FOUR, WHICH IS WHERE THE FIFTH GOT IN (T1113, and it is the
 * `disturb` term in the kernel below). §V900 IS A STATEMENT ABOUT THE OPERATOR'S FIXED
 * POINT. Every measurement above was taken at equilibrium or through ordinary phrase
 * dynamics, and the 0 of 2100 cross links from frame 900 on are a property of the SETTLED
 * LAYOUT rather than of the graph — measured, the colony centre gaps are 0.545 to 0.820
 * while a point's sixth-nearest neighbour sits at 0.067, a factor of eight. So the
 * separation is a DISTANCE, and a distance can be closed by moving bodies.
 *
 * THE PREMISE HELD. An external disturbance leaves the operator — and so block-diagonality,
 * and so §V900 — untouched, because it adds no weight to anything: it moves positions and
 * lets the graph be read where they land. Driving the two closest colonies into each other
 * takes the drawn web from 0 cross-community links to 80-95 of 2100, and from 0 to 48-63 of
 * 350 points holding a foreign near neighbour, and then back to EXACTLY 0 once the strike
 * passes and the push separates them again. On the shipped wiring that is 44-80 links at
 * each of the three struck phrases and 0 at every rested frame between them.
 *
 * THE PALETTE SURVIVES IT, and for a reason that can be pointed at rather than hoped for:
 * THE COLOUR OPERATOR'S CROSS-COMMUNITY WEIGHT IS DISTANCE-INDEPENDENT. Every pair carries
 * the background tie at every distance, and the only distance-dependent term is gated on
 * `mine == communityOf(other.id)` — so there is no term for proximity to strengthen across
 * a boundary, and two colonies can be driven through each other without exchanging any
 * colour they would not have exchanged at rest. Measured, worst margin +0.0123 during and
 * after the collision against +0.0129 for the same frames undisturbed: a delta of −0.0008,
 * where every refused attempt above went negative outright.
 *
 * ⚠ AND WHAT IT DOES NOT BUY, because this is the fifth attempt on a file that has refused
 * four and the temptation is to overclaim the one that worked: IT IS NOT CONQUEST.
 * `communityOf` is still a pure hash of identity, so no point changes hands — the colonies
 * collide, interpenetrate and separate carrying exactly the labels they arrived with. At
 * the deepest interpenetration only 3 to 9 of 350 points would flip even under a
 * label-propagation rule, and building one needs a fifth attribute against §V588's ceiling
 * of four. What the disturbance buys is a FRONTIER and a REARRANGEMENT — the ring comes
 * back in a visibly different order — and that is a smaller claim than the one T1113 set
 * out to test. §V900 is not refuted; it is bounded to the fixed point it was always about.
 *
 * Four knobs are left bare for a hand, each with a range that goes somewhere: Contrast 0 →
 * one undifferentiated blob, no communities possible; Repulsion 0 → every community
 * collapses to a single dot; Diffusion 0 → the seed dust never agrees on anything; Anchor 0
 * → every community melts into one colour.
 *
 * And every one of them, plus the whole published Coupling envelope, is SURVIVABLE rather
 * than merely documented, because the layout step carries a Courant bound — no point
 * travels more than 3 % of `reach` in a frame. Without it this file shipped a knob whose
 * usable range ended at Coupling ≈ 0.3 while its own four-bar envelope struck to 0.95: the
 * first strike put the assembly into a period-2 explosion it could never leave, and every
 * gate passed because every gate stopped at frame 180 and the first strike lands at 497.
 * The measurements are at the clamp, in the kernel. A knob that goes to 11 and blows up is
 * worse than one that goes to 11 and holds.
 *
 * ## Why the colour is normalised, and why that is not a look choice
 *
 * What survives the smoothing is a per-community MEAN of the seed field, whose spread is a
 * small fraction of the seed field's own. Drawn raw, the whole frame is mid-grey. So the
 * kernel divides the embedding by its own global deviation before storing it — the
 * normalisation step power iteration always carries, which is also what keeps the loop
 * stable, since the shrink and the restore balance and only the SHAPE survives. The picture
 * is literally the convergence of the iteration.
 */

const QUORUM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0.5, 0.5, 0.5, 1] },
  { name: "degree", type: "f32", semantic: "size", default: [0.35] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
]);

/*
 * Four attributes is the ceiling a plain kernel has (§V588: 2 bindings each, 8 per stage),
 * and this kernel spends all four. `degree` is the WEIGHTED degree — recomputed every frame
 * from the same loop, never authored — and it drives the billboard's size through Map mode,
 * which is where the reference picture's hubs come from.
 */
const QUORUM_KERNEL = `struct Params {
  coupling: f32,   // How hard each edge pulls its two ends together — the relaxation rate, and the structural knob.
  contrast: f32,   // How much weaker the background tie every pair shares is than a bond inside a community; at 0 the two weigh the same, the block structure is invisible to the operator, and the field can only ever be one blob.
  repulsion: f32,  // The Coulomb push between every pair, which is what separates one community from the next and holds a settled one open instead of letting it collapse to a dot.
  reach: f32,      // World radius a community bond can span, and the same number the drawn web uses — the picture must not show links the operator is not using.
  diffusion: f32,  // How fast a point's colour averages with its neighbours' — the rate at which a community agrees on a hue.
  anchor: f32,     // How hard each point holds its own seed colour against that averaging; at 0 every community melts into one.
  disturb: f32,    // T1113: the DISTURBANCE — how hard each colony is driven at the colony it is paired with. 0 at rest, and the only term in this kernel that is not part of the operator.
}

/* The community that binds to nobody — 28 % of the population, and the reason loose dust
   scatters across the field instead of everything being swept into a cluster. */
const LOOSE: u32 = 4u;

/* The degree an UNLINKED point carries: the floor every point starts from, so a point with
   no community bond lands on it exactly and a point with one lands above it. bound1 reads
   the same number from the other side, which is why neither of them is a knob (T1053: a
   number that has to match another number is not a control). */
const UNLINKED: f32 = 0.45;

/* Identity to a 32-bit hash. Written here rather than reached for through pointRand
   because these draws must NOT move: pointRand keys on the frame and on this node's Seed
   as well as on the point (§V74), which is right for per-frame randomness and wrong for a
   fact about a point that has to be identical on frame 0 and frame 4000, at every seed, on
   every device. The whole "same graph, different starting place" claim rests on the two
   draws having two sources. */
fn idHash(id: u32, salt: u32) -> u32 {
  var h = (id * 2654435761u) ^ (salt * 2246822519u);
  h = (h ^ (h >> 15u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return h ^ (h >> 16u);
}

fn idRand(id: u32, salt: u32) -> f32 {
  return f32(idHash(id, salt)) * (1.0 / 4294967296.0);
}

/* THE GRAPH — the one authored thing in this document. A stochastic block model keyed on
   identity alone, asymmetric on purpose (§V854): 26 / 20 / 15 / 11 % in four communities,
   the remaining 28 % affiliated with nobody. A symmetric partition could not tell a working
   operator from a broken one, and four equal communities would settle into a rosette that
   looks designed. */
fn communityOf(id: u32) -> u32 {
  let r = idRand(id, 101u);
  if (r < 0.26) { return 0u; }
  if (r < 0.46) { return 1u; }
  if (r < 0.61) { return 2u; }
  if (r < 0.72) { return 3u; }
  return LOOSE;
}

fn seedColorOf(id: u32) -> vec3f {
  return vec3f(idRand(id, 201u), idRand(id, 202u), idRand(id, 203u));
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T510: the buffers are fresh. Scatter the dust and hand every point its identity — and
     note WHICH generator each line uses. Position comes from pointRand, so this node's Seed
     decides where the field starts; everything else comes from idHash, so the Seed cannot
     touch what the graph IS. */
  if (ctx.firstRun == 1u) {
    q.id = ctx.index;
    let a = pointRand(ctx.index, 11u) * 6.2831853;
    let rr = sqrt(pointRand(ctx.index, 12u)) * 0.95;
    q.position = vec3f(cos(a) * rr, sin(a) * rr * 0.82, (pointRand(ctx.index, 13u) - 0.5) * 0.25);
    q.tint = vec4f(seedColorOf(ctx.index), 1.0);
    q.degree = UNLINKED;
    return q;
  }

  let reach = max(ctx.params.reach, 0.02);
  let mine = communityOf(p.id);

  var pull = vec3f(0.0);      /* Σ w·(x_j − x_i) — minus the Laplacian applied to POSITION */
  var blend = vec3f(0.0);     /* Σ w·c_j        — the SAME operator applied to COLOUR */
  var push = vec3f(0.0);
  var wsum = 0.0;
  var bond = 0.0;             /* the COMMUNITY part of the degree, which is what a hub has */
  var centroid = vec3f(0.0);
  var colorSum = vec3f(0.0);
  var colorSq = 0.0;
  /* T1113: the four colony centres, accumulated in the SAME scan — the disturbance needs
     somewhere to aim, and a colony's centre is the only landmark this operator owns. */
  var csum = array<vec3f, 4>();
  var cnt = array<f32, 4>();

  /* THE O(N²) SCAN, and it is one loop because it is one operator. T1070's pointAt reads
     the pre-frame half, so every point sees the same last-frame field whatever order the
     workgroups ran in — a Jacobi step, not a scheduling-dependent one (§V44). */
  for (var j = 0u; j < ctx.count; j += 1u) {
    let other = pointAt(j);
    { let oc = communityOf(other.id); if (oc < 4u) { csum[oc] += other.position; cnt[oc] += 1.0; } }
    centroid += other.position;
    colorSum += other.tint.rgb;
    colorSq += dot(other.tint.rgb, other.tint.rgb);
    if (j == ctx.index) { continue; }
    let d = other.position - p.position;
    let r = sqrt(max(dot(d, d), 1.0e-12));
    /* THE EDGE WEIGHT, in two terms and both POSITIVE — so this is a genuine graph
       Laplacian: the descent cannot run away and the diffusion cannot oscillate. (An earlier
       cut made a between-community weight NEGATIVE to force the clusters apart. It laid out
       beautifully and destroyed the colour, because a signed operator makes the power
       iteration anti-align and after clamping the whole field came back grey. Separation is
       the push's job, not the weight's.)

       THE BACKGROUND TIE is on every pair at every distance — that is what makes this one
       field rather than four that drift apart the moment they lose sight of each other, which
       is exactly what a cut with no long-range term did. THE COMMUNITY BOND is local, and
       only between two points of the same community. Contrast is the ratio between them, and
       at 0 they are equal: the operator cannot see the blocks and no cluster can form. */
    var w = 1.0 / (1.0 + max(ctx.params.contrast, 0.0));
    var kernel = 0.0;
    if (r <= reach) {
      kernel = 1.0 - r / reach;
      /* THE COULOMB PUSH, over every pair in range and softened near zero. This is what
         separates one community from the next — the weights only ever attract — and what
         stops a settled community from contracting to a single point. Bounded by the same
         radius the bond is: an earlier cut let it run to infinity, and the aggregate of many
         weak far pairs — each negligible, all of them outward — blew the field off the frame
         inside a hundred frames. */
      push -= (d / r) * kernel / (r * r + 0.0015);
      if (mine == communityOf(other.id) && mine != LOOSE) {
        w += kernel;
        bond += kernel;
      }
    }
    pull += d * w;
    blend += other.tint.rgb * w;
    wsum += w;
  }

  let n = f32(max(ctx.count, 1u));
  centroid = centroid / n;
  let mean = colorSum / n;
  let deviation = max(sqrt(max(colorSq / n - dot(mean, mean), 0.0)), 1.0e-4);
  let norm = max(wsum, 1.0e-6);

  /* THE LAYOUT: one descent step on ½·xᵀLx, plus the push. Divided by the degree, so the
     attraction is the random-walk Laplacian and a hub does not travel further per frame
     than a leaf. */
  var advance = (pull / norm) * ctx.params.coupling + push * ctx.params.repulsion;

  /* ⚑ THE DISTURBANCE (T1113), AND IT IS THE ONE TERM HERE THAT IS NOT THE OPERATOR.
     Communities 0↔3 and 1↔2 are driven at each other's centres while disturb is up, so
     the two closest colonies collide, interpenetrate, and are pushed apart again into a
     NEW arrangement when it falls. Nothing about the operator changes: the bond is still
     strictly within-community, the block structure is still block-diagonal, and this is an
     EXTERNAL input that moves the system away from its fixed point rather than a different
     fixed point (§V900 is a statement about the fixed point; the interesting behaviour is
     in the transient).

     WHY AN ASYMMETRIC AIM, MEASURED — three were tried at the same force and only this one
     collides, because THE AIM IS THE AUTHORED THING AND THE STRENGTH IS NOT:
       - a uniform contraction toward the centroid is a SIMILARITY TRANSFORM, and k-NN
         adjacency is SCALE-INVARIANT. Gap 0.542 → 0.435 and assembly radius 0.608 → 0.468,
         the SAME ratio, and the frontier stays at 0. Shrinking the picture changes nobody's
         six nearest;
       - a cyclic chase (0→1→2→3→0) is a merry-go-round: every colony pursues a target that
         is itself fleeing, the ring's symmetry survives, frontier 3–12 links;
       - mutual head-on, this one: frontier 80–95 links of 2100, and 48–63 of 350 points
         acquire a foreign near neighbour where the settled file has EXACTLY ZERO (T1074).
     3u - mine pairs the two CLOSEST colonies (centre gaps 0.562 and 0.562) rather than
     the two furthest (0.820, 0.770) that mine ^ 1u would have paired.

     AND IT IS ADDED BEFORE THE COURANT CLAMP, which is what makes it a FORCE rather than a
     teleport: it inherits the same travel bound every other term obeys, so no point moves
     more than 3 % of reach in a frame however hard it is driven. The clamp SATURATES —
     at the shipped gain a point half a world from its aim wants to step 0.25 and takes
     0.0255 — so disturb is a GATE on whether the colonies are driven, not a dial on how
     violently, and the collision runs at the speed the field's own relaxation does. That is
     also why it cannot reach the period-2 explosion the clamp exists to refuse.

     The loose dust is NOT driven: it is affiliated with nobody, so it has no colony to be
     paired with, and §V788 parks it out of every radius anyway. It stays where it is and
     the colonies move through it. */
  if (ctx.params.disturb > 0.0 && mine < 4u) {
    var ccentre = array<vec3f, 4>();
    for (var c = 0u; c < 4u; c += 1u) { ccentre[c] = csum[c] / max(cnt[c], 1.0); }
    advance += (ccentre[3u - mine] - p.position) * ctx.params.disturb;
  }

  /* ⚑ THE COURANT BOUND, AND IT IS WHAT MAKES THE STRIKE SURVIVABLE.

     Everything above is an EXPLICIT step, so it is only meaningful while a point stays
     inside the neighbourhood it just measured: a point that crosses reach in one frame
     has been moved by a set of neighbours it no longer has. pull respects that on its
     own — it is a weighted MEAN of neighbour offsets, bounded by the cluster's own width.
     push does not, and cannot: it is a raw SUM over every in-range pair with a 1/r²
     singularity, so its size is set by how many pairs are close rather than by any
     distance in the picture, and a pull-in is precisely the event that drives r small for
     hundreds of pairs at once.

     MEASURED, through the real plan on Dawn, over E54's own four-bar envelope. Without
     this clamp the step has a fixed point only up to Coupling ≈ 0.3; the document RESTS at
     0.449 and STRIKES to 0.95. Pinned at each value, mean displacement per point per frame
     and the assembly's radius over the last 12 frames of 400:

        Coupling  0.20 → 0.001 / radius 0.848..0.857     (settles)
        Coupling  0.30 → 0.005 / radius 0.771..0.781     (settles)
        Coupling  0.45 → 0.079 / radius 0.689..0.746     (a period-2 breath begins)
        Coupling  0.70 → 0.231 / radius 0.521..0.941
        Coupling  0.95 → 0.819 / radius 0.433..2.497     (the whole field, every frame)

     That last row is the bug the owner saw: the assembly inhales and explodes on
     ALTERNATING FRAMES — push fires hardest exactly when the pull has just collapsed the
     spacing, throws everything outward past the soft safety at 1.75, and the pull hauls it
     back in for the next one. It never recovers because there is nothing to recover TO: an
     explicit step past its stability limit has no fixed point to fall into. Nothing jumped
     — Coupling eases over 140 frames through clag1 — the smooth ramp simply walks the
     step across its own stability boundary.

     WHY A TRAVEL LIMIT AND NOT A SMALLER KNOB (the four cuts, all measured at 0.95):
       - shrink Repulsion / cap Coupling at the last stable value: that is a knob that goes
         to 3 instead of 11, and this is a VJ file (§V471);
       - a bigger soft core (0.0015 → 0.0035, → 0.02): still 0.106 / radius 0.413..0.624.
         It buys a constant factor and Repulsion is a knob, so any fixed core has a dial
         setting that outruns it;
       - clamp each PAIR to a fraction of its own separation: still 0.30 / radius
         0.494..1.324. The aggregate is the problem, not any one pair;
       - divide push by its own weight sum, making it an average exactly as pull is:
         still 0.15..0.25 at every Repulsion that keeps the clusters open, and it re-scales
         a published knob by 60× to say the same thing;
       - clamp only the push: settles, and the communities implode to radius 0.07..0.19,
         because holding a settled cluster open IS the push's magnitude.

     So the bound is on the TRAVEL, stated in the one length this operator owns. Three
     percent of reach is a factor of ~1.5 under the measured knee (0.05 leaves a residue,
     0.04 and below converge) and ~60× ABOVE the step a settled field actually takes, so it
     shapes nothing at rest and only ever refuses a blow-up. It holds the knobs at 11:
     Coupling 2.0 → 0.004, Repulsion ×10 → 0.001, Repulsion ×62 → 0.001, all settling.
     Unclamped, Repulsion ×10 at Coupling 0.95 reaches radius 16.9 and mean displacement
     10.1 — the field is off the frame.

     This is the same class as the unbounded push recorded above and one layer deeper: that
     cut bounded the push's RANGE and left its MAGNITUDE free. */
  let travel = length(advance);
  let limit = reach * 0.03;
  if (travel > limit) { advance = advance * (limit / travel); }

  var pos = p.position + advance;
  /* The assembly re-centres on its own centroid — no arbitrary spring to the origin, and
     nothing that would pull a community off its own found position. The weak background tie
     already keeps the field bounded, so what is left here is a SAFETY, soft and far out: an
     earlier cut used a hard projection at 1.0 and every point the push sent outward piled
     onto that sphere, which read as a wire cage drawn around the picture. */
  pos = pos - centroid;
  let over = max(length(pos) - 1.75, 0.0);
  pos = pos - normalize(pos + vec3f(1.0e-9)) * over * 0.15;
  q.position = vec3f(pos.x, pos.y, pos.z * 0.5);

  /* THE COLOUR: THE SAME OPERATOR, a different quantity. Applying it repeatedly to a value
     is power iteration — it drives the field toward this Laplacian's low eigenvectors, which
     is what "colour by community" means — and it runs on the CENTRED value because a
     Laplacian eigenvector is a deviation from the mean, not an absolute. Anchor holds each
     point to its own independent seed draw, so the three channels settle on three DIFFERENT
     low modes instead of all collapsing onto the top one; turn it to zero and they do
     collapse, which is the knob melting every community into a single hue. */
  let centred = blend - mean * wsum;
  var u = p.tint.rgb - mean;
  u = u + (centred / norm - u) * ctx.params.diffusion
        + ((seedColorOf(p.id) - vec3f(0.5)) - u) * ctx.params.anchor;
  /* Power iteration's normalisation step, and the reason it is here rather than downstream:
     what survives the smoothing is a per-community mean whose spread is a small fraction of
     the seed field's, so drawn raw the frame is mid-grey. Dividing by the field's own global
     deviation restores the scale the smoothing removed — which is also what keeps the loop
     stable, since the shrink and the restore balance and only the SHAPE survives. */
  q.tint = vec4f(clamp(0.5 + u * (0.34 / deviation), vec3f(0.0), vec3f(1.0)), 1.0);

  /* The degree in the COMMUNITY graph, straight out of the same loop — hubs draw large,
     edge-of-cluster nodes medium, and a point affiliated with nobody sits exactly on
     UNLINKED. The weak background tie is deliberately NOT counted: it is the same for every
     point, so counting it would say nothing and would cost the unaffiliated their floor. */
  q.degree = UNLINKED + clamp(bond / 34.0, 0.0, 1.9);
  return q;
}`;

export const quorumDocument = document(
  "e54-quorum",
  "E54 Quorum",
  settings({ randomSeed: 54 }),
  graph(
    [
      // ---- the clock, and the two drives ------------------------------------------
      /* E45's clock seam: every lane reads `clock1`, never `beat1`, so the tempo source
         is one node to exchange for a real track's analysis. At index 0 it is the
         deterministic pattern, which is what ships (§V44/§V45 — no device on load). */
      node("beat", "audioPattern", [-2560, 700], { bpm: 116, amount: 1 }, { label: "beat1" }),
      node("clock", "valueSwitch", [-2260, 700], { index: 0 }, { label: "clock1" }),
      /* HIGH band -> the web's reach. Rest subtracted first (T701), then one envelope so
         the web breathes on strikes instead of flickering on every analyser frame (T824). */
      node("hsub", "valueMath", [-1960, 700], { operation: "add", operand: -0.381 }, { label: "hsub1" }),
      node("henv", "valueLag", [-1660, 700], { lag: 0.04, releaseRatio: 8 }, { label: "henv1" }),
      node("rgain", "valueMath", [-1360, 700], { operation: "multiply", operand: 0.3 }, { label: "rgain1" }),
      /* THE ONE REACH. Both the operator and the drawn web read this node, so the picture
         cannot show a link the operator is not using (§V349). */
      node("reach", "valueMath", [-1060, 700], { operation: "add", operand: 0.85 }, { label: "reach1" }),
      /* THE STRUCTURAL MOVE, on the PHRASE rather than on a timer: a value held four bars,
         stretched so most phrases land at full coupling and an occasional one drops the
         assembly loose, then eased so the re-condensation is a swell and not a snap. */
      node("cstep", "valueStep", [-1960, 940], { every: 4, minimum: 0, maximum: 1, seed: 11 }, { label: "cstep1" }),
      node("cmul", "valueMath", [-1660, 940], { operation: "multiply", operand: 2.6 }, { label: "cmul1" }),
      node("csub", "valueMath", [-1360, 940], { operation: "add", operand: -0.45 }, { label: "csub1" }),
      node("clim", "valueLimit", [-1060, 940], { minimum: 0.25, maximum: 0.95 }, { label: "clim1" }),
      node("clag", "valueLag", [-760, 940], { lag: 0.9, releaseRatio: 3 }, { label: "clag1" }),
      /* THE DISTURBANCE LANE (T1113) — three nodes, on the same clock seam as everything
         else, and no arithmetic chain: the STEP'S OWN min/max do the mapping. `dstep1`
         holds a draw for two bars and emits −3.0 + 4.2·r, so `dlim1` clamping to [0, 0.5]
         is a GATE: the lane is flat zero unless the draw clears 0.714, which is a bit under
         a third of phrases. That is the rest-and-strike shape stated as arithmetic — most
         phrases the assembly is left alone, and on the others it is driven together.

         IT GETS ITS OWN STEP RATHER THAN READING `cstep1` because coupling's draw sequence
         happens to run high for five phrases together (0.73, 0.86, 0.96, 0.89, 0.75), so
         ANY threshold on it fires as one long contiguous block instead of as separate
         events. A second draw off the same clock is still the same tempo; it is just not
         the same coin. At the shipped seed it strikes on three well-separated phrases —
         frames 497–745, 1490–1738 and 2234–2483 — and rests for the rest of the minute. */
      node("dstep", "valueStep", [-1360, 1420], { every: 2, minimum: -3, maximum: 1.2, seed: 82 }, { label: "dstep1" }),
      node("dlim", "valueLimit", [-1060, 1420], { minimum: 0, maximum: 0.5 }, { label: "dlim1" }),
      /* Eased on the way in and out for the same reason clag1 is: a collision that snaps on
         reads as a teleport even when the clamp is holding every step to 3 % of reach. */
      node("dlag", "valueLag", [-760, 1420], { lag: 0.7, releaseRatio: 2 }, { label: "dlag1" }),
      /* The only free-running clock in the file, and it turns once every 80 seconds. */
      node("hue", "lfo", [-1960, 1180], { shape: "sine", frequency: 0.0125, amplitude: 150, offset: 0, phase: 0 }, { label: "hue1" }),

      // ---- the operator ------------------------------------------------------------
      node("mesh", "pointKernel", [-1960, -320], {
        capacity: 480,
        seed: 54,
        attributes: QUORUM_ATTRIBUTES,
        kernel: QUORUM_KERNEL,
        contrast: 18,
        repulsion: 0.00016,
        diffusion: 0.3,
        anchor: 0.05,
      }, {
        label: "mesh1",
        parameters: {
          reach: drivenSlot("reach1:high", 0.85),
          coupling: drivenSlot("clag1:bar", 0.85),
          /* T1113: 0 at rest, and the document's only structural event that is not the
             operator relaxing. Bare default 0 so a file with the lane cut is the file as
             it shipped before the disturbance existed. */
          disturb: drivenSlot("dlag1:bar", 0),
        },
      }),
      /* THE GRAPH, MINUS ITS ISOLATED VERTICES. Proximity is a purely SPATIAL query, so run
         on the whole population it would draw a link between two unaffiliated points that
         happen to be near each other — and the operator has no edge there at all. A picture
         that draws links the operator is not using lies about its own mechanism, so the
         unaffiliated are parked (§V788, z = −1e6, out of every radius and every camera)
         before the query runs. They are still DRAWN, by `dots1`, which reads the full set:
         loose points across the field, joined to nothing, exactly as they are in the graph. */
      node("bound", "pointRange", [-1660, 20], {
        attribute: "degree", component: "x", from: 0.451, to: 8, mode: "inside",
      }, { label: "bound1" }),
      /* T819's link set: Radius is the SAME channel the kernel's reach reads, so every link
         drawn is one of the operator's own edges — the six strongest at each node. Falloff 2
         keeps the long bridges dim and the tight in-cluster filaments bright, which is the
         reference picture's whole texture. */
      node("web", "pointProximity", [-1660, -180], { neighbors: 6, falloff: 3 }, {
        label: "web1",
        parameters: { radius: drivenSlot("reach1:high", 0.85) },
      }),

      // ---- the draw: TWO passes, because the two layers say different things ---------
      node("ink", "materialUnlit", [-1660, -560], { color: [1, 1, 1, 1] }, { label: "ink1" }),
      /* Beams, additive and soft: many filaments crossing one cluster must SUM into light
         rather than fight a depth buffer (T917). Taper 0 pinches each link at its origin so
         six links leaving one node do not fuse into a wedge. Proximity writes a WHITE tint
         whose alpha is the link's strength, so the web is pale by construction — the colour
         in this picture belongs to the nodes, exactly as it does in the reference. */
      node("links", "geometry", [-1360, -180], {
        mode: "beam", endpoint: "tip", material: "ink1",
        scale: 0.0016, taper: 0, soft: 0.9, blend: "additive",
      }, {
        label: "links1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      /* The nodes. Scale in Map mode MULTIPLIES by `degree`, so the size is the weighted
         degree the kernel just measured — nothing here decides how big a hub is. */
      node("dots", "geometry", [-1360, -440], {
        mode: "points", material: "ink1", soft: 0.75, blend: "additive", scale: 0.008,
      }, {
        label: "dots1",
        parameters: {
          scale: { mode: "map", bindings: { static: { kind: "static", value: 0.008 }, map: { kind: "map", attribute: "degree" } } },
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      node("cam", "camera", [-1360, -700], { eye: [0, 0, 2.15], lookAt: [0, 0, 0], fov: 52 }, { label: "cam1" }),
      /* The split is the reason the haze has a colour at all: blurring ONE render that held
         both layers would smear 2880 white filaments over 480 coloured nodes and the bed
         would come out grey. Two passes, one camera, and each layer is graded for its job. */
      node("webs", "render", [-1060, -180], {
        scenes: "links1", camera: "cam1", lights: "", ambientIntensity: 0, background: [0, 0, 0, 1],
      }, { label: "webs1" }),
      node("nodes", "render", [-1060, -440], {
        scenes: "dots1", camera: "cam1", lights: "", ambientIntensity: 0, background: [0, 0, 0, 1],
      }, { label: "nodes1" }),

      // ---- the haze: a density field, not a decoration ------------------------------
      /* Blurring the NODES is the density of the nodes, so the haze pools where the graph is
         dense because the graph is dense there — and it carries each community's own colour
         because that is what was blurred. Nothing paints it. */
      node("haze", "blur", [-760, -440], { size: 58, filter: "gaussian", extend: "hold" }, { label: "haze1" }),
      /* §V880: perlin4d with a real time axis and an OFF-LATTICE t4d, so Speed is a control
         that does something. A 3d variant here would be a static poster wearing a clock. */
      node("neb", "noise", [-1060, 120], {
        type: "perlin4d", seed: 54, period: 0.42, harmon: 3, spread: 2, gain: 0.55,
        rough: 0.5, exp: 1.4, amp: 1, offset: 0.4, mono: true, aspectcorrect: true,
        speed: 0.055, t4d: 0.41, s4d: 1,
      }, { label: "neb1" }),
      node("pool", "multiply", [-460, -300], {}, { label: "pool1" }),
      /* The bed is LIFTED in saturation and pushed DOWN in value: a haze reads as depth only
         while it stays below the thing it sits behind (§V471). */
      node("bed", "hsv", [-160, -300], { hueoffset: 0, saturation: 1.9, value: 0.5 }, { label: "bed1" }),
      /* The filaments, graded down so the web is structure rather than glare — the reference
         reads its links as thread, not as light. */
      node("thread", "level", [-760, -120], { brightness: 0.42, gamma1: 1.3 }, { label: "thread1" }),

      // ---- assemble, glow, iris ------------------------------------------------------
      /* Front is the NODES; the filaments and the bed fold in behind, in that order. */
      node("sum", "add", [140, -300], {}, { label: "sum1" }),
      node("glow", "blur", [440, -140], { size: 16, filter: "gaussian", extend: "hold" }, { label: "glow1" }),
      node("lit", "add", [740, -300], { opacity: 0.55 }, { label: "lit1" }),
      /* The aperture the reference is observed through: a radial ramp, open in the middle and
         closed to black before the corners. */
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
         depth cue is ordering, and a hue turn preserves luminance exactly. */
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
      /* The disturbance lane hangs off `clock1`, the same seam every other lane reads, so
         swapping the pattern for a real track's analysis moves the shove with it. */
      edge("e10a", ["clock", "out"], ["dstep", "in"]),
      edge("e10b", ["dstep", "out"], ["dlim", "in"]),
      edge("e10c", ["dlim", "out"], ["dlag", "in"]),
      edge("e11", ["mesh", "out"], ["bound", "points"]),
      edge("e11b", ["bound", "out"], ["web", "points"]),
      edge("e12", ["mesh", "out"], ["dots", "points"]),
      edge("e13", ["web", "out"], ["links", "points"]),
      edge("e14", ["nodes", "out"], ["haze", "input"]),
      edge("e15", ["haze", "out"], ["pool", "in1"]),
      edge("e16", ["neb", "out"], ["pool", "in2"]),
      edge("e17", ["pool", "out"], ["bed", "input"]),
      edge("e18", ["webs", "out"], ["thread", "input"]),
      edge("e19", ["nodes", "out"], ["sum", "in1"]),
      edge("e20", ["thread", "out"], ["sum", "in2"], 0),
      edge("e21", ["bed", "out"], ["sum", "in2"], 1),
      edge("e22", ["sum", "out"], ["glow", "input"]),
      edge("e23", ["glow", "out"], ["lit", "in1"]),
      edge("e24", ["sum", "out"], ["lit", "in2"]),
      edge("e25", ["lit", "out"], ["mask", "in1"]),
      edge("e26", ["iris", "out"], ["mask", "in2"]),
      edge("e27", ["mask", "out"], ["paint", "input"]),
      edge("e28", ["paint", "out"], ["out", "input"]),
    ],
  ),
);
