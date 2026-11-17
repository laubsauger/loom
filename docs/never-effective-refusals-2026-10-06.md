# A stored thing that can never take effect is refused where it is built

T1641b, phase 1. 2026-10-06. Inventory, classification, the rule, what it would refuse today, and the plan for phase 2. Nothing under `src/` changes in this phase.

Seams under it: B262 (an expression calling a function the grammar lacks), B264 (a parameter slot under a key the node does not declare), and the fourth wire into Custom WGSL · Multi's More input.

## How this was made, and how far to trust each part

- **Measured.** Scratch scripts ran the real code with no GPU: a repro of B262, B264 and their neighbours at every moment a document passes through (§1); every shipped document through the real load and compile path with the component-aware registry, six frames each through the real value graph (§5); every shipped document through the checks the candidate rule adds (§5); and two single questions (§5.3, §9.3). An AST census of the source tree produced the code list (§2.1).
- **Read by me.** `src/domain/parameters/**`, `src/domain/expressions/**`, `src/compiler/validate.ts` and the other emitters under `src/compiler/`, `src/domain/channels/value-graph.ts`, `src/domain/commands/apply-patch.ts`, `validate-command.ts`, the storing parts of `parameter-commands.ts`, `src/domain/project/{load,serialize,forward-compat,project-file}.ts`, the diagnostics flow of `src/tests/headless/render-harness.ts`, `src/agent/tool-support.ts` and the patch tools of `src/agent/tools/mutate.ts`, `src/app/problem-sources.ts`, and the compile and open/save flows of `src/app/use-graph-compile.ts` and `src/app/use-project.ts`.
- **Read by three delegated readers, one family each, checked by me in samples.** Node definitions and the node registry; presets, cues and Panel controls; components, migrations and limits. Where a statement rests on such a reading and I did not run it, it says "by reading".
- **Classed by name only.** The host and device families (`media.*`, `mesh.*`, `native.*`, `osc.*`, `vision.*`, `laser.*`, most of `backend/*`). §11 lists everything not read.

## 0. The findings in one page

1. **The bus already refuses B262 and B264.** `graph.applyPatch` runs `validateParameters` on what `addNode` and `setParameters` write: `pow(2, 2)` is refused as `parameter.expression.syntax` and `eyeColor.x` as `parameter.unknown`, both errors, the second with the declared keys. The two bugs shipped because **a document built by code never meets the bus**: a build script writes an object literal through `serializeProjectDocument`, which checks nothing; `loadProject` compares no parameter to a schema; and the compile, the only thing that looks, reports the same two conditions under two other codes as warnings (`parameter.expression`, `compiler/parameter-unknown`) and keeps rendering.
2. **So the seam is one sentence: a stored thing is judged by a different function, under a different code, at a different severity, depending on how it got into the document.** The rule below closes it with one validator per kind of stored thing, called at the write and at rest, and one table that says what each code's class is.
3. **Nine more members of the class, each measured** (§1): an unknown bare name (`flicker * 2`), a reference to a parameter the target does not declare (`op('solid_src').par.raduis`), a channel of a node that publishes none, a bind to no sibling, a map on a node that maps nothing, an expression on a code parameter, a fourth wire into More, a More wire the source never declares, and an unknown function inside a Value Expression node. The bus accepts every one with no diagnostic. Four of them produce **no diagnostic anywhere, ever**: the map, the two More wires, and the Value Expression (whose only check lives in a `compile()` the compiler never calls on a value node).
4. **`parameter.expression` is one warning for at least five different facts**, from "can never parse" to "divides by zero on this frame". `parameter.channels.unavailable`, an INFO, is decided before the node is even looked up, so in every headless compile it also covers a `.chan` read of a node that does not exist, or that publishes nothing.
5. **Whole regions of a document are read only when fired.** A preset bank's targets and stored values, a shot's recalls, a live cue list's cues: nothing at load, compile or `project.validate` reads them (by reading; the at-rest scan in §5 read them all). A recall that applies with skips tells no human surface.
6. **602 diagnostic codes.** 273 are about a stored thing. By the candidate table: 101 NEVER, 28 NOT YET, 64 ELSEWHERE (12 another build, 52 another host), 41 DEGRADED, 12 ADVICE, and 27 that hold more than one class today and must be split. 284 are about an action and 45 about the build itself.
7. **Nothing in the 112 shipped documents is NEVER under the candidate rule** (§5): no load diagnostic, no compile error, no write-gate refusal over 3,868 nodes, nothing in 2,708 expressions and 8,665 `op()` references, 6 banks, 1 cue list, 9 Value Expression nodes, 236 Custom WGSL · Multi nodes, 187 map slots. What turns red when the rule is switched on is **tests and scripts that name today's codes**: at least 13 test files, and the consumer's two `render.ts` guards, which filter on the string `parameter.expression` and would go blind the day that code is split.
8. **One shipped component leaks.** The Kaleidoscope starter component's inner node reads `op('lfo_driftx')` and `op('lfo_drifty')`, which are nodes of its demo file's root graph. It drifts in its own demo and nowhere else (measured, §5.3).

## 1. What happens today, measured

One document, built the way a project's build script builds it (object literals through `src/examples/documents/builders.ts`, then `serializeProjectDocument`), and the same stored things offered to the real bus. No GPU.

| Stored thing | Built by code, then saved | `loadProject` | `compileGraph` | The bus (`graph.applyPatch`) |
|---|---|---|---|---|
| `brightness` = expression `pow(2, 2)` (B262) | written, nothing said | nothing | WARNING `parameter.expression`, plan ok | **refused**, ERROR `parameter.expression.syntax` |
| slot under `eyeColor.x` on a shader with `eyeColor: vec3f` (B264) | written | nothing | WARNING `compiler/parameter-unknown`, plan ok | **refused**, ERROR `parameter.unknown`, "Known parameters: eyeColor, eyesAt, source." |
| `contrast` = `flicker * 2` (no such name) | written | nothing | WARNING `parameter.expression` | applied, nothing said |
| `gamma1` = `op('solid_src').par.raduis` | written | nothing | WARNING `parameter.expression` | applied, nothing said |
| `whitelevel` = `op('ghost').par.x` (no such node) | written | nothing | WARNING `parameter.expression` | applied, nothing said |
| `blacklevel` = `op('solid_src').chan.value` (a Solid publishes no channel) | written | nothing | INFO `parameter.channels.unavailable` ("this context has no channel resolver") | applied, nothing said |
| `brightness` bound to `gama` (no such sibling) | written | nothing | WARNING `parameter.bind` | applied, nothing said |
| `opacity` on a Level in Map mode | written | nothing | **nothing** | applied, nothing said |
| `source` (a code parameter) in expression mode | written | nothing | WARNING `parameter.expression`; and the node's reflected controls fall back to the default shader's, so its real ones read as undeclared | applied, nothing said |
| four wires into Custom WGSL · Multi's More | written | nothing | **nothing**; the pass binds one texture | applied, nothing said |
| a Value Expression node, `lamp = pow(2, 2)` | written | nothing | **nothing** about the node. Its reader gets INFO `parameter.channels.unavailable` | applied, nothing said |

The Value Expression row, followed through a frame: the value graph evaluates the node, skips the statement it cannot parse, publishes the one that works and reports nothing. The parameter that reads `op('expression_gain').chan.lamp` then says WARNING `parameter.expression`: `"expression_gain" publishes no channel "lamp" right now`, which reads as "not yet". The check that would have said `unknown function "pow"` is `node.valueExpression.syntax`, in the node's `compile()`. The compiler calls `compile()` only on nodes the prune keeps, the prune follows edges to a sink, and a value node has no texture output: it is never called.

`project.validate` lists the same findings at the same severities. None of them turns its `ok` to false.

## 2. The inventory

### 2.1 How the codes were counted

A code is a plain string in `RuntimeDiagnostic.code` (`src/domain/types/diagnostics.ts`). There is no list of them. The census parsed every non-test file under `src/` with the TypeScript parser and took:

- every object literal with a `code` property (about 390 sites, 304 of them a string literal);
- every code-shaped string literal passed to a function (the helpers: `error`, `warning`, `info`, `refuse`, `refusal`, `rejected`, `fail`, `failed`, `diagnostic`, `diag`, `skip`, `skipNode`, `capped`, `err`, `warn`, `bridgeFailureResult`, …; about thirty files define a local one);
- every member of a code table passed to a function (`CompilerDiagnosticCode`, `BackendDiagnosticCode`, `ExportDiagnosticCode`).

What that could not resolve was resolved by hand: about twenty constants (`CUSTOM_WGSL_MODULE_CODE`, …), seven ternaries, four templates (`preset.bank.${why}`, `preset.recalls.${why}`, `component.parentScope.${reason}`, `asset.reference.${kind}`), one array (Corner Pin's two codes) and one field passed through (`notice.code`). The delegated readers found six codes the census missed, all behind templates.

**602 codes.** The number is the census's and can be off by a few in the families nobody read in full. That it took a hand pass to finish is itself a finding: §7's gate has to forbid the shapes that cannot be derived.

### 2.2 Where a diagnostic is seen, by producer

Every code of a producer is seen at the same moments, so the moments are given once a producer and the codes after. **refused**: the command is rejected, nothing stored. **E / W / I**: reported as error, warning, info. **—**: not looked at.

| Producer | At the storing command | At save | At load | Compile at rest | Per frame | Headless render | Problems panel | Agent tool's result |
|---|---|---|---|---|---|---|---|---|
| **The write gate.** `validateParameters`, called by `addNode` and `setParameters` on what they write | **refused** (the written keys only) | — | — | only what the resolver re-derives: a wrong static value is the same code at E; an expression that does not parse is `parameter.expression` at W; an undeclared key is `compiler/parameter-unknown` at W; an armed pulse, or an inactive payload that does not parse: nothing | as at rest | E throws; W returned | the compile's | the refusal, with its code |
| **The resolver.** `resolve.ts`, through every compile | — | — | — | yes, at the zero frame. In the app with the live channels; headless with none | computed on every animated frame and **discarded**: the app takes the plan only (`use-graph-compile.ts`), the harness reads errors only | the structural plan's W returned; a per-frame W is dropped | the structural compile's, as of the last document revision | not in the storing tool's result; in `get_diagnostics`, `compile_project`, `validate_project` |
| **The compiler: structure.** `validate.ts`, `topology.ts`, `source-reference-edges.ts`, `flatten.ts`, resolution, format | the bus's own twin where there is one (`port.*`), else — | — | — | yes: the whole document for edges and parameters, kept nodes for required inputs | as at rest | E throws ("Parity graph failed to compile"); W returned | yes | `get_diagnostics` |
| **Node definitions.** `NodeDefinition.compile` | — | — | — | **kept nodes only**: a node no sink reaches says nothing, and a value node is never kept | never: the per-frame path does not read a definition's diagnostics (`frame-compile.ts`) | E throws; W returned | yes | `get_diagnostics` |
| **The value graph** | — | — | — | — | yes | E throws; W returned once each (B252) | source `valueGraph`; absent from the headless server | `get_diagnostics` in the app only |
| **Load.** `loadProject`, migrations, limits | — | — | yes | — | — | — (the harness takes a graph object and loads nothing) | source `project`: a held list from the last open, replaced by the next save or open, never derived again | — |
| **Presets and cues, live** (by reading). `planPresetRecall`, `requireCueTarget` | at Store, as notes | — | — | — | — | — | only a REFUSED recall or GO fired from a key (source `rejection`). An applied recall's warnings reach no human surface | all of them, in the recall's or the GO's own result |
| **Cue lists that follow the timeline.** `planTimelineCues` | — | — | — | yes (`cue.timeline.*`) | — | W returned | yes | `get_diagnostics` |
| **Component definition validation** (by reading). `validateComponentDefinition` | at definition commands and Save Selection | — | a refused definition becomes `project.components.rejected`; its own codes are lost in the message, its warnings dropped | never: a definition in the catalogue is not looked at again | — | — | — | the definition command's result |
| **Other command refusals and notes** | in the result | — | — | — | — | — | a refused gesture: source `rejection`. A note on an applied command: nowhere | in the result |
| **Hosts.** media, files, meshes, helper, devices | — | — | — | — | as the host changes | — (the harness stands in for media) | each its own source | absent from the headless server (`HEADLESS_ABSENT_PROBLEM_SOURCES`) |
| **The device.** `backend/*`, `wgsl/compile` | — | — | — | when the device builds the plan | when a frame fails | returned in `diagnostics`; fatal only when the build throws | source `backend` | `get_diagnostics` |

Three readers that cannot see, found while filling this in:

- **A per-frame warning has no reader anywhere.** The app discards a per-frame plan's diagnostics; the harness keeps its errors and drops the rest. An expression that fails on frame 40 only, or a channel that goes missing mid-take, is reported to nobody.
- **The Problems panel's compile source is the structural compile**: the zero frame, with whatever the live channels held at the last document revision.
- **`loadProject` reports on the root graph only.** Node migrations, placeholders, unknown parameter kinds and resolution clamps are not applied to nodes inside a component definition (by reading).

### 2.3 The codes about a stored thing, one row each

273 codes. The class and the reason are the candidate table of §3; "split" means the code holds more than one class today (§3.3).

#### The write gate

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `parameter.bind.empty` | error | `domain/parameters/validate.ts` | NEVER | a bind to nothing |
| `parameter.bindCycle` | error | `domain/parameters/bind-cycles.ts` | NEVER | a bind chain that returns to itself; refused at the write, reported again at compile |
| `parameter.driven.empty` | error | `domain/parameters/validate.ts` | NEVER | a driven slot naming no channel (the mode is retired) |
| `parameter.enum` | error | `domain/parameters/validate.ts` | NEVER | an option the type does not have |
| `parameter.expression.syntax` | error | `domain/parameters/validate.ts` | NEVER | does not parse: syntax, unknown function, wrong arity (B262 at the bus) |
| `parameter.map.empty` | error | `domain/parameters/validate.ts` | NEVER | a map naming no attribute |
| `parameter.pulse.stored` | error | `domain/parameters/validate.ts` | NEVER | a document may not hold an armed pulse (it would fire on every open) |
| `parameter.range` | error | `domain/parameters/validate.ts` | NEVER | a static value past a declared LIMIT is replaced by the default, not clamped |
| `parameter.referenceCycle` | error | `domain/graph/reference-cycles.ts` | NEVER | an op() chain that returns to itself; refused at the write, reported again at compile |
| `parameter.slot.empty` | warning / error | `domain/parameters/resolve.ts`, `domain/parameters/validate.ts` | NEVER | a mode with no payload. ERROR at the write gate, WARNING from the resolver: one code, two severities |
| `parameter.slot.shape` | error | `domain/parameters/validate.ts` | NEVER | a payload stored under another mode's binding |
| `parameter.stops.count` | error | `domain/parameters/validate.ts` | NEVER | more stops than the type carries |
| `parameter.type` | error | `domain/parameters/validate.ts` | NEVER | a stored value of the wrong shape is replaced by the default at every read |
| `parameter.undefined` | error | `domain/parameters/validate.ts` | NEVER | a key written as undefined |
| `parameter.unknown` | error | `domain/commands/parameter-commands.ts`, `domain/parameters/validate.ts` | NEVER | a key the node does not declare: nothing reads it (B264 at the bus) |

#### The resolver

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `parameter.bind` | warning | `domain/parameters/resolve.ts` | **split:** NEVER, DEGRADED, BUILD | names no sibling / binds to itself / wrong type (NEVER); bound value out of range (DEGRADED); the caller brought no schema or parent scope (BUILD) |
| `parameter.channels.unavailable` | info | `domain/parameters/resolve.ts` | ELSEWHERE (host) | this process has no channel resolver. Decided BEFORE the node is looked up, so it also covers op('ghost').chan.x and a channel of a node that publishes none |
| `parameter.driven` | info | `domain/parameters/resolve.ts` | NOT YET | a retired driven slot whose channel is not attached; load upgrades these, so a file cannot reach it |
| `parameter.driven.clamped` | warning | `domain/parameters/resolve.ts` | DEGRADED | the channel overshot a declared limit; the limit is in effect |
| `parameter.expression` | warning | `domain/parameters/resolve.ts` | **split:** NEVER, NOT YET, ELSEWHERE (build), DEGRADED | every way an expression fails to evaluate, as one WARNING: see the split table |
| `parameter.expression.clamped` | warning | `domain/parameters/resolve.ts` | DEGRADED | the expression overshot a declared limit; the limit is in effect |
| `parameter.slot.unknown` | warning | `domain/parameters/resolve.ts` | ELSEWHERE (build) | a mode this build does not have |

#### The compiler: structure, flattening

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `compiler/binding-budget` | error | `compiler/compile.ts` | ELSEWHERE (host) | past a device limit |
| `compiler/binding-unfilterable` | error | `compiler/compile.ts` | ELSEWHERE (host) | this device cannot filter the format |
| `compiler/bypass-incoherent` | warning | `compiler/compile.ts` | DEGRADED | muted instead of wired through |
| `compiler/camera-preview-ambiguous` | info | `compiler/compile.ts` | ADVICE | the preview shows the stock scene |
| `compiler/color-space-mismatch` | warning | `compiler/color-space.ts` | ADVICE | it renders as wired; the compiler never converts |
| `compiler/component-id-collision` | error | `compiler/flatten.ts` | NEVER | the second node is dropped from the flat graph |
| `compiler/component-missing` | error | `compiler/flatten.ts` | ELSEWHERE (build) | one fact, three codes: project.node.unknownType at load, this and compiler/unknown-node-type at compile |
| `compiler/component-parameter-conflict` | warning | `compiler/flatten.ts` | NEVER | three stored things, all inert, as a WARNING: a `parent.<key>` bind slot that does not resolve; a parent binding a published value shadows; a parent binding under a key the node does not declare. The first is an ERROR when stored the other way (component.parentScope.unknown-key) |
| `compiler/component-port-unresolved` | error | `compiler/flatten.ts` | NEVER | an edge onto an instance port the component does not expose: a wire that binds nothing |
| `compiler/component-recursion` | error | `compiler/flatten.ts` | NEVER | register refuses it; only a catalogue built another way holds one |
| `compiler/cycle` | error | `compiler/topology.ts` | NEVER | a same-frame loop with no temporal node in it. The storing command (connect) does not refuse it today |
| `compiler/definition-version` | warning | `compiler/validate.ts` | **split:** DEGRADED, ELSEWHERE (build) | saved OLDER with no migration (it runs on the current definition) or saved NEWER (another build's node) |
| `compiler/edge-endpoint-missing` | error | `compiler/validate.ts` | **split:** NEVER, ELSEWHERE (build) | an edge naming a node id that is not in the document (NEVER) or a node of unknown type (ELSEWHERE (build)) |
| `compiler/format-depth-on-color` | error | `compiler/format.ts` | NEVER | a depth format stored on a colour output can never apply |
| `compiler/format-input-missing` | warning | `compiler/format.ts` | DEGRADED | the working format stands in |
| `compiler/format-no-fallback` | error | `compiler/format.ts` | ELSEWHERE (host) | this device lacks the format and nothing can stand in |
| `compiler/format-unsupported` | warning | `compiler/format.ts` | ELSEWHERE (host) | this device lacks the format; a named one stands in |
| `compiler/input-missing` | error | `compiler/validate.ts` | NOT YET | a required input not wired yet |
| `compiler/memory-budget` | warning | `compiler/compile.ts` | ADVICE | reported, not enforced |
| `compiler/no-active-sinks` | warning | `compiler/prune.ts` | NOT YET | nothing reaches an output yet |
| `compiler/parameter-unknown` | warning | `compiler/validate.ts` | NEVER | the same condition as parameter.unknown, as a WARNING with no list of keys (B264). ELSEWHERE (build) when the node was saved by a newer definition version |
| `compiler/passthrough-unconnected` | warning | `compiler/compile.ts` | NOT YET | a Null chain that reaches no producer yet |
| `compiler/port-incompatible` | error | `compiler/validate.ts` | NEVER | there is no implicit conversion |
| `compiler/port-missing` | error | `compiler/validate.ts` | NEVER | an edge into or out of a port the type does not declare: a wire that binds nothing |
| `compiler/port-occupied` | error | `compiler/validate.ts` | NEVER | a second wire into a single input is ignored |
| `compiler/resolution-clamped` | warning | `compiler/resolution.ts` | DEGRADED | scaled to the limit in force |
| `compiler/resolution-custom` | info | `compiler/resolution.ts` | DEGRADED | the project resolution stands in |
| `compiler/resolution-input-missing` | warning | `compiler/resolution.ts` | DEGRADED | the project resolution stands in |
| `compiler/resolution-parameter` | warning | `compiler/resolution.ts` | DEGRADED | the project resolution stands in |
| `compiler/source-reference-ambiguous` | error | `compiler/source-reference-edges.ts` | NEVER | a name and a wire on one input: one of the two is never read |
| `compiler/source-reference-missing` | error | `compiler/source-reference-edges.ts` | **split:** NOT YET, NEVER | names no node yet (NOT YET); names a node with no output, or of a kind that can never satisfy it (NEVER) |
| `compiler/substeps-refused` | warning | `compiler/substeps.ts` | DEGRADED | runs one step, or a capped count, and says so. The no-loop site is also NOT YET; not split, the remedy text already differs by site |
| `compiler/unknown-node-type` | error | `compiler/validate.ts` | ELSEWHERE (build) | a type this build lacks (a newer build's, or a component not installed). In a file built by code it is a misspelt type: the code-save caller refuses ELSEWHERE (build) |
| `component.channelMaskTargetMissing` | error | `compiler/flatten.ts` | NEVER | an override path naming no internal node. ERROR at compile, WARNING at detach (component.detach.overrideMissing) |
| `component.parentScope.malformed` | error | `domain/components/commands.ts`, `domain/components/parent-scope.ts` | NEVER | a parent binding whose text is not `parent.<key>`; only a file can hold one |
| `component.parentScope.no-scope` | error | `domain/components/parent-scope.ts` | NEVER | a parent binding on a root node. The storing command WARNS (component.parentScope.noScope) and stores it |
| `component.parentScope.too-deep` | error | `domain/components/parent-scope.ts` | NEVER | for this placement |
| `component.parentScope.type` | error | `domain/components/parent-scope.ts` | **split:** NEVER, DEGRADED | the published value is another type (NEVER) or outside the range (DEGRADED) |
| `component.parentScope.unknown-key` | error | `domain/components/parent-scope.ts` | NEVER | an ERROR here; the bind-slot form of the same fact is a WARNING (compiler/component-parameter-conflict) |
| `component.resolutionTargetMissing` | error | `compiler/flatten.ts` | NEVER | a resolution override path naming no internal node |
| `node.channelMask.unsupported` | error | `compiler/compile.ts` and 2 more | NEVER | Processing Channels on a node with no texture to process. Refused at the bus and reported at compile under one code |

#### Node definitions

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `cornerPin.extract.degenerate` | warning | `nodes/definitions/corner-pin.ts` | DEGRADED | the quad cannot be pinned at these values; the output is transparent and says so. A corner dragged across another passes through it |
| `cornerPin.pin.degenerate` | warning | `nodes/definitions/corner-pin.ts` | DEGRADED | as above |
| `gridWarp.folded` | warning | `nodes/definitions/grid-warp.ts` | DEGRADED | as above, for a folded grid |
| `node.camera.reference` | error | `nodes/definitions/camera-blur.ts` and 3 more | NOT YET | the definition cannot tell a missing camera from a node that is not one; compiler/source-reference-missing can |
| `node.compile.historyUnavailable` | warning | `nodes/definitions/cache.ts` | NEVER | a static tap deeper than the ring: transparent for good, as a WARNING |
| `node.compile.missingResource` | error | `nodes/definitions/compile-context.ts` | **split:** NOT YET, BUILD | about 70 sites: an unwired input (NOT YET, a second report of compiler/input-missing) or the compiler handing a definition no resource (BUILD). Its suggestion addresses the compiler's author |
| `node.compile.tapClamped` | warning | `nodes/definitions/echo.ts`, `nodes/definitions/cache.ts` | DEGRADED | clamped to the oldest slice held |
| `node.compile.tooManyInputs` | error | `nodes/definitions/composite.ts`, `nodes/definitions/switch.ts` | NEVER | more wires than a Composite or a Switch folds. Decidable at the connect, if the port declared its limit |
| `node.customWgsl.module` | error | `nodes/definitions/custom-wgsl.ts` | **split:** NEVER, NOT YET | a // @use of no module, or a name declared twice (NEVER); inputTextureN declared with fewer wires into More (NOT YET on Multi, NEVER on plain Custom WGSL) |
| `node.customWgsl.params` | error | `nodes/definitions/custom-wgsl.ts` | NEVER | a Params field named after one of the node's own keys |
| `node.customWgsl.viewCamera` | warning | `nodes/definitions/custom-wgsl.ts` | DEGRADED | the picture renders; the viewport is not offered |
| `node.materialWgsl.params` | error | `nodes/definitions/material-wgsl.ts` | NEVER | a Params field named after one of the material's own keys |
| `node.materialWgsl.source` | error | `nodes/definitions/material-wgsl.ts` | NEVER | the geometry wearing it then draws the default material with nothing said of its own |
| `node.mesh.clip` | error | `nodes/definitions/mesh-file-in.ts` | NEVER | a clip on a selection with no joints |
| `node.mesh.lamps` | error | `nodes/definitions/mesh-file-in.ts` | NEVER | more lamp groups than have a gain |
| `node.mesh.size` | error | `nodes/definitions/mesh-file-in.ts` | ELSEWHERE (host) | past the storage binding baseline |
| `node.parameter.map` | error | `nodes/definitions/point-curve-frames.ts` and 7 more | **split:** NEVER, NOT YET | a map on a key the node never maps, a map the stored Mode cannot use, a map naming the wrong port, and a STATIC orient nothing reads (all NEVER); a map whose attribute the upstream does not carry (NOT YET) |
| `node.points.attributes` | error | `nodes/definitions/point-kernel-advanced.ts`, `nodes/definitions/points.ts` | NEVER | the attributes text does not read |
| `node.points.capacity` | error | `nodes/definitions/laser-path.ts` and 10 more | **split:** ELSEWHERE (host), NEVER | past the device's storage baseline (ELSEWHERE (host)) or past the build's million-point limit (NEVER). The same storage failure is eight codes by node type |
| `node.points.clock` | info | `points/codegen.ts`, `nodes/definitions/points.ts` | ADVICE | takes effect exactly as stored |
| `node.points.curve` | error | `nodes/definitions/point-curve.ts` | **split:** NOT YET, NEVER | an upstream that does not carry what the basis needs (NOT YET); a points table that does not read, a basis the stored claim cannot run (NEVER) |
| `node.points.curveFrames` | error | `nodes/definitions/point-curve-frames.ts` | **split:** NEVER, NOT YET | all three outputs off (NEVER); a seed or attribute the upstream does not carry (NOT YET) |
| `node.points.edge` | error | `nodes/definitions/laser-path.ts` and 11 more | NOT YET | almost always the echo of an upstream refusal, worded as a producer that predates T296 |
| `node.points.gather` | error | `nodes/definitions/point-gather.ts` | **split:** NOT YET, NEVER, ELSEWHERE (host) | a Links wire that is not a Proximity's, or an attribute the points do not carry (NOT YET); an average of an integer attribute, an output name that is not an identifier (NEVER); storage past the baseline (ELSEWHERE (host)) |
| `node.points.group` | error | `nodes/definitions/points.ts` | **split:** NEVER, NOT YET | a predicate reading no attribute (NEVER); one the upstream does not carry (NOT YET) |
| `node.points.input` | error | `nodes/definitions/point-rope.ts`, `nodes/definitions/points.ts` | NEVER | a wire between two stored things that cannot meet (a counted set into a fixed kernel, a capacity that differs) |
| `node.points.kernel` | error | `nodes/definitions/point-kernel-advanced.ts`, `nodes/definitions/points.ts` | **split:** NEVER, NOT YET, ELSEWHERE (host) | source that breaks the kernel contract (NEVER); ctx.dim or fieldAt with nothing upstream to supply it (NOT YET); past eight storage buffers (ELSEWHERE (host)) |
| `node.points.module` | error | `nodes/definitions/points.ts` | NEVER | a // @use of no module, or a name the module also declares |
| `node.points.params` | error | `nodes/definitions/points.ts` | NEVER | a Params field named after one of the kernel's own keys |
| `node.points.range` | error | `nodes/definitions/point-range.ts` | **split:** NOT YET, NEVER, ELSEWHERE (host) | an attribute the points do not carry (NOT YET); a component the attribute's type lacks (NEVER); storage past the baseline (ELSEWHERE (host)) |
| `node.points.resample` | error | `nodes/definitions/point-resample.ts` | **split:** NOT YET, NEVER | a counted or untyped upstream, a curvature attribute it does not carry (NOT YET); Even Parameter on an input that carries padding (NEVER) |
| `node.points.rope` | error | `nodes/definitions/point-rope.ts` | **split:** NOT YET, NEVER | an upstream claim the solver cannot walk (NOT YET); a strand past the build's 1024 points (NEVER) |
| `node.points.spawn` | error | `nodes/definitions/point-kernel-advanced.ts` | NEVER | spawn source that breaks the spawn contract |
| `node.points.strips` | error | `nodes/definitions/point-strips.ts` | NOT YET | the upstream claims no strips yet |
| `node.points.sweep` | error | `nodes/definitions/point-sweep.ts` | **split:** NOT YET, ELSEWHERE (host) | a path with no orient, no Profile wired, a one-point strip (NOT YET); past eight buffers in one pass (ELSEWHERE (host)) |
| `node.points.transform` | error | `nodes/definitions/point-transform.ts` | ELSEWHERE (host) | storage past the baseline |
| `node.scene.camera` | error | `nodes/definitions/scene.ts` | NOT YET | no camera named yet |
| `node.scene.empty` | error | `nodes/definitions/scene.ts` | NOT YET | also fires, wrongly worded, when every named geometry refused |
| `node.scene.endpoint` | error | `nodes/definitions/scene.ts` | NOT YET | beam mode with no Endpoint attribute named, or one the points do not carry |
| `node.scene.environment` | warning | `nodes/definitions/scene.ts` | NOT YET | the Background colour stands in |
| `node.scene.geometry` | error | `nodes/definitions/scene.ts` | **split:** NOT YET, NEVER | the echo of an upstream refusal (NOT YET); a fixed-capacity mode on a counted set (NEVER) |
| `node.scene.glass` | error | `nodes/definitions/scene.ts` | NEVER | a combination this build does not draw |
| `node.scene.group` | error | `nodes/definitions/scene.ts` | NEVER | a group predicate on a surface |
| `node.scene.instanceAttribute` | error | `nodes/definitions/instance-attributes.ts` | **split:** NEVER, NOT YET | text that does not read, a field the material lacks (NEVER); an attribute the points do not carry (NOT YET). With a shape that is not a mesh the text is never read at all, and nothing says so |
| `node.scene.lightDepth` | error | `nodes/definitions/scene.ts` | NOT YET | Light Depth Output with no light that casts yet |
| `node.scene.maps` | error | `nodes/definitions/scene.ts` | NEVER | texture maps on a draw that has no uv |
| `node.scene.material` | error | `nodes/definitions/scene.ts` | NEVER | a Material · WGSL on a draw it does not run on |
| `node.scene.override` | error | `nodes/definitions/material-overrides.ts` | NEVER | an override line that does not read, or names nothing the material has. Also an echo when the material itself refused |
| `node.scene.reference` | error | `nodes/definitions/scene.ts` | NEVER | a backstop behind compiler/source-reference-missing |
| `node.scene.shadowCasters` | warning | `nodes/definitions/scene.ts` | ADVICE | a light shared by two Renders may rightly cast in only one |
| `node.scene.shadowOnly` | error | `nodes/definitions/scene.ts` | NEVER | Shadow Only on a geometry that casts no shadow: it would draw nothing |
| `node.scene.shape` | error | `nodes/definitions/scene.ts` | **split:** NOT YET, ELSEWHERE (host) | no mesh on Shape Mesh yet, or one without triangles (NOT YET); storage past the baseline (ELSEWHERE (host)) |
| `node.scene.textureBudget` | warning | `nodes/definitions/scene.ts` | ELSEWHERE (host) | past the device baseline of sixteen sampled textures |
| `node.scene.topology` | error | `nodes/definitions/scene.ts` | NOT YET | a surface whose points carry no grid or mesh topology yet |
| `node.scene.unlit` | warning | `nodes/definitions/scene.ts` | DEGRADED | the ambient floor stands in |
| `node.surface.topology` | error | `nodes/definitions/point-topology.ts`, `nodes/definitions/render-surface.ts` | **split:** NOT YET, NEVER | an upstream that publishes no grid (NOT YET); cols x rows that do not match the points carried (NEVER) |
| `node.valueExpression.syntax` | error | `nodes/definitions/value-structure-nodes.ts` | NEVER | the Value Expression node's own unknown-function check. UNREACHABLE at rest: a value node is never kept by the prune, so its compile is never called (measured) |
| `output.toneMapInactive` | info | `nodes/definitions/output.ts` | DEGRADED | the tone map asked for is not applied while the project's display transform is none |
| `ramp.stops.capped` | warning | `nodes/definitions/generators.ts` | DEGRADED | the first sixteen render |
| `ramp.stops.unordered` | warning | `nodes/definitions/generators.ts` | ADVICE | renders exactly as stored |

#### The value graph

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `valueGraph.channelShadowed` | warning | `domain/channels/value-graph.ts` | DEGRADED | one of two same-named channels wins |
| `valueGraph.cycle` | error | `domain/channels/value-graph.ts` | NEVER | a loop through a wire and an op() reference: every member emits nothing. No storing command refuses the mixed loop (T1600b) |

#### Load and migrations

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `project.asset.unresolved` | warning | `domain/project/load.ts` | ELSEWHERE (host) | a session's file is gone after a reload |
| `project.components.invalid` | error | `domain/project/load.ts` | **split:** NEVER, ELSEWHERE (build) | the library fails the closed schema: one unreadable definition drops all of them |
| `project.components.rejected` | error | `domain/project/load.ts` | NEVER | a definition the registry refuses; the definition-validation codes are lost in the message |
| `project.limit.memoryBudget` | warning | `domain/project/limits.ts` | ADVICE | reported, nothing altered |
| `project.limit.nodeResolution` | error | `domain/project/limits.ts` | DEGRADED | clamped, at ERROR severity |
| `project.limit.preview` | error | `domain/project/limits.ts` | DEGRADED | clamped, at ERROR severity |
| `project.limit.resolution` | error | `domain/project/limits.ts` | DEGRADED | clamped, at ERROR severity |
| `project.limit.settings` | error | `domain/project/limits.ts` | DEGRADED | clamped, at ERROR severity |
| `project.migration.applied` | info | `domain/migrations/document-migrations.ts` | DEGRADED | the file was upgraded, and says so |
| `project.migration.noVersion` | error | `domain/migrations/document-migrations.ts` | NEVER | the file does not open |
| `project.node.migrated` | info | `domain/migrations/node-migrations.ts` | DEGRADED | the only place a key the migration dropped is named |
| `project.node.newerVersion` | warning | `domain/migrations/node-migrations.ts` | ELSEWHERE (build) | a newer build's node; kept exactly and written back |
| `project.node.noMigration` | warning | `domain/migrations/node-migrations.ts` | DEGRADED | it runs on the current definition; nothing says what moved |
| `project.node.unknownType` | warning | `domain/project/load.ts` | ELSEWHERE (build) | root graph only: a node inside a component definition is not looked at |
| `project.parameter.unknownKind` | info | `domain/project/forward-compat.ts` | ELSEWHERE (build) | a value shape this build does not read; kept and written back. Root graph only |
| `project.parse.invalidDocument` | error | `domain/project/serialize.ts` | NEVER | the file does not open |
| `project.parse.invalidJson` | error | `domain/project/serialize.ts` | NEVER | the file does not open |
| `project.parse.notAnObject` | error | `domain/migrations/document-migrations.ts` | NEVER | the file does not open |
| `project.schema.newer` | warning | `domain/migrations/document-migrations.ts` | ELSEWHERE (build) | a newer build's file |

#### Presets and cues, when fired

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `cue.bank.malformed` | error | `domain/presets/cue-commands.ts` | NEVER | the bank's text does not read; found only when a cue fires it |
| `cue.bank.missing` | error | `domain/presets/cue-commands.ts` | NOT YET | the bank may be added, or renamed back. Nothing says so at rest on a live list |
| `cue.bank.type` | error | `domain/presets/cue-commands.ts` | NEVER | a cue naming a node that is not a bank; an ERROR, and only when fired |
| `cue.current.unknown` | error | `domain/presets/cue-list.ts` | NOT YET | the stored current cue is no longer in the list |
| `cue.go.empty` | error | `domain/presets/cue-list.ts` | NOT YET | a list with no cues yet |
| `cue.list.malformed` | error | `domain/presets/cue-commands.ts` | NEVER | the cues text does not read |
| `cue.preset.missing` | error | `domain/presets/cue-commands.ts` | NOT YET | an ERROR on a live list when fired; a WARNING at rest on a list that follows the timeline (cue.timeline.preset) |
| `cue.standby.unknown` | error | `domain/presets/cue-list.ts` | NOT YET | the stored standby names a cue that is gone |
| `preset.bank.malformed` | error | `domain/presets/commands.ts`, `domain/presets/move-command.ts` | NEVER | the presets text does not read |
| `preset.bank.noCatalogue` | error | `domain/presets/move-command.ts`, `domain/presets/commands.ts` | ELSEWHERE (host) | this surface has no component catalogue |
| `preset.bank.noPageBank` | error | `domain/presets/commands.ts` | NOT YET | the component holds no bank targeting parent yet |
| `preset.bank.notInstalled` | error | `domain/presets/commands.ts`, `domain/presets/move-command.ts` | ELSEWHERE (build) | the component is not installed here |
| `preset.bank.unnamed` | error | `domain/presets/commands.ts` | NOT YET | the instance has no name yet |
| `preset.on.missing` | warning | `domain/presets/commands.ts` | NOT YET | on/off for a Layer that is not in the document |
| `preset.on.notLayer` | warning | `domain/presets/commands.ts` | NEVER | on/off for a node that is not a Layer; a WARNING, and only at recall. **Retired 2026-11-12 (§T1770b): a preset's on/off switches any node, so nothing emits this code; the counts in this survey are as taken.** |
| `preset.page.notParent` | warning | `domain/presets/commands.ts` | NEVER | a page bank's preset holding values for a name other than parent |
| `preset.page.on` | warning | `domain/presets/commands.ts` | NEVER | a page bank's preset carrying on/off: it reaches only its page |
| `preset.page.recalls` | warning | `domain/presets/commands.ts` | NEVER | a page bank's preset carrying recalls: it reaches only its page |
| `preset.recall.componentOverride` | warning | `domain/presets/commands.ts` | DEGRADED | written, and one channel is still overridden by its own slot |
| `preset.recall.cycle` | error | `domain/presets/commands.ts` | NEVER | accepted when written, found when recalled |
| `preset.recall.depth` | error | `domain/presets/commands.ts` | NEVER | recalls nested past four deep |
| `preset.recall.morphDropped` | warning | `domain/presets/commands.ts` | DEGRADED | the oldest fade was dropped; its keys jumped |
| `preset.recall.morphUnavailable` | info | `domain/presets/commands.ts` | ELSEWHERE (host) | no frame clock here, so the morph is a cut |
| `preset.recalls.malformed` | warning | `domain/presets/commands.ts` | NEVER | a shot recalls a bank whose text does not read |
| `preset.recalls.missing` | warning | `domain/presets/commands.ts` | NOT YET | a shot recalls a bank that is not in the document |
| `preset.recalls.noCatalogue` | warning | `domain/presets/commands.ts` | ELSEWHERE (host) | this surface has no component catalogue |
| `preset.recalls.noPageBank` | warning | `domain/presets/commands.ts` | NOT YET | the component holds no bank targeting parent yet |
| `preset.recalls.notInstalled` | warning | `domain/presets/commands.ts` | ELSEWHERE (build) | the component is not installed here |
| `preset.recalls.type` | warning | `domain/presets/commands.ts` | NEVER | a shot recalls a node that is not a bank; a WARNING, and only at recall |
| `preset.recalls.unknown` | warning | `domain/presets/commands.ts` | NOT YET | a shot recalls a preset its bank does not hold |
| `preset.store.noTargets` | error | `domain/presets/commands.ts` | NOT YET | a bank with no targets yet |
| `preset.target.key` | warning | `domain/presets/commands.ts` | NEVER | a target or a stored value under a key the node does not declare (or a pulse, or the instance's own preset state). A WARNING, only at Store or recall, silent on every human surface when the recall applies |
| `preset.target.missing` | warning | `domain/presets/commands.ts` | NOT YET | a target, or stored values, for a node that is not in the document |
| `preset.target.pulse` | warning | `domain/presets/commands.ts` | NEVER | a stored value for a pulse, which fires and holds nothing |
| `preset.target.self` | warning | `domain/presets/commands.ts` | NEVER | a bank targeting itself |
| `preset.target.unknownType` | warning | `domain/presets/commands.ts` | ELSEWHERE (build) | a target of a node type this build lacks |
| `preset.value.invalid` | warning | `domain/presets/commands.ts` | NEVER | a stored value the write gate refuses; the gate's own code is replaced and its severity drops to WARNING |

#### The timeline's cue plan

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `cue.timeline.bank` | warning | `domain/presets/timeline-cues.ts` | **split:** NOT YET, NEVER, ELSEWHERE (build) | one sentence for no node of that name, a node that is not a bank, no catalogue here, a component not installed, a component with no page bank |
| `cue.timeline.drivenMorph` | warning | `domain/presets/timeline-cues.ts` | DEGRADED | a timed cue uses the bank's stored fade, not its driver |
| `cue.timeline.malformed` | warning | `domain/presets/timeline-cues.ts` | NEVER | the whole list drives nothing, as a WARNING |
| `cue.timeline.overlap` | warning | `domain/presets/timeline-cues.ts` | ADVICE | two lists set one value; both run, in time order |
| `cue.timeline.preset` | warning | `domain/presets/timeline-cues.ts` | **split:** NOT YET, NEVER | the bank holds no such preset (NOT YET) or its text does not read (NEVER) |
| `cue.timeline.structural` | warning | `domain/presets/timeline-cues.ts` | ELSEWHERE (build) | a component whose definition cannot be read here |
| `cue.timeline.untimed` | warning | `domain/presets/timeline-cues.ts` | NOT YET | a cue with no At time on a list that follows the timeline; it is used again when the list goes Live |

#### Component definition validation

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `component.id` | error | `domain/components/definition.ts` | NEVER | a definition the registry will not hold |
| `component.name` | error | `domain/components/definition.ts` | NEVER | a definition the registry will not hold |
| `component.parameter.duplicate` | error | `domain/components/definition.ts` | NEVER | a key published twice |
| `component.parameter.key` | error | `domain/components/definition.ts` | NEVER | a published parameter with no key |
| `component.parameter.missingTarget` | error | `domain/components/definition.ts` | NEVER | not checked again when a nested component is re-authored at the same version |
| `component.parameter.noTargets` | info / warning | `domain/components/commands.ts`, `domain/components/definition.ts` | **split:** ADVICE, NEVER | a key descendants read as `parent.<key>` (fine) or a knob that drives nothing (NEVER); readsParentKey could tell them apart and is not asked |
| `component.parameter.rangeWiderThanTarget` | warning | `domain/components/definition.ts` | DEGRADED | it works inside the overlap of the two ranges |
| `component.parameter.reserved` | error | `domain/components/definition.ts` | NEVER | a key the instance's own preset state holds |
| `component.parameter.typeMismatch` | error | `domain/components/definition.ts` | NEVER | a published parameter of another type than its target |
| `component.port.duplicate` | error | `domain/components/definition.ts` | NEVER | a port exposed twice |
| `component.port.missingNode` | error | `domain/components/definition.ts` | NEVER | an exposed port mapped to a node that is not in the component |
| `component.port.missingPort` | error | `domain/components/commands.ts`, `domain/components/definition.ts` | NEVER | an exposed port mapped to a port the node does not have |
| `component.presets.parentNamed` | warning | `domain/components/definition.ts` | ADVICE | a node inside named parent cannot be a preset target |
| `component.presets.twoPageBanks` | warning | `domain/components/definition.ts` | DEGRADED | the first bank is used |
| `component.recursion` | error | `domain/components/commands.ts` and 3 more | NEVER | a component that contains itself |
| `component.version` | error | `domain/components/definition.ts` | NEVER | a definition the registry will not hold |

#### Commands (in the command's result)

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `component.detach.channelMask` | warning | `domain/components/commands.ts` | DEGRADED | the copies draw every channel |
| `component.detach.inexact` | warning | `domain/components/commands.ts` | DEGRADED | a value that could not be carried onto the copies exactly |
| `component.detach.instancePaths` | warning | `domain/components/commands.ts` | NEVER | the detach leaves override paths that name nothing: created by the command, said once |
| `component.detach.nestedParentReads` | warning | `domain/components/commands.ts` | DEGRADED | a nested read of `parent.parent.<key>` now names one component further out |
| `component.detach.outerTarget` | warning | `domain/components/commands.ts` | DEGRADED | one site unpublishes a key, which orphans every instance's value for it |
| `component.detach.overrideMissing` | warning | `domain/components/commands.ts` | NEVER | see component.channelMaskTargetMissing |
| `component.detach.pageBank` | info | `domain/components/commands.ts` | DEGRADED | the bank was rewritten for the copies |
| `component.detach.pageBankInert` | warning | `domain/components/commands.ts` | NEVER | the detach LEAVES a root bank targeting parent: created by the command, said once, a WARNING |
| `component.detach.parentValues` | info | `domain/components/commands.ts` | DEGRADED | the copies hold the values the parent reads gave |
| `component.import.renamed` | info | `domain/components/file-commands.ts` | DEGRADED | imported under another id |
| `component.parentScope.noScope` | warning | `domain/components/commands.ts` | NEVER | the note on the command that stores the item above |
| `component.upgrade.droppedParameters` | warning | `domain/components/upgrade.ts` | DEGRADED | values removed, and named |
| `component.upgrade.noMigration` | warning | `domain/components/upgrade.ts` | DEGRADED | nothing says what changed between the versions |
| `component.upgrade.removedPorts` | warning | `domain/components/upgrade.ts` | DEGRADED | edges removed, and named |
| `component.upgrade.valueReset` | warning | `domain/components/upgrade.ts` | DEGRADED | a value the new version refuses was reset to its default |
| `edge.duplicate` | error | `domain/commands/apply-patch.ts` | NEVER | BUS ONLY: the same connection twice. Nothing checks a loaded document for it |
| `node.nameTaken` | error | `domain/commands/apply-patch.ts` | NEVER | BUS ONLY: two nodes may not share a name. Nothing checks a loaded document for it |
| `node.unknownType` | error | `domain/commands/apply-patch.ts` and 2 more | ELSEWHERE (build) | the bus refuses a type this build lacks |
| `port.incompatible` | error | `domain/commands/apply-patch.ts` | NEVER | at rest: compiler/port-incompatible |
| `port.missing` | error | `domain/commands/apply-patch.ts` | NEVER | at rest: compiler/port-missing |
| `port.occupied` | error | `domain/commands/apply-patch.ts` | NEVER | at rest: compiler/port-occupied |

#### App hooks and hosts

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `asset.reference.error` | error | `app/use-file-references.ts` | ELSEWHERE (host) | by name |
| `asset.reference.invalid` | error | `app/use-file-references.ts` | NEVER | by name |
| `asset.reference.missing` | warning | `app/use-file-references.ts` | ELSEWHERE (host) | by name |
| `asset.reference.pending` | info | `app/use-file-references.ts` | ELSEWHERE (host) | by name |
| `asset.reference.permission` | warning | `app/use-file-references.ts` | ELSEWHERE (host) | by name |
| `export.nonReproducible` | warning | `domain/render/reproducibility.ts` | ADVICE | by name |
| `gpu.unavailable` | error | `app/app.tsx` | ELSEWHERE (host) | this session has no GPU device |
| `laser.armed` | info | `app/use-laser-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `laser.disarmed` | info | `app/use-laser-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `laser.emission.blocked` | info | `app/use-laser-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `laser.helper.absent` | info | `app/use-laser-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `laser.source.missing` | warning | `app/use-laser-bridge.ts` | NOT YET | by name |
| `media.connecting` | info | `app/use-phone-cameras.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `media.notLoaded` | error | `app/media-commands.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `media.playback` | warning | `app/use-media-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `media.screenCapture` | warning | `app/use-screen-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `media.unavailable` | warning | `app/use-media-sources.ts`, `app/use-phone-cameras.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `mesh.component` | warning | `app/use-mesh-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `mesh.decode` | error | `app/use-mesh-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `mesh.empty` | warning | `app/use-mesh-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `mesh.note` | info | `app/use-mesh-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `mesh.read` | error | `app/use-mesh-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `native.input` | warning | `app/use-native-inputs.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `native.output` | warning | `app/use-native-outputs.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `osc.helper` | warning | `app/use-osc-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `osc.send` | warning | `app/use-osc-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `requirement.unmet` | warning | `app/use-requirement-diagnostics.ts` | ELSEWHERE (host) | this machine cannot run the node |
| `sideEffect.blocked` | warning | `app/use-osc-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `vision.helper.absent` | warning | `app/use-vision-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `vision.native.refused` | warning | `app/native-vision-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `vision.native.retirement` | error | `app/native-vision-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `vision.native.starting` | warning | `app/native-vision-sources.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |
| `vision.refused` | warning | `app/use-vision-bridge.ts` | ELSEWHERE (host) | this session's device, helper or file (by name: producer not read) |

#### The device

| Code | Severity today | Producer | Class | Why, and what is wrong with it today |
|---|---|---|---|---|
| `backend/capability-below-baseline` | error | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/compile-failed` | error | `app/use-frame-loop.ts`, `runtime/backend/vgpu/vgpu-backend.ts` | NEVER | a stored shader the device refuses. Only a device can decide it |
| `backend/device-lost` | error | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/device-restored` | info | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/init-failed` | error | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/not-initialized` | warning | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/present-failed` | error | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/resource-limit` | warning / error | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/shader-validation-unavailable` | info | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/temporal-reset` | info | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `backend/timestamp-unavailable` | info / warning | `runtime/backend/vgpu/vgpu-backend.ts` | ELSEWHERE (host) | the device's state |
| `shader/compile-error` | error | `editor/shader-editor/shader-diagnostics.ts` | NEVER | the shader pane's form of the same |
| `shader/compile-info` | info | `editor/shader-editor/shader-diagnostics.ts` | ADVICE | the device's remark on a shader that compiled |
| `shader/compile-warning` | warning | `editor/shader-editor/shader-diagnostics.ts` | ADVICE | the device's warning on a shader that compiled |
| `wgsl/compile` | error | `runtime/backend/vgpu/vgpu-backend.ts` | NEVER | the device's own messages for a stored shader; severity follows the message |

### 2.4 The codes that are not about a stored thing

329 codes. They need a class for the gate's table to be total (§7) and nothing else. Listed by name so the table can be checked against them.

**ACT** (284 codes)

- `asset` (2): `asset.badData`, `asset.parameterUnresolved`
- `audio` (9): `audio.noSession`, `audio.noSource`, `audio.nothingRecorded`, `audio.track.fps`, `audio.track.frames`, `audio.track.malformed`, `audio.track.provenance`, `audio.track.version`, `audio.trackWriteFailed`
- `bridge` (6): `bridge/detached`, `bridge/devices-only`, `bridge/not-the-owner`, `bridge/page-error`, `bridge/proxy-lost`, `bridge/timeout`
- `capability` (1): `capability.denied`
- `clipboard` (2): `clipboard.empty`, `clipboard.foreign`
- `command` (2): `command.failed`, `command.input`
- `compile` (2): `compile.noCompiler`, `compile.noDevice`
- `compiler` (1): `compiler/sink-unknown`
- `component` (30): `component.create.noCanvas`, `component.create.noSelection`, `component.export.failed`, `component.export.input`, `component.export.missingDependency`, `component.export.noWriter`, `component.export.sessionAsset`, `component.import.input`, `component.import.malformed`, `component.import.missingDependency`, `component.import.noComponent`, `component.import.notAComponent`, `component.import.readFailed`, `component.navigation.atRoot`, `component.navigation.noCanvas`, `component.navigation.noSelection`, `component.navigation.notAComponent`, `component.navigation.notInstalled`, `component.notAnInstance`, `component.notInsideComponent`, `component.notInstalled`, `component.parameter.incomplete`, `component.parameter.unknown`, `component.path.missingNode`, `component.path.notAComponent`, `component.path.notInstalled`, `component.selection.empty`, `component.selection.missingNode`, `component.session.stale`, `component.upgrade.alreadyAtVersion`
- `connect` (4): `connect.incompatible`, `connect.incompatibleSwap`, `connect.noSuchNode`, `connect.noSuchPort`
- `control` (17): `control.channel`, `control.control`, `control.midi.mapping`, `control.midi.range`, `control.midi.source`, `control.midi.target`, `control.midi.unavailable`, `control.midi.unbound`, `control.midi.value`, `control.node`, `control.notBound`, `control.panel`, `control.panelAmbiguous`, `control.parameter`, `control.self`, `control.shape`, `control.unsupported`
- `cue` (11): `cue.back.start`, `cue.back.unfired`, `cue.fire.nothing`, `cue.go.end`, `cue.list.ambiguous`, `cue.list.missing`, `cue.list.none`, `cue.list.type`, `cue.list.unknown`, `cue.timeline`, `cue.unknown`
- `definition` (1): `definition.unknown`
- `edge` (2): `edge.missing`, `edge.orderMismatch`
- `example` (2): `example.unknown`, `example.unreadable`
- `export` (34): `export.audioEncoderUnavailable`, `export.audioNotDeterministic`, `export.cleanupFailed`, `export.encoderUnavailable`, `export.failed`, `export.invalidVideoSize`, `export.missing`, `export.noDevice`, `export.noOutput`, `export.noSession`, `export.noTransport`, `export.planUpdating`, `export.rangeNotContiguous`, `export.recordingSourceFrameMismatch`, `export.renderCancelled`, `export.renderFailed`, `export.renderInFlight`, `export.renderRangeOutsideTimeline`, `export.saveDestinationRequired`, `export.saveDestinationUnavailable`, `export.snapshotOversize`, `export.writeFailed`, `export/encoder-unavailable`, `export/live-read-too-large`, `export/malformed-readback`, `export/readback-during-playback`, `export/recording-backlog`, `export/recording-duplicate-frame`, `export/recording-failed`, `export/recording-frame-gap`, `export/recording-out-of-order`, `export/region-out-of-bounds`, `export/unknown-output`, `export/unsupported-format`
- `fixture` (1): `fixture.noRename`
- `gridWarp` (9): `gridWarp.line.axis`, `gridWarp.line.driven`, `gridWarp.line.exists`, `gridWarp.line.max`, `gridWarp.line.min`, `gridWarp.line.missing`, `gridWarp.line.outside`, `gridWarp.node.missing`, `gridWarp.node.type`
- `group` (2): `group.duplicate`, `group.missing`
- `help` (1): `help.noSurface`
- `history` (4): `history.blocked`, `history.dryRun`, `history.empty`, `history.integrity`
- `inspect` (4): `inspect.noPipelineSurface`, `inspect.noSurface`, `inspect.noTarget`, `inspect.unknownNode`
- `layout` (4): `layout.alreadyTidy`, `layout.empty`, `layout.noShell`, `layout.unknownNodes`
- `library` (3): `library.badPosition`, `library.noSurface`, `library.notOpened`
- `mcp` (3): `mcp/bridge`, `mcp/export-ungranted`, `mcp/no-gpu`
- `node` (20): `node.ambiguous`, `node.channelMask.invalid`, `node.channelMask.notComponent`, `node.duplicate`, `node.emptyLabel`, `node.format.invalid`, `node.label.empty`, `node.label.tooLong`, `node.missing`, `node.name.kind`, `node.name.kindMissing`, `node.name.referencesRewritten`, `node.name.stranded`, `node.notShaderAuthorable`, `node.position`, `node.resolution.invalid`, `node.size.invalid`, `node.ui.type`, `node.ui.unknown`, `node.unknown`
- `output` (4): `output.notTexture`, `output.unknownDefinition`, `output.unknownNode`, `output.unknownPort`
- `parameter` (22): `parameter.clipboard.empty`, `parameter.clipboard.unreadable`, `parameter.mode.payload`, `parameter.mode.retired`, `parameter.multipleOwners`, `parameter.node`, `parameter.paste.channelNoReading`, `parameter.paste.nameNotText`, `parameter.paste.noBinding`, `parameter.paste.noName`, `parameter.paste.noReference`, `parameter.paste.shape`, `parameter.paste.textIsReference`, `parameter.pulse.failed`, `parameter.pulse.node`, `parameter.pulse.type`, `parameter.pulse.unregistered`, `parameter.reference.self`, `parameter.reference.unnamed`, `parameter.reset.cleared`, `parameter.revert.created`, `parameter.revert.unopened`
- `patch` (6): `patch.conflict`, `patch.dryRun`, `patch.duplicateRef`, `patch.malformed`, `patch.staleBase`, `patch.unresolvedRef`
- `perform` (3): `perform.noWindowNode`, `perform.popupBlocked`, `perform.unavailable`
- `points` (2): `points.readFailed`, `points.unavailable`
- `port` (2): `port.notVariadic`, `port.sourceReference`
- `preset` (18): `preset.bank.inDefinition`, `preset.bank.missing`, `preset.bank.nested`, `preset.bank.type`, `preset.bank.unknown`, `preset.component.written`, `preset.delete.cued`, `preset.delete.recalled`, `preset.delete.unknown`, `preset.move.clash`, `preset.move.noInstance`, `preset.move.notOneLook`, `preset.name`, `preset.recall.morph`, `preset.recall.noName`, `preset.recall.nothing`, `preset.recall.unknown`, `preset.store.nothing`
- `preview` (5): `preview.noTarget`, `preview.statsFailed`, `preview.statsUnavailable`, `preview.unknownLens`, `preview.unknownNode`
- `project` (8): `project.autosave.failed`, `project.autosave.unavailable`, `project.new.unsupported`, `project.noSurface`, `project.open.failed`, `project.open.rejected`, `project.save.failed`, `project.settings.invalid`
- `proposal` (1): `proposal.unknown`
- `rename` (2): `rename.noTarget`, `rename.unknownNode`
- `runtime` (2): `runtime.noBackend`, `runtime.noFeedback`
- `selection` (2): `selection.empty`, `selection.noCanvas`
- `settings` (1): `settings.noSurface`
- `shader` (1): `shader/output-stale`
- `tool` (11): `tool.awaitingApproval`, `tool.dryRun`, `tool.failed`, `tool.input`, `tool.partialSource`, `tool.truncated`, `tool.unavailable`, `tool.unavailableCommand`, `tool.unavailablePort`, `tool.unavailableQuery`, `tool.unknown`
- `transaction` (4): `transaction.dryRun`, `transaction.empty`, `transaction.partialRevert`, `transaction.unknown`
- `transport` (3): `transport.noLoop`, `transport.seekLimit`, `transport.seekRange`
- `view` (5): `view.fullscreenRefused`, `view.fullscreenUnsupported`, `view.noCanvas`, `view.noFullscreenSurface`, `view.nothingToFrame`
- `viewer` (5): `viewer.flyDirection`, `viewer.noNode`, `viewer.noOrbit`, `viewer.noOutput`, `viewer.noPane`

**BUILD** (45 codes)

- `animation` (1): `animation/structuralDrift`
- `backend` (9): `backend/frame-error`, `backend/plan-invalid`, `backend/plan-not-current`, `backend/rebuild-failed`, `backend/recover-failed`, `backend/submission-halted`, `backend/unknown-output`, `backend/unknown-pass`, `backend/unknown-resource`
- `compiler` (6): `compiler.crashed`, `compiler/node-compile-failed`, `compiler/node-no-passes`, `compiler/pass-invalid`, `compiler/scratch-invalid`, `compiler/sink-format-undisplayable`
- `component` (5): `component.notFlattened`, `component.starter.invalidDefinition`, `component.starter.invalidJson`, `component.starter.invalidLibrary`, `component.starter.rejected`
- `node` (14): `node.channelMask.boundaryMissing`, `node.channelMask.unwritten`, `node.parameter.default`, `node.parameter.pulse`, `node.points.lifecycle`, `node.points.source`, `node.port`, `node.port.duplicate`, `node.stateful.inconsistent`, `node.stateful.undeclared`, `node.temporal.port`, `node.type`, `node.type.duplicate`, `node.version`
- `project` (8): `project.limit.buffer`, `project.limit.dispatch`, `project.migration.backwards`, `project.migration.duplicate`, `project.migration.failed`, `project.migration.malformed`, `project.migration.missing`, `project.node.migrationFailed`
- `shader` (1): `shader/compile-failed`
- `valueGraph` (1): `valueGraph.evaluate`

### 2.5 Stored things with no code at all

The worst of the class: nothing is reported at any moment. A rule that only re-classes existing codes misses all of these.

| Stored thing | What happens | How known |
|---|---|---|
| Map mode on a parameter of a node that reads no maps. Eight definitions read `parameterMaps`; every other node, the Point Kernel and Render Surface among them, ignores it | the retained static value is used | measured (a Level's `opacity`); the list of eight by reading |
| A wire into Custom WGSL · Multi's More past the third. A More wire whose `inputTextureN` the source does not declare | not bound. The limit is the literal `[1, 2, 3]` in `custom-wgsl.ts`; a Composite and a Switch refuse a ninth wire by name (`node.compile.tooManyInputs`) | measured |
| A Value Expression statement that does not parse, or reads a name nothing supplies | the statement is skipped; the node publishes the rest | measured |
| A preset bank's targets and stored values (a node that is gone, a key the node does not declare, a value the write gate would refuse); a shot's recalls; a recall that goes round in a circle; a live cue list's cues | found only when fired, as a skip. A recall that applies with skips is shown on no human surface | by reading; the at-rest scan of §5 read all of them |
| An expression stored INSIDE a preset's values | checked for its parse at recall and nothing else; then written to the node | by reading |
| A field a preset or cue entry does not have (`recall` for `recalls`, `time` for `at`) | parsed clean, does nothing, erased by the next Store | by reading |
| A Panel board member naming a node that is gone | left out | by reading |
| A MIDI In mapping that does not parse; an OSC In address that can never be published | rows after the bad one are dropped; the channel sits at rest. Shown only in that node's inspector section | by reading |
| An instance's `componentOverrides` path naming an internal node the definition lacks | ignored at flatten. The sibling mask and resolution paths are errors | by reading |
| Two nodes with one name; one connection stored twice; an armed pulse | the bus refuses each. Nothing looks for them in a loaded document | by reading |
| A component definition's warnings, for a definition that arrives by load, import, paste or the starter set | dropped | by reading |
| A definition's inner expression naming a node outside the definition | resolves only in a host document that happens to hold that name | measured (Kaleidoscope, §5.3) |
| Any warning that first appears on a frame after the first | discarded (§2.2) | by reading |
| A Recall, GO or BACK fired by an expression and refused | the result is discarded | by reading |
| On a Geometry: `instanceAttributes` with a shape that is not a mesh; a `material` whose node refused (the default material is drawn). `textureToAttribute.count`. A driven Cache index or Echo delay past the history | not read, or silently replaced | by reading |

## 3. The classification

### 3.1 The classes

Four are about a stored thing.

- **NEVER.** As stored, on any build that has this node type at this version, it can never do what it says: it cannot be evaluated, nothing reads it, or no write path would have accepted it. Only changing the stored thing itself fixes it.
- **NOT YET.** It takes effect the moment something else arrives, and the stored thing need not change: a node gets that name, an input gets its wire, the upstream starts carrying the attribute, a channel is published, an asset is attached. Legitimate while editing.
- **ELSEWHERE.** True of this build or this host only. Two kinds, because one caller treats them differently (§4.2): **build** (a newer build or an installed component has it: an unknown node type, a newer definition version, a parameter form this build does not read) and **host** (this device, process or session lacks it: no channel resolver in a headless process, a format the device cannot filter, a helper that is not running, a file of another session).
- **DEGRADED.** It takes effect, not as written, and the diagnostic says what stands in: a clamp, a cap, a fallback.

Three more exist so that every code has a class.

- **ADVICE.** It takes effect exactly as stored, and the app has a remark.
- **ACT.** About a command, not about anything stored: an action that named something absent or was malformed, or a note on a command that applied.
- **BUILD.** About the build's own definitions or an internal contract. Never a document's fault.

The tie-breaks used, since they decide most rows:

1. **Stored text that does not read is NEVER, not NOT YET**, though people type it: an expression, a bank's JSON, a cue list, a kernel's attributes, a shader's `// @use`. Every text field in the app already holds a draft and commits it as one command (§4.4), so the document never needs to hold the half-typed state.
2. **Two stored things that cannot meet are NEVER; a thing that is missing is NOT YET.** A counted pointset wired into a fixed kernel, a static tap deeper than its ring, a group predicate on a surface: NEVER. No wire, no node of that name, an attribute the upstream does not carry: NOT YET.
3. **A limit that is a constant of the build is NEVER; a limit that is a device baseline is ELSEWHERE (host).**
4. **A failure that depends on the value this frame is DEGRADED**: a division by zero, a quad dragged through itself.
5. **A refusal takes the class of its condition when a loaded document could hold that condition, else ACT.** `port.missing` is NEVER (a file can hold an edge into a port that is not there); `patch.conflict` is ACT.
6. **A NEVER finding on a node whose `definitionVersion` is newer than the registry's is not NEVER.** It is that node's one ELSEWHERE (build) finding: this build cannot judge a newer node's keys, ports or options.

### 3.2 The counts

| Class | Codes |
|---|---|
| NEVER | 101 |
| NOT YET | 28 |
| ELSEWHERE (build) | 12 |
| ELSEWHERE (host) | 52 |
| DEGRADED | 41 |
| ADVICE | 12 |
| holds more than one class today (§3.3) | 27 |
| **about a stored thing** | **273** |
| ACT | 284 |
| BUILD | 45 |
| **all** | **602** |

Of the 101 NEVER codes, 20 are not errors today: `compiler/parameter-unknown`, `compiler/component-parameter-conflict`, `parameter.slot.empty` (from the resolver), `node.compile.historyUnavailable`, `cue.timeline.malformed`, `preset.on.notLayer`, `preset.page.notParent`, `preset.page.on`, `preset.page.recalls`, `preset.recalls.malformed`, `preset.recalls.type`, `preset.target.key`, `preset.target.pulse`, `preset.target.self`, `preset.value.invalid`, `component.parentScope.noScope`, `component.detach.overrideMissing`, `component.detach.pageBankInert`, `component.detach.instancePaths`, and `wgsl/compile` where the device calls its message a warning.

### 3.3 The codes that hold more than one class, and how each splits

**`parameter.expression`** (WARNING) is every way an expression fails. It becomes:

| New code | Class | What it covers |
|---|---|---|
| `parameter.expression.syntax` | NEVER | does not parse: tokens, parentheses, an unknown function, a wrong number of arguments, a malformed `op()`. The code exists at the write gate; the resolver must emit it too, instead of `parameter.expression` |
| `parameter.expression.name` | NEVER | a bare name that is not one of the clocks |
| `parameter.expression.type` | NEVER | the parameter's type takes no expression (a curve, stops, an asset, code) |
| `parameter.reference.unreadable` | NEVER | not `.par` or `.chan`; no such parameter on the target; no such component; a compound read whole; a parameter that is not a number |
| `parameter.reference.ambiguous` | NEVER | an instance publishes that channel on two of its outputs |
| `parameter.reference.noChannel` | NEVER | the target's type publishes no channels, or never that one. Needs the declaration of slice 9 (§8); until then such a read is `parameter.reference.channel` |
| `parameter.reference.node` | NOT YET | no node has that name |
| `parameter.reference.channel` | NOT YET | the target publishes no such channel right now |
| `parameter.reference.upstream` | NOT YET | the referenced parameter itself failed. Its own finding carries the class; this one clears when that one does |
| `parameter.reference.unknownType` | ELSEWHERE (build) | the target is a placeholder |
| `parameter.expression.value` | DEGRADED | division by zero, `mod` by zero, `clamp` with its low above its high, `smoothstep` with equal edges, `exp` overflow, a result that is not finite |

How: the failure half of `EvaluateResult` and of `NodeReferenceResult` gains a `kind`, and the resolver maps kind to code. Today the resolver recognises one kind by searching the reason text for a marker (`CHANNEL_RESOLVER_MISSING` in `resolve.ts`); the split replaces that search.

The other splits:

| Code today | Holds | Becomes |
|---|---|---|
| `parameter.bind` | NEVER, DEGRADED, BUILD | `parameter.bind.unreadable` (NEVER: names no parameter of this node, no such component, itself); `parameter.bind.type` (NEVER) and `parameter.bind.value` (DEGRADED) for a bound value of another type or out of range; "no parent scope" joins `component.parentScope.*`; "the sibling schema is unavailable" is the caller's defect (BUILD) |
| `compiler/definition-version` | DEGRADED, ELSEWHERE (build) | `compiler/definition-older`, `compiler/definition-newer`. The numbers are both in hand |
| `compiler/edge-endpoint-missing` | NEVER, ELSEWHERE (build) | stays for a node id that is not in the document; `compiler/edge-endpoint-unknown-type` when the endpoint is a placeholder |
| `compiler/source-reference-missing` | NOT YET, NEVER | stays for a name no node holds; `compiler/source-reference-unusable` for a node with no output, or of a kind that can never satisfy the input |
| `project.components.invalid` | NEVER, ELSEWHERE (build) | cannot be told apart from the file. What can be fixed: read the library one definition at a time, so one unreadable definition does not drop all of them |
| `component.parentScope.type` | NEVER, DEGRADED | `.type` and `.value`, as for a bind |
| `component.parameter.noTargets` | ADVICE, NEVER | ask `readsParentKey`: ADVICE when a descendant reads `parent.<key>`; `component.parameter.unread` (NEVER) when nothing does |
| `cue.timeline.bank`, `cue.timeline.preset` | NOT YET, NEVER, ELSEWHERE | the live path already tells these apart (`cue.bank.missing`, `cue.bank.type`, `cue.preset.missing`, `cue.bank.malformed`, `preset.bank.noCatalogue`, …). A list that follows the timeline should report the same codes, at rest |
| `node.compile.missingResource` | NOT YET, BUILD | not emitted for an unwired input, which `compiler/input-missing` has already said; kept for the compiler's own contract (BUILD) |
| `node.customWgsl.module` | NEVER, NOT YET | stays for `// @use` and a name declared twice; `node.customWgsl.inputs` for a declared `inputTextureN` with fewer wires |
| `node.parameter.map` | NEVER, NOT YET | stays for a key the node never maps, a Mode that cannot use it, the wrong port; `node.parameter.map.upstream` for an attribute the upstream does not carry or carries as another type; the static `orient` nothing reads gets its own code |
| `node.points.capacity`, `.curve`, `.curveFrames`, `.gather`, `.group`, `.kernel`, `.range`, `.resample`, `.rope`, `.sweep`, `node.scene.geometry`, `.instanceAttribute`, `.shape`, `node.surface.topology` (14 codes) | two or three of NEVER, NOT YET, ELSEWHERE (host) | one mechanical rule. Each `refuse()` site already knows which it is. The base code keeps the sites where this node's own stored thing is wrong (NEVER); `<code>.upstream` takes the sites where what arrives does not carry what the node needs (NOT YET); `<code>.device` takes the sites that hit a device baseline (ELSEWHERE, host) |

Considered and not split: `compiler/substeps-refused` (four sites, all "it runs one step, or a capped count, and says so"; the remedy text already differs by site), `node.camera.reference` (the compiler's source-reference check tells the two cases apart before the definition runs), `preset.target.key` (three causes, all NEVER, one message).

### 3.4 One condition under two codes, or one code at two severities

These are not class splits. They are the same finding said twice, differently, and each is a place the rule cannot hold while it stays so.

| Condition | Today |
|---|---|
| A key the node does not declare | `parameter.unknown` (ERROR, with the declared keys) at the bus; `compiler/parameter-unknown` (WARNING, without them) at compile; `preset.target.key` (WARNING) inside a preset; `control.parameter` (ERROR) at a Panel control |
| An expression that does not parse | `parameter.expression.syntax` (ERROR) at the bus; `parameter.expression` (WARNING) at compile; `preset.value.invalid` (WARNING) inside a preset; `node.valueExpression.syntax` (ERROR, unreachable) in a Value Expression |
| A mode with no payload | `parameter.slot.empty`: ERROR at the bus, WARNING from the resolver |
| A `parent.<key>` read of a key that is not published | `compiler/component-parameter-conflict` (WARNING) as a bind slot; `component.parentScope.unknown-key` (ERROR) as a parent binding |
| A parent read on a root node | `component.parentScope.noScope` (WARNING, and stored) at the command; `component.parentScope.no-scope` (ERROR) at compile |
| An override path naming no internal node | `component.channelMaskTargetMissing` (ERROR) at compile; `component.detach.overrideMissing` (WARNING) at detach; nothing at all for `componentOverrides` |
| A component that is not installed | `project.node.unknownType` (WARNING) at load; `compiler/component-missing` and `compiler/unknown-node-type` (two ERRORs) at compile |
| A cue naming a missing bank or preset | ERROR on a live list, only when fired; WARNING at rest on a list that follows the timeline |
| Packed point storage past the limit | eight codes by node type (`node.points.capacity`, `.range`, `.gather`, `.transform`, `.kernel`, `.lifecycle`, `node.mesh.size`, `node.scene.shape`) |
| A setting clamped at load | `project.limit.*`: reported at ERROR, and the document opens |

## 4. The rule

### 4.1 The function, and where it lives

**One table and one question.**

```ts
// src/domain/diagnostics/classes.ts
export type DiagnosticClass = "never" | "notYet" | "elsewhereBuild" | "elsewhereHost" | "degraded" | "advice" | "act" | "build";

export interface DiagnosticClassRow {
  readonly class: DiagnosticClass;
  /** Why this code is of that class. One line; the gate refuses an empty one. */
  readonly reason: string;
  /** NEVER only: what can decide it (§4.5). */
  readonly decidedBy?: "write" | "document" | "compile" | "frame" | "device";
  /** NEVER only: the finding leaves the rest of the plan usable (§4.3). */
  readonly local?: true;
}

export const DIAGNOSTIC_CLASSES: Readonly<Record<string, DiagnosticClassRow>>;

/** The one answer to "what class is this code". Total: a code with no row is "unclassified". */
export function diagnosticClass(code: string): DiagnosticClass | "unclassified";

/** What a caller that refuses reads: the NEVER findings, and any unclassified one. */
export function neverEffective(diagnostics: readonly RuntimeDiagnostic[]): readonly RuntimeDiagnostic[];
```

Three properties of the table, each held by the gate:

1. **One code, one class.** The splits of §3.3 are what that costs.
2. **A NEVER code is an error at every emitter and carries a `suggestion` at every emitter**: the refusal says what to write instead.
3. **An unclassified code is treated as NEVER by every caller.** A code the gate's derivation missed fails the first headless render that produces it, loudly, instead of being waved through.

**Why the domain and not `src/app/problem-sources.ts`.** The row names the Problems registry as the home of the classification. The bus (`src/domain/commands`), the save path (`src/domain/project`) and the compiler must all ask the question, and none of them may import `src/app`. So the table lives in the domain, and `problem-sources.ts` keeps what it owns, the read side: `readProblemSources` is the one function the Problems panel and `diagnostics.get` take their diagnostics through, so it is where the class reaches a person or an agent, and where an unclassified code is refused a quiet tier. The gate checks both files.

**One validator per kind of stored thing, called at the write and at rest.** This is the half that closes B262 and B264, and the table alone does not do it.

- Stored parameters: `validateParameters` (`src/domain/parameters/validate.ts`). The bus calls it on what a patch writes. The compile's `resolveNodeParameters` must call the same function on what a node stores, in place of its own undeclared-key loop, so that the two cannot give two codes, two severities and two messages for one stored key. `retainedParameterKeys` stay exempt, as today.
- Expressions: the evaluator's failure kinds (§3.3). The write gate and the resolver read the same kinds.
- Wires: the port definition declares what it binds (slice 5); `connect` and `validateGraph` read the same declaration.
- Bank and cue text: the planner's own parse and target checks, called at the write and by the document check, in place of "found when fired".

**The whole-document check.**

```ts
// src/compiler/document-findings.ts
export function documentFindings(input: {
  readonly document: ProjectDocument;
  readonly registry: NodeRegistryView;
  readonly components: ComponentRegistryView;
}): readonly RuntimeDiagnostic[];
```

Everything that can be said of a document without a device: the write gate over every stored node, in the root graph and inside every library definition; definition validation for every library definition, with its own codes and its warnings; the flattening's diagnostics; `validateGraph` on the flattening; required inputs and cycles; the bus-only invariants (one name, one node; one connection, once); bank and cue text. It is what `project.validate` returns today, plus what that command does not read: the write gate's checks, the library's definitions, the flattening, the bus-only invariants, bank and cue text. `project.validate` becomes its face on the bus.

### 4.2 Who calls, and what each does with each class

| Caller | Asks | NEVER | NOT YET | ELSEWHERE | DEGRADED, ADVICE |
|---|---|---|---|---|---|
| **The bus**, `graph.applyPatch`, for every actor: what the patch writes, judged against the document as the patch leaves it | the validators of §4.1 on the written keys, wires and names | **the patch is rejected**, whole, with the finding at error and what to write instead | applied; the finding is in the patch's own result as a warning (new: today the storing command says nothing) | applied; reported | applied; reported |
| **A field in the editor** | the same bus | the commit is refused; the field keeps the text and shows the reason. This is what the expression field does today for a parse failure | committed; the row shows the warning | | |
| **Save, in the app**: `project.save`, autosave | `documentFindings` | **the file is written.** Losing work is worse than saving a document with a fault in it. The findings come back in the save's result and reach the Problems panel | | | |
| **Save, by code**: a build script, the examples build, the starter components. One function, `buildCheckedProjectFile` | `documentFindings`, then a compile at the Tier B baseline as the example gate compiles | **throws, naming every finding. No byte is written** | printed | **build**: throws (a script that writes a node type this build lacks has misspelt it). **host**: printed | printed. Any other error-severity finding on a kept node also throws |
| **Load, in the app**: open, autosave restore, an example | `loadProject`, then `documentFindings` | **the document opens, whole.** Nothing is dropped or rewritten. Each finding is in the Problems panel at error tier and on its node's badge, from two sources: the load's (held) and the compile's (live, and gone when it is fixed) | warning | as today (placeholders, kept values) | as today |
| **Load, by code**: `runExample`, a project's render script, anything that reads a file to render or test it. One function, `requireProject` | the same | **throws** | returned | returned | returned |
| **The compile** | emits the codes; decides plan usability | error. The plan stays usable when the row says `local` (§4.3) | as today | as today | as today |
| **A headless render**, `renderHeadless` | `documentFindings` on its request's graph before compiling; then every plan's diagnostics, the structural one's and **every frame's** | **throws**, like a per-frame error today, naming the first frame | returned, once each. `strict: true` on the request makes them throw: a final render has no "later" | returned | returned |
| **The Problems panel**, `diagnostics.get` | `readProblemSources` | error tier | warning | info or warning | warning or info |
| **Agent tools**: `apply_graph_patch`, `set_parameters`, `add_node`, `connect_ports`, `set_shader_source` | the bus's result | `rejected`, with the finding and its suggestion | `ok`, with the warning in the same result | | |
| **`validate_project`** | `documentFindings` | `ok: false` | `ok: true`, listed | | |

Two guards so that the code callers cannot be forgotten: `src/examples/**`, `src/projects/**` and the harness may not import `serializeProjectDocument`, `buildProjectFile` or `loadProject` directly (an eslint zone, as the layering rules are); and §7's shipped-set gate runs `documentFindings` over `projects/**` as well as the examples.

### 4.3 A document that already holds a NEVER item

It opens. It says so loudly. Nothing is dropped.

- `loadProject` changes nothing in the item: the stored bytes come back out of the next save (§V68 holds as it does for a newer build's values).
- The finding is an error in the Problems panel and on the node, with what to write instead.
- **The picture keeps rendering.** Today an error at compile withdraws the plan: the frame loop keeps the plan it already has, and a document opened fresh shows nothing. If every NEVER finding did that, a document that rendered yesterday with a warning would open black after the rule lands, and for an undeclared key there is no control in the inspector to fix it with. So the table says which NEVER findings are `local`: the item is inert, its stated fallback is in effect, and the rest of the plan is whole. `hasError` in `src/compiler/diagnostics.ts`, where the compiler turns severity into plan usability, skips them. **Every code that is a warning today and NEVER under the rule is `local`**: the report gets louder and the live picture does not get worse. Codes that are errors today stay as they are.
- The bus refuses a NEW NEVER write. It does not refuse an unrelated edit to a node that already holds one: the write gate judges what a patch writes, which is what it does today (§V264: a document that arrives broken must stay repairable).
- A way to clear it. An undeclared key has no row in the inspector, so the rule needs one command, `parameter.removeUndeclared`, offered from the Problems row. Without it a person cannot clear the error the rule gives them.
- Headless, the same document does not render: `renderHeadless` throws. That is the difference the row asks for between a file somebody is working in and a file a script is about to trust.

### 4.4 An edit by hand, against a patch from code or an agent

The row's worry is that typing an expression is a run of invalid states. The app has already answered it, twice, the same way:

- the expression panel (`src/ui/controls/parameter-mode.tsx`) holds a **draft**, asks `payloadProblem` (the grammar's own parse) before it commits, and shows the reason at the field when the draft does not read. Nothing is written;
- a code field holds its text locally and commits one `setShaderSource` when focus leaves (`src/app/dock-panes.tsx`).

So the bus needs no second rule for people. It refuses a NEVER write from anyone; the field keeps the text, as it does today for a parse failure. What phase 2 adds is that `payloadProblem` asks the same validator the bus asks, so the new write-decidable findings (an unknown name, a reference nothing can read, a bind to no sibling) show at the field before the commit rather than as a rejected patch after it.

A patch is judged against the document **as the patch leaves it**, not operation by operation. A reference to a node the same patch adds two operations later is fine. Bind cycles and `op()` cycles are already checked this way.

What a patch from code or an agent gets that it does not get today: the NOT YET findings on what it wrote, in its own result. An agent that writes `op('lamp_key').par.gain` before any node is called `lamp_key` is told so by `apply_graph_patch`, as a warning, and does not have to think to call `get_diagnostics`.

### 4.5 What can decide a NEVER finding

"Refused at the command that stores it" is only possible where the command can know. The table says which, per code.

| Decided by | Means | Who refuses |
|---|---|---|
| **write** | the written thing, the node's schema and the names in the document are enough | the bus. All of `parameter.*`, the expression and reference codes, a bind, a map on a parameter that is not mappable, a wire past what a port binds, bank and cue text |
| **document** | needs the whole document, no device: a loop through wires, a named source of the wrong kind, an edge onto a port a component does not expose, a parent read | `documentFindings`: the code save, the code load, the harness, `validate_project`. The bus reports it in the storing command's result as a consequence; refusing there is slice 10 |
| **compile** | needs the node's own compile: most `node.*` codes | the compile; so a headless render and the code save. An agent learns it from the compile, as today |
| **frame** | only a running frame shows it: `valueGraph.cycle` | a headless render |
| **device** | only a GPU decides: a shader the device refuses | a render on a device |

### 4.6 An edit that orphans something else

Some NEVER items are not written by anyone. They are left behind by a legitimate edit to something else:

| Edit | Leaves |
|---|---|
| a shader edit that drops or renames a `Params` field | the stored value or slot under the old key |
| `component.unpublishParameter`, `component.unexposePort`, an in-session detach, a re-author at the same version | instance values under a key that is no longer published; wires onto a port that is no longer exposed; parent reads of the key |
| `component.detach` | override paths that name nothing; a root bank targeting `parent` |
| deleting a node, or clearing its name (a rename rewrites what names it) | `op()` references, preset targets, cues, recalls, Panel members that name it (these are NOT YET) |
| `preset.delete` | cues and recalls naming the preset (NOT YET) |

The rule for all of them: **the edit is not refused, and it says what it orphaned.** The command's result names each item (`node.name.stranded`, `preset.delete.cued` and `component.detach.instancePaths` already do; `unpublishParameter`, `unexposePort` and a shader commit say nothing today), the item is a finding at rest from then on, and nothing is dropped behind the author's back. Dropping the orphaned value in the same undo step was considered for the shader case and rejected: a field renamed for one commit would lose its expression.

## 5. What the rule would refuse today in shipped documents

### 5.1 What was run

112 documents: the 74 examples, the 12 starter component files, the 26 project files under `projects/` (furnace, on-nothing, sentinel-bot). Each was read from its shipped bytes, with no product code changed.

- **The real path.** `loadProject` with the component-aware registry and the file's own library (`createComponentSystem`, as `src/examples/runner.ts` builds it; a bare registry severs every instance), one `flattenComponents`, the structural `compileGraph` at the Tier B baseline, then six frames (0, 1, 2, 30, 197, 900), each through the real value graph session and a per-frame compile reading its channels. Every diagnostic was kept with its code, node and message.
- **The write gate, asked of the stored document.** `validateParameters` on every node's stored parameters against its effective schema, in the root graph and inside every library definition (3,868 nodes, 2,894 slots: 2,707 expressions and 187 maps).
- **What nothing reads today.** Every expression's bare names and `op()` references (2,708 expressions, 8,665 references); every bank's targets, stored values, on/off and recalls (6 banks, 13 presets, 74 stored values); every cue (1 list, 5 cues); every Value Expression statement (9 nodes, 59 statements); every Custom WGSL · Multi's More wires against what its source declares (236 nodes); every map slot against the node that holds it; duplicate names; armed pulses.

Not run: a render. The compile had no mesh, media or audio facts, so a finding that needs an asset's contents (`node.mesh.*`, a clip's joints) cannot appear here. A node no sink reaches is not compiled, here as in the app.

### 5.2 The result

**No shipped document holds a NEVER item.** The load reported nothing in any file. No compile produced an error. The write gate refused nothing. The at-rest checks found no expression that does not parse, no unknown name, no reference to an undeclared parameter, no preset target or value the node does not declare, no cue naming a missing bank or preset, no Value Expression statement that does not parse, no More wire that binds nothing, and no map on a key its node does not map. `parameter.unknown` and `compiler/parameter-unknown` appear nowhere, so the false warning of §9.3 touches no shipped file.

Everything that was reported, in full:

| Document | Node | Code today | Message | Class under the rule |
|---|---|---|---|---|
| `examples/E43-Splice` | `wgsl_splice` (customWgsl) | `parameter.expression.clamped`, W, on a frame | Parameter "amount" expression "op('lag_glitch').chan.high" produced 1.0613, outside its range 0…1; the value in effect is clamped to 1. | DEGRADED: stays a warning |
| `examples/E52-Presence` | `level_wash` (level) | `parameter.expression`, W, on a frame | op('personmask1').chan.coverage: "personmask1" publishes no channel "coverage" right now | NOT YET (`parameter.reference.channel`): a Person Mask publishes through the vision helper, which this process does not have |
| `examples/E53-Two-Cuts` | `level_washC` (level) | the same | op('personmask_seg').chan.coverage: … publishes no channel "coverage" right now | NOT YET |
| `examples/E53-Two-Cuts` | `level_washW` (level) | the same | op('matte1').chan.coverage: … publishes no channel "coverage" right now | NOT YET |
| `examples/components/MatteCut` | `cache_history` (cache), inside the instance | the same | op('matte1').chan.ready: "matte1" publishes no channel "ready" right now | NOT YET |
| `projects/on-nothing/cards` | `render_type` (render) | `node.scene.unlit`, W | geometry "cardGeo" wears a lit material but no lights are named — ambient floor only. | DEGRADED |
| `projects/on-nothing/incar` | `render_paneshot` (render) | `node.scene.unlit`, W | geometry "geo_panes" wears a lit material but no lights are named — ambient floor only. | DEGRADED |
| `projects/sentinel-bot/sentinel` | `kernel_claw`, `kernel_hull`, `kernel_ring` (pointKernel) | `node.points.clock`, I | kernel reads ctx.time — the TIMELINE clock, which resets to the in point every time the loop comes round… | ADVICE |
| 79 of the 112 documents | 918 parameters | `parameter.channels.unavailable`, I | … this context has no channel resolver, so "…"'s channels cannot be read | ELSEWHERE (host). 449 in the examples, 20 in the component files, 234 in sentinel-bot, 176 in furnace, 39 in on-nothing |

The E52 and E53 reads are ones `channel-integrity.test.ts` already pins by name as unverifiable from a document alone. None of these rows changes severity under the rule, and none is refused anywhere, a strict headless render excepted (§4.2): a final render of E52 with no vision helper would stop on its row, which is the truth about that render.

**For the consumer session: `projects/sentinel-bot/sentinel.loom.json` as it stands at `e889b585` passes every check.** Three ADVICE infos and 234 host infos; nothing to change in the file. Its build script and its two guards are another matter (§5.4).

### 5.3 One shipped component reads out of itself

The Kaleidoscope starter component's inner node `facets` (a Tile) drives `offset.x` and `offset.y` with `op('lfo_driftx').chan.value` and `op('lfo_drifty').chan.value`. Those two LFOs are not in the component. They are nodes of the root graph of `examples/components/Kaleidoscope.loom.json`, the component's own demo file. After flattening every name is in one flat graph, so in that file the read resolves.

Measured, by compiling that file with and without the two root LFOs:

- with them: no warning, no error;
- without them, which is any other document that instances Kaleidoscope: `parameter.expression`, W, twice, per frame: `there is no node named "lfo_driftx" (Main / kaleidoscope1 / facets)`. The offsets hold their stored values and the drift never happens. At rest, with no channel resolver, the same read is the INFO of finding 4 in §0.

Two on-nothing files (`sleep-like-a-baby`, `sleep-like-a-baby-2`) carry the definition in their library and hold no instance of it, so nothing is evaluated there. `reference-integrity.test.ts` walks a file's root graph only, which is why it has not seen this.

By class this is NOT YET (a host with those names makes it resolve), and so it is not refused. Whether a definition may read its host by name at all is question 7 of §10.

### 5.4 What turns red that is not a document

- **At least 13 test files name a code the rule splits or merges** (`parameter.expression`, `compiler/parameter-unknown`, `parameter.bind`, `parameter.slot.empty`): `src/compiler/validate.test.ts`; `src/domain/parameters/{resolve,validate,node-references}.test.ts`; `src/domain/commands/parameter-commands.test.ts`; `src/tests/integration/cross-node-reference.test.tsx`; `src/tests/headless/{component-expression,frame-rates,pixel-reference}.gpu.test.ts`; `src/nodes/definitions/{camera-blur.gpu,matte}.test.ts`; `src/ui/controls/props-equal.test.ts`; `src/projects/sentinel-bot/director.test.ts`. Tests that match on message text were not counted.
- **The consumer's two render scripts** (`src/projects/sentinel-bot/render.ts`, `src/projects/on-nothing/render.ts`) stop on `d.severity === "error" || d.code === "parameter.expression"` (sentinel also on `compiler/parameter-unknown`). The day `parameter.expression` is split, that filter matches nothing and **the guard goes blind without failing**. Both must move to `neverEffective(result.diagnostics)` in the same commit as slice 1, or slice 1 must keep emitting the old code for one release.
- **Three project build scripts** (`src/projects/{sentinel-bot,on-nothing,furnace}/build.ts`) call `serializeProjectDocument` directly, and four modules under `src/examples/` call `buildProjectFile` (`example-files.ts`, `component-files.ts`, `starter-components.ts`, `look-instrument.ts`). Slice 3 makes the direct call an eslint error in both trees; all seven move to `buildCheckedProjectFile`.
- **120 test files call the harness.** Any that renders a document broken on purpose (a fallback's own test) needs to name the finding it expects. I did not count them; slice 3 has to, before it lands.

### 5.5 What this scan cannot say

- Whether a name read inside a Value Expression statement will be supplied: its inputs carry channels whose names exist only at run time.
- Whether a live publisher's channel name is right (`coverage`, `ready`): no definition declares what it publishes (slice 9).
- Anything a device decides: no shader was compiled on a GPU.
- Panel boards, MIDI In mappings and OSC In addresses: not scanned.

## 6. Better messages

Each NEVER refusal says what to write instead. The texts below are what the one validator should produce; today's are quoted from the repro of §1.

| Finding | Today | Should say |
|---|---|---|
| **B264.** A part a compound does not have: `eyeColor.x` on a colour | bus: `Unknown parameter "eyeColor.x".` / `Known parameters: eyeColor, eyesAt, source.` compile: `Node "wgsl_haze" carries parameter "eyeColor.x", which "customWgslMulti" does not declare.` / `The value is ignored; remove it or update the node definition.` | `"eyeColor" on "wgsl_haze" is a colour, so its parts are r, g, b, a: there is no "eyeColor.x".` / `Write "eyeColor.r".` And, when the node's controls come from its shader: `A vec3f or vec4f field of struct Params whose name contains colour, color, tint, rgb, albedo or emissi is a colour; any other is a vector, with parts x, y, z, w.` The name rule is `looksLikeColour` in `params-reflection.ts`; the message must read it from there, not repeat it |
| A key near a declared one | as above | `"level_lamp" (Level) declares no parameter "gama". Nearest: "gamma1".` / `It declares: blacklevel, brightness, contrast, gamma1, invert, opacity, whitelevel.` With each compound's parts beside it: `eyeColor (a colour: .r .g .b .a), eyesAt (a 3-vector: .x .y .z)` |
| A key a shader edit orphaned (at rest only) | the compile text above | `"wgsl_haze" stores a value under "amount", which its shader no longer declares. Nothing reads it.` / `Declare the field again, or remove the stored value (Problems: Remove).` |
| **B262.** A function the grammar lacks | `… does not parse: unknown function "pow" (available: abs, atan2, …)` | `Parameter "intensity" expression "pow(x, 2)": the grammar has no function "pow".` / `Write x ^ 2. Functions: abs, atan2, ceil, clamp, cos, exp, floor, fract, max, min, mod, round, sign, sin, smoothstep.` |
| The rewrites, as data beside `FUNCTIONS` in `evaluate.ts` (its docblock already argues each in prose) | none | `pow(a, b)`: `a ^ b`. `sqrt(x)`: `x ^ 0.5`. `mix(a, b, t)`, `lerp(a, b, t)`: `a + (b - a) * t`. `hypot(a, b)`: `(a ^ 2 + b ^ 2) ^ 0.5`. `step(edge, x)`: `(x >= edge)`. `tan(x)`: `sin(x) / cos(x)`. `atan(x)`: `atan2(x, 1)`. `log`, `log2`, `asin`, `acos`: `the grammar has none: its result is not finite for every input.` A test requires every name in `CANDIDATE_FUNCTIONS` (`reference.ts`) the grammar refuses to have a row |
| A misspelt function | the whole list | `Nearest: smoothstep(low, high, x).` |
| A wrong number of arguments | `clamp() takes 3 arguments, got 2: clamp(x, low, high)` | good as it is |
| An unknown bare name | `unknown name "flicker" (available: absframe, abstime, …)` | `Parameter "contrast" expression "flicker * 2": nothing an expression can read is called "flicker".` / `An expression reads the clocks (time, delta, frame, abstime, absframe, walltime, walldelta, fps, subframes) and other nodes: op('name').par.key, op('name').chan.channel.` Plus, when a node is named `slider_flicker`: `A node is named "slider_flicker": write op('slider_flicker').chan.value.` And when this node has a parameter `flicker`: `"flicker" is a parameter of this node: read it in Bind mode.` |
| A parameter the target does not declare | `op('solid_src').par.raduis: "solid_src" has no parameter "raduis"` | add the nearest declared key, and the list: `"solid_src" (Solid) declares: …` |
| A channel of a node that publishes none | INFO `this context has no channel resolver…`, or `publishes no channel "value" right now` | `op('solid_src').chan.value: "solid_src" is a Solid, which publishes no channels.` / `Read one of its parameters, op('solid_src').par.<key>, or name a value node.` |
| A compound read whole | `… is a color, and an expression reads a number — name a component, as ….r` | good as it is |
| A bind to no sibling | `it names no parameter on this node (it has …)` and, for a ref shaped like `node.key`, the `op()` form to write | good as it is; add the nearest key |
| An expression on a type that takes none | `a "code" parameter cannot take an expression (§V107)` | add `Switch "source" back to Constant.` |
| A map nothing reads (no code today) | nothing | `"opacity" on "level_lamp" is in Map mode, and a Level reads no point attributes: nothing maps it.` / `Switch it back to Constant, or drive it with an expression. Nodes that map: Geometry (tint, scale, orient, instanceTranslate), Render Points (color, sizePixels), Render Instances (color), Curve (arcLength, bow, bend), Curve Frames (up, roll), Sweep (radius).` The list is read from the declarations of slice 5 |
| A wire More cannot bind (no code today) | nothing | at the connect: `"wgsl_haze" (Custom WGSL · Multi) binds three textures on More, as inputTexture1, inputTexture2 and inputTexture3. A fourth would bind nothing.` / `Combine two of them upstream, or read the rest in a second Custom WGSL · Multi.` At rest: `More holds 2 wires and the source declares inputTexture1 only: the second binds nothing.` / ``Declare `var inputTexture2: texture_2d<f32>;` or disconnect it.`` |
| A Value Expression statement (unreachable today) | nothing | `Value Expression "expression_gain": "lamp = pow(2, 2)": the grammar has no function "pow".` / `Write 2 ^ 2.` And, as NOT YET: `"also = flicker * 2" reads "flicker", which no wire into In carries and no earlier statement or default defines; "also" is not published.` |
| A value inside a preset the node cannot take | `the value for "node.key" does not fit it (…); skipped.`, WARNING, the inner code lost | the inner finding's own code and text, with the preset and bank named in front |
| A name with two readings: `component.parameter.noTargets`, `cue.timeline.bank` | one sentence for both | the sentence of the case it is (§3.3) |
| `node.scene.empty` when names WERE given | `no geometry is named` | `scenes names "geo_a", which published nothing: see its own problem.` |
| `node.compile.missingResource` | `The compiler must assign every connected port a resource id before calling compile().` | not shown for an unwired input (the compiler has said `input-missing`); its suggestion addresses the compiler's author, not the reader |

## 7. The gate

Four parts. The first two are the gate the row asks for; the others are what stops the rule being true of the table and false of the product.

### 7.1 Every code has a class

`src/domain/diagnostics/classes.test.ts`, on `test:gates`. It walks `src/**` with the TypeScript parser (no checker: the census did this in 1.2 seconds on this machine), the way `problem-sources.test.ts` and `composition-seams.test.ts` derive their subjects, and finds every code three ways: an object literal's `code` property; a string passed where a function's parameter is named `code` (the helper is resolved in the same file, or by its import); a member of a code table.

It fails when:

- a code has no row in `DIAGNOSTIC_CLASSES`, or a row's reason is empty;
- a row names a code no source emits (the table cannot rot);
- a NEVER code is emitted at a severity other than error, or with no `suggestion`;
- a NEVER row has no `decidedBy`;
- **a `code` is an expression the derivation cannot resolve.** Allowed: a string literal; an identifier bound to a module-level `const` string; a member of an `as const` table; a ternary of those; a helper's own `code` parameter. Anything else (today: four templates, one array, `notice.code`, `CODE_BY_TYPE[message.type]`) is exempt BY NAME, with the codes it can produce listed beside it, and those are checked against the table like any other;
- an exemption no longer matches anything.

Red-verified the way `effective-schema-closure.test.ts` verifies itself: the derivation is run over a temporary file that emits an unclassified code, then one that hides a code behind a template, and each must be reported.

It finds its subjects by walking the tree, so `gate-list.test.ts` will require it on `test:gates`, and the count of gate files in `CLAUDE.md` and `AGENTS.md` moves with it.

### 7.2 A code the derivation missed fails at run time

`diagnosticClass` answers `"unclassified"` for a code with no row, and every refusing caller treats that as NEVER (§4.1). So a code built in a way the parser cannot see fails the first headless render, example gate or `validate_project` that produces it. The gate is the net; this is the floor under it.

### 7.3 The rule, through the real stack

`src/tests/headless/never-effective.gpu.test.ts` (Dawn), the literal bugs:

- **B262.** A document built by object literal, a Light's `intensity` as an expression slot calling `pow(x, 2)`. (a) `buildCheckedProjectFile` throws, naming the node, the key and `x ^ 2`. (b) The raw bytes through `loadProject`: the document opens, and its findings hold the error. (c) `renderHeadless` of it throws, naming the finding. (d) The bus refuses the same `setParameters`. (e) The legitimate case the guard could swallow: the same slot with `x ^ 2` renders, and the lit pixel differs from the render where the expression is cut back to its retained value. That last assertion is the one that says the expression is in effect, and it is what B262's picture lacked.
- **B264.** A Custom WGSL with `eyeColor: vec3f` and slots under `eyeColor.x`, `.y`, `.z`: the same five, the message naming `eyeColor.r`. The legitimate case: slots under `.r`, `.g`, `.b` render a pixel that moves with the driven value; and `eyesAt.x` beside it is accepted, because a position is a vector.
- **More.** Four wires: the fourth `connect` is refused; a document built with four is an error at rest; with three, the third texture reaches the pass (a pixel that only `inputTexture3` can produce).
- **A map on a Level; `pow` inside a Value Expression.** The same shape.

`src/compiler/document-findings.test.ts` (no GPU), the cases each refusal could wrongly swallow: a reference to a node the same patch adds later (accepted); a reference to a node no patch has added (accepted, with a NOT YET warning in the result); `.chan` of an LFO before the first frame (accepted); a newer-version node carrying a key this build does not know (ELSEWHERE; the document opens, nothing is NEVER); a key in `retainedParameterKeys` (silent); a look instance holding `presetCurrent` (silent: today it warns, §9.3); a key orphaned by a shader edit (the document opens and renders; the Problems panel holds one error; `parameter.removeUndeclared` clears it and undo brings it back).

### 7.4 The shipped set

`src/examples/never-effective.test.ts`, on `test:gates` (it enumerates the document set): `documentFindings` over the examples, the component files and every `projects/**/*.loom.json`, and `neverEffective(…)` is empty. This is the first gate of the family that reads `projects/`. `reference-integrity.test.ts`, the existence half of `channel-integrity.test.ts` and assertion (b1) of `authorability.test.ts` each re-implement a piece of it today, two of them with a regular expression over `op('…')`; they can become callers of the one function. This row does not delete them.

## 8. Slices for phase 2

Each lands alone. The order is the one I recommend: 0, 1, 2 and 3 close B262 and B264 at every moment a document passes through, and nothing after them is needed for that.

| # | Slice | Could break |
|---|---|---|
| 0 | **The table and its gate.** `src/domain/diagnostics/classes.ts` with all 602 codes as they are today, the 27 split codes entered as named exemptions; `diagnosticClass`, `neverEffective`; the gate of §7.1. No behaviour changes | nothing at run time. `gate-list.test.ts` and the gate count in the two instruction files |
| 1 | **Expression failures carry a kind.** `parameter.expression` splits (§3.3). The resolver emits `parameter.expression.syntax` and the other NEVER kinds at error, `local`. Existence and shape are decided before "no channel resolver". The B262 messages | the test files of §5.4. **The consumer's two `render.ts` guards go blind** unless they move in the same commit. `runner.test.ts` asserts no warning in any example: a reference that was hidden behind the resolver INFO now shows (the scan found none at a root graph) |
| 2 | **One validator for stored parameters, at rest too.** The compile calls `validateParameters`; `compiler/parameter-unknown` merges into `parameter.unknown` (error, `local`), with the declared keys, their parts and the nearest; not emitted for a newer-version node. `parameter.removeUndeclared` and its Problems action. The B264 messages | the false warning on a look instance's `presetCurrent` (§9.3) must be gone before the code is an error. A shader edit that drops a field now leaves an error where it left a warning. Tests naming `compiler/parameter-unknown`, the consumer's `director.test.ts` among them |
| 3 | **`documentFindings`, and the two doors for code.** `buildCheckedProjectFile`, `requireProject`; the harness calls `documentFindings`, reads every frame's diagnostics, throws on NEVER, returns the rest once, and takes `strict`. The eslint zone. The shipped-set gate of §7.4 | harness tests that render a broken document on purpose. One document check per headless render. The three project build scripts and the four writers under `src/examples/` change door (§5.4); the bytes they write do not change |
| 4 | **The write gate learns what it can decide.** An unknown bare name, an expression on a type that takes none, a reference nothing can read, a bind to no sibling: refused at the patch's end state. NOT YET findings in the patch's own result. `payloadProblem` asks the same validator | an agent that writes a reference before the shader declares the field is refused (question 5 of §10). Tests that store such a state through the bus as setup |
| 5 | **Declarations for wires and maps.** A port says how many wires it binds (More: three; a Composite and a Switch: eight); a definition says which keys it maps. `connect` and the write gate refuse; `validateGraph` reports the same at rest; the More wire the source does not declare | a node definition's shape changes: the 26 catalogue walkers, the help reference, `list_node_definitions`. No socket is added, so no shipped layout moves |
| 6 | **Text that is a program.** A code parameter may carry a validator the write gate calls: a Value Expression's statements, a bank's JSON, a cue list's. The value graph reports a statement it skipped; `node.valueExpression.syntax` becomes reachable | the value graph's diagnostics are no longer always empty at rest. An inspector text field that commits text the gate now refuses must keep it as a draft |
| 7 | **Presets and cues at rest.** `documentFindings` reads banks and cue lists through the planner; the live path and the timeline path report one set of codes; a recall that applied with skips shows them to a person | NOT YET warnings appear at rest on documents whose banks name nodes that are gone |
| 8 | **Components.** Definition validation keeps its codes at load and reports its warnings; the library is read one definition at a time; `unpublishParameter`, `unexposePort` and a detach name what they orphan; `setParentBinding` refuses a key that is not published and a root node; one severity for a parent read; `componentOverrides` paths are checked like their two siblings | definition commands that applied silently now carry notes. A `setParentBinding` that was stored is refused |
| 9 | **Publishers declare their channels.** Person Mask, Matte, Depth, MIDI In, OSC In, the inference nodes say what they can publish; a `.chan` read of a node that publishes none, or never that name, is NEVER | the unverifiable list in `channel-integrity.test.ts` shrinks; a wrong declaration refuses a working document |
| 10 | **What only the bus forbids, at rest; and loops at the connect.** Duplicate names and duplicate connections in `documentFindings`; `connect` refuses a wire that closes a same-frame loop; `valueGraph.cycle` at the write (T1600b) | a gesture that worked (wire the loop, then add the Feedback) is refused with the reason |

### 8.1 Slice 1 as built, where it differs from the plan above

Slices 0 and 1 are built. Slice 1 follows §3.3, with these differences, each found while building it:

- **A loop keeps its own code.** A reference that closes a cycle is `parameter.referenceCycle`, the code the whole-document check already had, at error and not `local` (it was an error before the rule). The resolver's guard fires one hop inside the loop, so the kind is passed up the chain; otherwise the parameter its author is looking at would say `upstream`.
- **"No channel resolver" passes up a chain too.** A read of a parameter that reads a channel is waiting on the same caller. While the tier came from a search of the message text this held by accident of quoting. Without it, 159 reads in the shipped examples became warnings at every structural compile (E55's haze reads the reactor's knobs). The re-run of §5's scan found it.
- **One code more than §3.3 lists:** `parameter.reference.unavailable` (ELSEWHERE, host), for a read with no graph to resolve `op()` in (`STORED_READ`). It was `parameter.expression` like the rest.
- **`parameter.reference.noChannel` is not emitted yet.** It needs slice 9. Until then such a read is `parameter.reference.channel`, as §3.3 says.
- **A scope name that holds no finite number is `value`, not `name`.** The evaluator said "unknown name" for both.
- **The messages keep their reasons and gain a suggestion.** The reason texts are unchanged, so every surface that shows a reason alone still names the grammar's functions. What to write instead is the diagnostic's `suggestion`: the rewrite in the author's own operands, the nearest spelling, the declared keys, or what in the graph is spelled like an unknown name. The mode panel now shows the suggestion beside the message.
- **The harness part of slice 3 that slice 1 could not do without.** `renderHeadless` takes `expectedFindings`: a fallback's own test names the `local` finding it renders through. A name that is not `local`, or that the render never produces, fails the render. It prints an error by the node's name, with its code and suggestion.
- **`stopsFinalRender` in place of `neverEffective`.** One question for every guard that stops a render: an error, a NEVER finding, a NOT YET finding, or a code nobody classed. `src/projects/on-nothing/render.ts` and three test guards ask it.
- **A ledger of retired codes.** The gate fails any file under `src/`, tests included, that still spells `parameter.expression` as a string, except the files listed as waiting on an edit this task does not own. A guard on a code nothing emits cannot fail, and this is what tells its owner.
- **The shipped-set gate of §7.4 is built now,** over what a structural compile says (`src/examples/never-effective.test.ts`, on `test:gates`). It reads `runExample` until `documentFindings` exists, so it does not yet see what only the write gate checks of a stored value.
- **`parameter.bind` was not split in slice 1.** It fails through another mechanism (`BindLookupResult`, and the parent scope's resolver inside a component), so it was slice 1b.

### 8.2 Slice 1b as built

`parameter.bind` is split by the kind of the failure, as §3.3 planned, with one code more:

| Code | Class | What it covers |
|---|---|---|
| `parameter.bind.unreadable` | NEVER, `local`, error | the ref names no parameter of this node, a component the parameter does not have, the parameter itself, or (through a parent scope that was handed over) no key the component publishes |
| `parameter.bind.type` | NEVER, `local`, error | what is bound is of another type: no value of it fits |
| `parameter.bind.value` | DEGRADED, warning | the bound value is past this parameter's limit or options at the moment; it reads at another value |
| `parameter.bind.unavailable` | BUILD, warning | the resolution was handed no parent scope, or no sibling schema. Not in §3.3, which sent "no parent scope" to `component.parentScope.*`: the resolver cannot tell a root node from a caller that brought no scope, and no product caller brings one, so calling it NEVER would be an error on every `parent.<key>` bind slot the inspector shows |

Two things the resolver does not do, which the tests state rather than hide:

- **A loop of binds is not the resolver's to report.** Its guard fires one hop inside the loop, and a bind reads what its sibling is in effect, fallback included, so the parameter at the top reads the fallback and says nothing. The whole-node check (`bindCycleDiagnostics`, at error) names the loop, as before.
- **A `parent.<key>` bind slot is baked at flattening**, where the scope exists, and a ref that does not resolve there is `compiler/component-parameter-conflict` (a warning, NEVER and `local` in the table). That code moves with slice 8.

### 8.3 Slice 2 as built

**One answer to "does this node declare this stored key".** `declaresParameter`, `undeclaredKeys` and `undeclaredParameter` in `src/domain/parameters/validate.ts`. The bus refuses a write with the finding; the compile reports what a document already stores with the same finding, in place of its own loop. `compiler/parameter-unknown` is gone (and in the gate's `RETIRED` ledger); `parameter.unknown` is an error at both moments and `local`.

What the finding says (B264 (2)):

- a part a compound does not have: `"eyeColor" is a colour, and its parts are r, g, b, a`, with the part that was meant (`eyeColor.x` → `Write "eyeColor.r".`; x, y, z, w and r, g, b, a name the same four places);
- an undeclared key: the nearest declared key, and every declared key with its parts (`eyeColor (.r .g .b .a), eyesAt (.x .y .z)`);
- the node's own naming rule, when its author wrote its keys: `NodeDefinition.parameterKeysNote`, set by the reflecting nodes (Custom WGSL, Custom WGSL · Multi, Material · WGSL, the two kernels) from the one list `looksLikeColour` tests, in `params-reflection.ts`;
- at rest, how the key leaves the document.

**What is not a key of nothing**, each held by a test:

- a look instance's own preset state. Fixed before the code became an error: the manifest and the flattener now read one list (`instanceOwnParameters`). Before, every compile after a recall on a look instance called `presetCurrent` undeclared;
- a node saved against another version of its definition, newer or older. The version mismatch is the finding (`compiler/definition-version`); "remove it" would lose what a migration reads. §8's plan said newer only. An older node is only ever met in a document that skipped `loadProject`, and its old keys are the migration's input;
- `retainedParameterKeys`, as before.

**An orphaned key** (a shader edit drops a field): the edit applies, the value stays stored, the compile says so as an error. It leaves by a patch operation, `removeParameters`, which removes only keys the node does not declare, and the command `parameter.removeUndeclared` (all such keys on a node, or the ones named), offered as `remove` on the Problems row. One patch, one undo step.

**B266.** The write gate refuses an expression on a parameter type no expression can drive (`parameter.expression.type`; one list, `EXPRESSION_DRIVEN_TYPES`, which the resolver's coercion is tested against). And the reflection of Custom WGSL and Material · WGSL reads the text a slot retains, as the kernels did, so a file built by code with such a slot gets the one true error and keeps its controls.

**Not in this slice: the rest of the write gate, at rest.** `validateParameters` checks more than keys: every retained payload of a slot (a stored static of the wrong type under a working expression, a payload under another mode's binding, an armed pulse). Those codes withdraw the plan (`parameter.type` is not `local`, because for the ACTIVE value the default really is what renders), so running them at the compile would stop a shipped document on a value that is inert. `projects/sentinel-bot/sentinel.loom.json` holds one today. They need the document check of slice 3, which reports without deciding plan usability, and a way to tell an inert retained payload from the active one.

### 8.4 Slice 3 as built

**A slot's payload in effect, and the payloads it keeps.** A slot reads one payload, its mode's, and keeps the rest (§V108). `storedParameterFindings` (`src/domain/parameters/validate.ts`) is the write gate's whole verdict on one stored parameter, each finding marked with whether it is about a kept payload; `validateStoredParameter` is its first finding, so the bus refuses what it always refused.

- A payload the gate refuses **under the slot's own mode** keeps its code (`parameter.type`, `parameter.range`, …). The default renders instead of it, and the plan is withdrawn, as before.
- The same payload **under another mode** is `parameter.retained`: NEVER, `local`, an error. Nothing reads it as the document stands. The day something would (the expression waits on a node that is not there, the mode is switched back) the fallback ladder refuses it and the DEFAULT stands in, with nothing said: that is measured (a boolean kept as the number 0, which its author meant as off, renders ON). The finding names the type to keep.
- One code at the write and at rest. The bus refused such a slot as `parameter.type`; it refuses it as `parameter.retained` now, since it is the same stored thing.
- The write gate's `parameter.expression.syntax` carries the grammar's rewrite (`pow(a, b)`: `a ^ b`), which only the resolver's finding had.

**`documentFindings`** (`src/compiler/document-findings.ts`) is one list of two things: the write gate over every stored node of the document's own graph and of every component definition in the catalogue, instanced or not; and the structural compile's diagnostics (wires, required inputs, loops, the flattening, each kept node's own compile, a cue list that follows the timeline). Each finding carries its class, `retained`, the node by name, the component it sits in, and `unreached` (no sink reaches the node). It reports and decides nothing. One stored thing is one finding: where the compile's resolver already says a code for a key, the gate's twin is dropped.

Not read yet, each with its slice: a bank's targets, values and recalls, a live cue list (7); a definition's own validation, an instance's override paths (8); a map on a node that maps nothing, a wire a port cannot bind (5); duplicate names and connections (10); a Value Expression's statements (6). `project.validate` is not its face on the bus yet.

**The save and the load for code.** `refusedAtCodeSave` is the rule: class NEVER at any severity (a kept payload included), an unclassified code, and an ERROR on a node a sink reaches (ruling 12). Let through: NOT YET that is not an error, ELSEWHERE, DEGRADED, ADVICE, and an error on a branch no sink reaches. This differs from §4.2 in one row: ELSEWHERE (build) is not refused by class. A type this build lacks is an error, so it is refused in the picture's path and let through beside it.

- `buildCheckedProjectFile` and `serializeCheckedProject` (`src/examples/checked-project.ts`) throw `DocumentRefused`, listing every refused finding as `<code>: "<node>" (<type>): <message> <what to write>`, before a byte exists. What they let through they write byte for byte as the unchecked save does.
- `requireExample` is the load: a script or test that reads a file to render it is refused the same findings. `runExample` still never throws, and carries `findings`.
- The app's save is not this door (ruling 8). It writes the file and returns what the write gate says is NEVER (`storedNeverFindings`) in the save's result and the Problems list. It runs no compile: the app's own is live.
- `never-effective.test.ts` fails any module under `src/examples` or `src/projects` that calls `serializeProjectDocument` or `buildProjectFile` itself, but the door and a strict ledger of one file (`src/projects/sentinel-bot/build.ts`, another session's). §4.2 planned an eslint zone; a ledger in the gate says who is waiting.

**The builder.** `expressionSlot(source, retained)` and `drivenSlot` take `number | boolean | string | readonly number[]`. `retained: number` left a boolean no right way to be written. The wrong type still compiles: a slot is built before it has a key, and a node's parameters have no type per key. It is refused at the build, by the checked save, with the node, the parameter and the type to keep.

**The harness reads every frame** (`render-harness.ts`).

- `findings` in the result: everything said about the render, once each by code, node and message, with the first frame it appeared at (`null` before any frame). At rest (`documentFindings`), the device's, every frame's plan and value graph. `diagnostics` is unchanged.
- At rest, a wrong thing IN EFFECT that only the write gate checks (a pulse stored armed, a payload under another mode's binding) stops the render. A kept payload and a finding inside a definition's own graph are returned and do not stop it.
- `strict: true` fails the render on everything `stopsFinalRender` names, at rest or at any frame. `stopsFinalRender` now includes `parameter.expression.value`: the clause both project guards wrote by hand. `src/projects/on-nothing/render.ts` passes `strict` in place of its guard.
- The animate trap: a render of a document that holds expression slots with `animate` off returns `harness.animateOff` (ACT, a warning; an error under `strict`, before a frame is stepped), with the count and up to three nodes named.

**The shipped-set gate** reads `documentFindings` of all 112 documents, and three frames of each (0, 1 and 30) through the real value graph with every node's parameters resolved at the frame: no GPU and no plan, about a third of a second. No finding of class NEVER may appear, and what still waits at a frame is a ledger held exactly (four reads of a live publisher's channel).

**The reasons left the app.** `classes.ts` was 47 % reason text (33.3 KB of 71.1 KB; minified 59.9 KB with it and 27.8 KB without, gzip 10.5 KB and 5.1 KB), and nothing in the product shows a reason. They are `class-reasons.ts`, held to the table in both directions by the gate, which also fails any other importer under `src/`.

## 9. Found on the way

None was fixed: this phase changes nothing under `src/`, and none is small enough to be safe without a test.

1. **Kaleidoscope reads out of itself** (§5.3). Measured.
2. **A code parameter in expression mode breaks its node's reflection.** `parametersFor` reads the stored `source` raw; a slot is not a string, so the schema falls back to the default shader's and the node's real controls read as undeclared. Measured (§1). Slice 4 refuses the write; the read should take the slot's static value in any case.
3. **A look instance's own preset state reads as undeclared, today.** An instance's manifest declares `presetCurrent` and `presetMorphs` when its component has a page bank (`definition.ts`), and the write gate accepts them. Flattening resolves the instance's page against `publishedSchema`, the published parameters only, so the compile says WARNING `compiler/parameter-unknown`: `Node "nd_bloom1" carries parameter "presetCurrent", which "component:bloom@1" does not declare.` Measured, on Bloom's shipped file with a page bank added to the definition and `presetCurrent` stored on the instance, in memory. No shipped file has a page bank, so no shipped file shows it; any document where a look instance has recalled a preset does, at every compile. It is the rule's own case in small: one stored key, two schemas, two answers. Slice 2 removes it by construction and must pin it with a test, because the warning becomes an error there.
4. **`node.valueExpression.syntax` cannot fire at rest** (§1). Measured.
5. **Per-frame diagnostics have no reader** (§2.2). By reading.
6. **Three codes with no product emitter**: `compiler/sink-format-undisplayable` (declared in the table, emitted nowhere), `project.limit.buffer`, `project.limit.dispatch` (tests only). By reading.
7. **`onInvalid` is never supplied** to a component session, so the ERROR form of `component.session.stale` reaches nobody, and an in-session edit that makes a definition invalid leaves the catalogue on the last valid graph in silence. By reading.
8. **Two comments name things that do not exist**: `flatten.ts` names a code `component.parentScope.notFound` (the code is `component.parentScope.no-scope`); `instance.ts` names a function `componentInstanceDiagnostics`. By reading.
9. **`node.scene.empty` says "no geometry is named" when every named geometry refused.** By reading.
10. **`component.parentScope.noScope` and `component.parentScope.no-scope` are two codes**, a warning on the command that stores the item and an error at the compile that reads it. By reading.

## 10. Questions for the lead's ruling

Each with what I recommend.

1. **Where the table lives.** The row says `problem-sources.ts`. The bus, the save path and the compiler cannot import `src/app`. *Recommend*: `src/domain/diagnostics/classes.ts`; `problem-sources.ts` applies it on the read side (§4.1).
2. **Severity against plan usability.** *Recommend*: a NEVER code is an error at every emitter; a row's `local` flag keeps the plan usable; every code that is a warning today and NEVER under the rule is `local` (§4.3). The alternative, leaving severities alone and letting callers ask the class, keeps the live app as it is and tells an agent reading `get_diagnostics` that a NEVER item is a warning.
3. **Seven classes, not four.** ADVICE, ACT and BUILD so that the gate's table is total; ELSEWHERE in two kinds because the code save refuses one of them. *Recommend*: accept.
4. **NOT YET in a headless render.** *Recommend*: returned, as today, with `strict: true` available and used by a project's final render. Making it the default would fail harness tests whose documents read a live publisher the harness does not have (E52, E53 and MatteCut, in the shipped set).
5. **A reference to a parameter the target does not declare, when the target's controls come from its shader.** NEVER (declare the field first, or do both in one patch), or NOT YET (the shader can grow the field). *Recommend*: NEVER. It is B264's own shape, and the order "declare, then reference" is always open.
6. **A same-frame loop through wires.** NEVER by class. Refusing it at `connect` changes a gesture. *Recommend*: class it NEVER now, refuse at the connect last (slice 10), as bind cycles and `op()` cycles are already refused.
7. **A component definition that reads a node of its host by name.** Today it works where the host has the name and silently not elsewhere. *Recommend*: NOT YET at rest for each instance it dangles in (visible once slice 1 lands), ADVICE at definition validation ("this definition reads `lfo_driftx`, which is not inside it"), and repair Kaleidoscope by publishing the two offsets or moving the LFOs in. That last part regenerates a shipped starter component: the owner's call.
8. **Save in the app when the document holds a NEVER item.** *Recommend*: write it and say so. Refusing a save loses work.
9. **A key a shader edit orphaned.** An error at rest with a Remove action (*recommended*, §4.6); or dropped in the same undo step; or exempt for nodes whose controls are reflected, which would reopen B264.
10. **A typed union of codes instead of a derived gate.** `RuntimeDiagnostic.code: keyof typeof DIAGNOSTIC_CLASSES` would make `tsc` the gate. It touches every helper signature and every test that builds a diagnostic. *Recommend*: the gate first; the type later, if the derivation proves leaky.
11. **Three rows where I class against a delegated reading.** A degenerate Corner Pin quad and a folded Grid Warp (read as NEVER; classed DEGRADED, because a corner dragged through another passes through that state and the output says so); a light whose Shadow Casters leave none of this Render's geometries (read as NEVER; classed ADVICE, because a light shared by two Renders may rightly cast in one). *Recommend*: as classed.
12. **How strict the code save is.** *Recommend*: it also refuses any error-severity finding on a node a sink reaches (a missing required input, a loop), since a script's output is meant to render.

## 11. What I did not read, and what I did not verify

- **Classed by name, producers not opened**: `media.*`, `mesh.*`, `native.*`, `osc.*`, `vision.*`, `laser.*`, `asset.reference.*`, `requirement.unmet`, `export.nonReproducible`, `audio.track.*`, and `backend/*` beyond its code table and the three sites where a failed build throws. 52 of the ELSEWHERE (host) rows rest on this.
- **The device path.** Whether a shader the device refuses always fails a headless render, or only when the build throws: not traced past `vgpu-backend.ts`'s three throw sites. The pipeline's later verdicts (`passBuildNotice`) were not followed.
- **Delegated and only sampled by me**: the node-definition family (I ran the map, More and Value Expression findings; the per-site readings of `scene.ts`, the point nodes and the kernels are the reader's), the preset and cue family (I checked which modules read a bank at all, and ran the at-rest scan; the routes by which a result reaches a person are the reader's), the component family (I read the flatten-time page schema for §9.3; the rest is the reader's). Each reader's own list of files not opened: for nodes, most texture nodes and `src/nodes/shaders/**`; for presets, the `.tsx` surfaces of `src/editor/controls/` and `morph-index.ts`; for components, every test and the open routes other than `project.open`.
- **The frame compiler.** `src/compiler/frame-compile.ts` was not read by me; that it never reads a definition's diagnostics is the node reader's statement.
- **The headless MCP server** (`src/mcp/serve.ts`) beyond its problem sources and its compile-and-render: whether it has an open-file door that the code-load rule should cover.
- **The agent tools for presets, components and previews** (`src/agent/tools/{presets,components,preview}.ts`): only what the readers reported.
- **Every test file.** No test was run. `pnpm typecheck` was not run: nothing under `src/` changed.
- **Inactive payloads.** The shipped set holds none (every slot's only payloads are its active one and its static), so "the write gate checks every retained mode and the compile checks only the active one" is by reading, with no shipped case behind it.
- **The count of 602** is the census's. A code built in a way neither the parser nor a reader saw is not in it.
- **The scripts.** The census, the scans and the repro are in the worktree's `scratchpad/t1641/` (gitignored, not committed): `census.mjs`, `consolidate.mjs`, `classes.mjs` (the class of every code, the draft of slice 0's table), `tables.mjs`, `scan.ts`, `scan-inner.ts`, `scan-static.mjs`, `repro.ts`, `kaleidoscope.ts`, `look-state.ts`.
