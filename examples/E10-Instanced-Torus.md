# E10 — Instanced Torus

A torus of 1152 points wearing a lit box each, spinning. Geometry with no mesh assets:
the points are analytic, the boxes are generated from the vertex index, and the
rotation is a driven parameter — nothing here recompiles while it moves.

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

## What it proves

**The edge carries the geometry (T296/§V197).** The renderer binds the GENERATOR'S
position pair by edge payload — `scratch:points:position`, half named by the producer —
not by a naming convention and not through a copy. Rewire the torus for a sphere and
the boxes follow; nothing downstream knows which node owns the buffer.

**3D without meshes (T299).** The box is arithmetic on `vertex_index`; depth comes from
the target's declared attachment (`depthOutputs`); the published transform order
(§V198: scale, rotate X→Y→Z, translate, project) is what makes "rotate.y" mean what a
TD or Houdini user expects.

**E7's mechanism on one COMPONENT (§V113).** `rotate.y` is in `driven` mode naming
`lfo1` while `rotate.x`/`rotate.z` stay static — per-channel modes on a compound
parameter, and because rotation reaches the shader as uniform values (§V5), the whole
spin costs zero recompiles.

## What breaks here first

Edge-payload binding (the draw's buffer id IS the generator's pair — the concept test
pins it), the depth attachment on the render target, and component-slot resolution.
Regressions read as: boxes frozen at origin (payload lost), faces bleeding through
each other (depth gone), or a formation that never spins (component slot unresolved).
