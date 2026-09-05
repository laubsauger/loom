# Shader composition: what vgpu's `triangle-led-front` actually does, and what we would need — T1186

**Study and design proposal. Nothing here is integrated; no composition mechanism was built.**

---

## Recommendation

**Components plus a small shared-function prelude gets ~90% of this, and a user-authored include graph is not worth building.** The owner's expectation holds and holds precisely: of vgpu's eight shaders, **four are shared functions with no standalone pass meaning** (14% of their WGSL bytes), two of the remaining four passes are things we already ship as nodes (`noise`→`cache`, `renderPoints`/`renderInstances`), one is irreducibly custom, and the biggest one is a megashader whose seven jobs are ~five nodes we already have. The decisive counter-evidence to "modularity would have made our 10,946-character shader smaller" is that **their largest shader is 15,546 characters — 42% bigger than ours — despite having the import mechanism available**, and two of their four passes duplicate the shared triangle-SDF helper rather than importing it. Imports are not what makes a shader small; decomposing it into passes is, and our compiler already does the pass orchestration that they hand-wrote in 340 lines of `scene-renderer.ts`. The second half of the ask — "wrap stuff around these shader groups so we can have a clean driving surface" — **ships today and is already exercised**: `timeGrid` is a 19-node component containing a `customWgsl`, publishing 13 knobs, three of which drive multiple internal targets. The one genuine gap is narrow: **a user's `customWgsl` cannot reach the shared-function library we already maintain for built-in nodes** (`src/nodes/shaders/common.wgsl.ts` — luma, channel select, extend modes, HSV, deterministic hash, 2D transform). Closing it is a versioned prelude prepended in the backend *after* `planStructureKeys`, which leaves reflection, T1184's declared defaults and the plan structure signature untouched by construction, and costs exactly two things: one constant line-number offset in `shader-diagnostics.ts`, and one new T1059-shaped collision class (author writes `fn luma`, prelude already has one) that must be paid for up front with a reserved `loom_` prefix and a named diagnostic. On T1184: **do not reopen it — the evidence strengthens it.** `settings.ts` is not a declarations file, vgpu ships no separate-declarations convention to conform to, and their README's stated idiom is the opposite ("reflection keeps binding names, types and layouts correct *without hand-written declarations*"), which is exactly what T1184 landed.

---

## 1. What was pulled, and its licence

```
npx vgpu examples pull triangle-led-front --out ./triangle-led-front
```

Pulled into the session scratchpad only (`scratchpad/triangle-led-front`), never into the repo. **Nothing from it is committed or vendored.**

- **Licence: MIT**, `Copyright (c) 2025 Vercel, Inc.` (`node_modules/vgpu/LICENSE`), repo `vercel-labs/vgpu`, author Matias Gonzalez. `vgpu` 0.3.1, pinned.
- Pull manifest: revision `69160a12…`, 17 files, 91,317 bytes, aggregate sha256 `81a1bf85…`.
- The quoted fragments below are short and cited for a design point. MIT permits redistribution with the notice attached, but copying source into this tree would be redistribution and we have no reason to do it.

> ⚠ **Citation correction, surfaced rather than smoothed over.** The brief cited §V858 as "this project does not redistribute other people's code." §V858 actually says close to the opposite in its own domain — it is the owner's ruling that *runtime download is not redistribution*, and that the previous licence rule was over-broad. The practical conclusion (do not copy vgpu's files into our tree) is right, and §V858's own test supports it: MIT's terms attach to distribution, and putting these files in our repo would be distribution. But §V858 is not a blanket no-vendoring invariant, and I am not going to cite it as one.

### File inventory (17 files)

**WGSL — 8 files, 32,024 bytes, 760 lines**

| File | Bytes | Lines | Role |
|---|---:|---:|---|
| `shaders/hash.wgsl` | 104 | 3 | One exported function: `hash21`, the `fract(sin(dot(…)))` trick. |
| `shaders/geometry.wgsl` | 737 | 18 | Triangle SDF from three vertices, plus a private segment-distance helper. |
| `shaders/floor-falloff.wgsl` | 1,435 | 41 | Three exported art-direction curves: `value_map01`, `near_falloff`, `far_falloff`. |
| `shaders/color-utils.wgsl` | 2,270 | 56 | Seven exported functions: OkLab in/out, Lottes tonemap, linear→sRGB, scalar remap ×2. |
| `shaders/floor-noise.wgsl` | 582 | 20 | **Pass.** Fullscreen triangle; three octaves of `hash21` → a 500×500 grain texture, baked once. |
| `shaders/led-emitters.wgsl` | 2,572 | 71 | **Pass.** Instanced quads over a 72-LED storage buffer; triangle-SDF clip; writes emitter RGB. |
| `shaders/direct-triangle-raycast.wgsl` | 8,778 | 215 | **Pass.** 24-ray angular sweep per pixel against the triangle's arc, analytic ray/segment hits, IGN jitter, Beer-Lambert falloff → half-res radiance. |
| `shaders/themes/dark/main-scene-floor.wgsl` | 15,546 | 336 | **Pass.** The megashader: cubic upsample, jittered resample, LED surface mask, OkLab blend, two-layer glow, tonemap, contrast, occluder, edge fade. Renders straight to canvas. |

**TypeScript — 9 files, 59,293 bytes, 1,984 lines**

| File | Bytes | Role |
|---|---:|---|
| `led-buffer.ts` | 17,372 | Per-frame CPU animation of 72 LEDs: line sweeps, hover deploy, RGB tint, brightness envelopes. **The largest file in the example, and not a shader.** |
| `scene-renderer.ts` | 10,972 | Hand-wired pass orchestration: creates targets, `draw()`s, bundles, and the per-frame `frame.pass(…)` sequence. Packs all uniform data. |
| `renderer.ts` | 9,285 | Surface/clock/frame loop, lil-gui debug panel, pointer input. |
| `light-sources-raw.ts` | 8,452 | Builds the LED emitter mesh + storage buffer; owns the `led-emitters` pass. |
| `settings.ts` | 7,706 | Scene constants, typed default objects, CPU triangle/LED layout math. See §3. |
| `hero-frame-state.ts` | 2,987 | Per-frame state resolution: smoothing, hover, mode transitions. |
| `sim-sizing.ts` | 1,577 | Simulation-resolution floor and pointer→sim-space mapping. |
| `index.tsx` | 591 | React canvas mount. |
| `types.ts` | 351 | A four-value mode union. |

**65% of the example by bytes is TypeScript.** The framing "a total of 8 shaders" is accurate but the shaders are the smaller half, and the biggest single file is CPU animation logic.

### The module system, measured

vgpu's WGSL dialect has real `import`/`export`:

```wgsl
// floor-noise.wgsl
import { hash21 } from "./hash.wgsl";
```
```wgsl
// main-scene-floor.wgsl
import { col3v, oklab_to_rgb, tonemap, value_remap_clamp } from "../../color-utils.wgsl";
import { sdf_triangle_vertices } from "../../geometry.wgsl";
import { near_falloff, far_falloff } from "../../floor-falloff.wgsl";
```

Across the whole example: **12 exported functions, 4 import statements, 3 of them in one file.** And the two facts that matter most:

1. **The mechanism did not shrink the big shader.** `main-scene-floor.wgsl` imports seven functions and is still 336 lines / 15,546 characters — larger than the 10,946-character `source` string that prompted the owner's complaint (T1184).
2. **Two of their four passes do not use it.** `led-emitters.wgsl` and `direct-triangle-raycast.wgsl` each re-implement `segment_distance` and a triangle inside/outside test locally instead of importing `geometry.wgsl`. In a hand-tuned flagship example, with the mechanism present and free, half the passes duplicate the shared helper anyway.

**And the mechanism is build-time, not runtime.** From the vgpu README:

> Imports resolve at build time through typed WGSL reflection — no codegen step and no manual binding declarations to keep in sync.

The `.wgsl` files are `import`ed into TypeScript and arrive at `draw()` as an already-linked string. The package's runtime entry for shader text is `toWgsl()` (`dist/shader-source.js`), which accepts only a `string` or a `{ version: 1, wgsl: string }` loader artifact — **there is no linker in the shipped package**. Loom's shader text comes out of a `.loom.json` document at runtime and is edited live in a CodeMirror pane. We could not adopt their mechanism if we wanted to; we would be building a different one that merely resembles it.

---

## 2. Question 1 — how much of it is already a graph of nodes in our idiom?

Our catalogue: **104 registered node types**.

| # | Their shader | Kind | Loom mapping | Verdict |
|---|---|---|---|---|
| 1 | `hash.wgsl` | shared function | `WGSL_HASH` in `src/nodes/shaders/common.wgsl.ts` — **we already have this, and better**: an integer PCG finaliser, because §V45 requires the same seed to give the same pixels on any GPU. Their `fract(sin(dot(…)))` is the exact construct our own comment rejects as transcendental-precision dependent. | **shared function — already ours** |
| 2 | `geometry.wgsl` | shared function | Nothing. `circle` and `rectangle` have signed-distance output modes; there is **no triangle or polygon SDF** anywhere in `src/nodes/`. | **shared function — genuinely missing** |
| 3 | `color-utils.wgsl` | shared functions | Splits three ways. `tonemap`/`linear_to_srgb_pow` → the `output` node's `toneMap` parameter (`reinhard`, `filmic`; `compileTime: true`, so the operator swaps the shader). Lottes specifically is not shipped. `value_remap`/`value_remap_clamp` → `valueMath` op `range` + `valueLimit` for scalars, `level`/`limit`/`lookup` for images. OkLab → nothing; zero `oklab` hits in the repo. | **⅔ already nodes, ⅓ missing function** |
| 4 | `floor-falloff.wgsl` | shared functions | This is T880's complaint in someone else's code. The functions are generic; the **art direction is passed as literals at the call site inside `main-scene-floor`'s `fs_main`** — `near_falloff(…, vec4f(0.046, 1.2, 2.74, 5.0), 4.0, 1.0)`, `far_falloff(…, vec4f(0.65, 2.0, 0.0, 8.85), 0.05, 1.0)`. Eleven tuned numbers with no names, reachable only by editing WGSL. In our idiom: a `ramp`→`lookup` or `level`+`limit` chain, or reflected `struct Params` knobs published on a component. | **shared function, but the values want to be nodes/knobs** |
| 5 | `floor-noise.wgsl` | **pass**, baked once | `noise` (type `random`) → `cache`. Their bake is a `frame(gpu, cb)` fired once at construction into a 500×500 `rgba16float` target; ours is the same shape. | **already a node** |
| 6 | `led-emitters.wgsl` | **pass**, instanced | `pointLine`/`pointGenerator` per edge → `pointKernel` for the animation → `renderPoints` (soft billboarded sprite quads, per-point colour from an attribute) or `renderInstances`. Their 580-line `led-buffer.ts` CPU animation becomes a point kernel plus `lfo`/`valueMath`/`valueLag` value nodes. | **already a node family — and we'd move their biggest TS file onto the GPU** |
| 7 | `direct-triangle-raycast.wgsl` | **pass**, novel | `customWgsl`. An angular-interval ray sweep with analytic ray/segment intersection and interleaved-gradient-noise jitter is not a node and should not be one. | **irreducibly custom — the residue** |
| 8 | `main-scene-floor.wgsl` | **pass**, megashader | Seven jobs. Cubic BC-spline upsample → closest is `blur`, but the kernel differs (custom). Jittered second tap + hash blend → custom. LED surface mask (`smoothstep` on max channel) → `threshold`. OkLab blend toward LED colour → missing helper. Two-layer screen blend + overflow split → `screen` + `add`. Tonemap ×0.25 + contrast 1.05 → `level` + `output.toneMap`. Triangle occluder from the SDF → `mask` (needs the missing triangle SDF). Vertical edge fade → `ramp` (vertical) → `multiply`. | **~5 of 7 jobs are nodes we ship** |

### Tally

- **4 of 8 are shared functions** with no standalone pass meaning — 4,546 bytes, **14% of their WGSL**. Of those four: one we already have and do better (hash), one we half have (remap/tonemap), two are genuinely missing (triangle SDF, OkLab).
- **2 of 8 are passes we already express as nodes** (floor noise, LED emitters).
- **1 of 8 is irreducibly custom** (the raycast).
- **1 of 8 is a megashader that decomposes ~70% into shipped nodes.**

**The owner's stated expectation is confirmed, and the falsification test he asked for does not fire.** Several map onto nodes we ship; the residue is shared *functions*, not shared *passes*. The one genuinely novel pass is one shader, which is what `customWgsl` is for.

The sharper reading is that **we are ahead of them on the half the ask was really about.** Their `scene-renderer.ts` is 340 lines of hand-written target creation, bundle recording and per-frame `frame.pass(…)` sequencing — the thing our compiler generates from a graph. "Shader files that can be stored and edited separately and then get organised and orchestrated in the pipeline" describes our compiler more accurately than it describes their code, where the orchestration is a hand-maintained TypeScript function.

---

## 3. Question 2 — what `settings.ts` actually is, and T1184

**`settings.ts` is not a declarations file for shader values.** 290 lines of TypeScript containing:

- ~20 scene constants (`LEDS_PER_EDGE = 24`, `TRIANGLE_HEIGHT_RATIO`, `LED_RADIUS_TO_TRIANGLE_HEIGHT`, `LED_MESH_INSET_PX`, …)
- 4 typed default objects (`HERO_STATE_DEFAULTS`, `DEFAULT_BRUSH`, `TUNABLE_DEFAULTS`, `HOVER_RGB_TINT_DEFAULTS`)
- 8 interfaces (`RenderSize`, `TriangleGeometry`, `BrushState`, `SceneTunables`, …)
- ~10 pure functions doing **CPU triangle and LED layout math** — `canonicalTriangleGeometry`, `triangleEdgeLedLayout`, `ledMeshGeometry`, `scaleTriangleGeometry`
- module-level mutable state: `let heroSceneScale = 1` with a `setHeroSceneScale` setter

**It contains zero references to any shader's uniform fields.** Nothing in it names a WGSL struct member. It is the analogue of our `src/examples/documents/*.ts` plus the CPU half of a node definition — not of a parameter schema.

Worse, from our point of view: **their shader uniforms are anonymous `vec4f` packs.** `struct Config { resolution: vec2f, tunables: vec4f, triangle: vec4f, led_clip: vec4f }`; `size_steps: vec4f`; `params: vec4f`. What `cfg.params.y` means is knowable only by counting positions in `directTriangleRaycastUniformData()` thirty lines away in `scene-renderer.ts`, where the array literal happens to be in the right order. There is no name, no type beyond `vec4f`, no default, and no reflection. Our reflected `struct Params` with a trailing `//` note is **strictly more self-describing than anything in this example.**

### What this means for T1184

**vgpu has no separate-declarations convention, so there is nothing for Rule 7 to conform to across the dependency boundary.** And where vgpu does state an idiom, it points the same way T1184 landed — the README, twice:

> reflection keeps binding names, types, and layouts correct **without hand-written declarations**

> Imports resolve at build time through typed WGSL reflection — no codegen step and **no manual binding declarations to keep in sync**.

vgpu's declared philosophy is *read it out of the shader source; do not maintain a second file that has to agree*. That is T1184's `// @default 6` in the trailing comment, read by the same `scanParamsStruct` pass that already reads the description (T1053's precedent, cited in the row). It is the *opposite* of the separate-map alternative the row rejected.

The example also demonstrates the failure mode T1184 prevents. `main-scene-floor.wgsl` hard-codes eleven tuned art-direction numbers inline at two call sites. They are not in `settings.ts`, not named, not reflectable, and not resettable. Their example has the problem T1184 solves.

**Recommendation: do not reopen T1184.** The row was decided twice and the deciding facts hold. This study adds a third argument for the landed design rather than against it. I found nothing that meets the row's own bar for a reopen — the only fact it flagged as decisive ("a *set current value as default* button would have to rewrite the user's shader text, and then the map wins") is untouched by anything here.

---

## 4. Question 3 — what the Loom representation would be

### The whole example, in our vocabulary

| Their artefact | Loom |
|---|---|
| 4 render passes | ~10–14 nodes: `noise`→`cache`; `pointLine`×3→`pointKernel`→`renderPoints`; one `customWgsl` (the raycast); then `threshold`, `screen`, `add`, `level`, `ramp`, `multiply`, `mask`, `output` |
| `led-buffer.ts` (580 lines, CPU) | a `pointKernel` plus `lfo` / `valueMath` / `valueLag` / `valueTrigger` value nodes |
| `settings.ts` layout math | node parameters and expressions (`domain/expressions`) |
| `scene-renderer.ts` orchestration | **the compiler's pass plan** — we already generate this |
| "wrap it, give it a driving surface" | **`domain/components` + published parameters, shipping today** |

### The second half of the ask is already done, and already exercised

All nine shipped components publish parameters:

| Component | Nodes | Published knobs |
|---|---:|---|
| `timeGrid` | 19 | 13 — `columns, rows, churn→2, span, spread, mode, rate→3, seed→2, glitch, chroma, crush, colour, blend` |
| `depthPoints` | 6 | 9 — `resolution→2, unproject, fov, inverseDepth, near, far, displace, gain, heat` |
| `mediaGrade` | 5 | 6 |
| `feedbackEcho` | 7 | 5 |
| `bloom` | 9 | 4 |
| `kaleidoscope` | 5 | 4 |
| `displacementStack` | 6 | 4 |
| `audioLevel` | 8 | 3 |
| `depthCut` | 5 | 3 |

`timeGrid` is the existence proof for the owner's exact sentence. It is a 19-node graph that **contains a `customWgsl`**, publishes 13 knobs on one page, and three of those knobs (`churn`, `rate`, `seed`) drive **multiple internal targets at once** — one published knob moving several nodes together. `depthCut` is the small version: a `customWgsl` plus a `mask`, wrapped, with three knobs out front. `bloom` is a nine-node threshold→blur→tint→add chain behind four knobs, and there is deliberately no `bloom` *node* — the component is how it exists.

And `definition.ts` already handles the case that matters here: publishing a **reflected** knob off a `customWgsl` goes through `effectiveParameterSchema`, not a static read, precisely so a shader's own `struct Params` fields are legal publish targets (T903).

So "wrap stuff around these shader groups so we can have a clean driving surface, **in addition to** each separate shader having its own drivable stuff" is: the component's published page is the outer surface; entering the component and selecting the node gives you its own reflected `struct Params`. Both exist. Nothing to build.

### The one genuine gap

**A user's `customWgsl` cannot reach the shared-function library we already maintain.** `src/nodes/shaders/common.wgsl.ts` is our `@vgpu/wgsl-std` — and its docblock already states the purpose in the owner's own terms:

> Each export is a self-contained block of WGSL declarations, composed into a shader by template interpolation. They live here rather than being duplicated per node so that "what luminance means" or "what mirror-extend means" has exactly one definition to be right or wrong about.

It holds `WGSL_LUMA`, `WGSL_CHANNEL`, `WGSL_EXTEND`, `WGSL_HSV`, `WGSL_HASH`, `WGSL_TRANSFORM2D`. Built-in node definitions interpolate them. A user writing `customWgsl` retypes them, badly — most notably the hash, where the naive `fract(sin(dot(…)))` is what people reach for and what §V45 forbids.

### Proposal: a versioned prelude, prepended in the backend

**Not** a user-authored include graph. A fixed, read-only block of `loom_`-prefixed WGSL functions, prepended to `customWgsl` / point-kernel source **in the backend, after `planStructureKeys` has run**, and versioned.

The placement is the whole design. Everything that reads shader text reads the *authored* bytes, and only the device sees the prelude.

| Contract | What a prepended prelude does to it |
|---|---|
| **`struct Params` reflection** (`params-reflection.ts`) | **Unchanged by construction** — reflection runs on the document's authored source, upstream of the prelude. Needs a gate asserting the reflected field set is identical with the prelude enabled. |
| **T1184 declared defaults** | **Unchanged, same reason.** `@default` is parsed from the authored trailing comment before the prelude exists. |
| **T1059 reserved names** | ⚠ **A new collision class, and it is T1059's exact shape**: the author writes `fn luma(…)`, the prelude already declares one, and the shader fails with a redefinition error pointing at a line they cannot see. **Pay for it up front, not later**: prefix every prelude symbol `loom_`, add the prefix to the reserved-name set, and emit a named diagnostic when authored source declares one. This is the single real cost and it is what makes the proposal safe. |
| **Editor line numbers and diagnostics** | ⚠ **The contract people forget.** `shader-diagnostics.ts:167` reads `diagnostic.source?.line` straight from the compiler. With a prelude of *N* lines every reported line is off by *N* — but *N* is a compile-time constant, not a source map, so it is one subtraction at one site. Gate: `shader-diagnostics.test.ts:39` already asserts a diagnostic lands on line 7; extend it to assert it *still* lands on 7 with the prelude present. Verify it can fail by changing the offset. |
| **Plan structure signature** (`plan.ts` `passKeyParts`, §B185's collision surface) | **Unchanged by construction.** The key embeds `pass.shader`; keep that the authored bytes. This also avoids a real regression: T1176 measured the key block at 12.8–14.5% of an entire `compileGraph`, and pushing ~4 KB of identical prelude into every pass key would inflate that for nothing. Gate: `pass.shader` is byte-identical to the authored `source`. |
| **`shaderSignature`** (editor compile cache) | Add a `preludeVersion` field; `source` stays the authored bytes. Without it, bumping the prelude serves stale programs from the cache. |
| **§V3** | No pressure. A prelude is plain WGSL text with no `vgpu` import; it lives beside `common.wgsl.ts` under `src/nodes/shaders/`. |

Scope it to what `common.wgsl.ts` already holds, plus the two genuinely-missing helpers this study surfaced: a **triangle/polygon SDF** and **OkLab in/out**. Nothing speculative.

### Why not the user-authored include graph

Every cost the T1186 row predicted is real, and the example gives no evidence any of it would pay:

- A second document-addressable text asset kind — where does a user's `.wgsl` file live inside a `.loom.json`? A new asset class, new commands, new migrations.
- A resolver with cycle detection.
- A **source map**, not a constant offset: a compiler error can land inside an imported file the editor is not currently showing. Multi-file editor surface follows.
- Reflection has to rule on whether an imported `struct Params` counts, and T1184 has to rule on whose `@default` wins when two files declare the same field.
- The structure key must cover the **transitive closure**, or editing an imported file does not recompile its dependents — a silent-stale-program bug, which is §B185's family exactly.
- And it would not be adopting vgpu's mechanism, because theirs resolves at build time and ours would have to resolve at runtime against live-edited document text.

Set against that: their biggest shader is bigger than ours *with* the mechanism, and half their passes ignore it.

---

## 5. What I would actually do, in order

1. **Decompose, don't include.** The 10,946-character shader is long because it does five things, not because it lacks `import`. Splitting its jobs across shipped nodes is the tidying the owner is asking for, it is already T880's row, and it needs **zero new mechanism**. Their own example is the argument: the parts they moved into a graph got tidier; the part they left as one shader is 336 lines.
2. **Wrap and publish.** `domain/components` + published parameters, **shipping today**, proven by `timeGrid`/`depthCut`. This is the owner's second ask, complete. If the driving surface feels thin in practice, the fix is authoring more published knobs, not a new mechanism.
3. **Then, only if 1 and 2 leave it still wanted: the prelude.** Bounded, one new collision class, one line-offset contract, both testable. Two new helpers worth adding regardless (triangle SDF, OkLab).
4. **Not the include graph.** No evidence from the artefact we were pointed at supports it.

**Honest cost statement.** Step 3 is not free, and its cost is not the concatenation — it is T1059's collision class and the line-number offset, and both are one-time and gateable. Steps 1 and 2 are free of new mechanism entirely and are where the value is. If the owner reads only the recommendation paragraph, the operative sentence is: *the tidying he wants comes from decomposing into nodes and wrapping in components, both of which we can do today, and the shared-function library is a small follow-on rather than the headline.*

## 6. Residuals — what I did not check

- I did not run anything. No code was executed against our tree beyond reads and greps; nothing under `src/` was touched.
- I read `main-scene-floor.wgsl` in full but skimmed `led-buffer.ts` (580 lines) and `renderer.ts`; my claim that `led-buffer.ts` maps onto a point kernel plus value nodes is a structural reading of its constants and per-frame shape, not a line-by-line port.
- `@vgpu/wgsl-std` is referenced in vgpu's README but **is not installed** in this repo's `node_modules`, so I could not inspect what their standard library actually contains. If the owner wants the prelude's contents benchmarked against theirs, that package needs pulling first.
- I did not measure what a prelude would cost at compile time. The claim that keeping it out of the structure key avoids a regression is derived from T1176's recorded measurement, not from a new one.
