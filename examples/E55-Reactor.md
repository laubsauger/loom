# E55 — Reactor

An alien disco ball lit from inside: a churning core marched as an emissive volume, a few large organic-framed glass facets per shell with finer shells within, a lattice that morphs, shutters that slam shut on a drop so the ball collapses to contained light and blazes back, a core that blows out on a swell, a camera that tours three stations, and a palette that turns over minutes. Two `customWgsl` passes from one shader, every knob on the main node's page.

## Why it is one shader (T1141)

The catalogue was read before this was shaped. The scene pipeline's glass is a screen-space read of what the opaque pass already drew, so glass behind glass does not refract; its lights are directional or point, with no medium a beam could be seen in. So `reactor1` does the optics itself, in E46 Lantern's lane taken into 3D:

- **Analytic shells.** Every shell is a sphere, so a crossing is a quadratic, not a march. The ray hops from crossing to crossing, and the glass never shows a sphere-tracing artefact.
- **The frame.** A 3D Worley partition of the direction splits each shell into organic cells: few and large on the outer shell (`divisions`), more on each shell inward, so adjacent facets differ sharply in angle and take visibly different Fresnel values. That contrast between neighbouring faces is what makes a faceted surface read as geometry; a fine lattice reads as one smooth gradient, which is a sprite. Within `frameWidth` of a border the ray has hit a strut, shaded as a lit body under the core with the core's light showing through the member, its width varying by cell so the frame reads as grown rather than extruded. A share of the faces (`blocked`) are plates at rest, a different set per shell. The lattice morphs (`morph`): the direction is warped by three slow travelling sines before the cells are read, so faces grow and shrink and borders travel without ever snapping; a cell's identity is its grid cell, so a plate or a facet's tilt never flickers while its shape moves.
- **The glass.** Each face is a facet: the sphere normal tilted by a per-cell random vector scaled by `facet`. Schlick Fresnel splits the ray, with a floor on the head-on reflectance tinted `glassColor` so the glass keeps its colour when a face turns toward you. The reflected share reads the core's glow per channel offset by `dispersion`; the transmitted share bends by Snell and walks on.
- **The haze.** A thin medium lit by the core, gated by every shell between the sample and the origin: bright through the faces, dark under the struts and plates. A fine noise on the direction striates the beams along their length.
- **The core.** Inside the innermost shell an emissive fbm volume churns on `absTime`, white-hot at the centre through `coreColor` to `edgeColor` at the rim, cut by radial filaments (`laserCount`, `laserGain`).

## Two passes, one shader (T1150)

The medium outside the ball was the whole frame's cost, and a volumetric is low-frequency. `haze1` draws only the straight ray's front haze, at half resolution through the node's own resolution override (`scale 0.5`), as two colour-free weights; `reactor1` draws the geometry at the project resolution and reads the front haze back bilinearly, which also softens the beams and settles the grain. Every knob `haze1` needs mirrors `reactor1`'s by expression, driven lanes included.

Measured on Dawn/Metal, the whole graph: about 13.5 ms a frame at 1280×720, about 25 ms at 1920×1080 (40 fps). The geometry pass alone is at the 60 fps budget at 1080p, so 1080p60 is not reachable for this design on this machine; the file ships at 1280×720. Set the project resolution to 1920×1080 if 40 fps is acceptable.

## The two gestures

**The collapse.** A drop is a transition, not a quiet level, so the detector is the slope of the slowest envelope: `drop1` differentiates `env3`, `dropx1` and `dropb1` map the top few percent of falls onto 0 to 1 (a beat's decay never fires it; a pulled-back bar shuts it fully), `dropc1` clamps, and two lags with a fast rise and a slow release close the outer shell first (`shieldOuter`) and the inner shells after (`shieldInner`), so the shielding cascades inward and opens in the same order. A raised shield raises the threshold every plate's hash is judged against, so plates close in hash order across the shell; at 1 the shell is solid. While the outer shell is shut the core's own radiance dies back to a third and its colour cools toward the rim colour, so the ball collapses and the light goes out rather than a lid closing on a lamp; a shut plate is contained light, not a dead hull: its seams glow where it meets the struts, a twelfth of the light leaks through its skin into the haze, and the whole thing opens back to full on a slow release, so a collapse lands for a couple of seconds instead of flickering past. `armt1` holds the shutters open for the first three seconds, because the pattern's opening hit decays like a drop and the rest state is the radiating one. `dropx1` and `dropb1` are the sensitivity; a real track has its own numbers.

**The escalation.** The tight bloom's gain rides `env3` with an aggressive range (`blowx1`, `blowb1`), so a sustained loud passage blows the core out and a quiet one lets it settle. The bloom is two widths: `cut1` remaps the highlights, `clamp1` floors the remap at zero (a Level is a remap, and a blurred negative field added back is a dark halo), `blur1` and `blur2` widen, `gain1` and `gain2` weight, `add1` and `add2` composite.

## The camera

Three stations on the free-running clock, eased between (a cut would throw the parallax away): wide, close on the shell surface with struts passing the lens, and between the second and third shells looking in at the core through the finest lattice. `stations` scales how far from the wide shot the tour goes (0 holds the wide shot), `travel` is the seconds per tour, `orbit` the circling rate, and the exposure stops down as the eye nears the core. The orbit is wide enough that the shells slide across each other, which is the depth cue.

## The knobs are the shader's own struct

There is no project-level publish surface in this build (§T1143), so the top level is `reactor1`'s parameter page. Each field of `struct Params` reflects into a named, drivable control with the shader's trailing comment as its description.

## Colour

One hue angle turns the core, the glass and the beams together at `hueDrift` degrees per minute, and each shell inward sits `shellHueStep` degrees further round from that same angle, so colour deepens toward the core and the shells keep their relationship at every moment of the cycle. The sky does not turn.

## Audio, on the light and on the form

`music1` is the synthetic pattern; `track1` is your own file one drop away, and `source1` picks between them. Three envelopes at three speeds feed affine `valueMath` pairs calibrated on the shipped pattern: through `env1` (fast), `level` to `coreGain`, `low` to `laserGain`, `highMid` to `facet`; through `env2` (0.35 s), `low` to `frameWidth` and `highMid` to `shellGap`; through `env3` (0.7 s), `level` to `swell` (the outer shell's radius) and to the bloom's gain, and its slope to the shutters. Every retained value sits inside its driven range and none holds a value for a second (§V903, asserted in the claims).

To use a microphone, replace `track1` with an `audioIn` node and set `source1` to 1.

## The chain

```
bed1(noise) -> haze1(customWgsl) -> reactor1(customWgsl) -> add1(add) -> add2(add) -> grade1(hsv) -> out1(output)
reactor1(customWgsl) -> cut1(level) -> clamp1(limit) -> blur1(blur) -> gain1(level) -> add1(add)
blur1(blur) -> blur2(blur) -> gain2(level) -> add2(add)
music1(audioPattern) -> source1(valueSwitch) -> env1(valueLag) -> levelx1(valueMath) -> levelb1(valueMath)
track1(audioFileIn) -> source1(valueSwitch)
env1(valueLag) -> lowx1(valueMath) -> lowb1(valueMath);  env1(valueLag) -> highx1(valueMath) -> highb1(valueMath)
source1(valueSwitch) -> env2(valueLag) -> barx1(valueMath) -> barb1(valueMath);  env2(valueLag) -> gapx1(valueMath) -> gapb1(valueMath)
source1(valueSwitch) -> env3(valueLag) -> swellx1(valueMath) -> swellb1(valueMath);  env3(valueLag) -> blowx1(valueMath) -> blowb1(valueMath)
env3(valueLag) -> drop1(valueSlope) -> dropx1(valueMath) -> dropb1(valueMath) -> dropc1(valueLimit) -> arm1(valueMath) -> shieldo1(valueLag), shieldi1(valueLag)
armt1(timer) -> armc1(valueLimit) -> arm1(valueMath)
levelb1 ┄drives┄► reactor1.coreGain
lowb1 ┄drives┄► reactor1.laserGain
highb1 ┄drives┄► reactor1.facet
barb1 ┄drives┄► reactor1.frameWidth
gapb1 ┄drives┄► reactor1.shellGap
swellb1 ┄drives┄► reactor1.swell
shieldo1 ┄drives┄► reactor1.shieldOuter
shieldi1 ┄drives┄► reactor1.shieldInner
blowb1 ┄drives┄► gain1.brightness
```

## Reproducibility

The only clocks are `frameU.absTime` in the shader and `armt1`'s timeline read for the arm; the volumetric dither is a hash of the pixel, fixed across frames. Same seed, same frames.

## What this example is a gate for

`reactor-claims.gpu.test.ts` reads the pixels: switching the core off brightens no pixel and darkens the disc; widening the struts until every cell is strut darkens the medium outside the ball; cutting the drives changes the frame, and the driven `coreGain` never falls below its bias nor holds still; a shut shell darkens the ring and the shipped frame 60 is the open state; cutting both bloom widths off the composite darkens the disc (the branch shipped dead for three rounds before this claim existed); and consecutive frames still differ at the end of a minute.
