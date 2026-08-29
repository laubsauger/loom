# Gap Analysis & Spec Amendment Proposals — 2026-08-29

**Audience:** orchestrator. Purpose: update SPEC.md (§C/§I/§V/§T/§P) and re-coordinate tracks before/at the wave 2 barrier.
**Source:** review of SPEC.md, `docs/vgpu-visual-node-compositor-implementation-handoff.md`, and the wave 0/1 implementation (commits `8be0189..24bdf2f`).
**Status:** complete. Architecture findings (§1–9), locked product decisions from owner interview (§10), weave-in sequencing for the in-flight wave 2 (§10b), code-level review findings with file:line (§11).

Legend per item: **Severity** (how hard it bites later) · **Timing** (when it must land) · **Contract impact** (additive vs. frozen-contract change requiring barrier + broadcast per §P rules).

---

## 1. Color management has no invariant

**Severity: high · Timing: before track E (compiler) ossifies format propagation · Contract impact: PortType change → barrier**

Handoff §16.2 mandates: linear working space, decode display-referred media to linear on load, tone-map/encode at display output, label data textures so they bypass conversion. SPEC carries only crumbs (`rgba8unorm-srgb` in the format override, V13 "no implicit conversion"). Nothing states *which space a texture edge is in*, so the compiler about to be built (T27/T28/T75) will propagate formats with no color semantics, and every node shader will make its own silent assumption. This is the single most common source of "why does my comp look washed out" bugs in this product category, and retrofitting color tags after 30+ nodes exist means auditing every shader.

**Proposed spec changes:**
- New §V invariant: *project working space = linear RGB. Media/import nodes decode to linear. Encode + tone-map happens only in Output/display nodes. Texture carrying non-color data flagged `data`, bypasses all color conversion. No node silently mixes encoded and linear values.*
- Extend `texture2d` port type: `space: "linear" | "encoded" | "data"` (default `linear`). Exact-match under V13; conversion = visible node, consistent with existing philosophy.
- New task (track E): compiler propagates/validates `space` alongside format; mismatch → diagnostic naming the conversion node to insert.
- `ProjectSettings` gains the display output transform choice (start: plain sRGB encode; HDR tone-map later).

---

## 2. Compute/buffer path is second-class in the plan IR

**Severity: high · Timing: track E day 1 · Contract impact: `RenderBackend` + plan IR change → barrier**

Port union declares `buffer`, but everything downstream is texture-shaped: `RenderBackend.resize(outputId, [w,h])`, `readOutput(): Uint8Array` with no element typing, and all wave-2 compiler tasks (T24–T33) describe texture passes. GPU particles / reaction-diffusion / simulations are a committed differentiator (handoff §1, §35.4, §35.5). If the compiler's pass model lands as "list of fullscreen render passes," adding compute later is a rewrite of scheduling, resource assignment, and the backend contract.

**Proposed spec changes:**
- §I: `LogicalExecutionPlan` pass model specified as a discriminated union now: `{ kind: "render" } | { kind: "compute" }` — even though v1 emits only `render`. Resource model likewise: `texture | buffer` union with size/usage/element metadata.
- §I `RenderBackend`: split readback into `readTexture(outputRef)` and `readBuffer(outputRef)`; both stay behind the export interface (V48).
- New §V invariant: *plan pass kind and resource kind are closed unions defined in domain types; compiler and backend switch exhaustively — adding a kind is a type error until handled everywhere.*
- Track E instruction: topo sort, sink pruning, and resource assignment operate on the union, never on a texture-only assumption.

---

## 3. Output identity: node-scoped vs. port-scoped ambiguity

**Severity: high · Timing: before track E + any further backend use · Contract impact: type-level clarification → cheap now, expensive in 3 weeks**

`resize(outputId, …)`, `readOutput(outputId)`, `set_output`, `render_preview` all take a bare `outputId` string. Is that a node or a port? Phase 3's `Render3D` emits color + depth + normals + objectId from one node (handoff §32.4), and even Phase 1 debug nodes may want multiple outputs. If `outputId == nodeId` bakes in anywhere, multi-output becomes a migration.

**Proposed spec change:**
- §I: define `OutputRef = { nodeId: NodeId; portId: PortId }` (or the canonical serialized form `"${nodeId}/${portId}"` — pick one, state it). All backend/export/preview/tool surfaces take `OutputRef`. Single-output nodes get a well-known default port id (e.g. `"out"`), so ergonomics don't suffer.
- Audit T54–T58 tool schemas to use `OutputRef` before track O starts.

---

## 4. Parameter modulation seam missing (the CHOP problem)

**Severity: high (product-defining) · Timing: seam now, feature later · Contract impact: one new invariant + one resolver module — additive if done before inspector (track G) and compiler (track E) read params ad hoc**

TouchDesigner's actual moat is not TOPs — it's CHOPs driving any parameter (audio, LFO, MIDI, math). Handoff §8.2 defers keyframes/expressions/MIDI/audio-modulation but says "design the schema so it can later support" them. Current schema has no such seam: nothing distinguishes a static value from a driven one, and once tracks E and G read `GraphNode.parameters` directly in a dozen places, adding modulation means touching every reader.

**Proposed spec changes (cheap now, unlocks everything later):**
- New §V invariant: *all parameter reads (compiler, runtime uniforms, inspector display of effective value) go through a single `resolveParameters(node, frame)` in `src/domain/parameters`. No other code reads `GraphNode.parameters` for evaluation.* v1 resolver is a passthrough of static values — trivial — but it is *the* future injection point for expressions, curves, audio features, MIDI, and parameter linking, all of which then arrive without touching node definitions or compiler.
- Reserve the schema envelope: `ParameterValue` becomes (or is documented as migrating to) `{ kind: "static", value } | { kind: "bound", … reserved }`. If changing the zod schema now is too disruptive mid-wave, at minimum spec the invariant + resolver so the read path is already centralized.
- Roadmap note in §C: signal/channel family ("CHOP-equivalent": audio analysis, LFO, math-on-channels, MIDI/OSC in) is the expected Phase 2/3 headline; `audioFeatures` + `event` port kinds and the resolver are the prepared seams.

---

## 5. Perform mode / dedicated output surface absent

**Severity: medium-high (product gap) · Timing: arch prep now, feature Phase 2 · Contract impact: additive**

Live performance is "the product center" (§C committed) — yet there is no notion of an output surface separate from the editor. TD's perform mode (fullscreen output, editor hidden or on another display) is table stakes for VJ/installation use. Browser reality: second window via `window.open` + canvas there, or fullscreen the viewer canvas, or (best) render in a worker with `OffscreenCanvas` and post to any number of surfaces.

**Proposed spec changes:**
- §C committed: add *perform mode = Phase 2 deliverable: main output presentable fullscreen and/or in a second window; editor UI fully detachable from render continuity (opening/closing panes never stalls output).*
- Arch prep invariant now: *the presentable output surface is handed to the runtime, not owned by app-shell React tree; runtime supports N presentation surfaces for the same compiled output.* This is nearly free while the backend adapter is young.
- Open product question logged in §C open: single fullscreen toggle vs. true multi-window; display-selection UX.

---

## 6. No worker story — main-thread everything

**Severity: medium-high · Timing: invariant now, migration later · Contract impact: additive (lint + serializability rule)**

React, xyflow, CodeMirror, compiler, and the GPU frame loop currently all share the main thread. At 200+ nodes with live previews, GC pauses and React commits will fight the frame loop. The production path is compiler and/or renderer in a worker with `OffscreenCanvas`. Retrofitting workers is brutal *only if* non-cloneable things (closures, DOM refs, class instances) leak into the plan or the runtime inputs.

**Proposed spec changes (prep only, no worker in v1):**
- New §V invariant: *`LogicalExecutionPlan`, `FrameEvaluationInput`, and everything crossing the compile/render boundary is structured-clone-safe data — no functions, no DOM references, no class instances. `NodeDefinition.compile` output is plain data (WGSL text + binding descriptions), never callbacks.*
- Extend lint guardrails (track D pattern): no `document`/`window` access in `src/compiler/**` and `src/runtime/**` (except the single surface-attachment module in the backend).
- §C open question: which side moves to a worker first when profiling demands it (renderer w/ OffscreenCanvas is the likely answer).

---

## 7. Autosave / crash recovery missing

**Severity: medium · Timing: wave 3 (track M) · Contract impact: additive tasks**

Single `.loom.json` + explicit save. A creative tool that loses 40 minutes of patching to a GPU device loss or tab crash loses the user. Browser gives us IndexedDB/OPFS for cheap local versioned snapshots.

**Proposed spec changes:**
- New tasks (track M): dirty-state tracking surfaced in title bar; periodic + on-mutation-debounced snapshot of the ProjectDocument to IndexedDB/OPFS (bounded ring, e.g. last 20); restore-on-launch flow ("recovered newer version — open?"); explicit save still writes `.loom.json`.
- Invariant: *snapshot = same serialized ProjectDocument as save (one serializer, V10 applies). Runtime state never snapshotted.*
- Note: revision counter + audit log already exist — snapshots keyed by revision come almost free.

---

## 8. `ProjectSettings` referenced but never specified

**Severity: medium · Timing: now (contract freeze says types are frozen — this one escaped) · Contract impact: additive field definitions on existing empty type**

`ProjectDocument.settings: ProjectSettings` exists in §I with no shape. Compiler (project resolution, working format), RNG (project seed), caps (V24 budget), and color policy (item 1) all need it.

**Proposed spec change — define in §I now:**

```ts
interface ProjectSettings {
  outputResolution: { width: number; height: number };
  workingFormat: "rgba8unorm" | "rgba16float";
  colorPolicy: { workingSpace: "linear"; displayTransform: "srgb" };
  projectSeed: number;
  memoryBudgetMB: number;
  previewResolutionLongEdge: number;   // default 192
  previewMaxFps: number;               // default 30
}
```

Zod schema + defaults + inclusion in migration scaffolding (T43).

---

## 9. Secondary findings (log, lower urgency)

- **Preview atlas positioning (T34, track J):** one shared GPU canvas under/over the xyflow viewport means tile rects must track pan/zoom transform every frame, and z-ordering with DOM node chrome is fiddly. Ask track J for a short design note *before* implementation: atlas-canvas-behind-DOM vs. per-node `<canvas>` fallback threshold, and how tiles handle devicePixelRatio + zoom.
- **Expression input:** handoff §8.1 "text entry supports arithmetic expressions where safe." No language decision. Recommend: defer full expressions, but route numeric text entry through one tiny safe evaluator module from day 1 so it's one file to upgrade. Determinism: expressions must consume `FrameEvaluationInput` only (V44 applies).
- **CI:** track D owns `.github/**`; verify a workflow actually runs lint + typecheck + unit on push. If absent → immediate small task.
- **PWA manifest:** committed in §C ("deploy: browser-only + PWA-ready manifest") but no §T task. Add one (trivial, wave 3+).
- **Audio-reactive roadmap position:** excluded v1 (correct), but it is the #1 requested capability in this product's audience. Recommend §C note pinning it to early Phase 2, riding on the item-4 resolver seam + `audioFeatures` port.
- **MIDI/OSC:** WebMIDI is browser-native (easy); OSC needs a WebSocket bridge (needs the desktop-adjacent helper story eventually). Log as Phase 2/3 open question; both are consumers of the item-4 seam, no core changes needed.

---

## 10. Locked product decisions (owner interview, 2026-08-29)

These are decided. Orchestrator: encode into SPEC §C decided / §I / §V and remove the corresponding §C open questions.

1. **Color:** `space: "linear" | "encoded" | "data"` joins the `texture2d` port type (item 1 as proposed). Linear working space, decode at load, encode+tone-map at output only. Contract change — broadcast immediately; T27/T28 consume it.
2. **Param modulation:** resolver invariant AND `ParameterValue` envelope migration (`{ kind: "static", value } | reserved bound variants`) both land now, before any `.loom.json` exists in the wild. Same stroke fixes D8's closed-union anti-V10 problem — envelope schema gets a passthrough lane for unknown kinds.
3. **Perform mode:** **full multi-window output is a committed Phase 2 deliverable** (multiple displays, VJ setups) — not just arch prep. Presentation seam (R6) must therefore be designed now: backend supports N presentation surfaces per output; surface ownership lives outside the React tree.
4. **Revision contention:** param-only carve-out. Patch ops get classified; value-only changes (params, positions) on disjoint entities do not conflict with structural patches; stale `baseRevision` rejects only on actual entity overlap. Amends V33 semantics — spec the classification table.
5. **Workers:** renderer-in-worker is **committed for Phase 2** (worker owns device + all surfaces; windows transfer `OffscreenCanvas` in — this is also the multi-window transport). v1 stays main-thread, but structured-clone invariant, DOM-free lint for compiler/runtime, and a non-rAF loop option land now.
6. **Audio-reactive:** early Phase 2 headline. AudioIn (mic/file) → analysis node (FFT bands, beat, envelope) → params via the resolver seam. First real consumer proving the modulation architecture. **WebMIDI ships alongside it** (second seam consumer). OSC waits for the bridge/helper story (Phase 3).
7. **Expressions:** custom minimal grammar — own small parser (jsep-style AST, whitelisted functions, variables only from `FrameEvaluationInput` + node context). Deterministic by construction (V44/V45 safe), sandboxed by construction, versionable. v1 ships arithmetic-only behind the single evaluator module; grammar grows later. Resolves the §9 expression note.
8. **Autosave:** IndexedDB snapshot ring, 2s debounce after last mutation, keep last 20 + one per 10 min pinned, restore-on-launch prompt. Manual save still writes `.loom.json`.
9. **Recording (resolves §C open ?):** first realtime export milestone = WebCodecs → mp4 (VideoEncoder, exact-frame capture from the render loop, no MediaRecorder stopgap). Chrome ≥128 baseline guarantees WebCodecs.

## 10b. Sequencing — weave-in plan (wave 2 already in flight)

Owner's call: **no wave-1.5 barrier** — wave 2 tracks are already cooking. Weave fixes and contract deltas in where necessary. Concretely:

**Broadcast immediately (contract deltas — every in-flight track gets these before writing more code against old shapes):**
- `OutputRef = { nodeId, portId }` everywhere an output is named (item 3).
- Plan IR pass/resource discriminated unions incl. `compute`/`buffer` (item 2, R11).
- `texture2d.space` field (decision 1).
- `ParameterValue` envelope + `resolveParameters()` module (decision 2) — stub is ~30 lines, land it before tracks E/G read params ad hoc.
- `readTexture`/`readBuffer` returning descriptor + bytes (R5).
- Presentation seam on `RenderBackend` (R6 + decision 3).
- `ProjectSettings` shape (item 8).

**Per-track gates (orchestrator enforces before merge, not before start):**
- **Track E (compiler):** MUST NOT build on the whole-plan signature (R2) — rebuild granularity is per-resource diff/reuse; feedback pairs survive unrelated edits. Must consume `space`, overrides, `OutputRef`, and the pass-kind union exhaustively. Reconcile the two resolution-change paths (R4) as part of T27/T72.
- **Track G (inspector/controls):** all param reads via resolver; no direct `GraphNode.parameters` evaluation.
- **Track H (shader editor):** blocked on shell owner deciding dock keep-mounted semantics (U3) + lazy-boundary convention (U5). Small track-A follow-up, do first.
- **Track F (graph view):** needs group/viewport patch ops (D13) and ContextMenu sub/checkbox parts (U11) — raise to owners, don't fork.
- **Track Q (keymap):** unaffected by contract deltas; proceed.

**Hotfixes routed to path owners, merge-priority flagged (each multiplies cost for every task built on top):**
- Track C owner: R1 (resize binding bug — real breakage), then R3, R9, R10.
- Track D owner: U1 + U2 (lint bypasses — must hold before more node/runtime code lands), U7 (CI build step + e2e honesty).
- Track B owner: D1 + D2 (undo/redo blockers), D3 (patch input zod + bus error→diagnostic+audit), then D8 passthrough lane, D6 (audit ring + commit cost — before T49 soak), decision-4 op classification.

**New backlog tasks from decisions:** perform-mode/multi-window (Phase 2, new track), renderer-in-worker (Phase 2), AudioIn + analysis + WebMIDI (Phase 2, resolver consumers), expression evaluator module (v1 arithmetic), autosave ring (track M), WebCodecs mp4 export (extends T68 line), PWA manifest task (§9).

---

## 11. Code-level review addendum

Three parallel reviewers: domain (`src/domain/**`, `src/nodes/registry/**`), runtime (`src/runtime/**` + vgpu internals cross-checked), UI/guardrails (`src/ui/**`, `src/app/**`, configs, CI — lint bypasses probe-confirmed against the real eslint config). 252 tests pass. Overall calibration: wave 0/1 foundations are genuinely good — atomic patch via immer draft-discard, real device-loss rebuild, real V5 uniform-only path, token discipline self-tested, thin vgpu boundary (4 files). The findings below are what stacks badly if uncorrected.

### 11.1 Domain layer

**D1 · blocker — redo clobbers another actor's work (V41 half-enforced).** `src/domain/graph/store.ts:352` — owner-conflict check runs only for `direction === "undo"`. When undo skips a blocked entity, the original group still lands intact on the redo stack (`store.ts:263-265`); redo re-applies `after` for all entities with no owner check. A sets X=1 → B sets X=2 → A undo (blocked) → A redo → B's work silently erased. No test covers it. Surfaces the moment agent + human edit concurrently.

**D2 · blocker — undo has no referential integrity.** `store.ts:371-393` — restore writes recorded entity values back with no cross-checks. A adds node N; B connects edge E to N; A undoes → N deleted, E dangles at a missing node. V40's cascade lives only in the `removeNodes` patch op, not in restore. Corrupts document for compiler and save.

**D3 · blocker — no structural validation of patch input; malformed agent JSON escapes atomicity AND audit.** `src/domain/types/patch.ts:13-23` has no zod schema; `apply-patch.ts:104-108` catches only `PatchAbort`; bus handler not try/caught (`bus.ts:352`). `{op:"addNode"}` without `position` → raw TypeError, no audit entry (V31 hole), unhandled rejection instead of diagnostic. Also `addNode` accepts non-finite positions (`apply-patch.ts:239`) → NaN serializes to `null` → document fails schema on reload. V37 says untrusted; code trusts compile-time types.

**D4 · design-risk — dryRun returns `status:"applied"` and leaks real minted ids (V36).** `apply-patch.ts:110-132`. dryRun-then-apply yields two different id sets; callers may cache phantoms. Should return distinct status (`"validated"`) and no real ids.

**D5 · design-risk — capability grants are caller-supplied → V38 currently self-grantable.** `bus.ts:218-230` reads `context.capabilities` straight from invocation; any adapter can fabricate grants. Real design: bus-owned grant store keyed by actor. Also invalid `expiresAt` → `Date.parse` NaN → valid forever; `Date.now()` wall-clock in domain uninjectable.

**D6 · design-risk — O(whole-document) commit + unbounded audit log.** `store.ts:142-155` diffs by sorting ALL node/edge/group keys per apply — 1000 nodes × 60Hz drag ≈ 180k sorted-key ops/sec over frozen immer tree. `store.ts:293` copies whole audit array per commit; 60Hz drag appends entries unboundedly → quadratic memory over session. `owners` map copied per commit, never pruned. Fix: immer patches for dirty-key tracking, audit ring buffer, owner GC.

**D7 · design-risk — human 60Hz drags starve agent patches.** Every drag tick bumps `revision`; any agent `baseRevision` stale within 16ms of live dragging. Conflict-no-rebase correct per V33, but no queue / per-scope revision / param-only carve-out. T62 gate will pass in a quiet test and be unusable next to a live human. Design decision needed before wave 4. *(Product decision — see interview.)*

**D8 · design-risk — migration story types-only; closed param schema is anti-V10.** `NodeDefinition.migrate` never called; no loader, no schemaVersion gate, no `src/domain/migrations/`; `definitionVersion` written once, never read. Frozen landmine: `parameterValueSchema` (`schemas.ts:48-55`) closed union → future-version doc fails whole-document parse — opposite of V10 "preserved, not dropped". Add passthrough/preserve lane before files exist in the wild.

**D9 · design-risk — V34 conventional, not structural.** `store.ts:220-227` coalesces only with caller-supplied `transactionId`; future multi-apply handler → two undo groups per command. Bus should mint a default per-invocation transactionId. Transaction groups also never close.

**D10 · design-risk — live clock: absolute time unclamped, reset incomplete.** `live-clock.ts:33-45` — delta clamped but `timeSeconds` raw `performance.now()`: 10-min backgrounded tab → time-driven nodes jump 600s while delta-driven sims step 0.25s, divergence in one graph. `reset()` zeroes frameIndex, not time base. Accumulate time from clamped deltas.

**D11 · design-risk — V29 has no lint; store backdoors exported.** `store.ts:131` exports `raw`; `createDomainBus` hands back `internals`. Clean today (checked), but V3/V11/V44 got lint and V29 didn't — restrict importing `internals`/`raw` outside `src/domain/commands` + tests. Also `setAutoFreeze(true)` at `store.ts:25` is a global immer side effect — will freeze the app's other immer stores; editor tracks should know.

**D12 · design-risk — fully-blocked undo consumes the history entry** (`store.ts:352-417`): empty commit, revision bump, "applied" audit, entry popped. User sees nothing happen and loses the entry. Reject without consuming.

**D13-17 · nits.** Patch-op asymmetries: `removeNodes`/`disconnect`/`moveNodes` take no temp refs; edges without `ref` unaddressable in-patch; NO ops for groups/viewport at all — groups undoable but uncreatable via sole mutation path. Registry: definitions held by mutable reference, no unregister, duplicate-register throws → breaks Vite HMR for node definitions. `z.record` never asserts `nodes[k].id === k`. Spec/code PortType drift: code has `geometry.topology`, `material.model`, `scene|material|light|transform3d` kinds — SPEC §I union doesn't; amend spec to match code. RNG seed collapses to 32-bit (`rng.ts:48`) — `Date.now()`-scale seeds collide.

### 11.2 Runtime / backend

**R1 · blocker — `resize()` breaks every downstream consumer of a plain target.** `resources.ts:121` binds `plain.color` (the Texture) into effects; vgpu auto-rebinds across resize only for `Target` objects (`vgpu/dist/set-resources.js:56-62`). `Target.resize()` destroys/recreates textures → after `vgpu-backend.ts:447` any pass sampling that target holds a destroyed texture. `rebindDynamicTextures` re-points only ping-pongs. Test at `vgpu-backend.test.ts:415` resizes an output, never a *sampled intermediate*, so can't catch it. Fix: bind the Target itself (vgpu supports it) or subscribe `onTexturesRecreated`.

**R2 · blocker (design) — any structural edit nukes the whole program including all feedback history.** `compile()` keys on whole-plan signature (`vgpu-backend.ts:391-417`): adding an unrelated node → new ResourceSet → zeroed ping-pongs → every feedback loop resets, contradicting V22/V50 "reset only when the pair itself changed". Also `compileSync`s every pipeline (`resources.ts:154`) — edit hitch scales with graph size; uniform *key set* is in the signature (`plan.ts:363`) so adding one param to one node triggers it too. **Decide rebuild granularity (per-resource diff/reuse) BEFORE track E builds on whole-plan signatures.**

**R3 · design-risk — WGSL compile failures never reach `onDiagnostic`.** `buildResources` throws `ResourceBuildError` (`resources.ts:172`); `compile()` reports only plan-read diagnostics. Problems tab wired to `onDiagnostic` misses shader errors. V9 "stale flag" has no representation anywhere.

**R4 · design-risk — `resize()` and compile signature diverge.** Resize mutates live targets but `resourceDescriptors`/signature keep old size (`vgpu-backend.ts:447-463`): next compile w/ new sizes → spurious full rebuild (→ R2 feedback wipe); w/ old sizes → descriptors silently lie. Two resolution-change paths (V21 propagation vs `resize()`), no reconciliation rule. *(Interacts with items 2/3 above — fold into plan-IR redesign.)*

**R5 · design-risk — `readOutput(): Promise<Uint8Array>` underspecified → guaranteed breaking change.** No width/height/format/row-stride metadata; rgba16float bytes uninterpretable; no mip/layer/slice selection possible later; vgpu's `readFloats()` inexpressible. Return descriptor + bytes now. *(Merge with item 3 `OutputRef` change — one contract amendment.)*

**R6 · design-risk — no presentation path exists.** `initialize()` accepts `canvas` and ignores it (`vgpu-backend.ts:356-370`); nothing creates a surface or blits; V7 preview has no mechanism and V2 forbids React doing it. `RenderBackend` needs a present/view-registration seam — design before contract calcifies. *(Merge with item 5 perform-mode surface ownership — same seam.)*

**R7 · design-risk — V24 entirely aspirational.** `plan.ts:115` accepts any positive finite size (fractional included); nothing clamps vs `capabilities.limits`; no memory accounting. 30k×30k target → device loss.

**R8 · design-risk — capability format report is fake.** `capabilities.ts:39,74` hardcodes `TEXTURE_FORMATS`; `meetsBaseline` rgba16float check tautological. V51 validation has no real data. `r32float` user-selectable but filterable-sampling needs `float32-filterable` — surfaces only as late vgpu bind error.

**R9 · design-risk — device-loss recovery terminal on failure.** `rebuild()` (`vgpu-backend.ts:246-255`): one failed re-acquire → `halted` forever, no retry API; `loop()`/`compile()` during recovery window throw instead of queue/report.

**R10 · design-risk — no error boundary in frame loop.** `frame-driver.ts:48-59` catches nothing; a throwing `render()` explodes in vgpu's rAF every frame. `frameError`/`submissionHalted` diagnostic codes exist (`diagnostics.ts:21-22`) but are emitted nowhere.

**R11 · design-risk — pass/resource vocabulary fragment-effect-only.** `plan.ts:49-99`: passes = `effect|swap`, resources = `target|pingPong|sampler`. No compute/storage/MRT/draw/mipmaps — all of which vgpu ships. Confirms item 2 above; extending is additive EXCEPT `readOutput`/`resize` single-texture assumptions (R4/R5) — those are the actual break points.

**R12-15 · nits.** Diagnostic flooding: stale-plan warn per frame @60fps, hub has no dedupe/rate limit (`diagnostics.ts:53`). f32 time precision: `shared-uniforms.ts:20-27` packs absolute time as f32 → >1ms quantization after ~3h — installation use case stutters; rebase time or f32 pair. Per-frame small allocs in `render()` (pool later; no readback in loop — V7/V48 clean). Pipeline/effect accumulation: vgpu `Effect` has no destroy; hours of shader edits grow the shared render-service cache unboundedly — T49's 10-min gate may pass while memory creeps; vgpu API gap, track upstream.

**R16 · seam quality notes.** Frame driver transport injection genuinely swappable; `step()` real headless path (verified `render()` opens its own frame). Caveat: `backend.loop()` = vgpu rAF `frameLoop` — worker/Node realtime needs a non-rAF loop (trivial to build on `frame()`). `step()` during live loop double-renders — no guard. vgpu coupling thin + survivable: 4 files, ~1000 lines replacement cost, version pinned 0.3.1; three load-bearing leaks (duck-typed `destroy()`, private `GPUDevice.lost` reach-in at `gpu-host.ts:52`, mock instrumentation types) — keep commented as such.

### 11.3 UI / guardrails / infra

**U1 · blocker — V3 lint bypassable.** Probe-confirmed: `import("vgpu")` (dynamic) and `import "vgpu/webgpu"` (unlisted subpath) pass clean. `eslint.config.js:20` uses exact-specifier allowlist; core rule never sees `ImportExpression`. Fix: `patterns` with regex `^vgpu(/|$)` + `no-restricted-syntax` selector for `ImportExpression[source.value=/^vgpu/]`.

**U2 · blocker — V44 lint catches only literal spellings.** Probe-confirmed bypasses in `src/nodes/**`: `window.performance.now()`, `globalThis.performance.now()`, aliased `const p = performance; p.now()`, `self.requestAnimationFrame()`. T70 (Noise node) is next wave — exactly where someone writes this reflexively. Add member-expression selectors + restrict the `performance` global identifier in that tree. Note runtime/UI trees aren't covered at all (`eslint.config.js:153`).

**U3 · design-risk — Radix Tabs unmounts inactive dock content.** `bottom-dock.tsx:52-68` no `forceMount` → CodeMirror (T20) dies on every tab switch: scroll/selection/setup lost; perf-tab subscriptions churn. Decide keep-mounted semantics in shell NOW, before track H builds against remount. Interacts with U5 (lazy + forceMount designed together).

**U4 · design-risk — V17 guard has `.ts` blind spot + color-fn gaps.** `tokens.test.ts:25` scans only `.tsx`/`.css`; misses `lch(`/`oklab(`/`hwb(`/`light-dark(`/named colors. Edge/node colors for xyflow (T18/T19) come from TS objects — `stroke: "#4fd1c5"` in `.ts` passes today. Extend walker to `.ts` (excl. tests).

**U5 · design-risk — no code-splitting seams before heavy deps land.** Everything eager in `main.tsx`/`app.tsx`; CodeMirror (7 pkgs) + xyflow enter the main chunk the moment wave 2 fills slots. Shell owns slot mounting → shell should establish lazy-boundary convention (dock tab content lazy, canvas lazy) before five tracks wire in.

**U6 · design-risk — collapse state can desync from persisted layout on reload.** `app-shell.tsx:79` inits `collapsed` all-false; persisted 0-size group may mount collapsed without `onCollapse` firing → LayoutMenu lies, two-click toggle. `isValidGroup` accepts `[100,0]` vs `minSize={12}`. One jsdom test w/ collapsed persisted layout closes it.

**U7 · design-risk — `pnpm test:e2e` fails today; CI never builds.** Playwright dir `src/tests/e2e` doesn't exist → "no tests found" error, yet §I lists it as a working command (Rule 8: add one smoke spec or drop the script until T48). `.github/workflows/ci.yml` runs lint+typecheck+test, never `pnpm build` — Vite-build-only breakage ships green. Add build step.

**U8 · design-risk — TopBar callback props pre-empt bus (T51/V29).** `top-bar.tsx:10-14` `onPlayPause`/`onStep`/`onResetTime` closures = plumbing T51 must rip out. Fine as slot boundary if eventual wiring is `bus.execute("play")` — comment it so tracks don't copy the pattern into inspector/library.

**U9-13 · nits.** Token gaps: spacing stops @24px, single `--radius`, z-index ladder lacks canvas-overlay + toast slots, no disabled-text/selection-accent tokens — add before wave 2. ContextMenu missing SubTrigger/SubContent/CheckboxItem/RadioItem — track F needs bypass/mute toggles + add-node submenus. TopBar a11y: disabled buttons in Tooltip = unfocusable + tooltip-less (prefer `aria-disabled`), `aria-label` on bare spans, focusable non-widget tier span — this is the V19 reference impl others will copy. Layout persisted synchronously per drag frame (`app-shell.tsx:88-94`) — debounce. `package.json` lacks `packageManager` field (CI pins pnpm 9 — drift risk); `@radix-ui/react-slider` dep unused (reserve for track G, comment it). PWA manifest absent (see §9).

### 11.4 Fix-first ordering (orchestrator queue)

**Now, before any wave 2 code (small, sharp):**
1. R1 resize texture-binding bug (real bug, bounded fix).
2. U1 + U2 lint bypasses (guardrails must hold before agents write node code).
3. D3 patch input zod validation + bus-level error→diagnostic+audit (agent surface correctness).
4. D1 + D2 undo/redo multi-actor fixes (redo owner check; referential-integrity pass or edge-cascade on restore).
5. U7 CI build step + e2e honesty.

**At wave 2 barrier (fold into the §10 contract changes):**
6. R2 + R4 rebuild-granularity decision — joint with item 2 plan-IR redesign; track E must NOT build on whole-plan signature.
7. R5 readback descriptor — joint with item 3 `OutputRef`.
8. R6 presentation seam — joint with item 5 perform-mode prep.
9. D8 schema forward-compat passthrough lane (before any `.loom.json` exists in the wild).
10. U3 + U5 dock keep-mounted + lazy-boundary convention (before track H).
11. D13 group/viewport patch ops (before track F needs them).

**Scheduled (new tasks, not blocking):**
12. D6 commit-cost + audit ring (before 1000-node graphs, i.e. before T49 soak).
13. D5 bus-owned grant store (with T59).
14. D4 dryRun status; D9 structural transactionId; D10/R-nit time-base fixes (joint: clamped accumulated time + f32 rebase); D11 V29 lint; D12; R3 diagnostics routing; R7 caps (with T44); R8 real capability query; R9/R10 recovery + frame error boundary; R12 diagnostic dedupe; U4 token guard `.ts`; U6 collapse test; U9-13 nits.
15. D7 revision-contention design (before wave 4 track O). *(Interview decision.)*
