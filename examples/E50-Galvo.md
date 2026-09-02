# E50 — Galvo

A show laser, simulated by its own physics: a red star scanned on a dark wall, with
the bright dwell dots at its points that real laser art has and fakes do not.
Simulation only — the hardware output stage is sequenced behind §T949's sideEffect
declaration, deliberately.

E49 Lissajous is the same `laserPath` planner with its stages turned down; here it
runs at full strength, because a galvo is a mirror with mass: it cannot turn a corner
at speed, so the planner dwells there — extra samples at every vertex, scaled linearly
by angle steepness (TouchDesigner's own mincornerhold/maxcornerhold formulation).

## The hot dots are the physics, not a decoration

Corners are bright because the beam decelerates: the planner inserts up to fifteen
coincident samples at the star's sharp outer points, each sample is one tick of the
30,000 points/second clock rendered as a small additive splat, and fifteen ticks in
one place deposit fifteen times the energy. Nobody drew a dot. The five gentler inner
vertices dwell less and glow less — the contrast is the corner-hold formula made
visible. Set `beam1.holdMax` to 0 and the dots vanish; set `maxStep` to 0 and every
edge draws bright at the ends and dim in the middle, the ballistic artifact
resampling exists to fix. Both of the plan document's acceptance criteria are one
knob each.

## In budget, and honestly so

The star's ~460 planned samples sit inside the 500-point frame budget of 30 kpps at
60 fps, so the figure is rock steady — what a correctly driven scanner looks like.
Drop `beam1.pps` toward 5,000 and the same figure crawls and flickers as the scan
window stops covering the plan in one frame: the overdriven-scanner artifact, from
arithmetic rather than an effect. The short afterglow is the eye (`echo1` at 0.55),
not phosphor, and the wide soft bloom is beam divergence on a wall.

```
gen1(pointKernel) ─► beam1(laserPath) ─► draw1(renderPoints) ─► trace1(add) ◄─ echo1(feedback)
trace1 ─► hot1(threshold) ─► halo1(blur) ─► glow1(add) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `gen1` | `pointKernel` | ten vertices, outer/inner radii alternating, spinning slowly — the dots ride the geometry |
| `beam1` | `laserPath` | the planner at full strength: bounded galvo velocity, corner dwell by angle steepness |
| `draw1` | `renderPoints` | the spot on the wall: additive splats, colour mapped from the plan's scan window |
| `trace1` | `add` | this frame's beam over the eye's decay |
| `echo1` | `feedback` | persistence of vision: 0.55, far shorter than E49's phosphor |
| `hot1` | `threshold` | the beam's core, into the halo |
| `halo1` | `blur` | divergence: 34 px of soft spread |
| `glow1` | `add` | beam plus divergence |
| `out1` | `output` | the wall |
