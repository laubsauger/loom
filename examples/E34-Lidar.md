# E34 — Lidar

A night survey. A mast at the origin sweeps a ring of 240 rays over a dark terrain;
where a ray lands, a hot return beads onto the relief, where it runs out of range it
hangs in the air, and where it lands it also *bounces* — a second cast, reflected off
the surface normal, drops cyan echoes across the valley. The Ray POP, working for its
living.

## Graph

```
relief(noise) ─► carve(level) ─┬─► probe(textureToAttribute) ─► raise(pointKernel) ─► ground(geometry)
                               │        ▲ sheet(pointGrid) ─► unfold(pointKernel)
                               ├─► cast(pointRay) ◄─ aim(pointKernel) ◄─ fan(pointLine)
                               │        ├─► mark(pointKernel) ─► impacts(geometry)
                               │        └─► ricochet(pointKernel) ─► rebound(pointRay) ─► mark2(pointKernel) ─► echoes(geometry)
                               └───────────────────────────────────▲ (field)

skyband(ramp) ─► shot(render) ◄─ ground · impacts · echoes · eye(camera) · moon(light) · lamp(light)
shot ─► cut(level) ─► clip(limit) ─► halo(blur) ─► glow(add) ─► out(output)
```

## What it proves

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
buffer, exactly as `renderPoints` runs it (same resolver, same zero-area collapse, and
the depth pass gates too, so an excluded echo casts no ghost shadow). This file
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

## Editing the camera

**The orbit radius is not in the camera.** `eye1.eye.x` and `eye1.eye.z` are *driven*
by `orbx1`/`orbz1`, so the static vector's x and z are inert (§V465) and changing them
to reframe the shot is a silent no-op that looks like a fix in the diff. The radius is
the two LFO amplitudes, and it is deliberately smaller than the terrain's half-extent:
the camera orbits *inside* the plate's footprint, which is what keeps the sheet's
straight rim — a finite square seen edge-on — out of the frame.
