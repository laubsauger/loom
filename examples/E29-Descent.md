# E29 — Descent

A neon square opens in the middle of a black frame, rushes outward past you, turning as it
goes and sliding a quarter of the way round the hue wheel — and behind it the next one, and
the next, receding to a point that never arrives. Cyan at the mouth, periwinkle a step back,
magenta beyond that, white at the vanishing point. On every kick the fall lurches: the whole
shaft surges toward you and settles over the beat.

**It is a corridor made of one shape, one loop, and no clock at all.**

## Graph

```
beat1(audioPattern 124bpm) ─┬─► punch1(lag 0.28) ─► zgain1 ─► zbase1 ─► zoom1(limit) ┄┐
                            └─► hit1(trigger)    ─► strike1 ─► lamp1(limit) ┄┐        │
                                                                             │  s.x/s.y│
bore1(rectangle 0.124) ─┐                                                    │        │
                        ├─► ring1(difference) ─► paint1(lookup) ─► lampl1(level, brightness ┄)
core1(rectangle 0.113) ─┘                            ▲                       │
                                          hue1(ramp) ┘                       │
                                                                             ▼
   loop1(feedback ← born1) ─► fall1(transform s>1, r 0.55°) ─► fade1(level γ1.12) ─► shift1(hsv +3.1°)
                                                                                        │
                                                            lampl1 ──► born1(add) ◄──────┘
                                                                        │
                            born1 ─► halo1(blur) ─► haze1(level ×0.5) ─┬─► burn1(add) ─► trim1 ─► out1
                            born1 ────────────────────────────────────┘
```

| Node | Type | Doing |
| --- | --- | --- |
| `loop1` | `feedback` | the temporal boundary (§V4). Persistence 0.985 — the corridor's whole length, in one number |
| `fall1` | `transform` | **scale above one** about the centre. This is the tunnel; everything else is decoration |
| `shift1` | `hsv` | +3.1° per pass, so depth reads as colour |
| `hit1` | `valueTrigger` | one frame per kick. The reason the loop is stable — see below |
| `ring1` | `difference` | `\|a − b\|` over two rounded squares: an exact frame, whose width is the difference of two sizes |

## Why this is not E1 with more knobs

E1 Feedback Echo is a **smear**: a trail that transforms slightly and fades. Two differences
make this a corridor instead, and neither is a matter of degree.

**The scale inside the loop is greater than one.** E1's loop shrinks and drifts; this one
magnifies by 1.9% per pass about the frame's centre, so each copy is bigger and further out
than the one that made it. That is what a corridor *is*.

**The hue rotates inside the loop.** Each visible square has been round one more time than
the one inside it, so ~90° separates neighbours and you can count the shaft by colour even
where the edges have blurred together.

## The clock, and why this one cannot snap at a lap

**There is no clock read in the picture path at all** — not `time`, not `absTime`. The motion
*is* the loop's iteration, one pass per frame, and feedback state carries across a timeline
lap like any other frame boundary (T489). An example whose animation comes from state rather
than from a clock position is loop-proof by construction, which for something meant to run
for an hour behind a set is worth more than it sounds.

The one clock reader is `beat1`, and it is **timeline-anchored on purpose** (§V436): it
stands in for a track, so bar one lands on the in point and a scrub finds the same beat.

## Three things that had to be arithmetic, not taste

Every one of these was found by the frame going solid white, and each has a different cause.

**1. An expanding loop does not dim itself.** The first build assumed it did — the same
light over more pixels. It does not: `s > 1` *divides* the sampling coordinates, so the pass
magnifies the centre and **duplicates** its pixels. Nothing leaves the frame and nothing is
diluted. Every bit of the decay is `loop1.persistence`, deliberately.

**2. A ring lit by an envelope is a DC term, and the loop integrates it.** With gain 0.985
the loop sums roughly 67 frames, so a constant input of `x` settles at `x / 0.015` — sixty
times itself. A fast Lag is still a DC term. `hit1` is a **Trigger**: 1 for the one frame the
kick crosses its threshold, 0 for the other twenty-eight, so the mean input is a
twenty-ninth of the peak and the steady state lands under one *by arithmetic*. It is also
the better picture — squares are **born on the beat**, which is why the corridor has
segments instead of being a cone.

**3. Contrast inside a loop is positive feedback.** Contrast above one expands about a
mid-grey pivot, so for anything brighter than the pivot it is a gain. At 1.05 with
persistence 0.989 the frame went white in seven seconds. `fade1` uses **gamma 1.12**
instead: `pow(v, 1.12)` is below `v` everywhere in [0,1), so it re-sharpens the edges the
bilinear resampling keeps softening *and* contracts at the same time.

## Two more that are about the picture, not the numbers

**The seed is a square because the loop rotates.** A rotation of a rotationally symmetric
shape is invisible — the first coloured build seeded circles and thirty degrees per ring did
nothing at all. A square turns visibly, so the shaft reads as twisting rather than as a
dartboard.

**The palette ends on a saturated teal, not on white.** Rotating the hue of a neutral is a
no-op. Ending on `(1, 0.98, 0.92)` made every square white and `shift1` had nothing to turn.

## Where the sound goes

`beat1` is the deterministic Audio Pattern, so the file **opens playing with no asset bound**
(§V363, B74) and an offline render reproduces (§V45). The kick reaches two places at two
time constants: the **zoom** through a 0.28 s Lag, so the surge is felt as a swell, and the
**square's brightness** through the Trigger, so a square is struck rather than faded up.
Both are fenced by a `valueLimit` (§V's two-fence pattern, E24's precedent) — above ~1.05
per frame the corridor outruns the eye, at or below 1.0 the loop stops expanding and piles
up.

Swap `beat1` for an `audioFileIn`, keep the label, and every mapping downstream follows.

## Regression signatures

- **A solid white frame** → the loop gain went above one. Check `fade1` for a contrast, and
  check that `lampl1`'s brightness is driven by the Trigger and not by an envelope.
- **A dartboard instead of a tunnel** → `fall1.r` went to zero, or the seed became a circle.
- **One colour everywhere** → `hue1`'s last stop desaturated, or `shift1.hueoffset` went
  small.
- **The corridor is two squares deep** → `loop1.persistence` dropped; that number *is* the
  tunnel's length.
- **The tunnel stops receding and piles up in the middle** → `fall1.s` fell to 1.0 or below.

## Look pass

Rendered on Dawn at 1280×720 and inspected at frames 240, 420, 600, 900 and 1200 (§V383),
plus at 220px thumbnail width.

**Correctness.** Squares appear on the beat, expand, twist and leave through the corners.
Nothing in the picture path reads a clock, so a lap is invisible.

**Beauty (§V420).** **Ships.** It reads instantly at thumbnail size — the one place in the
product where people actually meet an example — and it is the frame in this batch I would
most expect to be screenshotted. Thirteen builds got there, and every discarded one is
recorded above rather than tuned away: the value of this file is as much the three
loop-stability findings as the picture.
