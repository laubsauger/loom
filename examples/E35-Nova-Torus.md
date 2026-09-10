# E35 — Nova-Torus

A starred, ribboned tube of points turning in the dark — a magenta body with gold flashes
and cyan tips. The audio fattens the cable rather than scaling the ring.

The owner's second file, shipped beside their first. E31-Corona is the bar this project
measures "beautiful and showcasing" against, and this is its sibling — the owner's own
phrase was "similar to Nova but different enough", and the sibling they mean is Corona.
Most of these nodes are theirs: three renderPoints readings of one cloud, the
blur-level-add bloom, a ramp into a lookup, feedback trails, hue drift. All of that E31's
own document already teaches, so this file's notes cover only what differs — which is the
reason it has a slot at all. The eight gain-and-bias pairs the owner saved are the one
part that is no longer theirs: T1271 replaced them with one AudioAnalysis instance and
eight expressions, for reasons the last section sets out with the numbers.

## What differs, and why it matters

- **The audio drives the tube's *thickness*.** `pointgenerator1` is a torus with its
  major radius standing still at 1 and its minor radius — `radius2` — driven by
  `0.18 + 0.3 · lowMid` off the ranked levels, spanning 0.183..0.427 on the shipped
  pattern. Corona's audio scales a sphere's whole radius; here the ring keeps its size
  and the *cable fattens*, a different mechanism rather than a different palette. This is
  gated from pixels, and from the right quantity: the ring BREATHES with the pattern and
  stands still without it — lit area varies 21.5% about its mean with the audio wired and
  3.7% with the path cut, a factor of 5.8 (§V955: it cannot be gated by muting, because a
  muted source is a CONSTANT and a constant ranks 0.5).
- **A starred, ribboned tube.** The kernel builds the profile as
  `1.0 + 0.38 · star + 0.15 · field`, so the cross-section is a gear rather than a
  circle and the braiding reads along the ring.
- **A noise-mottled palette read.** `noise1 → multiply1` sits between the bloom sum and
  the lookup — a stage Corona has no equivalent of. It ships as `perlin4d` because the
  saved 2D type had no time axis and its `speed` was inert; measured honestly, the
  moving mask touches ~0.2% of the frame's pixels per comparison — texture, not signal.
- **A fast hue modulator.** `lfo1` runs at 0.5 Hz against Corona's 0.035 — a two-second
  shimmer instead of a 29-second cycle, deliberately the opposite tempo idea. The saved
  amplitude was 0.5 *degrees* (invisible — the T574 bug again); it ships at ±18°.

## What was corrected before shipping, each with precedent

- **The persistence overshoot is §B115, verbatim.** The saved gain-and-bias pair mapped
  `level` to `feedback1.persistence` as ×0.95 + 0.62 — a span of 0.62..1.57 on a
  bounded 0..1 parameter, the *identical numbers* Corona shipped with and the owner
  found within minutes. Corona's retune applies wholesale: gain 0.30, trails topping
  out at 0.92, where a trail still ends.
- **The dead pair is wired.** `valuemath15 ×9 → valuemath16 +1` drove nothing in the
  saved file. Corona's identical tipG/tip pair drives its third renderPoints' size on
  the cyan tips, and this file's third renderPoints is also the cyan sparkle group with
  its size sitting static — unfinished intent with a working precedent. It drives
  `renderpoints3.sizePixels` now, on the hat COUNT rather than the high band (T1271, and
  the next section says why). A parameter that drives nothing is a lie in a document:
  wire it or remove it, never ship it dead.
- **The audio opens deterministic.** The saved file pointed at a `blob:` URL that is
  dead outside the browser session it was saved in. It ships with E24/E31's swap:
  `music1` (audioPattern, 112 bpm) and the owner's `audiofilein1` — File parameter
  empty, its transport kept — both wired permanently into `source1`, index 0 playing
  the pattern. Drop a track on `audiofilein1` and flip the index; nothing downstream
  changes, because everything downstream reads `source1`.

The one loud number the owner saved was the high band's brightness chain at ×20 — legal,
because brightness is floor-ranged, and on screen it was the gold flash bursting through
the magenta body on a high transient. T1271 kept the flash and changed what fires it (the
hat count, not the high band's level); the measured reason is below. Judged on the
display-encoded tile (§V618), where all of this file's look calls were made.

## One analysis instance, and eight expressions (T1271)

What stood between `source1` and the picture was `valuelag1` (0.09 s) feeding eight
gain·bias pairs — sixteen `valueMath` nodes conditioning one source's RAW band energy.
The rebuild replaces them with one `component:audioAnalysis@1`, two 0..1 bags (`lvl1` on
its ranked levels, `hit1` on its drum counts) and one expression per property. The node
count is the visible change; two measurements are the reason.

**The gains were fitted to this pattern's spread, and two lanes ran backwards.** Over 30 s
of the shipped 112 bpm pattern, the `high` lanes spent **21–22% of the run negative**:
`level2.brightness` was `23.2749 · high − 7.5588`, which reaches **−6.30** in the
arrangement's quiet bar, and a negative brightness SUBTRACTS the cyan layer from the frame
rather than dimming it; `renderpoints3.sizePixels` went to −1.88 on the same bars, which is
the sparkle layer switched off for a fifth of the piece. Neither is a tuning error — it is
what happens when a lane multiplies raw band energy whose floor moves with the material.
The ranked levels are 0..1 by construction (§V952), so `a + b · rank` cannot leave the
range its own two literals name.

**And the retained values were a lie — the file rendered BLACK without its audio.** §V914
asks that a driven parameter's retained value lie inside the range the drive produces. Six
of the eight sat outside it, and three of those were **0** on parameters that draw:
`renderpoints1.sizePixels` retained 0 is a point cloud with no points. Measured by cutting
the audio path (not by muting): the shipped file rendered **0.0000 of the frame lit** —
a black frame — where the rebuilt file renders a still, sane torus at 0.2256 lit. Every
retained value now equals what silence renders, because silence IS the rank's own middle:
`radius2` 0.33, `level1` 1.0, `level3` 1.45, `lookup1.scale` 1.45, `renderpoints1` 1.55 px,
`feedback1.persistence` 0.70, and the two hit lanes at their floor.

**Six properties read the rank; the cyan sparkle reads a count.** A body that breathes
wants a level, and six of these lanes are that. The sparkle is not a body — `renderpoints3`
selects the tips and `level2` grades them, so the two together are one flash — and a rank
RESTS AT 0.5, which would leave that flash half-lit forever. A count rests at 0 and decays
over 250 ms, which is what a flash is. Both arms were rendered and compared before the
choice: on the hat count the cyan population covers 7.3% of the frame on average and peaks
at 15.0%; on the ranked high band, 6.0% and 11.2%, and the peak does not land on the strike
because "louder than the last sixteen frames of high band" is not the same event as a hat.

## The clock that was running at 1/1000th speed

The saved kernel read `ctx.absTime * 0.001` — a milliseconds assumption, but
`absTime` is seconds — so every motion the owner had already authored inside it (a
tilted-axis tumble, a travelling colour band, three morphing cross-section profiles)
ran at a thousandth of its designed rate: real code, frozen picture. The turntable the
owner asked for (T683) was already written; unfreezing the clock is the whole change.
The layers now visibly turn against each other — the cyan band sweeps the ring while
the warm body tumbles — and the gate asserts the RELATIVE phase between the two colour
populations moves, not that any layer's own angle advances: a torus is rotationally
symmetric about its axis, so a per-layer angle can advance invisibly, but a
relationship cannot hide. The clock is `ctx.absTime` by contract (§V436): it keeps
counting across a timeline lap, so the tumble cannot snap at the loop point.

## What to look at

- **The tube breathing with the lowMid** — thickness, not size. Watch the hole: it
  keeps its shape while the cable around it swells.
- **Three readings of one cloud**: magenta body (ungrouped), cyan sparkle
  (`p.velocity.x > 0.66 && p.velocity.y < 0.04`) with its size riding the hat count,
  amber seams (`p.velocity.y > 0.06`).
- **The gold flash** on the hats — `0.15 + 4 · hatCount` through the screen blend, at rest
  between strikes rather than half-lit.
- **The two-second hue shimmer** over everything — fast on purpose; Corona holds the
  slow-cycle end of that axis.
- **The tumble and the band sweeping against it** — the turntable: watch the cyan band
  lap the ring while the whole braid slowly changes attitude.
- Drop your own track on `audiofilein1`, set `source1.index` to 1.
