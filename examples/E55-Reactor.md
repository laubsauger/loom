# E55 — Reactor

An alien disco ball lit from inside: a churning core marched as an emissive volume, nested organic-framed glass-faced shells the light refracts and glints through, and a haze that turns what gets out into shafts. One `customWgsl` raymarcher, every knob on its page, the synthetic pattern scaling the core, the filaments and the glitter.

## Why it is one shader (T1141)

The catalogue was read before this was shaped. The scene pipeline's glass is a screen-space read of what the opaque pass already drew, so glass behind glass does not refract; its lights are directional or point, with no medium a beam could be seen in. A light-emitting nested ball built from additive beams and bloom would be pretending, so `reactor1` does the optics itself, in E46 Lantern's lane taken into 3D:

- **Analytic shells.** Every shell is a sphere, so a crossing is a quadratic, not a march. The ray hops from crossing to crossing, and the glass never shows a sphere-tracing artefact.
- **The frame.** A 3D Worley partition of the direction splits each shell into organic polygonal cells. Within `frameWidth` of a cell border the ray has hit a bar, shaded under the core's light with a rounded profile whose normal comes free from the Worley search. Elsewhere it has hit a face.
- **The glass.** Each face is a facet: the sphere normal tilted by a per-cell random vector scaled by `facet`, so neighbouring faces reflect the core differently. That per-tile disagreement is the disco reading. Schlick Fresnel splits the ray; the reflected share reads the core's glow per channel offset by `dispersion`, the transmitted share bends by Snell and walks on. Total internal reflection reflects.
- **The haze.** Between crossings the ray integrates a thin medium lit by the core, gated by every shell between the sample and the origin. Bright through the faces, dark under the bars: the shafts outside the ball are the faces, projected.
- **The core.** Inside the innermost shell an emissive fbm volume churns on `absTime`, white-hot at the centre through `coreColor` to `edgeColor` at the rim, cut by radial filaments (`laserCount`, `laserGain`) that ride through the haze as beams.

## The knobs are the shader's own struct

There is no project-level publish surface in this build (§T1143), so the top level is `reactor1`'s parameter page. Each field of the shader's `struct Params` reflects into a named, drivable control with the shader's trailing comment as its description: `layers` (0 to 4 shells), `divisions` (cells on the outer shell; inner shells carry fewer), `frameWidth`, `shellGap`, the glass (`ior`, `dispersion`, `facet`), the light (`coreGain`, `coreColor`, `edgeColor`, `laserGain`, `laserCount`, `haze`), the motion (`spin`, `turbulence`, `orbit`), and `frameColor`, `distance`, `exposure`. Change `layers` or `divisions` and the whole optical stack follows, because there is nothing else to change.

## Liveliness is structural

The camera orbits, every shell counter-rotates at its own rate, the core churns and the filaments sweep, all on the free-running clock and none of it an envelope with a rest state. The music only scales gains that are already moving. Measured with the look instrument's own arithmetic over a whole minute rather than its first two seconds (§V913): the mean frame-to-frame luma motion is reported in the document's docblock alongside the recorded row.

## Audio, in the catalogue's fixed shape

`music1` is the synthetic pattern, no microphone and no asset. `track1` is your own file one drop away, and `source1` picks between them so the two never merge onto one port. `env1` smooths, then each `valueMath` pair maps a band's measured range on the shipped pattern onto the range a knob wants: `level` 0.06 to 0.52 becomes `coreGain` 0.9 to 2.2, `low` 0.70 to 0.98 becomes `laserGain` 0.3 to 1.6, `highMid` 0.30 to 0.71 becomes `facet` 0.4 to 1.0. No lane can fall below its bias, and none holds a value for a second (§V903, asserted in the claims).

To use a microphone, replace `track1` with an `audioIn` node and set `source1` to 1; nothing downstream changes.

## The chain

```
bed1(noise) -> reactor1(customWgsl) -> add1(add) -> grade1(hsv) -> out1(output)
reactor1(customWgsl) -> cut1(level) -> blur1(blur) -> gain1(level) -> add1(add)
music1(audioPattern) -> source1(valueSwitch) -> env1(valueLag) -> levelx1(valueMath) -> levelb1(valueMath)
track1(audioFileIn) -> source1(valueSwitch)
env1(valueLag) -> lowx1(valueMath) -> lowb1(valueMath);  env1(valueLag) -> highx1(valueMath) -> highb1(valueMath)
levelb1 ┄drives┄► reactor1.coreGain
lowb1 ┄drives┄► reactor1.laserGain
highb1 ┄drives┄► reactor1.facet
```

## Reproducibility

The only clock is `frameU.absTime`; the volumetric dither is a hash of the pixel, fixed across frames, so it is grain rather than flicker. Same seed, same frames.

## What this example is a gate for

`reactor-claims.gpu.test.ts` reads the pixels: switching the core off brightens no pixel and darkens the disc (the core is the only light); widening the bars until every cell is bar darkens the medium outside the ball (the shafts are the faces); cutting the three drives changes the frame, and the driven `coreGain` never falls below its bias nor holds still for a second; and consecutive frames still differ at the end of a minute.
