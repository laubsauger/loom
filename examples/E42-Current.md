# E42 — Current

A mosaic of small lit tiles, each a facet of the picture behind it. Where the picture
holds still, the grid is perfectly calm — every tile flat, identical, identity. Where the
subject travels, the tiles **turn**: they spin their edges into the local flow, lean their
faces along it, and swell with the motion under them — and because they are lit by one
raking key, the lean reads as **shading**: a swept region catches the light differently
from a calm one, so you see the direction of motion as brightness before you see it as
shape.

This is T723's first witness — the per-instance quaternion, landed with zero consumers —
and T721's mapped scale rides beside it, on E41's exact source rig.

## Graph

```
bed1(noise 4d) ─┐
orb1(circle ┄ pathx1/pathy1) ─┴─► stand1(add) ─┐ order 0
clip1(movieFileIn) ─────────────────────────────┴─► pick1(switch) ─┬─► past1(cache, 6 back)
                                                                   ▼        ▼
pick1 ─► pack1.in1 (rgb)                                      moved1(difference)
gain1 ─► pack1.in2 (a)  ─► pack1(reorder) ─► flow1.field           │
                                                    gain1(level) ◄─┘
grid1(pointGrid 48×27) ─► flow1(pointKernel) ─► tiles1(geometry, instances quad)
facet1(materialPhong) ── by name ──► tiles1 ─► shot1(render ◄ view1, rake1) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `flow1` | `pointKernel` | four `fieldAt` taps → the motion's local GRADIENT → a composed quaternion: spin about +Z into the flow, lean about the in-plane axis along it |
| `tiles1` | `geometry` | instanced quads with all three maps at once: `tint` (the picture), `scale` (T721, from `tint.w` = motion), `orient` (T723, the quaternion) |
| `facet1` | `materialPhong` | the reason the lean is VISIBLE: a specular facet under `rake1`'s low key answers "which way is this tile turned" per pixel |
| `pack1` | `reorder` | E41's pack, verbatim: rgb = source colour, a = motion — one field input carries both readings |
| `rake1` | `light` | low from the left, so a tile leant into rightward flow faces the light and a leftward one turns away — direction as light |

## Why a quaternion, witnessed rather than cited

T723's commit argues the choice: Euler cannot compose, a bare direction cannot carry
roll. This kernel **uses** the property — the tile's turn is `spin(atan2(g)) ⊗ lean(|g|)`,
two rotations composed into one attribute — and the claims verify the composition is
alive: turned tiles must carry a non-zero xy part, which spin alone (the flat-sprite
version of this example) could never produce.

The convention is pinned from the draw's own contract, not re-derived: xyzw with w last,
right-handed and active — `(0, 0, sin45, cos45)` carries +X to +Y.

## Calm means identity, exactly

Below the gradient epsilon the kernel writes `(0, 0, 0, 1)` — not a small rotation, the
identity to the float. That is a claim in `current-claims.gpu.test.ts`, read off the
orient buffer through the harness's `probeBuffers` seam (pixels cannot testify about a
rotation): every tile off the orb's analytic recent path holds identity exactly, every
turned tile is unit-length and on the path. The epsilon exists because the understudy's
bed simmers (§V687 — something almost-still, not frozen), and it was raised once after
looking at the frame (§V383): at 0.02 the bed's murmur scattered spun tiles across the
calm field.

## §V712, made deliberate

Negate the gradient in a mutated clone and every moving tile turns half around — its
quaternion lands near-orthogonal to the shipped one (`⟨spin(θ), spin(θ+π)⟩ = 0`) — while
the calm tiles agree exactly and the mean display luma, the still-frame statistic a look
baseline eats, moves by **under 2%**. Total wrongness, statistically invisible. The claim
asserts both halves: the buffer sees the flip, the picture statistics do not — which is
the measured reason buffer-level claims exist for this example at all (§V712/§V717).

## Where the seams show

- **The gradient is a reading of the difference field, not optical flow.** It points
  across the motion's edge, not along the velocity; for a compact moving subject the
  swirl this produces is the honest picture of the field we actually measure. Real
  optical flow (two-frame correlation) is a different instrument.
- **The lean angle and epsilon are tuned constants**, fitted against the understudy's
  measured field (§V696); very fast footage may want a lower `gain1.whitelevel`.
- **Point `clip1` at real footage** (`pick1.index = 1`) and the mosaic re-tiles it live —
  the understudy proves the mechanism; the video input is the point.
