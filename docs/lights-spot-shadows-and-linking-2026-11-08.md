# Lights: a spot that casts in one pass, and light linking (T1742b, T1743b)

**Date:** 2026-11-08. **Status:** DESIGN ONLY, nothing built; the build waits for the owner's review (section 9).
**Rows:** T1742b (a casting Spot is a Point light today), T1743b (generated surfaces are lit from both sides; no
light linking). **Cited:** V640, V426, V309, T301, B227, T481, T1285, T1362b, T1598b, T1623b, T1688b, T1589b
(`docs/lights-from-pointset-design-2026-10-06.md` section 3.4, ruling L3), T1622b.

## 1. The problem

The perfumery-bar previz (`projects/perfumery-pillar/`) is a room with a flat ceiling at 3.0 m, recessed
downlights (a Points-mode Spot Light, Cone 95°), two key spots (Cone 110°), people and stools. It needed shadows
under the downlights. Two engine limits got in the way, and the workaround was wrong:

1. **A casting Spot is a Point light.** With Cast Shadows on, `singleLightPayload` writes `type: "point"` for a
   spot, the lit block has no cone, and the Render sweeps a six-face cube (`CASTING_SPOT`, `lightSpotUnbuilt`).
   The README records "point lights that cast cost six passes each (14 fps in the editor)".
2. **So the previz used one directional sun for shadows**, standing above the ceiling. Generated surfaces are
   lit by `abs(dot(N, L))` (T301; V640), so the sun lit the ceiling's underside as if it were the top. The
   ceiling's colour was darkened to compensate, which is wrong at every other light. The sun is now gone and the
   shot has no shadow-casting light at all.

Shadows do not fix (2): the ceiling is the sun's first occluder, so its underside sits at the stored depth and
passes the bias. Lighting from both sides is the cause.

## 2. Loom today (read in the code at HEAD + worktree, 2026-11-08)

- **Light kinds.** `kind` Directional | Point | Spot is a VALUE (T1623b). Spot carries `cone` (full outer angle,
  default 60°) and `coneSoftness` (0.4). Mode Single | Points. **Only a Light in Single mode casts**
  (`pointsCastNothing`); a pointset's lights are rows of the Render's light table and never cast.
- **Two light paths in one lit shader.** Non-casting Single Lights and every pointset are ROWS of the light table
  (`scene-lights.wgsl.ts`; slices 1–4 of T1623b): a 64-byte record whose `aim.w`/`cone.x` hold a spot's outer and
  inner cosines, `cone.z` a shadow slot (written by nothing yet) and `cone.w` the SOURCE NUMBER, the Light's index in
  the Render's Lights list ("read by nothing yet (the lists, Lit Only and Lit Exclude, will test it)"). Casting
  Lights are still unrolled BLOCKS (`lightBlock` in `scene-render.wgsl.ts`). A block reads `lightNMeta` (kind,
  intensity, law, range) and `lightNVector`; **it has no aim and no cone.** Slice 5 (casting Lights become rows)
  is waiting for its first measurement.
- **Shadow slots and storage.** A casting light is a slot of one of two kinds. *Directional*: one orthographic
  sweep framed by Shadow Extent around Shadow Centre (`directionalShadowMatrix`). *Point*: six 90° sweeps into a
  3×2 atlas that stores radial distance ÷ range (`cubeShadowVariant`, `pointShadowFaceMatrices`). Since slice 4
  the maps are layers of two `r32float` arrays per Render. The directional array is 2× the output
  (`SHADOW_MAP_SCALE`), 31.6 MiB a layer at 1080p. The cube array is 1.5× (`SHADOW_CUBE_SCALE`), 17.8 MiB. Each
  array has one shared depth buffer, and its layer count steps 1, 2, 4, 8, then eights. A lit draw binds a 2D view
  per casting light, inside the cap of 16 sampled textures. **No resolution parameter exists: map size follows the
  Render's output**, so previews stay cheap.
- **Sweeps.** `emitDepthSweep` draws `castersBySlot` (Shadow Casters, less Shadow Exclude, by geometry node id;
  T1598b). Reach culling skips a bounded geometry per cube face for the current frame (`skip`, a per-frame value,
  `pointShadowFaceReaches`). Shadow On (T1688b) skips every caster draw as a value.
- **Lookups.** Directional: one matrix, no divide, PCF `(2r+1)²` taps (Shadow Softness 0–4, compile-time), bias
  `0.0015 + 0.012(1−λ)·(r+1)`. Point: pick a face, use its matrix, compare radial distance, with a bias in texels
  at the fragment (`2d ÷ tile`, T1362b). Both have Shadow Bias (world units, compile-time) on top. Outside the
  volume the light is unshadowed (V426).
- **Sidedness.** Generated surfaces (grids, `renderSurface`), the instances generator and projectors use `abs(N·L)`
  and an `abs` highlight, so they are lit from both sides at once (T301; V640). File meshes are the exception
  (B227). Their normal is turned to face the viewer (`faceViewer`), `lambert = max(N·L, 0)` and radiance is ×
  `sign(lambert)`, so they are lit from the viewer's side only. Environment irradiance faces the viewer in both
  paths. **The switch is `options.mesh === undefined`, so sidedness is tied to topology and nobody can choose it.**
  Projectors stay `abs` even on file meshes. I read that in the code and have not reproduced it.
- **Scope of a light.** The Render's Lights list is the only scope. **Lit Only / Lit Exclude** are designed and
  ruled but not built. They are lists on the Light that light only (shadow lists stay separate), resolved per
  Render (design section 3.4, ruling L3). T1623b ruled one mechanism for them, "the record's source number against a
  mask on the draw, so editing a list stops being a recompile".

## 3. How the references do it (read by two surveys, 2026-11-08)

**TouchDesigner.** Light COMP (https://docs.derivative.ca/Light_COMP): `lighttype` point | cone | distant;
`coneangle`, `conedelta`, `coneroll`. Shadows "render the scene in a depth-only pass to create a shadow map";
`shadowtype` Off | Hard, 2D Mapped | Soft, 2D Mapped | Custom; `shadowresolution1/2` (width, height, per light);
`shadowcasters` (pattern, default `*`, https://docs.derivative.ca/Rendering_Shadows); soft params `lightsize1/2`,
`maxshadowsoftness`, `filtersamples`, `searchsteps` (a blocker search, PCSS-like: *inferred*); bias by
`polygonoffsetfactor`/`polygonoffsetunits`. The frustum is the light's View page; `useconeforfov` "sets the FOV
using the Cone Angle and Cone Delta" for a cone light, and `near`/`far` apply there. Not documented: whether a
point light uses a cube. Light linking is on the **Geometry COMP**: `lightmask` "specify a sub-set of lights to be
used for this particular geometry" (https://docs.derivative.ca/Geometry_COMP). Camera COMP has `camlightmask`
(https://docs.derivative.ca/Camera_COMP). The Render TOP's `lights` takes patterns
(https://docs.derivative.ca/Render_TOP, https://docs.derivative.ca/Pattern_Matching). Sidedness is per light
**and** per MAT: `frontfacelit` / `backfacelit` offer Front Lit | Back Lit, and the MATs add Use Per-Light
(https://docs.derivative.ca/Phong_MAT, https://docs.derivative.ca/PBR_MAT). The back-face normal rule is not
documented. Shadow strength and colour are on the MAT.

**Notch.** Spot Light (https://manual.notch.one/latest/en/docs/reference/nodes/lighting/spot-light/): `Light Cone
Angle`, `Light Inner Cone Angle`, `Penumbra Falloff Power`; shadows are `Casts Shadows`, `Shadow Softness` and `Z Bias`
only. Resolution is **renderer-wide**: `Shadow Map Resolution` "for all the shadow casting lights in the scene"
(https://manual.notch.one/latest/en/docs/reference/nodes/rendering/standard-renderer/). The Hybrid Renderer adds
Raytraced | Shadow Maps | Off per light class, and "further away lights use lower shadow map resolutions"
(https://manual.notch.one/2026.1/en/docs/reference/nodes/rendering/hybrid-renderer/). Linking is by node inputs on
every light: `Affected Nodes` ("by default, all are affected") and `Excluded Nodes`. The docs do not say whether
these lists gate shadows. Sidedness is on the **Material**: `Polygon Sidedness` Front | Back | Double Sided, plus
`Invert Normals` (https://manual.notch.one/latest/en/docs/reference/nodes/materials/material/).

**Engines.** three.js renders one `PerspectiveCamera` per spot shadow, `fov = 2·angle·focus`, with `focus` default
1 (https://threejs.org/docs/pages/SpotLightShadow.html, source `src/lights/SpotLightShadow.js` r170). Unreal has 3
**Lighting Channels**; a light affects an object when their channels overlap
(https://dev.epicgames.com/documentation/en-us/unreal-engine/using-lighting-channels-in-unreal-engine). Unity HDRP
has **Rendering Layers**, and Custom Shadow Layers separates casting from lighting
(https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/Rendering-Layers.html).
**Two-sided means "flip the normal to the side you see", never `abs`.** Unreal: "the normal is flipped on back faces"
(https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-material-properties). Unity offers Flip,
Mirror or None (https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/Double-Sided.html).
three.js `DoubleSide` does `normal *= gl_FrontFacing ? 1 : -1` (source `normal_fragment_begin.glsl.js` r170).
Loom's B227 rule is that convention. T301's `abs` is the outlier: it lights a sheet as if it were thin and
translucent.

### 3.1 Comparison

| | TouchDesigner | Notch | Loom today | Loom proposed |
|---|---|---|---|---|
| Spot shadow | one depth pass from the light (read); one 2D map (*inferred* from "2D Mapped") | Casts Shadows on the Spot (read) | a cube: six 90° sweeps, and the light loses its cone | one perspective sweep, FOV from the cone, cone kept in the lit block |
| Frustum | View page, `useconeforfov`, near/far (read) | not documented | — | FOV = Cone + a PCF margin, capped at 120°; far = Shadow Extent |
| Resolution | per light, w × h (read) | one value for all lights, in the renderer (read) | a share of the Render's output per kind | per light: Auto (today's share) or 512–4096 square |
| Softness / bias | PCSS-like light size and samples; polygon offset (read) | Shadow Softness; Z Bias (read) | PCF radius; texel bias + Shadow Bias | the same knobs; the spot bias in texels at the fragment |
| Caster lists | `shadowcasters` on the light (read) | not documented | Shadow Casters / Exclude on the light | the same; reach culling by cone |
| Light linking | `lightmask` on the Geometry (read) | Affected / Excluded Nodes on the light (read) | none (only the Render's Lights list) | Lit Only / Lit Exclude on the light (ruled L3), as a value mask |
| Sidedness | Front Lit / Back Lit per light and per MAT (read) | Polygon Sidedness on the Material (read) | fixed by topology: generated `abs`, file mesh faces the viewer | Lit Sides on the Geometry: Auto / Both / Facing Viewer |
| Lights of a set cast | — (lights are not instanced) | clones cast, sized by distance (read) | no | no (T1622b) |

## 4. Proposal for T1742b: a Spot that casts in one pass

**Shape.** A casting Spot is a third **slot kind** beside directional and point. Kind already decides a casting
light's structure (one sweep or six), so a third kind is the same rule. One perspective sweep a frame:

- **Frustum.** The eye is Position and the axis is the normalized Direction. Up is world Y, or Z when the axis is
  vertical (the `directionalShadowMatrix` rule; a circular cone does not care about roll). The aspect is 1.
  `FOV = 2·atan(tan(Cone/2) · side ÷ (side − 2(r+1)))`, so the cone's edge stays `r+1` texels inside the map and no
  PCF tap reads past it. **Capped at 120°** (`SPOT_SHADOW_MAX_CONE`): past it a texel at the edge is ≥ 4× the
  centre's footprint. Outside the frustum the light is unshadowed (V426) and the Light warns by name
  (`node.scene.spotShadowCone`). Cone stays a VALUE: the matrix is a uniform each frame. Near is
  `max(0.01, far·0.002)` and far is Shadow Extent, as for a point light.
- **Depth shader: no new text.** The sweep uses `cubeShadowVariant` with an identity tile `(1, 1, 0, 0)` and
  stores radial distance ÷ range, which is a cube face's own module and pipeline.
- **Lookup** `spotShadowFactorWgsl(slot, r, bias)` is shared verbatim by the surface and instances generators, as
  `shadowFactorWgsl` is. It takes `shadowSMatrix` with a perspective divide; outside `[0,1]²` or beyond the range
  it is unshadowed; PCF `(2r+1)²`. The bias is T1362b's texel rule with the spot's texel:
  `texelWorld = 2·d·tan(FOV/2) ÷ side`. The new uniform is `shadowSSpot` (x = `tan(FOV/2)`), beside
  `shadowSLight` (position, range).
- **The cone in the casting block.** A spot slot's block gets `lightNAim` (axis, outer cosine) and `lightNCone`
  (inner cosine) and multiplies radiance by the walk's own smoothstep share. That expression is exported once from
  `scene-lights.wgsl.ts` so a row and a block cannot disagree. `CASTING_SPOT`, `lightSpotUnbuilt` and the payload's
  spot→point mapping go away.
- **Storage.** A third layered array per Render, `shadowSpots`, with **square** layers. The layered scratch request
  gains an absolute `side`, so this is engine work in `ScratchLayersRequest` and the compiler's allocation.
- **Parameters.** Shadow Softness, Shadow Bias, Shadow On, Shadow Casters / Exclude apply unchanged. Shadow Extent
  is the shadow range, and its description gains "Spot". Shadow Centre stays inactive. **Shadow Resolution** is new
  on every casting Light, an enum: Auto (default) | 512 | 1024 | 2048 | 4096. Auto keeps today's sizes (directional
  2×, cube 1.5×) and for a spot is a square of the output's short side, so previews stay cheap. An explicit value
  is a square of that side (a cube's tile is that side). Arrays are grouped by `(kind, side)`, so one Render holds at
  most 3 × 5 arrays. Each casting light still binds one 2D view, so the cap of 16 is unchanged. Changing it
  rebuilds (compile-time).
- **Interactions.** Reach culling gets `spotShadowReaches(position, axis, FOV/2, range, sphere)`: out of range, or
  wholly outside the cone (`angle(axis, centre) − asin(radius ÷ d) > FOV/2`). It is conservative, decided per frame,
  and a bound-less geometry is always drawn (T1598b). Light Depth output (T1417b) renders the spot's one sweep at
  the port's size. The shadow matte (T1414b) reads the slot's factor. Points mode is unchanged: a pointset spot
  does not cast. **T1622b (shadow slots for a pointset's nearest lights) will use exactly this slot**, so the
  perfumery's 95° downlights can cast without N named Lights. The instances generator still takes no cone for any
  spot (`lightSpotDraw` stays, T1623b slice 7).
- **Under T1623b slice 5** (casting Lights as rows), the row's slot carries the same matrix, the same `side` and
  the same lookup function. Slice 5 moves where the uniforms are read from, not the slot. This design adds a slot
  kind slice 5 must cover, and nothing it must undo.

## 5. Proposal for T1743b: sidedness first, then linking

The two tools answer different questions, and the ceiling needs the first one. **Lit Sides** says which side of
a surface a light can reach: that is physics, for an opaque sheet. **Lit Only / Lit Exclude** says which lights
touch an object: that is art direction, such as a key reserved for the hero. Excluding the sun from the ceiling
would have fixed one surface and missed every wall the sun reaches from outside.

**5.1 Lit Sides, on the Geometry.** Values Auto | Both | Facing Viewer, default Auto, compile-time.
- *Auto* is today's rule, byte for byte: a file mesh faces the viewer (B227); a grid, the instances generator and
  projectors use Both (T301).
- *Both* is `abs(N·L)` and `abs(N·H)`, lit from both sides at once (V640 holds under it).
- *Facing Viewer* is B227's rule (`faceViewer`, `max(N·L, 0)`, radiance × sign), applied to every direct term the
  draw has: blocks, table rows, the instances generator's blocks and **projectors**. The environment is unchanged
  (it already faces the viewer).
- In the generators, `options.mesh` stops meaning "one-sided". A new `sides: "both" | "viewer"` is resolved from
  the Geometry, so Auto emits today's text (V309).
- Why on the Geometry and not the Material: Auto depends on topology; one plaster material dresses both a wall
  (one-sided) and a hanging banner (Both); and per-object variants already live there (Shadow Only, Material
  Overrides). TD has this on the light and the MAT, Notch and the engines on the material (decision D4).
- **Is the per-geometry option needed? Yes.** It is the fix for the ceiling: set Facing Viewer on the room's
  surfaces and nothing above the ceiling lights its underside. That holds for any light, casting or not, and needs
  no list.

**5.2 Lit Only / Lit Exclude, on the Light (as ruled, L3).** These are name lists registered as source
references, in both modes, beside the shadow lists. The lit set is the Render's geometries, kept if Lit Only is
empty or names them, less Lit Exclude; exclude wins. They gate lighting only: an unlit geometry still casts if the
shadow lists say so (TD and Unity keep the two apart, and Notch does not document it). A list that leaves none of a
Render's geometries gets a warning (`node.scene.litGeometry`). A rename rewrites the lists; a dangling name refuses.
- **Mechanism (T1623b's ruling).** Each lit draw carries `litMask: vec4u`, a bit per source number (128 sources;
  past that a Render with a list refuses by name). The walk tests `cone.w`'s bit before reading a row's colour. A
  casting block tests its own source's bit. The mask is a value, so editing a list re-runs the compile for the new
  references but creates no shader module and no pipeline. The test is in the text **only in a Render where some
  Light has a list**, so every shipped Render keeps its text (decision D5).
- **Not chosen.** A per-geometry Light Mask (TD) is the same data from the other end; two writable ends need a
  precedence rule. Channels or layers (Unreal 3, Unity 32) add a vocabulary that renames cannot follow. A Geometry's
  inspector can show the lights that reach it, read-only and derived (follow-up).

**Composition.** A light reaches a fragment iff the light is linked to the draw, **and** (Sides = Both **or**
`N_v·L > 0`), **and** the fragment is unshadowed. Each factor is exact 0 or 1 except the shadow's PCF, so the
order does not matter.

## 6. Cost

| Per casting spot, 1920×1080 output | Today (as a point) | Proposed |
|---|---|---|
| Sweeps a frame | 6 face sweeps (reach-culled per face) | 1 (cone-culled) |
| Caster triangles drawn | up to 6× | 1× |
| Map texels / bytes | 2880×1620 atlas, 17.8 MiB | Auto 1080², 4.5 MiB; 1024², 4 MiB (+ one depth per array) |
| Lit lookup | face pick, 6-way switch, PCF | one matrix, one divide, PCF |
| Lit cone | none: it lights every direction | one dot and a smoothstep |
| Sampled textures | 1 of 16 | 1 of 16 |

T1604b already merges a sweep's draws into one device render pass. What drops is triangle work and fill, not
encoder passes. **Perfumery projection, six casting downlights:** 36 face sweeps become 6 and about 107 MiB of
atlas becomes about 27 MiB. These figures are arithmetic, not measurements. The frame figure must be measured in
the build by the reference-pass rule (§V86), alternated against main. **Lit Sides** costs nothing (`max` for
`abs`, one multiply). **Linking** costs nothing in a Render without lists. With lists, it is one uniform per draw
plus a bit test per walked row and block, measured in the build against the same Render without lists.

## 7. Migration and compatibility

- The new parameters are `shadowResolution` (Auto), `sides` (Auto), `litOnly` and `litExclude` (empty). Saved
  documents store only non-default values, so no shipped `.loom.json` changes. **The node versions and the document
  schema do not move, and there is no migration step.**
- No shipped example has a casting point or spot light. All 11 casting Lights in `examples/` are directional, so
  the spot slot cannot move a shipped picture. Auto keeps every sweep's size and every lit text (V309).
- The spot's own behaviour changes: a casting spot that lit everything now has a cone. That is the fix, and the
  diagnostic that announced the old behaviour goes. In the repo only `projects/perfumery-pillar` and
  `projects/sentinel-bot` have spots, and none of them casts.

## 8. Test plan (Dawn, exact; each claim red-verified by the edit named)

1. **One sweep, a cone.** A spot straight down at a floor, Cone 60°, a plate 0.5 m below it. (a) The plate's shadow
   reads the ambient byte exactly. (b) A floor pixel outside the cone reads ambient exactly (red against today's
   `CASTING_SPOT`, and against a block with the share deleted). (c) An open pixel inside the inner cone equals the
   same Light with Cast Shadows off: the row path and the block path agree. (d) The plan has one sweep under
   `shadow:<i>`, and six for Type: Point. (e) Cut the plate (Shadow Exclude it) and (a)'s pixel equals (c)'s.
2. **The frustum follows the cone.** A caster at 50° off the axis of a 110° spot shadows the floor (red with a fixed
   90° FOV). Driving Cone moves the shadow with no module or pipeline created (mock host device-call gate). A 150°
   spot warns, and a pixel past 120° is unshadowed and lit.
3. **Density and PCF.** A straight edge's penumbra is a monotone ramp `2r+1` spot texels wide, so its width in
   screen pixels halves from 512 to 1024 (T1285's form: a merely dimmer shadow fails it). There is no artefact at
   the cone's rim at r = 4 (red with the PCF margin removed).
4. **Bias.** T1362b's claim as a spot: a lamp 0.95 m under a 10 cm plate, Extent 80 m, on a wall facing the lamp,
   reads ambient behind the plate (red with the bias as a share of the range).
5. **Reach culling.** A caster wholly outside the cone is `skip: true` this frame, and the picture equals the one
   with it excluded, byte for byte. A caster just inside the rim is drawn and shadows (the case the guard could
   swallow).
6. **Shadow On off** equals Cast Shadows off for a spot, byte for byte, and is not stale on return (T1688b). The
   Light Depth port holds one perspective map.
7. **Lit Sides.** The literal perfumery repro is a grid ceiling, a sun above it, and a camera below. The underside
   reads lit under Auto (red today), and under Facing Viewer it reads the ambient byte exactly with no PBR highlight
   (red with `abs`, and with `sign` removed). Seen from above, the top is the exact lambert. A file mesh set to Both
   reads its back at the front's lambert, as a grid does. A projector on a Facing Viewer back face lights nothing.
8. **Linking.** This is design section 3.4's acceptance, for a block, a row and a pointset source. An excluded
   geometry equals the Render without that light; its neighbour equals the Render with it; the excluded one still
   casts that light's shadow on the neighbour. Also covered: Lit Only alone; a rename; a dangling name refusing; the
   empty-set warning; a list edit creating 0 modules and 0 pipelines; and a Render with no list keeping its text.
9. **Byte identity.** The 27 shipped casting Renders (T1688b's landing set), frames 0 and 60, against clean main: 0 values differ. Lit-text
   fingerprints are equal for every Render with no spot slot, no list and Sides Auto. `FRAME_ZERO_DIGESTS`, `sync`
   and `doc-drift` are unchanged. `test:gates` and `pnpm build` run once.

## 9. Decisions for the owner, and risks

- **D1. When to build T1742b.** *Recommended:* now, on the casting blocks, as a third slot kind whose matrix, side
  and lookup slice 5 takes unchanged. *Alternative:* inside T1623b slice 5, which is waiting on a measurement.
  *Risk:* slice 5 has one more slot kind to carry.
- **D2. Wide cones.** *Recommended:* cap the map at 120°, leave the light unshadowed outside the cap, and warn; a
  wider casting light is a Point. *Alternative:* above 120°, use the cube with the faces outside the cone skipped.
  That makes Cone structural at the threshold.
- **D3. Shadow Resolution.** *Recommended:* per light, Auto plus absolute squares, for all three kinds in this row.
  *Alternatives:* spots only; or one value per Render (Notch). *Risk:* an explicit 4096 in a preview tile is paid
  in full. One option is clamping explicit sizes to 2× the output's short side.
- **D4. Where Lit Sides lives.** *Recommended:* the Geometry. *Alternatives:* the Material (Notch and the engines),
  or the Light as well (TD).
- **D4b. Projectors under Auto on a file mesh** stay `abs` today. *Recommended:* Auto keeps it, so pictures are
  unchanged; file a bug row with a repro first.
- **D5. The linking mask in the text.** *Recommended:* only in a Render with a list. *Alternative:* always, like
  T1623b's D1 for shadows, so the first list compiles nothing; the price is re-stamping every fingerprint and
  measuring the walk.
- **D6.** Confirm L3: lists on the light only, lighting only, no Light Mask on the Geometry, no channels.
- **D7.** Should generated surfaces ever default to Facing Viewer? *Recommended:* not in this row. It would move
  V640 and pictures, so it gets its own row and picture review if wanted.
- **Open.** Whether TD's `backfacelit` flips or mirrors the normal is not documented. Whether Notch's Affected
  Nodes gates shadows is not documented. The 120° figure is geometry, not a measurement on a real shot.

## 10. Rows to file (the next free id at writing is T1746b; take numbers at filing)

1. The build of section 4 under T1742b, and of 5.1 then 5.2 under T1743b. 5.2 closes design slice 3 of T1589b
   (Lit Only / Lit Exclude).
2. If D2 is the cap: wide casting spots through the cube, with the faces outside the cone skipped.
3. If D3 is spots only: Shadow Resolution for directional and point lights.
4. B-row: a projector lights a file mesh's far side (`abs` beside B227), with a repro first.
5. A Geometry inspector row showing the lights that reach it, derived from the lists, read-only.
6. Soft shadows by light size (TD's `lightsize`/`searchsteps`, PCSS) beside PCF.
7. Lit lists for Projectors once they are rows (T1623b slice 6).
8. V-invariant: one sidedness rule for every direct term of a draw (blocks, rows, instances, projectors, matte).
   V640's text gains "under Lit Sides: Both".
