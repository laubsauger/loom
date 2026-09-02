# E44 — Sounding

A monocular depth model turns a flat picture into a distance map. `pointsFromTexture`
lifts a lattice of points by what it reads there, so a video stands up as a point cloud.

The map is read on a 96×72 lattice and `tint1` colours each point from the source, so you
can look at the cloud from the side — the depth-camera look, from a source that never
carried depth.

Named for the nautical sense: throwing a line to find how deep the water is. E27 already
carries the sculptural word *Relief*; this is the measurement rather than the carving.

```
bed1(noise, nearly still) ─┐          pivot1(lfo) ┄drives┄► draw1.eye.x
orb1(circle) ← 2 LFOs ─────┴─► stand1(add) ─┬─► pick1(switch) ─► depth1(depth)
clip1(movieFileIn) ──────────── order 1 ─┘      │ colour            │ height
                                                ▼                   ▼
out1 ◄─ plate1(add) ◄─ dim1(level) ◄────────────┘   tint1(textureToAttribute) ◄ cloud1(GRID)
            ▲                                                │
            └──────────── draw1(renderInstances, 6912 boxes) ◄┘
```

## It opens flat, and that is the design

A 94 MB model does not download because a document was opened. Until you press **Download**
in the notice strip, `depth1` publishes flat mid-grey — the exact value `displace` defines
as *no displacement* — so the cloud is a flat lattice and the document renders anyway.
Acquire the model and the same lattice lifts into relief.

No example had ever exercised that path. `sounding-claims.gpu.test.ts` asserts both ends of
it on the position buffer rather than on pixels: mid-grey in gives a cloud whose z-spread is
under 0.01, and a left-to-right brightness ramp gives a left-to-right rise that is monotonic
across every one of 96 columns. A screenshot cannot tell a real relief from a plausible one.

## The camera pivots, and the sway is the depth cue

A relief seen from a fixed eye is a *picture* of a relief: the geometry carries the depth
and nothing reveals it. So `pivot1` swings `draw1.eye.x` by ±0.85 at an xz distance of 3 —
±16° — on a 28-second round trip. A drift, not a turntable.

It matters more here than in the other 3D examples, for two reasons. The relief itself only
changes every 2.6 seconds, so the one thing moving at 60fps has to be the viewpoint; and it
is what makes the no-model state read honestly. A flat lattice standing still is ambiguous
— it was reported as the example not doing anything. A flat sheet *swinging* in perspective
is visibly a flat sheet, and the same swing over a real relief is visibly not.

The sway only ever increases the eye's distance from `lookAt` (3.31 to 3.42 at the
extremes), so it cannot push the cloud out of frame. Frame 0 sits at the sine's zero
crossing, so the example still opens on exactly the shot it was framed for.

## The lattice is not a picture of the depth map, it is the depth map

`pointsFromTexture` in **Grid** mode puts one point per lattice cell, places it by the
cell's own coordinate, and raises it by the brightness found there. That is the opposite
addressing from the catalogue's existing texture-sampling node, which reads a texture *at*
a point's position: there the position is the address, here it is the result. The node
exists because of this example, and it works on any texture — a noise field, a video
luminance, anything with brightness in it.

Its **Value** mode is the other half, and it is what body keypoints need: texel *i* is
point *i*, read by index, because a model says where a wrist is and the texture's layout is
irrelevant.

## The boxes carry the picture, not a constant

`pointsFromTexture` writes only *position* — height is its whole job. On its own that left
the cloud a wall of identically coloured boxes, which said nothing about the source and read
as a grey lattice standing in front of a dimmed plate. So `tint1` (`textureToAttribute`)
samples the source at each point and hands `draw1` a per-point colour, exactly E27's lesson:
the cloud has to *be* the picture, not a caricature of its silhouette. `draw1.color` maps
that `sample` attribute, so every box wears the source's own colour and the relief you look
at from the side is the video itself, lifted into depth.

The lattice is a square (`sizeX = sizeY = 2`) on purpose: that puts each point on the clip
square the bridge reads back as a UV, so the colour is sampled at the very texel that set
the point's height — the colour and the shape come from the same pixel, never drift apart.
`sounding-claims.gpu.test.ts` pins it: the tint varies across the cloud rather than sitting
at a constant, which is what a bridge sampling nothing — or the old fixed colour — would give.

## The update rate is visible, and here is the number

Depth Anything at 518² was measured at **2599 ms per inference** under wasm on one thread.
Inference runs on a worker, so the frame loop stays at 60fps and the picture never stutters
— but the **relief only changes about every 2.6 seconds**, and the node info popup reports
the age in frames while it waits.

The orb is deliberately fast enough that the lag is plain to see. An example that hid it
behind a slow-moving subject would be flattering the number instead of reporting it. Whether
a GPU execution provider brings that down to something interactive on your machine is
unmeasured — it depends on the browser, and it is the open question in §T754.

## The understudy moves, and that is load-bearing

The subject is depth over time, so the synthetic performer is an orb on two free-running
LFOs above a nearly-still perlin bed: the bed gives the model something to place, the orb
gives it something that moves. Point `clip1` at real footage and set `pick1.index = 1` and
the same lattice reads whatever the video contains — a camera never has to be opened for
the example to work.

## The plate is added, not composited over

`renderInstances` clears to **opaque black**, so an `over` would simply hide the source
behind it. The dimmed source is *added* underneath instead, which suits the picture anyway:
the scan reads as light standing off its own image, and both states are a picture — flat,
the grid lies on the plate; with depth, it lifts away from it.

`dim1`'s brightness is `0.035`, which looks far too dark until you remember the output
display-encodes: linear 0.15 arrives on screen as about 0.44 grey, and an earlier pass at
"dimming" made the plate *lighter*.

## Reproducibility

`depth` is classified `async-cached`. A render waits for each frame's inference, so a take
lags by exactly one frame every time rather than by however far behind the model happened to
be — but different machines' inference backends produce different numbers for the same
picture, so a take reproduces on your machine and not necessarily on another. The render
warning says so by name.
