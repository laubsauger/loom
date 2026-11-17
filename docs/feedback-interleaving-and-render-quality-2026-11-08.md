# Coupled feedback loops and a render-level quality switch (§T1744b, §T1740b)

Status: design for the owner's review, 2026-11-08. Nothing is built. Probes cited by name are in
`/private/tmp/claude-501/-Users-flo-work-code-shaderloom/ac864667-afef-4072-938f-5a273bec915f/scratchpad/t1744b/`.

## The problem

**The ink simulation (§T1744b).** The perfumery ink chapter v3
(`projects/perfumery-pillar/review/ink/notes.md`, sources in the session scratchpad under
`chapters/ink/v3/`) is a stable-fluids sim built from Loom nodes. Stable fluids couples two
states in both directions. The velocity step reads the dye (`feedback_inkdye → ink_force`,
for buoyancy), and the dye step is advected by this step's projected velocity (`ink_project`).
Wired that way, the plan is refused. So the worker had the dye read `feedback_inkvel`
instead, and wrote down "a one-step lag, harmless here".

**The perfumery pre-render (§T1740b).** Antialias and AO quality are compile-time
parameters on the Render node (`src/nodes/definitions/scene.ts:2151`, `:2204`), and they
often sit inside components. A final render had to patch component internals by label.
§T1738b's `pnpm render --quality final` stands in for the fix: it overwrites every Render
node's `antialias`/`aoQuality` with `ssaa`/`high`, components included, and ignores what the
author chose (`src/tooling/offline-render.ts:264–347`).

## Loom today, and the exact reason for the refusal

A Feedback names its source (§V285); the compiler splits the temporal edge (§V4), backs the
output with a ping-pong pair and places swaps last (§V22, `src/compiler/compile.ts:2511`). Step
6b wraps every loop in a begin/end region, even at count 1, so a live `substeps` never changes
structure (§V358, T425, `compile.ts:2569`). A body is every node on a current-frame path from a
reader of the output back into the Feedback (`loopBody`, `src/compiler/substeps.ts:167`), and
`applySubstepLoops` (`:214`) partitions the passes loop by loop into ancestors, body and rest.
`expandLoops` (`src/runtime/backend/plan.ts:1401`) does not nest regions, and
`loopStructureDiagnostics` (`plan.ts:1315`) makes a nested marker an ERROR (§V147).

**Why interleaving is refused.** Suppose dye reads `project` and force reads `fbdye`. Then
the dye body is {force, project, dye, fbdye} and the velocity body is {force, project,
fbvel}. They overlap, and neither contains the other. The first loop is wrapped into one
entry. The second loop's body then swallows that entry, so its markers end up inside it. The
plan check refuses this as `Loop "pingpong:fbdye:out" opens inside loop
"pingpong:fbvel:out"; substep regions do not nest` and `ok=false`, at substeps 1/1, 4/1 and
1/4 (probe `probe.ts`). The refusal does not protect correctness, ordering or aliasing. At
count 1 a single topological order (force, project, dye, both writes, both swaps) is well
defined. The refusal comes from the region planner: one region per loop, and no nesting.

**Two findings that change the brief:**

1. **A Feedback read outside its loop's region sees this frame's state, not the previous
   one.** The node says "The PREVIOUS frame's input" (`feedback.ts:55`). But since T425 the
   swap sits inside the region, and the backend rebinds every reader after a swap
   (`vgpu-backend.ts:1711`, `rebindResource`). Measured on Dawn (`tap-probe.ts`): a counter
   loop plus a `tap` node reading `state.out` outside the body. Over frames 0–3 the tap reads
   1,2,3,4, identical to the kernel. The contract says 0,1,2,3. At substeps 3 the tap reads
   3,6,9,12. A frame difference (`kernel − feedback`) would therefore read 0.
2. **Plan order, not the wiring, decides previous versus current, and node ids decide plan
   order.** In the v3 ink plan, `ink_dye` and `ink_uv` read `feedback_inkvel` after its swap
   (`outside-readers.ts`, plan level; finding 1 is the mechanism). The "one-step lag" in the
   notes did not happen: the dye already got this step's velocity. With the same lag wiring and only the two Feedback ids renamed
   (`rename-probe.ts`), the order flips: `fbvel, fbdye` runs the velocity first, while
   `avel, zdye` runs the dye first. Velocity then reads the current dye and dye reads the
   previous velocity. Same wires, different simulation. This is deterministic per document,
   but a rebuild that mints new ids can change the picture.

No shipped plan has such a read. In all 17 feedback documents (examples and starter
components, compiled with their Output sinks), no pass reads a pair after that pair's swap
(`outside-readers.ts`). The editor's preview tile of a Feedback node is such a reader, and
today it shows the current state.

## Comparison

| | TouchDesigner | Notch | Loom today | Loom proposed |
|---|---|---|---|---|
| Loop model | Feedback TOP/POP names a **Target** downstream. Its output is the target "from the previous frame, i.e. delayed by one cook cycle" (Feedback POP). Cooking is pull-based. Every Feedback TOP is an independent one-frame delay, so any operator can read the current target or the delayed Feedback. Coupled loops are ordinary networks. | Closed solvers. Field 2D Root steps velocity and ink inside one node. Frame Feedback is a post-FX ("To further manipulate the feedback frame, add more post-fx nodes to the output"), with no arbitrary nodes inside its loop. | Feedback names a source (§V285), and each loop gets one region, even at count 1. Overlapping bodies are a plan error. A read outside the region sees the current state. Order between independent regions depends on ids. | Loops whose bodies overlap, or that read each other's state, form one **group**: one region, swaps at its end. A Feedback read is its source one step behind for every reader. Plan order never changes what a read sees. |
| Iterations per frame | None on Feedback TOP. GLSL TOP `Passes` "Duplicates the operation of the TOP"; "Other inputs and parameters remain the same for each pass." | Field 2D Root "Advect Substeps: Amount of advection calculations performed per frame". Field 3D Root has Solver Iterations. One count for the coupled system. | `substeps` on each Feedback, a live value (T387/T425). | One count per group: the largest member's, with a warning when members differ. |
| Antialias setting | Render TOP Anti-Alias, 1x–32x, an ordinary parameter. | Scene AA mode (MSAA, EdgeAA, Temporal, DLSS, FXAA) in the document. Refine is "only applicable to offline workflows". | Render `antialias` none/msaa/ssaa and `aoQuality` low/medium/high, both compile-time. | Both gain `auto`. Explicit values always win. |
| Realtime vs offline | Realtime flag off / `project.realTime = False`: "all frames are processed sequentially regardless of duration". Quality changes only if the network reads that flag in an expression (our reading; the docs list it only as a Python member). | The Export Video job has its own Antialiasing Passes ("re-rendering the frame with a sub-pixel offset"), Refinement Passes, Motion Blur Frames and size. "Use Scene Refinement / AA Settings" makes the export match the viewport and turns AA passes and motion blur off. | `export.renderRange` steps the live plan deterministically. `pnpm render --spp` averages sub-frames in linear light (≈ Notch Motion Blur Frames). `--quality final` overwrites Render nodes. | A **render context** (`live`/`final`) on the compile request, set by the host. `auto` resolves against it. Nothing writes the document. |

Sources. TouchDesigner: [Feedback TOP](https://docs.derivative.ca/Feedback_TOP), [Feedback POP](https://docs.derivative.ca/Feedback_POP), [GLSL TOP](https://docs.derivative.ca/GLSL_TOP), [Cook](https://docs.derivative.ca/Cook), [Render TOP](https://docs.derivative.ca/Render_TOP), [Project Class](https://docs.derivative.ca/Project_Class), [Movie File Out TOP](https://docs.derivative.ca/Movie_File_Out_TOP).
Notch: [Field 2D Root](https://manual.notch.one/2026.1/en/docs/reference/nodes/fields/field-2d-root/), [Field 3D Root](https://manual.notch.one/2026.1/en/docs/reference/nodes/fields/field-3d-root/), [Frame Feedback](https://manual.notch.one/2026.1/en/docs/reference/nodes/post-fx/blur/frame-feedback/), [Anti-aliasing](https://manual.notch.one/2026.1/en/docs/learning/lighting-and-renderers/anti-aliasing/), [Export Video](https://manual.notch.one/0.9.23/en/docs/user-interface/exporting-video/) (0.9.23; no current-version export page was found).

## Proposal, §T1744b: coupled loops

**The contract (new §V1031).** *A read of a Feedback output sees its source one step behind.
A read of the source sees this step. This holds for every reader, inside a region or outside
it, and no plan order or node id changes it.* A step is one iteration of the reader's own
group. For a reader in no group that holds the pair, a step is the frame, so it reads the
state the frame started with. At count 1, which covers every shipped document, this is TD's
rule exactly. The wire states the intent: the ink dye reads `ink_project` for current
velocity and `feedback_inkvel` for previous velocity.

**Scheduling** (all in `substeps.ts`, after §V22 swap placement, as today):

1. Bodies: as today (`loopBody`).
2. Groups are the strongly connected components of a graph over loops. Loop A gets an edge
   *A before B* when B's body reads A's body on a current-frame edge. It gets *B before A* when
   B's body reads A's pair, so that B sees A's start-of-step state. Overlapping bodies are
   joined directly. The ink's two-way coupling is a cycle, so it becomes one group. E12's
   one-way coupling (dye reads `wgsl_stir`) stays two groups in today's order.
3. Each group is one region with the begin/end markers it has today. Its `loopId` is the
   first member pair in topological order, and a new `members` list carries the rest. Inside
   the region, passes keep topological order and every member swap sits at the region's end.
   Groups are placed in the order of the constraint DAG. The reorder is stable: a plan whose
   reads already obey the contract keeps its order byte for byte.
4. A reader in no loop body sees the frame-start state. It is ordered before the region when
   nothing it reads comes out of it. When it must follow the region (it also reads the region's
   current outputs, as a frame difference does), at count 1 it binds the pair's **other half**,
   which after the swap holds the frame-start state: a new `half: "previous"` on texture
   bindings, no copy. At count > 1 that state is overwritten, so the read is refused by name
   (§V288, D3).
5. Count: `max` of the members' `substepCount`. If the stored counts differ, a structural
   warning names each member and its count. The per-frame path (`frame-compile.ts:635`)
   re-derives the count with the same function, over every member.
6. These rules stay as they are: kernel steps inside a group are refused (`applyKernelSteps`).
   A foreign swap trapped in the group's span is refused (§V288). Regions still do not nest.

**Determinism.** Plan order is the constraint DAG, with ids breaking ties only between groups
that never read each other. So an id can no longer change a read.

**Resource aliasing.** Loom does not alias transient textures by lifetime (§V6: one persistent
resource per output), so the only hazard is a pair's halves. In an iteration a member writes its
write half while others sample its read half: distinct textures in distinct passes, no WebGPU
usage-scope conflict. Swaps at the region end rebind readers through the existing
`rebindResource`. The "previous" half is untouched until next frame. No new resource, except
under D3's snapshot option.

**Cost.** This is compiler only, plus one binding flag in the backend. At count 1 the pass
count is the same as the lag wiring, merely reordered, so the GPU cost is zero. At count N a
group costs N times its union body. The per-node timing already sums iterations (§V86).

## Proposal, §T1740b: a render context and `auto`

**Shape** (recommended): a render-context flag plus a node-level `auto`, through one trait.

- `CompileRequest.renderContext?: "live" | "final"`. Absent means `live`. The value is a fact
  about the render job, not the composition, which is Notch's split between the scene and the
  export job. It is structural: switching it recompiles.
- A parameter may declare `auto: { live, final }`. `antialias` declares `{ live: "none",
  final: "ssaa" }` and `aoQuality` declares `{ live: "medium", final: "high" }`. Both gain an
  `auto` option. The compiler resolves `auto` before a node compiles. It does this in the
  same value pass as `scaleOutputPixels` (`src/compiler/pixel-scale.ts`, T1432b's precedent),
  and in both compile paths, so the full compile and the per-frame compile cannot disagree.
  The node's `compile` never sees the word `auto`.
- Explicit values always win. A Render that stores `msaa` renders MSAA in every context. A
  component author writes `auto` once, inside the component, and every instance follows the
  render with no promotion and no patching by label.

Rejected: a **document setting** (one document renders live and final; a per-project list of
final overrides is the label patch moved into the file), and a **flag alone** (the stand-in
moved into the compiler; it still overrides the author).

**What `final` means, per host:**

| Host | Context |
|---|---|
| Editor, preview tiles, perform windows, phone, MCP live tab | `live`, always. A preview tile has no quality of its own; it shows the plan it is part of. |
| `pnpm render` | `--quality live\|final` sets the context only (D7). The notes list the `auto` parameters it resolved and the explicit ones it respected. |
| In-app `export.renderRange` | A take-local `quality` in `RenderJobSettings` (`use-render-range.ts:91`), applied to the compile only while the take runs. Resolution already reaches the compile this way (`app.tsx:754`). The take recompiles at start and at end. |
| `renderHeadless`, thumbnails, every gate | `live` unless a test names `final`. Thumbnails stay byte-identical. |
| Agent `render_preview` and image export | `live`. A `quality` argument is a follow-up row. |

**Cost.** One request field, one trait, one resolver pass, two enum options, two host wirings.
Live costs nothing extra; final costs what the stand-in costs today.

## Compatibility: shipped examples stay byte-identical

No document changes and no example is regenerated. For §T1744b, all 17 feedback documents
already obey the contract (no post-swap reads), so the stable reorder leaves their plans
unchanged. For §T1740b, no document stores `auto`, and if the default stays put (D5) every
stored or absent value resolves to itself. Both claims are proved by a plan A/B: every
`examples/*.loom.json` and starter component is compiled at HEAD (a `git archive` baseline in
the scratchpad) and with the change, and the plan JSON is compared, pass for pass. Two things
change for non-shipped plans: the editor's Feedback preview tile now shows one frame behind
its source (TD's viewer does the same), and ink v3's lag wiring now gets the lag its notes
describe. The fix there is to wire `ink_dye`/`ink_uv` to `ink_project`.

## Test plan (Dawn, exact bytes; rgba8unorm counters as in `substeps.gpu.test.ts`)

§T1744b, in `src/runtime/backend/vgpu/coupled-loops.gpu.test.ts`:

1. **The literal bug.** `kA = fbA + fbB + 1/255` and `kB = copy(kA)`, with `fbA.source = kA`
   and `fbB.source = kB`. The bodies overlap at `kA`. Frames 0–3 of `kA` read **1, 3, 7, 15**
   (a = a′ + b′ + 1, b = a). The plan is `ok`. Red-verify: (a) disable grouping, and the
   plan is refused with "do not nest"; (b) rewire `kB` to read `fbA` instead of `kA`, and the
   run reads 1, 2, 4, 7, so the assertion separates current from previous.
2. **Substeps on a group.** Two frames at count 2 read **3, 15**, which matches frames 1 and 3
   at count 1. Members at 2 and 1 run at 2 and carry one warning naming both (a headless plan
   test).
3. **The outside-reader contract.** Counter plus `tap`: the tap reads **0, 1, 2, 3** while the
   kernel reads 1, 2, 3, 4. A frame difference `kernel − fb` reads 1 on every frame. This
   test is red on main today: the tap was measured at 1, 2, 3, 4, so the difference is 0.
   The same reader at count 3, if it must follow the region, is refused by name.
4. **Ids do not matter.** Take `rename-probe.ts`'s graph, render it with the ids permuted, and
   compare: identical bytes on every frame. On main today the reads flip.
5. **No regression.** The plan A/B above; the E2, E12, E24, E89 GPU claims by name with `-t`;
   `pnpm test:gates` (a node definition's shape changes) and `pnpm typecheck`.

§T1740b, extending the groove scene in `src/tooling/offline-render.gpu.test.ts`:

6. Inside a component, `auto`/`auto` in `live` equals stored `none`/`medium` (0 differing
   values). In `final` it equals stored `ssaa`/`high` (0 differing), and it differs from live
   (> 0). Red-verify: map `auto`'s live value to `msaa`, and the first equality fails.
7. Stored `none`/`low` in `final` equals the same in `live` (0 differing): explicit wins.
   Red-verify: let the resolver touch explicit values.
8. Headless: on an animated `auto` document at `final`, `compileFrame`'s plan signature equals
   the full compile's, and the plan holds `scratch:<id>:ss`.
9. `use-render-range` (jsdom): a final take's compile carries `renderContext: "final"` and a
   `:ss` resource while it runs, and live before and after.

## Risks

- §T1744b changes what a reader outside a region sees: Feedback preview tiles, and any
  unshipped project relying on today's behaviour. A plan A/B over `projects/` before landing
  names each one.
- The SCC can merge loops the author meant to be independent (two systems reading each other's
  trails); they then step together. The mismatched-count warning makes that visible.
- `auto` in final is SSAA: 4× the scene fill per Render. `pnpm render` prints resolved values.
- Context-only `--quality final` is a no-op on documents without `auto`, where today it forces
  SSAA.

## Decisions for the owner

- **D1** Adopt §V1031 (a Feedback is its source one step behind for every reader), filing
  B299 for the measured outside-reader behaviour and fixing it in the same build. Recommended.
- **D2** Group count when members differ: **max with a warning** (recommended), refuse
  substeps for the group (count 1 with a warning), or let one named member lead.
- **D3** A reader outside a region that needs both the current outputs and the frame-start
  state at count > 1: **refuse by name** now (recommended; no real network needs it yet), or
  a compiler-emitted snapshot copy, which costs one target and one copy per frame.
- **D4** §T1740b shape: **render context + `auto` through a definition trait** (recommended),
  a document setting, or the flag alone.
- **D5** Default for absent values: **stay `none`/`medium`** (recommended; nothing changes
  anywhere), or become `auto` (live identical; every final render of a sparse document turns
  SSAA/high; saved documents are sparse, E20's Render stores 5 parameters).
- **D6** `auto`'s final mapping: **fixed in the definition** (recommended), or a project setting.
- **D7** `pnpm render --quality final`: **context only** (recommended), or keep the overwrite
  under a separate `--force-quality`.
- **D8** Context defaults: `pnpm render` live or final; the in-app take live or final; preview
  tiles during a final take show the final plan or are suspended.

## Follow-up rows (numbers are the next free ones today; take them when filing)

- **B299**: a Feedback read outside its loop's region reads this frame's state (Dawn: tap
  1,2,3,4 against the contract's 0,1,2,3) since T425 put a region around every loop.
- **T1746b**: the render context is readable in expressions (TD's `project.realTime` idiom)
  for numeric parameters, such as kernel iterations.
- **T1747b**: repeat one node N times per frame (TD GLSL TOP `Passes`), collapsing the ink's
  12–24 unrolled Jacobi nodes (its final mode had to be a different document).
- **T1748b**: a `quality` argument on the agent's `render_preview` and image export.
- **T1749b** (only if D3 is refuse): a frame-start snapshot for outside readers at count > 1.
- **V1031** (the contract above) and **V1032**: *render quality belongs to the render job; a
  document states an explicit value or `auto`; explicit wins; the editor is live.*
- Adjacent, not this work: §T1739b (GPU `--spp` accumulation), §T1745b (warm start).
