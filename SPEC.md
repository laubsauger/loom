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
- components/subgraphs = CORE (track U), ⊥ deferred. TD COMP model: instance pins version, params published to a component page, `parent` scope, flatten @ compile.
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

### point model — unified pointset (TD POP analog), Phase 2/3
ONE data model. mesh = points + topology. particles = points w/o topology. ⊥ SOP/POP split.
- storage = structure-of-arrays: 1 buffer per attribute. kills WGSL alignment pain; op binds only what it touches.
- arbitrary named attributes day 1. WGSL structs CODE-GENERATED from attribute schema.
- kernel ABI: `fn process(p: Point, ctx) -> Point`. `Point` codegen'd. versioned (`contractVersion`), fusion-ready.
- per-point RNG = `hash(seed, pointId, frame)`. `pointId` = identity, ⊥ slot index.
- GPU-driven lifecycle from start via scan/prefix-sum COMPACTION, ⊥ atomics — atomics ⊥ deterministic, would break V45 + headless parity. cost = 2-3 extra passes, nothing else.
- render spine: sprites → instances → mesh.
- TOP↔POP bridges: `TextureToAttribute` (P3a), splat-to-texture (P3b), audio/pointer via resolver seam (V61). one instrument, ⊥ two apps.

slices:
- P3a (late Phase 2, beside audio-reactive): pointset core, SoA buffers, attribute codegen, custom per-point WGSL kernel node, sprite render, viewer + attribute spreadsheet, `TextureToAttribute`. flagship demo = audio-driven particles.
- P3b: neighbors (flocking, SPH) — kernel ABI reserves the slot. indirect instancing, trails, splat-to-texture.
- P3c: handoff §35.6 3D scene.

gates:
- P3a exit: audio-reactive 100k particles @ 60fps 1080p · seed-identical browser vs headless · agent builds a variant via patch + verifies via `render_preview` + `read_points`.
- P3b exit: flocking 50k + indirect instancing + trails, 10-min stable resource count.

TOP RISK: attribute→WGSL codegen = new center of gravity. own task, heavily tested, headless.
⊥ a side effect of writing the first node.

### example projects — executable specs, ⊥ demos
handoff §35: examples ARE specifications. each ships as a real `.loom.json`, is a visual
regression fixture, and documents the concept it proves. an example that ⊥ load = a
release blocker, ⊥ a docs chore.

buildable w/ what exists (18 nodes + Feedback + CustomWGSL):
- **E1 Feedback Echo** — Noise → Over → Output, w/ Feedback → Transform → Blur → Level
  closing the loop. proves: explicit temporal boundary, fade+transform inside loop,
  branch preview, reset, ping-pong stability over 10 min (T49 gate).
- **E2 Reaction-Diffusion** — Feedback → CustomWGSL (Gray-Scott kernel) → Feedback.
  proves: iterative sim via render feedback, seeded init (V45), pause|step|reset,
  rgba16float precision path, determinism browser vs headless (V47).
- **E3 Animated Noise Field** — Noise (perlin4d, t4d ← time) → Level → Displace ← Noise.
  proves: time reaches shader via `FrameEvaluationInput` ⊥ wall clock (V44), fan-out
  rendered once (V6), 4D noise as the TD animation idiom.
- **E4 Bloom** — Threshold → Blur → Add ← source. proves: multi-branch converge,
  HDR rgba16float intermediate, per-node format override (V51).
- **E5 Kaleidoscope** — Transform → Tile/mirror → Transform. proves: extend modes,
  resolution override (V50), cheap chain @ high res.
- **E6 Displacement Stack** — Noise → Level → Transform → Displace. proves: `data` vs
  `linear` space discipline (V56/V57) — displacement input ⊥ color-converted.

later, when deps land: media mixer (needs image/video nodes), particle trails +
audio-reactive (P3a), 3D scene (P3c), agent-built visual (§35.7, agent gate).

### three libraries, three verbs (TD: OP Create dialog | Palette | example projects)
- **node library** — a TYPE. verb = ADD. already exists.
- **component library** — a reusable subgraph (TD Palette / `.tox`). verb = INSTANTIATE into the
  current graph, linked or detached, at a pinned version (V79, V84). shipped set + user-saved.
- **example library** — a whole PROJECT. verb = OPEN, which REPLACES the open document.

⊥ merge into one browser. the verbs differ, and merging puts a DESTRUCTIVE action (open
replaces your work) one click from an additive one. examples ! confirm when the document
is dirty; add/instantiate ! never confirm — they are undoable.

shipped components (handoff §31.4, buildable w/ current catalogue):
FeedbackEcho · Bloom · DisplacementStack · MediaGrade · Kaleidoscope.

### media as NODES (TD Movie File In / Movie File Out TOP)
recording belongs ∈ the GRAPH, ⊥ a global "record" button. TD makes it a node ∴ TOPOLOGY
decides what is recorded: an intermediate branch, several outputs at once, a pass you are
debugging — ⊥ only whatever the single main output happens to be.

- **MovieFileIn** — ONE node for STILL, SEQUENCE and VIDEO, as TD's Movie File In TOP is.
  ⊥ a separate ImageIn: the param set overlaps almost entirely (file, color space, alpha,
  filter/wrap, native res) and 2 nodes would mean choosing the wrong one before you know
  what the file is. a still simply has no timeline — playback params HIDE when the loaded
  asset has 1 frame, ⊥ sit there inert (V90: ⊥ show a control that does nothing).
  **NOTHING loads a file today** — the catalogue is entirely procedural, so this is the
  first node that reads from disk and the first real consumer of `AssetReference`.
  image | video | sequence → texture. play/pause/seek/loop/rate, in|out
  points, native res, current time, duration, frame-ready event. asset by `AssetReference`,
  ⊥ a raw path (V10). decode behind a media-source abstraction: `HTMLVideoElement` first,
  WebCodecs later where it measurably wins.
- **MovieFileOut** — a texture input → an encoded file. rides T111's WebCodecs mp4 +
  exact-frame capture. IS A SINK (V25) ∴ ⊥ pruned; recording is its side effect.

both are Phase 2 (media pipeline, doc §33) — but the SHAPE is decided now, because
"recording is a node" changes who owns the export interface, and retrofitting a global
recorder into a node model is a rewrite.

### node catalog guideline
TD TOP family = reference vocabulary for core node set — naming, param names, default behavior.
map where it maps, ⊥ clone. POP/SOP families → later phase, same approach.
per-node parity notes ∈ node manifest `description`, ⊥ ∈ spec.

### decided (was open, confirmed 2026-08-29)
- baseline: Chrome/Edge ≥ 128 desktop. min capability Tier B (rgba16float + compute + storage buffers). timestamp query optional. mobile excluded v1.
- headless: seam + CI parity test. ⊥ render queue v1.
- agent authority: graph edit | shader edit | param set = free + undoable, ⊥ confirm. local file | network | upload | export | recording | component install | project delete = capability grant + confirm.
- save: single `.loom.json` + external `AssetReference`. unresolved → relink flow. bundle → Phase 2.

### locked — owner interview 2026-08-29
- color: `space` ∈ `texture2d` port type. linear working space, decode @ load, encode+tonemap @ output only.
- param modulation: resolver invariant AND `ParameterValue` envelope `{kind:"static",value}` | reserved bound — both land now, before ∀ `.loom.json` ∈ wild. envelope passthrough lane fixes closed-union anti-V10.
- perform mode: full multi-window output = COMMITTED Phase 2 deliverable (multi display, VJ). presentation seam designed now, ⊥ prep-only.
- revision contention: param-only carve-out. value-only edits on disjoint entities ⊥ conflict w/ structural patch. amends V33.
- workers: renderer-in-worker COMMITTED Phase 2. worker owns device + ∀ surfaces; window transfers `OffscreenCanvas` in = also multi-window transport. v1 main-thread + clone-safe invariant + DOM-free lint + non-rAF loop.
- audio-reactive: early Phase 2 headline. AudioIn (mic|file) → analysis (FFT bands, beat, envelope) → params via resolver. first consumer proving modulation arch. WebMIDI alongside. OSC → Phase 3 (needs bridge).
- expressions: own minimal grammar. jsep-style AST, whitelisted fns, vars only ← `FrameEvaluationInput` + node ctx. deterministic + sandboxed by construction. v1 = arithmetic only, 1 evaluator module.
- autosave: IndexedDB ring. 2s debounce after last mutation. keep last 20 + 1 per 10min pinned, pins capped 48 (~8h; ⊥ multi-day session fills quota). restore-on-launch prompt. manual save still writes `.loom.json`. `serialize.ts` = sole serializer, shared w/ manual save.
- recording: first realtime export = WebCodecs → mp4 (`VideoEncoder`, exact-frame capture ← render loop). ⊥ MediaRecorder stopgap. Chrome ≥128 guarantees WebCodecs.

### open ? — ⊥ blocking Phase 0/1
- extension trust: declarative graph + manifest + WGSL only, ⊥ 3rd-party JS. ?
- 3D scope: doc §36.6 option 1 — procedural + loaded geometry → texture graph. ?
- when deterministic media seek + stateful-sim checkpoints enter roadmap. ?
- perform mode display-selection UX: single fullscreen toggle vs true multi-window. ?

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
read: `read_points` (reserved — windowed point attribute readback, ≤10Hz, via export iface V48)
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

### type: pointset port (replaces unimplemented `geometry`)
```ts
interface PointAttributeSpec {
  name: string;                       // "P", "vel", "age", "Cd" — arbitrary, day 1
  type: "f32" | "vec2f" | "vec3f" | "vec4f" | "i32" | "u32" | "mat3x3f" | "mat4x4f";
}
type PortType =
  | …
  | { kind: "pointset"; requires: PointAttributeSpec[]; topology?: "points" | "lines" | "triangles" };
```
compat (V13 spirit): consumer's `requires` ! be satisfied by producer's attributes — name AND
type exact. superset OK (producer may carry more), missing|mistyped = ⊥. topology absent = particles.

### kernel ABI
```wgsl
fn process(p: Point, ctx: KernelContext) -> Point
```
`Point` struct codegen'd from attribute schema. `ctx` carries frame input + `pointId`.
`NodeDefinition.contractVersion` pins ABI; mismatch → diagnostic, ⊥ silent run.

### type: component (COMP) — subgraph behind a stable interface
```ts
interface GraphComponentDefinition {
  componentId: ComponentId;
  version: number;
  name: string;
  graph: GraphDocument;              // internal network
  inputs: ExposedPort[];             // internal port → external port
  outputs: ExposedPort[];
  parameters: PublishedParameter[];  // internal params → component param page
  migrations?: ComponentMigration[];
}

interface ExposedPort { externalId: PortId; label: string; nodeId: NodeId; portId: PortId; }

/** One component param drives N internal targets — TD binds a custom par to many. */
interface PublishedParameter {
  key: string;                       // name on the component's param page
  definition: ParameterDefinition;   // label, range, unit, default — re-authored, ⊥ copied
  targets: ReadonlyArray<{ nodeId: NodeId; key: string }>;
}
```
instance stores `componentId` + `version` + own param values + overrides.
⊥ duplicate internal graph unless detached.

### parent scope
child reads owning component's params via resolver (V61): `parent.<key>`.
resolves ∀ nesting depth by walking up instance chain. ⊥ arbitrary cross-node reads —
`parent` = lexical, ⊥ a graph edge.

### type: context menu (right-click) — data, ⊥ hardcoded
```ts
interface MenuTarget {
  surface: "canvas" | "node" | "port" | "edge" | "parameter";
  nodeId?: NodeId; portId?: PortId; edgeId?: EdgeId; parameterKey?: string;
}
interface MenuItem {
  command: CommandName;   // ⊥ inline handler — same path as hotkey + palette (V29, V52)
  input?: unknown;
  label: string;
  when?: string;
  submenu?: MenuItem[];
}
```
ONE menu root per surface, target resolved from event on open. ⊥ Radix root per node —
dense graph cost. keys rendered ← keymap (V55), ⊥ literal "⌘Z" strings.

### parameter modes — TD parity (verified vs docs.derivative.ca)
TD: ∀ parameter has a MODE. click the param NAME to expand → 4 square mode buttons.
grey=Constant · blue=Expression · green=Export(CHOP-driven) · purple=Bind(bi-directional).
right-click = popup menu. ctrl/cmd+E = edit the expression.

**THE DETAIL THAT MATTERS**: an inactive mode that HAS a value shows a small square ∈ the
button's lower-left corner. ∴ **each mode retains its own value independently** — switching
to Constant ⊥ destroys the expression. that is why the indicator exists, and it is what
makes mode-switching safe to experiment with.

```ts
type ParameterBinding =
  | { kind: "static"; value: ParameterValue }
  | { kind: "expression"; source: string }            // OUR grammar (V71), ⊥ Python
  | { kind: "bind"; ref: string }                     // another param | `parent.<key>`
  | { kind: "driven"; channel: string };              // TD Export analog — audio|MIDI|LFO, Phase 2

interface ParameterSlot {
  mode: ParameterBinding["kind"];
  /** EVERY mode's last value, kept. mode switch ⊥ destructive. */
  bindings: Partial<Record<ParameterBinding["kind"], ParameterBinding>>;
}
```
∀ parameter TYPE takes ∀ mode — number, vector, color, bool, enum, string alike. ⊥ a
number-only feature: TD drives menus + toggles from expressions & that is half its power.

### pulse parameters (TD Pulse) — momentary triggers
TD: `Pulse` is a parameter TYPE, ⊥ a per-node feature. Feedback TOP has Reset; Timer has
Start/Stop. ∴ ANY node can declare one and the mechanism is written once.

```ts
interface PulseParameter extends ParameterBase { type: "pulse"; }
```
- momentary: it FIRES, it ⊥ hold. never serialized as "on" — a pulse ∈ a saved doc that
  re-fires on load would reset your work every time you opened it.
- mutates RUNTIME state, ⊥ document state ∴ audited (V31) but **⊥ undoable**: undo restores
  a document, and a cleared feedback buffer is ⊥ ∈ the document. saying so beats a
  disabled undo that silently does nothing.
- takes ∀ mode (V107) — an EXPRESSION firing a pulse is how an automated reset happens
  (TD's whole idiom: pulse on a beat, on a threshold, on a frame count).
- TD also pairs a HOLD toggle w/ the momentary pulse (Feedback TOP has both). support both:
  `reset` (hold ∈ reset) + `resetPulse` (fire once).

a node declaring `stateful.reset === true` (V46, already ∈ the contract) SHOULD expose one
— that field has been declaring the capability w/ nothing to trigger it.
consumers: Feedback (clear), Noise (reseed), accumulator (clear), point sim (reset),
MovieFileIn (re-fetch).

### compound parameters are COMPONENT-ADDRESSABLE (TD: colorr/colorg/colorb, tx/ty/tz)
TD has ⊥ "a color parameter" — it has `colorr`, `colorg`, `colorb`, each a first-class
parameter w/ its OWN mode. the swatch is a convenience ON TOP. same for `tx`/`ty`/`tz`.
that is what makes a single channel drivable while the others stay constant.

ours: the MANIFEST keeps one declaration (`color`, `t`) — verbose 4-way manifests would
be worse — but the SLOT is per component:
```
color  → color.r  color.g  color.b  color.a
t      → t.x      t.y      t.z      (t.w for size 4)
```
∀ component gets its own `ParameterSlot` ∴ its own mode, expression, bind, value.
resolver reassembles components → the compound value the shader wants.
component names: r g b a · x y z w.

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

TD Output Resolution menu = Use Input | Eighth | Quarter | Half | 2X | 4X | 8X |
Fit Resolution | Limit Resolution | Custom. our `scale` covers eighth..8x, `fixed` = custom.
MISSING: `fit` (fit w/h, keep aspect) + `limit` (clamp w/h). both real, both useful —
`limit` = safety valve. → wave 2 barrier (union growth, tracks E+G reading it now).

### type: per-node pixel format override (TD Common page)
```ts
type NodeFormatOverride =
  | { mode: "auto" }                          // node's own FormatPolicy — DEFAULT
  | { mode: "project" }                       // project workingFormat
  | { mode: "input"; input?: PortId }         // Use Input
  | { mode: "fixed"; format: TextureFormat }; // rgba8unorm | rgba16float | r32float
```
lives on `GraphNode.format?`. depth ⊥ selectable — color outputs only.
`rgba8unorm-srgb` landed @ barrier. `TEXTURE_FORMATS` const = single source, type derived from it.

### module: `src/editor/keymap` — bindings as data
```ts
type KeyContext = "global" | "graph" | "inspector" | "viewer" | "text";

interface KeyBinding {
  id: string;              // stable, survives rebinding
  keys: string;            // "mod+z", "shift+h", "g d" (chord)
  context: KeyContext;     // narrowest wins; "text" swallows editing keys
  command: CommandName;    // bus command — ⊥ inline handler
  input?: unknown;         // static args, or resolved from selection
  when?: string;           // guard: "hasSelection", "nodeHovered"
  label: string;           // shown in palette, menus, tooltips
}

interface Keymap {
  defaults: KeyBinding[];
  overrides: Record<string, string | null>;  // id → keys, null = unbound
}
```
`mod` = Cmd @ macOS, Ctrl elsewhere. overrides ∈ localStorage, ⊥ ∈ project doc.

### defaults — verified vs docs.derivative.ca/Application_Shortcuts
TD philosophy: graph context = SINGLE KEY, no modifier. case distinguishes all vs selected.
adopt it — modifier-heavy bindings ⊥ feel like TD.
```
VERIFIED (TD network editor):
Tab   add operator          Esc   cancel
H     home (default view)   h     home selected
F     frame (fit content)   f     frame selected
b     toggle bypass         d     toggle display      r  toggle render
v     open viewer           o     overview
i     dive in               u     jump up             Enter  jump down
n     name                  c     color palette       e  edit/expose
L     layout                l     layout all
Del   delete                mod+a select all         mod+f find
mod+c / mod+x / mod+v  copy / cut / paste

OURS (⊥ ∈ TD, app-level — justified):
mod+z / mod+shift+z  undo / redo      mod+s  save
mod+d  duplicate                      mod+k  command palette
mod+,  settings                       Space  play | pause      .  step frame
mod+shift+r  reset feedback history

DROPPED (was guess, ⊥ in TD docs): P pin, M mute, mod+g group, 1..8 viewer.
`d`/`r`/`v` cover display+render+viewer instead.
```
mouse: pan | zoom ⊥ documented @ Application_Shortcuts. use node-editor convention:
middle-drag | space-drag pan, scroll zoom, alt+drag zoom. mark ? — ! confirm vs TD install.

### node info — TD middle-click analog (verified vs docs.derivative.ca)
TD: MMB on node → popup w/ most-recent cook time + "cooking every frame?".
richer stats live in Info CHOP + TOP class. our popup merges both — 1 surface, ⊥ two.

TD source fields → ours:
```
Info CHOP (common operator)        →  ours
  cook_time                        →  gpuMs (timer span, ⊥ CPU encode duration)
  total_cooks                      →  framesRendered
  cooked_this_frame                →  renderedThisFrame
  cook_frame / cook_abs_frame      →  lastRenderedFrame
  warnings / errors                →  warningCount / errorCount
TOP class                          →  ours
  width / height                   →  resolution [w,h]
  aspect / aspectWidth/Height      →  aspect
  pixelFormat / pixelFormatName    →  format + label
  gpuMemory                        →  estimatedBytes (← plan.ts estimateResourceBytes)
  curPass                          →  passCount (nodes compile to ≥1 pass)
```
ours beyond TD: `space` (linear|encoded|data), resolution SOURCE (which override/policy
decided it), bypassed|muted, stale (V9), agent activity (V42).

COMPONENT: aggregate over flattened internal passes (V82) — own time, children time,
total, pass count, node count. "time consumed within that component" = the ask.
```

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

// Shared frame block — the runtime fills it from FrameEvaluationInput every frame.
// TIME LIVES HERE AND NOWHERE ELSE (V44).
@group(0) @binding(3) var<uniform> frameU: SharedFrame;

struct Params { amount: f32 };
@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}
```
`Params` ⊥ carries `time`. per-pass uniform block written @ compile + on param change
(V5, V21) ∴ structurally ⊥ carry a per-frame clock — a `time` field there = a value that
silently never advances. `frameU.time` = its only home.

binding is GATED, ⊥ unconditional: runtime binds by NAME and hard-errors on a name the
shader ⊥ declare (`VGPU-RING1-UNSUPPORTED`). `compile()` scans the source and binds only
what it asked for — a kernel declaring neither block (E2 Gray-Scott) ! still compile.

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
V14b: an EDGE is a valid drop target for a connection. release over the line → the drag takes that edge's TARGET and replaces it. the line is a big target; the port is a 7px dot (V99) — requiring the dot when the wire is right there is asking for precision the task ⊥ need.
V14c: edge hit area ! be generous (~10px each side of the stroke, invisible), same principle as V99. a 1px stroke is ⊥ a target.
V14a: dropping a connection on an OCCUPIED input REPLACES the existing edge — 1 patch, 1 undo group (V32, V34). ⊥ silently refuse: the user's intent is unambiguous and refusing makes them hunt for the old edge to delete first.
V15: ∀ semantic edit undoable. continuous drag coalesced → 1 history entry, live values still applied.
V16: per-frame metrics & preview pixels ⊥ enter document store. UI metric refresh ≤ 10 Hz.
V17: theme dark-only v1. ∀ color from CSS var token. ⊥ hardcoded hex in component. a color FUNCTION deriving from a token (`color-mix(in srgb, var(--x) 30%, transparent)`) = allowed — it introduces no literal & is the only way to express a translucent tint of a themed color. a literal ANYWHERE inside one, incl. nested, = caught.
V18: pane sizes persisted ∈ localStorage, ⊥ ∈ project doc.
V19: ∀ interactive control keyboard reachable, visible focus ring, `prefers-reduced-motion` honored (edge flow anim → static).
V20: param control drag ⊥ start graph pan | node drag | selection.
V21: resolution & format propagation deterministic, happens @ compile/resize. ⊥ per-frame.
V22: feedback = stable ping-pong pair. swap after ∀ current-frame consumers encoded.
V23: device lost → halt submit, report diagnostic, rebuild resources from domain graph, reset temporal history.
V24: caps enforced before dispatch — resolution, dispatch size, buffer bytes, point count, attribute count, per-point stride. ∀ checked vs `capabilities.limits` + `settings.limits`. project memory budget reported. over-cap → diagnostic + refuse, ⊥ device loss.
V25: compiler evaluates only nodes reachable backward from active sinks. rest pruned.
V26: edge visual hue = source port family color (§C). ⊥ arbitrary edge color.
V27: WGSL compile message maps to editor line+col, surfaces on node badge + problems tab.
V28: only visible|pinned previews scheduled. offscreen/collapsed node preview suspended.
V28b: a VISIBLE texture-producing node previews BY DEFAULT — TD parity: a disconnected node shows its output, ⊥ a blank box. ∴ visibility (⊥ `ui.preview`) is what makes it a preview sink. `ui.preview` = an explicit PIN — keep previewing while scrolled off — ⊥ the on-switch. w/o this a node renders nothing until wired to an Output, which reads as broken & hides the node you are authoring.
V28c: default-on previews are affordable ONLY because V28 suspends offscreen|collapsed. a 200-node graph previews the ~dozen on screen. ∴ V28b ⊥ shippable w/o V28's scheduler — they land together.
V28a: explicit sink list = AUTHORITATIVE ∀ previews — empty list means NONE visible, ⊥ "fall back to the flags". `undefined` = use document `ui.preview` flags. ∴ composition root ! pass ∀ visible previews once it derives them, ⊥ rely on the union.
V29: ∀ mutation → `AppCommandBus.execute`. ⊥ adapter mutates zustand | React Flow array | GPU resource directly.
V30: ∀ command carries `InvocationContext.actor`. ⊥ anonymous mutation.
V31: ∀ mutation → `AuditEntry`. recent window inspectable ∈ UI; ring bound 512 — ⊥ a bug: an unbounded log grows quadratically over a 60Hz drag session. durable full audit → IndexedDB append task if ever needed.
V32: `GraphPatch` atomic — ∀ ops apply | 0 apply.
V33: stale `baseRevision` → `conflict` ⟺ actual entity overlap. ⊥ silent rebase. patch ops classified value-only (param, position, ui) | structural (add, remove, connect, disconnect). value-only on disjoint entities ⊥ conflict w/ concurrent structural patch — else 60Hz human drag starves ∀ agent patch (T62 gate passes quiet, unusable next to live human).
V34: 1 patch → 1 undo group unless explicitly split.
V35: patch temp IDs resolved to stable IDs, returned ∈ `createdIds`.
V36: `dryRun: true` → validate + return diagnostics, ⊥ mutate, ⊥ audit as applied.
V37: tool result = structured data, ⊥ instruction to calling model. 3rd-party node text & project text = untrusted.
V38: capability grant required per class: local file, network, upload, export, recording, component install, project delete. calling tool ⊥ grants permission.
V39: bus adapter-agnostic. WebMCP | MCP server adapter = transport + schema only, 0 app-logic duplication.
V40: node delete → incident edges removed|tombstoned deterministically, same result ∀ actors. binds undo/redo RESTORE too, ⊥ only `removeNodes` op — restore ! refuse rather than leave a dangling edge (V65).
V41: undo actor-local. ⊥ erase other actor work. FULLY-blocked undo|redo → `rejected` + entry RETAINED, ⊥ revision bump, ⊥ "applied" audit for a no-op. blocked ← owner conflict OR referential integrity (V65) alike. partially-blocked → apply rest, consume, push to redo.
V42: agent activity visible — planning | editing | compiling | awaiting-approval shown in UI. ⊥ invisible background mutation.
V43: long render | sim cancellable.
V44: ∀ time-dependent node consumes `FrameEvaluationInput`. ⊥ read `Date.now` | `performance.now` | rAF directly. lint-enforced.
V45: ∀ random generator seeded from `randomSeed` (project|node). same seed + same frameIndex → same output.
V46: stateful node declares `{reset, deterministicReplay, checkpoint, randomAccess}` ∈ manifest.
V47: execution plan renders to offscreen target w/o visible surface. headless path = same graph + same compiler.
V48: ∀ readback isolated behind export interface. ⊥ readback call outside it.
V49: runtime ⊥ couple graph eval to rAF | wall clock. scheduler = swappable transport source.
V51: node format override = instance state, @ compile, ⊥ per-frame. absent → definition `formatPolicy`. ! validated vs capability report (V12) — unsupported → diagnostic + documented fallback, ⊥ crash, ⊥ silent swap. depth format ⊥ on color output. change → recreate targets + reset feedback (V22).
V56: project working space = linear RGB. import|media node decodes → linear. encode + tonemap ONLY @ output|display node. texture carrying non-color data flagged `data`, bypasses ∀ conversion. ⊥ node silently mixes encoded & linear.
V57: `texture2d` carries `space: "linear"|"encoded"|"data"`. exact-match under V13 — absent = linear (`colorSpaceOf`). ∈ propagation absent = NO CLAIM, derived fills it (`declaredColorSpace`). mismatch → diagnostic naming conversion node to insert, ⊥ silent convert.
V57a: data textures SHOULD read UNFILTERED — `textureLoad`, binding declares `sampled:"unfiltered"`, ⊥ sampler paired. vgpu has ⊥ non-filtering-sampler path at all; its model = sampler-paired-means-filtering. ∴ real dichotomy = sampled-through-sampler vs textureLoad, ⊥ linear-vs-nearest sampler.
V57b: compiler refuses ONLY the impossible case — filtered `r32float` w/o `float32-filterable` → `compiler/binding-unfilterable` error naming node + fix. filtering a filterable-format data texture (mask ∈ rgba8unorm) stays LEGAL: usually wrong, never unsafe. `space` ⊥ silently changes sampling — a silent switch changes rendered output invisibly (V13 philosophy).
V58: plan pass kind & resource kind = closed unions ∈ domain types. compiler & backend switch exhaustively. new kind → type error until handled everywhere. v1 emits `render` only, ⊥ texture-only assumption ∈ sort|prune|resource assign. `counter` kind = RESERVED, ⊥ encoded — lifecycle expresses scan/compact as ordinary `dispatch` passes, which proved cleaner. ⊥ wait for it.
V59: output identity = port-scoped. `OutputRef = {nodeId, portId}` ∀ backend|export|preview|tool surface. single-output node → default port `"out"`. ⊥ outputId ≡ nodeId.
V60: readback returns descriptor + bytes — {width, height, format, rowStride, bytes}. ⊥ bare `Uint8Array`.
V69: `ParameterValue` = envelope `{kind:"static", value}` | reserved bound kinds. unknown kind preserved through load→save, ⊥ rejects doc (V10, V68).
V70: presentation surface count = N per compiled output, worker-transferable (`OffscreenCanvas`). ⊥ React tree owns surface (V64). surface handed IN — `present(canvas, {outputId})`, canvas structural ({width, height, getContext}) so HTMLCanvas | OffscreenCanvas | stub all fit.
V70a: present blit = RAW copy. ⊥ sRGB encode, ⊥ tonemap ∈ present path. display transform belongs to the Output node ∈ graph (V56). ⊥ "fix" washed-out output by sneaking an encode into the blit — that hides which node is wrong and double-encodes once Output does its job.
V71: expression eval = own grammar ∈ `src/domain/expressions/`, sole engine. whitelisted fns, vars only ← `FrameEvaluationInput` + node ctx (frame names win on collision). ⊥ `eval`, ⊥ `Function`, ⊥ host global. deterministic by construction (V44, V45). `src/ui/controls/expression.ts` = thin wrapper, ⊥ 2nd evaluator.
V61: ∀ param read for eval|display → `resolveParameters(node, definition, frame)`. ⊥ other code reads `GraphNode.parameters` for evaluation. v1 = static passthrough; sole future injection point ∀ expression, curve, audio, MIDI, link.
V62: rebuild granularity = per-resource. unrelated graph edit ⊥ resets unchanged feedback pair. feedback resource identity stable ∀ unrelated edits (V22).
V62a: `resize()` ! reconcile retained program's descriptors + signature + memory estimate w/ live targets. ∴ recompile @ post-resize size = cache HIT → feedback history SURVIVES viewport resize. compile asking a size live targets ⊥ have → real rebuild. device-loss rebuild reallocates @ post-resize sizes, ⊥ silently reverts to compile-time sizes.
V62b: backend carries per-entry, ⊥ whole-plan. resource carried ⟺ structure key (id+kind+size+format) unchanged. effect carried ⟺ pass key unchanged AND target carried AND ∀ bound resources carried — a carried effect's bindings reference carried OBJECTS, so identity consistency is what makes reuse safe. carried pingpong → contents PRESERVED. recreated pingpong (size|format change) → zeroed = the correct reset (V22, V51 resetOn).
V62c: release by object identity, ⊥ by id — a rebuilt resource shares its id w/ predecessor; only predecessor dies. failed build releases NOTHING (carried objects still belong to retained program, V9).
V62d: `planStructureSignature` DERIVED from the same per-entry key fns. whole-plan fast path & per-entry diff ⊥ can disagree — 1 identity definition, ⊥ 2.
V63: ∀ data crossing compile→render boundary structured-clone-safe. ⊥ function, ⊥ DOM ref, ⊥ class instance. `NodeDefinition.compile` emits plain data (WGSL text + binding desc), ⊥ callback.
V64: presentable surface handed TO runtime, ⊥ owned by React tree. runtime supports N presentation surfaces per compiled output. opening|closing pane ⊥ stalls output.
V65: undo|redo owner-checked ∀ directions. redo ⊥ clobber other actor newer edit. restore ! preserve referential integrity — ⊥ dangling edge @ missing node (V40 cascade applies to restore, ⊥ only to removeNodes op).
V66: ∀ patch input structurally validated (zod) before apply. malformed → diagnostic + audit entry, ⊥ raw throw, ⊥ unhandled rejection. non-finite position rejected (NaN → null → doc unloadable).
V67: capability grant issued by bus-owned store keyed by actor. ⊥ read from caller-supplied context — self-grantable = ⊥ (V38).
V68: unknown|future-version serialized data preserved through load→save round trip. closed param schema ⊥ reject whole doc (V10).
V72: point identity = `pointId`, ⊥ slot index. compaction reorders slots; ∀ id-keyed state survives.
V73: per-point RNG = `hash(seed, pointId, frame)`. same seed + id + frame → same value ∀ device, ∀ browser|headless (V45).
V74: lifecycle (spawn|kill|compact) via scan/prefix-sum. ⊥ atomics ∈ lifecycle path — nondeterministic order ⊥ V45 + headless parity.
V75: pointset storage = SoA, 1 buffer per attribute. op binds only attributes it declares. ⊥ monolithic Point buffer.
V76: attribute→WGSL codegen = own module, headless-tested. ⊥ inlined ∈ node definition.
V77: kernel `contractVersion` checked before run. mismatch → diagnostic + refuse, ⊥ silent run against wrong ABI.
V78: context menu content ← bus command registry + keymap. ⊥ hardcoded action, ⊥ hardcoded key text. 1 menu root per surface, target resolved on open, ⊥ per-node root.
V79: component instance = `componentId` + `version` + own values. ⊥ copy internal graph unless detached. edit to definition → ∀ linked instances, detached ⊥ affected.
V80: published param drives N internal targets. 1 edit → 1 atomic patch → 1 undo group ∀ targets (V32, V34).
V81: `parent.<key>` resolved via resolver (V61), lexical up the instance chain. ⊥ direct cross-node param read.
V82: component compiles by FLATTENING into parent logical graph. source path preserved `Main/Feedback_2/Blur_1` ∀ diagnostic, timing, profile.
V83: component recursion ⊥ — direct & indirect. detected @ instantiate, save, load.
V84: instance pins component version. upgrade = explicit migration, ⊥ silent (V10).
V85: node info = read-only view over the runtime telemetry channel (V16), ⊥ document store, ⊥ its own subscription. refresh ≤ 10Hz. ⊥ readback (V7) — every field ← plan + timer spans + diagnostics already collected.
V86: node timing ← GPU timer spans, ⊥ CPU encode duration. timestamp query optional (V12) — absent → field reads "unavailable", ⊥ a fabricated number.
V87: component info aggregates over its flattened passes by source path (V82): own | children | total. ⊥ reporting only the instance's own pass.
V88: example project = real `.loom.json` loaded through the SAME loader as a user file (V10). ⊥ hand-built in-memory fixture — an example that only exists as code ⊥ prove the format works.
V89: ∀ example ! load, compile w/ 0 error diagnostics, and render deterministically from a fixed seed + frame sequence (V45). CI runs them; a broken example = release blocker.
V113: compound params (color, vector) are COMPONENT-ADDRESSABLE — `color.g`, `t.x` each carry their own mode + value (V107). a color you ⊥ animate per channel is a picker, ⊥ a parameter. manifest stays compound; the SLOT is per component; resolver reassembles.
V114: the compound editor (swatch, xyz row) writes ∀ components in ONE patch = 1 undo entry (V15, V32). ⊥ 4 patches for 1 colour pick.
V107: ∀ parameter, ∀ TYPE, accepts ∀ mode: static | expression | bind | driven. ⊥ expressions-on-numbers-only — a mode available on some parameters is a mode users ⊥ trust.
V108: mode switch is NON-DESTRUCTIVE — each mode keeps its own last value, and the UI shows which inactive modes hold one (TD's corner square). flipping to Constant to check a number ⊥ costs you the expression you were writing.
V109: mode evaluation happens ONLY ∈ `resolveParameters` (V61). the compiler, the inspector & the runtime ∀ read the resolved value — ⊥ a second evaluator, ⊥ a node reading its own raw slot.
V110: `bind` = a REFERENCE, resolved lexically (`parent.<key>`) or by explicit path. cycles detected @ bind time, ⊥ @ evaluation — an expression cycle discovered per-frame is a hang, discovered @ authoring it is a diagnostic.
V105: help content DERIVED from live sources — shortcuts ← keymap (V55), node docs ← manifests, expression fns ← the evaluator's own whitelist. ⊥ a hand-written copy: a rebound key or a renamed param makes hand-written help WRONG, and wrong help is worse than none because it is trusted.
V123: `pulse` = a parameter type, ⊥ a node feature — declared once, available to any node (TD Pulse). ∀ node w/ `stateful.reset === true` (V46) SHOULD expose one.
V124: a pulse mutates RUNTIME state, ⊥ document state ∴ audited (V31), ⊥ undoable, ⊥ serialized. a pulse persisted as "on" would re-fire on load & wipe your work every open.
V125: a pulse takes ∀ parameter mode (V107) — an expression firing it is how an automated reset happens: on a beat, a threshold, a frame count. a trigger you can only click is ⊥ a trigger, it is a button.
V126: pulse reset is PER-RESOURCE, ⊥ whole-backend. `resetTemporalHistory()` is global today ∴ resetting one Feedback would clear every other node's history — the reason `runtime.resetFeedback` stayed unregistered (V62).
V119: recording is a NODE, ⊥ a global action. topology decides what is recorded ∴ several recorders may run at once, on intermediate branches. a recorder declares `sink: true` (V25) — recording is its side effect & it ⊥ be pruned for having no consumer.
V120: a recorder captures by `frameIndex` via the export interface (V48, T111), ⊥ by sampling a clock. a take that dropped|duplicated frames = a WRONG recording, ⊥ a shorter one — it ! fail the take, ⊥ silently ship.
V122: 1 media-in node covers still|sequence|video (TD Movie File In). params that ⊥ apply to the loaded asset are HIDDEN, ⊥ disabled-and-visible — a still has no in|out point, and showing one teaches the user the node is broken.
V121: media nodes reference an `AssetReference`, ⊥ a raw path or an object URL (V10). unresolved asset → relink flow, keeps identity. decode behind a media-source abstraction ∴ WebCodecs can replace `HTMLVideoElement` w/o touching a node.
V116: node size = DOCUMENT state (`GraphNode.size`, already ∈ contract) — persisted, undoable, 1 patch per gesture (V15). resize is how a graph gets a layout: a key node big, the rest small. ⊥ view-only state, else a saved project loses its composition.
V117: a resized node buys a BIGGER TILE, ⊥ a stretched one. preview resolution follows the node's preview area, quantised to the size ladder + capped by `previewLongEdge` (V28c) — the cap is what keeps default-on previews affordable, so it survives resizing.
V118: preview preserves the SOURCE aspect inside the region — letterbox, ⊥ stretch. a stretched preview lies about the image, and the node body's aspect is whatever the user dragged, ⊥ what the texture is.
V111: tile rects are COMPUTED (`graphPos × zoom + pan`), ⊥ measured. `getBoundingClientRect()` per slot per frame = dozens of forced layouts during pan|drag, the busiest gesture ∈ the app — and a rect measured ONCE goes stale the instant anything moves.
V112: tile placement follows the LIVE VIEW position, ⊥ the document position. a node drag is deliberately uncommitted until release (V15 coalesces it to 1 undo entry), so `GraphNode.position` is STALE for the whole gesture — the exact window where the preview must keep up.
V106: a preview surface composited OVER the graph ! be genuinely transparent — WebGPU canvas `alphaMode` defaults to **opaque**, so a transparent CLEAR still paints black. `alphaMode:"premultiplied"` + clear to (0,0,0,0). an opaque overlay hides the entire app except its tiles.
V101: a per-node UI toggle (bypass|preview|mute) acts on the SELECTION when that node is in it, else on that node alone. ⊥ badge dispatching a raw patch: it ! go through the same bus command the key + menu use, else three surfaces diverge (V29, V52).
V102: multi-node toggle SETS all to one value, ⊥ flips each independently — a mixed selection becomes uniformly ON, then uniformly OFF. flipping each keeps mixed selections mixed forever, which is never what the user meant by selecting them together.
V103: `compileShader` `validated:false` = the DEVICE ⊥ report compilation info — UNKNOWN, ⊥ broken. editor shows "unvalidated on this device", ⊥ red. `ok:true` only when validation actually RAN clean.
V104: a pointset TRANSFORM owns FRESH pairs for everything it outputs (position copied through) — consumers derive pair ids from their source node id, so modifying an upstream pair in place would alias sim state across nodes. generalizes to ∀ pointset op.
V115: STATE outranks a transient pointer cue. selection|error|bypass ⊥ replaced by `:hover` — a selected node under the cursor ! still read as selected. hover adds (a ring, a tint), ⊥ overwrites the property state owns. specificity: state selectors ! be ≥ the hover selector, ⊥ rely on source order.
V99: ∀ pointer target ≥ ~20px even when its VISUAL is smaller. a 7px port dot is a coin toss, and missing it drags the NODE — you meant to wire and you moved the thing you were wiring. expand w/ an invisible pad, ⊥ by growing the dot (a bigger dot dominates a dense graph).
V100: a disabled preview region shows the node's RESOLVED FACTS (size, format, space) — ⊥ a black rectangle. off ⊥ mean empty: the space is already spent, so it should carry what the user would otherwise open the info popup for.
V90: help = ON DEMAND, ⊥ ambient. carried by the LABEL — hover|focus it, ⊥ a separate `?` element. an indicator for something the label already implies is 1 more thing ∈ a dense panel, and a 3rd child ∈ a 2-column row wraps to its own line. inline text ∈ a control row limited to: label, value, unit, state badge. ∀ explanation → hover|focus|tooltip|`?` handle. a node has 10-15 params — a sentence under each buries the values the user came to read, is read once, then permanently ∈ the way. text ⊥ lost: reachable by hover, focus & screen reader.
V91: empty state names the STATE ("No selection", "No problems"), ⊥ the pane's purpose, ⊥ its implementation. "CodeMirror 6 mounts here" teaches a user nothing actionable. hint ? only when the next ACTION is genuinely non-obvious.
V92a: device|build diagnostics (tier, timestamp query, format list, memory, resource counts) belong ∈ the PERFORMANCE surface, ⊥ ∈ a content surface. the viewer shows OUTPUT or an empty state — a GPU spec sheet where pixels belong is a debug affordance that outlived its debugging.
V92: ⊥ decorative prose ∈ chrome — ⊥ taglines, ⊥ "Tip:", ⊥ restating a label in a sentence. if a label needs a sentence, the LABEL is wrong. dense pro tool: imagery = hero, chrome competes w/ it (§C).
V98: a port type = a STATIC CLAIM a dynamic parameter ⊥ break. kernel node's output port advertises `position: vec3f` ∈ its provides set; the attributes JSON param ⊥ remove it, enforced @ schema validation. custom schemas otherwise free. else a graph type-checks @ edit time and the producer silently stops providing what the edge promised.
V93: node|component|example = 3 libraries, 3 verbs — add | instantiate | OPEN. ⊥ one merged browser: open REPLACES the document, and a destructive verb ⊥ sit one click from additive ones. open ! confirm when dirty; add|instantiate ⊥ confirm (undoable).
V94: a shipped component = the SAME `GraphComponentDefinition` a user saves (V79). ⊥ a privileged format — else the shipped set stops being a worked example of the thing users make.
V95: ∀ pane relocatable — dock zone left|right|bottom|center, or FLOAT (own window). ⊥ pane hardcoded to a slot. arrangement persisted ∈ localStorage (V18), ⊥ ∈ project doc. shader editor forced to the bottom dock = the specific complaint; the general rule is the fix.
V96: relocating a pane ⊥ REMOUNTS its content. CodeMirror keeps scroll, selection & undo history; a preview keeps its tile; a running editor keeps focus. same failure as the dock's forceMount fix (U3), reached by dragging instead of by tab-switching — a pane that forgets on move is a pane you ⊥ move.
V97: a floated|popped-out window shares ONE app state — same bus, same store, same runtime (V29). ⊥ a second runtime ∈ the child window. it renders through the SAME presentation machinery as multi-window perform mode (V64, V70): surface handed to the runtime, N surfaces per output. → bus command by name (V29). binding = data, ⊥ inline handler, ⊥ hardcoded key ∈ component.
V53: keymap context-scoped. narrowest context wins. `text` context swallows editing keys — mod+z ∈ shader editor ⊥ graph undo.
V54: user override layered over defaults, ∈ localStorage, ⊥ ∈ project doc. conflict detected + surfaced, ⊥ silent shadow. reset-to-default per binding & whole map.
V55: ∀ binding discoverable — command palette lists ∀ command + its key; menus & tooltips show binding from keymap, ⊥ hardcoded string.
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
T51|x|route ∀ human action through bus — toolbar, menu, keybind, inspector edit, drag-connect|V29
T52|x|`revision` counter + `AuditEntry` log + actor identity, audit viewer in dock|V31,V40
T53|x|undo groups keyed to command\|patch, actor-local history|V34,V41
T13|x|`RenderBackend` iface + vgpu adapter impl, device init, capability report|I.backend,V2,V12
T14|x|device-loss handling: halt, diagnose, rebuild from graph, reset temporal|V23
T15|x|Phase0 spike nodes: Solid, CustomWGSL, Output|I.wgsl
T16|x|frame loop via vgpu frameLoop, shared uniforms (time, frame, pointer, resolution)|V8
T64|x|lint rule: ⊥ `Date.now`\|`performance.now`\|rAF ∈ `src/nodes/**` — frame input only|V44
T65|x|seeded RNG: project seed + node seed → deterministic per frameIndex|V45
T17|x|uniform-only update path, ⊥ recompile|V5
T18|x|custom node component: title bar, status dot, ports L/R, preview slot, bypass/mute|V26
T19|x|edge renderer: flow-dash anim, hue=port family, speed←GPU ms, static if reduced-motion|V19,V26
T20|x|CodeMirror6 WGSL editor in bottom dock, theme from tokens|C
T21|x|shader diagnostics: debounce, async compile, line/col map, node badge + problems tab|V9,V27
T22|x|retain last valid program + stale-output indicator|V9
T23|~|**Phase0 exit**: uniform live-update, WGSL recompile, invalid WGSL keeps output|V5,V9
T71|x|`NodeResolutionOverride` on `GraphNode` + zod + `setNodeResolution` patch op + bus command|V50,I.res
T74|x|`NodeFormatOverride` on `GraphNode` + zod + `setNodeFormat` patch op + bus command|V51,I.fmt
T24|x|compiler: resolve defs, validate params+connections|V13,V14
T25|x|compiler: split temporal edges, reject illegal cycles, topo sort|V4
T26|x|compiler: active-sink trace + prune|V25
T27|x|compiler: resolution propagation (`ResolutionPolicy`)|V21
T72|x|compiler: honor per-node resolution override in propagation, clamp to project limits, recreate targets on change|V50,V21,V24
T75|x|compiler: honor per-node format override, validate vs capability tier, diagnostic + fallback when unsupported|V51,V12
T28|x|compiler: format propagation rgba8unorm / rgba16float|V21
T29|x|compiler: logical resource assign, persistent target per materialized output|V8
T30|x|compiler: emit plan + structured `RuntimeDiagnostic[]`|I.diag
T31|x|recompile classifier — edit kind → minimal work|V5,V21
T32|x|branch reuse: 1 render per output, shared by N consumers|V6
T33|x|Feedback node: pingPong pair, swap after encode, reset triggers|V22
T66|x|manifest field: stateful node declares reset\|deterministicReplay\|checkpoint\|randomAccess|V46
T80|x|`OutputRef {nodeId, portId}` ∀ backend/export/preview/tool surface, default port `"out"`|V59
T81|x|SUPERSEDED by T115 (same union, landed w/ dispatch\|draw\|counter + buffer\|bufferPair)|V58
T82|x|readback descriptor {width,height,format,rowStride,bytes} replaces bare Uint8Array|V60,V48
T83|x|`texture2d.space` linear\|encoded\|data + compiler propagation + mismatch diagnostic|V56,V57
T84|x|`ProjectSettings.colorPolicy` {workingSpace, displayTransform} + zod + defaults|V56
T85|x|`resolveParameters(node, def, frame)` ∈ `src/domain/parameters`, sole eval read path|V61
T86|x|SUPERSEDED by T143 (backend per-entry carry-over; V62b now the rule)|V62,V22
T87|x|presentation seam: `present(outputRef, surface)`, N surfaces, runtime-owned|V64,V7
T88|x|fix redo owner check + undo referential integrity (edge cascade on restore)|V65
T89|x|zod validation of patch input @ bus boundary → diagnostic + audit, ⊥ throw|V66
T90|x|bus-owned capability grant store keyed by actor, injectable clock for expiry|V67
T91|x|forward-compat passthrough lane: unknown params/nodes preserved through round trip|V68,V10
T92|x|lint: ⊥ document\|window ∈ src/compiler, src/runtime (except surface module)|V63
T93|x|lint: ⊥ import store `internals`\|`raw` outside src/domain/commands + tests|V29
T94|x|fix resize: bind Target not `plain.color` — sampled intermediates hold destroyed texture|V21
T95|x|route WGSL compile failures to `onDiagnostic`; represent V9 stale flag in backend status|V9,V27
T96|x|real capability format query (⊥ hardcoded list); `float32-filterable` gates r32float sampling|V12,V51
T97|x|clamp plan sizes vs `capabilities.limits` + memory accounting|V24,R7
T98|x|frame-loop error boundary + device-loss retry API, ⊥ terminal halt|V23
T99|x|diagnostic dedupe/rate-limit; ⊥ per-frame flood|V16
T100|x|live clock: accumulate time from clamped deltas, reset time base; f32 time rebase|V44,V49
T101|x|autosave: dirty state, debounced IndexedDB/OPFS ring (20), restore-on-launch flow|V10
T102|x|dryRun returns `validated` status + ⊥ mint real ids|V36
T103|x|commit cost: immer patches for dirty keys, audit ring buffer, owner GC|V16
T104|x|group + viewport patch ops (groups undoable but uncreatable via bus today)|V29
T105|x|PWA manifest|C
T106|.|`ParameterValue` envelope migration + passthrough lane for unknown kinds|V69,V68,V10
T107|x|patch-op classification value-only\|structural + overlap-scoped conflict|V33
T108|x|expression evaluator: jsep-style AST, whitelisted fns, `FrameEvaluationInput` vars only. v1 arithmetic|V71,V44,V45
T109|x|non-rAF frame loop option (worker + node realtime)|V49,V63
T110|.|Phase 2 seam: multi-window perform mode — N surfaces, OffscreenCanvas transfer|V70,V64
T111|x|WebCodecs mp4 export — VideoEncoder, exact-frame capture ← render loop|V48
T112|.|lazy-boundary convention: dock tab + canvas code-split before heavy deps land|C
T114|x|`pointset` port kind + attribute-requirement compat, replaces `geometry`|V13,I.pointset
T115|x|plan IR: `dispatch` `draw` `counter` pass kinds + `buffer` resource kind, declared|V58
T116|x|`contractVersion` on `NodeDefinition` + kernel ABI check|V77
T117|x|**attribute→WGSL codegen module** — own task, headless, heavily tested. TOP RISK|V76,V75
T118|x|SoA point storage: 1 buffer per attribute, alloc/resize/free|V75,V24
T119|x|scan/prefix-sum compaction for spawn/kill. ⊥ atomics|V74,V73
T120|x|per-point RNG `hash(seed, pointId, frame)` + `pointId` identity|V72,V73,V45
T121|x|custom per-point WGSL kernel node (`fn process`)|V77,I.kernel
T122|x|sprite render path (spine step 1 of sprites→instances→mesh)|V58
T123|.|point viewer + attribute spreadsheet, windowed readback ≤10Hz|V48,V16
T124|x|`TextureToAttribute` bridge node (TOP→POP)|V13
T125|x|`read_points` agent tool — windowed, via export iface|V37,V48
T126|x|context menu engine: `MenuTarget` resolution, items ← bus registry, keys ← keymap, 1 root per surface|V78,V29,V55
T127|x|menus for canvas (add node @ cursor, paste, layout), node (bypass, mute, preview, rename, color, delete, dive in), port (disconnect, insert conversion), edge (delete, reroute), parameter (reset, copy path, publish)|V78
T128|x|`GraphComponentDefinition` + instance type + zod + component registry|V79,V84
T129|x|save-selection-as-component + instantiate (linked \| detached copy)|V79,V83
T130|x|enter/exit component, breadcrumb trail, nested editing|V82
T131|x|expose internal port → external component port|V79
T132|x|publish parameter: internal param → component param page, N targets, re-authored range/label|V80
T133|x|`parent.<key>` scope resolution through the resolver, ∀ nesting depth|V81,V61
T134|x|compiler: flatten component instances, preserve source path ∀ diagnostics + timing|V82
T135|x|recursion detection — direct + indirect — @ instantiate, save, load|V83
T136|x|component version pin + explicit upgrade migration|V84,V10
T137|x|component inspector: param page, exposed ports, version + upgrade affordance|V79,V17
T138|x|fully-blocked undo ⊥ consume history entry — today it empties, bumps revision, audits "applied" and pops. reject without consuming|V41,V65
T140|x|`resize()` reconciles descriptors + signature + memory estimate w/ live targets|V62a,V21
T141|x|`compile()`|`loop()` await in-flight recovery, ⊥ throw "before initialize()"|V23,V98
T142|x|compiler emits `compiler/memory-budget` warning vs `settings.limits.memoryBudgetBytes`; shared `estimateResourceBytes` ∈ plan.ts|V24
T143|x|backend diffs per-entry `resourceSignatures` ⊥ whole-plan signature — unrelated edit ⊥ wipes feedback|V62,V62b,V22
T144|x|unify identity: `CompiledGraph.resourceSignatures`/`passSignatures` ← plan.ts `resourceStructureKey`/`passStructureKey`. compiler + backend share 1 definition, ⊥ 2 that drift|V62d
T145|x|node info popup — TD MMB analog. res+aspect, format+space, est bytes, gpu ms, frames rendered, cooked-this-frame, pass count, warn/err, resolution source, bypass/mute/stale. MMB + keymap + context menu, all → 1 surface|V85,V86,I.info
T146|x|component info aggregate: own | children | total time, pass + node count, over flattened source path|V87,V82
T147|x|scratch/intermediate target kind ∈ plan IR — node needs >1 pass. unblocks separable Gaussian Blur (today: 1 pass, 81 taps, under-samples past ~dozens of px) + ∀ multi-pass filter|V58,V8
T148|x|decode `space:"display"` color params → linear @ resolver. 1 fix covers ∀ picker-driven nodes, ⊥ 20 in-shader curves|V56,V61
T149|x|`resolveColorSpace` ! follow the port named by `formatPolicy.inherit`, ⊥ `colorInputs[0]` ∈ edge-id order|V57
T150|x|per-node sampler | extend-mode resources — today 1 shared clamp-to-edge sampler per plan, repeat/mirror done as in-shader coord math|V58
T151|x|`ResolutionPolicy` derived from a parameter — Crop keeps input res + blanks outside region, ⊥ resizes like TD Crop TOP|V21,V50
T152|x|**Feedback node** — `TemporalDefinition`, prev-frame read, swap after consumers, reset + seed input. compiler/backend support exists, ⊥ node declares it, ∴ feedback unreachable from UI|V22,V50
T153|x|example E1 Feedback Echo — `.loom.json` + regression fixture + concept doc|V88,V89,V22
T154|x|example E2 Reaction-Diffusion — Gray-Scott CustomWGSL kernel, seeded init, pause/step/reset|V88,V89,V45
T155|x|example E3 Animated Noise Field — perlin4d t4d ← frame time, fan-out once|V88,V89,V44,V6
T156|x|example E4 Bloom + E5 Kaleidoscope + E6 Displacement Stack|V88,V89,V51,V56
T157|x|example runner: load ∀ example, compile, assert 0 errors + deterministic render. CI gate|V89
T158|x|fix B1+B2 — depth fallback ⊥ pick a color format; `formatNoFallback` ⊥ return an unallocatable format. test AFTER fixing, ⊥ pin current behavior|V51,V12
T159|x|fix B3 — `resolveSinks` doc ≠ impl on preview narrowing. pick one, make the other match|V25
T160|x|`nodeGpuHost()` ∈ `src/runtime/backend/vgpu/node-gpu-host.ts` — the V3-clean Dawn host. parity harness deletes its eslint-disable + imports it|V3,V47
T161|x|preview pass-SUBSET encoding: `render()` accepts pass ids to encode this frame. w/o it refresh cadence = rebuilding the plan @ 15-30Hz|V8,V28
T162|x|CI needs a GPU-capable runner for the Dawn suite — tests fail loud when Dawn absent, ⊥ skip into green|V89
T163|x|backend GPU timing surface — `timer(gpu)` after init when `timestampQuery`, `timer: t.span(pass.id)` ∈ `f.pass()`, forward `t.onResults`. span name = pass id. ⊥ exists today ∴ T41 reads "unavailable" everywhere|V86,V12
T164|x|`ResolvedOutput` carries `resolutionSource` `formatSource` `clamped` — compiler computes them ∈ `propagate()` then discards. popup MIRRORS the precedence today = drift risk|V50,V51,V85
T165|x|fix B6 — Output node targets the PROJECT surface, ⊥ inherits its input's size/format|V21,V50
T166|x|fix B7 — `customWgsl` emits `uniformBinding` + `sharedBinding` so a kernel gets uniforms + time; default `source` ⊥ declare a block bound to nothing|V5,V44
T167|x|friendlier port label ∀ UI — `describePortType` is diagnostic-shaped (`texture2d<float,4,linear>`); the library port-drag chip renders it raw|V17,V19
T172|x|backend `encode()` wires `dispatch`/`draw` passes — buffers ALLOCATE today but kernels ⊥ run ∈ a frame. blocks T121 kernel node rendering|V58,V8
T178|.|UI copy audit vs V90/V91/V92 — ∀ surface: node body, inspector, library, viewer, dock, palette, menus, agent panel. + a guard test bounding inline prose per surface|V90,V91,V92
T194|x|compiler deltas for point passes: dispatch/draw emittable, bufferPair scratch, pointset outputs materialize as a marker, pair swaps, chain test. point family registered ∴ rides the catalogue sweep. (landed ∈ commit 4ca9c4f, which is MISLABELLED T176 — T176 is the bus track's zod lift, still open)|V58,V22,V75
T217|.|fix B9: await pipeline creation | `pushErrorScope`/`popErrorScope` BEFORE installing the program; route the failure to `onDiagnostic` + set `stale`; keep the previous program. AND make the mock reject the way Dawn does, else the test stays greener than the product|V9,V27
T218|.|fix B10: live parameter values ∀ gesture — find why the composed app swallows them (suspect editor lifecycle ∈ `inspector.tsx`). add a test @ the COMPOSED level, ⊥ only per-module|V15,V5
T219|.|fix B11 (DATA LOSS): commit the shader edit before unmount; ⊥ report "saved" when nothing was|V9,V29
T220|.|wire `createAgentToolSurface` into the composition root + inject its ports|V39,B12
T214|.|`pulse` parameter type + control (momentary, ⊥ serialized, audited ⊥ undoable) + expression-fireable|V123,V124,V125,V107
T215|.|per-resource temporal reset so a pulse clears ONE node's history, ⊥ every pair. unblocks `runtime.resetFeedback`|V126,V62,V22
T216|.|expose Reset on nodes declaring `stateful.reset`: Feedback (+ hold toggle, TD pairs both), Noise reseed, accumulator, point sim|V123,V46
T210|.|**MovieFileOut** node — texture in → encoded file out, `sink: true`, drives T111 exact-frame capture, capability-gated (recording + localFile, V38). several may run at once|V119,V120,V48,V38
T211|.|**MovieFileIn** node — image\|video\|sequence → texture. play/pause/seek/loop/rate, in\|out points, outputs res + current time + duration + frame-ready. `AssetReference`, media-source abstraction|V121,V10,V13
T212|.|drop a connection ON AN EDGE → replaces it (takes that edge's target). 1 patch = disconnect + connect, 1 undo group. generous invisible hit area on the edge|V14b,V14c,V32,V34
T213|.|drop a NODE on an edge → SPLICE it inline (upstream→node→downstream) when types allow. 1 patch. the sibling gesture: the edge as a drop target for a node, ⊥ only for a connection|V14b,V13,V32
T208|.|node resize: React Flow NodeResizer + `setNodeSize` patch op, 1 patch per gesture, persisted ∈ the document, min size respected|V116,V15,V29
T209|.|preview tile resolution follows the node's preview area (ladder-quantised, capped), aspect letterboxed ⊥ stretched|V117,V118,V28c
T206|.|preview tiles follow a node drag: compute rects w/ `slotScreenRect(slot, viewport)` ← React Flow's LIVE node positions, every display frame. today `node-preview-slot.tsx:39` measures w/ `getBoundingClientRect()` — the design note (§2) rejected measuring explicitly|V111,V112,V16
T207|.|component-addressable slots: `color.r`/`t.x` each w/ own mode+value; resolver reassembles; compound editor writes ∀ components ∈ 1 patch|V113,V114,V107
T202|.|`ParameterSlot` + `ParameterBinding` ∈ domain types + zod + passthrough for unknown kinds (extends T106). ∀ mode keeps its own value|V107,V108,V69
T203|.|resolver evaluates ∀ modes — static, expression (V71 evaluator), bind (incl. `parent.<key>`), driven reserved. sole eval point|V109,V61,V71
T204|.|parameter mode UI: click the LABEL to expand → 4 mode buttons w/ TD's has-a-value corner mark; ctrl/cmd+E edits the expression; right-click menu|V107,V108,V90
T205|.|bind cycle detection @ authoring time, ⊥ @ evaluation|V110
T200|.|help panel (mod+/ or ?): shortcuts ← keymap, node reference ← manifests, expression guide ← evaluator whitelist. on-demand, ⊥ ambient (V90)|V105,V55,V90
T201|.|expression authoring surfaced @ the parameter — how to drive e.g. noise translate from `time`, which vars + fns exist, live-evaluated preview of the result|V105,V71,V61
T198|.|node badges (P/B/M) dispatch `node.toggle*` w/ the SELECTION, ⊥ a raw single-node patch. today `node-view.tsx:47` bypasses the command ∴ badge ≠ key ≠ menu|V101,V102,V29,V52
T199|.|wire `read_points`: `createPointsReadback({ readBuffer, pointSetInfo, now })` — clock ! be INJECTED (the export boundary test caught a `Date.now` default)|V48,V16
T197|.|preview OFF renders the node's resolved size/format/space, ⊥ a black box (V100). preview ON but not yet rendered = a distinct state, ⊥ the same blank|V100,V91
T196|.|move `GpuStatusCard` out of the viewer → performance panel (beside est. bytes, lastBuild, per-pass ms). viewer empty state = "No output" per V91; drop the implementation prose entirely|V91,V92a
T195|x|standalone WGSL compile — today WGSL is only checked when the GRAPH compiles on a device ∴ a shader error ⊥ surface until the whole graph is wired + rendering|V9,V27
T191|.|dockable pane system: zones (left\|right\|bottom\|center), drag a pane between them, persisted arrangement, ∀ pane not just the shader editor|V95,V18
T192|.|float / pop-out a pane into its own window, sharing ONE bus + store + runtime. shares the multi-window transport w/ T110 perform mode|V97,V64,V70,V29
T193|.|relocation preserves content — portal|reparent so CodeMirror & previews survive a move w/o remount|V96
T188|.|component library browser — shipped + user, instantiate linked\|detached, version + upgrade shown, save-selection-as-component surfaced|V93,V94,V79,V84
T189|.|example library browser — open project, confirm when dirty, reads the 6 shipped `.loom.json`|V93,V88
T190|.|ship the starter component set: FeedbackEcho, Bloom, DisplacementStack, MediaGrade, Kaleidoscope — as real saved components, ⊥ a privileged format|V94,V79
T187|.|`component-scope.ts::resolveInstanceValues` returns DECODED `.values` into the parent scope ∴ a display colour decodes TWICE (mid-grey → ~0.046). ! return stored-space `entries[].value`, as `flatten.ts` now does|V56,V61,V81
T184|.|**START THE FRAME LOOP.** `backend.loop()` is called NOWHERE ∴ nothing renders — ⊥ node preview, ⊥ viewer, ⊥ output. compiler runs, backend exists, ⊥ frame is ever driven|V8,V49
T185|.|mount the preview system: construct `createPreviewSystem`, `backend.previewHost(canvas)`, feed `PreviewSystemFrame.requests` ← visible set, present tiles per frame|V7,V28,V64
T186|.|drop-on-occupied-input REPLACES the edge in 1 patch|V14a,V32,V34
T182|.|previews default-on for visible texture nodes: composition root derives visible set → explicit sink list (V28a) ∀ compile. `ui.preview` becomes a PIN. today a disconnected node renders nothing|V28b,V28c,V28a,V25
T183|.|`.subTrigger[data-state="open"]` uses `--bg-raise` while `.item[data-highlighted]` uses `--bg-active` ∴ the highlight visibly CHANGES when a submenu opens. open parent ! look identical to highlighted|V17
T179|.|buffer binding half-selector (`resourceId` + `half:"read"|"write"`) + swap pass, so a stateful kernel's `out_` bindings reach the write half. today in/out are 2 separate buffers|V22,V75
T180|x|`clear` knob on draw passes — vgpu's standalone draw clears by default; trails-style accumulate needs `clear:false`|V58
T181|~|GPU timer spans for dispatch/draw — literal draws DONE (f.pass gives clear+timer); indirect draws & ALL compute ⊥ measurable: vgpu has no timestampWrites hook on compute passes. UPSTREAM GAP — T163 covers effect passes only ∴ compute cost is unmeasured|V86
T173|x|`RenderBackend.readOutput(id, {region?}) → ReadbackImage` — completes T82. today returns bare bytes ∴ format+stride come from a table BESIDE the copy, ⊥ from the thing that copied. also: a 1×1 probe pulls a whole 1080p frame|V60,V48
T174|x|bus commands the agent surface needs & ⊥ exist: `graph.setOutput` `runtime.resetFeedback` `project.validate` `project.compile` `transport.play|pause`|V39
T175|x|bus QUERIES for `get_selection` `get_diagnostics` `get_runtime_metrics` `project.get` — injected ports work in-tab only; an out-of-process MCP server needs real queries|V39
T176|x|lift `GraphPatchOperation` zod into `domain/types/schemas.ts` — agent guards its own boundary only; every caller needs it (V66)|V66
T177|x|`transactionId` on `HistoryGroupSummary` (or a `graph.revertTransaction`) so revert-as-one-unit ⊥ rely on an adapter-side ledger|V42,V34
T169|.|`GraphStore.replace(graph, {clearHistory})` committing through the same path as `apply` + a `project.load` command, so open is in-place w/ an actor. today open = teardown+rebuild ∴ undo history ⊥ survives|V29,V30,V31,V41
T170|.|`Inspector` accepts `unresolvedParameters?: readonly string[]` — today a node w/ ANY newer-version param suppresses ALL its controls|V68,V10
T171|.|attach the timing source where the frame loop lives — T163's backend surface exists; composition root ⊥ runs a loop ∴ attaching there would park ∀ fields on "measuring…" forever|V86
T168|x|promote `resolveParameters` → `src/domain/parameters/`, compiler + inspector BOTH evaluate through it. fixes B8. V61 says ONE read path & there are 2 — the exact drift the invariant exists to stop|V61,V56
T139|x|wire autosave into composition root: subscribe to commits, flush before save/unload, restore-on-launch prompt, IndexedDB-unavailable diagnostic|V10
T113|x|preview atlas design note BEFORE impl — atlas-behind-DOM vs per-node canvas, dpr + zoom|V7,V28
T34|x|preview system: shared atlas, tile alloc for visible \|pinned only, 192px long edge, 15-30fps|V7,V28
T35|x|debug preview effects: color, single-channel, alpha-on-checker, NaN/Inf highlight|V7
T36|x|large viewer pane: pinned output, channel toggles, px value under cursor|I.ui
T67|x|plan renders to offscreen target w/o visible surface — headless path shares compiler|V47
T37|x|param control kit: draggable number (shift slow/alt fast), dbl-click reset, units, enum, color, bool|V20
T38|x|inspector pane: manifest-driven full control set, grouped|V17
T76|x|keymap engine: binding table, chord + context resolution, `mod` normalize, when-guards, dispatch → bus|V52,V53
T77|x|default TD-informed keymap + `when` guards + selection-resolved inputs|V52
T78|x|keybinding settings pane: rebind, conflict detect + warn, per-binding & full reset, persisted overrides|V54
T79|x|command palette (mod+k): fuzzy search ∀ bus command, shows binding, runs via bus|V55,V29
T73|x|node Common section: resolution select (auto\|project\|input\|1/8..8x\|custom) + w/h, format select, resolved size+format readout on node & inspector, unsupported-format warning|V50,V51,V17
T39|x|node library pane: search, categories, drag-to-canvas, port-drag→compatible-node search|V13
T70|x|Noise node — TD Noise TOP parity. type: perlin2d/3d/4d, simplex2d/3d/4d, sparse, hermite, harmonic, alligator, random, randomgpu. params (TD names): seed, period, harmon, spread, gain, rough, exp, amp, offset, mono, aspectcorrect + TRS xform (xord/rord/t/r/s/p) + t4d/s4d. 4D translate = time evolve ← `FrameEvaluationInput`, ⊥ wall clock|V44,V45,I.registry
T40|x|core node set, TD TOP vocabulary: Ramp, UV, Checker, Circle/SDF, Transform, Crop, Tile/Mirror, Level, HSV, Blur, Threshold, Displace, Lookup/Colorize, Over, Add, Multiply, Screen, Difference, Mask|I.registry
T41|x|GPU timer spans, per-pass ms, performance tab, resource count + surface `plan.estimatedResourceBytes`, `compiler/memory-budget` warning, `BackendStatus.lastBuild` {resourcesCreated/Reused, effectsBuilt/Reused}|V16,V24
T42|x|metrics pipe outside document store, ≤10Hz UI tick|V16
T68|x|export interface = sole readback surface. screenshot/PNG v1|V48,V7
T54|x|read tools: get_project_summary, get_graph, get_selection, list_node_definitions, get_node_definition, get_node, get_diagnostics, get_runtime_metrics|I.tools,V37
T55|x|`apply_graph_patch` — atomic ops, baseRevision conflict, temp→stable `createdIds`, 1 undo group|V32,V33,V34,V35
T56|x|mutation tools on bus: add_node, remove_nodes, connect_ports, disconnect_ports, set_parameters, set_shader_source, set_output, reset_feedback, undo, redo|V29,V30
T57|x|workflow tools: validate_project, compile_project, play, pause, save_project|I.tools
T58|x|`render_preview` → bounded-size PNG of any texture output, via export iface|V48,I.tools
T59|x|capability grant model + gate table, dryRun on destructive, ⊥ self-grant|V36,V38
T60|x|agent presence UI: actor badge, planning\|editing\|compiling\|awaiting state, patch review + revert-transaction-as-unit|V42
T43|x|save/load `.loom.json` via `src/domain/project/serialize.ts` (CANONICAL — ⊥ 2nd serializer), migration scaffolding, unknown-node placeholder|V10
T44|x|resource caps: max resolution, dispatch size, buffer size, project budget|V24
T45|x|unit tests: port compat, cycle/temporal, topo order, sink prune, resolution, format, migrations|V4,V13,V21,V25
T46|x|`vgpu/mock` command-level tests|C
T47|x|Dawn headless render snapshot: gradient→levels, blur chain, feedback progression|C
T69|x|headless parity test: same graph browser vs `vgpu/node` Dawn → snapshot match within tolerance|V47
T48|x|playwright: connect gesture, undo/redo, param drag, shader error recovery, save+reload|V15
T61|x|tests: patch atomicity, stale-revision conflict, dryRun ⊥ mutate, audit completeness, actor-local undo|V32,V33,V36,V41
T49|x|**Phase1 exit**: PoC graph Noise→Displace→Levels→Composite→Output + Feedback + Colorize fan-out, 10min stable resource count|V6,V7,V22
T62|~|**Phase1 agent exit**: agent adds 3 nodes + wires them in 1 patch, compiles, renders preview, reads GPU ms, undoes as 1 group|V32,V34,V35

## §P PARALLEL PLAN

wave = barrier. tracks ∈ wave run concurrent. track owns disjoint paths → ⊥ write collision.
rule: track ⊥ edit file outside owned paths. shared contract frozen @ wave 0.
cross-track need → raise, ⊥ patch other track path.
⊥ `git stash` | `git checkout` | any tree-wide git op while tracks live — stash cycles OTHER tracks' uncommitted work. blame a file w/ `git diff HEAD -- <path>`, ⊥ tree-wide state changes.

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
| A design system + shell | T2 T3 T5 T4 T6 T169 T170 T171 T191 T192 T193 | `src/ui/**` `src/app/**` |
| B domain + bus | T11 T12 T10 T50 T52 T53 T65 T66 T174 T175 T176 T177 T202 T203 T205 T207 T214 | `src/domain/graph/**` `src/domain/parameters/**` `src/domain/commands/**` |
| C gpu backend | T13 T14 T16 T17 T67 | `src/runtime/backend/**` `src/runtime/execution/**` |
| D guardrails | T7 T8 T64 | `eslint.config.*` `vitest.config.*` `playwright.config.*` `.github/**` |

### wave 2 — 5 tracks
| track | tasks | owns |
|---|---|---|
| E compiler | T24 T25 T26 T27 T72 T28 T75 T29 T30 T31 T32 T33 T147 T149 T151 T164 | `src/compiler/**` |
| F graph view | T18 T19 | `src/editor/graph-canvas/**` `src/editor/nodes/**` `src/editor/edges/**` |
| G controls | T37 T38 T73 T39 T167 T178 T182 T183 T184 T185 T186 T187 T188 T189 T196 T197 T198 T200 T201 T204 T218 T219 T220 | `src/editor/inspector/**` `src/editor/library/**` `src/ui/controls/**` |
| H shader editor | T20 T21 T22 | `src/editor/shader-editor/**` |
| I spike nodes | T15 | `src/nodes/definitions/**` `src/nodes/shaders/**` |
| Q input + keymap | T76 T77 T78 T79 | `src/editor/keymap/**` `src/editor/palette/**` |

barrier: **T23 Phase 0 exit** ← C, H, I.

barrier (wave 2 → 3) — contract changes, ⊥ parallel:
T80 OutputRef · T81 plan IR unions · T82 readback descriptor · T83 texture2d.space ·
T84 colorPolicy · T85 resolveParameters · T86 rebuild granularity · T88 undo/redo fixes ·
T89 patch zod · T94 resize bug · T104 group/viewport ops · T106 param envelope · T107 op classification · resolution `fit`+`limit` modes.
∀ = frozen-contract edits. do serial, broadcast, then fan out.

### wave 3 — 5 tracks
| track | tasks | owns |
|---|---|---|
| J preview | T113 T34 T35 T36 T87 | `src/runtime/previews/**` `src/editor/viewer/**` |
| K node catalog | T70 T40 T152 T165 T166 T190 T194 T210 T211 T216 | `src/nodes/definitions/**` `src/nodes/shaders/**` |
| L telemetry | T41 T42 T99 T145 T146 | `src/runtime/telemetry/**` |
| M persistence | T43 T44 T91 T139 | `src/domain/project/**` `src/domain/migrations/**` |
| N export | T68 T82 T111 | `src/runtime/export/**` |

barrier: **T51** route ∀ human action through bus — toolbar, menu, keybind, inspector, drag-connect.
serial, crosses `src/editor/**` + `src/app/**`. ! before wave 4: agent tools assume bus = only mutation path (V29).

### wave 4 — 2 tracks
| track | tasks | owns |
|---|---|---|
| O agent surface | T54 T55 T56 T57 T58 T59 T60 | `src/agent/**` |
| P tests | T45 T46 T47 T69 T48 T61 T157 T162 | `src/tests/**` |
| R hardening | T217 T215 T199 T195 T173 T179 T180 T181 T172 T95 T96 T97 T98 T102 T103 T109 T138 T140 T141 T142 T143 T144 T158 T159 T160 T161 T163 | `src/runtime/backend/**` `src/domain/graph/**` |
| S guardrails+ | T90 T92 T93 T105 T108 T112 T114 T115 T116 T148 T150 | `eslint.config.js` `src/domain/commands/**` `public/**` |

### track U — components + menus (core, ⊥ Phase 2 backlog)
T126 T127 menus (owns `src/editor/menus/**`) — depends bus + keymap, both landed.
T128 T129 T130 T131 T132 T133 T136 T137 components (owns `src/domain/components/**`
`src/editor/component/**`). T134 T135 → compiler owner.
menus ∥ components — disjoint paths, run concurrent.

### P3a track (late Phase 2, parallel w/ audio-reactive) — new track T
T117 codegen (FIRST, own task, blocks rest) → T118 SoA storage → T119 compaction →
T120 RNG/identity → T121 kernel node → T122 sprite render → T123 viewer+spreadsheet →
T124 TextureToAttribute → T125 read_points.
owns `src/points/**` `src/nodes/definitions/points/**`.

### Phase 2 backlog (⊥ v1, committed direction)
T110 multi-window perform mode · renderer-in-worker · AudioIn + analysis + WebMIDI (resolver
consumers, prove modulation arch) · T111 WebCodecs mp4 · components/subgraphs · media nodes ·
WebMCP + MCP adapters.

T168 landed w/ the resolver promotion (see §T).

### completed outside the wave plan (peer session, disjoint paths)
T88 undo/redo owner check + restore integrity · T100 monotonic clock base ·
T108 expression engine · T101 autosave ring · T105 PWA manifest.

### track X — examples (⊥ demos, they are the acceptance suite)
T152 Feedback node FIRST (blocks E1+E2) → T153 T154 T155 T156 → T157 runner + CI gate.
owns `examples/**` + `src/tests/examples/**`.

### wave 5 — serial gates
T49 Phase 1 exit, T62 Phase 1 agent exit.

### notes
- `src/agent/` ∉ doc §25 structure. added here. holds bus adapters + tool schemas only, ⊥ app logic (V39).
- K reuses I paths → I done @ wave 2 barrier, ⊥ concurrent.
- G owns `src/ui/controls/**` only. A owns rest of `src/ui/`.
- max concurrency 6. widening past that → collision risk > speedup.

## §B BUGS
id|date|cause|fix
B9|2026-08-29|**V9 BROKEN ON REAL DEVICE.** vgpu raises `VGPU-COMPILE-FAILED` from an ASYNC pipeline-store path ∴ ⊥ caught by `resources.ts` try/catch — lands as an unhandled rejection on stderr. `compile()` RESOLVES, broken program installed, previous VALID program RELEASED, `stale` stays false, ZERO diagnostics reach `onDiagnostic`. picture "looks retained" only because Dawn drops the whole command buffer. **the mock test PASSES** — mock rejects sync, Dawn ⊥ — a gate greener than the product|T217
B10|2026-08-29|**V15 BROKEN ∈ the composed app.** an 80px slider drag shows ONE value until release; arrow-key hold same. `parameter-editor.ts` + `coalesce.ts` correct in isolation & unit-tested; `NumberField` does emit live. suspect `inspector.tsx` builds the editor ∈ `useMemo` + disposes ∈ effect cleanup → disposed coalescer cancels the pending frame, swallowing live values while commit (immediate) still works. ∴ ∀ of V5's uniform-only path is UNREACHABLE from the UI|T218
B11|2026-08-29|**DATA LOSS.** shader edit discarded when clicking empty canvas: the click blurs the editor AND clears selection, `ShaderPane` hits its `nodeId === null` branch and unmounts `ShaderEditor` BEFORE the onBlur commit lands. status strip then reads "saved" — a lie on top of the loss|T219
B12|2026-08-29|`createAgentToolSurface` has NO CALLER anywhere ∈ `src/app/**` — the agent surface is built, tested & not wired into the product|T220
B1|2026-08-29|`formatFallback` w/ unsupported `depth24plus` + `allowsDepth` → falls back to `supported[0]` = a COLOR format, warning only. depth output silently becomes color|T158 ✓
B2|2026-08-29|`formatNoFallback` error path RETURNS the unsupported format ∴ plan carries a format the device ⊥ allocate|T158 ✓
B3|2026-08-29|`resolveSinks` doc says caller may narrow preview list; impl unconditionally unions ∀ `ui.preview===true`. doc ≠ code|T159 ✓
B8|2026-08-29|TWO parameter eval paths ∴ V61 already drifted: `src/editor/inspector/parameter-resolver.ts` (decodes display→linear) & `src/compiler/validate.ts::resolveParameterValues` (⊥ decodes). T148's fix reaches the INSPECTOR, ⊥ the GPU — rendered color still wrong|T168 ✓
B5|2026-08-29|`data` space unshippable — `colorSpaceForFormat` derives `data` only ← `r32float`, but plan binds 1 shared LINEAR sampler ∀ textures & r32float ⊥ filterable on Tier B w/o `float32-filterable`. ∴ a V56-flagged displacement field ⊥ renders|T83+T150 ✓
B6|2026-08-29|Output node target size/format follows its INPUT, ⊥ project. `outputNode` declares no resolution/format policy; its own doc says project surface. E5 presents 2048² ⊥ project 1280×720|T165 ✓
B7|2026-08-29|`customWgsl.compile()` emits ⊥ `uniformBinding`/`sharedBinding` ∴ kernel ⊥ receive uniforms or time. shipped default `source` DECLARES a `params` block bound to nothing = trap for anyone editing it|T166 ✓
B4|2026-08-29|⊥ Dawn host ∈ `src/runtime/backend/vgpu/` ∴ ⊥ V3-clean way to get a headless device. V47/T67/T69 were untestable; parity harness had to `eslint-disable` V3|T160 ✓
