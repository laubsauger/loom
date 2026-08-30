# E16 — Murmuration

Two thousand birds swirling around a sphere they never abandon, coloured by how fast
they fly, parting around the cursor — and drawn through a chain of THREE point nodes.
This is the SOP-chain showcase: points as a pipeline, not a source-to-sink hop.

## Graph

```
sphere1(pointSphere) ─► flock1.in ─► flock1(pointKernel) ─► part1.in ─► part1(pointKernel) ─► birds1.points ─► birds1(renderInstances) ─► out1(output)
```

| Node | Type | Doing |
| --- | --- | --- |
| `sphere1` | `pointSphere` | 2000 anchor points on a Fibonacci sphere — the formation |
| `flock1` | `pointKernel` | the murmuration: flow-field swirl + spring home, integrated in its OWN state around the UPSTREAM anchors; writes `tint` from speed |
| `part1` | `pointKernel` | the E9 cursor push as a stateless PROCESSOR — a Gaussian shove away from the pointer |
| `birds1` | `renderInstances` | an octahedron per point, colour mapped from `tint`, `group` culling anything past radius 1.7 |

## What the picture is

The sphere formation is the SKELETON: `flock1` reads it fresh every frame — a processor
RE-READS its input, it does not integrate it — accumulates `offset` and `velocity` in
its own persistent pairs, and writes `position = anchor + offset`. That split is what
stops a chained kernel slowly diverging from the geometry it is deforming: the anchor
cannot drift because it is never fed back.

**Why this is not boids, and looks like it anyway.** Real boids need neighbour reads —
separation, alignment and cohesion are all functions of the birds around you — and a
kernel sees exactly one point, so honest boids would need an O(N²) gather this system
deliberately does not have. Instead every bird samples one SHARED flow field,
phase-keyed by its anchor: neighbours on the formation sit at nearly the same anchor,
sample nearly the same field, and therefore turn together — which is most of what your
eye reads as flocking. The spring home supplies cohesion, damping keeps flight airborne
rather than orbital, and no bird ever knows another exists.

Slow birds sit deep blue; fast ones flare toward warm white — `tint` is computed from
`length(velocity)` inside the flock kernel, which is what "coloured by velocity" means
here: the renderer maps a vec4f attribute; the kernel decides what velocity looks like.

Move the cursor into the flock and it parts: `part1` displaces positions away from the
pointer with the same Gaussian-not-edge falloff as E9's fountain. Push a bird past the
flock's airspace and it VANISHES — `birds1`'s `group` predicate (`length(p.position) <
1.7`) collapses it to a zero-area primitive at draw time. Nothing killed it; it is
simply not drawn until it springs back inside.

## What it proves

**Processors chain (T401/B57).** `flock1` binds `sphere1`'s position pair; `part1`
binds `flock1`'s; `birds1` draws `part1`'s. Before T401 the second node of this chain
could not exist: every kernel was a source, and `torus → kernel → instances` was a
graph nobody could draw.

**Mixed ownership is the mechanism, not a hazard (§V197).** In one node: `position`
arrives from upstream (carried attribute → upstream pair, fresh every frame), while
`offset`/`velocity`/`tint` persist in the kernel's own pairs (not carried → own state).
That split is exactly what lets a PROCESSOR still be a SIMULATION.

**Attributes cross nodes by reference (§V197's narrowing).** `part1` declares only
`position`. `tint` — authored in `flock1`, consumed by `birds1` — crosses `part1`
untouched, as the FLOCK's own pair: one buffer, zero copies, two nodes apart. Check the
draw's bindings: the colour map names `scratch:flock:tint`.

**Draw-time groups earn their keep (T333).** The cull is a predicate over the edge's
typed payload, evaluated in the vertex stage — no kernel cooperation, no CPU, no
readback.

## Regression signatures

- The flock drifts away from the sphere or collapses into it → the spring/damping
  balance in `flock1`, or `offset` no longer persisting (its pair stopped being the
  kernel's own).
- The whole flock is one colour → `tint` stopped crossing `part1` by reference (the
  §V197 passthrough broke) or the colour map lost its attribute.
- Birds pushed by the cursor come back displaced from their neighbours permanently →
  `part1` grew state it must not have; it is stateless by design.
- Strays never vanish → the `group` predicate stopped binding `p.position` from the
  typed edge (T333/§V308).
