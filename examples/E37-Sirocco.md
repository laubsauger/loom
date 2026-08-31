# E37 — Sirocco

A hot wind, made visible by what it carries. Eighteen thousand motes drift in a
three-dimensional curl-noise field, and each one is drawn as a **streak** — a tapered
ribbon running backwards along its own velocity, so a fast mote draws a long one and a
slow mote draws almost none. The cloud is read three ways at once off one simulation: a
violet body, a gold fast layer, and a dusting of billboard heads. The single most common
look in TouchDesigner's particle repertoire, built out of pieces that already existed.

## Graph

```
drift1(pointKernel · THE WIND) ─► streak1(pointKernel · THE READING) ─┬─► body1(geometry · BEAM, p.size <= 1.35)
   curl of a vector potential        trail = position − velocity·t    ├─► fast1(geometry · BEAM, p.size  > 1.35)
   + containment + inertia           size  = f(speed)                 └─► heads1(geometry · POINTS)
                                                                           ▲ haze1(materialUnlit) — all three

orbx1(lfo) ─┬─► eye1(camera) ─► shot1(render) ◄─ body1 · fast1 · heads1
orbz1(lfo) ─┘

shot1 ─┬───────────────────────────► burn1(add) ─► hue1(hsv) ─► out1(output)
       └─► halo1(blur) ─► halolvl1(level) ─┘          ▲ drift2(lfo) — a 29-second hue cycle
```

## What it proves

- **A beam is a velocity streak, and the trail costs one attribute and no history.**
  `mode: "beam"` takes a per-point far end; `streak1` writes
  `trail = position − velocity × 0.34s`, so the ribbon *is* the distance the mote would
  cover in a third of a second. Derived from **velocity and not from the previous
  position**, and the difference is structural rather than stylistic: a previous-position
  trail draws a false streak across the frame the instant anything moves a point
  discontinuously, and a velocity trail cannot, because velocity does not jump when
  position does.

- **The first example in the set to draw `geometry` in `points` mode.** Every other
  shipped scene uses `surface`, `instances` or `beam`; the billboard mode had no witness
  at all, which is how §B132 — points-mode `scale` silently inert, every authored size
  rendering as 0.05 — survived from T647 until it was measured. Dropping `heads1` from the
  render changes **9.0% of the frame**, so the mode is load-bearing here and the size that
  reaches it is measured, not assumed.

- **The first consumer of a mapped `scale` (T721).** All three draws take `scale` in Map
  mode off the `size` attribute, so the number on the node stays the object's size and the
  attribute is a factor. Size and colour normalise against the **same** reference speed, so
  "fast" means one thing in this document.

- **One cloud, three readings — §V471.1 in the lit scene path.** The `size` predicate
  splits the same edge into a slow body and a fast layer with their own widths and tapers,
  and the heads ride over both. Measured at frame 120, full resolution, display-encoded:
  dropping `fast1` changes 16.2% of the frame and takes mean luma from 18.3 to 11.7;
  dropping `body1` changes 15.8%. None of the three is decoration.

- **Five channels reach the draws where one kernel may declare four.** §V588's ceiling is
  *per kernel*: `drift1` owns position, velocity and tint; `streak1` declares position,
  velocity, trail and size — exactly four, at the ceiling — and does **not** declare
  `tint`, so the colour travels past it by reference (§V197). Chaining is how you spend
  more than one kernel's worth of attributes, and this file needs the room.

- **A flow field is a POTENTIAL, differentiated — not three noises.** What the motes feel
  is the curl of a vector potential, which is divergence-free by construction: the wind can
  stretch the cloud, fold it and shed sheets off it, and can never drain it into a point.
  Three independent noises have sources and sinks, and a cloud in one of them collects into
  blobs within seconds. Measured over thirty seconds: the centroid never leaves a ball of
  radius 0.21 about the origin and the p95 radius stays between 1.29 and 1.39 — the
  population neither escapes nor collapses.

- **The motes are accelerated by the wind, never carried along it.** The picture is the
  field *integrated through inertia*, which is the whole of §V427 — noise is smooth at
  every scale and a simulation is not. Raise the drag far enough and this degenerates into
  exactly the plain noise lookup it exists not to be.

- **The warm start runs the same integrator the frame does.** A gallery thumbnail is frame
  0 (T535), and a cold seed opens on a uniform fuzzy ball the piece never shows again —
  measured, before the fix. `ctx.firstRun` seeds a volume-filled sphere and then runs
  **120 steps of the identical `step` function**, ending exactly at this frame's clock, so
  frame 0 is a cloud that has already folded. The seeding signal is `firstRun` and not
  `frameIndex == 0` (§V495/T510): a lap keeps its buffers and this simulation must survive
  it, while a seek and a load clear them and it must not.

- **Nothing here restarts at a timeline lap.** The wind reads `ctx.absTime`; `ctx.time`
  wraps at the out point and would put every phase of the potential back where it was at
  frame zero, snapping the whole cloud once a lap.

- **The colour is data the kernel writes, so there is no palette lookup downstream.**
  `drift1` writes a per-point tint from speed *squared* and a slowly travelling band —
  squared because the median mote sits at heat ≈ 0.46, which puts the body of the cloud in
  deep blue and spends the amber only on the genuinely fast few. A linear ramp washes every
  streak to the same cream; that was the first render, and it is why this one is not a
  luminance lookup like E31's. A grade that replaced colour with luminance would discard
  the one thing the kernel is saying.

## What it does not claim

The draws are **opaque and depth-tested** — a scene draw is not an additive splat — so the
brightness here is surface, not accumulation, and §V627's resolution-dependence argument
about additive point density does not apply to the render itself. The bloom after it is
still judged at full resolution and display-encoded (§V618).

There is **no feedback trail**. The streak is geometry, not a smear, and that is the whole
point of the beam: a feedback smear on top would be a second, softer answer to a question
this file already answers exactly.
