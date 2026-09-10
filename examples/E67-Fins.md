# E67 — Fins

Nine bevelled glass slabs, hanging in a dark room, ray traced exactly. Each ray refracts in and out of every slab it crosses, so glass sees glass. Three coloured beams are traced through the same stack and kink at every face. Thin film sweeps an oil-slick rainbow across each face, and the camera drifts in a slow orbit. The piece was built by hand in the app. This example ships it unchanged, and adds one thing: the lights answer the beat.

## The graph

```
envSeed(solid) -> glassRT(customWgsl) -> finalGrade(customWgsl) -> finalImage(output)

clip1(audioFileIn) -> analysis1 -> react1(valueMath)     the hits, times the reactivity knob
```

`glassRT` is an analytic ray tracer in one fragment shader. A slab is an oriented box with an exact ray intersection, so there is no marching. Beer-Lambert absorption is applied inside each body, Fresnel splits every interface, and the bevel is shaded rather than modelled. `finalGrade` is deliberately light: an asymptotic highlight ceiling, a shallow toe and a small vignette. The frame is dark because the lighting leaves most of it empty, not because a curve crushes it. Both shaders are the hand-built sources, byte for byte (`src/examples/shaders/fins.wgsl.ts`).

## The lights on the beat

`clip1` plays the shipped beat (`media/showcase-beat.m4a`, the clip E66 reads) under the timeline lock, so a recording is frame-exact and repeatable. `analysis1` is the starter `AudioAnalysis` component. Its `hits` output is four counts, each 1 on the frame it fires and decaying over 300 ms. It passes through `react1`, a multiply whose operand is the **reactivity** knob.

| lane | drives on `glassRT` | what you see |
| --- | --- | --- |
| `kickCount` | `stripLevel`, `laser`, `laser2`, `laser3` | the white strip sources the edges catch, and all three beams, flare on the kick |
| `snareCount` | `glow` | the light wandering inside the glass blooms on 2 and 4 |
| `hatCount` | `gelLevel` | the coloured panels of the room lift a little on every eighth |

Every driven parameter is the hand-built value times (1 + gain × lane), or plus gain × lane. A lane at 0 therefore returns the hand-built value exactly. Only light parameters are driven: the geometry, the camera and the motion never hear the music, so a beat frame shows the same slabs in the same place as a rest frame.

- **Reactivity 0** (`react1` operand) is the hand-built piece, byte for byte.
- **Above 1** hits harder.
- **Your own track**: set `clip1`'s file. For a new tempo, change its BPM and beat offset, or set tempo to detect.

`src/examples/e67-fins-claims.gpu.test.ts` asserts all of this from rendered pixels. At reactivity 0, and before the clip's first hit, the frame equals the frame with every light cut to its hand-built value. On the kick, cutting the kick lights changes the frame and darkens it. On the snare, cutting the glow does the same, and on the kick cutting the glow changes nothing. The same test checks on the document that the set of parameters reading `react1` is exactly the six lights.

## Motion

The camera circles the stack once every **four minutes**, at the hand-built distance and height (T1268). It starts at the hand-built angle, so the first frame is the composition approved when the piece shipped. Over a turn the fins go from facing you, through side-on (where the stack reads as a line of blades), and back. The hand-built orbit swung ±17° over eight minutes and read as a still. The owner picked the full circle from stills against two gentler swings. A turn is periodic, so it never shows a seam. Inside the stack, the slabs keep their own slow spin, spiral surges and beams, all on the absolute clock.

## What changed from the hand-built file

- The room's input was a photo node holding a `blob:` URL, which dies with the tab. It never reached the picture: `envMix` was never set, so it sits at its default of 0, and the shader samples its input only above that. The file's own unconnected black `envSeed` feeds the input now. To light the glass with a real room, wire a latlong image into `glassRT` and raise `envMix`.
- The photo node was pinned to 2048×1024 and `glassRT` inherits its input's size. The hand-built piece therefore traced at 2:1 and was squashed into a 1280×720 output. The example renders native 16:9 at 1920×1080. The vertical field of view is the shader's, so the slabs keep their height in frame and get their true width back. This is the only difference from the hand-built frame.
- The unused starter components and the empty group frames were not carried over.

## Recording

The recorder writes video only. Record with the timeline running from the start, then mux the clip (or your own track) under it afterwards. Both follow the same timeline, so they stay in sync.
