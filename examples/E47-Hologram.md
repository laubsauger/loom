# E47 — Hologram

The DepthPoints library component, showcased: a depth map unprojected through a ray per
pixel into a real 3D point cloud, painted by a palette KEYED ON THAT SAME DEPTH, hanging
in space as a volume of soft additive motes under a slow orbital camera.

This is the first example to INSTANCE a library component. `holo1` is
`component:depthPoints@1` from the starter set — the example feeds it two textures and
styles the pointset that comes back; the chain inside (grid → carve → paint) is the
component's own business. Its published page is turned from here: `fov` 55, a shallow
`near`/`far` stage, `displace` 1, `resolution` 160, and `heat` 0 — the T973 knob is
turned OFF because this document supplies its own heat map through the colour port
instead (see below), and two thermal readouts on one axis would be two decisions on one
number. Raise `heat` and the component's own analytic readout comes back, which is the
comparison the boundary is there to make.

## Two switches: the source, and the depth

`srcpick1` picks WHAT the cloud is made of: index 0 is the deterministic synthetic
performer; index 1 is `cam1`, the webcam — flip it and the cloud is whoever is at the
camera, as a thermal readout of their own depth. Permission is only requested when the
webcam activates, never on load. With the understudy depth this degrades beautifully: webcam plus no
model still carves a moving cloud of your face from its own luma.

## Two depth sources, one switch

The component takes a depth *texture*, not "the depth node" — and the graph proves it
with a switch:

- `pick1.index = 0` (shipped): the source's own luma, desaturated and blurred — an
  UNDERSTUDY depth map, bright-is-close, exactly the inverse encoding the component's
  `inverseDepth` knob declares. Deterministic, so every gate and the gallery card see a
  real carved volume, and the orb pops toward the viewer because it is the brightest
  thing in the frame.
- `pick1.index = 1`: the monocular ML `depth` model reads the same source. Per §T715 the
  document loads and renders without the model — `depth1` publishes flat mid-grey and
  the cloud is a visibly flat sheet in the orbit, never a failure.

```
bed1(noise) ─┬─► src1(add) ─► srcpick1(switch) ◄─ cam1(webcam)   (index 1)
orb1(circle)─┘                     │
srcpick1 ─┬─► flat1(hsv) ─► soften1(blur) ─► pick1(switch)
          └─► depth1(depth) ── index 1 ────────┘   │
                                  pick1 ─► holo1 (depth map)
srcpick1 ─► cut1(component:depthCut@1) ◄─ pick1 (the active depth map drives the matte)
palette1(ramp) ─► coat1(lookup) ◄─ pick1 (the SAME map, read as the palette's key)
coat1 ─► braid1(reorder) ◄─ cut1 (rgb from the palette, ALPHA from the cut)
braid1 ─► holo1 (colour: the heat map, background cut away)
holo1(component:depthPoints@1) ─► zone1(pointRange) ─► dots1(geometry) ─┐
src1 ─► flat2(hsv) ─► soften2(blur) ─┬─► holo2 (depth map)              ├─► shot1(render) ─► out1
                                     └─► wcoat1(lookup) ◄─ palette1     │
wcoat1 ─► holo2 (colour)                                                │
holo2(component:depthPoints@1) ─► wall1(pointRange) ─► wdots1(geometry) ┘
orbit1(lfo) ┄drives┄► eye1.eye.x   cycle1(lfo) ┄drives┄► coat1/wcoat1 offset
```

## The cut — the model-less 2D spelling

`cut1` (DepthCut) mattes the subject's COLOUR by the active depth map before it becomes
paint: everything past the cut plane loses its light entirely (threshold 0.8, feather
0.12 over the understudy's luma), so the backdrop goes dark and the subject stands alone
in its own cloud. It removes things further away, not "not-the-person" — a real matte
knows the difference; this never needs to, and it costs no download. The chain carries
light because the component's paint kernel honours the map's alpha as premultiplied,
CLAMPED coverage — an additive composite's alpha reads 2 where the orb crosses the
opaque bed, and coverage is [0, 1] by meaning, not by storage.

A threshold means nothing on its own: it is only meaningful against the RANGE of the map
it reads. The understudy's blurred luma occupies [0.498, 1.0] with 80% of the frame in
[0.584, 0.696], so 0.8/0.12 puts the cut in the empty gap between the bed and the orb.
Feed a real depth model here (flip `pick1` to 1) and this number wants retuning — that
is what the knob is for.

Since §B189's follow-up the cut carves COLOUR as well as coverage. This document reads
only its ALPHA (see the heat map below), because the component's paint kernel already
multiplies by coverage and reading a pre-carved rgb would apply the matte twice.

## The heat map — E27 Relief's instrument, keyed on depth

`palette1` is E27's contrast ramp, stop for stop: a long near-black foot, then a short
violent climb through teal, magenta and orange to a white crest. What makes it a heat
map rather than a tint is the `lookup` that reads it — and what it is keyed ON is the
ACTIVE DEPTH MAP, the same texture at the same uv that the carve kernel sampled to place
each point. So a mote's colour is its distance: far is navy and teal, near is magenta and
orange, and the near plane burns white.

Depth rather than the picture's luminance, deliberately. The understudy makes the two
nearly the same number, but only one of them survives the switch this example is about:
flip `pick1` to the ML model and "the colour is the depth" is still true, while "bright
is hot" would be a statement about a picture nobody is looking at.

`braid1` is why the cut still works. A `lookup` returns the palette's texel whole — the
source's alpha is not carried — so rgb comes from the palette and ALPHA from `cut1`, the
same channel-braid E27 uses to carry two fields over one bridge. Without it every mote
would come back at full coverage and the background would walk straight back in.

Two lookups, two fits, one mapping. The map's range was measured before an index was
chosen (min 0.498, p50 0.622, p90 0.696, a clipped plateau at 1.0), and `zone1`/`wall1`
already split the cloud at map luma 0.72: the subject only ever wears [0.68, 1.00] and
the wall only [0.498, 0.72]. One affine across both would crush 80% of the frame into the
black foot. Two segments meeting at the partition — `wcoat1` 2.25/−0.94, `coat1`
1.06/−0.06 — spend the whole ramp and stay monotone through the join, so brighter is
nearer is hotter across both clouds at once.

`cycle1` sweeps both offsets ±0.05 at 0.037 Hz, a 27-second cycle incommensurate with
the orbit. `Lookup`'s index CLAMPS, so a sweep slides the picture along the ramp and
never wraps — unlike `ramp`'s own `phase`, which would rotate a monotone table into a
non-monotone one and take the reading apart (E27 measured that; the finding transfers).

Both carriers are white. §T478's per-point tint multiplies the material colour, so the
cyan and blue carriers this file used to ship could not draw a warm mote at any tint —
which is most of what "just blue" was.

## The zone and the wall

`zone1` keeps holo1's points whose `depthN` falls inside [0, 0.13] — the subject band —
and parks the rest out of shot. The cut happens ON the cloud, where depth is an exact
per-point attribute, not on the texture; drag `to` and the room recedes live.

`wall1` is the SAME operator in its other mode: it keeps a second DepthPoints instance's
points OUTSIDE the same range. Inside + outside over one range partition a cloud exactly
(the boundary belongs to inside), so between the two instances no depth band is drawn
twice or lost.

The second instance redeems the source switch: `holo2` reads the synthetic performer
ALWAYS — its own luma chain (`flat2` → `soften2`) is both its depth map and, through
`wcoat1`, the key its colour is painted from — so flipping `srcpick1` to the webcam no
longer throws the synthetic source away. It becomes
the backdrop: you, near, in front of a wall of clouds, far. holo2's published `near`/`far`
place its stage behind holo1's (2.0–4.4 against 0.7–2.6), so the two clouds separate by
REAL world depth under the orbit's parallax — the thing a 2D key cannot do.

| Node | Type | Doing |
| --- | --- | --- |
| `bed1` | `noise` | a dim, slowly evolving mono field — the terrain the cloud carves |
| `orb1` | `circle` | the performer: a warm orb on two free-running LFOs (`swayx1`, `swayy1`) |
| `src1` | `add` | the source — both the COLOUR the cloud wears and the stuff depth is made from |
| `flat1` | `hsv` | saturation 0: the source's luma, the understudy's raw material |
| `soften1` | `blur` | 14 px: the carve reads a surface, not film grain |
| `depth1` | `depth` | the ML path — stale-tolerant, mid-grey without the model (§T715) |
| `cam1` | `webcam` | the live source (T972) — your face as the cloud, permission only on activation |
| `srcpick1` | `switch` | WHICH picture the cloud is made of: synthetic performer or webcam |
| `pick1` | `switch` | WHICH depth map the component reads — the source-agnosticism, live |
| `cut1` | `component:depthCut@1` | the model-less cut (§T977): the active depth map mattes the subject's colour — this file reads its ALPHA |
| `palette1` | `ramp` | E27 Relief's contrast palette, stop for stop: black foot, teal, magenta, orange, white crest |
| `coat1` | `lookup` | the subject's heat map: the active depth map read through the palette, fitted 1.06 / −0.06 |
| `wcoat1` | `lookup` | the wall's segment of the same mapping, fitted 2.25 / −0.94 to the band the wall actually occupies |
| `braid1` | `reorder` | rgb from the palette, alpha from the cut — one texture, two fields (E27's braid) |
| `cycle1` | `lfo` | ±0.05 at 0.037 Hz on both lookups' offset: the palette breathes along the depth axis |
| `holo1` | `component:depthPoints@1` | the DepthPoints instance (T958): unprojection, declared encoding, retexture |
| `zone1` | `pointRange` | the subject's zone (T983): keep depthN inside [0, 0.13], park the rest |
| `flat2` | `hsv` | the backdrop's own luma — the wall never depends on the switch |
| `soften2` | `blur` | the wall's carve reads a surface, same 14 px as the subject's |
| `holo2` | `component:depthPoints@1` | the second instance (§T979): the synthetic performer as a backdrop, staged deeper |
| `wall1` | `pointRange` | the same operator, mode outside: the wall keeps what the subject's zone drops |
| `dots1` | `geometry` | soft additive points, per-point tint mapped from the component's paint |
| `wdots1` | `geometry` | the wall's motes: finer, dimmer, mapped from holo2's paint — 176² of them, a wall rather than a lattice |
| `glowm1` | `materialUnlit` | white: §T478's tint multiplies this, so a coloured carrier would veto the palette |
| `wallm1` | `materialUnlit` | white for the same reason; the wall is subordinate by mote size, gain and DEPTH, not by cast |
| `eye1` | `camera` | orbited by `orbit1` — ±0.9 at 0.03 Hz, E44's ±16° parallax figure |
| `shot1` | `render` | `antialias: ssaa` — thin bright motes on black, supersampled before bloom would see them |

## Why the orbit

A relief seen from a fixed eye is a picture of a relief (E34/E44's lesson). The swing is
what makes the depth legible — and it reads the no-model state honestly: a flat sheet
SWINGING in perspective is visibly a flat sheet, the same swing over a carved volume is
visibly not.
