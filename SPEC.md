# SPEC

## §G GOAL
Browser WebGPU node compositor: typed graph → compiled pass plan → live multi-branch preview, dark pro-tool UI, agent-drivable via 1 semantic command bus. Phase 0 + Phase 1 of `docs/vgpu-visual-node-compositor-implementation-handoff.md` only.

## §C CONSTRAINTS

### stack (locked)
- React 19 + TypeScript strict + Vite. pnpm.
- graph UI: `@xyflow/react`. presentation & gesture only.
- GPU: `vgpu` (vercel-labs), exact pinned version.
- state: `zustand` + `immer`. selective subscriptions.
- panes: `react-resizable-panels`. persisted layout.
- shader editor: CodeMirror 6 (⊥ Monaco — bundle size, theming to tokens).
- primitives: Radix UI, fully restyled.
- style: CSS vars + CSS modules. ⊥ Tailwind.
- validation: `zod`.
- test: `vitest` (unit + `vgpu/mock`), Dawn headless node render, `playwright` browser.
- persist: versioned JSON, ext `.loom.json`.

### scope
- ⊥ .toe / Notch import. ⊥ NDI/Spout/Syphon/capture. ⊥ native plugin ABI.
- ⊥ marketplace. ⊥ pass fusion. ⊥ resource aliasing pool. ⊥ timeline/keyframes.
- ⊥ 3D geometry graph, scenes, materials, cameras, lights (doc §32 → Phase 3).
- ⊥ image/video/webcam loader nodes, asset registry (doc §33 → Phase 2).
- ⊥ reusable components / subgraphs (doc §31 → Phase 2).
- ⊥ WebMCP adapter, ⊥ MCP server (doc §30.2 → Phase 2). bus ! shaped so both add w/ 0 logic dup.
- ⊥ CRDT, presence, live collab (doc §34 → Phase 4). arch prep only: stable IDs, atomic patch, actor-tagged mutation, actor-local undo.
- ⊥ agent-authored node packages (doc §30.6 → Phase 2).
- doc §35.7 Agent-Built Visual = Phase 2 acceptance gate, needs `package_component`. ⊥ v1.
- ports `geometry` `scene` `material` `camera` `light` `transform3d` `event` `audioFeatures` declared in type union, ⊥ implemented v1.

### committed (doc §2.4, §36)
- browser-only v1. desktop wrapper = later adapter, ⊥ native assumption in core graph|renderer.
- live continuously-running real-time = product center. timeline/keyframes/seek → later layer.
- offline + headless render = arch requirement NOW. seam preserved, ⊥ built v1.
- multiplayer waits on stable compiler+renderer+doc format+command model+components. prep only.
- agent control = early core capability. ⊥ waits on multiplayer.
- export order: 1 screenshot/still → 2 realtime browser recording → 3 deterministic frame sequence → 4 headless `vgpu/node` render queue → 5 video encode/alpha/HDR. v1 = step 1 only.
- deploy: browser-only + PWA-ready manifest.

### node catalog guideline
TD TOP family = reference vocabulary for core node set — naming, param names, default behavior.
map where it maps, ⊥ clone. POP/SOP families → later phase, same approach.
per-node parity notes ∈ node manifest `description`, ⊥ ∈ spec.

### decided (was open, confirmed 2026-08-29)
- baseline: Chrome/Edge ≥ 128 desktop. min capability Tier B (rgba16float + compute + storage buffers). timestamp query optional. mobile excluded v1.
- headless: seam + CI parity test. ⊥ render queue v1.
- agent authority: graph edit | shader edit | param set = free + undoable, ⊥ confirm. local file | network | upload | export | recording | component install | project delete = capability grant + confirm.
- save: single `.loom.json` + external `AssetReference`. unresolved → relink flow. bundle → Phase 2.

### open ? — ⊥ blocking Phase 0/1
- extension trust: declarative graph + manifest + WGSL only, ⊥ 3rd-party JS. ?
- 3D scope: doc §36.6 option 1 — procedural + loaded geometry → texture graph. ?
- when deterministic media seek + stateful-sim checkpoints enter roadmap. ?
- exact realtime recording + offline delivery formats @ first export milestone. ?

## §I INTERFACES

### file: `*.loom.json`
```ts
interface ProjectDocument {
  schemaVersion: number; projectId: string; name: string;
  graph: GraphDocument; settings: ProjectSettings;
  assets: AssetReference[]; createdAt: string; updatedAt: string;
}
interface GraphDocument {
  revision: number;
  nodes: Record<NodeId, GraphNode>; edges: Record<EdgeId, GraphEdge>;
  groups: Record<string, GraphGroup>; viewport?: ViewportState;
}
```
IDs opaque, globally unique strings. ⊥ array index as identity. `revision` monotonic, bumped per applied command.

### module: `src/runtime/backend` — sole vgpu boundary
```ts
interface RenderBackend {
  initialize(options: BackendInitOptions): Promise<BackendCapabilities>;
  compile(plan: LogicalExecutionPlan): Promise<CompiledExecutionPlan>;
  render(plan: CompiledExecutionPlan, frame: FrameInputs): void;
  resize(outputId: string, size: readonly [number, number]): void;
  readOutput(outputId: string): Promise<Uint8Array>;
  onDiagnostic(listener: (diagnostic: RuntimeDiagnostic) => void): () => void;
  dispose(): void;
}
```

### module: `src/domain/commands` — sole mutation path
```ts
interface AppCommandBus {
  query<TName extends QueryName>(
    name: TName, input: QueryInput<TName>, context: InvocationContext,
  ): Promise<QueryOutput<TName>>;
  execute<TName extends CommandName>(
    name: TName, input: CommandInput<TName>, context: InvocationContext,
  ): Promise<CommandResult<TName>>;
}
interface InvocationContext {
  actor: { kind: "human" | "agent" | "system"; id: string; label?: string };
  projectId: string;
  capabilities: CapabilityGrant[];
  transactionId?: string;
  dryRun?: boolean;
}
```
callers: toolbar, menu, keybind, inspector edit, drag-connect, tests, agent adapters.

### type: atomic graph patch
```ts
interface GraphPatch {
  baseRevision: number;
  operations: GraphPatchOperation[];
  label?: string;
}
interface GraphPatchResult {
  status: "applied" | "rejected" | "conflict";
  revision: number;
  appliedOperations: number;
  diagnostics: RuntimeDiagnostic[];
  createdIds: Record<string, string>;
  undoGroupId?: string;
}
```
patch-local temp IDs → stable IDs via `createdIds`. lets agent add N nodes + wire them in 1 request.

### agent tool surface — v1 subset (doc §30.3)
read: `get_project_summary` `get_graph` `get_selection` `list_node_definitions`
      `get_node_definition` `get_node` `get_diagnostics` `get_runtime_metrics` `render_preview`
mutate: `apply_graph_patch` `add_node` `remove_nodes` `connect_ports` `disconnect_ports`
      `set_parameters` `set_shader_source` `set_output` `reset_feedback` `undo` `redo`
workflow: `validate_project` `compile_project` `play` `pause` `save_project`
deferred → Phase 2: `create_component` `instantiate_component` `expose_component_port`
      `expose_component_parameter` `package_component` `get_asset_catalog`
      `inspect_output_pixel` `seek` `export_snapshot`
`render_preview` → bounded-size PNG of any texture output. multimodal verify loop:
inspect → patch → validate → compile → render → examine → refine.

### type: transport-independent frame input (doc §16.4)
```ts
interface FrameEvaluationInput {
  timeSeconds: number;
  deltaSeconds: number;
  frameIndex: number;
  mode: "realtime" | "fixed-step" | "offline";
  randomSeed: number;
}
```
live scheduler ← browser clock. future timeline ← playhead. future offline ← exact frame + fixed step.
same domain graph + compiler ∀ modes.

### type: audit entry
```ts
interface AuditEntry {
  revision: number; timestamp: string;
  actor: InvocationContext["actor"];
  command: string; undoGroupId?: string;
  status: "applied" | "rejected" | "conflict";
}
```

### module: `src/nodes/registry` — node manifest
```ts
interface NodeDefinition {
  type: string; version: number; title: string; category: string;
  inputs: PortDefinition[]; outputs: PortDefinition[];
  parameters: ParameterSchema;
  resolutionPolicy?: ResolutionPolicy; formatPolicy?: FormatPolicy;
  temporal?: TemporalDefinition; capabilities?: CapabilityRequirement[];
  compile(context: NodeCompileContext): CompiledNodeDescription;
  migrate?(oldVersion: number, data: unknown): MigrationResult;
}
```

### type: port union
```ts
type PortType =
  | { kind: "texture2d"; sample: "float" | "unfilterable-float" | "depth"; channels?: 1 | 2 | 4 }
  | { kind: "buffer"; element: string; access: "read" | "write" | "read-write" }
  | { kind: "scalar"; scalar: "f32" | "i32" | "u32" | "bool" }
  | { kind: "vector"; scalar: "f32" | "i32" | "u32"; size: 2 | 3 | 4 }
  | { kind: "matrix"; columns: 3 | 4; rows: 3 | 4 }
  | { kind: "geometry" } | { kind: "camera" }
  | { kind: "event" } | { kind: "audioFeatures" };
```

### type: per-node output resolution override (TD Common page)
```ts
type NodeResolutionOverride =
  | { mode: "auto" }                                   // node's own ResolutionPolicy — DEFAULT
  | { mode: "project" }                                // project output resolution
  | { mode: "input"; input?: PortId }                  // inherit named input
  | { mode: "scale"; factor: number; input?: PortId }  // 1/8 1/4 1/2 2x 4x 8x
  | { mode: "fixed"; width: number; height: number };  // custom
```
lives on `GraphNode.resolution?`. absent → definition policy. instance state, ⊥ definition state.

### type: per-node pixel format override (TD Common page)
```ts
type NodeFormatOverride =
  | { mode: "auto" }                          // node's own FormatPolicy — DEFAULT
  | { mode: "project" }                       // project workingFormat
  | { mode: "input"; input?: PortId }         // Use Input
  | { mode: "fixed"; format: TextureFormat }; // rgba8unorm | rgba16float | r32float
```
lives on `GraphNode.format?`. depth ⊥ selectable — color outputs only.
⊥ `rgba8unorm-srgb` yet: union growth mid-flight breaks exhaustive switches. → barrier.

### type: diagnostic (user-facing error surface)
```ts
interface RuntimeDiagnostic {
  severity: "info" | "warning" | "error"; code: string; message: string;
  nodeId?: NodeId; portId?: PortId;
  source?: { file?: string; line?: number; column?: number };
  suggestion?: string;
}
```

### custom WGSL node contract v1
```wgsl
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
struct Params { time: f32, amount: f32, };
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}
```

### ui: app shell panes
resizable + collapsible, drag dividers, dbl-click divider → reset, layout persisted `localStorage`.
```
┌──────────────── top bar: transport, fps, GPU ms, capability tier ─────────────┐
├───────────┬───────────────────────────────────┬───────────────────────────────┤
│ node      │  GRAPH CANVAS (@xyflow/react)     │  INSPECTOR (params of sel)    │
│ library   │                                   ├───────────────────────────────┤
│ + search  │                                   │  VIEWER (large preview)       │
├───────────┴───────────────────────────────────┴───────────────────────────────┤
│ BOTTOM DOCK ⇄ tabs: shader editor | problems | performance                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

### cmd
```
pnpm dev | pnpm build | pnpm test | pnpm test:headless | pnpm test:e2e | pnpm typecheck
```

## §V INVARIANTS

V1: domain graph = truth. React Flow node array ⊥ execution source.
V2: React component ⊥ encode GPU command. WebGPU calls only ∈ `src/runtime/`.
V3: `vgpu` import only ∈ `src/runtime/backend/vgpu/`. lint-enforced.
V4: current-frame graph = DAG. cycle legal ⟺ ∀ path in cycle crosses explicit temporal node.
V5: uniform-value param change → update uniform only. ⊥ recompile.
V6: output w/ N consumers → rendered 1× per frame, texture reused ∀ N.
V7: preview GPU→GPU. readback ⊥ in playback loop — export/inspect/test only.
V8: ⊥ render-target alloc inside frame loop. effects/targets/samplers/buffers created outside.
V9: shader compile fail → last valid plan retained + output flagged stale. ⊥ blank frame.
V10: ∀ serialized doc has `schemaVersion` + per-node `definitionVersion`. unknown node preserved as placeholder, ⊥ dropped.
V11: ∀ node definition runs headless. ⊥ import React or @xyflow.
V12: optional GPU feature discovered via capability report before use. ⊥ assumed.
V13: connect requires exact `PortType` match. ⊥ implicit color-space/format/scalar/resolution conversion. conversion = visible node.
V14: input port accepts ≤ 1 incoming edge unless declared variadic. output fan-out unbounded.
V15: ∀ semantic edit undoable. continuous drag coalesced → 1 history entry, live values still applied.
V16: per-frame metrics & preview pixels ⊥ enter document store. UI metric refresh ≤ 10 Hz.
V17: theme dark-only v1. ∀ color from CSS var token. ⊥ hardcoded hex in component.
V18: pane sizes persisted ∈ localStorage, ⊥ ∈ project doc.
V19: ∀ interactive control keyboard reachable, visible focus ring, `prefers-reduced-motion` honored (edge flow anim → static).
V20: param control drag ⊥ start graph pan | node drag | selection.
V21: resolution & format propagation deterministic, happens @ compile/resize. ⊥ per-frame.
V22: feedback = stable ping-pong pair. swap after ∀ current-frame consumers encoded.
V23: device lost → halt submit, report diagnostic, rebuild resources from domain graph, reset temporal history.
V24: resolution / dispatch / buffer-size caps enforced before dispatch. project memory budget reported.
V25: compiler evaluates only nodes reachable backward from active sinks. rest pruned.
V26: edge visual hue = source port family color (§C). ⊥ arbitrary edge color.
V27: WGSL compile message maps to editor line+col, surfaces on node badge + problems tab.
V28: only visible|pinned previews scheduled. offscreen/collapsed node preview suspended.
V29: ∀ mutation → `AppCommandBus.execute`. ⊥ adapter mutates zustand | React Flow array | GPU resource directly.
V30: ∀ command carries `InvocationContext.actor`. ⊥ anonymous mutation.
V31: ∀ mutation → `AuditEntry`. audit log inspectable in UI.
V32: `GraphPatch` atomic — ∀ ops apply | 0 apply.
V33: stale `baseRevision` → status `conflict`. ⊥ silent rebase.
V34: 1 patch → 1 undo group unless explicitly split.
V35: patch temp IDs resolved to stable IDs, returned ∈ `createdIds`.
V36: `dryRun: true` → validate + return diagnostics, ⊥ mutate, ⊥ audit as applied.
V37: tool result = structured data, ⊥ instruction to calling model. 3rd-party node text & project text = untrusted.
V38: capability grant required per class: local file, network, upload, export, recording, component install, project delete. calling tool ⊥ grants permission.
V39: bus adapter-agnostic. WebMCP | MCP server adapter = transport + schema only, 0 app-logic duplication.
V40: node delete → incident edges removed|tombstoned deterministically, same result ∀ actors.
V41: undo actor-local. ⊥ erase other actor work.
V42: agent activity visible — planning | editing | compiling | awaiting-approval shown in UI. ⊥ invisible background mutation.
V43: long render | sim cancellable.
V44: ∀ time-dependent node consumes `FrameEvaluationInput`. ⊥ read `Date.now` | `performance.now` | rAF directly. lint-enforced.
V45: ∀ random generator seeded from `randomSeed` (project|node). same seed + same frameIndex → same output.
V46: stateful node declares `{reset, deterministicReplay, checkpoint, randomAccess}` ∈ manifest.
V47: execution plan renders to offscreen target w/o visible surface. headless path = same graph + same compiler.
V48: ∀ readback isolated behind export interface. ⊥ readback call outside it.
V49: runtime ⊥ couple graph eval to rAF | wall clock. scheduler = swappable transport source.
V51: node format override = instance state, @ compile, ⊥ per-frame. absent → definition `formatPolicy`. ! validated vs capability report (V12) — unsupported → diagnostic + documented fallback, ⊥ crash, ⊥ silent swap. depth format ⊥ on color output. change → recreate targets + reset feedback (V22).
V50: node resolution override = instance state, applied @ compile|resize, ⊥ per-frame (V21). absent → definition `resolutionPolicy`. ! clamped to project limits (V24). change → recreate affected targets + reset feedback history if pair resized (V22).

## §T TASKS
row order = exec order. id = stable label, ⊥ ordering.
id|status|task|cites
T1|x|scaffold vite+react19+ts strict, pnpm, path aliases|C
T2|x|token layer `src/ui/tokens.css` — colors, type scale, radius, port family vars|V17,V26
T3|x|load Archivo + JetBrains Mono, self-host woff2, fallback stacks|C
T4|x|app shell: `react-resizable-panels` layout per §I.ui, persisted localStorage|V18
T5|x|Radix base primitives restyled to tokens: tooltip, popover, tabs, ctx menu, dialog|V17,V19
T6|x|a11y floor: focus-visible rings, reduced-motion media query, tab order|V19
T7|x|eslint rule: `vgpu` import restricted to `src/runtime/backend/vgpu/**`|V3
T8|x|eslint rule: no react/@xyflow import in `src/nodes/definitions/**`|V11
T9|x|domain types — ProjectDocument, GraphDocument, GraphNode, GraphEdge + zod schemas|I.file,V10
T63|x|`FrameEvaluationInput` type + live scheduler feeding it from browser clock|I.frame,V49
T10|x|zustand+immer graph store, semantic command layer, undo/redo w/ drag coalescing|V1,V15
T11|x|`PortType` union + `arePortsCompatible()` exact-match check|I.port,V13
T12|x|node registry + `NodeDefinition` manifest type|I.registry
T50|x|`AppCommandBus`: command+query registry, `InvocationContext`, dryRun, result types|I.bus,V29,V30
T51|.|route ∀ human action through bus — toolbar, menu, keybind, inspector edit, drag-connect|V29
T52|x|`revision` counter + `AuditEntry` log + actor identity, audit viewer in dock|V31,V40
T53|x|undo groups keyed to command\|patch, actor-local history|V34,V41
T13|x|`RenderBackend` iface + vgpu adapter impl, device init, capability report|I.backend,V2,V12
T14|x|device-loss handling: halt, diagnose, rebuild from graph, reset temporal|V23
T15|.|Phase0 spike nodes: Solid, CustomWGSL, Output|I.wgsl
T16|x|frame loop via vgpu frameLoop, shared uniforms (time, frame, pointer, resolution)|V8
T64|x|lint rule: ⊥ `Date.now`\|`performance.now`\|rAF ∈ `src/nodes/**` — frame input only|V44
T65|x|seeded RNG: project seed + node seed → deterministic per frameIndex|V45
T17|x|uniform-only update path, ⊥ recompile|V5
T18|.|custom node component: title bar, status dot, ports L/R, preview slot, bypass/mute|V26
T19|.|edge renderer: flow-dash anim, hue=port family, speed←GPU ms, static if reduced-motion|V19,V26
T20|.|CodeMirror6 WGSL editor in bottom dock, theme from tokens|C
T21|.|shader diagnostics: debounce, async compile, line/col map, node badge + problems tab|V9,V27
T22|.|retain last valid program + stale-output indicator|V9
T23|.|**Phase0 exit**: uniform live-update, WGSL recompile, invalid WGSL keeps output|V5,V9
T71|.|`NodeResolutionOverride` on `GraphNode` + zod + `setNodeResolution` patch op + bus command|V50,I.res
T74|.|`NodeFormatOverride` on `GraphNode` + zod + `setNodeFormat` patch op + bus command|V51,I.fmt
T24|.|compiler: resolve defs, validate params+connections|V13,V14
T25|.|compiler: split temporal edges, reject illegal cycles, topo sort|V4
T26|.|compiler: active-sink trace + prune|V25
T27|.|compiler: resolution propagation (`ResolutionPolicy`)|V21
T72|.|compiler: honor per-node resolution override in propagation, clamp to project limits, recreate targets on change|V50,V21,V24
T75|.|compiler: honor per-node format override, validate vs capability tier, diagnostic + fallback when unsupported|V51,V12
T28|.|compiler: format propagation rgba8unorm / rgba16float|V21
T29|.|compiler: logical resource assign, persistent target per materialized output|V8
T30|.|compiler: emit plan + structured `RuntimeDiagnostic[]`|I.diag
T31|.|recompile classifier — edit kind → minimal work|V5,V21
T32|.|branch reuse: 1 render per output, shared by N consumers|V6
T33|.|Feedback node: pingPong pair, swap after encode, reset triggers|V22
T66|x|manifest field: stateful node declares reset\|deterministicReplay\|checkpoint\|randomAccess|V46
T34|.|preview system: shared atlas, tile alloc for visible \|pinned only, 192px long edge, 15-30fps|V7,V28
T35|.|debug preview effects: color, single-channel, alpha-on-checker, NaN/Inf highlight|V7
T36|.|large viewer pane: pinned output, channel toggles, px value under cursor|I.ui
T67|x|plan renders to offscreen target w/o visible surface — headless path shares compiler|V47
T37|.|param control kit: draggable number (shift slow/alt fast), dbl-click reset, units, enum, color, bool|V20
T38|.|inspector pane: manifest-driven full control set, grouped|V17
T73|.|node Common section: resolution select (auto\|project\|input\|1/8..8x\|custom) + w/h, format select, resolved size+format readout on node & inspector, unsupported-format warning|V50,V51,V17
T39|.|node library pane: search, categories, drag-to-canvas, port-drag→compatible-node search|V13
T70|.|Noise node — types perlin\|simplex\|value\|sparse\|worley. params period, harmonics, gain, lacunarity, exponent, offset, amplitude, mono\|RGB, signed\|unsigned range, seed, 3D time evolve, xform. TD Noise TOP as param reference|V44,V45,I.registry
T40|.|core node set, TD TOP vocabulary: Ramp, UV, Checker, Circle/SDF, Transform, Crop, Tile/Mirror, Level, HSV, Blur, Threshold, Displace, Lookup/Colorize, Over, Add, Multiply, Screen, Difference, Mask|I.registry
T41|.|GPU timer spans, per-pass ms, performance tab, resource count + mem estimate|V16,V24
T42|.|metrics pipe outside document store, ≤10Hz UI tick|V16
T68|.|export interface = sole readback surface. screenshot/PNG v1|V48,V7
T54|.|read tools: get_project_summary, get_graph, get_selection, list_node_definitions, get_node_definition, get_node, get_diagnostics, get_runtime_metrics|I.tools,V37
T55|.|`apply_graph_patch` — atomic ops, baseRevision conflict, temp→stable `createdIds`, 1 undo group|V32,V33,V34,V35
T56|.|mutation tools on bus: add_node, remove_nodes, connect_ports, disconnect_ports, set_parameters, set_shader_source, set_output, reset_feedback, undo, redo|V29,V30
T57|.|workflow tools: validate_project, compile_project, play, pause, save_project|I.tools
T58|.|`render_preview` → bounded-size PNG of any texture output, via export iface|V48,I.tools
T59|.|capability grant model + gate table, dryRun on destructive, ⊥ self-grant|V36,V38
T60|.|agent presence UI: actor badge, planning\|editing\|compiling\|awaiting state, patch review + revert-transaction-as-unit|V42
T43|.|save/load `.loom.json`, migration scaffolding, unknown-node placeholder|V10
T44|.|resource caps: max resolution, dispatch size, buffer size, project budget|V24
T45|.|unit tests: port compat, cycle/temporal, topo order, sink prune, resolution, format, migrations|V4,V13,V21,V25
T46|.|`vgpu/mock` command-level tests|C
T47|.|Dawn headless render snapshot: gradient→levels, blur chain, feedback progression|C
T69|.|headless parity test: same graph browser vs `vgpu/node` Dawn → snapshot match within tolerance|V47
T48|.|playwright: connect gesture, undo/redo, param drag, shader error recovery, save+reload|V15
T61|.|tests: patch atomicity, stale-revision conflict, dryRun ⊥ mutate, audit completeness, actor-local undo|V32,V33,V36,V41
T49|.|**Phase1 exit**: PoC graph Noise→Displace→Levels→Composite→Output + Feedback + Colorize fan-out, 10min stable resource count|V6,V7,V22
T62|.|**Phase1 agent exit**: agent adds 3 nodes + wires them in 1 patch, compiles, renders preview, reads GPU ms, undoes as 1 group|V32,V34,V35

## §P PARALLEL PLAN

wave = barrier. tracks ∈ wave run concurrent. track owns disjoint paths → ⊥ write collision.
rule: track ⊥ edit file outside owned paths. shared contract frozen @ wave 0.
cross-track need → raise, ⊥ patch other track path.

### wave 0 — serial, 1 worker. contract freeze.
T1, T9, T63
emits: `src/domain/types/` — ProjectDocument, GraphDocument, PortType, NodeDefinition,
RuntimeDiagnostic, AppCommandBus, InvocationContext, GraphPatch, FrameEvaluationInput, AuditEntry.
∀ later track codes against these. change after freeze → barrier + broadcast.

barrier addendum: **T71 T74** — contract fields + zod landed pre-emptively (additive, safe mid-flight).
patch-op union + bus command land @ wave 1 barrier, ⊥ mid-flight (union growth breaks exhaustive switches).

### wave 1 — 4 tracks
| track | tasks | owns |
|---|---|---|
| A design system + shell | T2 T3 T5 T4 T6 | `src/ui/**` `src/app/**` |
| B domain + bus | T11 T12 T10 T50 T52 T53 T65 T66 | `src/domain/graph/**` `src/domain/parameters/**` `src/domain/commands/**` |
| C gpu backend | T13 T14 T16 T17 T67 | `src/runtime/backend/**` `src/runtime/execution/**` |
| D guardrails | T7 T8 T64 | `eslint.config.*` `vitest.config.*` `playwright.config.*` `.github/**` |

### wave 2 — 5 tracks
| track | tasks | owns |
|---|---|---|
| E compiler | T24 T25 T26 T27 T72 T28 T75 T29 T30 T31 T32 T33 | `src/compiler/**` |
| F graph view | T18 T19 | `src/editor/graph-canvas/**` `src/editor/nodes/**` `src/editor/edges/**` |
| G controls | T37 T38 T73 T39 | `src/editor/inspector/**` `src/editor/library/**` `src/ui/controls/**` |
| H shader editor | T20 T21 T22 | `src/editor/shader-editor/**` |
| I spike nodes | T15 | `src/nodes/definitions/**` `src/nodes/shaders/**` |

barrier: **T23 Phase 0 exit** ← C, H, I.

### wave 3 — 5 tracks
| track | tasks | owns |
|---|---|---|
| J preview | T34 T35 T36 | `src/runtime/previews/**` `src/editor/viewer/**` |
| K node catalog | T70 T40 | `src/nodes/definitions/**` `src/nodes/shaders/**` |
| L telemetry | T41 T42 | `src/runtime/telemetry/**` |
| M persistence | T43 T44 | `src/domain/project/**` `src/domain/migrations/**` |
| N export | T68 | `src/runtime/export/**` |

barrier: **T51** route ∀ human action through bus — toolbar, menu, keybind, inspector, drag-connect.
serial, crosses `src/editor/**` + `src/app/**`. ! before wave 4: agent tools assume bus = only mutation path (V29).

### wave 4 — 2 tracks
| track | tasks | owns |
|---|---|---|
| O agent surface | T54 T55 T56 T57 T58 T59 T60 | `src/agent/**` |
| P tests | T45 T46 T47 T69 T48 T61 | `src/tests/**` |

### wave 5 — serial gates
T49 Phase 1 exit, T62 Phase 1 agent exit.

### notes
- `src/agent/` ∉ doc §25 structure. added here. holds bus adapters + tool schemas only, ⊥ app logic (V39).
- K reuses I paths → I done @ wave 2 barrier, ⊥ concurrent.
- G owns `src/ui/controls/**` only. A owns rest of `src/ui/`.
- max concurrency 5. widening past that → collision risk > speedup.

## §B BUGS
id|date|cause|fix
