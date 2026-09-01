# E41 — Cinder

A dark field, a warm light travelling through it — and the light **sheds**. Wherever the
picture moves, embers are born off it: they take the colour of the frame beneath them,
swell with the local motion, rise on a slow draught, and die out in under two seconds. Park
the subject and the cloud starves; within one lifetime the stage is empty. **A moving
subject sheds motes and a still one sheds none** — that sentence is the example, and it is
asserted as numbers on frame pairs, because no still frame can testify about it.

This is the "particles from video" example: point `clip1` at real footage
(`pick1.index = 1`) and the same scouts shed embers off whatever moves in it.

## Graph

```
bed1(noise 4d, nearly still) ─┐
orb1(circle ┄ pathx1/pathy1) ─┴─► stand1(add) ─┐ order 0
clip1(movieFileIn) ─────────────────────────────┴─► pick1(switch) ─┬─► past1(cache, 6 back)
                                                                   │        │
under1(level, night-dims) ◄── pick1                                ▼        ▼
                                                              moved1(difference)
pick1 ─► pack1.in1 (rgb = colour)      gain1(level) ◄──────────────┘
gain1 ─► pack1.in2 (a = motion)   ─►  pack1(reorder) ─► cloud1.field

cloud1(pointKernelAdvanced: scouts spawn where the picture moves) ─► motes1(geometry, instances)
flare1(materialUnlit) ── by name ──► motes1 ─► shot1(render ◄ view1) ─► halo1(blur) ─► burn1(add)
under1 ─► lay1(add ◄ burn1) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `pack1` | `reorder` | THE design decision: rgb = the source's colour (in1), alpha = the motion (in2lum) — a kernel has one field input, and this makes one `fieldAt` answer *where is it moving* and *what colour is it there* |
| `past1` → `moved1` | `cache`, `difference` | E40's motion instrument, reused as a SPAWN FIELD rather than a picture |
| `cloud1` | `pointKernelAdvanced` | the T322 lifecycle on a T744 field: invisible scouts spawn where motion clears the threshold; children die and are compacted, and the live count meters the motion |
| `motes1` | `geometry` | counted `instances` (quads — a counted set draws indirectly off the live count, T478); `tint` mapped from the kernel, `scale` from `tint.w` (T721) — size IS the local motion, faded by age |
| `flare1` | `materialUnlit` | motes are light: they cast nothing and take nothing (§V617/§V666) |
| `gain1` | `level` | ranges the difference with `whitelevel` alone — no subtractive offset anywhere in this file (§V694) |
| `bed1`, `orb1` | `noise`, `circle` | the understudy that MOVES (§V411/§V687): a warm orb on two free-running LFOs over a nearly-still bed — something must hold still for shed-on-motion to mean anything |

## The packed field

A point kernel has exactly one field input. Instead of choosing between "read the motion"
and "read the picture", `pack1` carries both: `outr/g/b` from the source, `outa` from the
difference's luminance. A scout probes the alpha; a live mote samples the rgb under
its own position every frame, so its colour is the video *live* — drift across a boundary
in the footage and the ember changes colour mid-flight.

## The real lifecycle, and the gap it closed first (T744 → T745)

The first landing recycled a fixed population, because `pointKernelAdvanced` took **no
inputs at all** — a spawn decision could not read a texture. That finding became T744:
the advanced kernel now carries the plain kernel's own `field` input (one route, one
`fieldAt`, one refusal), and this file runs the machinery it always wanted: 96 immortal
invisible **scouts** jump to fresh deterministic sites every frame (`pointRand` salted by
the absolute frame, so a seek reproduces, §V44/§V45) and **spawn** where the motion alpha
clears the threshold. Children are born at the site, die within 1.6 s, and are
**compacted** — so the GPU live count is a meter of how much the picture is moving.
Frame 0 is an empty stage bar the invisible scouts: everything ever visible was born
from measured motion.

The budget is spent deliberately (§V588): spawning requires `id` (identity is minted at
birth, §V73) and the picture requires `tint`, which is the whole three-attribute
allowance — so **age rides `position.z`** (scaled negative, doubling as depth ordering:
older, dimmer motes sit farther from the ortho camera and never occlude fresh ones) and
velocity is **procedural** — a per-ember kick from its own id, buoyancy, and the
draught's curl, recomputed each frame. No inertia; stated, not hidden. The spawn hook
reads no field, by T744's own rule — the kernel that decided the birth is the sampling
site, and the hook only scatters the newborn a breath from its parent.

## What the claims hold, and why they are all cross-frame

§V712 measured a look baseline reading identically to four decimals with every element
mis-owned; §V717 measured it sampling frames 60–180 and missing a 10× late collapse. This
example's subject is *behaviour over time*, so `cinder-claims.gpu.test.ts` asserts:

- **The sentence itself, on the population:** the GPU live count — read off the count
  buffer through the harness's `probeBuffers` seam (§V729) — grows while the orb
  travels, and with the path LFOs pinned it returns to **exactly the scout floor**:
  zero live points born of motion, which is a stronger sentence than zero visible
  pixels (a mote that is merely dark or off-screen satisfies the pixel claim and fails
  this one). The pixel count stays as corroboration: the population died AND the
  screen agrees.
- **Where:** at frame 132, over 90% of mote pixels sit within reach of the orb's
  *analytic* path over the last lifetime — the LFO sine computed in the test, not the
  kernel's own arithmetic (§V683's discipline) — and essentially none sit in the region
  the orb never visited.
- **Whose colour:** the cloud reads warm over its grey bed, and — the §V712 mutation made
  deliberate — swapping the pack's red and blue sources produces a *cooler* cloud than the
  shipped wiring while every count stays green. Only the comparison sees the mis-ownership.

## Where the seams show

- **The motes are square.** Instanced quads; the bloom (`halo1` + `burn1`, no Level in
  the chain, §V694) is what rounds them into embers at viewing distance. A soft-sprite
  mode would replace the bloom; it does not exist yet.
- **Birth rate is scouts × hit-area.** 96 probes per frame set how hard a moving region
  sheds, fitted against the understudy's measured difference field (§V696); very small
  or very fast footage may want a different `gain1.whitelevel` or scout count.
- **Capacity still caps a frame with enormous motion** — spawns beyond the allocation
  are dropped by the lifecycle machinery rather than growing the buffer; steady footage
  never approaches it.
- **The motes have no inertia.** Velocity is recomputed each frame (the schema is spent
  — see above), so an ember never overshoots a gust the way E9's do. The look reads
  honestly without it; the trade is stated here rather than silently absorbed.
