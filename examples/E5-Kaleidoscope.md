# E5 — Kaleidoscope

A colour wheel turning slowly inside a pair of counter-rotating mirrors. Four sampling
nodes plus two LFOs, no filters and no compositing.

It runs at 2048×2048 on a 1280×720 project, so the example is about **edges**, about
**resolution**, and about the fact that a kaleidoscope is nothing until something drifts
through it.

## Graph

```
source(ramp, circular) ─► fold(transform) ─► facets(tile) ─► spin(transform) ─► output
   2048×2048                extend: mirror     mirror x+y      extend: repeat
   phase ← abstime          r ← abstime        offset ← lfo×2  r ← abstime
```

| Node | Type | Doing |
| --- | --- | --- |
| `source` | `ramp` | `circular`, `period 0.5`, six cyclic stops, `phase` scrolling. **Resolution override: fixed 2048×2048** |
| `fold` | `transform` | translate 0.12, scale 0.5, rotate at 5°/s, `extend: mirror` |
| `facets` | `tile` | repeat 2×2 with `mirrorx` and `mirrory`, `offset` drifting on two LFOs |
| `spin` | `transform` | counter-rotate at 2.5°/s, `extend: repeat` |

## What it proves

- **§V50 — a per-node resolution override, inherited by everything below it.** The project
  is 1280×720. `source` is pinned to 2048×2048 and every node after it inherits, so the
  chain runs above the project resolution end to end. This is instance state applied at
  compile time, never per frame.
- **Extend modes.** Three different edge behaviours in one chain — `mirror` on the fold, the
  Tile node's own mirroring, `repeat` on the spin. An extend mode is invisible in the middle
  of the frame and decides everything at the border, and a kaleidoscope is nothing *but*
  borders. Set `fold.extend` to `hold` and the mirrored seams turn into streaks of the edge
  pixel; set it to `zero` and they turn into transparent wedges.
- **A cheap chain is worth running high.** Four sampling passes at 2048² cost about 100 MB
  of texture memory and no arithmetic worth mentioning. Supersampling the mirrored seams is
  what stops them aliasing, and it is nearly free here in a way it would not be after a
  blur.

## What to look at

- **Where the override stops — it currently does not.** The Output node declares no
  `resolutionPolicy`, so its target falls back to its input's size: the presented target is
  2048×2048 too, not the project's 1280×720. That is the compiler's present default rather
  than something this file asks for, so the gate pins the *chain's* resolution and
  deliberately says nothing about the sink's.
- **`facets.offset`.** Shifting the tile grid off the origin is what breaks the four-fold
  symmetry into something that reads as a kaleidoscope rather than as wallpaper. It is
  driven by two LFOs at 0.023 and 0.031 Hz — rates that do not close, so the grid never
  returns to an arrangement it has already shown.
- **`fold.t` is what makes `fold.r` mean anything.** A circular ramp centred on the frame
  is rotationally symmetric, so spinning it about its own centre is a perfect no-op — the
  plan would be identical, every structural assertion would pass, and not one pixel would
  differ (§V361). Translated off-centre, it turns.
- **The tile count is even, and that is a fix rather than a preference.** A mirrored tiling
  alternates flipped and unflipped cells, so it is periodic across the frame boundary only
  at even counts. At the old 3×3 the `repeat` extend on `spin` wrapped an unmirrored edge
  onto a mirrored one and drew a hard diagonal seam sweeping across the frame — present in
  every rotated capture, absent from every unrotated one, which is precisely the failure
  an example about edge modes must not ship.
- **`spin.xord` is `rst`, not `srt`.** Transform order changes the result whenever more than
  one of translate/rotate/scale is non-default. TD's menu is reproduced exactly, abbreviation
  and all.
- **`source` is a `circular` ramp, and the choice is structural.** Its coordinate is the
  *angle* about the centre, so it is periodic: at `period 0.5` the palette wraps twice
  around the circle and the pattern arrives with rotational symmetry already in it, before
  the fold and the tile add theirs. The stops are **cyclic** — the last colour equals the
  first — because `phase` scrolls a ramp by `fract((coord + phase) / period)`, and a
  palette whose ends disagree jumps every time the scroll wraps.

## What was wrong before (T518)

Two faults, and the owner reported the first: *"caleidoscope is unanimated and really
should use translate rotation or something"*. Every transform parameter was a literal, so
nothing in the file moved at all — mean |Δ| of exactly 0.00 between rendered frames. The
instinct behind the request is right: a kaleidoscope's whole appeal is the slow drift of a
source through fixed mirror lines, and both rotations, the tile offset and the palette
phase now move. They all read the **absolute** clock, so nothing snaps at the loop.

The second fault had gone unreported and was worse. The source was a `circle` in
`distance` mode, and `distance` publishes the signed distance in **red** and leaves green
and blue at zero — so `fillcolor` and `bgcolor` were never reaching the picture. What
shipped was a single-hue red field whose brightest pixel measured **43 out of 255**, and
the paragraph on this page describing "warm on deep blue" was describing something the file
had never rendered.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (2048×2048 across the chain
against a 1280×720 project, and the three distinct edge behaviours).
