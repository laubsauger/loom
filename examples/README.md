# Examples

These are not demos. Each file here is an executable specification (§C "example projects",
§V88, §V89): a real `.loom.json`, loaded through the same loader a user's file goes
through, compiled by the same compiler, and stepped by the same backend.

An example that stops loading, stops compiling cleanly, or stops rendering deterministically
is a **release blocker**, not a docs chore. When one fails, exactly one of three things has
happened:

1. the file format regressed,
2. a node manifest changed incompatibly, or
3. the compiler broke.

| File | Proves |
| --- | --- |
| [E1 Feedback Echo](./E1-Feedback-Echo.md) | explicit temporal boundary, fade + transform inside a loop, stable ping-pong (§V4, §V22) |
| [E2 Reaction-Diffusion](./E2-Reaction-Diffusion.md) | the algorithm as a GRAPH: animated noise into a spatially varying feed/kill map, 20 substeps per frame, colour through a Ramp (T387, T388) |
| [E3 Animated Noise Field](./E3-Animated-Noise-Field.md) | time via `FrameEvaluationInput` and never a clock, fan-out rendered once (§V44, §V6) |
| [E4 Bloom](./E4-Bloom.md) | multi-branch converge, HDR intermediate through a per-node format override (§V51, §V6) |
| [E5 Kaleidoscope](./E5-Kaleidoscope.md) | extend modes, per-node resolution override, cheap chain at high resolution (§V50) |
| [E6 Displacement Stack](./E6-Displacement-Stack.md) | `data` vs `linear` space discipline; a displacement field is never colour-converted (§V56, §V57) |
| [E7 LFO Dissolve](./E7-LFO-Dissolve.md) | a parameter animated through `driven` mode; channel liveness without edges (§V143, §V173b) |
| [E8 Slit Scan](./E8-Slit-Scan.md) | per-pixel time from a 48-frame ring bound as one texture array (T321, §V229) |
| [E9 Ember](./E9-Ember.md) | A fire front on a curl field: GPU-side kill and spawn, deterministic compaction, indirect draw off a live count, and one cloud read three times by age (§V74, T322/T323, §V471.1) |
| [E10 Instanced Torus](./E10-Instanced-Torus.md) | lit 3D primitives on generated points via the edge payload; a driven component tumbles each primitive in place (§V197, §V198, §V113) |
| [E11 Gradient Remap](./E11-Gradient-Remap.md) | Ramp into Lookup: a multi-stop palette remapping an image by luminance; per-entry colour decode (T270, §V196) |
| [E12 Fluid](./E12-Fluid.md) | two temporal states — a velocity field carrying a dye; advection as a Displace; the pointer stirs both halves (§V182, §V236) |
| [E13 Prism](./E13-Prism.md) | the showcase: dispersion through three refractions, per-point colour, LFO → Lag, Mouse → Lag, an expression (T364, §V179, §V71) |
| [E14 Self-Regulating Bloom](./E14-Self-Regulating-Bloom.md) | the first CLOSED image → parameter → image loop (§V144, §V615): analyze meters the finished frame, channelIn subtracts it from a setpoint, and a P-controller with a measured loop gain of 0.7 rings, settles at its honest residual, and fights an LFO disturbance — with the open loop one valueSwitch away (T408, §V616) |
| [E16 Murmuration](./E16-Murmuration.md) | the SOP-chain showcase: generator → flock kernel → pointer kernel → instances; mixed §V197 ownership, by-reference tint across a node, draw-time group cull (T401, T333) |
| [E20 Gooeyball](./E20-Gooeyball.md) | the 2D→3D crossing: animated noise → per-point attribute → displacement along the normal → a closed surface whose seam is a topology claim (T417, T301/T302) |
| [E24 Audio Reaction-Diffusion](./E24-Audio-Reaction-Diffusion.md) | the capstone: audio-driven substeps (the beat makes the chemistry FASTER), safe-bounded feed/kill, a genuinely temporal RGB delay off three cache taps, wind inside the loop (T425, T414, T437) |
| [E25 Stage](./E25-Stage.md) | the multi-stage render: scene A filmed by an orbiting camera becomes a MATERIAL MAP on scene B's screen, filmed again to the output — a virtual screen inside a scene, everything driven (T444, T377, T428) |
| [E26 Interference](./E26-Interference.md) | one ring field read TWICE and subtracted from itself: nine nodes, no WGSL, no state, and a moiré whose structure is in neither input (§V6, T475) |
| [E27 Relief](./E27-Relief.md) | a picture LIFTED into geometry: 96,000 unlit points at 3D heights with per-point colour in the scene pipeline, and the UNDERSTUDY pattern — a synthetic performer plays on open while `webcam` stays in the plan and gets compiled (§V411, §V363, T478) |
| [E28 Sundial](./E28-Sundial.md) | a hard shadow travelling across a floor: one orbiting caster under a fixed raking key with `shadows` on, three standing stones, and a dusk sky worn as the render's environment — seen only in the specular sheen (T481, T482, T484) |
| [E29 Descent](./E29-Descent.md) | a neon square tunnel you fall into, born on the beat: scale ABOVE ONE inside a feedback loop, hue rotating per pass so depth reads as colour, and NO clock read in the picture path at all (T503) |
| [E30 Nave](./E30-Nave.md) | a fluted cathedral bore scrolling toward you and breathing on the kick — the audio-and-3D corner nothing else in the set filled, written on the ABSOLUTE clock so a timeline lap cannot touch it (T503, T489) |
| [E31 Corona](./E31-Corona.md) | the owner's own file, adopted as the BAR (§V471): one point cloud read THREE ways by group predicate — body, crests, tips — eight per-band gain/bias pairs, and a 29-second hue cycle. Read this one before writing an example (T538) |
| [E32 Pasture](./E32-Pasture.md) | the first example where the POINTS WRITE THE FIELD THAT STEERS THEM: five thousand animals deposit spore, a Gray-Scott reaction grows and divides it on its own, and the herd smells the reaction and grazes it back down. One cloud read FIVE ways, two of which are not pictures (T621) |
| [E33 Obol](./E33-Obol.md) | a yin-yang medallion melting into slick oil and re-forming, in an ambient studio: the morph is a per-point blend of TWO CONFIGURATIONS with a front that leaves the emblem's own dividing curve, so it reads as becoming rather than as a cross-fade — and the first example to switch on the render's AMBIENT OCCLUSION (T624, T625) |
| [E34 Lidar](./E34-Lidar.md) | a night survey: a ring of 240 rays, each AIMED BY AN ATTRIBUTE a kernel writes, sweeps a noise terrain — hot returns drape the relief, out-of-range dots hang where the beam gave out, and a SECOND chained Ray bounces off hitNormal for cyan echoes (T641, the Ray POP + reflection, lit by the T632/T636 environment stack) |
| [E35 Nova-Torus](./E35-Nova-Torus.md) | the owner's second file, Corona's sibling: a starred torus whose TUBE THICKNESS is the audio's way in (`radius2` ← lowMid, gated from pixels — muting the pattern thins the ring to under half its lit area), a noise-mottled palette read, and a 0.5 Hz hue shimmer against Corona's 29-second cycle (T660, §V471, §V624) |
| [E36 Facade](./E36-Facade.md) | projection-mapping PREVIZ: two projectors throw up a night facade — a scrolling warm gradient and an alignment chart whose overlap ADDS in the blend zone, aimed by LENS SHIFT rather than tilt so the rectangles stay rectangles, while a dentil cornice prints occlusion fingers on the wall above itself (T704: throw ratio, shift, additive beams, perspective occlusion) |
| [E39 Rosette](./E39-Rosette.md) | a video signal read in POLAR coordinates: a circular Ramp is theta, a Circle in distance mode is rho, Reorder packs them and Remap applies them — the polar warp is six existing nodes and not a missing primitive, with the petal count driven by the kick (T729, §V688, §V694) |
| [E40 Wake](./E40-Wake.md) | motion inferred by subtracting a picture from its own past: a Cache tap read as an INSTRUMENT rather than a delay, accumulated in a loop and graded AFTER it so the palette maps trail AGE — the first example whose subject is change itself (T729, §V687, §V694) |
| [E37 Sirocco](./E37-Sirocco.md) | the canonical TouchDesigner particle look, absent until now: eighteen thousand motes in a 3D CURL-NOISE field, each drawn as a VELOCITY STREAK — `beam` mode given `position − velocity·t` as its far end, so a fast mote draws a long ribbon and no history buffer exists. The first example to draw `geometry` in `points` mode (the mode §B132 repaired), the first consumer of T721's mapped `scale`, and a standing §V681 test: flipping the trail's sign gives every ribbon the wrong owner and moves the look baseline by 0.1% (T727) |
| [E41 Cinder](./E41-Cinder.md) | PARTICLES FROM VIDEO — the owner's ask verbatim: a moving subject SHEDS MOTES and a still one sheds none, off E40's frame-difference instrument reused as a SPAWN FIELD. One reorder packs source colour (rgb) with motion (alpha) so a single fieldAt answers where-and-what-colour; a recycling population is reborn where the picture moves, wears the video's live colour, and is sized by T721's mapped scale. The owner's sentence is asserted on frame pairs — grows while it moves, decays to exactly none when it parks (T741, §V681, §V717) |
| [E42 Current](./E42-Current.md) | the video as an ORIENTED FIELD — T723's first witness: a fixed grid of phong-lit tiles SPINS into the local flow and LEANS along it (the two turns COMPOSE, which is the quaternion's whole case), sized by T721 and tinted by the picture, under one raking key so orientation reads as SHADING. Calm means identity EXACTLY; the §V712 sign-flip turns every moving tile half around while the still-frame statistics move under 2% — asserted on the quaternion buffer itself (T741, §V683, §V712) |
| [E43 Splice](./E43-Splice.md) | the custom shader AS THE STAR — the VJ glitch rack: beat-quantised slicing (bands jump, blocks tear, RGB splits) in ONE customWgsl, folded by a rotating MIRROR (its first example — and the first Dawn compile of its shader, which found it had never compiled anywhere), slammed by a crop letterbox, echoed by a kick-driven composite. amount = 0 is BYTE-IDENTICAL passthrough — §V147 extended to user WGSL for the first time — and the glitch is frozen inside a deal, re-dealt across the tick (T749, §V681) |
| [E38 Sigil](./E38-Sigil.md) | the first example where a PICTURE decides which points belong to it, rather than what colour they are: `fieldAt` samples a drawn emblem at each grid cell and that number scales the spring that gathers the mote, so a mark assembles out of a drifting population and comes apart into it again. Membership is a property of the CELL — sampling where the mote IS instead takes 6528 members to 8302 while the look baseline does not move a digit (T727, §V681, §V684) |

## Running them

The gate lives in `src/examples/` and runs with the rest of the suite:

```
pnpm test           # everything
npx vitest run src/examples
```

It discovers the directory. Dropping a new `.loom.json` in here is the entire registration
step — there is no list to add it to.

- `runner.test.ts` — the §V89 gate: loads, compiles, reads the plan, replays a fixed frame
  sequence twice, and builds every plan on `vgpu/mock`.
- `temporal.test.ts` — §V22 for every example that closes a loop.
- `concepts.test.ts` — the specific claim each example's doc makes.
- `sync.test.ts` — these files are byte-identical to what the app's own save path writes.
- `component-sync.test.ts` — the same for `components/`, plus the §V89 gate on each.
- `examples.gpu.test.ts` — every example built on **Dawn**: the one place the WGSL an
  example ships is actually compiled. See "What the gate cannot check" below.

## `components/` — the starter component set

`components/` holds the shipped components (T190, §V94): FeedbackEcho, Bloom,
Kaleidoscope, DisplacementStack, MediaGrade. They are a **different library with a
different verb** — you *instantiate* a component, you *open* an example (§V93) — which is
why they sit in a subdirectory: `listExamples` and the browser's example glob both read
this directory non-recursively, so a component can never appear as a project to open.

Each file is a whole project: the definition under `componentLibrary`, plus a graph that
instantiates it between a source and an Output, so the shipped component comes with a
working demonstration of itself.

§V94 says a shipped component must be the same `GraphComponentDefinition` a user's own save
produces. So these are not constructed. `src/examples/starter-components.ts` drives the
real authoring commands — `component.saveSelection` over a selection in a real document,
then `component.publishParameter` inside a component session — and the result is saved
through `buildProjectFile`. Four of the five are authored out of the examples above,
because E1's echo loop and E4's threshold-blur-add already *are* the structures the
components are meant to be.

`component-sync.test.ts` regenerates the set and compares byte for byte, then loads,
installs and compiles every file the way §V89 gates an example.

## Editing an example

Do not hand-edit the JSON. Edit `src/examples/documents.ts` and regenerate:

```
node --import ./src/mcp/alias-hooks.ts src/examples/build-examples.ts
```

The bare `--experimental-strip-types` form does not work: the build script and everything
it imports resolve through the `@domain`/`@editor` path aliases, and only the loader hook
teaches Node about them. §T691 corrected three docblocks and missed this line, and a
second worker lost time to it a week later.

Five workers share this checkout, so regenerate only what your change touched:

```
node --import ./src/mcp/alias-hooks.ts src/examples/build-examples.ts --only Cinder
```

The files are written by `buildProjectFile`, the app's real save path, so a shipped example
can never be a shape the app would not itself produce. `sync.test.ts` fails if the two drift.

The same command regenerates `components/`; edit `src/examples/starter-components.ts` for
those.

## What the gate cannot check

There is no GPU in CI. "Renders deterministically" here means:

- the same bytes compile to a byte-identical plan every time;
- the shared frame block — the only route time takes into a shader — is a pure function of
  the frame index and the project seed;
- the real backend can construct every resource, shader module and pipeline the plan names,
  and stepping a fixed frame sequence issues an identical command trace twice.

It does **not** mean pixels. The mock device executes no shaders, so a readback returns
zeroes; comparing those images would be a test that looks like it verifies rendering and
does not. Pixel-level parity between browser and headless is the Dawn track's gate (§V47).

The WGSL an example ships **is** compiled, but only since `examples.gpu.test.ts` (T362):
before that, E2's Gray-Scott kernel had shipped for a week without any validator ever
looking at it, because the mock host does not compile shaders. That test builds every
example's plan on Dawn — which reflects each module, resolves every binding by name and
creates the pipelines — and steps six frames. Running the same file on both hosts is
§V280's rule: the mock proves the plan is constructible, Dawn proves the shaders are real,
and neither finds the other's bugs.

It checks **one** pixel property, deliberately, and only for E12: with the stirring force on
the dye reaches thirty-two times more of the frame than with it off. "It flows" is a claim
about pixels, and every other assertion in the suite is one a motionless fluid would also
satisfy (§V147, B15). There is still no reference-image comparison anywhere.
