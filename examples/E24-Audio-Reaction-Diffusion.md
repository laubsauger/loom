# E24 — Audio Reaction-Diffusion

E2's chemistry, played like an instrument — and it PLAYS THE MOMENT IT OPENS. The
music source is a deterministic beat pattern (`audioPattern`, 112 bpm): the bass makes
the pattern grow FASTER — not brighter, faster — the mids steer which chemistry the
dish runs, each kick pulses the palette warm, and motion fringes into a genuinely
temporal RGB delay.

**To play it with your own track: drop a file on `track1` and set `source1.index` to 1.**
Both sources are already wired. Nothing else in the graph changes, because everything
downstream reads `source1`.

Why a synthetic source ships (§V363): assets are session-only, so no example can carry
a bound track, and an audio-reactive graph whose null state looks finished demos
nothing. The pattern is also the audio path's deterministic test signal — the replay
gate renders this file twice and demands byte-identical frames, with no recording
involved.

## Graph

```
music1(audioPattern 112bpm) ─┐
                             ├─► source1(valueSwitch, index 0) ─┬─► env1(lag) ─► sgain1·sbase1·steps1 ┄► state1.substeps
track1(audioFileIn — DROP    ─┘   0 = pattern, 1 = your file    │                └► wgain1·wbase1·wlevel1 ┄► shape1.whitelevel
        YOUR TRACK HERE)                                        └─► trig1(trigger: onsetCount) ─► kick1 ─► kgain1·kscale1 ┄► tint1.scale

broad1 ─► warp1 ◄─ detail1        state1(feedback, source: pack1)
              │                        │
              ▼                        ▼
          shape1 ─────────────► pack1 ◄─ rd1 ◄─ wind1 ◄─ (the loop)
                                              rd1 ─► tint1 ◄─ palette1
tint1 ─► tapr1 ─► fringerg1 ─► fringe1 ─► out1
     └─► tapg1 ──────┘             │
     └─► tapb1 ────────────────────┘
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

## The mappings, and why each is shaped the way it is

**Bass → substeps: the beat makes the simulation FASTER.** `steps1` drives
`state1.substeps` — a per-frame VALUE since T425, so no recompile, no history wipe, just
more Gray-Scott iterations encoded on loud frames (base 14, up to 34). The cap is
enforced twice on purpose: `valueLimit` fences the value in the graph, and the encoder
clamps again at expansion — a loud passage cannot spike frame time unboundedly through
any path. This is also the honest reading of "audio-reactive": the CHEMISTRY runs
faster, rather than a brightness knob pretending.

**Mids → chemistry, range-mapped with safe bounds.** The tutorial's own warning is the
teaching. `wlevel1` nudges the chemistry map's white point 0.64–0.80, hard-fenced —
because outside the band where fronts keep dividing, the pattern doesn't distort, it
DIES, and dead Gray-Scott is a fixed point: silence does not bring it back. The clamp is
what makes this an instrument you can play loudly and recover, not a tuning nicety.

**Kick → colour.** `trig1` thresholds `onsetCount` — counted rising energy EVENTS
(T437), not a beat claim — and `kick1` turns each pulse into a decaying envelope that
punches the lookup's gain: every front in the image shifts down-ramp together on the
hit, easing home as the lag decays. The palette also breathes on its
own LFO, which is what keeps the colour alive with no audio at all.

**Wind, inside the loop.** `wind1` rotates the state a hair per ITERATION (state → wind
→ rd), and because substeps multiply iterations, the bass literally stirs the dish
faster. The loop stays a NAME (`source: "pack1"`, T350) while its body grew a node.

**The RGB delay is TIME, not space.** Three cache rings tap the coloured output at 2, 5
and 9 frames back; two Reorders wear one channel from each. Moving fronts fringe into
rainbow; still regions stay clean — which is the tell that this is temporal. The naive
translation (scaling channels apart spatially) is chromatic aberration: it would fringe
STILL pixels too, and that is the wrong effect wearing the right name.

## Silence, stated

Swap in a live source and mute it, and the channels read all-zero (§V329): substeps
rest at 14, the white point sits mid-band, the kick never fires, and the noises + LFO
keep the picture breathing. Every audio mapping is an ADDITION on top of a
self-animating base. An `audioFileIn` with no file chosen SAYS so — the inspector's
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
- Frame time spikes unboundedly with loud audio → a clamp fell off one of the two
  fences (graph `valueLimit`, encoder clamp at expansion).
