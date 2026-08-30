# E28 — Sundial

A stone floor at dusk. One warm key rakes in low from the west; a single amber
octahedron circles slowly above the ground, and its shadow — long, hard-edged,
raking — sweeps across the floor and climbs over three standing cubes like the
hand of a clock. Overhead, a sky the frame never shows directly: you see it only
as the cool sheen the stones' specular lobes lift off a dusk gradient.

The shot is the shadow. Everything else in the file exists to give it somewhere
beautiful to travel.

## Graph

```
floorpts1(pointGrid 32×24) ─► floorlay1(pointKernel: lie flat) ─► ground1(geometry: surface)
stonepts1(pointGrid 3×1)   ─► stonelay1(pointKernel: 3 marks)  ─► stones1(geometry: box ×3)
sunpt1(pointGrid 1×1)      ─► sunorbit1(pointKernel)           ─► sun1(geometry: octahedron)
                                  ▲ value1 ┄ orbx1, value2 ┄ orbz1

sky1(ramp: dusk, 5 stops) ──► shot1.environment
ground1 stones1 sun1 ─(names)─► shot1(render) ◄─(names)─ cam1, key1(shadows ON) ─► out1
                                    ▲ eye.x ┄ drift1
```

| Node | Type | Doing |
| --- | --- | --- |
| `key1` | `light` | THE performer's light: directional, warm, low from the west, `shadows` on, `shadowExtent` 3.6 — set by hand to hug the floor (V426) |
| `sunorbit1` | `pointKernel` | one point riding two quadrature LFOs through `ctx.value1`/`ctx.value2` (T479) — values, never rebuilds |
| `floorlay1` | `pointKernel` | lays the grid down: xy → xz at y = 0; grid topology survives, so the surface gets analytic normals |
| `stonelay1` | `pointKernel` | three cubes placed off-axis, so no two shadows ever agree |
| `sky1` | `ramp` | vertical dusk gradient worn as the render's ENVIRONMENT (T482): deep blue at the zenith, a hot amber band at the horizon |
| `drift1` | `lfo` | 0.03 Hz on the camera's eye.x — a locked-off camera reads as a screenshot |

## The antialiasing, and why it is supersampling (T503)

The owner's note was that the edges alias. They did — the box silhouettes stepped and the
shadow's leading edge was a staircase with seven-pixel treads.

**The tempting answer does not apply here.** Analytic coverage from a distance field —
`smoothstep` over `fwidth(d)` — is almost always the better antialias: one extra
instruction, an exact one-pixel filter width, no extra fragments. But **there is no distance
field in this graph.** Every edge in this frame comes from a rasteriser: triangle silhouettes
of an octahedron and three boxes, and a depth comparison against a shadow map. A fragment
shader cannot recover an analytic coverage term for a triangle edge it was never told about,
and a shadow test is a discrete comparison — there is no `d` to take `fwidth` of. Reaching
for `fwidth` here would have been the right tool on the wrong image.

So `shot1` carries a per-node resolution override (§V50) of **1536×864** over a 768×432
project, and the output's blit downsamples it. At exactly 2:1 each destination pixel's sample
lands on the corner between four source texels, so a bilinear read returns their exact mean —
a true 4× box-filtered SSAA, not a blur that happens to soften.

**The cost, stated.** Four boxes' worth of triangles over a 768-point floor at 1.3
megapixels is nothing. What makes it worth paying twice over is that the **shadow map scales
with the render** — a render node's `scratch` entries are `scale: 2` of its own size — so
the same one field takes the map from 1536×864 to 3072×1728, and the blocky staircase along
the shadow's edge was always the worse of the two aliases. Both go away for one parameter.
3072 stays under `maxResolution` (4096) with room, which is why it is 2× and not 3×.

`shadowExtent` came down from 5 to 3.6 in the same pass, which is free resolution: the volume
still contains every shadow at every phase of the orbit (the longest reaches x ≈ −3.5), and a
tighter box spends more of the map on the floor the shadow actually lives on.

## What it proves

**A hard shadow travelling across a floor.** The whole T481 pipeline in one frame you
can watch: the key's r32float shadow map re-renders every frame because the caster's
position is a per-frame uniform write, and the shadow's edge stays HARD — one
`textureLoad`, no soft filtering — which is exactly what makes it read as an object
interrupting light rather than a smudge under a sprite.

**The caster moves, the light does not.** An orbiting light changes the whole frame's
exposure every second; an orbiting object under a fixed key changes only the one thing
the eye is meant to follow. When the octahedron passes west of a stone, both shadows
briefly merge and split again — an event the graph never states anywhere. It falls out
of two objects and one light being real to each other.

**The sky is worn, not shown.** The `environment` wire (T482, V372: pixels are data)
feeds a five-stop dusk ramp into the phong reflection term. The frame never looks up —
the sky exists entirely in the stones' glancing highlights, scaled by `(1 − roughness)`,
which is why the rough floor stays matte while the polished stones catch the amber
horizon on their west faces.

**Nothing rebuilds.** The orbit, the camera drift, the shadow matrix's per-frame
consumption of the caster's position — all of it travels the scene payload channel
(§V5) as uniform writes. The compiled plan for frame 1 and frame 10,000 is the same
plan.

## Tuning notes

The orbit's radius (1.7) against the shadow extent (3.6) is deliberate: the caster stays
well inside the shadow volume at every phase, so the map's resolution is spent on the
floor rather than on empty margin. The light's elevation (direction y = −0.45 against
x = −1) puts the shadow at roughly twice the caster's height in length — long enough to
rake, short enough to stay in frame.


## Regression signatures

- **Stepped silhouettes and a blocky shadow edge** → `shot1` lost its resolution override,
  or it stopped being an exact 2× of the project resolution, and the downsample became an
  uneven interpolation instead of a box filter.
- **A shadow that stops halfway across the floor** → `shadowExtent` went too tight; the
  longest shadow in the orbit reaches about x = −3.5.
- **The stones go matte and the frame flattens** → the `environment` wire came off `shot1`,
  or `environmentIntensity` went to zero. The sky is only ever visible as a highlight.

## Look pass

Rendered on Dawn at 768×432 and inspected at frames 120 and 240, before and after (§V383),
including 8× nearest-zoom crops of a box silhouette and of the shadow's leading edge — which
is the only way to judge an antialias, since at 100% the difference is exactly the thing the
eye is being spared.

**Before:** the shadow edge was a hard binary staircase with roughly seven-pixel treads.
**After:** two-pixel treads with intermediate coverage between them, and the box silhouettes
carry partial-coverage pixels rather than a hard step. Shadows are complete at every orbit
phase after the extent came down. Verdict: **ships.**
