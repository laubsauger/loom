# E10 — Instanced Torus

A torus of 1152 points wearing a lit box each, every box tumbling in place. Geometry with
no mesh assets.

The points are analytic, the boxes are generated from the vertex index, and the rotation
is a driven parameter — nothing here recompiles while it moves.

## Graph

```
torus1(pointTorus) ─► instances1.points ─► instances1(renderInstances) ─► out1(output)

lfo1(lfo, saw 0.1 Hz × 360°) ┄┄drives┄┄► instances1.rotate.y
```

| Node | Type | Doing |
| --- | --- | --- |
| `torus1` | `pointTorus` | 48×24 points on a torus, wrapped both ways (`grid:48x24:wrapUV` on the edge) |
| `instances1` | `renderInstances` | a 36-vertex box per point, lambert-lit, through the §V198 camera into a depth-attached target |
| `lfo1` | `lfo` | saw sweeping 0→360 over ten seconds, driving **one component**: `rotate.y` |

## What the picture is

The torus is STILL. What turns is each box, about its own centre, all 1152 of them in
unison — `renderInstances` composes `rotate` before the translation to the point:

```
clip = viewProjection × ( T(point) × Rz × Ry × Rx × S(scale) × vertex )
```

Rotation is inside the translate, so it is the PRIMITIVE's orientation and never the
formation's. Spinning the ring itself is a different edit — the points would have to
move, which is the generator's transform, not the renderer's `rotate`. Read this doc
against `render-instances.wgsl.ts`, not against the word "spin".

## What it proves

**The edge carries the geometry (T296/§V197).** The renderer binds the GENERATOR'S
position pair by edge payload — `scratch:points:position`, half named by the producer —
not by a naming convention and not through a copy. Rewire the torus for a sphere and
the boxes follow; nothing downstream knows which node owns the buffer.

**3D without meshes (T299).** The box is arithmetic on `vertex_index`; depth comes from
the target's declared attachment (`depthOutputs`); the published transform order
(§V198: scale, rotate X→Y→Z, translate, project) is what makes "rotate.y" mean what a
TD or Houdini user expects — a yaw of the thing you named, in place.

**E7's mechanism on one COMPONENT (§V113).** `rotate.y` is in `driven` mode naming
`lfo1` while `rotate.x`/`rotate.z` stay static — per-channel modes on a compound
parameter, and because rotation reaches the shader as uniform values (§V5), the whole
tumble costs zero recompiles.

## What breaks here first

Edge-payload binding, the depth attachment on the render target, and component-slot
resolution. Regressions read as:

| Symptom | Cause | What catches it |
| --- | --- | --- |
| boxes frozen at origin | edge payload lost | `concepts.test.ts` — the draw's buffer id IS `scratch:points:position` |
| faces bleeding through each other | depth attachment gone | `concepts.test.ts` — the draw target declares `depth: true` |
| every box axis-aligned and motionless | `rotate.y` fell back to its static binding | `concepts.test.ts` pins the SLOT in the document (`mode: "driven"`, channel `lfo1`) — nothing here asserts the resolved uniform actually moves, so a resolver that silently dropped the drive would pass |

A "formation that never spins" is NOT a regression signature here: the formation has
never spun (B43). Watching for the absence of behaviour the shader does not implement
sends the next reader to the wrong file.
