# E5 — Kaleidoscope

Four sampling nodes, no filters, no compositing — running at 2048×2048 on a 1280×720
project. The example is about **edges** and about **resolution**.

## Graph

```
source(circle) ─► fold(transform) ─► facets(tile) ─► spin(transform) ─► output
   2048×2048         extend: mirror     mirror x+y      extend: repeat
```

| Node | Type | Doing |
| --- | --- | --- |
| `source` | `circle` | signed-distance disc, warm on deep blue. **Resolution override: fixed 2048×2048** |
| `fold` | `transform` | rotate 30°, scale 0.5, `extend: mirror` |
| `facets` | `tile` | repeat 3×3 with `mirrorx` and `mirrory` |
| `spin` | `transform` | rotate −15°, `extend: repeat` |

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
  symmetry into something that reads as a kaleidoscope rather than as wallpaper.
- **`spin.xord` is `rst`, not `srt`.** Transform order changes the result whenever more than
  one of translate/rotate/scale is non-default. TD's menu is reproduced exactly, abbreviation
  and all.
- **`source.mode` is `distance`, not `fill`.** A signed-distance field gives the folds
  something continuous to work with; a hard fill would give the tiler a binary mask and the
  seams would be the only thing visible.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (2048×2048 across the chain
against a 1280×720 project, and the three distinct edge behaviours).
