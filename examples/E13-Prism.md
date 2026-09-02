# E13 — Prism

A triangular block of glass in deep black, drawn entirely by the light caught on its edges.
A white beam enters low from the right and a spectrum fans out to the left.

The fan opens and closes as the beam swings, because the fan is Snell's law and not a
drawing.

The optics are a TRACED RAY (T718): the shaft meets the entry face, a visible internal
segment crosses the body at the refracted angle — which is neither the incoming nor the
outgoing one — and the fan opens at each wavelength's own exit point. Past the critical
angle a band reflects at the exit face, crosses to the base and Snells out *there* —
total internal reflection is a path, not a deletion. The BODY wears T725's `materialGlass`
since T758: it is transmissive, so the traced interior segment is seen *through* the front
face, and its Schlick fresnel against the environment carries the same thin bright rim
along every silhouette that the phong `envFresnel` used to — same physics, different name.

The aim has two hands on it (T857). A square LFO swings it between two angles; a moving
cursor **takes** it, across a much wider range, and gives it back a couple of seconds after
you stop — including far enough to walk the beam off the end of the glass entirely.

## Graph

```
bar1(pointTube) ─► form1(pointKernel) ─► solid1(geometry) ─┐
glass1(materialGlass) ─────── by name ────────────────────┘  the glass (T758)
                                                              │
spectrum1(ramp) ─► optics1.field                              │
optics1(pointKernel) ─┬─► shaft1(geometry)  p.role < 0.5      ├─► shot1(render)
                      └─► fan1(geometry)    p.role > 0.5      │
flare1(materialUnlit) ────── by name ─────────────────────────┤
                                                              │
sky1(ramp) ──┐                                                │
band1(circle) ┴─► studio1(add) ─► shot1.environment           │
key1(light), eye1(camera) ──── by name ───────────────────────┘

shot1 ─► cut1(level) ─► clip1(limit) ─► halo1(blur) ─► glow1.in2
shot1 ────────────────────────────────────────────► glow1(add) ─► out1(output)

swing1(lfo, square) ─► ease1(valueLag) ┄drives┄► optics1.value1     the aim, auto
mouse1 ─► follow1(valueLag) ┄drives┄► optics1.value3                the aim, by hand
follow1 ─► stir1(valueSlope) ─► urge1(valueMath) ─► hold1(valueLag)
                              ┄drives┄► optics1.value4              which one (T857)
drift1(lfo, sine) ┄drives┄► eye1.eye.x
fan1.tint ← the `tint` attribute                                    the map mode
```

| Node | Type | Doing |
| --- | --- | --- |
| `bar1` | `pointTube` | a 240×45 grid with its u seam closed — the topology a prism's lateral loop needs |
| `form1` | `pointKernel` | walks a **rounded** triangle by arc length and puts a quarter-round on each cap edge |
| `glass1` | `materialGlass` | the T725 transmissive surface (T758): ior 1.5, gentle absorption, dispersion 0.06 — the body SAMPLES the frame behind it, and its Schlick fresnel against the environment carries the rim |
| `solid1` | `geometry` | `mode: surface` |
| `spectrum1` | `ramp` | seven stops, red → violet. The kernel samples it at `u = t`, and `t` is also the refractive index |
| `optics1` | `pointKernel` | Snell's law twice per band, 61 bands, plus the shaft and its reflected ghost |
| `stir1`, `urge1`, `hold1` | `valueSlope`, `valueMath`, `valueLag` | the pointer's AUTHORITY (T857): how fast the cursor is moving, squared to make it unsigned, through an envelope that rises in 0.02 s and falls over 0.6 s |
| `shaft1` | `geometry` | `mode: beam`, taper 1 — a parallel-sided ribbon |
| `fan1` | `geometry` | `mode: beam`, taper 0.06, **tint mapped per point** |
| `sky1`, `band1` | `ramp`, `circle` | the equirect: near-black, with a bright band on its horizon at (0.5, 0.5) |
| `key1` | `light` | one directional, aimed to put a glint on one edge and nowhere else |
| `cut1 → clip1 → halo1 → glow1` | post | the bloom, with the clamp that is load-bearing |

## What it proves

### The rim is Fresnel at grazing, and the geometry is built for it

§V640 records both halves of the mechanism: a Fresnel term rises to 1 at grazing, so a
bright band on the equirect's horizon shows up as a rim — **and it does that only on
geometry that curves away.** On a flat camera-facing surface there is barely any grazing
for the term to find, and the same band becomes fill. T758 swapped which Fresnel: the
body wears the T725 glass material now, whose Schlick term against the same environment
peaks at grazing exactly as the phong `envFresnel` did — same physics, and the same
§V640 ring/interior gate measures it. What the glass ADDS is transmission: the T718
interior segment lives inside the body's depth since this change, so the thread is seen
*through* the front face — absorption-warmed — and the rounded edges refract the beams
into dispersion fringes that move with the aim.

So `form1` builds a shape that curves exactly where the light is wanted. The cross-section
is a rounded triangle walked by **arc length** — three straight runs joined by three 120°
arcs — and the profile puts a quarter-round where each flat cap meets the barrel. Along a
straight run, the surface renderer's central difference is collinear, so the face normal is
*exactly* constant and the faces stay flat and black. Across an arc the normal sweeps 120°,
and somewhere in that sweep it passes through grazing. A thread of surface at grazing
therefore runs the whole way round the triangle, from any camera.

Rounding the corners does not move the faces, which is what lets the optics share the
geometry from a single constant: a rounded triangle's straight run sits at `d·cos(60°) + ρ`
from the axis, and with `d = RC − 2ρ` that is `RC/2` for **every** corner radius — a sharp
triangle's inradius.

The equirect address is not a coincidence either. A normal lying in the cross-section plane
reflects to `(0, 0, −1)`, which the equirect mapping sends to `(0.5, 0.5)` exactly — the
band's centre, which is the address §V640 gives for it. The flat cap's normal lands near
`u = 0.01` instead, outside the band. One texture, two addresses: the outline lights and
the body does not.

Measured with §V640's own instrument (environment wired against unwired, mean |Δ| split by
a 6px erosion of the prism's mask), 1280×720, display-encoded from the plan's own output
space, at commit `9d6b674`:

| | ring | interior | ratio |
| --- | --- | --- | --- |
| mean \|Δ\| with the band on vs off | **43.06** | **4.21** | **10.2× harder on the outline** |
| luma on the shipped frame | 62.7 | 6.3 | 10.0× |

For scale, the two subjects §V640 was measured on: E33's lobed goo read 45.8 / 25.9 = 1.8×
(a rim, but a soft one), and E33's flat emblem read 14.5 / 19.5 — *stronger in the body*,
i.e. fill wearing a rim's name. §V640's limit is a limit; here it is the whole design.

**Ambient is zero and the key is hard**, which is E33's lesson (§V632/T636) rather than
taste. The physical terms in this scene are a 4% head-on Fresnel on a specular of 0.86 and
a diffuse albedo of 0.0009 linear, so any ambient worth the name drowns them and the glass
goes to grey slate. `key1` does exactly one job: its direction is the mirror of the view
about the upper-left round-over's normal, so its Blinn lobe lands as a glint on that edge.
Killing it moves 8,387 pixels by more than 4 luma — it earns its node.

### The dispersion is solved, not drawn

`optics1` runs `refract` twice per band, vectorially, in the prism's own cross-section:
into the right face, across to the left face's plane, out. The refractive index runs from
1.500 at the red end to 1.585 at the violet end, and the *same* parameter `t` picks the
band's colour out of `spectrum1`. Hue and refractive index are one number, so a reversed
`n(λ)` reverses the fan and nothing else.

Exaggeration, stated: real crown glass disperses about a sixth of this. The span is
`optics1.value2`, a number this file owns rather than a constant hidden in the kernel — set
it to zero and the fan collapses to a single ray, which is what the gate asserts.

**Which way the angle actually works.** The brief for this rebuild said a more oblique
incoming beam spreads more. That is not what the arithmetic says, and the file follows the
arithmetic. Differentiating the deviation at fixed incidence:

```
dδ/dn = (sin θ3 + cos θ3 · tan θ2) / cos θ4
```

As θ1 grows, θ2 grows, θ3 = A − θ2 shrinks and θ4 shrinks with it — numerator down,
denominator up. Angular dispersion **falls** monotonically as the beam lies down on the
*entry* face, and **rises** as the internal ray approaches the critical angle at the *exit*
face. The exit face is where dispersion is made; the entry face only decides how obliquely
the ray arrives there.

Over the swing this file uses, computed and then measured on the picture (fan span at
screen column 240, commit `9d6b674`):

| aim | θ1 | computed fan | measured span |
| --- | --- | --- | --- |
| `value1 = 0` | 62° | 5.98° | 46 px |
| `value1 = 1` | 37° | 10.91° | 108 px |
| ratio | | 1.82 | **2.35** |

The measured ratio is larger than the angular one because the exit *point* swings as well
as the exit angle — the same physics arriving twice.

**The swing stops at 37° and not lower, and the reason expired.** At n = 1.585 the
critical angle is 39.1°, and θ3 reaches it at θ1 ≈ 33.7°: below that the violet end
**totally internally reflects**, which the pre-T718 optics expressed by returning a zero
vector — a band quietly leaving the spectrum. T718 made TIR a drawn *path* instead, and
§V750 says a compensation outlives its cause unless somebody goes and looks. T857 looked.
The swing keeps its 37°–62° band, because two comfortable aims are what a hold-and-slam
shutter wants; the **pointer** now runs 84° down to 6°, straight through the onset. The
violet end turns at 34.5° and the red end at 27.9°, so between them the spectrum leaves
through **two faces at once** — and below 27.9° the internal ray meets the *base* first,
mirrors there and exits the left face. That last regime carries an identity worth stating:
after a total internal reflection this cross-section returns every wavelength at exactly
θ1, so the fan stops being a fan and becomes a **sheet** of parallel rays separated by
their exit points rather than their angles.

### One source, two readings

`optics1` writes 65 points — the shaft, its ghost, the drawn internal segment, its TIR
continuation (zero-length whenever the central ray exits cleanly), and 61 bands — and two Geometries read
that one pointset through a **group predicate** (§V471's first idea, structure from
selection rather than from more nodes). The split is not cosmetic: `shaft1` wants taper 1,
a parallel-sided ribbon, and `fan1` wants taper 0.06, because 61 beams leaving the same
face within 0.03 of each other fuse into an opaque wedge at any taper above roughly zero
(T680).

**The ghost is the part that says "surface."** Not every ray enters the glass. Schlick on
the same incidence the refraction uses gives the share the entry face sends back — 4.3% at
37°, rising to 8.3% at 62° — and that share *is* its tint, so the reflected streak
brightens as the fan narrows, out of one number rather than a second knob.

### Two hands on the aim, and they do not add (T857)

`swing1(lfo, square) → ease1(valueLag) → value1` is the canonical chain, and the square is
deliberate: a square through a one-pole smoother **is** an ease. Delete `ease1` and the
beam snaps between two angles like a shutter instead of swinging.

`mouse1 → follow1(valueLag) → value3` is the pointer. What changed in T857 is how the two
*meet*. They used to be summed in the kernel — `clamp(value1 + 0.55·value3, 0, 1)` — and
the owner's report reads straight off that line: *the mouse controls get overridden by the
auto movement, the range of motion is too limited, and we can't miss the glass triangle.*
Both halves are the one wiring. A **square** LFO visits two aims and slams between them, so
the pointer was a small delta riding on a jump and never had the aim at all; and a sum of
two 0…1 terms is bounded, so no cursor position could reach an extreme, let alone aim the
beam past the glass.

So the kernel **mixes** them, weighted by whether a hand is on the pointer at all:
`mix(swingAngle, handAngle, hand)`, with `hand = clamp(400·value4, 0, 1)`. `value4` is the
cursor's own motion — `follow1 → stir1(valueSlope) → urge1(× itself) → hold1(valueLag)`,
i.e. speed, squared to make it unsigned, through an envelope that rises in 0.02 s and falls
with a 0.6 s time constant. A cursor moving faster than a twentieth of the frame per second
owns the aim outright; the hold lasts `0.6·ln(400·speed²)` seconds after it stops, so a
decisive gesture keeps control longer than a nudge. And a cursor that has **never** moved
reads exactly 0 through all three stages, so every gate and every fresh session still sees
the LFO's picture bit for bit, exactly as the additive build promised.

**The swing is not touched**, which is §T842's lesson rather than caution: the square, the
slam and the two angles it visits are this example's character, so the fix is in how the
terms *combine* and never in what the auto term is. The widening lives entirely on the
pointer's own scale — 84° to 6° against the swing's 62° to 37° — and the same one knob
walks the **entry point** along the face, from below the base vertex to past the apex,
because a beam you aim does not pivot about a fixed spot on the glass. Pinning the entry
point is exactly what made the old aim unable to miss.

Measured at column 240, `value1` pinned so only the pointer moves: the fan's midpoint sits
at y 289.5 with the cursor parked and y 123 with it moving — a **166px** swing, against the
86px the additive build managed with the cursor *held* at the end of its travel. Five
seconds after the cursor stops, the fan is back within **2.5px** of the parked frame.

### And it can miss the glass

The refracting face is a **segment**, not a plane: an equilateral cross-section's half side
is its inradius times √3, which is 0.658 here — the same `RI` the mesh and the optics
already share, so the bound is not a fourth number to keep in step. The pointer's reach
runs to ±0.8, so the outer ninth of the travel at each end puts the entry past a vertex,
and there the ray is travelling *away* from the body: the fan collapses to zero length
(zero area, T680) and the shaft carries straight on past the glass instead of stopping at a
face it never met. Missing is a **state**, not a failure — it is the diagnostic the owner
asked for by name, and the picture stays coherent because the glass is lit by the
environment and never by the beam (§V617).

Measured: 20,429 fan pixels with the beam on the glass and **0** past either vertex, while
the body's lit population is 2,700 in all three frames — identical, and read out of the
full missed frame rather than a solo render the beam never entered. The shaft keeps 1,637
pixels past the apex and 3,183 past the base, none of them inside a 3px erosion of the
body: the exact inversion of the T718 claim above, on the same instrument.

`drift1` sways the camera 0.22 either side of 0.45 over 22 seconds, and it is not
decoration. `envFresnel` reads `dot(N, viewDir)`, so moving the eye moves *which* thread of
the round-over is at grazing. The rim travels. A static camera over this material is the
one thing that would make an edge-lit prism look painted.

## What breaks here first

**The material model.** The rim needs a Fresnel-against-environment term, which only the
glass and phong models carry. Make the body a lambert or an unlit and there is no
Fresnel, therefore no rim, therefore no glass — and nothing warns you. You get a black
triangle. (And only the GLASS model transmits: on phong the interior segment — inside
the body since T758 — would be swallowed by an opaque solid.)

**The round-over going flat.** Shrink the cap edge from 0.120 to 0.002 and the normal stops
sweeping through grazing. The picture still renders a triangle; §V640's split falls from
10.2× to under the gate's floor, which is the only thing that notices.

**The mesh and the optics disagreeing.** `form1` builds the geometry and `optics1` solves
the optics, and the *only* thing making them agree is that both read one circumradius.
Nothing in the compiler checks it. Move one and the picture stays entirely plausible — a
prism, a beam, a spectrum — while the beam either floats beside the glass or drives through
the middle of it. Since T718 the interior is SUPPOSED to carry the traced segment, so the
pixel gate holds the fan out of the solid and demands a real population of shaft-group
pixels inside it (743 measured at the swap); the exact mesh/optics agreement lives in
`prism-trace.gpu.test.ts`, which holds every segment against scalar Snell computed from the
domain (§V683) — entry angle, internal angle, per-band exit angle, the TIR case leaving
through the base, and the apex case shortening the internal path.

**The clamp between the Level and the blur.** Level is a signed pipeline: below
`blacklevel` it emits negatives, the blur spreads them across the whole frame, and `add`
then *subtracts* a halo from the picture. On a document this black almost every pixel is
below the threshold, so without `clip1` the frame goes out entirely. E33 and E34 both
learned this; a deep-black document is its worst case.

**Judging any of it from a saved linear frame.** §V618: `savePng` in a GPU test writes the
linear target, about a stop and a half darker than the tile a human sees, and this document
is 90% black. Every number on this page is measured on the display-encoded frame at the
project's full 1280×720, with the output space read from the plan.

## Where the seams still show

- **There is still no caustic on the base.** The owner's reference has one. The BEAM
  refracts now (T718), but a caustic is refracted light LANDING on another surface, and
  the fan's ribbons are unlit primitives that take no part in shadowing or lighting
  (§V617) — so a caustic would still be light invented and placed. The glow under the
  prism is bloom spilling off the exit face, which is a real thing that happens. What
  changed with T718, measured rather than asserted (§V642): the interior now carries the
  traced segment (743 interior beam pixels where the gate previously held zero), the look
  baseline's motion row moved 0.04247 → 0.04351 (+2.4% — the opening frames were already
  dominated by the sweep), and every T710 pixel gate except the deliberately inverted
  burial claim held unchanged.
- **The beams are drawn in one plane inside the body's depth** (z = 0.10 since T758, and
  0.05 *in front* of the front face before it). The optics are solved in the cross-section,
  which does not use the extrusion axis at all, so this is a shift along exactly the
  direction the physics ignores — but it is a shift. While the body was opaque the shift
  had to be forward, so the solid could not swallow the ends of the shaft and the fan;
  with a transmissive body, swallowing is the point.
- **The dispersion is about six times life.** Crown glass separates a beam by roughly two
  degrees over this geometry, which at this scale is a coloured fringe rather than a
  spectrum. The exaggeration is a document parameter, not a hidden constant.
- **The spectrum is 61 opaque ribbons, not a continuum.** A scene draw has no additive
  blend mode, so the bands overlap by depth rather than by light. At the widest aim the
  overlap is thin enough that a very close look finds the seams; the bloom is what carries
  them into a continuous band.
- **~~A point kernel cannot read the pointer.~~** Fixed by T367 — `PointCtx` carries
  `pointer`. This file still routes the cursor through the value graph rather than reading
  it in the kernel, because the aim wants smoothing (`follow1`) and a Lag is a value-graph
  node, not a kernel one.
