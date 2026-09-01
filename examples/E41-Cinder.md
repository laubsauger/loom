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

cloud1(pointKernel: reborn where the picture moves) ─► motes1(geometry, points)
flare1(materialUnlit) ── by name ──► motes1 ─► shot1(render ◄ view1) ─► halo1(blur) ─► burn1(add)
under1 ─► lay1(add ◄ burn1) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `pack1` | `reorder` | THE design decision: rgb = the source's colour (in1), alpha = the motion (in2lum) — a kernel has one field input, and this makes one `fieldAt` answer *where is it moving* and *what colour is it there* |
| `past1` → `moved1` | `cache`, `difference` | E40's motion instrument, reused as a SPAWN FIELD rather than a picture |
| `cloud1` | `pointKernel` | the recycling population: dormant points probe deterministic sites and are REBORN where motion clears the threshold; age rides `velocity.z` (E9's idiom) |
| `motes1` | `geometry` | `points` billboards; `tint` mapped from the kernel, `scale` mapped from `tint.w` (T721) — size IS the local motion, faded by age |
| `flare1` | `materialUnlit` | motes are light: they cast nothing and take nothing (§V617/§V666) |
| `gain1` | `level` | ranges the difference with `whitelevel` alone — no subtractive offset anywhere in this file (§V694) |
| `bed1`, `orb1` | `noise`, `circle` | the understudy that MOVES (§V411/§V687): a warm orb on two free-running LFOs over a nearly-still bed — something must hold still for shed-on-motion to mean anything |

## The packed field

A point kernel has exactly one field input. Instead of choosing between "read the motion"
and "read the picture", `pack1` carries both: `outr/g/b` from the source, `outa` from the
difference's luminance. A dormant point probes the alpha; a live mote samples the rgb under
its own position every frame, so its colour is the video *live* — drift across a boundary
in the footage and the ember changes colour mid-flight.

## The recycling population, and the machinery that was NOT used

The plan was `pointKernelAdvanced` — real spawn/kill with a live count. The pre-build
check surfaced a wall worth recording: **the advanced kernel has no inputs at all** — no
field port — so a spawn decision cannot read a texture there. That is a capability gap
(a field input is a texture binding, not a storage buffer, so the §V588 budget does not
forbid it), filed rather than worked around by side effect.

So the population recycles in one plain kernel: every point is a live mote (`age < 1.6 s`,
riding `velocity.z`) or dormant. Each frame a dormant point rolls a deterministic gate;
winners probe one fresh site (`pointRand` salted by the absolute frame, so a seek
reproduces, §V44/§V45) and are reborn where the motion alpha clears the threshold. The
default age is dormant, so **frame 0 is an empty stage and everything ever visible was
born from measured motion**. Three attributes — position, velocity, tint — is `2n + 2 = 8`
storage bindings, exactly the baseline (§V588).

## What the claims hold, and why they are all cross-frame

§V712 measured a look baseline reading identically to four decimals with every element
mis-owned; §V717 measured it sampling frames 60–180 and missing a 10× late collapse. This
example's subject is *behaviour over time*, so `cinder-claims.gpu.test.ts` asserts:

- **The sentence itself:** the mote population grows from frame 12 to frame 132, and the
  same graph with the path LFOs pinned holds **exactly zero** motes at frame 132 — the
  warm-up transient is dead within one TTL, and nothing moves, so nothing is born.
- **Where:** at frame 132, over 90% of mote pixels sit within reach of the orb's
  *analytic* path over the last lifetime — the LFO sine computed in the test, not the
  kernel's own arithmetic (§V683's discipline) — and essentially none sit in the region
  the orb never visited.
- **Whose colour:** the cloud reads warm over its grey bed, and — the §V712 mutation made
  deliberate — swapping the pack's red and blue sources produces a *cooler* cloud than the
  shipped wiring while every count stays green. Only the comparison sees the mis-ownership.

## Where the seams show

- **The motes are square.** `points` billboards are quads; the bloom (`halo1` + `burn1`,
  no Level in the chain, §V694) is what rounds them into embers at viewing distance. A
  soft-sprite mode would replace the bloom; it does not exist yet.
- **Birth rate is a tuned constant.** `GATE × capacity × hit-area` sets how hard a moving
  region sheds. It was fitted against the understudy's measured difference field (§V696);
  very small or very fast footage may want a different `gain1.whitelevel`.
- **The recycle is not a true spawn.** Population is capped at capacity; a frame with
  enormous motion saturates rather than growing. The advanced kernel's missing field
  input is the honest blocker, recorded above.
