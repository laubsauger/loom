# E34 — Lidar

A night survey. A mast at the origin sweeps a ring of 240 rays over a dark terrain, and
one ray in ten is *drawn*: a beam from the mast down to whatever it found, in the same
glowing yellow as the return it ends on. Where a ray lands, a hot return beads onto the
relief and pools light onto the ground under it; where it gets no return at all, nothing
is drawn; and where it lands it also *bounces* — a second cast, reflected off the surface
normal, drawn as a green leg out to the green echo it produced. The Ray POP, working for
its living.

## Graph

```
relief(noise) ─► carve(level) ─┬─► probe(textureToAttribute) ─► raise(pointKernel) ─► ground(geometry)
                               │        ▲ sheet(pointGrid) ─► unfold(pointKernel)
                               ├─► cast(pointRay) ◄─ aim(pointKernel) ◄─ fan(pointLine)
                               │        ├─► sight(pointKernel) ─► rays(geometry · BEAM)
                               │        ├─► mark(pointKernel) ─┬─► impacts(geometry)
                               │        │                      └─► pool(pointKernel) ─► poolmap(renderPoints)
                               │        └─► ricochet(pointKernel) ─► rebound(pointRay) ─► mark2(pointKernel) ─┬─► echoes(geometry)
                               └───────────────────────────────────▲ (field)                                 └─► bounce(geometry · BEAM)

poolmap ─► poolsoft(blur) ─► poolbase(level) ─► basalt.albedo        the ground LIT by its returns
skyband(ramp) ─► shot(render) ◄─ ground · impacts · echoes · rays · bounce · eye(camera) · moon(light) · lamp(light)
shot ─► cut(level) ─► clip(limit) ─► halo(blur) ─► glow(add) ─► out(output)
shot ─┬─► hot(threshold) ─┐                                          the TRAIL: only bright things smear
      └─► stain(multiply) ◄┘ ─► smear(add) ─► glow.in2
                                  ▲ trail(feedback "smear1")
```

## What it proves

- **A lidar without beams is a hillside with noise on it.** The returns used to appear
  with no visible cause, and the owner read them exactly that way — "some weird noise,
  missing something that ties it together". `rays1` draws the causal chain: mode `beam`
  (T680) spans each ray's `position` — the mast — to its `hitPosition`, which `cast1`
  already carries, so 24 beams cost 24 instances of six vertices and **not one extra ray
  march**. The alternative, sampling each ray into a string of billboards, was built and
  measured first: 983,000 texture reads a frame against this file's 15,400, for a
  serrated ribbon that cannot taper. The primitive was the cheap answer as well as the
  good one.
- **A ray and the mark it makes share a colour, and that is why the scene reads as one
  process.** `haze1` used to be a flat `[0.36, 0.21, 0.08]` — one colour for every beam,
  unrelated to the box it landed on — and the mechanism nobody had named is that 0.36
  sits just *below* `cut1`'s 0.42 bloom knee, so 24 lit ribbons read as matte orange
  sticks while the ring they ended on glowed. `sight1` now gives each beam `mark1`'s own
  return expression at a lower gain, so the beam is the same yellow as its impact and
  lands *above* the knee. The bounce leg does the same on the other side: `bounce1` reads
  `mark2a`'s tint unchanged, so the leg and the echo it ends on are literally one colour.
  The eye traces cause to effect because there is nothing to trace *between*.
- **A ray with no return is not drawn, and both alternatives were built and measured
  first.** Recolouring the misses takes the green band's hard-flip rate from **0.4% to
  11.3%**, because the *class boundary* is what oscillates — a recoloured miss class
  blinks worse than the hit class it replaces. Fading the beam out at max range paints a
  **black ribbon** across the lit terrain: a beam is opaque scene geometry, so dimming it
  toward zero does not hide it, it darkens whatever is behind it (§V668). Dropping is what
  survives, and it is free — the amber hard-flip rate is *unchanged* at 0.4% with the drop
  alone, and the 0.4% → 1.9% this rework does spend is attributable entirely to the beams
  getting brighter, measured separately. The drop needs no flag either: both ends on the
  same point is a zero-area beam, and the Ray node's contract is that a miss ends exactly
  `maxDistance` from its origin.
- **Contraction costs reach — the tightest ring and the max distance are one number.**
  The mast stands at y = 3.3 and the terrain floor is −0.6, so a vertical shot needs 3.9
  to touch the bottom of the basin. At the old range of 3.4 a vertical shot bottomed out
  at y = −0.1, and steepening the tilt past ~1.10 rad simply made the middle of the ring
  fall *short*: measured at tilt span 0.72 the whole ring turns out-of-range steel and
  exactly one beam survives. So "contract the circle further" is not a tilt edit, it is a
  tilt edit **and** a range edit, and the two constants carry each other. Span 0.50 → 0.62
  with range 3.4 → 3.9 takes the tightest ring's radius to tan(1.10)/tan(1.22) = 0.719 of
  what it was — 28% smaller, and the ratio is free of the local ground height, so it is a
  fact about the instrument rather than about one frame.
- **The bounce leg is drawn, and it took a hold to make that affordable.** This was
  rejected once, by measurement, and the rejection was right for its tree: drawn off
  `rebound1`'s *raw* verdict it cost green energy 873k → 1,399k, because the segments
  popped in and out with the verdict and had no persistence to inherit. Sample-and-hold
  then landed, and a beam hung on `mark2a` inherits exactly the persistence the rejected
  version lacked. Same ten rays, same width, same colour, camera frozen, the only variable
  being where the segment reads from:

  | | green energy | green px | green hard-flip |
  |---|---|---|---|
  | no bounce beam | 663,533 | 171,680 | 0.4% |
  | bounce, **held** | 4,961,526 | 393,877 | **2.2%** |
  | bounce, raw verdict | 32,123,665 | 1,490,859 | **7.1%** |

  The hold is worth 6.5× the green energy and 3.2× the churn. Two details make it work
  with no new state: the far end is the *first* hit, which `mark2a` publishes by
  overwriting its own leaf `hitPosition` slot (four attributes is the whole budget,
  §V588), and it is deliberately live while the near end is held — the first hit is a
  smooth function of azimuth, so the beam's base creeps while its tip stays put. And the
  predicate carries `p.spoke` as well as `p.wake.w`: an attribute a pointKernel does not
  *declare* still flows through the pointset, so the every-tenth subset reaches this draw
  for free. Drop that half and all 240 legs draw, the basin becomes green spaghetti, and
  it is T681's picture exactly.
- **Only bright things trail, and where the threshold sits is a measurement.** `hot1`
  thresholds *luminance* off the scene, `stain1` multiplies the colour back through the
  mask, and `smear1` + `trail1` are the loop. The tuning question is where the threshold
  sits relative to the pool-lit ground, and it is answered with a number: rendered with
  the marks, beams and echoes taken out of the Scenes list, the terrain — moonlit *and*
  lit by its own impact pool — tops out at **linear luma 0.102**. Threshold 0.16 with
  softness 0.10 is a smoothstep across 0.11 … 0.21, so the transition's *foot* is above
  the brightest ground there is: the ground contributes exactly nothing and everything the
  eye reads as a glow trails. The loop is bounded by arithmetic rather than by hope
  (§V631): steady state is injection ÷ (1 − 0.90), so an injection gain of 0.05 settles at
  half the source at a mark that holds still; gain is positive and below one, so it
  converges without the sign alternation §V630's oscillator needs. Checked over a long
  window, not a short one — `smear1`'s own alpha reads [0, 0.47] at frame 60 and
  [0, 0.50] at frame 800, and the sink's stays inside [0, 1].
- **Only one ray in ten is drawn, and that is measured rather than chosen.** `aim1`
  writes a third attribute, `spoke`, and the beam geometry's group predicate reads it, so
  every ray is still cast and only every tenth is drawn. At 240 the beams fuse into a
  solid opaque cone that hides the terrain completely. The `taper` is the other half of
  the same problem: beams sharing one origin fuse *at the origin* whatever their number,
  and pinching the near end to a point is both the cure and what a divergent beam does.
- **The ground is lit by its own returns, through the albedo map** — and the mapping is
  the same agreement, stated a second time. `pool1` parks each return at clip
  `(X/extent, −Z/extent)`, `poolmap1` splats it additively, and `poolbase1` — a Level with
  its black point at −0.1 and its white at 0, which is how you say *add one* — turns the
  splat into a multiplier the terrain's albedo can wear. It has to be `1 + pool` and not
  `pool`, because albedo *multiplies*: a map that read zero anywhere would black the
  terrain out there (§V644). Why that exact clip mapping: the surface samples its map by
  grid uv, grid v runs along world Z, and `renderPoints` draws at clip xy where +1 is the
  top of the picture and therefore texel row 0 and therefore v = 0. Compose those three
  and the minus sign comes back out — the same minus `unfold1` needs, for the same reason.
- **The echoes stopped scintillating when the relocation moved out of sight, not when the
  smoothing got stronger.** Round two's `wake` was the right state and the wrong end of
  the problem. The second leg's landing point is a *chaotic* function of azimuth — colour
  each echo by the index of the ray that made it and the primary ring is a smooth colour
  wheel while the echoes are scrambled, adjacent rays landing metres apart — so a marker
  that adopts a new hit every frame it qualifies **teleports while lit**, constantly.
  `mark2a` now takes a new reading only while it is already dark (`p.wake.w < 0.06`): it
  lights at a place, holds still, fades, re-arms. A display's phosphor. Measured with the
  camera frozen, so nothing but the reading can change: the green band's frame-to-frame
  energy falls **873,292 → 53,657** and its hard-flip rate **39.1% → 6.6%**, which is
  below the amber band's own. Every tail remedy was tried first and is in the file's
  history for a reason: position lag made it *worse* (2,386,000 — a lagged marker smears
  across more pixels), a lagged rise moved 4.5%, and decay 0.90 → 0.98 moved the hard-flip
  rate 39.1% → 34.7%. **The churn was births, not the tail.**
- **Per-ray aiming is what makes Ray a POP.** `aim1` writes a vec3f `direction`
  attribute — azimuth from the point's own index, the ring's tilt breathing on a driven
  Value slot — and the Ray node reads it instead of its Direction parameter. A grid of
  downward rays would be a heightmap lookup; a cloud of independently aimed rays is an
  instrument.
- **One texture, two mappings, made to agree.** The terrain the camera sees and the
  field the rays march are the *same* carved texture. The bridge samples at clip xy with
  v inverted; the Ray maps world x,z over 2·extent with no inversion — so `unfold1`
  parks the sample sheet at `(X/extent, −Z/extent)`, and the minus sign is the whole
  agreement. Get it wrong and the scan drapes over a terrain the picture mirrors
  front-to-back: plausible at a glance, wrong everywhere.
- **The stretch is measured, and measured in the right space.** Four perlin harmonics
  sum to a sliver (≈0.36–0.61 *linear* here), so `carve1` stretches it to full range
  once, on the texture both readers share (E27's lesson). The window is stated in
  linear because the ray and the mesh read the target raw — an early read of the same
  numbers *through the Output node* came back display-encoded and off by a whole
  transfer curve, which is §V56's trap with a survey mast on top.
- **The clamp under the bloom is load-bearing.** Level is a signed pipeline: below its
  black point it emits negatives, the blur spreads them, and `add` then *subtracts* the
  halo from the picture — on a night scene almost everything sits below the threshold,
  and the un-clamped chain blacks out the entire film. `clip1` pins the floor at zero
  before the blur ever sees it.
- **Reflection, literally.** Two chained Ray nodes: `ricochet1` re-origins each hit a
  hair along its `hitNormal` and reflects the direction; `rebound1` casts again. The
  first leg's verdict crosses the second cast as a *parked position* rather than a
  carried flag — every declared attribute costs a read-and-write pair against the
  WebGPU baseline of 8 storage buffers per stage, so four attributes is the whole
  budget; the budget shaped the design, and the file says so where it happens.
- **The relief reads in the hit/miss frontier.** `maxDistance` is deliberately shorter
  than the shallow ring's slant, so as the ring breathes it *crosses* the range
  boundary — and ridges, being nearer, come into range before valleys. The hit/miss
  split is not decoration; it re-draws the terrain's own shape in the air. It has to be
  shorter at the *shallow* end and long enough at the *steep* one, which is the squeeze
  the range constant lives in.
- **Lit by the whole stack that landed today.** The ground is a rough dielectric under
  a shadowed cool key and an equirect night sky: the Fresnel term rims the ridges at
  grazing, and the diffuse irradiance half fills the valleys the key never reaches —
  unplug the environment wire and the valleys go black. The returns themselves are
  unlit emitters (`materialUnlit` × per-point tint), which is what a display's dots are.
- **The sky is the same map that lights the scene** (T659). `showEnvironment` on the
  render draws `skyband1` as the background along a camera ray per pixel. Before it,
  `sampleEnvironment` had exactly two readers — the reflection vector and the five
  irradiance taps — and *no pass drew it*, so the visible night was the Background
  colour and retuning the ramp moved the fill and the rim and never the sky. The
  switch is off by default; this is the only shipped example that opts in.
- **An unlit surface casts no shadow** (T666/§V617). The returns are unlit, so they
  do not block the moon. They used to: 480 octahedra threw hard, texel-quantised fins
  down every grazing slope, which was the entire visible shadow content of this scene
  and read as black combing nobody could attribute to anything in frame.

## Three readings of one cast

Returns (hot yellow, brightness 1 − distance/range), out-of-range (faint steel dots at
the ray ends), echoes (green, both legs landed). Since T642 the echo reading is a real
**group predicate on the geometry node** — `p.wake.w > 0.03` since T658, the second
leg's own verdict before that —
§V471's selection idiom running in the lit path through the shared camera and depth
buffer, the same resolver `renderPoints` uses (same zero-area collapse, and the depth
pass gates too, so an excluded echo casts no ghost shadow) — and this file now runs
**both halves** of that resolver, since the light pool is a `renderPoints` draw into a
texture. This file
originally shipped days earlier with a *parked-position cull* instead — the kernel
moved non-echoes to y = −80 and zeroed their tint, because the seam did not exist yet —
and the migration deleted exactly that select and that multiply while rendering a
byte-comparable frame. The returns/out-of-range split stays a tint class on one
geometry deliberately: both classes are *drawn*, differing only in colour, which is
what a tint is for. The *beams* went the other way, and the seam is the reason: a beam
whose ray got no return has nothing to say, and recolouring it was measured at 0.4% →
11.3% green hard-flip because the class boundary itself oscillates. A tint class is
right when both classes are worth drawing; when one of them is an absence, it is a
predicate.

## What to look at

- The scan ring **draping** over ridges — the march finding the surface, visibly.
- The breathing boundary where amber returns give way to steel out-of-range dots, and
  how ridgelines punch through it first.
- Kill `e-skyband-shot` and watch the valleys die: that is the diffuse irradiance term
  working, not `ambientIntensity`.
- `cast1.steps` — THE cost knob (steps × points per frame). At 8 the drape starts
  tunnelling through thin ridges; 64 is honest for this relief.
- The **wake**: set `mark1`'s lag rates to 1.0, or `mark2a`'s decay to 0.0, and watch
  the readings start blinking again. A ray's verdict is binary, so a ray sitting on the
  range frontier flips it every frame; the smoothing therefore has to be *temporal and
  on the reading*, never a blur on the picture. The same state that stops the blinking
  is what leaves a fade behind a moving return — the trail and the smoothing are one
  mechanism, not two.
- The **beams**, and what they explain: set `rays1`'s group predicate to empty and watch
  240 of them fuse into an opaque cone; set `taper` to 1 and watch the apex become a solid
  wedge. Both failures are why the two knobs exist.
- The **colour agreement**: put a flat colour back on `haze1` and the beams stop belonging
  to the marks they make — they read as scaffolding rather than as the cause. Then put
  that colour *below* 0.42 and watch them stop glowing entirely, which is the bloom knee
  and not a lighting change.
- The **drop**: delete the `select` on `sight1`'s last line and every ray draws to its
  full range whether it found anything or not, which is a picture of hits that did not
  happen. Recolour that class instead of dropping it and the frame starts blinking, which
  is the measurement in the bullet above.
- The **contraction**, and its price: raise the tilt span past ~0.62 without raising
  `LIDAR_RANGE` with it and the middle of the ring goes out-of-range steel — the shot no
  longer reaches the basin floor. The two constants are one decision.
- The **trail**: drop `hot1`'s threshold under 0.10 and the whole lit hillside smears,
  because that is where the pool-lit ground actually tops out; raise it past 0.40 and only
  the 0.7% of the frame that is core survives. And set `trail1`'s persistence to 1.0 to
  see §V631's other half: the loop stops decaying and the picture accumulates without
  bound.
- The **light pool**: kill `e-poolbase-basalt` and the ground under the ring goes back to
  the same blue-grey as the far hills. That is the returns lighting their own terrain, and
  it is an albedo map rather than 240 lights.
- The **hold**: set `mark2a`'s re-arm threshold to 1.0 and the echoes go back to adopting
  a new hit every frame they qualify — which is round two's behaviour, and it
  scintillates. Note that a *still* frame looks the same either way; this one only shows
  up in motion, which is why it is asserted rather than eyeballed.

## Editing the camera

**The orbit radius is not in the camera.** `eye1.eye.x` and `eye1.eye.z` are *driven*
by `orbx1`/`orbz1`, so the static vector's x and z are inert (§V465) and changing them
to reframe the shot is a silent no-op that looks like a fix in the diff. The radius is
the two LFO amplitudes, and it is deliberately smaller than the terrain's half-extent:
the camera orbits *inside* the plate's footprint, which is what keeps the sheet's
straight rim — a finite square seen edge-on — out of the frame.

`lookAt` **is** live, unlike `eye.x` and `eye.z`: it is what puts the beams' convergence
just above the frame, and it was checked at all eight of the orbit's worst angles (edges
at frames 0/790/1579/2369, corners at 395/1184/1974/2763) because raising it tilts the
camera up and could have re-exposed the plate rim that round two spent its time removing.

## The numbers, and where they were measured (§V641)

Both halves of the pair were re-measured back to back on **one** engine tree, so the
comparison is not an argument:

| | |
|---|---|
| "before" | E34's entry as shipped at `5979367` (T672) |
| "after" | the T711 rework, same engine tree, measured minutes apart |
| method | camera frozen (`orbx1`/`orbz1` frequency 0), 15 frame-pairs, full 1280×720 (§V627), display-encoded (§V618) |

Two windows, because one of them is a lie on its own: frames 400–415 sit near the tilt's
**steep** peak where nearly every ray lands, and 1000–1015 near its **shallow** one where
the ring is crossing the range frontier. A rework that touches the frontier has to be
measured on both sides of it.

| band | before (f400) | after (f400) | before (f1000) | after (f1000) |
|---|---|---|---|---|
| total energy | 7,893,812 | 20,512,226 | 14,085,425 | 11,614,846 |
| green energy | 671,113 | 3,532,722 | 1,401,545 | 828,223 |
| green hard-flip | 0.4% on 170,950 px | 0.7% on 407,602 px | 0.1% on 117,513 px | 0.1% on 163,153 px |
| amber energy | 6,553,801 | 16,060,790 | 12,575,883 | 10,100,270 |
| amber hard-flip | 0.4% on 637,799 px | 0.5% on 1,905,680 px | 0.2% on 501,006 px | 1.0% on 1,031,816 px |
| halo energy | 668,898 | 918,714 | 107,996 | 686,353 |

Energy is up at the steep end and down at the shallow one, and both are the point: ten
bright ribbons now sweep where twenty-four dull ones used to sit, and the misses that used
to be drawn full-length are gone. **Churn is the number that had to hold, and it did** —
and the trail is why. Without it the same picture reads 2.9% amber hard-flip at f400 and
4.5% at f1000; with it, 0.5% and 1.0%, at 1.6% *less* total energy. Trails add
frame-to-frame correlation, so they buy churn; here they paid for themselves in energy as
well, because raising the floor around a bright thing shrinks the delta at its edges.

Both halves were re-measured back to back on **one** engine tree, so the comparison is not
an argument. The T672 pass's own numbers, on its own tree, are in this file's history; do
not compare across the two, because the baseline moved (§V641).

The liveness figures this document is gated against live in `look-baselines.json` (§V643),
re-measured in the same commit as this rework: motion 0.0925 → **0.108**, range 0.9821 →
**0.9978**, f0max 0.7317 → **0.8528**. The motion move is +16.8% against a band of
max(10%, 0.003), so the gate would have reddened had the row not moved on purpose.

Also measured and **rejected**, so nobody re-tries them:

- deriving the bounce off a normal smoothed toward +Y, which kills the echo count to
  **zero** at k = 0.55 and k = 0.80, because echoes exist precisely because shallow rays
  reflect forward off back-slopes and straightening the normal sends leg two into the sky
  (§V639);
- **fading** a non-returning beam out at max range — a beam is opaque geometry, so a faded
  beam is a black ribbon over the terrain, not an absent one (§V668);
- **recolouring** the non-returning beams, which takes the green band's hard-flip rate from
  0.4% to 11.3% because the class boundary is what oscillates;
- **retracting** a non-returning beam toward the mast, which leaves stubs hanging in the
  air and breaks the one thing the beams exist to show — that this ray made that mark;
- tilt span past ~0.62 without raising the range with it: the ring contracts past what a
  3.9-unit shot can reach and its middle turns out-of-range steel.

**Un-rejected, and this is the one worth reading:** drawing the bounce leg was rejected by
measurement in T672 (green energy 873k → 1,399k, "the segments pop in and out with the raw
verdict and have no persistence to inherit") — and that conclusion was true of a tree that
did not yet have sample-and-hold. Re-measured on this one, with the beam inheriting the
same hold, it wins. A measured rejection is evidence about the tree it was measured on and
about nothing else.
