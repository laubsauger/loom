# E47 — Hologram

The DepthPoints library component, showcased: a depth map unprojected through a ray per
pixel into a real 3D point cloud, retextured from its source, hanging in space as a
volume of soft additive motes under a slow orbital camera.

This is the first example to INSTANCE a library component. `holo1` is
`component:depthPoints@1` from the starter set — the example feeds it two textures and
styles the pointset that comes back; the chain inside (grid → carve → paint) is the
component's own business. Its published page is turned from here: `fov` 55, a shallow
`near`/`far` stage, `displace` 1, `resolution` 160, `heat` 0.45 — the T973 knob that
blends the photographic tint toward a thermal readout of depth (near burns hot, far
cools blue), so the axis the 2D projection hides is readable at a glance.

## Two switches: the source, and the depth

`srcpick1` picks WHAT the cloud is made of: index 0 is the deterministic synthetic
performer; index 1 is `cam1`, the webcam — flip it and the cloud is whoever is at the
camera, in their own colour. Permission is only requested when the webcam activates,
never on load. With the understudy depth this degrades beautifully: webcam plus no
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
srcpick1 ─┬──────────────────────────────────────────► holo1 (colour)
          ├─► flat1(hsv) ─► soften1(blur) ─► pick1(switch)
          └─► depth1(depth) ── index 1 ────────┘   │
                                  pick1 ─► holo1 (depth map)
holo1(component:depthPoints@1) ─► dots1(geometry) ─► shot1(render) ─► out1
orbit1(lfo) ┄drives┄► eye1.eye.x
```

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
| `holo1` | `component:depthPoints@1` | the DepthPoints instance (T958): unprojection, declared encoding, retexture |
| `dots1` | `geometry` | soft additive points, per-point tint mapped from the component's paint |
| `glowm1` | `materialUnlit` | the hologram's cast: a cool cyan carrier the warm orb burns through |
| `eye1` | `camera` | orbited by `orbit1` — ±0.9 at 0.03 Hz, E44's ±16° parallax figure |
| `shot1` | `render` | `antialias: ssaa` — thin bright motes on black, supersampled before bloom would see them |

## Why the orbit

A relief seen from a fixed eye is a picture of a relief (E34/E44's lesson). The swing is
what makes the depth legible — and it reads the no-model state honestly: a flat sheet
SWINGING in perspective is visibly a flat sheet, the same swing over a carved volume is
visibly not.
