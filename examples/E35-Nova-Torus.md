# E35 — Nova-Torus

The owner's second file, shipped beside their first. E31-Corona is the bar this project
measures "beautiful and showcasing" against, and this is its sibling — the owner's own
phrase was "similar to Nova but different enough", and the sibling they mean is Corona.
Forty-one of these forty-three nodes are theirs: the same eight gain-and-bias pairs off
one lagged audio source, three renderPoints readings of one cloud, the blur-level-add
bloom, a ramp into a lookup, feedback trails, hue drift. All of that E31's own document
already teaches, so this file's notes cover only what differs — which is the reason it
has a slot at all.

## What differs, and why it matters

- **The audio drives the tube's *thickness*.** `pointgenerator1` is a torus with its
  major radius standing still at 1 and its minor radius — `radius2` — driven by
  `valuemath2:lowMid`, spanning 0.18..0.52. Corona's audio scales a sphere's whole
  radius; here the ring keeps its size and the *cable fattens*, a different mechanism
  rather than a different palette. This is gated from pixels: muting the pattern thins
  the ring to well under half its lit area (measured 16.7% → 6.3% of the frame).
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
  its size sitting static — unfinished intent with a working precedent. It now drives
  `renderpoints3.sizePixels` (1..10 px on the high band). A parameter that drives
  nothing is a lie in a document: wire it or remove it, never ship it dead.
- **The audio opens deterministic.** The saved file pointed at a `blob:` URL that is
  dead outside the browser session it was saved in. It ships with E24/E31's swap:
  `music1` (audioPattern, 112 bpm) and the owner's `audiofilein1` — File parameter
  empty, its transport kept — both wired permanently into `source1`, index 0 playing
  the pattern. Drop a track on `audiofilein1` and flip the index; nothing downstream
  changes, because everything downstream reads `source1`.

The one loud number left as saved: the high band's brightness chain reaches ×20. That
is legal — brightness is floor-ranged, so its max is slider travel, not a limit — and
on screen it is the gold flash bursting through the magenta body on a high transient,
which reads as the intended accent, not as a blowout. Judged on the display-encoded
tile (§V618), where all of this file's look calls were made.

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
  (`p.velocity.x > 0.66 && p.velocity.y < 0.04`) with its size riding the high band,
  amber seams (`p.velocity.y > 0.06`).
- **The gold flash** on high transients — the ×20 chain doing its job through the
  screen blend.
- **The two-second hue shimmer** over everything — fast on purpose; Corona holds the
  slow-cycle end of that axis.
- **The tumble and the band sweeping against it** — the turntable: watch the cyan band
  lap the ring while the whole braid slowly changes attitude.
- Drop your own track on `audiofilein1`, set `source1.index` to 1.
