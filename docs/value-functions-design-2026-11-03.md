# A compiled node hands back its value function: the values lane without re-emission

**Date:** 2026-11-03. **Status:** design, for the owner's review before any build.

**Rows:**
- T1333b ("no shader text is regenerated per frame"): this is its next step.
- T1686b (the values lane re-emits a node whose values did not move): this is the general form of what it asks.
- T1684b (expressions): its second half is in §7.
- New rows T1719b–T1722b are filed as open (§10).

**Measured on:** `projects/sentinel-bot/sentinel.loom.json` at `bcd572b7`. The harness is the app's frame headless on the mock device: value graph, then values-lane compile, then uniform push, then encode. Each figure is a median of 3–4 runs, alternated against a HEAD copy in one session.

## 1. Why

One frame of sentinel-bot on the main thread, without the browser:

| Part | ms |
|---|---|
| Value graph | 0.75 |
| **Values-only compile** (`compileFrame`) | **4.4** |
| – resolving the parameters of 41 animated nodes | 2.0 |
| – re-running `compile` for 48 nodes (41 animated, 7 because a scene input moved) | 2.0 |
| – `normalizePass` / `readPass` of every re-emitted pass, then `samePassStructure` against the base | 0.5 |
| Uniform push | 0.6 |
| Encode (vgpu) | 1.1 |
| **Frame** | **≈ 7.0** |

The second and third compile rows are 2.5 ms a frame, and almost none of it is needed.

**What the values lane does today, per animated node:**
1. Calls the definition's whole `compile` again.
2. That rebuilds every pass descriptor: the shader text lookup (T1603b's `generatedOnce` trie walk, 0.55 ms on this file), the bindings, the targets, and the scene payloads.
3. The new passes are normalised, read again, and compared field by field with the base, to prove the structure did not move (§V936).
4. Then the new passes are spliced in, though only their uniform values differ.

**The largest re-emitters:**
- `render_shot`: 0.60 ms.
- `camera_rig`: 0.35 ms. For Camera Blur's motion it resolves its parameters at two other moments every frame (T1421b).
- About twenty point kernels and materials at 0.03–0.08 ms each.

**The structure is already known to hold.** The frame compiler is prepared only after the classifier has proved that no animated parameter is structural (`compileTime`, resolution policy). The re-emission and the comparison re-prove each frame what the classification proved once. The comparison stays as a safety net for nodes that have not adopted the new mechanism.

## 2. What TouchDesigner, Notch and others do

The research brief, 2026-11-03, used official documentation only.

| Tool | How values reach the GPU each frame | What rebuilds the structure | How per-frame expressions stay cheap |
|---|---|---|---|
| TouchDesigner (GLSL TOP/MAT/POP, Render TOP) | Parameter pages (Vectors, Arrays, Matrices) are uniforms, matched by name. A CHOP's channels can feed a uniform array or a texture buffer. The Render TOP fills `uTDMats[]` (world, camera, projection) for each camera. | The shader text. The number or type of a GLSL TOP's inputs. For a material: the number and types of lights and cameras (`TD_NUM_*` defines). Each permutation is compiled once and cached. | Expressions made of recognised tokens are evaluated natively, in about a quarter of Python's time. Their results are cached instead of recalculated every frame. Cooking is pull-based along dependencies. |
| Notch | Keyframes and modifier nodes drive other nodes' properties. A custom shader's global floats become properties. | A custom shader reloads when its file is saved. A particle system's maximum count allocates. A general split between values and rebuilds is not documented. | The Expression modifier's cost and caching are not documented. |
| Unreal | Material Instance parameters, changed at runtime through a Material Instance Dynamic. | Editing the base material. Static switches: one material is compiled for every combination. | n/a |

**Sources:**
- https://docs.derivative.ca/GLSL_TOP and https://docs.derivative.ca/Write_a_GLSL_TOP. A GLSL TOP recompiles when "the number/type of inputs" changes.
- https://docs.derivative.ca/Write_a_GLSL_Material. Lights and cameras are defines: "each permutation … only cause[s] one compilation".
- https://docs.derivative.ca/Cook and https://docs.derivative.ca/Dependency: a pull system.
- https://docs.derivative.ca/Optimized_Python_Expressions: native evaluation, results cached.
- https://docs.derivative.ca/Optimize: "cook faster … when they don't have to add/remove cells/points/channels".
- https://manual.notch.one/2026.2/en/docs/reference/nodes/post-fx/image-processing/custom-shader-post-effect/
- https://dev.epicgames.com/documentation/en-us/unreal-engine/instanced-materials-in-unreal-engine

**The documented model, which Loom already has half of:**
- **Structure:** shader text, input and light counts, and defines. Built once, cached.
- **Values:** parameters, arrays, camera matrices. Written each cook.

Loom has the classification: `compileTime` parameters and structure keys play the role of TouchDesigner's permutations. What Loom lacks is the cheap half. A value change still runs the code that builds structure. In TouchDesigner terms, it rebuilds the GLSL TOP's setup on every cook and then checks that it came out the same.

No documentation says TouchDesigner skips recompiling when a uniform value changes. That is implied by the lists of what triggers a recompile, not stated.

## 3. The proposal

A definition's `compile` may hand back, beside its description, the function that turns this node's moving inputs into this frame's values. On a values-only frame the compiler calls that function instead of `compile`.

```ts
// src/domain/types/node-definition.ts
export interface CompiledNodeDescription {
  passes: ReadonlyArray<unknown>;
  scratch?: …; pointsets?: …; diagnostics?: …;
  /**
   * The values of THESE passes at another frame. Absent: the values lane re-runs `compile`,
   * as today.
   */
  values?: NodeValueFunction;
}

/** What may move on a values-only frame, and nothing else. */
export interface NodeValueInputs {
  readonly parameters: ResolvedParameterValues;          // this frame's, already resolved
  readonly parameterMaps: ParameterMaps;                  // §V-map bindings, as compile gets them
  readonly scene: ReadonlyMap<PortId, ScenePayload>;      // this frame's payloads on scene inputs
  readonly timeProbe?: TimeProbe;                         // T1421b, unchanged
}

export interface NodeFrameValues {
  /**
   * One entry per pass the description emitted, in emission order. Uniforms for an
   * effect/draw/dispatch, rows and a count for a write (§T1623b), a count for a loop marker.
   */
  readonly passes: ReadonlyArray<PassValues | undefined>;  // undefined: this pass did not move
  /** Payloads on this node's scene outputs (a camera's pose, a light's row). */
  readonly scene?: Readonly<Record<PortId, ScenePayload>>;
}

export type NodeValueFunction = (inputs: NodeValueInputs) => NodeFrameValues;
```

**In `compileFrame`, per re-run node:**
- If the base description carried `values`, call it.
- Build each replacement pass as the base pass with its value fields swapped: `uniforms`, a write's `values`, a loop's `count`.
- The pass id, shader, bindings, targets, scratch and pointsets are the base's objects, by reference. So there is nothing to normalise, read again or compare.
- Payloads it returns travel the scene edge as today (`withScenePayloads`). A downstream node that adopted value functions receives them as `scene`.
- A node without `values` takes today's path unchanged, including the §V936 verifier.

**Why a function returned from `compile`, not a second method on the definition.** The function closes over what `compile` already worked out at the base resolution: pass ids, which slot a uniform lives in, the light-row layout and the bindings. It cannot see anything structural that `compile` did not decide, because it is handed no resources, targets or input bindings. And the definition has one place where its values are computed, if `compile` fills the base description's uniforms by calling the same function (rule V-b below).

**Type-level guarantee.** `NodeFrameValues` has no field for a shader, a binding, a target, a pass count or an id. A value function cannot change the structure, because there is nowhere to write it.

### Proposed invariants

- **V-a. Values only.** On a values-only frame an adopting node's passes are its base passes with value fields replaced, by reference everywhere else. Checked in the gate as reference identity of `shader`, `textures`, `buffers` and `target` for every pass.
- **V-b. One source.** An adopting definition computes its base uniforms through the function it returns: `values(baseInputs)` equals the base description's value fields. Checked by the gate for every adopting node in every shipped example, at the base frame.
- **V-c. Equal to re-emission.** For every shipped example, at frames 1, 37 and 240: the plan spliced through value functions equals the plan from re-running `compile` for those nodes, which equals the full compile. This is T1182's existing claim, extended by one arm.

## 4. The gate

Everything is derived; nothing is hand-listed.

1. **Existing T1182 suites, unchanged.**
   - Every animated shipped example splices equal to the full compile at frames 1, 37 and 240.
   - Every non-`compileTime` parameter of every registered type, driven across a threshold, gives a spliced plan equal to the full one.
   - Once a type adopts, both suites run through its value function with no edit.
2. **New, in `frame-compile.test.ts`.** For each adopting node in each shipped example:
   - V-b at the base frame;
   - V-a by reference;
   - V-c with a second arm that forces re-emission (`prepareFrameCompiler(…, { reemit: true })`, a test-only switch).
3. **Red-verify.**
   - Perturb one uniform inside one adopting value function, for example the Render's exposure times 1.001. Both V-b and V-c must fail by name.
   - Make one value function return a pass count different from its base. V-a must fail.
4. **Performance**, recorded in the row, not asserted: re-measure the table in §1 on the same harness with the same alternation.

## 5. Slices

| Slice | What | Measured exit |
|---|---|---|
| **S1. The seam** | Types, the `compileFrame` branch, the gate's arms. First adopter: Level, which is trivial, to prove the plumbing end to end. | Gate green. Level re-emits nothing. No change on sentinel-bot. |
| **S2. Camera** | The camera's pose and motion through `values`. Motion only when a consumer reads it (§8). | `camera_rig`'s 0.35 ms to under 0.05. |
| **S3. Render** | `render_shot`'s per-frame uniforms and light rows (the §T1623b write pass) through `values`. Its scene inputs, the camera and the lights, arrive as `scene`. | 0.60 ms to under 0.1. The 0.55 ms `generatedOnce` walk leaves the frame. |
| **S4. The many** | Point Kernel, Material WGSL and Custom WGSL (Multi): the three types with the most animated instances. | Sum of emission on sentinel-bot under 0.5 ms; read and compare under 0.1 ms. |
| **S5. Closing** | Measure E89, E55, E77 and sentinel-bot. List the types that still re-emit, with their per-frame cost on the shipped set. Adopt the remainder only where measured worth it. | A table in the row. |

**Expected after S4, estimated:** 2.5 ms becomes about 0.6, taking sentinel-bot's values-lane compile from about 4.4 ms to about 2.5.

## 6. Risks

- **A value function that diverges from `compile` in a branch the examples never reach.** V-b and V-c hold on the shipped set and on T1182's parameter sweep. A branch neither reaches remains possible, which is the same exposure today's verifier has. Rule V-b (compile goes through the function) is the structural answer: one computation, not two.
- **Scene payload objects shared by reference.** A downstream value function must not mutate a payload. Payloads are already frozen where `generatedOnce` returns them; S2 freezes what value functions return in test builds.
- **The camera's lazy motion** changes when a payload carries `motion`. Every consumer that reads motion must be found by the compiler, not by convention (§8).
- **Diagnostics.** `compile` reports per-frame diagnostics such as a clamped value, which the values lane drops today ("dropped, exactly as the full per-frame compile's were"). Value functions return none, so nothing changes.

## 7. Expressions: the other 2.0 ms (T1684b, second half)

**Landed with this design:** the frame's reader asks the channel resolver once per address (`onceThisFrame`, `src/compiler/frame-compile.ts`).
- On sentinel-bot, asks fall from 2,999 to 616 a frame.
- With the app's resolver chain (MIDI, OSC, Analyze, depth, Vision) in front of the value graph, the compile drops from 5.08 to 4.58 ms.
- The time probe keeps the resolver as given; `frame-compile.test.ts` holds that, and holds equality with the full compile.

**Still open: repeated subexpressions.** The census (T1684b) has 91% of evaluated tree nodes repeating a subtree already evaluated that frame. Within one frame's reader everything an expression reads is fixed:
- the scope is `scopeFromFrame(frame)`, the same for every expression;
- `.chan` answers are now memoised;
- `.par` reads go through T1172's target memo.

So an expression's value is a function of its tree alone, with one exception: a cycle makes a read depend on the path that asked (§V152). T1172 solved the same problem for `.par`: remember only a result during which the cycle guard did not fire.

The design, in two steps:
1. **Whole expressions** (206 distinct texts of 365 on this file): remember the value per source text per reader, under T1172's no-cycle rule. Small, and exact by the same argument as T1172.
2. **Shared subtrees.** Hash-cons the AST at parse, so structurally equal subtrees are one object across all expressions. Remember each subtree's value per reader, under the same rule. The parse cache (`parsedBySource`) is the natural place. The time probe's readers are other readers, so they are other memos.

**The gate,** as T1684b states: the count of tree nodes evaluated on a frame of sentinel-bot, and equality of every resolved parameter with an evaluation that remembers nothing. Red-verify by sharing one memo across two frames: values must freeze, and the equality must fail (§B181).

This is TouchDesigner's "results are cached so they are kept from re-calculating every frame". Native evaluation is the other half of TouchDesigner's answer. Loom's evaluator is already native (a tree walk, no `eval`). A bytecode form is the moonshot K4a idea and is not proposed here.

## 8. The camera's motion probe (T1421b)

**Today:** the camera resolves its parameters at `±CAMERA_MOTION_SECONDS` on every frame there is a probe, and compares the poses. It does this whether or not any Camera Blur, or a Render with motion blur, reads that camera's motion.

**Proposal:** the compiler knows at the base compile which nodes read a camera's motion:
- Camera Blur names its camera by a parameter.
- A Render takes it on a scene edge.

The camera then gets `wantsMotion` in its context, and computes motion only when true.

**Open question for the owner:** is the consumer set closed (Camera Blur, the Render), or should a definition declare that it reads motion? Declaring it is the general shape, in line with §V982's preference for derived over listed.

## 9. What this does not do

- No change to what is structural. `compileTime`, resolution policy and the classifier are untouched.
- No change to the full compile, previews or the backend. The uniform push and vgpu's encode (1.7 ms) are a separate row.
- No hand memoisation per emission site. That is what T1333b warns against: 85 sites, 85 keys. A value function is a computation the definition already does, moved behind a type that cannot carry structure.

## 10. Rows filed, open until reviewed

- **T1719b. A compiled node hands back its value function (this document).** Slices S1–S5. Proposed invariants V1031 (V-a, values only), V1032 (V-b, one source), V1033 (V-c, equal to re-emission).
- **T1720b. Expressions remember a result per reader** (T1684b, second half): whole expressions, then shared subtrees.
- **T1721b. The camera's motion only for a reader of it** (§8).
- **T1722b. Uniform push and encode per frame, measured again after T1719b:** vgpu's `set` clone and validation, bind-group bookkeeping per dispatch, and the 1.1 ms encode.

## Appendix: the harness

The harness lives in `scratchpad/frame-bench/`, which is gitignored:
- `bench.ts`: the app's frame on the mock device. `CHAIN=1` adds the app's resolver ladder.
- `ab.sh` and `ab-sum.mjs`: alternate a HEAD tree from `git archive` with the work tree, then take medians.
- `prof-*.mjs`: profile readers.

**Lessons, for whoever measures next:**
- **Yield between frames.** Frames encoded back to back in one turn each take a fresh vgpu uniform page, which showed up as 146 bind groups a frame that the app never makes.
- **Don't trust the profiler's attribution for small functions.** It put 40% of a channel read on building an error string. Making that string lazy measured as no gain, and was reverted.

## 11. What landed on 2026-11-03 (uncommitted, for review)

**Measured on sentinel-bot**, headless, as in §1. Medians of four runs alternated against a `git archive` of HEAD.

| | HEAD | Now |
|---|---|---|
| Values-only compile, with the app's resolver ladder | 5.37 ms | 3.30 ms |
| Frame, with the app's resolver ladder | 8.18 ms | 5.99 ms (−27%) |
| Frame, without it | 7.90 ms | 5.93 ms (−25%) |

E89 and E55 spend about 1 ms of main thread a frame and are GPU-bound. Their frames did not move.

**What landed:**
- **One answer per channel address a frame** (§7, T1684b): `onceThisFrame`.
- **Motion only for a reader of it** (§8, T1721b): the declared shape, `PortDefinition.readsMotion`, which Camera Blur's `camera` input carries.
  - This answers §8's open question with the general form.
  - A camera nothing blurs by no longer resolves itself at two other moments.
- **Shared subtrees** (§7, T1720b): `internAst` at parse, plus a per-reader `SubtreeMemory` under §T1172's rule. Only the frame compiler's reader opts in.
  - A memo by whole text was measured no better beside it, and was removed.
- **The value-function seam and Level** (§3–5, S1).
  - What the first adopter forced into the shape: the value function takes the compile context itself, not a narrowed set of inputs. That is what lets `compile` call the same function (V1032).
  - A node that publishes scene payloads keeps re-emitting until its scene values are in.

**S2 (camera) is dropped.** With motion gated, the camera's emission is negligible.

**S3 (the Render) is the next slice and the largest single item.** About 0.6–1.0 ms of emission a frame on sentinel-bot, in `scene.ts` 2185–4177, where uniforms are computed among structural decisions.

## 12. S3 and S4 landed, same day (uncommitted)

**The Render's shape (S3).** The Render's `compile` takes `mode` as an optional second argument.
- In `"values"` mode it runs the same body, but leaves every generated shader unbuilt: each of the 13 generator calls goes through `text(() => …)`, and `surface()` builds no module.
- `renderValues` reads each pass's id and value fields from that run.
- Per pass this is the design's value function, with no second copy of 2,000 lines: V1032 holds because the numbers come from the same code.
- §3's type-level guarantee becomes a run-time one: the splice takes only value fields, and checks each pass's id against the base's.

**The value fields grew** to `id`, `uniforms`, `skip`, `instances` (literal only), `vertexCount`, and a write's `values`. `withValues` checks each one against its base pass's kind.

**S4 adopters:**
- Point Kernel: `uniformsAt` over its compiled module.
- Custom WGSL, with · Multi sharing it.
- Material · WGSL and Light (Single mode): `payloadAt` and `singleLightPayload`.
- The camera, after all, once scene payloads travel: `NodeFrameValues.scene` must name exactly the outputs the base published on.

**Not adopted:**
- Geometry: payload-only, no text, about 0.1 ms.
- The stock materials.
- Every node not measured to be worth it.

**Also landed.** A values-only frame that keeps no diagnostics resolves with `resolveParameterSchema` alone. The bind-cycle walk and the undeclared-key check were only ever computed to be thrown away.

**Measured on sentinel-bot**, as in §11:

| | HEAD | Now |
|---|---|---|
| Values-only compile | 5.50 ms | 1.79 ms |
| Frame | 8.63 ms | 4.54 ms (−47%) |

Fourteen frames across 0–600 equal the full compile.

**Remaining on the main thread, profiled:**
- Parameter resolution: about 1 ms.
- The Render's values run: about 0.5 ms. It still walks its control flow and builds descriptors, with no text.
- Push: 0.6 ms (T1722b).
- Encode: 1.2 ms (T1722b).
- The value graph: 0.85 ms (T1179).

**Found on the way: B296.** `grid-uv.test.ts` is red at HEAD for E75 and E76, and is not on the gates.

## 13. Later the same day: the value graph, the Render's shared uniforms, and generality

**The value graph (T1179).**
- Its members, value edges, references walk, Kahn order, cycle and names are kept per structure; they were rebuilt every frame.
- Its reader remembers subtrees: a member's channel is read only after it has published, and a read before that fails, which is never kept.

**The Render.** Its per-geometry light and shadow entries and its `viewProjection` are built once a compile instead of once per geometry. Plans are byte-identical to HEAD on E25, E34, E75, E76, E79 and sentinel-bot.

**sentinel-bot**, headless, with the app's resolver ladder, alternated against HEAD:

| | HEAD | Now |
|---|---|---|
| Value graph | 0.78 ms | 0.50 ms |
| Values-only compile | 5.28 ms | 1.58 ms |
| Push | 0.78 ms | 0.56 ms |
| Encode | 1.26 ms | 1.15 ms |
| **Frame** | **8.08 ms** | **3.82 ms (−53%)** |

**Not one document's tuning.** Thirteen shipped examples, alternated against HEAD:
- Compile: −10% to −76%. E68 0.54 → 0.13 ms, E79 1.32 → 0.66 ms, E75 1.42 → 0.77 ms.
- Frame: −3% to −48%.
- E89 and E55 are GPU-bound. Their main thread was never their limit.

**What is left is vgpu's work, and the next step is a design (T1722b):**
- **Push, 0.56 ms.** vgpu packs whole blocks, and every lit draw carries the camera and the lights.
  - Option (a): a per-Render scene-frame uniform block, the TouchDesigner `uTDMats` shape.
  - Option (b): a vgpu `set` that does not clone and repack the untouched record.
- **Encode, 1.15 ms.** This is vgpu's per-pass encode.

**One more, the same evening.** A values-only frame resolves only each animated node's animated root keys (`AnimatedNode.moving`). The full schema rides along as the sibling schema, as §T1172's one-key resolve does. The rest are stored constants the base context resolved once.

- sentinel-bot compile: 1.58 → 1.44 ms.
- Frame: 7.95 → 3.60 ms against HEAD (−55%).
- Red-verified: when nothing is resolved, 94 of §T1182's splice tests fail.


## 14. Next, for review: the Render's frame block (T1722b)

**The cost.** After §11–13, the uniform push is 0.56 ms a frame on sentinel-bot: 71 blocks and 1,067 keys, 747 of them the Render's.
- Every lit, G-buffer and depth draw carries the same per-frame values: `viewProjection`, `eye`, `ambientColor`, `environment`, every casting light's `light{i}Meta/Color/Vector`, and every shadow slot's matrices.
- So a moving camera re-sends all 51 draw blocks, and vgpu's `set` packs each whole layout on every set (§12).
- The data was copied into each draw because each draw's uniform block is its own. The values themselves are computed once a compile since §13.

**What TouchDesigner does** (`docs.derivative.ca/Write_a_GLSL_Material`). The Render TOP fills built-in arrays once per render: `uTDMats[]` (world, camera, projection per camera), `uTDCamInfos[]`, and the light blocks. Every material reads them. A camera move is one write, not one per material. The number of cameras and lights is structure (`TD_NUM_CAMERAS`, `TD_NUM_LIGHTS`); their values are not.

**Proposal.** A per-Render FRAME block: one uniform resource the Render declares, written once a frame, bound read-only by every draw the Render emits.
- **What moves into it:** the camera, ambient, environment intensity, the casting lights and the shadow slots.
- **What stays in each draw's own block:** only what is that geometry's (model and normal matrix, material, instance, grid, billboard axes).
- **Two ways to carry it:**
  - (a) Reuse §T1623b's buffer-region `write` pass: a storage buffer, read with `var<storage, read>`. This already exists end to end, including in value functions (`PassFrameValues.values`).
  - (b) A plan resource of kind uniform block that the backend writes once a frame. It is closer to TouchDesigner, and uniform-address-space reads are cheaper on some GPUs, but it is a new resource kind in the plan.
  - Recommendation: (a) first, measured. Move to (b) only if the reads show up in GPU time.

**The gate:**
- The pixels of every scene GPU test are equal. It is the same arithmetic, read from another binding.
- On sentinel-bot, pushed keys fall from 1,067 to about 320 a frame, and push time is measured as in §1.
- §V1032 holds for the Render's value function, which now returns the frame block's rows instead of 51 copies.

**Risk.** Every scene generator reads `params.viewProjection` and the light and shadow members today: the surface, instances, shadow, depth, glass and G-buffer generators. So the shader text of every Render changes. That is why this waits for review rather than being built in the same push.
