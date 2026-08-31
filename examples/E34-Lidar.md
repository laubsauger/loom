# E34 — Lidar

A night survey. A mast at the origin sweeps a ring of 240 rays over a dark terrain, and
one ray in ten is *drawn*: a beam from the mast down to whatever it found. Where a ray
lands, a hot return beads onto the relief and pools light onto the ground under it; where
it runs out of range it hangs in the air; and where it lands it also *bounces* — a second
cast, reflected off the surface normal, drops cyan echoes across the valley. The Ray POP,
working for its living.

## Graph

```
relief(noise) ─► carve(level) ─┬─► probe(textureToAttribute) ─► raise(pointKernel) ─► ground(geometry)
                               │        ▲ sheet(pointGrid) ─► unfold(pointKernel)
                               ├─► cast(pointRay) ◄─ aim(pointKernel) ◄─ fan(pointLine)
                               │        ├─► rays(geometry · BEAM)
                               │        ├─► mark(pointKernel) ─┬─► impacts(geometry)
                               │        │                      └─► pool(pointKernel) ─► poolmap(renderPoints)
                               │        └─► ricochet(pointKernel) ─► rebound(pointRay) ─► mark2(pointKernel) ─► echoes(geometry)
                               └───────────────────────────────────▲ (field)

poolmap ─► poolsoft(blur) ─► poolbase(level) ─► basalt.albedo        the ground LIT by its returns
skyband(ramp) ─► shot(render) ◄─ ground · impacts · echoes · rays · eye(camera) · moon(light) · lamp(light)
shot ─► cut(level) ─► clip(limit) ─► halo(blur) ─► glow(add) ─► out(output)
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
  split is not decoration; it re-draws the terrain's own shape in the air.
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

Returns (hot amber, brightness 1 − distance/range), out-of-range (faint steel dots at
the ray ends), echoes (cyan, both legs landed). Since T642 the echo reading is a real
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
what a tint is for.

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

| | | |
|---|---|---|
| engine tree | `d8ed47e` | |
| "before" | E34's entry as shipped at `83e03ff` (T658) | |
| "after" | the T672 design, same engine | |
| method | camera frozen (`orbx1`/`orbz1` frequency 0), 15 frame-pairs over frames 400–415, full 1280×720 (§V627), display-encoded (§V618) | |

| band | before | after |
|---|---|---|
| total energy | 1,386,519 | 727,237 |
| green energy | 873,292 (63.0%) | 53,657 (7.4%) |
| green hard-flip | 39.1% on 9,502 px | 6.6% on 3,730 px |
| amber energy | 205,286 (14.8%) | 626,612 (86.2%) ← the beams' own sweep |
| amber hard-flip | 7.7% | 6.0% |
| halo energy | 307,942 | 46,968 |

The liveness figures this document is gated against live in `look-baselines.json` (§V643),
which was re-measured in the same commit as this rework.

Also measured and **rejected**, so nobody re-tries them: drawing the bounce leg as a
second beam set (green energy 873k → 1,399k — the segments pop with the raw verdict and
inherit no persistence); deriving the bounce off a normal smoothed toward +Y, which kills
the echo count to **zero** at k = 0.55 and k = 0.80, because echoes exist precisely
because shallow rays reflect forward off back-slopes and straightening the normal sends
leg two into the sky (§V639).
