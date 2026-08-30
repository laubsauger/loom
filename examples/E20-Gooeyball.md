# E20 — Gooeyball

A closed ball that breathes: an animated 2D noise reaches inside a 3D surface and pushes
it in and out, and the surface never tears. The owner's ask in their own words —
"deformed from the inside without breaking the surface" — and the 2D→3D crossing made
literal in five point nodes.

## Graph

```
noise1 ──────────────────────► sample1.texture
grid1(pointGrid) ─► ball1(pointKernel) ─► sample1(textureToAttribute) ─► goo1(pointKernel) ─► topology1(pointTopology) ─► surface1(renderSurface) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `noise1` | `noise` | animated perlin4d — the goo's source, continuous in uv AND time |
| `grid1` | `pointGrid` | a 64×64 index sheet; its plane positions are scaffolding |
| `ball1` | `pointKernel` | maps each index to a UV sphere: `u = col/COLS`, `v = row/(ROWS-1)` |
| `sample1` | `textureToAttribute` | samples the noise at each point's position, writes `sample` |
| `goo1` | `pointKernel` | pushes each point along the surface NORMAL by `sample.r − 0.5` |
| `topology1` | `pointTopology` | re-claims the edge as `grid:64x64:wrapU` — the seam CELL |
| `paint1`+`goopalette1` | `lookup`+`ramp` | the SAME noise, through a palette — the albedo map |
| `gooskin1` | `materialPhong` | the skin: palette albedo, raw-noise roughness, warm specular |
| `body1` | `geometry` | the ball as a nameable object wearing `gooskin1` |
| `cam1`/`key1`/`fill1` | `camera`/`light` | the stage: a still warm key and a cool point fill ORBITING on two LFOs |
| `shot1` | `render` | draws `body1` through `cam1` under both lights, depth-tested |

## Why the surface survives

That is the whole teaching of this example, and it is three separate facts:

**Displacement is along the normal, and on a sphere the normal is free.**
`normalize(position)` IS the outward normal — no neighbour reads, no precomputed
normals. A radial push moves a point toward or away from the centre and never sideways
past its grid neighbours, so cells stretch but never fold or self-intersect. Displace
along anything else — a fixed axis, the noise gradient — and cells can cross; the
surface shears and the lighting breaks before the geometry visibly does.

**The noise is continuous, in space and in time.** Neighbouring points sample almost the
same value, so neighbouring cells displace almost the same amount, and the surface stays
a surface. Swap the perlin for white noise and the ball shreds into spikes — same graph,
same shader, one property lost. Continuity in TIME is what makes it goo rather than a
sequence of unrelated dents: the noise is 4D with `speed` set, so the deformation crawls
(B14: on a 2D type, `speed` silently does nothing).

**The seam is a topology claim, not geometry.** The ball kernel maps `u = col/COLS` — not
`cols−1` — so column 0 and a hypothetical column 64 coincide in space. What actually
closes the ring is `topology1`'s `wrapU`: one seam CELL stitching the last column back to
the first (T302). Delete that node and every point stays exactly where it was, but the
ball shows a slit. Connectivity is authored on the EDGE, and this node is the proof that
it is a claim about the same points, not a change to them.

The poles close themselves: every point of row 0 maps to the same position (the north
pole), so each polar cell has two coincident corners — one degenerate triangle, one real
one — which is the standard UV-sphere fan, for free.

## One field, three uses (T429)

The owner's own complaint about the first version — "lame and kinda single colored" —
is answered by WIDENING the crossing, not by painting over it: the same noise that
displaces the ball goes through a palette into the material's ALBEDO map and raw into
its ROUGHNESS map. Bulges are coloured differently from hollows and shine differently
too, so the goo reads as a substance rather than a shape. And the fill light ORBITS —
its position is two LFOs in quadrature, and because a light is VALUES in the scene
pipeline (T377), the orbit is a uniform write per frame, never a rebuild.

## What it proves

**The 2D→3D crossing (T417).** A texture drives geometry: `textureToAttribute` is the
bridge — position in, `sample` out, one dispatch — and the kernel downstream reads that
sample as an ordinary upstream-bound attribute (T401). Note the sampling is by the
point's clip-space `xy`, so the ball's front and back share the noise mirror-fashion;
for goo that symmetry is invisible, and it is stated here so nobody hunts for it later.

**Processors chain through a bridge (T401/B57).** `ball1` is a processor on the grid;
`goo1` is a processor on the bridge's output. `sample` is authored by `sample1` and
bound by `goo1` from upstream, fresh every frame; positions flow `grid → ball → goo` by
pair bindings. Five nodes, one buffer per attribute, zero copies.

**Topology flows and is re-claimable (T296/T302).** The grid's claim rides through both
kernels and the bridge by passthrough; `topology1` then REPLACES it with the wrapped
claim. `renderSurface` never learns who authored what — it reads the edge.

## Regression signatures

- A visible vertical slit on the ball → `wrapU` stopped reaching `renderSurface` (the
  claim is lost in passthrough, or the seam cell count regressed — T301/T302).
- Spikes instead of goo → someone made the sampled field discontinuous (nearest-texel
  jumps, a non-continuous noise type, or `sample` no longer binding the bridge's pair).
- The ball deforms but the deformation never moves → the noise lost its time dimension
  (B14's shape: `speed` on a 2D type).
- The ball drifts or turns inside out over minutes → `goo1` started integrating its
  input instead of re-reading it (V344: a processor re-reads; the anchor cannot drift).
- Lighting bands or shears while the silhouette still looks right → displacement stopped
  being radial; cells are folding.
