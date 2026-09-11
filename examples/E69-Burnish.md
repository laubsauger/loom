# E69 — Burnish

Four spheres and a plate under a coloured sky: a mirror, a brushed metal, a rough metal and
a dielectric, differing in exactly two numbers.

It is the plainest honest thing that renders the metallic-roughness material, and that is
the point of it. This is not a second showcase — it is the gate the BRDF never had.

## Why this file exists

The renderer's flagship material shipped in **zero of 59 examples**. T1284 gave it a real
GGX/Smith lobe and T1289 made roughness blur the environment instead of dimming it, and
nothing in the catalogue rendered either. That is not a coverage statistic; it is how a real
defect hid. The shader generator decides whether to *declare* `environmentMap`, and
`scene.ts` decides at five separate sites whether to *bind* it. Both spelled the same rule
independently, T1284 changed one of them, and the disagreement could not surface because no
shipped frame rendered a pbr material with an environment wired.

If the metallic-roughness path breaks now, a picture in the catalogue breaks with it.

## The four spheres, left to right

Same base colour on the three metals, same light, same sky. The only things that move are
`metallic` and `roughness`, so anything you can see between them is the BRDF and not a tint.

| | metallic | roughness | what it shows |
| --- | --- | --- | --- |
| mirror | 1 | 0.05 | the sky arrives sharp — its gradient and its horizon band are legible in the surface |
| brushed | 1 | 0.42 | the **same** sky, blurred |
| rough | 1 | 0.92 | almost no structure left, and still bright: a rough metal is soft, never dark |
| dielectric | 0 | 0.3 | a body colour and a diffuse half the metals have none of |

Before T1289 the rough ball would have been the mirror's picture **scaled**, not softened —
which is the single largest gap there was between what this renderer shipped and what "PBR"
means to somebody looking at it.

## Why an environment rather than more lights

A metal has no diffuse lobe, so a metal lit only by point sources is a highlight on black —
which is what a BRDF test looks like when it is testing the BRDF rather than the renderer.
The environment is what gives a metal something to reflect, and the reflection is where
roughness actually lives.

The sky is a `ramp`, so it is a TOP like any other and nothing here is an asset. Its band at
the horizon is deliberate: a gradient with an **edge** in it is what makes a mirror legible
as a mirror, because a smooth sky reflects as a smooth nothing and says nothing about
roughness.

## The spheres are a grid folded into a ball

Both obvious routes are closed. `geometry` in instance mode offers quad, box and octahedron
— no sphere — and a faceted solid is the worst possible subject for a roughness ladder,
because its own facets do what roughness is supposed to do. the point generator at shape
`sphere` emits no analytic grid topology, so the surface renderer cannot build a surface
from it at all; only grid, tube and torus carry one.

What works is the oldest route: a `pointGrid`, which carries topology by construction,
mapped onto a sphere in a kernel. The surface renderer takes its normals from central
differences on that grid, so the reflections belong to the material rather than to the mesh.

## Rasterised on purpose

E68 took the marcher's path and gave up MSAA and this material to get volumetrics. This file
takes the other side of that trade deliberately — the scene node family, so it gets the real
BRDF, real shadow maps with PCF, and MSAA free, which is exactly where a sphere's silhouette
shows it. The two pieces together cover both renderers rather than twice covering one.

## The camera drifts, and that is not decoration

A still mirror and a still rough ball differ less than a moving pair, because what roughness
does to a reflection is most legible when the reflection is **travelling**. The drift is slow
and free-running.
