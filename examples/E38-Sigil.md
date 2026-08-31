# E38 — Sigil

Eighty-three thousand motes sit on a grid, and a picture decides which of them are the
mark. A ring and a pip, drawn from two circles and a difference, are sampled once per
grid cell; the motes that land inside the drawing are sprung to their own cells and hold
the shape, and the ones that do not are never gathered at all — they are the blue haze
drifting around it. A slow cycle lets go and takes hold again, so the mark comes apart
into the population it was made of and reassembles out of the same motes.

## Graph

```
disc1(circle) ─┐                         cycle1(lfo) ─► shape1(valueMath) ─► hold1(valueLimit)
hole1(circle) ─┴─► ring1(difference) ─┐                                            │ value1
pip1(circle) ─────────────────────────┴─► emblem1(add) ─────────────► gather1(pointKernel)
                                                                         ▲ field    │
grid1(pointGrid 384x216) ────────────────────────────────────────────────┘ in       │
                                                       ┌────────────────────────────┘
                                    haze1(renderPoints  p.mark <= 0.5) ─┐
                                    glyph1(renderPoints p.mark >  0.5) ─┴─► both1(add)

both1 ─┬────────────────────────────► burn1(add) ─► hue1(hsv ┄ drift1) ─► out1
       └─► halo1(blur) ─► halolvl1(level) ─┘
```

## What it proves

- **An image can decide where points BELONG, not just what colour they are.** A picture has
  been reachable from a point graph since the texture-to-attribute bridge landed at T124,
  and E20, E27 and E34 all use one — but always to tint or displace points that were going
  to be where they are anyway. Here `fieldAt` samples the emblem at each mote's own cell and
  that number scales the spring that gathers it, so the mark is drawn **out of** the
  population rather than emitted from somewhere else, and the motes the picture does not
  claim are the haze around it. One texture wire, no extra attribute pass.

- **Membership is a property of the CELL, and that is the whole correctness argument.**
  `fieldAt(home)` — the mote's grid cell — and never `fieldAt(home + drift)`, which is the
  shorter and more obvious thing to write. Sample where the mote *is* and the mark's
  population changes hands: motes that wander in are captured, motes that wander out are
  dropped. Measured over one cycle: **6528 members become 8302, with 3573 slots changing
  sides**, while the look instrument reads **range 0.8953 for both, to four decimal
  places.** That is §V681 in one line — the damage is entirely in the correspondence, and
  no still frame contains it. `sigil.gpu.test.ts` is what sees it.

- **The glyph that re-forms is the glyph that came apart.** One whole cycle after frame 0
  the assembly plateau has come round again and every member is back on its own cell: mean
  |drift| over members **0.0011**, against **0.0962** with the gather term removed — 87×,
  and the same look range to four decimals again. The two claims pin each other's blind
  spot: the first alone passes on a population frozen in the dispersed state, the second
  alone passes on a mark made of the wrong motes.

- **A bounded displacement, not a force — and the difference is the second build.** The
  first version let the spring fall to zero and a wander force accumulate. That does not
  scatter a glyph, it **inflates** one: members keep their relative positions and drift
  outward together, so the mark balloons instead of coming apart, and the shared term
  carries the whole population off the frame edges leaving black corners. The kernel now
  springs to a bounded target, so nothing can leave a ball of `SPREAD + CURRENT` about its
  own cell whatever the cycle does.

- **The grid is deliberately WIDER than the frame.** 2.4 units against a 2-unit clip
  square, so there are always motes outside the picture to drift inward and fill its
  border. `fieldAt` clamps its uv and the emblem is black at its edge, so an off-frame cell
  samples background and joins the haze — it can never become a false member.

- **The mark is stippled, not dithered.** 384×216 cells land almost exactly four pixels
  apart on a 1280×720 frame, so without a fixed sub-cell offset per mote the assembled mark
  is a regular lattice and reads as halftone. The offset is fixed *per mote* rather than
  redrawn each frame, or the stipple boils.

- **The cycle is shaped, not just an LFO.** A sine spends almost no time at its extremes, so
  on its own the glyph would never *hold* — it would pass through legible on its way
  somewhere. Gain then clamp is the standard shape for that, and it is two nodes doing one
  job each: `shape1` multiplies by 1.6, `hold1` clamps to 0…1, and real dwells appear at
  both ends. The result reaches the kernel as `ctx.value1`, an ordinary drivable parameter,
  so the cycle lives in the value graph where it can be seen and retimed rather than buried
  in WGSL where only a recompile could reach it.

- **§V684, paid rather than argued.** The obvious subject for this example is text, and
  text is unavailable: the harness does not fake the `text` node, so a text-bearing document
  renders black in every offline gate and its §V643 baseline would enshrine that black. Two
  circles differenced into a ring, plus a pip.

- **§V627, paid rather than discovered.** This file began with E31's luminance palette on
  the end of it. At the look instrument's 192×108 probe the same points land in 1/44th of
  the texels, every pixel clears the ramp's last stop, and the measured frame is **uniform
  white — range 0.0000**, a straight failure of the contrast floor on a document that reads
  perfectly well at 1280×720. The two layers carry their own colour instead, and the grade
  is a hue drift that cannot saturate.

## What it does not claim

The dispersed state is a **scatter**, not a simulation: each mote has a fixed heading and a
fixed distance, with one shared moving current on top. Nothing here is advected and nothing
integrates a field — E37 is where that argument is made. What this file is about is the
target, and the target is a picture.
