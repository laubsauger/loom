# E24 — Audio Reaction-Diffusion

A dense colony of reaction-diffusion sits off the middle of an almost black frame, and
every beat sends a family of rings outward through it.

E2's chemistry, played like an instrument — and it PLAYS THE MOMENT IT OPENS. The rings
travel, the colony's own echoes travel with them, and four fifths of the picture is the
dark they cross.

The music source is a deterministic beat pattern (`audioPattern`, 112 bpm), and it reaches
the picture on THREE timescales at once: the bass makes the simulation grow FASTER and
the mids steer which chemistry each region runs (slow, structural); five bands each
drive one fast property — the three lens weights, the palette's grade, the output gain —
so a hit is visible in the frame it lands on; and every onset opens a gate for exactly
one frame that SEEDS new chemistry into the plate, which the reaction then grows.

**To play it with your own track: drop a file on `track1` and set `source1.index` to 1.**
Both sources are already wired. Nothing else in the graph changes, because everything
downstream reads `source1`.

Why a synthetic source ships (§V363): assets are session-only, so no example can carry
a bound track, and an audio-reactive graph whose null state looks finished demos
nothing. The pattern is also the audio path's deterministic test signal — the replay
gate renders this file twice and demands byte-identical frames, with no recording
involved.


## What you see on load

It **opens on a black frame**, then flares bright for a handful of frames, and has
settled by about frame twelve, and the colony takes a couple of seconds more to fill its
disc. Two causes for the black, both by construction rather than defect: the
feedback pair's alpha channel is the seeded-start flag, so frame 0 is the moment before
any chemistry exists; and the RGB delay's deepest cache ring is seven frames long, so
until frame seven one colour channel is still reading an empty ring.

**This file used to carry the only declared exemption from T521's frame-0 rule, and T794
deleted it** — not because the physics changed but because the rule did. The sentence that
justified the exemption was *"a gallery thumbnail is frame 0"*, and that was a policy this
repo set rather than a fact about anything: there is no card image in the codebase, so the
card is whichever frame the look instrument names. It now names frame 60, where this file
measures 0.9048 — a colony on a plate — so it passes on its own merits with nothing
excused. Two other examples had independently re-derived the same exemption and shipped a
black card instead of declaring one, which is what made it a policy problem rather than an
E24 problem. The black opening stays, and stays written down here, because what a user sees
for the first fifth of a second is still worth knowing.

## Graph

```
music1(audioPattern 112bpm) ─┐
                             ├─► source1(valueSwitch, index 0)
track1(audioFileIn — DROP    ─┘   0 = pattern, 1 = your file
        YOUR TRACK HERE)                    │
  analysis1(component:audioAnalysis@1) ◄──────┤   ONE instance (T1234); every lane below
        │ levels ─► lvl1(valueSelect)           │   is an expression on one of its two bags
        │      ├─► state.substeps      = clamp(8 + 24·low, 1, 34)
        │      ├─► shape1.whitelevel   = 0.48 + 0.07·lowMid
        │      ├─► grow1.s             = 1.008 + 0.021·low
        │      └─► tint1.scale         = 1.6 + 1.3·highMid
        └ hits ───► hit1(valueSelect)           │
               ├─► warpa1.weight       = 0.14·kickCount
               ├─► warpb1.weight       = 0.06·snareCount
               ├─► warpc1.weight       = 0.02·hatCount
               └─► glow1.brightness    = 0.94 + 0.3·onsetCount
  EVENT ── trig1(trigger, RAW) ◄────────────────┘
               ├─► gate1.threshold     = 2 − 1.28·onsetCount
               └─► crest1.opacity      = 0.02 + 0.6·onsetCount
  CLOCKS (T1237, never on a beat):
    band1(lfo 80 s) ─► rd1.morph     stencil1(lfo 120 s) ─► rd1.shape, rd1.facet (0.6·)     grain1(lfo 164 s, ±0.3) ─► rd1.anisotropy

WHERE THE ORGANISM LIVES — one disc, read twice, never drawn:
  bowl1(circle, off-centre) ─► rim1(invert) ─► dish1(screen) ◄─ shape1   ⇒ chemistry
  bowl1 ────────────────────► sow1(multiply) ◄─ spark1                   ⇒ the beat's seed

broad1 ─► warp1 ◄─ detail1     state(feedback, source: pack1)      sow1 ─► gate1
              │                     │                                          │
              ▼                     ▼                                          ▼
 shape1 ─► dish1 ─────────► pack1 ◄─ inject1(screen, 512²) ◄─ rd1 ◄─ wind1(displace) ◄─ (the loop)
                                                                       └─ swell1(noise, mono off) — the flow field
              │                            │
              └─► chem1(invert) ─► blend1(add) ◄─┘
                                       └─► tint1 ◄─ palette1

THE OUTWARD DRIVING FORCE — a second loop, and a beat is the only thing that feeds it:
  rings1(radial ramp, period 8, phase ◄─ lfo1)
        │
  tint1 ─► stamp1(add, opacity 0.32 on the PICTURE) ◄─ rings1 at full
        │        │
        │        ▼
        │   crest1(add, opacity ◄─ trig1) ◄─ cap1(clamp 0..1) ◄─ dim1(level) ◄─ grow1(scale ▸1) ◄─ echo1
        │        │                                                                  (feedback, source: crest1)
        └─► show1(add) ◄────────────────────┘

show1 ─► warpa1 ─► warpb1 ─► warpc1 ◄─ crest1 (the ring field IS the finest lens)
                                 └─► tapr1 ─► fringerg1 ─► fringe1 ─► glow1 ─► hue1 ─► out
                                 └─► tapg1 ──────┘             ▲                  ▲
                                 └─► tapb1 ─────────────────────┘   drift1(lfo 0.033Hz)┘
```

## The source is a SWITCH, and it could not have been a wire (T504, T508)

The owner's ask was "quickly drop in an audio file instead of a pattern... so it's easy to
switch around between the two **without mixing them together**". The last four words are the
whole design.

**Wiring both sources into one value port does not mix them — it makes one of them
disappear.** The value graph merges every edge landing on one port, `{...prior, ...next}`
over sorted edge ids (§V457). That merge is deliberate and useful: it lets a multi-wire input
compose bags of *different* channels. But `audioPattern` and `audioFileIn` publish the
*same* names — `level`, `low`, `lowMid`, `highMid`, `high`, `onset`, `onsetCount`,
`onsetMax` — so on that port the later edge wins outright and the earlier source is simply
gone, with the graph still looking correct. (Since T509 it at least warns.)

So exclusivity has to come from a node, and `valueSwitch` (T508 — TD's Switch CHOP) is it:
the unselected branch is not read into the output at all. There is no blend setting, because
a crossfade between two unrelated tracks' band energies is not a thing anyone wants; it is
just a quieter version of both.

**Why it reads at a glance.** `track1` sits directly beneath the pattern it replaces, wired
into the same box, with an empty File parameter waiting. The port order *is* the branch
order — value ports are named, so `in1`/`in2` is unambiguous by construction, unlike the
texture Switch's variadic port where the order has to be declared on the edges (§V131, and
E27 shipped opening on a black webcam because of it).

**A third branch is free, and deliberately not taken.** `valueSwitch` has four ports; wiring
an `audioIn` into `in3` would make index 2 the microphone. It is not shipped that way because
the first `audioIn` in a graph OPENS THE MICROPHONE on load, and an example that asks for
device permission the moment you click it is not a demo, it is an ambush. Add the node
yourself and index 2 is live input.

**With nothing bound, index 1 is honest silence, not a broken frame** (§V329): an unbound
`audioFileIn` projects all-zero channels, so the substeps rest at their base and the
chemistry sits mid-band. The picture keeps animating on its own LFO either way.

T493 gave `audioFileIn` a real transport — play mode, speed, cue, trim, volume — and it is
on its defaults here, which is a **timeline-anchored** playhead: bar one of your track lands
on the in point, a scrub finds the same second, and an offline render reproduces (§V436,
§V45). Once T493's transport UI is exercised, driving `cue` from the graph would let the
track be re-triggered as part of a performance; that is the obvious next thing this example
should show and it is not shown yet.

## Three lenses and some room to breathe (T507)

The owner's two notes on the look were that the reference "used something like 3 layers of
lenses or displacements to make things more interesting", and that "the two noises need a
little more negative space too for more structure". They are separate fixes.

### Negative space, and the direction of the fix is the finding

The dish used to sit wall-to-wall in the labyrinth regime: every part of the frame striped
at once, so there was no empty field for the structure to resolve against and the whole
thing read as one texture — a fingerprint.

`shape1` is the lever, and **the first attempt went the wrong way.** Raising `blacklevel`
pushes more of the map to the LOW end of the feed/kill band, and I expected that to sparsen
it. It did the opposite: **Gray-Scott's low corner (feed 0.028 / kill 0.0545) IS the
labyrinth**, and the high corner is spots and mitosis, which is where the empty field lives.
So negative space means putting the map's REST STATE in the high corner and letting it dip
into the low one.

Fixed at the chemistry rather than by masking the output, because §V427's whole point is
that the structure belongs to the simulation. Giving it room is a chemistry decision.

## The map was a field in name and a constant in fact (T562)

The owner's next note was that the dish "already felt pretty dense and regular instead of
interesting with sparser regions sprinkled in". It is the same lever again, and this time
the failure was measurable rather than aesthetic.

The kernel reads its feed/kill coordinate per fragment — `centre.b`, painted by the graph
and packed by `pack1` — so the chemistry has always been a FIELD. It just had nothing in
it. Measured at frame 322 of the shipped file, that field's own histogram ran 0.45…1.00
with a median of 0.645 and **half of every frame inside 0.60…0.69**. Across the band that
is feed 0.0364 to 0.0377, and Gray-Scott is famously sensitive at the *thousandth*. Every
region of the picture was running the same chemistry, which is exactly what "dense and
regular" looks like.

Two causes, both fixed on the map and neither in the shader:

- **One spatial scale, and it was bigger than the frame.** `detail1` only ever *warped*
  `broad1`; it contributed no value of its own. With `broad1` at period 0.62 and two
  octaves, the rendered map was a flat pale cloud. It now runs period 0.30 with three
  octaves — features at roughly 150, 75 and 38 pixels of a 512 frame, which is several
  Gray-Scott features per region rather than one region per frame.
- **A window twelve times wider than the signal in it.** The warped field's p10…p90 is
  0.465…0.539 — an interquartile of 0.039 — and `shape1`'s window was 0.485 wide, so the
  Level was mostly moving DC around. The window is now 0.451…0.543, fitted to the measured
  spread, with `contrast` back at 1 (a narrow window *is* the contrast; two controls doing
  one job is what made the old set so hard to reason about) and `gamma1` at 1.25 to lift
  the midtones.

The map's histogram after: about 7% pinned at the labyrinth end, median 0.63, 99th
percentile at the mitosis end. Sparse ground, dense veins, several regimes in one frame —
and the tails fall *outside* the window on purpose, because the kernel clamps the
coordinate, so the deepest patches sit at one corner and the airiest at the other rather
than everything crowding the middle.

## The composition, and it was never a tuning pass (T598)

The owner asked for this example three times and supplied a **reference image** on the
third: *"still lame and is missing this multi-layered outward driving force and some
feedback."*

Every earlier round argued about the TEXTURE. The reference is an argument about the
COMPOSITION, and the two things are not the same however good the texture gets. Measured,
side by side, on the reference and on the file it was rejecting:

| | reference | E24 before | E24 now (across a beat) |
| --- | --- | --- | --- |
| frame under 0.08 displayed luma | 77.9% | 65.2% | 66% … 87% |
| 90th percentile luma | 0.127 | 0.431 | 0.10 … 0.25 |
| mean chroma over the lit pixels | 0.067 | 0.527 | 0.19 … 0.27 |

The old file was a wall-to-wall carpet with a bright ninetieth percentile: beautiful
texture, no picture. The reference is four fifths dark, with the living material a small
dense cluster off the middle and concentric rings crossing everything else.

### Where the organism is allowed to exist — one disc, read twice, never drawn

`bowl1` is a soft circle, off-centre, and it is the whole occupancy decision in one node's
`center`, `radius` and `softness`. It is read TWICE and drawn never, which is §V471.1's
"one source, several readings" in the shape a texture graph can have it:

- **inverted, into the chemistry.** `rim1` flips the disc to 1 *outside* and `dish1`
  SCREENS that into the map. `1−(1−a)(1−b)` is exactly `mix(map, 1, rim)` for a 0..1 rim,
  so outside the disc the feed/kill coordinate is pinned at the band's HIGH corner.
- **straight, onto the seed.** `sow1` multiplies `spark1` by the disc *before* the gate, so
  the sparse field is exactly zero outside it and no beat can strew a one-frame sprinkle
  across the empty four fifths of the frame.

**The black is the simulation being genuinely empty, not a matte over a full-frame one.**
§V474 said the high corner is where empty field lives; the arithmetic says why. At feed
0.042 / kill 0.068 Gray-Scott fails its own existence condition — a non-trivial steady
state needs `F ≥ 4(F+k)²`, and 0.042 against 0.0484 does not have one — so V there does not
merely go sparse, it decays to nothing. The soft edge of the disc is a gradient *through*
the band, so the colony frays into spots before it stops, which is the edge a matte cannot
give you. §V427 is the reason to want it this way round: the structure is the simulation's.

### The outward driving force, and the feedback that carries it

Six nodes, and every one of them is E29-Descent's mechanism rather than a rediscovery of
it. E29 paid thirteen builds for these two traps and §V481 is the receipt.

**A ring is born by a TRIGGER, and that is the load-bearing line.** Anything added into a
persistent loop every frame is a DC term: at persistence 0.987 the loop integrates it about
seventy-fold and the frame goes white. So `crest1`'s `opacity` sits at **0.02** at rest and
**0.55** for the ONE frame `trig1` fires. A beat STAMPS a fresh family of rings and the
current picture into the loop; between beats nothing enters it at all, and the mean input
is a thirtieth of the peak by construction rather than by luck. Which is also, exactly, the
owner's own sentence: a beat sends a ring outward.

`rings1` is a RADIAL ramp at `period: 8` — one node, eight concentric rings, which is
"several ring systems at different scales" read literally. Its `phase` rides `lfo1`, the
palette's own 20-second sine read a second time, so consecutive beats do not stamp at
identical radii and the set never stands still.

**The stamp carries the living picture as well as the rings, at a third of its strength.**
`stamp1`'s `opacity` scales its FRONT only, and the front is `tint1` — which looks backwards
in the stack and is the only wiring that works. The reference's outer speckle is not several
colonies; it is the SAME colony at three or four sizes, further out and blurrier each time.
Those are strobed copies of the material, which is what a magnifying loop does to anything
dropped into it once per beat. Wired the other way round the number lands on the rings
instead: they go three times too faint while the echoes go three times too hot, and the
frame becomes a bright smear with a couple of arcs in the corner of it. (Measured. It is an
easy mistake, because the ring is the thing you are thinking about.)

**An expanding loop does not dim itself** (§V481a). `s > 1` DIVIDES the sampling
coordinates, so `grow1` magnifies about the frame's centre and DUPLICATES pixels — nothing
leaves, nothing is diluted, and a near-unity gain goes to white in seconds. Every part of
the decay here is deliberate: `echo1`'s persistence, `dim1`'s black point, `dim1`'s gamma.

**And §V481(c)'s sign has to be checked against this catalogue's own shader.** Level
computes `pow(c, 1/gamma1)`. Contractive therefore means `gamma1` **below** one: 0.98 is the
exponent 1.02, under `v` everywhere in [0,1). A `gamma1` above one in this node is positive
feedback, exactly as a Contrast above one is. (E29's `fade1` carries a comment claiming
`gamma1: 1.12` is "below v everywhere"; the shader says the opposite. Its loop is stable for
other reasons — that is a note for whoever next reads E29, not a defect found here.)

**THE COMPOSITION IS ALSO THE STABILITY.** The one thing that made this blow out was moving
the colony onto the pivot: an expansion has a fixed point, material sitting on it never
travels, and it integrates instead. At `bowl1.center` = (0.455, 0.545) the 90th percentile
went to **0.93** and stayed there. At (0.395, 0.635) — the reference's own off-centre
composition — it settles at 0.10…0.25 and is still stable at frame 900. The picture being
off-centre is not a taste call; it is why the loop terminates.

`grow1`'s scale rides the audio (`low`), which is E29's lurch: the field SURGES outward on
the kick and settles over the beat. Both fences are arithmetic rather than a clamp — the
band is 0..1 and the pair spans 1.012…1.029, so it can neither stop expanding (which piles
up into white) nor outrun the eye. A Limit node there would fence a range the gain cannot
leave.

The loop closes on the GRADED picture (§V471.5), so the echoes carry the ramp's own colour
rather than raw simulation state, and `show1` puts the LIVE colony back on top at full
strength — the thing you are watching is never the loop's own copy of itself.

### The fringing was already here; it needed something to move

The reference's iridescence is channel separation, and E24 has shipped an RGB delay since
T425. **Nothing was added for it.** Motion fringing needs motion, and a Gray-Scott dish
creeping a texel a frame gave the 2/4/7 taps almost nothing to separate. Rings that travel
give them plenty: a ring crossing r = 0.4 moves about 2.5 px a frame, so seven frames of
delay put the blue tap most of a ring-width behind the red one and every arc wears a green
leading edge and a magenta trailing one. Zoom into the colony and the same delay renders
each front as a bead of red, gold and violet. That is one existing node earning its keep
because the composition finally moves, and it is the cheapest thing in this round.

### The simulation was riding on the output resolution, and nobody could see it

Composite inherits its size from `in1`, and `inject1`'s `in1` is the seed GATE — which it
has to be, because `opacity` scales the front and that is what makes `opacity` mean "how
much V a hit drops in" (§V510). The gate is a `project`-resolution chain. So the loop ran
512-square through `rd1`, was DOWNSAMPLED to the output's size at the composite, and was
resampled back up by `state`: a low-pass through the whole reaction, once per frame.

At a 512-square output that is a no-op and it hid for three rounds. At T521's 192×108 probe
it wipes Gray-Scott's structure out, and once T598's disc confined the chemistry to a fifth
of the frame there was not enough left to survive it — the probe measured a contrast range
of **0.0700** and a colony that had DIED by frame 600. Pinning `inject1` to the state's own
512-square takes the output resolution out of the simulation entirely, which is where it
should never have been. The probe's range went 0.0700 → **0.9812** and its motion 0.00184 →
**0.01001** on that one change, and the 512-square picture is unaffected because there it
was already the same number.

### Three lenses, and the point is that they are at different scales

Stacking is not "turn the displacement up". One strong displacement is a smear and a smear
has no depth in it. `warpa1`, `warpb1` and `warpc1` run in series on the coloured output,
each about **2.5× finer and 2.5× faster than the one before it, with a third of the
weight**:

| | period | speed | band | weight, rest → peak |
| --- | --- | --- | --- | --- |
| `warpa1` | 1.15 | 0.018 | `low` | 0.042 → 0.139 — a broad swell you feel rather than see |
| `warpb1` | 0.42 | 0.046 | `lowMid` | 0.018 → 0.050 — the sway the fronts ride on |
| `warpc1` | 0.14 | 0.115 | `high` | 0.007 → 0.017 — the only one touching individual ridges |

The weights come down as the frequency goes up for the same reason a fractal's gain does:
equal weight at every scale is white noise, not depth.

### The lens weights are fenced, and what that does and does not fix (T738)

Each of the three weights used to end in a Limit — `lenswa1`, `lenswb1`, `lenswc1` — floored
at **0** and capped at `gain + bias`. T1234 removed the three nodes and kept the fence: each
weight is now a bare gain on a drum COUNT out of `hit1`, and a count rests at exactly 0 and
never exceeds 1, so `0.14 · kickCount` spans 0..0.14 by arithmetic rather than by a clamp.
The floor is still the part that matters, and this is why.

Without it, these three pairs were the only gain+bias chains in the document without a
range check, and under real music that omission **inverted a lens**. Measured on three recorded tracks, 2400 frames each:
`warpc1.weight` ran negative for **20.2%, 32.7% and 99.9%** of the three tracks — on the
bass-heavy one its median was **-0.0454**, negative for effectively the whole piece. A
negative displace weight is not a quiet lens, it is one pushing the picture the other way.

The fence lives on the chain and **not** on the parameter on purpose. `displace.weight` is
declared -2..2 because a signed weight is meaningful — E12-Fluid's `advect1` uses weight
**-1** to advect backward. "Never negative" is true of *this chain*, not of the node.

**What it does not fix.** On material with little or no top end, `warpc1` now rests at its
floor — the fine lens is **off for the whole track** rather than inverted. That is honest,
not fixed: an inverted lens is a wrong picture, an absent one is a missing effect, and
this trades the first for the second. The cause is upstream of E24 — the bias was tuned
against `audioPattern`, whose 1st percentile equals its median because a periodic beat
returns to the same floor every bar, so a rest state fitted just under that floor sits
*inside* real music's lower tail. The grade lane showed the same thing at its other rail,
pinned low for 96.9% of that track. Fixing the tuning basis rather than the consumers was
T766's question, and T1234's rank is the answer this file took: a rank has no tuning basis.

A band the music does not contain is a separate matter again: that track's `high` has a
median of **0.000**, so the fine lens has nothing to respond to and resting off is the
correct behaviour, not a shortfall.

**All three amounts are on the audio (T560), one drum each**, which is what finally
makes this structure audible: coarse on the kick, mid on the snare, fine on the hats. T1234
moved them from raw bands to the analysis' drum counts (`kickCount`, `snareCount`,
`hatCount` through `hits`): a band is loud for as long as the sound is, a count is a 1 ms
attack and a 250 ms decay, which is the shape of a lens that FLEXES on a hit rather than
one that sits pushed for the length of a bass note. Driving all three from one envelope
would collapse the three scales back into a single pump. The retained values are the
weights T507 tuned, so a host with no channel attached still gets that picture.

**`mono` is off on all three, and that is the difference between a lens and a shear.**
`displace` reads x from red and y from green, so a *monochrome* field has red == green and
every pixel moves along the same 45° diagonal — the image slides rather than warps. (E24's
older `warp1` on the chemistry map is mono and does exactly that, deliberately; a diagonal
shear of a feed/kill map is a fine thing to want. It is just not a lens.)

They sit **after** the palette and **before** the cache rings, so the RGB delay tastes the
lens motion: glass that moves disperses, and the fringing follows the warp.

All three noises run on `absTime` (T497) and start at `t4d: 0.37` rather than 0 — zero sits
on a lattice plane of the 4D noise where amplitude collapses, which makes frame 0
systematically flatter than the piece it is supposed to represent, and frame 0 is the frame
a user opens on (T535; the card itself moved to frame 60 under T794, but a flat first
second is still a worse first second).

## The mappings, and why each is shaped the way it is

**Bass → substeps: the beat makes the simulation FASTER.** `clamp(8 + 24·low, 1, 34)` on
`state.substeps` — a per-frame VALUE since T425, so no recompile, no history wipe, just
more Gray-Scott iterations encoded on loud frames (8 at the rank's floor, 20 at rest, 34
at its ceiling). The cap is enforced twice on purpose: the expression's own `clamp` fences
the value in the graph, and the encoder clamps again at expansion — a loud passage cannot
spike frame time unboundedly through any path. This is also the honest reading of "audio-reactive": the CHEMISTRY runs
faster, rather than a brightness knob pretending.

**Mids → chemistry, range-mapped with safe bounds.** The tutorial's own warning is the
teaching. `0.48 + 0.07·lowMid` nudges the chemistry map's white point across 0.48–0.55 —
because outside the band where fronts keep dividing, the pattern doesn't distort, it
DIES, and dead Gray-Scott is a fixed point: silence does not bring it back. The rank is
0..1 by construction, so the two literals ARE the fence, and they were measured (T1234):
a static white point of 0.49 covers 39% of the disc, 0.55 covers 68%, 0.60 covers 83% and
is the wall-to-wall picture this file exists to avoid. The bound is what makes this an
instrument you can play loudly and recover, not a tuning nicety.

## Five fast paths, and why they had to exist (T560)

The owner's read of the shipped file was "I don't even see the audio reactivity — maybe
some stuttering, but nothing compelling". They were right, and it was arithmetic.

**Everything the sound touched ran through a slow integrator.** Feed/kill and the substep
count are both the reaction, and a reaction INTEGRATES a beat into a gradual regime change
over dozens of frames. Measured across the beat at frame 194 of the shipped file: p90
luminance moved 0.0599 → 0.0615 and p99 moved 0.4000 → 0.4036. **Under one percent.**

**And the one path that was meant to be fast was dead.** `trig1` emits a one-frame pulse;
it fed a Lag of 0.35 s; and a one-pole smoother answers a single-frame impulse with
`1 − exp(−Δt/τ)`, which is 0.047 at 60 fps. The palette's driven scale therefore travelled
2.4000 → 2.4535 on a hit — a 2% swing, described in the comments as "the kick PUNCHES the
lookup's gain". It is §V481(b) seen from the other side: an impulse into a smoother is an
impulse *divided by the frame rate*, which is also why the seeding below reads the trigger
raw and lags nothing.

T560's fix was §V471.3 transplanted from E31 — one band to one property, each with its own
gain and bias, off a SECOND and much faster Lag (`snap1`, 0.04 s). T1234 kept the split
and moved the lanes onto the analysis component (below); as they stand now:

| channel | bag | property | rest → peak | what you see |
| --- | --- | --- | --- | --- |
| `kickCount` | hits | `warpa1.weight` | 0 → 0.14 | the whole picture swells on the kick |
| `snareCount` | hits | `warpb1.weight` | 0 → 0.06 | the fronts sway with the snare |
| `hatCount` | hits | `warpc1.weight` | 0 → 0.02 | the ridges shiver with the hats |
| `highMid` | levels | `tint1.scale` | 1.6 → 2.9 | the ramp breathes (§V471.7) |
| `onsetCount` | hits | `glow1.brightness` | 0.94 → 1.24 | the whole frame lifts, 250 ms |

and T598 added three more; two are events and read `trig1` RAW, not through `hit1`:

| channel | bag | property | rest → peak | what you see |
| --- | --- | --- | --- | --- |
| `onsetCount` | trig1 | `gate1.threshold` (a CUT) | 2.0 → 0.72 | the beat seeds new chemistry |
| `onsetCount` | trig1 | `crest1.opacity` | 0.02 → 0.62 | the beat sends a ring outward |
| `low` | levels | `grow1.s` | 1.008 → 1.029 | the whole field surges outward and settles |

That is **ten** properties on the audio. E31-Corona, the file §V471 was measured from, has
eight; this is the count half of T580's gap closed. The other half was three readings of one
source, and there are now three of those: `bowl1` read inverted into the chemistry and
straight onto the seed, `shape1` read as feed/kill and again (inverted, dimmed) as colour,
and `crest1` read as the picture's own light and again as the finest lens.

§V477 governs every one of those pairs: **the bias is the rest state and the gain is the
swing**, so the hit lanes rest at their floor and a hit has somewhere to travel to. The
level lanes rest in the MIDDLE, and that is the rank's doing, not a tuning: see the T1234
section below. `tint1.scale` spans 1.6…2.9 against a Lookup Scale declared −4…4, which is
the third fence (T544) stated as the expression's own range.

## One analysis instance, and the lanes are expressions (T1234)

The graph above used to carry **33 conditioning nodes**: two Lags (`env1` at 0.12 s, `snap1`
at 0.04 s) reading the source, and thirteen gain·bias·limit lanes of value math and
value limits between them and the properties. T1234 replaced the lot with one
`component:audioAnalysis@1` (`analysis1`, 8 ms envelope, 16-frame ranking window, 0.15 s
settle, 250 ms hit decay), two 0..1 bags — `lvl1` on its `levels` output, `hit1` on its
`hits` — and one expression per property. The node count is the visible change; the reason
is what the old lanes were measuring.

**A raw band × gain lane is a statement about one source's loudness.** Measured over
30 s at the disc, bowl occupancy — the fraction of disc pixels with V above 0.5 — was
**21.5% on the Beat pattern and 5.8% on the clip**, same graph, same gains. The bass band
of a 112 bpm pattern and the bass band of a recorded track are not on the same scale, and
every lane had been tuned against the first. The analysis' `levels` are the envelope
RANKED over its window (§V952): 0..1 says "louder than most of the last sixteen frames",
whichever source those frames came from. After the move, over the same 30 s: **pattern
16.7%, clip 17.8%** — the two sources converge on one picture, which is what the lanes
were supposed to do all along. Over a 120 s walk of the pattern the mean is 20.9%,
ranging roughly 8%–42% with `band1`.

**Continuous through `levels`, counts through `hits`, and the trigger raw.** The four
continuous properties (substeps, white point, expansion rate, palette scale) read the
rank; the four drum properties (three lenses, the glow lift) read the analysis' hit
counts, whose 1 ms attack and 250 ms decay is the shape a lens flex wants. `gate1` and
`crest1` still read `trig1` directly: the gate must be open for exactly one frame, and a
250 ms decay through `hit1` would hold it open for fifteen and seed a wash.

**What kind of pattern the disc grows is on three slow clocks (T1237), never on a beat.**
`rd1`'s `morph` (0..1, the band's low endpoint toward the holes regime), `shape` (−1..1,
cross against diagonal in the stencil) and `anisotropy` ride `band1` (80 s), `stencil1`
(120 s) and `grain1` (164 s), three incommensurate free-running laps, so the same spots-
labyrinth-stripes combination does not recur inside a set. A regime change per beat is a
strobe of unrelated textures, which is why none of the three touches `hit1`. `grain1`
swings ±0.3 against T1237's measured ceiling of 0.35: past ±0.5, stripes stay alive in the
band's high corner where spots die, and E24's black IS that corner being dead.

**The echo loop is capped, and the old file was shrinking.** `grow1.s` used to rest at
0.982 through the raw lane — a loop the comments called an expansion was contracting at
rest and only expanded on a loud bar. On the rank it runs 1.008…1.029 always, and that
exposed §V481(c) on the clip: `dim1`'s gamma of 0.98 is contractive only in [0, 1) and
GROWS above 1, so once a bright ring stacked past about 1.9 the top-right corner diverged
to inf and rendered magenta. `cap1` clamps the loop to 0..1 between `dim1` and `crest1`;
measured at frames 1800 and 3600 on both sources, the streak is gone and the rings read as
before.

**§V477 and the liveness gate used to pull against each other here, and T598 dissolved
it.** T521's contrast floor asks that the 0.1st-to-99.9th percentile span of frame 180 clear
0.30 at 192×108, and this file used to measure **0.2325** and fail: a picture whose fronts
rest in the violet has no dark end to span from, so the rest states were pushed HIGHER than
§V477 wants and the trade was written down here rather than tuned quietly (T581).

It measures **0.9812** now, and neither half of that came from raising a rest state. Four
fifths of the frame is the simulation being genuinely empty, which is a real black point;
and the resolution bug above was costing the probe most of its span. A dark-resting picture
was never the problem — a picture with no dark in it was.

**Kick → the beat SEEDS the plate.** This is the one that makes a hit legible rather than
merely measurable. A beat that nudges a rate is a rate change; a beat that spawns structure
is an event, and Gray-Scott is unusually good at it — drop V into the plate and the reaction
grows it for the next second on its own. `trig1` thresholds `onsetCount` (counted rising
EVENTS, T437, not a beat claim) and drives `gate1`'s CUT, not a brightness: at rest the cut
sits at 2.0, which nothing in a 0..1 field can reach, so the gate is exactly shut; on the
frame a hit lands it drops to 0.72 and about one percent of `spark1` passes through — a
scatter of small dots, not a wash. The amount matters less than it looks: with eight to
thirty-four substeps per displayed frame the reaction amplifies whatever it is handed
within one frame, so what is being tuned here is COVERAGE, not brightness.
`inject1` SCREENS that into the simulation state, and screen is the operator this wants
rather than a convenience — `1−(1−a)(1−b)` takes U and V to 1 where the mask is 1 and leaves
them untouched where it is 0, and (U=1, V=1) in a small patch is *literally* the kernel's own
`seededState`. Composite's `opacity` scales the front only, so wiring the mask as the FRONT
turns `opacity` into "how much V a hit drops in" with no extra node to hold it.

A Level would have been the wrong gate: it goes negative below its black point, and a
negative through `screen` brightens — a DC term in a persistent loop, which is precisely the
failure §V481(b) is about. `spark1` runs at `speed: 0.9` so consecutive beats seed different
places.

**Colour that goes somewhere, and colour that evolves.** Two separate asks and two separate
mechanisms. `palette1` now carries seven stops on E31's arc — near-black, navy, blue,
violet, crimson, gold, cream — which crosses HUE as well as brightness; a ramp from navy to
cream through nothing is a monochrome picture however many stops it has. And `drift1` is a
**0.033 Hz LFO — a 30-second lap (§V471.8)** — on `hue1`'s offset, so the finished picture
turns through ±15° of hue and never sits in one colour. Free-running (§V436, B98): a
timeline lap must not restart the drift. (E31's own hue drift is worth comparing: its LFO
amplitude is 0.35 against a `hueoffset` declared in DEGREES, so it swings a third of a
degree. §V471.8 is the right idea; the file it was measured from does not implement it.)

**One source, several readings (§V471.1).** E31 gets its richness by drawing one point
cloud three times and splitting it by group predicate — structure from SELECTION rather
than from more nodes. The texture analogue is `chem1`: the chemistry map read a SECOND
time, dimmed and added to the simulation's V before the palette lookup. T598 made it read
the MASKED map and INVERT it, and both halves are forced by the composition rather than
chosen. `dish1` is pinned at 1 outside the disc, so reading it straight would lift the empty
four fifths of the frame to ramp position 0.25 — a navy ground everywhere, which is the
wall-to-wall look this whole round exists to remove. Inverted, the dead field contributes
exactly zero and the ground is the ramp's own first stop, which is black. Inside the disc
the sense is the better one anyway: a region running the LOW (labyrinth) chemistry is the
dense one, and it now gets the warmer base rather than the colder. It is
there because V in Gray-Scott is **near-binary** — empty plate or front, nothing between —
and a near-binary coordinate visits exactly two positions on a ramp however many stops that
ramp has. That is why the shipped file was cream fronts on navy with the blue and teal in
the middle of its own palette never on screen. The added continuous term moves each region's
ground to its own place on the ramp and carries its fronts with it: **the hue now says
which chemistry you are looking at, and V says how far along the reaction is.**

**Wind, inside the loop — and it advects, it does not rotate (T734, §V626).** `wind1` sits
between the Feedback and the kernel (state → wind → rd), and because substeps multiply
iterations it runs eight to thirty-four times a frame, so the bass literally stirs the
dish faster. The loop stays a NAME (`source: "pack1"`, T350) while its body grew a node.

For most of this file's life that node was a **Transform with `r: 0.02`** — a rigid rotation
applied twenty-odd times per frame. It looked like stirring and it was not: a Gray-Scott
lattice is stable because its substrate is stationary, and a rotation carries the substrate
*with* the pattern, so nothing shears. It turned the lattice and left it a lattice. That is
the mechanism behind "gets very lame and boring and evenly covering the screen very early
on" — the plate had reached its lattice and the wind was decorative.

It is now a **Displace at weight 0.0002**, fed by `swell1`, a slow two-channel perlin
(`mono: false` — one channel offsets every texel identically, which translates the dish
rather than shearing it). The chemistry map is not carried along: `pack1` repaints blue from
`dish1` *after* the reaction, so the state slides across a stationary parameter field, which
is the thing that shears. Same slot, same edge out, different kind. Measured at frame 1800:
frame-pair motion **0.0462 → 0.0624** and live spot count **238 → 907**, and it beats the
rotation on motion at every age measured. Zeroing the weight renders a perfectly plausible
picture and collapses moved pixels three-to-twelve fold, which is why it is gated on pixels
rather than on structure alone.

**Weather was measured here too, and rejected.** E2 documents the whole comparison; the
short version is that this file's in-disc map already swings across the band on its own
(median 0.672 → 0.386 → 0.305 across frames 300/900/1800), and multiplying a travelling
front into it walks the chemistry *down* — toward the dense-labyrinth end, which is the most
screen-filling regime there is. Measured after the advection landed, in-disc tile CV went
0.430/0.237/0.307 to 0.300/0.232/0.249 and in-disc spot count went 462/907/470 to
1120/2472/1631: three times the spots, finer and flatter. That is the complaint restated,
not fixed. E2 and E24 both carry the single mechanism.

**The RGB delay is TIME, not space.** Three cache rings tap the coloured output at 2, 4
and 7 frames back; two Reorders wear one channel from each. Moving fronts fringe into
rainbow; still regions stay clean — which is the tell that this is temporal. The naive
translation (scaling channels apart spatially) is chromatic aberration: it would fringe
STILL pixels too, and that is the wrong effect wearing the right name.

The taps used to sit at 2, 5 and 9, and T560 shortened them for a reason worth writing
down: **a delay line longer than a transient turns that transient into pure primaries.**
Once a beat seeds new structure, a blob appears and is consumed within a frame or two; at
a spread of seven frames each channel caught that flash alone, so every seed rendered as a
saturated green disc that is in no stop of the palette. At a spread of five the channels
overlap through the flash and it reads as a warm core with coloured edges — which is what
motion fringing is supposed to look like. The effect is unchanged; the delay is now scaled
to the fastest thing in the picture.

## Silence, stated

Swap in a live source and mute it, and the analysis' `hits` read all-zero while its
`levels` sit at **0.5** — a constant input ranks at its own mid (§V952), so silence is the
middle of every level lane, not its floor: substeps rest at 20, the white point at 0.515,
`grow1.s` at 1.0185, the grade at 2.25. The hit lanes rest at their floor: the three lens
weights at 0, `glow1` at 0.94, the gate never opens — and the noises, the palette LFO, the
three T1237 clocks and the 30-second hue drift keep the picture breathing. The retained
values are those same numbers, so a host with no audio attached renders silence rather
than a rest state the analysis cannot produce.

**T598 made silence a quieter picture than it was, and deliberately.** The rings are born by
a trigger, and in silence no trigger fires: `crest1.opacity` sits on its 0.02 rest, so the
expansion loop receives a trickle and the frame is the colony alone. Measured with
`source1.index = 1` and no file bound, p90 goes to 0.0019 and 7% of the frame is lit; with a
loud track on the same switch it is 0.135 and 73%. That is a large swing and it is the point
— a beat is the only thing that sends a ring — but it does mean the true-silence frame is
the colony breathing on its own noises rather than the whole composition. The file ships on
`index 0`, the Beat pattern, which is what anyone opening it sees. Every audio mapping is an ADDITION on top of a self-animating base. An `audioFileIn` with no file chosen SAYS so — the inspector's
Audio section reads "Waiting for a file" rather than an idle that looks finished.

## Regression signatures

- Pattern dies on a loud passage and never returns → a safe bound came off (the white
  point's expression reaches past 0.55, or someone widened the band past where the
  chemistry survives).
- Beat changes brightness but not GROWTH RATE → substeps stopped being driven (the
  T425 value path broke) and something is faking it downstream.
- Colour fringes even when the image is still → the delay went spatial; the caches or
  the channel braid were replaced with per-channel scaling.
- Kicks fire on sustained loud passages → `onsetCount` regressed toward an energy level
  (it must count rising EVENTS; T437's threshold semantics).
- A beat is measurable but not VISIBLE → a fast path went back onto a level, or a pulse
  acquired a Lag (there is no Lag node in this graph, and the gate reads `trig1` raw). Check the numbers: across the beat at frame 193 the output's p90 should
  move by about a third on the landing frame and reach three times calm within five, then be
  back inside fifteen. Under 5% means everything is on the integrator again.
- The picture is one texture everywhere → the chemistry map lost its spread. Render
  `shape1` on its own and look at the histogram, not at the image: it should reach both
  ends of 0..1, not sit inside a tenth of it.
- Every hit renders as a saturated primary blob → the RGB delay's tap spread went back past
  the length of a transient.
- Frame time spikes unboundedly with loud audio → a clamp fell off one of the two
  fences (the substeps expression's `clamp`, encoder clamp at expansion).
- The frame goes white within a few seconds → something is feeding the expansion loop every
  frame instead of on the trigger (§V481b), or the colony has been moved onto the pivot at
  (0.5, 0.5) where an expansion has nothing to carry it away.
- Rings but no travel — a fixed moiré → `grow1.s` fell to 1.0 or below. At or under unity
  the loop stops expanding and piles up; above about 1.03 it reads as a flash.
- A magenta corner that grows → `cap1` came out of the echo loop and §V481(c) is back: the
  dimmer's gamma expands anything above 1.
- The Beat pattern and a recorded track render two different pictures → a lane went back
  to a raw band; occupancy over 30 s should agree within a few points on both sources.
- The texture strobes between regimes on the beat → `rd1.morph`/`shape`/`anisotropy` got
  wired to a hit; they are on `band1`/`stencil1`/`grain1` and nothing faster.
- Rings faint and the echoes hot → `stamp1`'s inputs were swapped. `opacity` scales the
  FRONT, and the front is the picture, not the ring family.
- The example looks fine at 512-square and dies at preview size → `inject1` lost its fixed
  resolution and the simulation is being low-passed through the output size once per frame.
- Four fifths of the frame stopped being black → `chem1`'s invert came off, or `dish1` is
  reading `shape1` without `rim1`, and the dead field is being lifted onto the ramp.
- The colony never turns square, or only on the first frame → `rd1.facet` lost its
  `stencil1` expression. `shape` alone cannot square spots this size (T1269, below).

## The squares are grown, not stenciled (T1269)

The owner asked for the colony to swing between round spots and "squares of sorts", and
T1237 built it: `stencil1` walks `rd1.shape` from −1 (the lattice stencil) to +1 (the
diagonal one) every 120 s. It never showed after the first frame. The stencil squares a
front through the 9-tap Laplacian's lattice error, and that error only shows on features
a few texels wide. E24's spots are 8–10 px on its 512 plate, where every split of the
weights looks round: pinned at −1 or +1 for a whole run, the colony at f600, f1800 and
f3600 looked like the shipped one. (T1237's own Dawn claims hold; they measure
grain-scale effects on E2's bench, a scale E24's features never reach.)

`rd1.facet` fixes it in the chemistry. Diffusion is scaled by the front's orientation,
1 + facet·cos4θ, with θ the direction of V's gradient, so a front advances faster along
two axes than the other two and grows flat faces at any feature size. It rides the same
lane as `shape` (`facet = 0.6 · stencil1`): −1 squares on the grid, +1 turns the squares
45°, 0 is round. 0.6 is the owner's pick from a strength ladder; past 0.9 the colony dies
back. At `facet` 0 the step is the one before this term, bit for bit, so E2 is unchanged.

Measured on `rd1`'s V with an energy-weighted cos4θ of the gradient (+ grid-aligned, −
turned, 0 round), shipped against the same file with `facet` cut:

| | 30 s (stencil +1) | 90 s (stencil −1) |
| --- | --- | --- |
| pattern, cut | −0.118 | +0.134 |
| pattern, shipped | −0.161 | +0.228 |
| clip, cut | −0.113 | +0.160 |
| clip, shipped | −0.143 | +0.292 |

The price is density. The faceted colony covers about a third less of the plate at 30 s
and about half as much at 90 s, where it is at its squarest (V above 0.25: 4.7% against
7.0%, and 2.0% against 4.2%, on the pattern). It keeps the labyrinth's fingerprint
texture between the squared passages, which the other candidate did not: shrinking the
feature scale until the stencil showed (option A) turned the labyrinth into sparse
dash-combs, and the owner chose this one over it from stills.
