# E31 — Corona

A luminous organism turning in the dark. Sixty-five thousand additive points on a sphere
that the sound pulls between two entirely different characters: quiet, it is soft lobes
breathing, a slow deep-blue mass; loud, the same points snap into ridged **filaments**, the
silhouette twists like taffy, orange crests light along the creases and a cyan frost picks
out only the sharpest tips. Bloom, a seven-stop grade, trails, and a hue that takes
twenty-nine seconds to go anywhere.

**This is the owner's own working file, adopted as an example and as the definition of the
bar.** If you are about to build an example, read this one first — not for the picture, for
the eight ideas underneath it. None of them is "add more nodes".

## Graph

```
beat1(audioPattern) ─┐
                     ├─► source1(valueSwitch) ─► damp1(lag 0.09) ─► EIGHT multiply→add pairs
track1(audioFileIn) ─┘        0 = beat, 1 = your file             (one band → one property, RANGE-CHECKED)

gen1(pointGenerator: sphere 256×256, radius ┄ swell1:lowMid) ─► shape1(pointKernel)
                                                                   │  ONE cloud
      ┌────────────────────────────────────────────────────────────┤
      ▼                            ▼                               ▼
 drawbase1(renderPoints)     drawmid1(renderPoints)          drawtip1(renderPoints)
   group: (none)               group: velocity.y > 0.04        group: velocity.y > 0.17
   deep blue                   orange, 1.3px                   cyan, size ┄ tip1:high
      │                            │                               │
   base1(null)               heatlvl1(level)                 sparklvl1(level)
      ├─► halo1(blur 34) ─► halolvl1(level) ─┐  │                  │
      └───────────────────────────────────────┴─► burn1(add) ─► coat1(lookup ◄ palette1)
                                                                   │
                    coat1 ─► liftheat1(screen) ◄─ heatlvl1         │
                             liftspark1(screen) ◄─ sparklvl1       │
                             mixtrail1(screen) ◄─ loop1(feedback ← tail1)
                             hue1(hsv, hue ┄ drift1 @ 0.035Hz) ─► tail1(null) ─► out1
```

## 1. One source, three readings — and this is the transferable one

`drawbase1`, `drawmid1` and `drawtip1` are three `renderPoints` over the **same** point
cloud. They differ only in a group predicate, a colour and a size:

| | predicate | colour | reads as |
| --- | --- | --- | --- |
| `drawbase1` | (none — all 65,536) | deep blue | the body |
| `drawmid1` | `p.velocity.y > 0.04` | orange | the lit crests |
| `drawtip1` | `p.velocity.y > 0.17` | cyan | the sharpest tips only |

**Structure comes from SELECTION, not from adding elements.** Three draws over one
simulation give a picture with three depths in it and cost one node each. Three separate
systems would cost three of everything and still not be registered with each other — the
crests would not be *this* creature's crests.

This is the answer to "more interesting without overloading", and it generalises to
anything with points in it.

## 2. The kernel writes data for the selection to slice

```wgsl
q.velocity = vec3f(field, creases, drive);
```

Velocity is not velocity here — it is an **attribute carrier**, and `creases` is the
ridged-noise field. So `p.velocity.y > 0.17` means *"only where the surface is sharply
creased"*: a selection on shape, not on position.

The kernel and the compositing were designed **together**. The predicates are not a filter
bolted on afterwards; they read a channel the kernel wrote for them. If you take one
technique from this file, take this pairing rather than either half.

## 3. Gain and bias per band, not one reactivity knob

Eight `valueMath` multiply→add pairs. Each maps **one** band to **one** property with its
own scale and offset:

| pair | band | × | + | drives |
| --- | --- | --- | --- | --- |
| `swell1` | lowMid | 1.25 | 0.68 | `gen1.radius` — the creature's character |
| `glow1` | low | 1.8 | 0.45 | bloom gain |
| `dot1` | level | 2.2 | 1.2 | body point size |
| `heat1` | low | 2.2 | 0.25 | orange band gain |
| `spark1` | high | 6 | 0.15, then LIMIT 0.05…5 | cyan band gain |
| `grade1` | highMid | 2.6 | 0.55 | palette scale |
| `trail1` | level | 0.30 | 0.62 | trail persistence |
| `tip1` | high | 9 | 1 | tip point size |

`high × 6 + 0.15` and `level × 0.30 + 0.62` are not the same curve and must not be. **A
single master gain makes everything move together, which reads as one thing pumping.** One
`valueLag` at 0.09 s sits between the audio and all eight, so nothing jitters and every
driven property agrees about what "now" is.

### …and the pair has to be RANGE-CHECKED against its target

The idiom is right and it is incomplete, and the owner hit the gap within minutes of
opening this:

> `Parameter "persistence" is 1.1111499999999999, above its maximum 1.`

`level × 0.95 + 0.62` spans **0.62 … 1.57** against a Persistence declared **0 … 1**, so it
raised a `parameter.range` problem on any moderately loud passage — and T368's clamp was the
only thing standing between the piece and **persistence 1.0, which is perfect accumulation:
an image that never decays.** Retuning the gain to 0.30 (0.62 … 0.92) is a better *look*,
not a compromise for the sake of a warning: it keeps "louder means longer trails" and tops
out where a trail still ends.

A second pair was over too. `high × 20 + 0.1` spans 0.1 … 20.1 against a Brightness of
0 … 8 — and here the gain is *correct*, because `high` is a small channel and the cyan tips
are the faintest thing in the frame, so a quiet passage still has to light them. The fix is
a `valueLimit` at 0.1 … 6: **two fences, E24's shape** — the Limit holds the value in the
graph where you can see it, and the compiler's clamp goes back to being a backstop rather
than the mechanism.

Composing a gain/bias pair over the source channel's 0…1 and comparing it against the
target's declared range needs no device and no render. Six of the eight were fine; the two
that were not are the two with the largest gains, which is where to look first.

### …and it has to REST LOW AND TRAVEL (§V477)

The owner's second note was that it should "contract a bit more to the center so that the
expansion is a bit more pronounced" and that the colours are "always in blast mode". Those
are one cause, and it is the same arithmetic seen from the other end:

**The bias is the rest state. The gain is the swing.** Every pair in the original biased
*into* the interesting part of its range, so there was nowhere to go but up:

- `gen1.radius` rested at **1.0** — already the full sphere. There was no contracted state
  to expand *from*, so the audio could only add. Now 0.68 → 1.93: tighter core, bigger
  travel, and the expansion reads as an expansion instead of as jitter on a still image.
- `coat1.scale` rested at **1.4**, which drives the lookup coordinate far up a seven-stop
  ramp that *ends in white*. The palette sat permanently at its hot end, a peak had nowhere
  to climb to, and the seven stops might as well have been two. Resting near 0.85 puts the
  calm state in the navy and blue and lets a loud passage reach the gold — which is idea 6
  finally doing something.
- `sparklvl1.brightness` rested around **4** of a ceiling of 6, so the Limit was *pinning*
  on every loud frame and the cyan band was permanently blasting. ×6 rests near 0.5, and
  the Limit goes back to being a fence for a real track rather than the thing setting the
  level.

A rest value at the top of its range is a still image with jitter, and the audio stops
meaning anything. Check the rest state on the **Beat** source, not just on a loud track —
the Beat is what most people see first.

## 4. Layered post, each stage doing one job

Bloom (`blur 34` → `level` → `add`), grade (`lookup` ← a seven-stop `ramp`), two highlight
screens, feedback trails, hue drift. Five stages, each legible on its own, none of them
doing two things. A stage that does two things is a stage you cannot tune.

## 5. The feedback closes on the final output

`loop1.source` is `tail1` — the very last node — not the raw render. So what smears is the
**graded, hue-drifted** picture. A trail taken from an earlier stage looks like a ghost of
something else that happens to be in the frame.

## 6. A ramp that goes somewhere

Seven stops: black → near-black navy → blue → purple → red → gold → white. Most shipped
examples before this used four or five and travelled less far. The grade is why three
colours read as a hundred.

## 7. The grade itself breathes

`coat1.scale` is driven by `highMid`, so the whole image slides along the ramp with the
music. The palette is a performance, not a decision made once.

## 8. The slowest thing is slower than your attention span

`drift1` runs at **0.035 Hz — a 29-second cycle** — on hue. That single number is most of
why an hour of this is watchable: at any moment something is changing that you did not
notice start. Free-running (§V436, B98), so a timeline lap does not restart it.

## What shipping it changed, and it is one thing

The owner's file bound their own track. Assets are session-only (§V363), so the shipped
version puts the deterministic Beat pattern and an empty `audioFileIn` **both** into a
`valueSwitch`: index 0 plays on open with no asset, index 1 is your file. Same treatment as
E24, and for the same reason — two value sources on one port would merge and one of them
would silently vanish (§V457).

Everything else is as the owner wrote it, including the two `null` nodes. Those are
worth a line: `null` is spliced out by the compiler (no pass, no resource, zero render-time
cost) and it is here purely as a **stable name** — `base1` is the fan-out point for the
bloom, `tail1` is what the feedback names. That is what a Null is for, and this is the
first shipped example that uses one.

## Clock

The kernel reads `ctx.absTime` and the LFO is free-running, so the rotation, the taffy
twist and the hue drift all survive a timeline lap (§V436, T489). The one timeline-anchored
thing is `beat1`, deliberately: it stands in for a track, so bar one lands on the in point.

## Regression signatures

- **The creature is one flat blue mass** → the group predicates lost their channel, or the
  kernel stopped writing `creases` into `velocity.y`. Both halves of §V471.2 have to hold.
- **Everything pumps together on the beat** → the eight pairs collapsed toward one gain.
- **The trails look like a separate ghost image** → `loop1.source` moved off `tail1`.
- **It gets boring after a minute** → `drift1.frequency` went up. 0.035 Hz is the number.
- **It is bright and busy from the first frame and the beat does nothing** → a bias crept
  back up. Rest low and travel (§V477); check `swell1` and `grade1` first.
- **The image stops decaying and blows out to white** → `trailg1`'s gain went back up and
  persistence is pinning at 1.0.
- **A `parameter.range` problem in the problems pane** → a gain/bias pair overshot its
  target. Compose the pair over 0…1 and compare; do not silence it at the clamp.
- **A black frame on open** → `source1.index` moved to 1 with no file bound. That is honest
  silence in E24 because the picture animates anyway; here the audio drives the *shape*, so
  index 1 unbound is a much quieter creature rather than a dead one — but check it first.

## Look pass

Rendered on Dawn at 1280×720 and inspected at frames 300 and 900 (§V383), through the
corrected harness (V470 — the earlier one double-encoded and read a stop and a half pale).

**Beauty (§V420).** **Ships**, and it is the best frame in the set. Filaments and frost
against black, real depth from three readings of one cloud, and nothing in it looks
procedural in the way a noise field does. That is §V427 paying out: the structure comes from
a designed field and a selection over it, not from noise being asked to look interesting.
