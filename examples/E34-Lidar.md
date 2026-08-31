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

skyband(ramp) ─► shot(render) ◄─ ground · impacts · echoes · eye(camera) · moon(light)
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

## Three readings of one cast

Returns (hot amber, brightness 1 − distance/range), out-of-range (faint steel dots at
the ray ends), echoes (cyan, both legs landed). These are kernel-written **tint
classes** plus a parked-position cull — *not* `renderPoints` group predicates: the lit
scene path has no predicate seam (T642 tracks whether it should grow one), and a
predicate-filtered 2D overlay under its own projection cannot sit on a 3D camera's
picture. Until T642 decides, tint-classes are the workaround here, not the idiom.

## What to look at

- The scan ring **draping** over ridges — the march finding the surface, visibly.
- The breathing boundary where amber returns give way to steel out-of-range dots, and
  how ridgelines punch through it first.
- Kill `e-skyband-shot` and watch the valleys die: that is the diffuse irradiance term
  working, not `ambientIntensity`.
- `cast1.steps` — THE cost knob (steps × points per frame). At 8 the drape starts
  tunnelling through thin ridges; 64 is honest for this relief.
