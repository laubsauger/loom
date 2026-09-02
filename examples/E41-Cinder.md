# E41 — Cinder

A dark field, a warm light travelling through it — and the light **sheds**. Wherever the
picture moves embers are born off it; park the subject and the cloud starves.

The embers take the colour of the frame beneath them, swell with the local motion, rise on
a slow draught, and die out in under two seconds, so within one lifetime the stage is
empty. **A moving subject sheds motes and a still one sheds none** — that sentence is the
example, and it is asserted as numbers on frame pairs, because no still frame can testify
about it.

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
Everything visible after the first lifetime was born from measured motion — frame 0 itself
carries a seeded generation, which is T793 and is set out below.

The budget is spent deliberately (§V588): spawning requires `id` (identity is minted at
birth, §V73) and the picture requires `tint`, which is the whole three-attribute
allowance — so **age rides `position.z`** (scaled negative, doubling as depth ordering:
older, dimmer motes sit farther from the ortho camera and never occlude fresh ones) and
velocity is **procedural** — a per-ember kick from its own id, buoyancy, and the
draught's curl, recomputed each frame. No inertia; stated, not hidden. The spawn hook
reads no field, by T744's own rule — the kernel that decided the birth is the sampling
site, and the hook only scatters the newborn a breath from its parent.

## T793 — the warm start, and why it does not weaken the claim

**A causal claim is a claim about the steady state, not about frame 0** (§V774). This file
used to open on an empty stage on purpose — `ctx.firstRun` spawned nothing, so *everything
ever visible was born from measured motion* — and it paid for that with a black gallery
card: frames 0 and 1 were a featureless grey plate (output max luma 0.279, against 0.999
from frame 2 on), and **a gallery thumbnail is frame 0** (§V769).

**T794 has since moved the card to frame 60**, so this warm start is no longer *compulsory*
— and it is kept anyway, because the thing it fixes is real on its own terms: the first two
frames a viewer sees when they open this file used to be a grey plate. What changed is the
justification, not the picture.

E9 Ember had already made this trade and nobody generalised it. So Cinder now takes it too:
`ctx.firstRun` seeds **400 motes** — sized from the measurement, not chosen, because the
moving cloud settles at 480–500 live points of which 96 are scouts — and the file opens on
the population it actually runs at.

**The seed is gone within one lifetime, and that is measured rather than asserted.** Each
seeded mote's age is a uniform fraction of its own TTL, which is the age distribution a
constant birth rate produces, so the generation dies off on exactly the schedule a born one
does: nothing seeded is alive after 1.6 s — 96 frames at 60 fps. The parked arm of the lead
claim is the proof and it needs no extra test: at **frame 132**, more than a TTL past the
seed, the still graph returns to **exactly the scout floor of 96**, which not one surviving
seeded mote could allow. Every claim below is read at 132 or later.

**It is the same simulation, run forward — not a scatter.** `moteVel` and `moteTint` exist
as functions precisely so the seed and the per-frame update cannot drift apart: a seeded
mote is given the spawn hook's own birth jitter and then integrated forward by its own age
through the same velocity, and graded by the same tint. E9 states the rule and this file
obeys it — *a warm start computed by different arithmetic from the simulation is a warm
start that opens on a picture the piece never shows.*

**The one approximation, stated rather than buried.** A born mote's site is where the
picture *moves*, and on the first frame there is no motion measurement to read: the cache
is empty, so the difference is the whole picture and the packed alpha floods (measured —
mean 1.02, and 100% of the frame over threshold at frame 0, against 3–5% from frame 1 on).
So the seed ranks 48 deterministic sites by the field's own **luminance** and takes the
best, which is the one thing a first frame can honestly say; for this understudy the warm
orb is by some way the brightest thing in it, and the opening frame reads as a warm plume
rising off the orb with older embers spread behind it. For the same reason the seeded motes
carry the **size floor** and none of the motion bonus — there is no motion to spend. With
real footage on branch 1 the opening generation lands on the brightest region rather than
the moving one, for the one lifetime it exists.

**What the fix cost the argument, and the honest accounting.** The lead claim used to be
read as *the population GROWS from frame 12 to frame 132*. That comparison measured the
cloud filling an empty stage, not the sentence, and a warm start removes it by design. The
claim is now read where it always belonged: **one frame, two wirings, opposite answers** —
501 live points with the orb travelling and exactly 96 with it parked, both at frame 132.

## What the claims hold, and why they are all cross-frame

§V712 measured a look baseline reading identically to four decimals with every element
mis-owned; §V717 measured it sampling frames 60–180 and missing a 10× late collapse. This
example's subject is *behaviour over time*, so `cinder-claims.gpu.test.ts` asserts:

- **The sentence itself, on the population:** the GPU live count — read off the count
  buffer through the harness's `probeBuffers` seam (§V729) — is **hundreds of live points
  beyond the scouts at frame 132 while the orb travels, and exactly the scout floor at the
  same frame with the path LFOs pinned**: zero live points born of motion, which is a
  stronger sentence than zero visible pixels (a mote that is merely dark or off-screen
  satisfies the pixel claim and fails this one). The pixel count stays as corroboration:
  the population died AND the screen agrees. Read at ONE frame since T793, because the
  old early-versus-late reading measured a warm-up the file no longer has (see above).
- **That it opens on its subject (§V769):** frame 0 holds exactly the scouts plus the
  seeded generation, and draws them — the same pixel test the steady state uses.
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
