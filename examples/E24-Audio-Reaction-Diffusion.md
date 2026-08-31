# E24 — Audio Reaction-Diffusion

E2's chemistry, played like an instrument — and it PLAYS THE MOMENT IT OPENS. The
music source is a deterministic beat pattern (`audioPattern`, 112 bpm), and it reaches
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
settled by about frame twelve. Two causes, both by construction rather than defect: the
feedback pair's alpha channel is the seeded-start flag, so frame 0 is the moment before
any chemistry exists; and the RGB delay's deepest cache ring is seven frames long, so
until frame seven one colour channel is still reading an empty ring. Worth stating rather
than hiding, because a gallery thumbnail is frame 0 — and T521's liveness gate holds a
declared exemption for exactly this, which is why the sentence has to live here where a
reader will find it.

## Graph

```
music1(audioPattern 112bpm) ─┐
                             ├─► source1(valueSwitch, index 0)
track1(audioFileIn — DROP    ─┘   0 = pattern, 1 = your file
        YOUR TRACK HERE)                    │
   SLOW ── env1(lag 0.12) ◄────────────────┤
             ├─► sgain1·sbase1·steps1 ┄► state1.substeps            (low)
             └─► wgain1·wbase1·wlevel1 ┄► shape1.whitelevel         (lowMid)
   FAST ── snap1(lag 0.04) ◄───────────────┤
             ├─► lagain1·lena1 ┄► warpa1.weight                     (low)
             ├─► lbgain1·lenb1 ┄► warpb1.weight                     (lowMid)
             ├─► lcgain1·lenc1 ┄► warpc1.weight                     (high)
             ├─► ggain1·gadd1·grade1 ┄► tint1.scale                 (highMid)
             └─► bgain1·bright1 ┄► glow1.brightness                 (level)
  EVENT ── trig1(trigger) ◄────────────────┘
             └─► seedamt1·seedcut1 ┄► gate1.threshold               (onsetCount)

broad1 ─► warp1 ◄─ detail1     state1(feedback, source: pack1)      spark1 ─► gate1
              │                     │                                            │
              ▼                     ▼                                            ▼
          shape1 ──────────► pack1 ◄─ inject1(screen) ◄─ rd1 ◄─ wind1 ◄─ (the loop)
              │                                │
              └─► chem1 ──► blend1(add) ◄──────┘
                                 └─► tint1 ◄─ palette1
tint1 ─► warpa1 ─► warpb1 ─► warpc1 (three lenses) ─► tapr1 ─► fringerg1 ─► fringe1 ─► glow1 ─► hue1 ─► out1
     └─► tapg1 ──────┘             │                                                             ▲
     └─► tapb1 ────────────────────┘                                          drift1(lfo 0.033Hz)┘
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

**All three amounts are on the audio now (T560), one band each**, which is what finally
makes this structure audible: coarse on the kick, mid on the snare, fine on the hats.
Driving all three from one envelope would collapse the three scales back into a single
pump. The retained values are the weights T507 tuned, so a host with no channel attached
still gets that picture.

**`mono` is off on all three, and that is the difference between a lens and a shear.**
`displace` reads x from red and y from green, so a *monochrome* field has red == green and
every pixel moves along the same 45° diagonal — the image slides rather than warps. (E24's
older `warp1` on the chemistry map is mono and does exactly that, deliberately; a diagonal
shear of a feed/kill map is a fine thing to want. It is just not a lens.)

They sit **after** the palette and **before** the cache rings, so the RGB delay tastes the
lens motion: glass that moves disperses, and the fringing follows the warp.

All three noises run on `absTime` (T497) and start at `t4d: 0.37` rather than 0 — zero sits
on a lattice plane of the 4D noise where amplitude collapses, which makes frame 0
systematically flatter than the piece it is supposed to represent, and frame 0 is what a
gallery thumbnail shows (T535).

## The mappings, and why each is shaped the way it is

**Bass → substeps: the beat makes the simulation FASTER.** `steps1` drives
`state1.substeps` — a per-frame VALUE since T425, so no recompile, no history wipe, just
more Gray-Scott iterations encoded on loud frames (base 14, up to 34). The cap is
enforced twice on purpose: `valueLimit` fences the value in the graph, and the encoder
clamps again at expansion — a loud passage cannot spike frame time unboundedly through
any path. This is also the honest reading of "audio-reactive": the CHEMISTRY runs
faster, rather than a brightness knob pretending.

**Mids → chemistry, range-mapped with safe bounds.** The tutorial's own warning is the
teaching. `wlevel1` nudges the chemistry map's white point, hard-fenced to 0.528–0.566 —
because outside the band where fronts keep dividing, the pattern doesn't distort, it
DIES, and dead Gray-Scott is a fixed point: silence does not bring it back. The clamp is
what makes this an instrument you can play loudly and recover, not a tuning nicety. The
fence moved with T562's window: 0.62–0.80 around a white point of 0.543 would not have
been a safety bound, it would have been the whole picture.

## Five fast paths, and why they had to exist (T560)

The owner's read of the shipped file was "I don't even see the audio reactivity — maybe
some stuttering, but nothing compelling". They were right, and it was arithmetic.

**Everything the sound touched ran through a slow integrator.** Feed/kill and the substep
count are both the reaction, and a reaction INTEGRATES a beat into a gradual regime change
over dozens of frames. Measured across the beat at frame 194 of the shipped file: p90
luminance moved 0.0599 → 0.0615 and p99 moved 0.4000 → 0.4036. **Under one percent.**

**And the one path that was meant to be fast was dead.** `trig1` emits a one-frame pulse;
it fed a `valueLag` of 0.35 s; and a one-pole smoother answers a single-frame impulse with
`1 − exp(−Δt/τ)`, which is 0.047 at 60 fps. The palette's driven scale therefore travelled
2.4000 → 2.4535 on a hit — a 2% swing, described in the comments as "the kick PUNCHES the
lookup's gain". It is §V481(b) seen from the other side: an impulse into a smoother is an
impulse *divided by the frame rate*, which is also why the seeding below reads the trigger
raw and lags nothing.

The fix is §V471.3 transplanted from E31 — one band to one property, each with its own gain
and bias, off a SECOND and much faster Lag (`snap1`, 0.04 s):

| band | property | rest → peak | what you see |
| --- | --- | --- | --- |
| `low` | `warpa1.weight` | 0.042 → 0.139 | the whole picture swells on the kick |
| `lowMid` | `warpb1.weight` | 0.018 → 0.050 | the fronts sway with the snare |
| `high` | `warpc1.weight` | 0.007 → 0.017 | the ridges shiver with the hats |
| `highMid` | `tint1.scale` | 2.25 → 2.64 | the ramp breathes (§V471.7) |
| `level` | `glow1.brightness` | 1.08 → 1.44 | the whole frame lifts, one frame |

§V477 governs every one of those pairs: **the bias is the rest state and the gain is the
swing**, so all five rest LOW and a hit has somewhere to travel to. `tint1.scale` also
carries the third fence (T544): ×4.2 over a 0..1 band spans 1.83…6.03 against a Lookup
Scale declared −4…4, so `grade1` holds it in 1.2…3.2 where you can still read it in the
graph.

**Where §V477 and the liveness gate pull against each other, and how far each got.** The
rest states here are HIGHER than the rule wants. T521's contrast floor asks that the
0.1st-to-99.9th percentile span of frame 180 clear 0.30 at 192×108, and a picture whose
fronts rest in the violet does not: at a `tint1.scale` rest of 2.02 it measured 0.2325 and
failed. The fronts therefore rest in the amber, and what travels on a hit is the last
stretch to gold and cream plus a global lift. The swing is real — p90 luminance roughly
doubles across a beat, against 1.03× before — but it is a smaller swing than a colder rest
would have bought, and that is the trade rather than a tuning nobody looked at. The ground
is unaffected either way: V is near zero over most of the frame, so it sits in the navy
whatever the music does.

**Kick → the beat SEEDS the plate.** This is the one that makes a hit legible rather than
merely measurable. A beat that nudges a rate is a rate change; a beat that spawns structure
is an event, and Gray-Scott is unusually good at it — drop V into the plate and the reaction
grows it for the next second on its own. `trig1` thresholds `onsetCount` (counted rising
EVENTS, T437, not a beat claim) and drives `gate1`'s CUT, not a brightness: at rest the cut
sits at 2.0, which nothing in a 0..1 field can reach, so the gate is exactly shut; on the
frame a hit lands it drops to 0.72 and about one percent of `spark1` passes through — a
scatter of small dots, not a wash. The amount matters less than it looks: with fourteen to
twenty-two substeps per displayed frame the reaction amplifies whatever it is handed
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
time, dimmed to 0.11, and added to the simulation's V before the palette lookup. It is
there because V in Gray-Scott is **near-binary** — empty plate or front, nothing between —
and a near-binary coordinate visits exactly two positions on a ramp however many stops that
ramp has. That is why the shipped file was cream fronts on navy with the blue and teal in
the middle of its own palette never on screen. The added continuous term moves each region's
ground to its own place on the ramp and carries its fronts with it: **the hue now says
which chemistry you are looking at, and V says how far along the reaction is.**

**Wind, inside the loop.** `wind1` rotates the state a hair per ITERATION (state → wind
→ rd), and because substeps multiply iterations, the bass literally stirs the dish
faster. The loop stays a NAME (`source: "pack1"`, T350) while its body grew a node.

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

Swap in a live source and mute it, and the channels read all-zero (§V329): substeps
rest at 14, the white point sits at 0.534, the three lens weights fall to their biases
(0.018 / 0.002 / 0.000), the grade sits at 1.83, `glow1` at 0.93, the gate never opens — and the noises, the palette LFO and the 30-second hue drift keep the
picture breathing. Every audio mapping is an ADDITION on top of a self-animating base. An `audioFileIn` with no file chosen SAYS so — the inspector's
Audio section reads "Waiting for a file" rather than an idle that looks finished.

## Regression signatures

- Pattern dies on a loud passage and never returns → a safe bound came off (`wlevel1`'s
  valueLimit, or someone widened the band past where the chemistry survives).
- Beat changes brightness but not GROWTH RATE → substeps stopped being driven (the
  T425 value path broke) and something is faking it downstream.
- Colour fringes even when the image is still → the delay went spatial; the caches or
  the channel braid were replaced with per-channel scaling.
- Kicks fire on sustained loud passages → `onsetCount` regressed toward an energy level
  (it must count rising EVENTS; T437's threshold semantics).
- A beat is measurable but not VISIBLE → a fast path went back through `env1`, or a pulse
  acquired a Lag. Check the numbers: across the beat at frame 193 the output's p90 should
  move by about a third on the landing frame and reach three times calm within five, then be
  back inside fifteen. Under 5% means everything is on the integrator again.
- The picture is one texture everywhere → the chemistry map lost its spread. Render
  `shape1` on its own and look at the histogram, not at the image: it should reach both
  ends of 0..1, not sit inside a tenth of it.
- Every hit renders as a saturated primary blob → the RGB delay's tap spread went back past
  the length of a transient.
- Frame time spikes unboundedly with loud audio → a clamp fell off one of the two
  fences (graph `valueLimit`, encoder clamp at expansion).
