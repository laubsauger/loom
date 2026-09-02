# E43 — Splice

A picture on the beat. Horizontal bands jump sideways and hold, blocks tear vertically,
the colour planes split along every tear — and between hits nothing wobbles.

Then the deal clock ticks and the bands jump somewhere else. The red and blue planes split
along every tear, the whole frame is folded about a slowly drifting mirror axis, a
letterbox bar slams up from the bottom on the onsets, and a scaled echo of the picture
punches in over itself on the kick. The glitch **holds**, and that hold-and-slam is the
difference between rhythm and noise — a claim in the test suite, not a hope.

This is the custom shader **as the star**. Every other `customWgsl` in the catalogue is
simulation plumbing — Gray-Scott chemistry, fluid velocity — buried inside a loop. This
one is what the node is *for* in a VJ rack: a per-pixel effect no stock node can express,
on a picture, driven by the music.

## The identity, extended to user code

**`amount = 0` is a byte-identical passthrough.** Not close — identical, asserted pixel
for pixel in `splice-claims.gpu.test.ts`. Every read in the kernel is a `textureLoad` at
the pixel's own integer coordinate once the offsets collapse: no sampler, no filtering,
nothing to forgive. Every stock node in this project proves its no-op (§V147); user
shader code never had to until now. **This is the pattern for every custom shader anyone
writes here afterwards** — if your kernel claims to pass through at zero, prove it in
bytes.

The audio chains make silence *be* zero: each band drive subtracts the T701 rest value
(the analyser's dB-domain bands rest well above nothing) before scaling, so a silent
pattern drives exactly 0 and the rack at rest shows the picture untouched — also
asserted, as the §V361 cut.

## Graph

```
bed1(noise, dark smoke) ─┐
orb1(circle ┄ pathx1/pathy1) ─┴─► stand1(add) ─┐ order 0
clip1(movieFileIn) ─────────────────────────────┴─► pick1(switch)

pick1 ─► splice1(customWgsl: the glitch) ─► fold1(mirror ┄ spin1) ─┬─► slam1(crop) ─► punch1.in2
beat1(audioPattern 122bpm) ┄ gsub1(−rest)·gd1(×5.5) ┄► splice1.amount │
       ┄ esub1(−rest)·ed1(×1.7) ┄► punch1.opacity                     └─► echo1(transform ×1.18) ─► punch1.in1
       ┄ slag1·sl1(×0.24) ┄► slam1.bottom
punch1(composite, over) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `splice1` | `customWgsl` | the star: 36 bands roll per (band, deal) whether to jump, a 9×5 block grid tears vertically on a rarer roll, and R/B travel further along the same tear — all `textureLoad`, so zero is exact |
| `fold1` | `mirror` | the kaleidoscope fold on live video — the mirror node's **first example**, and the first time its shader was ever compiled by a real device (see below) |
| `slam1` | `crop` | crop *blanks* (TD's crop resizes; ours doesn't) — which makes it the letterbox: the bottom edge rides the onsets through a lag, bars slam up and decay |
| `punch1` | `composite` | the kick echo: a ×1.18 copy laid `over` the frame, opacity driven by the rest-subtracted low band — silent means absent, in bytes |
| `spin1` | `lfo` | the fold axis drifts ±22° — a locked mirror reads as a screenshot |
| `gsub1`/`esub1` | `valueMath` | the T701 rest subtractions: high rests at 0.381, low at 0.712; silence must drive zero or the identity claim is a lie |

## What compiling the mirror found (the §B39 shape, again)

The mirror node's shader contained `vec2f(bool)` — not a WGSL constructor — and had
therefore **never compiled on any real device since it shipped**. No example carried the
node, so no gate ever handed its WGSL to a compiler; the whole catalogue was green about
a node that could not draw. The fix is one token (`vec2<bool>`), and the permanent gate
is this example's existence: `examples.gpu.test.ts` compiles every shipped example on
Dawn, so the mirror — and the crop, the composite, and a customWgsl-as-effect — are now
in that sweep forever. This is exactly why "the idle types are never Dawn-compiled" was
worth closing with examples rather than with a checklist.

## Quantised, not animated

The deal clock ticks at 3/s on the **absolute** clock (§V436 — a timeline lap must not
re-deal the glitch). Between ticks the displacement map is frozen: on a pinned-static
source, frames 90 and 96 are byte-identical; frame 102, across the tick, differs by
thousands of pixels. Both halves are asserted (§V681) — a per-frame wobble would fail
the first, a stuck effect would fail the second, and no still frame or look baseline can
tell either apart from the shipped behaviour (§V712/§V717).

## Where the seams show

- **The fold is pixel-exact but the claim needs it un-rotated.** The symmetry assertion
  pins `rotate = 0` (mirrored pixels sample the same texel, so equality is exact); at a
  driven angle the resample interpolates and exactness would be false precision.
- **The deal hash is the kernel's own.** `hash2` is the standard sin-fract lattice hash —
  fine for a glitch, not a statistical RNG, and deliberately not `pointRand` (that is
  the point pipeline's; a fragment shader has no point identity).
- **Point `clip1` at real footage** (`pick1.index = 1`) and the rack plays it as-is —
  the understudy proves the mechanism; the video input is the point.
