# E55 — Reactor

An alien disco ball lit from inside: a churning core marched as an emissive volume, nested organic-framed glass-faced shells the light refracts and glints through, and a haze that turns what gets out into shafts. Two `customWgsl` passes from one shader (the front haze at half resolution), every knob on the main node's page, the synthetic pattern scaling the light and the form, and a palette that turns over minutes.

## Why it is one shader (T1141)

The catalogue was read before this was shaped. The scene pipeline's glass is a screen-space read of what the opaque pass already drew, so glass behind glass does not refract; its lights are directional or point, with no medium a beam could be seen in. A light-emitting nested ball built from additive beams and bloom would be pretending, so `reactor1` does the optics itself, in E46 Lantern's lane taken into 3D:

- **Analytic shells.** Every shell is a sphere, so a crossing is a quadratic, not a march. The ray hops from crossing to crossing, and the glass never shows a sphere-tracing artefact.
- **The frame.** A 3D Worley partition of the direction splits each shell into organic polygonal cells. Within `frameWidth` of a cell border the ray has hit a bar, shaded under the core's light with a rounded profile whose normal comes free from the Worley search. A share of the faces (`blocked`) are solid plates, a different set on every shell, so each shell throws its own silhouette into the light. Elsewhere it has hit a face.
- **The glass.** Each face is a facet: the sphere normal tilted by a per-cell random vector scaled by `facet`, so neighbouring faces reflect the core differently. That per-tile disagreement is the disco reading. Schlick Fresnel splits the ray, with a floor on the head-on reflectance tinted `glassColor` so the glass keeps its colour when a face turns toward you (Fresnel alone vanishes head-on). The reflected share reads the core's glow per channel offset by `dispersion`; the transmitted share bends by Snell and walks on. Total internal reflection reflects.
- **The haze.** A thin medium lit by the core, gated by every shell between the sample and the origin. Bright through the faces, dark under the bars and plates: the shafts outside the ball are the faces, projected. A fine noise on the direction striates the beams along their length.
- **The core.** Inside the innermost shell an emissive fbm volume churns on `absTime`, white-hot at the centre through `coreColor` to `edgeColor` at the rim, cut by radial filaments (`laserCount`, `laserGain`) that ride through the haze as beams.

## Two passes, one shader (T1150)

The medium outside the ball was the whole frame's cost, and a volumetric is low-frequency. So `haze1` draws only the straight ray's front haze, at half resolution through the node's own resolution override (`scale 0.5`, a seam the compiler already had), as two colour-free weights; `reactor1` draws the geometry at the project resolution and reads the front haze back bilinearly, which is also what softens the beams and settles the grain. Every knob `haze1` needs mirrors `reactor1`'s by expression, driven lanes included, so the two passes cannot disagree about where the shells are.

Measured, the whole graph including the bloom, on Dawn/Metal: at 1280×720 about 13.5 ms a frame; at 1920×1080 about 25 ms a frame (40 fps), against 31 before the split. The geometry pass alone is at the 60 fps budget at 1080p, so 1080p60 is not reachable for this design on this machine, and the file ships at 1280×720. Set the project resolution to 1920×1080 if 40 fps is acceptable.

## The knobs are the shader's own struct

There is no project-level publish surface in this build (§T1143), so the top level is `reactor1`'s parameter page. Each field of the shader's `struct Params` reflects into a named, drivable control with the shader's trailing comment as its description: `layers` (0 to 4 shells), `divisions`, `frameWidth`, `blocked`, `shellGap`, `swell`, the glass (`ior`, `dispersion`, `facet`, `glassColor`), the light (`coreGain`, `coreColor`, `edgeColor`, `laserGain`, `laserCount`, `haze`), the motion (`spin`, `turbulence`, `orbit`, `hueDrift`), and `frameColor`, `distance`, `exposure`.

## Liveliness is structural

The camera orbits, every shell counter-rotates at its own rate, the core churns and the filaments sweep, all on the free-running clock and none of it an envelope with a rest state. Measured with the look instrument's own arithmetic over a whole minute rather than its first two seconds (§V913), the frame-to-frame motion is reported in the document's docblock alongside the recorded row.

## Colour evolution

One hue angle turns the core, the glass and the beams together, inside the shader, at `hueDrift` degrees per minute: the hot-against-cold relationship is invariant while the scheme rotates, and the sky does not turn. A hue offset on the graded frame was tried first and refused, because it turned the background with the ball.

## Audio, on the light and on the form

`music1` is the synthetic pattern, no microphone and no asset. `track1` is your own file one drop away, and `source1` picks between them so the two never merge onto one port. Three envelopes at three speeds, then affine `valueMath` pairs map each band's measured range on the shipped pattern onto the range a knob wants:

- On the light, through `env1` (fast): `level` to `coreGain`, `low` to `laserGain`, `highMid` to `facet`.
- On the form, through `env2` (0.35 s): `low` to `frameWidth`, so the bars swell on the kick and the faces close; `highMid` to `shellGap`.
- On the form, through `env3` (0.7 s): `level` to `swell`, the outer shell's radius, the slowest and largest response, so the ball breathes rather than pulses.

Every retained value sits inside its driven range, no lane can fall below its bias, and none holds a value for a second (§V903, asserted in the claims).

To use a microphone, replace `track1` with an `audioIn` node and set `source1` to 1; nothing downstream changes.

## The chain

```
bed1(noise) -> haze1(customWgsl) -> reactor1(customWgsl) -> add1(add) -> add2(add) -> grade1(hsv) -> out1(output)
reactor1(customWgsl) -> cut1(level) -> blur1(blur) -> gain1(level) -> add1(add)
blur1(blur) -> blur2(blur) -> gain2(level) -> add2(add)
music1(audioPattern) -> source1(valueSwitch) -> env1(valueLag) -> levelx1(valueMath) -> levelb1(valueMath)
track1(audioFileIn) -> source1(valueSwitch)
env1(valueLag) -> lowx1(valueMath) -> lowb1(valueMath);  env1(valueLag) -> highx1(valueMath) -> highb1(valueMath)
source1(valueSwitch) -> env2(valueLag) -> barx1(valueMath) -> barb1(valueMath);  env2(valueLag) -> gapx1(valueMath) -> gapb1(valueMath)
source1(valueSwitch) -> env3(valueLag) -> swellx1(valueMath) -> swellb1(valueMath)
levelb1 ┄drives┄► reactor1.coreGain
lowb1 ┄drives┄► reactor1.laserGain
highb1 ┄drives┄► reactor1.facet
barb1 ┄drives┄► reactor1.frameWidth
gapb1 ┄drives┄► reactor1.shellGap
swellb1 ┄drives┄► reactor1.swell
```

## Reproducibility

The only clock is `frameU.absTime`; the volumetric dither is a hash of the pixel, fixed across frames, so it is grain rather than flicker. Same seed, same frames.

## What this example is a gate for

`reactor-claims.gpu.test.ts` reads the pixels: switching the core off brightens no pixel and darkens the disc (the core is the only light); widening the bars until every cell is bar darkens the medium outside the ball (the shafts are the faces); cutting the six drives changes the frame, and the driven `coreGain` never falls below its bias nor holds still for a second; and consecutive frames still differ at the end of a minute.
