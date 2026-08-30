# E25 — Stage

The multi-stage render, in the owner's words: "a multi stage setup of a camera,
geometry, reproduction, picked up by another camera then to screen and all this driven
interestingly." Scene A is a performance; its render becomes a MATERIAL on a screen
standing inside scene B; a second camera films the screen — a virtual screen inside a
scene, the TD/Notch classic.

## Graph

```
scene A:  ringa1(pointTorus) ─► geoa1(geometry: octahedra, mata1 phong)
          cama1(camera, eye.x/z ┄ orbax1/orbaz1)   keya1(light)
          shota1(render) ─────────────────► a TEXTURE

the crossing:  shota1.out ──► screenmat1.albedo     ← ONE texture edge (V372)

scene B:  screengrid1 ─► screen1(geometry: surface, screenmat1)
          floorpts1 ─► floorkernel1 ─► floor1(geometry: boxes, matfloor1)
          camb1(camera, eye.x ┄ orbbx1)   keyb1(light, intensity ┄ breathe1)
          shotb1(render, scenes: "screen1 floor1") ─► out1
```

## The two sentences that ARE the example

**Scene assembly flows by name; pixels flow on wires (V372).** Each render LISTS its
geometries, camera and lights as names — dashed reference lines, hued per kind — while
scene A's picture crosses into scene B as an ordinary texture edge into a material's
albedo slot. That one edge is the whole mechanism of the virtual screen: any texture
can skin any surface, including a texture some other camera just made.

**Everything moves, nothing rebuilds.** Camera A orbits its performance (two LFOs in
quadrature on `eye.x`/`eye.z`), camera B drifts, the key light breathes — all VALUE
writes through the scene payload channel (T377, §V5). Watch the torus on the screen
change viewing angle independently of your own view of the screen: two cameras,
genuinely nested.

## Why the screen needs a backdrop

The first render of this example showed a floating torus and no screen at all: render
A cleared to unlit black, and an unlit-black screen in a dark room is invisible. Every
`render` now paints a `background` first (a value, like everything else here), so a
render used as a material map is a PICTURE — performers AND stage — not performers
floating in nothing. That failure was caught by looking, and this paragraph is its
regression note.

## Regression signatures

- The screen vanishes and the torus floats → render A's background stopped painting
  (the backdrop pass) or the screen material went lit and shadowed to black.
- The torus on the screen stops moving while the screen still drifts → camera A's
  orbit broke (drive on `cama1.eye.x/z`); the reverse means camera B's did.
- The screen shows scene B's own view (feedback hall-of-mirrors) → someone rewired the
  albedo edge to `shotb1.out`; A-before-B ordering is pinned by test.
- Both scenes light identically → the renders are sharing a light list; each names its
  own.
