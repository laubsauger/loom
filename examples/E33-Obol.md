# E33 — Obol

A yin-yang medallion stands on its rim on a dark studio sweep, lit by two softboxes it
can see in itself. Its dividing curve softens first; the seam flows, the faces lose
their edges, and in a few seconds the emblem is a slick black blob that sags and
breathes. Then it runs backwards and the medallion re-forms. One sixteen-second breath,
both directions, forever.

**The morph is a deformation with a FRONT, not a cross-fade.** Every point carries two
places — one on the medallion, one on the goo — and a single kernel decides how far
along each point has travelled, from its own distance to the emblem's dividing curve.
A cross-fade at 50% shows a ghost of both pictures. This shows a medallion whose middle
has already gone liquid while its rim is still a hard, lit edge.

## Graph

```
  ramp ─────┐
  circle ───┤ add ──────────────────► render.environment
  circle ───┘ (studio1)                    ▲
                                           │
  pointTube ── pointKernel ── geometry ────┤        ┌─ level ─ limit ─ blur ─┐
   (grid:208x160:wrapU)  (morph1)  (body1) │        │                       │
                                           ├── render ──────────────────────add ── output
  pointGrid ── pointKernel ── geometry ────┤   (shot1)                       │
   (grid:64x96)          (sweep1)  (cyc1)  │      ▲  ▲                       │
                                           │      │  └── camera (eye1)       │
                                           └──────┴───── 3 lights            │
                                                                             │
  lfo tide1 ─┬─ multiply ─ add ─► render.aoIntensity        (and the render's own
             ├─ multiply ─ add ─► render.environmentIntensity  output feeds `in1`)
             └─ multiply ─ add ─► materialPhong.roughness
  lfo tide1 ────────────────────► pointKernel.value1  (the morph)
  lfo sheen1 ───────────────────► pointKernel.value2  (the spectrum's phase)
  lfo swing1, lift1 ────────────► camera.eye.x, camera.eye.y
```

| Node | Type | Doing |
| --- | --- | --- |
| `shell1` | `pointTube` | 208 x 160 points with **wrapU**, so the longitude seam closes and the surface has no slit. The kernel overwrites every position; only the topology matters here |
| `morph1` | `pointKernel` | the whole piece. Two configurations, the melt order, the two tones and the front's spectrum |
| `oil1` | `materialPhong` | shininess 300, roughness driven 0.190 → 0.085. White base colour: the colour is the per-point tint |
| `body1` | `geometry` | surface mode, `tint` in **map** mode bound to the kernel's `tint` attribute (T478) |
| `sweep1` | `pointKernel` | bends a flat 64 x 96 grid into a cyclorama — flat to z = −2, then rising 11 units over the next 13 |
| `shot1` | `render` | three lights, an equirect environment on a wire, `ambientOcclusion` on at quality **high** |
| `cut1`/`clip1`/`veil1`/`bloom1` | `level`/`limit`/`blur`/`add` | the bloom, with the clamp that makes it work (see below) |

## What it took from §V471, and where

- **§V471.1/.2 — the kernel writes what selection reads.** Corona splits one cloud
  three ways with a group predicate over an attribute its kernel wrote. This surface is
  one object, so the split is a per-point tint rather than three draws — but the
  mechanism is the same and the attribute is the same kind of thing. `order` is the
  emblem's own geometry: distance to the two circles the S-curve is built from, blended
  with radius. It decides the colour AND the order things melt in, and it costs nothing
  to compute because the shape already knows it.
- **§V471.3 and §V477 — gain and bias per band.** One source (`tide1`) drives three
  properties, each through its own multiply→add pair rather than one shared knob:

  | target | gain | bias | travels | declared range |
  | --- | --- | --- | --- | --- |
  | `render.aoIntensity` | 0.90 | 0.55 | 0.550 → 1.450 | 0 … 2 |
  | `render.environmentIntensity` | 0.85 | 1.00 | 1.000 → 1.850 | 0 … — |
  | `materialPhong.roughness` | −0.105 | 0.190 | 0.190 → 0.085 | 0 … 1 |

  Each rests where the eye expects calm — a hard emblem with few creases, a moderate
  reflection, a slightly duller finish — and travels toward the interesting end as the
  thing turns to fluid. `ranges.ts` reports **CLEAN**: every achievable span fits its
  target's declared range.
- **§V471.6/.8 — a ramp that goes somewhere, on a long cycle.** Six stops — midnight,
  indigo, violet, magenta, amber, gold — worn by the melt FRONT only, so the emblem's
  own two tones stay intact behind it. Its phase turns on a 0.011 Hz LFO: 91 seconds a
  lap. **Unlike the file §V471.8 was measured from, this one travels.** `lfoValue`
  returns `offset + amplitude·wave` in the TARGET's units, and the target here is
  `ctx.value2` — a unitless kernel value read through `fract` — so amplitude 0.5 with
  offset 0.5 is exactly one full rotation of the ramp. `t560-ranges.ts` measures the
  span as `0.000..1.000`, not as a default.

## Three things that had to be arithmetic, not taste

**A flat medallion seen dead-on is pixel-identical to a sphere.** The first build had
the coin facing the camera and every look pass read it as a ball, because in silhouette
it *is* one. The emblem is tilted 17° about x, which puts the rim bevel on screen as a
lit edge, and the camera's own swing rests off-axis rather than at zero. Nothing about
the geometry changed — only whether you can see what it is.

**Distance to the dividing curve has a conical local maximum at each dot.** Raw
`min(|d₁|, |d₂|)` peaks at the centre of each of the two dots, so each dot was the last
thing left un-melted and got pulled out into a literal spike with a specular on it. The
fix is two-part and both parts are needed: cap the distance at 0.42 so those peaks
become plateaus, then blend 40% of the plain radius in so the front has a global
outward sweep and there is no interior maximum for the surface to be drawn towards.

**A Level's black point is a subtraction — §V510, paid for again.** The bloom's
threshold is a `level`, and on a float target it sends the whole background to
`(0.0006 − 0.80) / 0.5 = −1.6`. `add` is front + back, so the first build of this chain
subtracted a constant −1.6 from the finished frame: the picture came back BLACK with a
blown-out object floating in it, and the render itself was perfect. `limit` in clamp
mode is the node that was missing. E4 records the same pairing; it cost this file a
build anyway.

## What "ambient studio lighting" needed, and what it did not

**It did not need an area light.** The catalogue has directional and point lights only,
and the visually load-bearing part of a softbox on a slick surface is its REFLECTION —
which arrives through the environment input. The two ellipses in the equirect (a wide
thin one at u 0.46, a tall narrow one at u 0.715) are the softboxes, sampled along R by
the phong path and scaled by (1 − roughness). What an area light would still add is a
soft shadow edge and a diffuse wrap; the cast shadow here is hard, and that is recorded
rather than hidden.

**It did need a POINT light.** Directional lights do not fall off, so three of them
paint a cyclorama one flat grey and the piece reads as a model on a card table. The
`crown1` light is a point light at (0, 2.90, −3.40) with intensity 14, which the
1/(1 + d²) attenuation eats down to about 0.6 at the object and about 0.15 in the
corners of the frame. The gradient on the backdrop is that ratio and nothing else.

**And it needed a cyclorama, not a floor.** A floor ends, and its far edge lands inside
a 42° frame as a hard horizon with black above it. The same grid curved up into a cove
removes the horizon entirely — and is sized against the frustum at the deepest row,
because an 8-unit rise was still leaving a dark arc in the top corner at the camera's
widest swing.

## Ambient occlusion (T624), and how much of it you can actually see

This is the first example to switch on the render's `ambientOcclusion`. It is one
parameter on `shot1` — not a per-geometry opt-in — and both the medallion and the
cyclorama are occluded by each other with nothing else to configure (§V437).

**Honest measurement.** With AO on against AO off, at the full-goo frame, the largest
darkening anywhere in the frame is **0.045** in linear luminance and the mean absolute
difference is **0.00137**. It lands where it should — a contact crescent where the blob
meets the sweep, and the folds between lobes — and it is a subtle effect here, because
AO multiplies the AMBIENT and ENVIRONMENT terms only and this scene also carries three
direct lights and a strong specular. That restriction is deliberate: occlusion is about
the light that arrives from everywhere, and a key light arrives from one direction
whether or not the neighbourhood is enclosed. An AO that darkened direct diffuse would
look stronger and be wrong.

The capability itself is pinned somewhere the numbers are unambiguous:
`scene-ao.gpu.test.ts` renders a V-shaped groove with no lights and ambient 1.0, so the
lit result is exactly `albedo × occlusion`. Mid-wall, where the surface is planar, the
byte is **204 with AO on and 204 with AO off**. In the crease it is **146**.

## Clock

The kernel reads `ctx.absTime` only — the goo's field, its turn, its drift and the
object's yaw all ride the absolute clock, so nothing snaps at a timeline lap (§V437).
The morph, the spectrum phase and the camera ride LFOs, which are free-running for the
same reason. There is no feedback loop in this file, so §V501's warning about from-black
captures does not apply and §V533's resolution trap has nothing to catch.

**The yaw is a gate, not a flourish.** Every other motion in this piece arrives through
the value graph, and the cook oracle (T249) renders each example with no channel
resolver — so the first build of this file hashed all eighty of its oracle frames
identical and failed on `new Set(always).size > 1`. That is not a harness artefact: an
idle value graph in the app produces the same still picture. A 12° sway on the absolute
clock fixes it at the source, and it is also what keeps the softbox reflections
travelling across the surface.

## Regression signatures

- **The frame is black and the object is blown out** → the bloom's `limit` is gone or
  its `low` is below zero. §V510: a Level's black point subtracts.
- **A dotted crescent across the lit half of the medallion** → the shadow bias went
  back to a constant. Depth per shadow texel grows as 1/|N·L|, and every curved object
  has a terminator.
- **The dots grow spikes as it melts** → the melt order lost its cap, or its radius
  term. Both halves of that fix are load-bearing.
- **The emblem reads as a ball** → the tilt is zero, or the camera swing rests at zero.
- **Concentric arcs near the rim in the reflection** → the sphere lost rows. The
  environment reflection amplifies normal quantisation, and the latitude rows crowd
  exactly where the bevel is steepest.
- **A dark arc in a top corner** → the camera swung past the edge of the cyclorama.
- **The oracle hashes every frame the same** → the object lost its absolute-clock yaw
  and the piece is value-graph-only again.
- **The goo reads as crumpled tinfoil** → the fbm's octave weights drifted toward the
  high end. Radial high-frequency displacement on a closed surface makes creases, not
  fluid.

## Look pass

Dawn, headless, `animate: true`, 1280×720, frames 0 / 180 / 340 / 484 / 620 / 750 / 968
— which covers the emblem, the melt out, the full goo and the re-form, in both
directions. Output space read off the plan (§V470), not assumed.

Gate numbers at 192×108: **motion 0.01191** (floor 0.002), **range 0.7419** (floor
0.30), **frame-0 max luma 0.7621** (floor 0.02). No exemption declared; none needed.
Frame 0 is the fully formed emblem on purpose — the gallery card is frame 0 (T535).

`t560-ranges.ts`: **CLEAN**, seven driven chains, zero `parameter.range` problems.

**Beauty (§V420/§V427).** It ships, and with one reservation stated rather than hidden:
the emblem state and the transition are the strong part — the S-curve lifting off a
still-hard rim is the picture this file exists for — while the fully-melted state reads
closer to wet chrome than to oil. That is a limit of the shading model rather than of
the tuning: an IBL-lite reflection along R with no Fresnel term cannot make a dark
dielectric go glassy at grazing angles, which is the exact thing that separates oil
from metal.
