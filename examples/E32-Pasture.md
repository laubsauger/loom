# E32 — Pasture

A field of pale spores in the dark, and five thousand animals walking it. They leave spore
where they walk, smell what they planted, follow its living edge, and eat it.

The spore **reacts** — it grows, branches, divides into new spots on its own — and where
the herd has fed the ground behind goes bare, and the reaction grows it back from the sides
while they move on. What you are watching is not a field and not a swarm. It is one loop
with the two halves of the catalogue on either side of it.

**Every structure in this frame was deposited by an animal.** Turn the deposit off and the
plate stays empty forever — measured below, and it is the whole reason this example exists.

**It also means this file starts on a bare plate, and it is not going to be seeded** (T794).
A frame-0 floor once made that look like a defect, because *a gallery thumbnail is frame 0*
had been written down as though it were a law; seeding the plate would have bought a
thumbnail by breaking the one sentence this example is for — the claim is testable at every
frame, and a seed makes it false at all of them. The card is now sourced a second in, where
this file reads 0.6838 and shows the lace it is about. Frame 0 stays a bare pasture, which
is what it is.

## The thing that is new

Every other example in this set is one-directional. E2 and E24 are fields that make a
picture. E16 and E31 are points that make a picture. **Nothing until now let the points
write the field that steers them**, and both halves of the machinery were already here:
`fieldAt(p.position)` samples a wired texture inside a point kernel (T477, orientation fixed
by T512), and `renderPoints → texture → the reaction's input` closes the other side.

```
                    ┌───────────────── the loop ─────────────────┐
                    ▼                                            │
 state1(feedback ← pack1, 640×360) ─► rd1..rd8 (Gray-Scott ×8) ─┬─► sowin1(screen) ─► eat1(multiply) ─► pack1(reorder) ─┘
                                                                │        ▲                  ▲
                                          smell1(blur 8) ◄──────┘        │                  │
                                                │                    sow1(deposit)     chew1(1 − bite)
                                                ▼                        ▲                  ▲
                                          herd1.field                    │                  │
                                                │                        │              bite1(renderPoints
                                       herd1(pointKernel, 5 000) ────────┴───────────────┴─  group: fed)
                                                │
                     ┌──────────────────────────┼──────────────────────────┐   ONE cloud,
                     ▼                          ▼                          ▼   FIVE readings
              scout1(renderPoints)       graze1(renderPoints)       find1(renderPoints)
              famine > 0.45              fed > 0.30                 found > 0.30
              deep blue, 0.9 px          amber, size ┄ graze.w      cyan, size ┄ spark1:high

 eat1 ─┐
       ├─► look1(add, PINNED 1280×720) ─► tint1(lookup ◄ palette1, scale ┄ grade1:highMid)
 chem1 ┘        │
                ├─► liftscout1 ─► liftgraze1 ─► liftfind1 ─┬─► halo1(blur 18) ─┐
                                                           └───────────────────┴─► burn1(add, opacity ┄ glow1:level)
                                     ─► mixtrail1(screen) ◄─ loop1(feedback ← hue1, persistence ┄ trail1:level)
                                     ─► hue1(hsv, hue ┄ drift1 @ 0.028 Hz, ±24°) ─► out1
```

Read the cycle as a sentence: **the animals deposit where they walk, the deposit reacts, and
the reaction is what the animals smell on the next lap.** The middle step is what keeps this
from being a Physarum clone. A Physarum trail only blurs and decays, so the picture can never
be more than the paths that were walked; a Gray-Scott deposit spots, branches and mitoses on
its own, so a trail laid twenty seconds ago is still inventing structure while the herd is
somewhere else, and the herd comes back and eats what it invented.

## Both directions are measured, because "it looks organic" is not the same claim

**The field changes where the animals went.** With the deposit's opacity set to zero, the
field at frame 900 measures **mean V = 0.00000 with zero texels above 0.05** — the reaction
kernel answers a cleared pair with a *bare* plate (U = 1, V = 0) rather than the sprinkled
one E2 uses, so the herd is the only seed there is. With the deposit on, 41% of the grid
carries structure. And the sign of the coupling is the interesting part: taking the herd's
footprint at frame 900 and watching the next ninety frames, V falls by **−0.315** inside that
footprint and rises by **+0.030** outside it. Where the herd has been, the field is eaten;
where it has not, the field grows back.

**The animals change course because of the field.** Delete the steering term from the kernel
and nothing else, and the reaction rate under the herd falls from **2.09×** the pasture's mean
to **1.65×**. That test is confounded, though — the herd makes the field it is standing on —
so there is a second one with the confound removed: hand the herd `terrain1`, a field it
cannot write, and ask whether it ends up on the high ground. Steering on, the herd sits at
**1.046×** the frame mean; steering deleted, **1.001×**, which is chance to three decimals.
Its footprint also concentrates from 68 876 texels to 40 458 — the herd clumps because the
field tells it where to clump.

## What it inherits, named

**From E16 Murmuration — local rules, global structure.** The herd has no neighbour reads and
no plan. Three field samples, a random turn scaled by hunger, and one weak spring toward the
roost. Everything that looks like a decision is those four lines meeting a field.

**From E31 Corona (§V471, the bar).** One cloud read **five** ways, three of them by group
predicate on attributes the kernel wrote (§V471.1/.2) — and two of the five are not pictures
at all: `sow1` is the simulation's input and `bite1` is its mouth. Ten **gain-and-bias pairs**,
one band to one property (§V471.3), with the bias as the rest state and the gain as the swing
(§V477). A seven-stop ramp that goes somewhere (§V471.6). And a long cycle (§V471.8) — noting
that §V471.8 is marked *inert* in Corona itself, because `lfoValue` returns
`offset + amplitude·wave` **in the target's units** and `0.35` on a degrees parameter is a
tenth of a percent of a turn. There are two long cycles here and both travel: 24° of hue over
36 seconds, and the herd's own 83-second circuit of its range.

**From E24 — the field as a living substrate with real regimes** (§V474) and the off-centre
composition (§V532). The reaction is E2's kernel in shape and not in its numbers; see below.

## Where the audio goes, and the answer is BOTH HALVES

Ten driven properties. Five are inside the simulation and only four are on the picture.

| band | property | half |
| --- | --- | --- |
| `low` → `pace1` | walking speed, 0.18…0.52 clip units/s | the herd |
| `high` → `reach1` | how far ahead an animal smells, 11…25 px | the herd |
| `onsetCount` → `burst1` | a scatter ANGLE, ±0.01 rad at rest, ±1.7 on the beat | the herd |
| `level` → `drop1` | how much spore a footstep leaves | the field |
| `lowMid` → `warm1` | the chemistry map's white point — whole regions change regime | the field |
| `low` → `gnaw1` | how big a mouthful is, 2…4 px | the field |
| `highMid` → `grade1` | the palette's scale — the ramp breathes | the picture |
| `high` → `spark1` | the pioneers' size | the picture |
| `level` → `glow1` | the bloom's weight | the picture |
| `level` → `trail1` | the trail's persistence | the picture |

A beat is therefore visible at three timescales at once. The herd scatters **this frame**; the
spore that scatter lays becomes structure over the next few **seconds**; and the regime it
lands in was set by the **bar** before. §V509 is why `trig1` reaches `burst1` with nothing in
between: a one-pole answers a single-frame impulse with `1−exp(−Δt/τ)`, which at τ = 0.35 s is
**0.047** — a trigger through an envelope-sized smoother is a trigger you deleted.

## The five readings, and what each animal knows about itself

The kernel writes three numbers per animal and the picture slices on all three (§V471.2):

- **`graze.x` — FED**: a short lag of the reaction rate under its feet. `graze1` draws these
  in amber, and their **sprite size is mapped per point** from `graze.w` (T286's pscale), so
  a grazer is drawn at how much it is eating rather than at one number for the whole layer.
- **`graze.y` — FAMINE**: seconds since the last proper mouthful, over a 1.6-second scale.
  `scout1` draws these, and **the kernel reads it back as its own exploration policy** — a fed
  animal walks its front, a hungry one random-walks, and that random walk is the only thing in
  the file that ever finds the next colony.
- **`graze.z` — FOUND**: set on the step a long-starved animal eats, decaying after. `find1`
  draws these — the pioneers, marking where the colony is about to be rather than where it
  already is.

`sow1` is every animal, drawn white-green into the simulation's own grid: the deposit.
`bite1` is the fed ones drawn again into a mask that is multiplied *out* of the state: the
mouth. Without that fifth reading there is no negative term anywhere in the loop, and a
deposit that grows into a colony stays a colony — measured, the pasture filled its disc and
the composition froze into a carpet by frame 900.

## Six things this file measured rather than assumed

**1. §V474's direction is a claim about E2's constants, not about Gray-Scott.** Driving E2's
imported band with a horizontal 0..1 ramp for 4 800 steps: it is dense worms at 0, open worms
at 1, and labyrinth at every point between. No spot regime, and — the part that mattered here
— **no dead corner**, so an example that wants empty field cannot get it by pushing that
coordinate to either end. E24's black four fifths comes from its colour inversion, not from a
chemistry that stopped. This example ships its own band for that reason, chosen against
Pearson's map and measured the same way. Re-measured for T657 with a 0..1 ramp: labyrinth
below ~0.15, worms breaking into segments 0.15–0.35, rings and irregular blobs 0.35–0.60,
the regular spot lattice 0.60–0.85, death only above ~0.85 — and the boundary that decides
whether the outskirts read as a place or as a hex grid is 0.60, not the death line.

The outskirts used to sit at **0.9989**, one value across the whole region (median, p90,
p99 and p999 all identical), because `screen(coast1, shape1)` composited a WHITE disc
background and `screen(1, x) = 1`: `terrain1`'s drift was already wired and was being
thrown away. T657 widened the disc's falloff so the outskirts run down through the band
instead, widened the herd's grazing circuit so the disturbance reaches them, and left the
background white — putting the far outskirts ON the death line was tried at 0.86 and 0.92
and cost negative space (dark fraction 46.4% → 38.6%) while coming back MORE regular
(blob-area CV 0.483 → 0.449).

**2. The arithmetic that made the old claim look safe is also wrong.** `F ≥ 4(F+k)²` is the
condition for a non-trivial *homogeneous* steady state, and Gray-Scott's whole interesting
region — self-replicating spots included — lives outside it. A pattern is not a fixed point.

**3. An animal deposits spore, not soil.** The state is (U = substrate, V = autocatalyst), and
a *white* deposit screens both toward 1 — so a footprint hands the animal back everything its
own sensor multiplies together, `U·V²` goes maximal exactly where the herd already is, and the
flock converges to a point and stays there (measured: a blown-out core at the same coordinates
at frames 300, 900 and 1500 with the rest of the pasture untouched). The deposit is **green**.
U is the pasture's to give, and the reaction eats it.

**4. A fixed spring has a fixed point, and a flock sitting on its own fixed point eats one
spot to the ground forever.** §V532 is the same sentence about an expanding loop. So the roost
walks a slow circle — `ctx.value4` is an 83-second **saw on an angle**, the one wave whose
wrap is invisible once you take its cosine — and the homing pull is gated on **hunger** rather
than on distance, so a well-fed animal is not homing at all and the flock's outline is drawn
by the food. A distance spring draws a disc whatever the field underneath it is doing.

**5. Physarum's rule beats a proportional controller here.** The kernel steered on
`(left − right)/total` for six builds; ablating that term entirely moved the measurement from
1.56× to 1.71×, which is to say it was doing nothing. A gain small enough not to spin a
saturated animal is also too small to turn it onto a ten-pixel feature before it has walked
past. A **fixed turn toward the better side**, guarded so it does not fire on the noise of
bare ground, is what makes the sensor a mechanism.

**6. Level applies `brightness` AFTER `invert`.** `(1 − x)·b`, not `1 − b·x`. Putting the
grazing depth on the bite mask's brightness therefore multiplies the *entire simulation* by
`b` every frame instead of only under a grazer, and the field collapses in about a second —
which looks exactly like a chemistry that will not ignite. The depth lives in the sprite's
colour instead, where it can only touch what a sprite covers.

## Resolution is pinned twice, and neither number is the other's

§V533 says a loop closed through a Composite rides the output resolution. This file has two
things that must not: the **simulation** (`state1`, `rd1`..`rd8`, `smell1`, `sow1`, `bite1`,
`sowin1`, `eat1`, `pack1`, `bowl1`, `swell1`, `terrain1`) is fixed at **640×360**, and the
**picture** (`look1` onward, plus the three caste renders) is fixed at **1280×720**, with the
Output node scaling a finished frame.

The second pin is the one E24 did not need. Two things here are measured in *output pixels* —
`sizePixels` on the caste renders and `halo1`'s blur radius — and at T521's 192×108 liveness
probe a 0.9 px scout becomes a six-pixel blob and an 18 px bloom becomes nine percent of the
frame across. Unpinned, the herd rendered as one saturated white mass at the probe and as a
faint sprinkle at full size: the same file, two different pictures.

`sow1` is **alpha**-blended for a related reason. A deposit answers "is there spore on this
texel", which is bounded; two animals standing together cannot leave twice as much. Additive,
they do — five thousand sprites in the opening frame overlapped three deep, the screen took V
straight to 1 across the whole herd, and frame 0 rendered as a solid white disc.

## Substeps are structurally unavailable here, and the reason is the example itself

A feedback loop's substep body is *every node on a current-frame path from a consumer of the
Feedback's output back into the Feedback*. The herd reads `rd1` and writes `pack1`, so **the
herd is in the loop** — structurally, not by choice, and that sentence is the example. It also
means the point kernel's own ping-pong swaps sit inside the span the substep repartition would
reorder across, and §V288's guard refuses that rather than land a swap on the wrong side of
the passes that bind it. Measured, not reasoned: `substeps = 12` compiles to

```
warning compiler/substeps-refused: Node "state" asked for 12 substeps, but another
temporal pair swaps inside the loop; it runs one step per frame.
```

and the rendered frames came back byte-identical to one step. A shipped example may raise no
diagnostic of any severity, so the reaction's speed comes from a **chain of eight
`customWgsl` nodes** instead — the same arithmetic with the count visible in the graph rather
than hidden in a parameter, and every one of the eight is a real pass doing a real Laplacian.

Worth knowing for the next person: `renderHeadless` reports **backend** diagnostics only. That
refusal lives on `plan.diagnostics`, which a look harness printing `result.diagnostics` never
sees — this file ran three builds believing substeps worked.

## Playing it

It opens on the deterministic `audioPattern` at 104 bpm, so it plays with no asset (§V363).
Drop a track on `track1` and set `source1`'s index to 1: nothing downstream changes, because
everything downstream reads `source1`, and the Switch is exclusive by construction (T508) —
two value sources on one port would merge and one of them would silently vanish.

Frame 0 is a faint sprinkle of fresh spore on bare ground, which is the honest first frame of
a piece whose whole subject is what the herd does next. Give it thirty seconds.

## T671 — what breaks a lattice

A hexagonal lattice is what Gray-Scott produces at a *uniform* feed, so more contrast
does not cure it. What cures it is denying the pattern the stationary substrate it needs,
and three of T671's four changes are that one idea:

- **Advection.** `flow1` displaces the state along a slow flow between the feedback and
  the reaction. The chemistry map does **not** move with it — `pack1` repaints it *after*
  the reaction — so this is advection through a static parameter field, which shears the
  lattice apart. A rigid rotation would turn the lattice and leave it a lattice. Its
  weight is the density knob: at 0.006 the dark fraction hits 71% and the pasture visibly
  shrinks, because the flow carries V away faster than a low-feed regime regrows it.
- **Weather.** `front1` is a fertile ring expanding on the herd's own 83-second lap; it
  multiplies the chemistry down as it passes, walking a region out of the lattice band
  and back again.
- **The camera.** `sway1` rotates the picture on that same clock — a sine, not `range1`'s
  saw, because a saw is right for an angle the herd *walks* and would snap a rotation back
  once a lap. Outside the trail loop, or the trails would spiral.

And the blink, which is temporal and was measured rather than judged: `env1`'s lag goes
0.07 → 0.16 s so a high band stops arriving as a per-frame pulse on two sprite castes'
size, and the `found` caste's decay slows so points stop dithering across its threshold.
The **trigger** is untouched — it reaches `burst1` on its own wire, never through the lag,
so a beat is still an event.

Measured on the shipped file: blob-area spread in the outskirts 0.872 → 1.132, mean blob
area 60.6 → 106.0, dark fraction 26.8% → 31.7% (negative space is not paid for), nucleus
hard-flip rate 23.28% → 18.68%. And the loop is unchanged — deposit off gives mean V
0.00000, steering on 1.079× against steering deleted 0.996×, versus 1.080× / 0.994×
before. A prettier Pasture with a dead stigmergy loop would be the wrong trade.
