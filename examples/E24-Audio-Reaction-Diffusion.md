# E24 — Audio Reaction-Diffusion

E2's chemistry, played like an instrument. Bind a track (or grant the microphone) and
the bass makes the pattern grow FASTER — not brighter, faster — the mids steer which
chemistry the dish runs, each kick bumps the palette warm, and motion fringes into a
genuinely temporal RGB delay. Unplug everything and it still animates: silence is a
picture here, not a failure.

## Graph

```
music1(audioFileIn) ─► env1(lag) ─► sgain1·sbase1·steps1 ┄┄drives┄┄► state1.substeps
                              └───► wgain1·wbase1·wlevel1 ┄┄drives┄┄► shape1.whitelevel
music1 ─► trig1(trigger: onsetCount) ─► kick1(lag) ─► kgain1·kscale1 ┄┄drives┄┄► tint1.scale

broad1 ─► warp1 ◄─ detail1        state1(feedback, source: pack1)
              │                        │
              ▼                        ▼
          shape1 ─────────────► pack1 ◄─ rd1 ◄─ wind1 ◄─ (the loop)
                                              rd1 ─► tint1 ◄─ palette1
tint1 ─► tapr1 ─► fringerg1 ─► fringe1 ─► out1
     └─► tapg1 ──────┘             │
     └─► tapb1 ────────────────────┘
```

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

Unbound audio reads all-zero channels (§V329): substeps rest at 14, the white point
sits mid-band, the kick never fires, and the noises + LFO keep the picture breathing.
Every audio mapping is an ADDITION on top of a self-animating base — which is what
makes the example demonstrable anywhere and an instrument when fed.

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
