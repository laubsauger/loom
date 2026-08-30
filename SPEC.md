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

### media needs a resource kind that ⊥ exist yet
`ResourceDescriptor` = target | pingPong | sampler | buffer | bufferPair. **⊥ way to
carry a texture the CPU supplies.** ∀ current resource is GPU-allocated & GPU-written;
a decoded frame comes from outside. ∴ media is blocked on plan-IR work, ⊥ on node work —
worth knowing before anyone starts w/ the node.

```ts
interface ExternalTextureResourceDescriptor {
  kind: "externalTexture";
  id: string;
  size: readonly [number, number];
  format: TextureFormat;
  /** Who supplies frames. The runtime uploads; the plan ⊥ carry pixels (V63 clone-safe). */
  sourceId: string;
}
```
`sourceId` ⊥ the pixels: the plan stays structured-clone-safe (V63) ∴ worker-movable. the
runtime holds a registry `sourceId → MediaSource` and uploads on frame-ready.

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
- **DeviceIn** (TD Video Device In TOP) — webcam | capture device → texture. SEPARATE node
  from MovieFileIn, as TD keeps them: the param sets barely overlap (device pick, resolution
  negotiation vs file + playback), and V122's hide-what-⊥-apply would hide most of either.
  rides the SAME `externalTexture` + media-source registry (T229) — a webcam is another
  `MediaSource`, ⊥ a subsystem. `getDisplayMedia` screen capture = the same shape, later.
  what a FILE never has to handle, and ∀ of it is normal ⊥ exceptional:
  permission denied · no device · device unplugged mid-stream · another app takes the camera ·
  tab backgrounded · resolution ⊥ what you asked for.
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

### Composite node + individual blend nodes — BOTH, sharing one implementation
TD ships a Composite TOP w/ an Operation menu AND standalone Add/Multiply/etc. keep both:
- **Composite** — variadic inputs + an `operation` ENUM. flexible: change the blend w/o
  rewiring, drive the mode by expression (V107), reach a mode you ⊥ have a node for.
- **Over/Add/Multiply/Screen/Difference** — fixed operation. a graph reading `Multiply`
  says what it does at a glance; `Composite` makes you open it. when you KNOW the op, the
  named node is the better documentation.

**⊥ two implementations of the blend math.** blend fns live ∈ 1 WGSL module; Composite
selects @ compile time; a named node binds a fixed selection of the SAME fn. else Over ∈
Composite and the Over node drift & only one gets the bug fix.

`operation` is `compileTime: true` — it changes the SHADER, ⊥ a uniform. specialise per
mode (the shader cache already keys on constants) ⊥ branch per pixel: a per-pixel switch
on a value that changes ~never is the wrong trade, and V5's uniform-only fast path stays
meaningful only if mode changes are honestly classified as structural.

### variadic inputs (1+n) — the mechanism exists, ⊥ node uses it
`PortDefinition.variadic` is ∈ the contract, honored by the patch layer (V14), the
compiler (`CompiledInputBinding` is an ARRAY per port), and the canvas. **⊥ production
node declares one** — only test fixtures. same shape as feedback before T152: every layer
built, nothing reaching it.

Composite (Over/Add/Multiply/Screen/Difference) is the obvious first consumer — TD's
Composite TOP is multi-input. Also: Switch, Merge, and any "combine N of these" op.

**THE GAP THAT MATTERS**: edges into one port currently arrive in EDGE-ID order — i.e.
creation order — and `GraphEdge` carries no ordering field. For Over, **layer order IS the
operation**. Wiring a third layer would land it wherever its id sorted, and reordering
would mean deleting and rewiring. ∴ a variadic port needs an EXPLICIT order before any node
can use one.

### node NAMES are identifiers, ⊥ decoration (TD: noise1, noise2, null1)
prerequisite for expressions & binds: `op('noise1').par.period` only works because a name
is UNIQUE within its network. ∴ names must land BEFORE reference syntax, ⊥ after.

- ∀ node has a `name`, unique within its graph. auto-numbered on collision: `noise1`,
  `noise2` — created from the definition type, lowercased.
- rename to a taken name → auto-suffix, ⊥ reject. the user's intent is the WORD; the
  number is bookkeeping.
- `name` (identifier, unique, referenceable) ≠ a comment (free text, ⊥ unique). today's
  `GraphNode.label` conflates them — it is display-only & unconstrained. `label` BECOMES
  the name; a separate comment field arrives when someone wants one.
- rename ! rewrite references that named it, or the rename silently breaks a bind (V110).
  ∴ rename is a graph-wide patch, ⊥ a node-local one.

**Null node** — TD `null1` idiom: 1 in, 1 out, passes through untouched. exists to be a
STABLE REFERENCE POINT: reference `null1` & rewire upstream freely w/o touching any
reference. cheap (⊥ pass emitted — compiler passes the binding through), and the standard
place to park a bookmark ∈ a big graph.

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
### cooking — TD's model, Notch's stateless/stateful split (T249-T256)
TD: cook needs BOTH a REQUEST (downstream | param reference | viewer) & a REASON (input
cooked | param changed | time-dependent | expression resolves ≠). PULL, ⊥ push. cook graph =
wires ∪ PARAMETER REFERENCES. escape hatches @ both ends (Cook Type, Cooking Flag).
Notch: push-traverse active tree from Root ∀ frame, ⊥ dirty mechanism, per-node manual
"static" switches. worse — but 3 ideas better than TD's:
 1. STATELESS vs STATEFUL as a per-node property (the thing TD lacks & we need most)
 2. a frozen node ! COMPUTE ONCE before it may serve cache; clears on reset
 3. CPU+GPU ms together per node, category rollups
TD's own failure worth ⊥ inheriting: dependency system ⊥ total; when it misses it shows a
STALE value as FRESH. documented (`Dependency.modified()` exists for this) & unroot-caused
∈ the field. ∴ our gate is built BEFORE the feature, ⊥ after.

LAYERING — 3 rows, ⊥ 1: compile = does node EXIST. build = which GPU objects REUSED
(carry-over, already built). cook = does this pass RUN THIS FRAME. cooking is only row 3.
unit = NODE ⊥ pass (Blur's 2 passes share a node-private scratch).

V174: ∈ the inspector, PARAMETERS come first & COMMON is a separate TAB (TD's page model) — ⊥ both stacked on 1 page. common is chrome you set once; parameters are the work. prime real estate goes to the work.
V175: a Ramp is N STOPS, ⊥ 2 colours. add|remove|move a stop, position per stop. 2-colour is the degenerate case of the general thing, & shipping only the degenerate case means every gradient anyone actually wants is impossible.
### jitter ∈ `time * k` — ⊥ rounding, it's the CLOCK (B21)
`liveClock` accumulates WALL deltas (clamped, epoch 0 — both already right). but rAF deltas
jitter ~16.6ms ± several ∴ `time` advances NON-UNIFORMLY ∴ `time * 0.15` on a translate
steps unevenly. spatially straight, temporally ragged. ⊥ f32, ⊥ JS rounding — f64 on CPU,
& they already start @ 0 which is the real f32 mitigation.
TD's answer: 2 clocks. `absTime.seconds` = wall. timeline time = frame/fps, UNIFORM BY
CONSTRUCTION. animation uses the timeline one.
TRADE, stated: timeline time means dropped frames SLOW the animation (TD behaves this way);
wall time means dropped frames SKIP it (Notch's "frame-rate independence" = "visually
similar", ⊥ identical). ⊥ 1 right answer ∴ ship both & DEFAULT to smooth.

### the VALUE GRAPH — TD's CHOP network, ⊥ a 2nd product (T273-T277)
value nodes today have ⊥ ports & are addressed by NAME (`driven` → `lfo1`). that works for a
SOURCE. it ⊥ work the moment you want `mouse1 → lag1 → filter1 → parameter`: naming a chain
∈ a parameter string is ⊥ a graph, it's a graph typed as text.
TD wires CHOPs w/ cables ∴ so do we. a `value` PORT TYPE, value EDGES, & a CPU-side graph
evaluated ∀ frame BEFORE the render. this is the same split TD has (CHOP network vs TOP
network) ∈ 1 canvas.

### TD catalogue survey — 149 TOPs, 102 POPs, crawled ⊥ remembered (2026-08-30)
what it changed: Flip's `swap` was WRONG (squashed non-square — fixed), Mirror lacked TD's
ROTATE (added), 2 comment claims were invented ("TD's Premultiply TOP" ⊥ exist among 149;
Mask ≠ TD Matte, which is 3-input). deprecated & ⊥ copy: **SVG TOP** (documented, ⊥ runs),
**GLSL Create POP** ∴ our 2nd kernel node = an ADVANCED kernel that ? change counts, ⊥ a
separate Create node.

NOTE: commit `640de4e` labels this work T279/T280 — ids assigned before the spec's were published & now taken by Remap/Reorder. the work IS T288/T289. ⊥ renumber the commit; record the mapping.
### POP + Houdini survey (2026-08-30) — what it corrected, what it unlocks
my brief had 2 WRONG premises the survey fixed: ⊥ "Scatter POP" (= **Sprinkle POP**, needs an
input; from-scratch scatter = **Point Generator POP**), ⊥ "Constant POP" (= **Point POP**), &
POPs are **2025** (build 2025.30060, Jun 2025) ⊥ 2023.
biggest unlock: ∀ TD parametric generator has a **Connectivity** param
(`none|points|lines|linestrips|tris|alttris|quads`) + publishes **`Dim[]` (numCols numRows)**.
topology is ANALYTIC ∴ a grid|sphere|tube|torus draws as a SURFACE w/ ⊥ index buffer. that
collapses most of the "we need a mesh resource kind" work.
⊥ exists ∈ TD after 2 release years: Instance POP, Render POP, **Lattice|Magnet|Deform POP**
(cage deform is SOP-only). **Copy POP** = copy-to-points (realises copies); hardware
instancing still lives on Geometry COMP. deprecated: **GLSL Create POP** → GLSL Advanced POP
**+ a separate Topology POP** — that SPLIT is worth stealing.
Houdini publishes an exact 3-line transform composition order; TD publishes NONE.

V201: a composed test that STUBS the thing under suspicion proves the layers around it & says NOTHING about it. T267 drives a stubbed `loop` & ticks it by hand ∴ it proves edit→plan and is silent on whether `backend.loop` ever fires. ⊥ a defence of the code — a gap ∈ the test.
V200: a "we measured & stopped" decision is recorded W/ ITS NUMBERS & the script that produced them, ⊥ as "deferred". a bare deferral reads as laziness to the next person & gets re-litigated from scratch; the census is what makes the decision re-checkable when the assumption (graph size) changes.
V197: §V104 NARROWED — "if you WRITE it, you OWN it". an UNMODIFIED attribute passes downstream BY REFERENCE. V104's stated reason was an ID-DERIVATION CONVENTION (`pointPairId(nodeId, attr)`), ⊥ a physical hazard ∴ narrowing preserves the safety argument exactly. NUMBERS: a 4-node chain over a 7-attribute schema costs 56 buffers / 640 B per point / **480 B per point per frame of pure memcpy = 28.8 GB/s @ 1M points @60fps** — enough to saturate an integrated GPU before 1 useful instruction runs. copy-on-write: 20 buffers, 256 B/point, copy traffic ≈ 0. the HARD part is SWAP OWNERSHIP: consumers are found by WHO BINDS A `pairId`, ⊥ by reachability. that is its own task w/ its own test, ⊥ a footnote.
V198: point-node TRANSFORM COMPOSITION ORDER is PUBLISHED & pinned by test. Houdini publishes one; TD publishes none, & "which order" is the most expensive thing to get wrong & costs nothing to fix today.
V199b: compat mode is **⊥ a target** — decided, ⊥ deferred. baseline is Tier B CORE. on a compat adapter the capability report REFUSES point/geometry rendering LOUDLY (V12 style), ⊥ breaks silently. migration IS named & bounded: SoA pairs gain VERTEX usage & bind as instance-step vertex buffers — same buffers, same kernels, different binding point. a named migration w/o a GUARD is how a silent breakage ships ∴ the refusal is wired now.
V199: WebGPU **compat mode allows 0 storage buffers ∈ the VERTEX stage** (core allows 8). our render approach is vertex-pulling from SoA storage ∴ compat is a REWRITE, ⊥ a tuning problem. decide EXPLICITLY whether compat is a target before more of the point system assumes vertex-stage storage.
V195: V107's "∀ parameter takes ∀ mode" applies to SCALAR LEAVES. a CONTAINER parameter (`curve`, `stops`) is static as a whole — an expression returns a number & there is ⊥ meaning to a list-valued one. its LEAVES (`stops[2].position`) are the moded things, once the key grammar carries an index. `curve` already lives under this rule; writing it down stops `stops` inventing a 2nd answer.
V196: a container parameter carrying COLOUR declares its space like `color` does, & the resolver decodes PER ENTRY. decoding at the container level (or ⊥ @ all) reproduces B8 — inspector shows 1 colour, GPU renders another — & a list makes it N times harder to notice.
V194: node TYPE STRINGS are 1 flat namespace across families ∴ a value-graph node that shares a concept w/ an image node is prefixed: `valueMath`, `valueLimit`, `valueFilter`. TD disambiguates by family suffix (TOP|CHOP) & we have ⊥ that. the collisions are ⊥ hypothetical — Limit, Math, Noise, Constant, Transform ∀ exist | will exist ∈ both families. the EXPORTED CONST ! match its type string ∴ `valueLimitNode`, ⊥ `limitNode` — a const named for the concept & typed for the family is how 2 modules silently claim 1 name.
V193: ∀ agent tool is REACHABLE ∈ the composed app — a composed-level test enumerates the surface & asserts each tool's port is live, ⊥ per-tool spot checks. "built, tested, ⊥ wired" has now happened 3× (B12 agent surface, T264 media, B23 render_preview) & each time every unit test was green. the enumeration is the only guard that scales: a NEW tool is covered the day it exists, ⊥ the day someone remembers.
V189: auto-layout is DETERMINISTIC — same graph → same positions, ∀ time. an agent that re-lays-out & gets different coordinates ⊥ reason about its own canvas, & a human gets churn ∈ every diff. ⊥ randomness, ⊥ iteration count, ⊥ insertion-order dependence.
V190: layout is a POSITION edit ∴ `nodePosition` classification — editor-only, ⊥ recompile, ⊥ resource rebuild (V1). laying out a 200-node graph ! cost 0 GPU work.
V191: ONE layout implementation, reached by both the keymap (`L`) & the bus command the agent calls (V78). a "layout for agents" that differs from the button is 2 products.
V192: MCP|WebMCP adapters are TRANSPORT + SCHEMA ONLY (V39). they live OUTSIDE `src/agent/**` ∴ the surface stays transport-free & headlessly testable — a server drags node|network deps, WebMCP drags DOM, & neither belongs ∈ the thing they both wrap.
V186b: retracting a wrong citation means finding EVERY copy of it. the invented "Premultiply TOP" claim lived ∈ 2 files; the 1st correction fixed 1 & left the other reading as researched fact for another 3 hours. `grep` the claim, ⊥ the file you happened to open.
V186: a comment citing an EXTERNAL fact is a claim. if nobody checked it, ⊥ write it — the next person treats it as researched. 2 invented TD citations shipped ∈ this catalogue before a survey caught them.
V187: `index.test.ts`'s type list catches a node registered w/ the wrong name. it ⊥ catch WRITTEN BUT NEVER REGISTERED — a shader + definition can sit unreferenced & every gate stays green. the catalogue-chain sweep is what must own that claim.
V188: POP survey vs §V104 — TD passes UNMODIFIED attributes downstream BY REFERENCE (copy-on-write); V104 mandates fresh pairs for ∀ a node outputs. V104's REASON is sound (aliased sim state across nodes). its COST is ~80 buffers where TD allocates 12. re-read before P3a allocates — ⊥ inherit the number by accident.
V183: know WHICH crossing costs. SCALARS crossing CPU↔GPU are ~free — a value graph is a handful of f32 & the uniform write already happens ∀ frame (V5's path). TEXTURES crossing are ⊥ free. ∴ the value graph is CPU-side BECAUSE it is scalars; the rule ⊥ generalize to pixels.
V184: ⊥ NEW GPU→CPU route. the ONLY readback is the existing ASYNC between-frames one (V48/V7/V144), 1 frame late by contract. ⊥ `mapAsync`-await inside the frame loop, ⊥ a "just this once" sync read. a stall is invisible ∈ a test & fatal ∈ a 60Hz loop.
V185: readbacks are COUNTED & SHOWN. N Analyze nodes = N readbacks/frame; the perf panel reports the count & total bytes ∴ a user who drops 20 of them SEES why it got slow, ⊥ guesses. an invisible cost gets paid repeatedly.
V179: value edges form a SEPARATE graph — CPU-side, topologically ordered, evaluated ∀ frame BEFORE the GPU plan. value nodes ⊥ enter the GPU plan & ⊥ allocate GPU resources. a value edge ⊥ a texture edge & the 2 ⊥ connect (V19 port typing already refuses it).
V180: a value node publishes NAMED CHANNELS, ⊥ 1 anonymous number. address = `node` (first channel) | `node:channel` (`mouse1:x`). single-channel is the degenerate case — Mouse has x,y & shipping only 1 forces 2 nodes for 1 device.
V181: a STATEFUL value node (Lag, Hold, Count, Slope) is unskippable (V155) & ! declare its reset (T214/T216). its state ⊥ a function of frame index ∴ a seek that ⊥ replay is ⊥ scrub-accurate (V170) & ! say so.
V182: Mouse publishes the SAME pointer the shaders read (`FrameEvaluationInput.pointer`, the shared block's `pointer`). ⊥ a 2nd DOM listener — 2 sources for 1 device drift by a frame & the CPU & GPU halves of one graph disagree about where the cursor is.
V177: project settings are DOCUMENT state — they serialize w/ the graph, mutate ONLY via `project.setSettings` (V29), bump the revision & make ONE undo entry ("Set frame rate", TD-style). `AppRuntime.settings` is a live VIEW of the store, ⊥ a snapshot.
V178: settings edits classify PER FIELD. `outputResolution`, `workingFormat`, `limits` = STRUCTURAL → recompile. `fps`, `previewFps`, `previewLongEdge` = ⊥ structural → ⊥ recompile, ⊥ resource rebuild. w/o this someone writes "any settings edit rebuilds the world" & dragging an fps field rebuilds every resource @ 60Hz.
V176: `time` ∈ expressions & the shared block is TIMELINE time = frameIndex/fps — uniform by construction. wall time is a SEPARATE name for when sync matters. a linear expression on `time` ! produce linear motion; if it visibly jitters the clock is wrong, ⊥ the user's expression.
V173b: LIVENESS has 3 sources, ⊥ 1: (a) a data EDGE to a sink, (b) a DRIVEN slot naming a value node's channel, (c) an `op()` REFERENCE ∈ an expression. ∀ consumer of liveness uses the SAME answer — `plan.pruned`, the example gate's dead-node check, cooking's dirty set, the UI's pruned badge. 4 places computing it separately = 4 chances to disagree, & they will.
V173: `pruned` means DEAD — "could have contributed GPU work & was excluded". a node that is NON-PLAN-RESIDENT BY DESIGN (the value trio: LFO, Constant, Timer — no ports, no passes) is ⊥ pruned, it was never a candidate. conflating them puts a `pruned` warning badge on a WORKING LFO & counts it ∈ "nodes pruned".
V172: a graph edit produces a rendered frame BY ITSELF — ⊥ waiting on an unrelated event (zoom, resize, pointer move, next param change) to nudge it. "renders when I zoom" means the render is riding someone else's invalidation & the edit path has no trigger of its own. measure FIRST-FRAME-AFTER-EDIT ∈ a composed test, ⊥ eyeball it.
V169: the timeline readout (frame, time, fps) reads the SAME `FrameEvaluationInput` the render consumed — ⊥ a parallel clock, ⊥ `performance.now`. a readout that can disagree w/ the picture is worse than no readout: it's the thing you check when you ⊥ trust the picture.
V170: SEEKING BACKWARD ∈ a graph w/ temporal state (feedback, Cache, point sim) ⊥ free — the state ∉ a function of frame index alone. ∴ a backward seek ! either RESET stateful nodes or SAY it ⊥ scrub-accurate. ⊥ silently show a state that belongs to a different history. forward seek = run the frames | same problem.
V171: resolution is a LADDER: project → component → node override (V-existing per-node). each level defaults to its parent & says WHERE its value came from ∈ the UI. an inherited value that looks authored is how someone edits the wrong level.
V167: a capability is ⊥ SHIPPED until a node can DECLARE it & a user can REACH it. T229 built `ExternalTextureResourceDescriptor` + `registerMediaSource` + upload gating, ∀ tested — & ⊥ node can request one ∴ `ScratchRequest` has no `external` kind. the plan layer & the backend layer are both green & the catalogue has no media node. same shape as B12.
V168: within 1 frame, PLAN ORDER = EXECUTION ORDER. vgpu `compute.dispatch()` submits IMMEDIATELY while render passes submit @ frame close ∴ ∀ dispatch ran before ∀ render pass regardless of plan order (B19). ⊥ observable ∈ any mock.
V165: `project.new` is a 4th DESTRUCTIVE verb (w/ open) — ! confirm when dirty, same rule as V93's open.
V166: an unsaved-work confirm offers SAVE as its primary action, ⊥ only discard|cancel. a 2-button "are you sure" forces cancel → save by hand → redo the action, & the user who wanted to keep their work is the one punished for it. 3 buttons: Save & continue | Discard | Cancel.
V164: ∈ dev, a surface that drew NOTHING ! be distinguishable from one that correctly drew BLACK. preview overlay is `alphaMode:"premultiplied"`, clear `[0,0,0,0]` (V106) ∴ "compositor produced nothing" reads as clean black over a dark app — indistinguishable from a working black picture. a distinct dev clear turns a silent class of bug into an obvious one.
V163: a graph w/ ANY animated parameter (driven | time-dependent expression) re-resolves & pushes VALUES-ONLY updates ∀ frame. `hasAnimatedParameters(graph)` gates it ∴ a static graph pays ⊥. w/o this the resolver moves & the SCREEN ⊥ — a correct resolver is ⊥ the feature.
V160: a preview tile's size derives from the node's preview AREA (V117), ⊥ from its on-screen rect. the rect carries ZOOM ∴ sizing from it reallocates on camera move (B13).
V161: HOLDING a tile ≠ DRAWING into it — separate lifetimes. suspension (V28) governs per-frame GPU WORK; the pool governs ALLOCATION. a suspended preview keeps its slot until the pool needs it for an on-screen one. conflating them = panning a node off screen blanks it & (per V162) everything else.
V162: the preview host ! carry over per-resource like the main program (V62b/T143). today `buildPreviewHost` builds w/ `emptyCarryOver` ∴ ANY program change destroys & recreates EVERY tile — 1 node crossing the screen edge blanks ∀ of them on the same frame. that is the "IN SYNC" ∈ B13 and it is still live above the 48-tile pool.
V154: the dependency graph is DATA EDGES ∪ PARAMETER REFERENCES — for pruning AND cooking AND cycle detection (V152). `pruneToActiveSinks()` walks edges ONLY today ∴ `op('x').par.y` is invisible to it. this is TD's exact documented bug; ⊥ inherit it.
V155: a node declaring §V46 STATE is UNSKIPPABLE. a skipped stateless node is 1 frame stale & SELF-CORRECTS; a skipped stateful node's trajectory DIVERGES permanently & nothing fixes it. feedback's failure mode ⊥ "stale frame" — it's "advances @ half rate", which reads as a LOOK someone tunes around & ships.
V156: time-dependence is DATA, ⊥ a callback (§V63): `"always" | "never" | {anyNonZero:[param]}`, re-evaluated against CURRENT uniforms ∴ Noise speed 0→1 flips the class w/ ⊥ recompile. expression time-dependence: WHITELIST provably-static names, ⊥ blacklist clocks.
V157: `cookPolicy: "always"|"auto"` ships BEFORE any gating & stays forever. "auto" ! be BYTE-IDENTICAL to "always" @ EVERY frame index — ⊥ only the last. a 1-frame lag is THE signature failure & it self-corrects by the final frame. also the permanent bisect switch when someone suspects cooking ∈ the wild.
V158: preview-only nodes ? be viewport-gated. output-reachable nodes ⊥ EVER. offline render has ⊥ previews ∴ this can only under-render, never over-.
V159: dirty marks are set @ the BACKEND ENTRY POINT (`updateUniforms`), ⊥ @ call sites. V5 & cooking become 1 mechanism — 2 competing notions of "changed" is how the stale frame gets in.
V151: a reference|bind line is DERIVED from parameter slots @ render time — ⊥ stored ∈ `edges`, ⊥ ∈ the plan, ⊥ a drop target. it is a VIEW of a dependency that already exists. storing it = 2 sources of truth & a graph that ⊥ round-trip.
V152: cycle detection spans DATA EDGES ∪ PARAMETER REFERENCES. `a.par ← b` & `b.par ← a` is a real cycle a texture-edge topo sort ⊥ see. reject @ command time w/ the path named, ⊥ discover @ evaluate.
V153: reference lines TOGGLEABLE. a network w/ many refs is unreadable if ∀ drawn always — TD ships the toggle for this reason.
V150: expression completion offers ONLY what the evaluator accepts. source = same probe the help reference uses (run it, keep what parses) — ⊥ a hand-kept list. a completion menu that suggests a fn the grammar rejects is worse than no menu: it TEACHES a wrong API & the user blames their syntax.
V148: "copy parameter reference" yields a string that PASTES INTO an expression & resolves to that same parameter. round-trip tested (copy → paste → evaluate == source value). a reference format that ⊥ paste back is the whole feature failing silently.
V149: reset-to-default restores BOTH value & mode, & SAYS what it cleared when an expression|reference was discarded. ⊥ silently drop authored work. per-mode retained values (V107) survive a value reset — clearing the mode ≠ clearing its memory.
V146: a parameter that CANNOT affect output ∈ current state ! read INACTIVE (dimmed + reason on hover, TD-style) — ⊥ silently ignored. ∀ node declares each param's applicability as a predicate over its OWN params. a live control that does nothing is worse than a control that isn't there: user did everything right & got nothing.
V147: a claim about the PICTURE is tested on the picture. "shader source contains X" ⊥ evidence that X reaches a pixel. ∀ per-frame behaviour (motion, feedback, carry-over) needs ≥1 texel-level test @ real device.
V145: a domain type sharing a name w/ a DOM|Node GLOBAL (`MediaSource`, `Text`, `Selection`, `Range`, `Event`, `Image`, `Path`, `Node`, `Screen`, `Cache`, `Transform`…) ! be imported explicitly @ ∀ use. lint-enforced. w/o import tsc resolves the GLOBAL & goes GREEN against the WRONG interface — the silence is the bug.
V142: viewport transform (pan/zoom) is VIEW state ∴ ⊥ reach the plan, ⊥ re-create surfaces, ⊥ recompile, ⊥ reconfigure a canvas. camera move ! be free. corollary: a preview surface's configured size derives from its NODE's resolution, ⊥ from zoom — zoom scales w/ CSS, ⊥ w/ reallocation.
V143: a node that MAKES a value over time (LFO, Timer) reads time from FrameEvaluationInput like every other node — ⊥ wall clock (already lint-enforced) ∴ offline render & live preview agree frame-for-frame.
V144: image→scalar reduction (Analyze) lands ∈ a readback that is ALREADY async & ALREADY between frames (V48/V7). ⊥ stall the frame loop to feed a parameter. a value 1 frame late is correct; a hitch is ⊥.
V140: a blend operation has ONE implementation. Composite selects it @ compile time, a named node binds a fixed selection of the SAME fn. ⊥ 2 copies of the math — else the node and the mode drift and only 1 gets the fix.
V141: a parameter that changes the SHADER is `compileTime: true` & recompiles (V5, V31 classifier). ⊥ a per-pixel branch on a value that changes ~never. V5's uniform-only fast path is only meaningful if structural changes are classified honestly.
V131: a variadic port's input ORDER is explicit & user-controllable — the edge carries it. ⊥ edge-id|creation order: for Over|Composite the layer order IS the operation, and an order the user ⊥ change is a wrong answer they ⊥ fix.
V132: variadic UI = n connected slots + 1 free, reorder by drag. reorder = 1 patch, 1 undo entry (V15). the free slot is how "1+n" is discoverable ⊥ documentation.
V127: node `name` = a unique IDENTIFIER within its graph, auto-numbered on collision (`noise1`, `noise2`). ⊥ decoration: it is the reference target for binds + expressions (V110), so uniqueness ! precede reference syntax.
V128: rename rewrites ∀ reference naming that node, ∈ the SAME patch — else a rename silently breaks a bind. rename is graph-wide, ⊥ node-local.
V129: a rename collision auto-suffixes, ⊥ rejects. the user's intent is the word; the number is bookkeeping, & a modal saying "name taken" is the tool arguing w/ a decision already made.
V123: `pulse` = a parameter type, ⊥ a node feature — declared once, available to any node (TD Pulse). ∀ node w/ `stateful.reset === true` (V46) SHOULD expose one.
V124: a pulse mutates RUNTIME state, ⊥ document state ∴ audited (V31), ⊥ undoable, ⊥ serialized. a pulse persisted as "on" would re-fire on load & wipe your work every open.
V125: a pulse takes ∀ parameter mode (V107) — an expression firing it is how an automated reset happens: on a beat, a threshold, a frame count. a trigger you can only click is ⊥ a trigger, it is a button.
V126: pulse reset is PER-RESOURCE, ⊥ whole-backend. `resetTemporalHistory()` is global today ∴ resetting one Feedback would clear every other node's history — the reason `runtime.resetFeedback` stayed unregistered (V62).
V119: recording is a NODE, ⊥ a global action. topology decides what is recorded ∴ several recorders may run at once, on intermediate branches. a recorder declares `sink: true` (V25) — recording is its side effect & it ⊥ be pruned for having no consumer.
V120: a recorder captures by `frameIndex` via the export interface (V48, T111), ⊥ by sampling a clock. a take that dropped|duplicated frames = a WRONG recording, ⊥ a shorter one — it ! fail the take, ⊥ silently ship.
V122: 1 media-in node covers still|sequence|video (TD Movie File In). params that ⊥ apply to the loaded asset are HIDDEN, ⊥ disabled-and-visible — a still has no in|out point, and showing one teaches the user the node is broken.
V137: a live-device node treats permission-denied, no-device, unplugged, taken-by-another-app & backgrounded as NORMAL states w/ their own node status + a stated next action — ⊥ errors, ⊥ a black frame. a camera that is off looks exactly like a camera that is broken unless the node says which.
V138: a live device is capability-gated (V38) & the app shows its OWN live indicator while a stream is open. relying on the browser's dot alone means a graph can hold a camera open w/ ⊥ trace ∈ the tool that opened it.
V139: a live device negotiates — requested resolution|rate is a REQUEST. the node reports what it actually GOT, & downstream resolution follows the actual (V21), ⊥ the asked-for.
V135: a decoded frame enters the graph as an `externalTexture` RESOURCE, ⊥ as pixels ∈ the plan. the plan carries a `sourceId`; the runtime owns the registry & uploads. keeps the plan structured-clone-safe (V63) ∴ the worker migration stays free.
V136: upload happens on FRAME-READY, ⊥ per render frame. a 30fps video ∈ a 60fps graph uploads 30 times, ⊥ 60 — re-uploading an unchanged frame is the easiest wasted bandwidth ∈ the system.
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
V133: numeric drag precision spans DECADES, ⊥ 3 fixed modifier levels. same field ! reach 0.0001 and 100 w/o the user editing a `step` setting: modifiers give ±1 decade, a magnitude LADDER (press-hold → 0.001·0.01·0.1·1·10·100, pick one, drag) gives arbitrary reach. the manifest `step` is the DEFAULT decade, ⊥ a cap.
V134: ∀ emitted value still lands on the chosen decade's grid @ declared precision (V-drag rules) — changing reach ⊥ mean changing exactness. 0.30000000000000004 ∈ a saved document is the failure this prevents.
V99: ∀ pointer target ≥ ~20px even when its VISUAL is smaller. a 7px port dot is a coin toss, and missing it drags the NODE — you meant to wire and you moved the thing you were wiring. expand w/ an invisible pad, ⊥ by growing the dot (a bigger dot dominates a dense graph).
V100: a disabled preview region shows the node's RESOLVED FACTS (size, format, space) — ⊥ a black rectangle. off ⊥ mean empty: the space is already spent, so it should carry what the user would otherwise open the info popup for.
V130: the Common block (resolution, format, space readout) goes LAST or behind a fold — ⊥ above the node's own parameters. TD puts it on a separate tab for a reason: it is chrome that is occasionally consulted, and the params are why the panel was opened. prime real estate belongs to the node's actual controls.
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
T23|x|**Phase0 exit**: uniform live-update, WGSL recompile, invalid WGSL keeps output|V5,V9
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
T178|x|UI copy audit vs V90/V91/V92 — ∀ surface: node body, inspector, library, viewer, dock, palette, menus, agent panel. + a guard test bounding inline prose per surface|V90,V91,V92
T194|x|compiler deltas for point passes: dispatch/draw emittable, bufferPair scratch, pointset outputs materialize as a marker, pair swaps, chain test. point family registered ∴ rides the catalogue sweep. (landed ∈ commit 4ca9c4f, which is MISLABELLED T176 — T176 is the bus track's zod lift, still open)|V58,V22,V75
T217|x|fix B9: await pipeline creation | `pushErrorScope`/`popErrorScope` BEFORE installing the program; route the failure to `onDiagnostic` + set `stale`; keep the previous program. AND make the mock reject the way Dawn does, else the test stays greener than the product|V9,V27
T218|x|fix B10: live parameter values ∀ gesture — find why the composed app swallows them (suspect editor lifecycle ∈ `inspector.tsx`). add a test @ the COMPOSED level, ⊥ only per-module|V15,V5
T219|x|fix B11 (DATA LOSS): commit the shader edit before unmount; ⊥ report "saved" when nothing was|V9,V29
T220|x|wire `createAgentToolSurface` into the composition root + inject its ports|V39,B12
T228|x|numeric magnitude ladder: press-hold on a number → decade ladder (0.001…100), pick, then drag @ that decade. modifiers still ±1 decade; typed entry unchanged; value stays on the decade grid|V133,V134,V20
T225|.|`order` on edges targeting a variadic port + `reorderEdges` patch op. ⊥ creation order|V131,V29
T271|x|2 clocks: timeline time (frameIndex/fps, default, smooth) + wall time (separate name). fixed-step realtime transport option|V176,V44,V49
T269|x|inspector TABS — Parameters first, Common as its own tab (T224 completes here)|V174,V90
T270|.|Ramp multi-stop: new `stops` param type = `{position, color}[]` + `space` (V196), static-as-a-whole (V195). compile → capped uniform array (16) + count, diagnostic beyond. stop editor UI: add|remove|reorder|position|swatch, 1 patch per gesture (V114)|V175,V195,V196,V56 N stops w/ position + colour, add|remove|reorder, stop editor UI|V175,V56
T268|x|ONE liveness fn: edges ∪ driven channels ∪ op() refs (V173b). fixes `plan.pruned` (B20), the example dead-node gate & the UI badge together. T251 folds in here|V173,V173b,V154
T267|x|first-frame-after-edit: connect|add|param change ! render w/o a nudge. composed test measuring frames between edit & pixel change|V172,V5
T265|x|timeline readout ∈ top bar — frame + time + fps, TD-style. frame field editable → seek (V170 rules apply)|V169,V170,V29
T273|x|`value` port type + value EDGES + CPU value-graph evaluator (topo order, cycle rejection, ∀ frame pre-render)|V179,V19,V152
T274|x|multi-channel value nodes: `node:channel` addressing; LFO/Constant/Timer keep single-channel as the degenerate case|V180
T275|x|**Mouse** input node — x, y, buttons as channels, from `FrameEvaluationInput.pointer`. ⊥ a 2nd listener|V182,V180
T276|x|CHOP math family: **Math** (binary op + scale/offset/range remap), **Limit** (clamp/quantize), **Slope** (derivative), **Trigger** (threshold → pulse)|V179,V180
T292|x|**enumerate-the-surface** test: ∀ tool ∈ the agent surface has a live port ∈ the composed app (V193). the guard B12/B23 needed|V193
T293|x|`read_points` port ∈ `useAgentPorts` — plan→schema mapping. portless in-app today (same shape as B23, caught before it bit)|V193
T294|.|MCP `tools/list_changed` notification when grants|ports change; wire backend diagnostics to the existing notification channel (needs a headless backend)|V192
T288|x|deterministic auto-layout as a BUS COMMAND — layered/topological, rank = depth from sources, order within rank minimizing crossings. keymap `L` & the agent call the SAME one|V189,V190,V191,V78
T289|x|`add_node` placement ergonomics: optional `{relativeTo, direction}` ∴ an agent building left-to-right ⊥ invent coordinates. still 1 undo group|V189,V34
T290|x|MCP server + WebMCP adapters ∈ `src/mcp/**` — transport + schema only. + revision/diagnostic NOTIFICATIONS ∴ an observing agent sees the graph move w/o polling (quasi-realtime, ⊥ command-response)|V192,V39
T291|x|agent output inspection economics: encoded thumbnails (PNG, bounded long edge) + `describe_output` returning STATS ⊥ pixels (the T236 reduction generalizes). both throttled like `read_points`|V16,V144
T279|x|**Remap** — absolute UV lookup. our `uv` generator currently makes coordinates NOTHING can consume|V56
T280|x|**Reorder** (2-input channel shuffle). we have ⊥ way to move a value between channels @ all — capability gap, ⊥ convenience|V56,V57
T281|x|premultiply/unpremultiply as Math modes. we took TD's straight-alpha default w/o its escape hatch ∴ blurring a cutout halos & nothing can fix it|V56
T282|x|Composite ops 5 → ~15: Porter-Duff (atop/inside/outside/xor/under). ~0 cost — `operation` already `compileTime` & V140 forces 1 blend module|V140,V141
T283|x|**Limit** — quantize. value → posterize, position → pixelate. 1 neighbourless shader, 2 recognisable looks|-
T284|x|**Slope** w/ normal + emboss as MODES — the missing half of E6. needs T280 first (height → offset field ⊥ expressible w/o a Reorder)|T280
T285|.|**B22: `scale` override SHIMMERS today** — ⊥ mipmaps + 1 shared sampler ∴ the existing `scale: 1/4` preview path aliases. ⊥ hypothetical|V60
T295|.|**camera matrix + depth attachment** — camera is free (a uniform array, ⊥ IR change); depth is a small real change. EVERYTHING geometric is invisible w/o them ∴ first|V199
T296|.|pointset EDGE carries a resolved attribute→pair map + capacity + topology. 1 change, 4 payoffs — & it IS the copy-on-write mechanism V197 needs|V197,V19
T297|.|**swap ownership** under copy-on-write: consumers found by WHO BINDS a `pairId`, ⊥ by reachability. own task, own test — the genuinely hard half of V197|V197,V22
T298|.|point GENERATOR family — `pointGenerator` + named presets (grid, sphere, tube, torus, line, circle) sharing ONE kernel module, per the Composite/Over "both, one implementation" convention|V140,V196
T299|.|`renderInstances` — procedural primitives on points, Houdini's published composition order. ⊥ new resource kind, ⊥ new pass kind: `SPRITE_RENDER_WGSL` is already an instanced draw off an SoA buffer|V198,V199
T300|.|**mask/group** parameter on every point node — Houdini's Group field as a per-point WGSL predicate. CHEAPER for us than for Houdini: we evaluate ∈ a thread already running, Houdini ! materialize a list|-
T301|.|`renderSurface` w/ ANALYTIC topology (TD's Connectivity + `Dim[]`) — grid → deform → shaded surface w/ ⊥ mesh machinery|V199
T302|.|split kernel authoring like TD did: an ADVANCED kernel (may change counts) + a separate TOPOLOGY node. TD deprecated the combined Create POP ∴ ⊥ rebuild it|-
T286|.|POP **Map page** — a per-point attribute as a PARAMETER MODE (5th `ParameterBinding` kind). decide the shape while the union is cheap to grow|V107,V69
T287|.|POP **attribute qualifiers** (Color/Direction/Quaternion) — declares how a transform ! treat an attribute. our spec is type-only; encoding this ∈ magic names later is "index as identity" again|V75
T278|.|readback budget ∈ perf panel: count + bytes/frame, per-node attribution (V185)|V185,V144
T277|x|CHOP smoothing family: **Lag** (attack/release) + **Filter** (window). STATEFUL ∴ reset + V155|V181,V155
T272|.|`ProjectSettings.fps` (default 60, 1..240) + `project.setSettings` taking a PARTIAL patch validated by `projectSettingsSchema.partial()` (V37/V68) + per-field classifier (V178) + `AppRuntime.settings` as live view|V177,V178,V29,V37
T266|.|project settings UI: resolution, TARGET FPS, seed, working format. fps is ⊥ cosmetic — it's the DENOMINATOR of timeline time (V176) ∴ changing it changes the animation timebase, & the readout ! agree. + component resolution, showing INHERITED vs AUTHORED @ each level|V171,V21
T262|x|`ScratchRequest` gains an `external` kind + compiler materializes → `ExternalTextureResourceDescriptor`. the missing seam that makes T229 reachable|V167,V135
T263|x|**Movie/Image File In** node (T210) + **Webcam** node (T231) — decl external, `sourceId` per node|V167,V135,V136
T264|x|app side: file picker → `MediaSource`, `getUserMedia` → `MediaSource`, both → `registerMediaSource`. permission denial is a DIAGNOSTIC ⊥ a crash|V167,V136
T261|x|**New** button beside Open/Save + `project.new` command. confirm-when-dirty w/ Save as primary|V165,V166,V93,V29
T260|.|dev-only distinct preview clear colour — "drew nothing" ⊥ look like "drew black" (V164). ⊥ ship ∈ prod builds|V164,V106
T259|x|**per-frame driven/expression push** ∈ composition root — gate on `hasAnimatedParameters`, re-resolve, values-only update (isUniformOnlyChange → updateUniforms). THE last inch of "something moves"|V163,V5,V143
T257|x|**preview-side carry-over** ∈ `buildPreviewHost` — reuse T143's mechanism. w/o it V142 holds only below the 48-tile pool; above it a camera move still blanks everything|V162,V142
T258|x|preview host resilience: 1 unresolvable binding currently blanks the WHOLE host (`buildPreviewHost` catches → `h.set` unusable). ⊥ let 1 bad node black out ∀ previews. widens w/ T252|V162,V28
T249|x|`cookPolicy:"always"|"auto"` + the ORACLE first: ∀ §V89 example rendered both ways, byte-identical @ every frame index, under a scripted edit sequence (param@f10, speed 0→1@f20, rewire@f30, bypass@f40, feedback pulse@f50, mode@f60, rename@f70) + bus-fuzzed variant|V157,V147
T250|x|**fix bypass/mute** — `ui.bypassed`/`ui.muted` are UI-ONLY; `compile.ts` ⊥ reads them (B16)|V25
T251|x|dependency graph = edges ∪ param refs, applied to `pruneToActiveSinks()` FIRST|V154,V152
T252|x|preview-only vs output-reachable partition + fix `visiblePreviewSinks()` declaring EVERY texture node a sink (B18)|V158,V25
T253|x|reuse the media dirty bit `uploadExternalTextures` already computes & discards — 30fps source ∈ 60fps graph re-runs ∀ downstream today|V136
T254|~|**DEFERRED W/ NUMBERS, ⊥ pending.** the STATIC-PLAN gate shipped (a fully static plan w/ nothing dirty skips the frame outright; V155 safe by construction). the per-node residual is ⊥ worth its correctness risk: census over ∀ 7 examples — E1 13%, E2-E4 0%, E5 100%, E6 17%, E7 25%. shared-frame binding propagates time-dependence through nearly everything ∴ gating buys ≤25% on ANIMATED graphs. revisit ONLY if 200-node graphs make 25% matter; the census script ∈ the commit reproduces the basis| ∈ `encode()` + dirty set on `Program` + pure clock-free `runtime/execution/cook.ts` policy|V155,V156,V159,V157
T255|x|**fix `renderedThisFrame`** — `noteFrame()` bumps EVERY node ∀ frame ∴ popup always reads true (B17)|V85
T256|.|per-node CPU+GPU ms together w/ category rollups (Notch's profiler, better than TD's)|V85
T248|.|reference/bind lines ∈ node graph — straight + DASHED, visually ≠ data edge. derived, toggleable. + cycle rejection across edges ∪ refs|V151,V152,V153,V107
T247|x|expression completion @ the parameter — variables ∈ scope, fns, node refs. popup ⊥ steal Enter|Esc from the field. source = evaluator probe|V150,V107,V90
T246|.|parameter context menu (TD analog): copy value, copy REFERENCE, paste, reset→default, mode switch. items ← bus registry per V78 — ⊥ a 2nd hardcoded menu|V148,V149,V78,V107
T245|x|param applicability predicates + inactive rendering ∈ ∀ controls (B14). noise `speed` on 2D types is case 0|V146,V90
T244|x|lint rule for V145 — ⊥ implicit global-named type|V145
T233|x|**flicker on pan/zoom** — find the shared cause (B13), fix, regression test @ composed level|V142
T234|x|**Cross** node — lerp 2 inputs by a factor. the one blend that ISN'T ∈ the composite op list because its param, ⊥ its mode, is the point|V140
T235|.|**Switch** node — select 1 of N inputs by index. variadic (T225/T226 ordering) + index is expression-drivable (V107)|V131,V107
T236|x|**Analyze** node — texture → scalar (max/min/avg/sum/count) readable by expressions. closes image→parameter loop|V144,V107
T237|.|**Cache / Time Machine** — TRAP: needs a 3D-texture resource kind we ⊥ have, & ~1 GB for 60 frames @ 1080p rgba16float. cost the resource kind BEFORE the node — hold N frames, read frame `t-n`. trails & time-displacement w/o hand-rolled feedback|V135
T238|x|**LFO** node — sin/tri/saw/square/noise over time, phase+freq+amp. THE animation source|V143
T239|x|**Constant/Value** node — named scalar channels, 1 place to park numbers many params reference (TD Constant CHOP)|V107
T240|x|**Timer** node — ramp 0..1 over a length, w/ cycle + pulse reset (T214/T216)|V143
T241|x|Edge + Convolve (arbitrary kernel) filters|-
T242|x|Rectangle SDF generator (Circle exists, Rect ⊥) + Flip/Mirror|-
T243|.|Text generator — glyph atlas → texture. DEPENDS ON T262: text is a media node ∈ disguise (the atlas is an external texture)|T262
T232|x|**Composite** node — variadic in + `operation` enum (`compileTime`), sharing ONE blend module w/ the named nodes|V140,V141,V131,V107
T226|.|Composite family variadic (Over/Add/Multiply/Screen/Difference) — fold N inputs ∈ declared order; Over is order-dependent so the fold direction is a stated fact, ⊥ an accident|V131,V14
T227|.|variadic port UI: n slots + 1 free, drag to reorder, index shown|V132,V19
T221|x|node `name` as a unique identifier: auto-number on create + on rename collision, `label` → name semantics, uniqueness enforced ∈ the patch layer|V127,V129
T222|x|rename rewrites referencing binds/expressions ∈ the same patch|V128,V110
T223|x|**Null node** — 1 in 1 out, passthrough, ⊥ emits a pass; the stable reference point for rewiring|V127,V25
T224|x|move the Common block below the node's parameters (or behind a fold) — today it sits above them|V130,V90
T214|.|`pulse` parameter type + control (momentary, ⊥ serialized, audited ⊥ undoable) + expression-fireable|V123,V124,V125,V107
T215|x|per-resource temporal reset so a pulse clears ONE node's history, ⊥ every pair. unblocks `runtime.resetFeedback`|V126,V62,V22
T216|.|expose Reset on nodes declaring `stateful.reset`: Feedback (+ hold toggle, TD pairs both), Noise reseed, accumulator, point sim|V123,V46
T229|x|`externalTexture` resource kind + runtime media-source registry + upload-on-frame-ready. BLOCKS T211 — media cannot exist without it|V135,V136,V63,V58
T231|.|**DeviceIn** node — device enumeration + pick, permission flow, live indicator, negotiated-vs-requested resolution, ∀ interruption states as node status. rides T229's registry|V137,V138,V139,V38
T230|.|asset registry: resolve `AssetReference` → a decoded source; File System Access + drag-drop + relink flow for unresolved|V121,V10
T210|.|**MovieFileOut** node — texture in → encoded file out, `sink: true`, drives T111 exact-frame capture, capability-gated (recording + localFile, V38). several may run at once|V119,V120,V48,V38
T211|.|**MovieFileIn** node — image\|video\|sequence → texture. play/pause/seek/loop/rate, in\|out points, outputs res + current time + duration + frame-ready. `AssetReference`, media-source abstraction|V121,V10,V13
T212|.|drop a connection ON AN EDGE → replaces it (takes that edge's target). 1 patch = disconnect + connect, 1 undo group. generous invisible hit area on the edge|V14b,V14c,V32,V34
T213|.|drop a NODE on an edge → SPLICE it inline (upstream→node→downstream) when types allow. 1 patch. the sibling gesture: the edge as a drop target for a node, ⊥ only for a connection|V14b,V13,V32
T208|.|node resize: React Flow NodeResizer + `setNodeSize` patch op, 1 patch per gesture, persisted ∈ the document, min size respected|V116,V15,V29
T209|.|preview tile resolution follows the node's preview area (ladder-quantised, capped), aspect letterboxed ⊥ stretched|V117,V118,V28c
T206|x|preview tiles follow a node drag: compute rects w/ `slotScreenRect(slot, viewport)` ← React Flow's LIVE node positions, every display frame. today `node-preview-slot.tsx:39` measures w/ `getBoundingClientRect()` — the design note (§2) rejected measuring explicitly|V111,V112,V16
T207|x|component-addressable slots: `color.r`/`t.x` each w/ own mode+value; resolver reassembles; compound editor writes ∀ components ∈ 1 patch|V113,V114,V107
T202|x|`ParameterSlot` + `ParameterBinding` ∈ domain types + zod + passthrough for unknown kinds (extends T106). ∀ mode keeps its own value|V107,V108,V69
T203|x|resolver evaluates ∀ modes — static, expression (V71 evaluator), bind (incl. `parent.<key>`), driven reserved. sole eval point|V109,V61,V71
T204|x|parameter mode UI: click the LABEL to expand → 4 mode buttons w/ TD's has-a-value corner mark; ctrl/cmd+E edits the expression; right-click menu|V107,V108,V90
T205|x|bind cycle detection @ authoring time, ⊥ @ evaluation|V110
T200|x|help panel (mod+/ or ?): shortcuts ← keymap, node reference ← manifests, expression guide ← evaluator whitelist. on-demand, ⊥ ambient (V90)|V105,V55,V90
T201|x|expression authoring surfaced @ the parameter — how to drive e.g. noise translate from `time`, which vars + fns exist, live-evaluated preview of the result|V105,V71,V61
T198|x|node badges (P/B/M) dispatch `node.toggle*` w/ the SELECTION, ⊥ a raw single-node patch. today `node-view.tsx:47` bypasses the command ∴ badge ≠ key ≠ menu|V101,V102,V29,V52
T199|x|wire `read_points`: `createPointsReadback({ readBuffer, pointSetInfo, now })` — clock ! be INJECTED (the export boundary test caught a `Date.now` default)|V48,V16
T197|x|preview OFF renders the node's resolved size/format/space, ⊥ a black box (V100). preview ON but not yet rendered = a distinct state, ⊥ the same blank|V100,V91
T196|x|move `GpuStatusCard` out of the viewer → performance panel (beside est. bytes, lastBuild, per-pass ms). viewer empty state = "No output" per V91; drop the implementation prose entirely|V91,V92a
T195|x|standalone WGSL compile — today WGSL is only checked when the GRAPH compiles on a device ∴ a shader error ⊥ surface until the whole graph is wired + rendering|V9,V27
T191|x|dockable pane system: zones (left\|right\|bottom\|center), drag a pane between them, persisted arrangement, ∀ pane not just the shader editor|V95,V18
T192|x|float / pop-out a pane into its own window, sharing ONE bus + store + runtime. shares the multi-window transport w/ T110 perform mode|V97,V64,V70,V29
T193|x|relocation preserves content — portal|reparent so CodeMirror & previews survive a move w/o remount|V96
T188|x|component library browser — shipped + user, instantiate linked\|detached, version + upgrade shown, save-selection-as-component surfaced|V93,V94,V79,V84
T189|x|example library browser — open project, confirm when dirty, reads the 6 shipped `.loom.json`|V93,V88
T190|.|ship the starter component set: FeedbackEcho, Bloom, DisplacementStack, MediaGrade, Kaleidoscope — as real saved components, ⊥ a privileged format|V94,V79
T187|.|`component-scope.ts::resolveInstanceValues` returns DECODED `.values` into the parent scope ∴ a display colour decodes TWICE (mid-grey → ~0.046). ! return stored-space `entries[].value`, as `flatten.ts` now does|V56,V61,V81
T184|x|**START THE FRAME LOOP.** `backend.loop()` is called NOWHERE ∴ nothing renders — ⊥ node preview, ⊥ viewer, ⊥ output. compiler runs, backend exists, ⊥ frame is ever driven|V8,V49
T185|x|mount the preview system: construct `createPreviewSystem`, `backend.previewHost(canvas)`, feed `PreviewSystemFrame.requests` ← visible set, present tiles per frame|V7,V28,V64
T186|x|drop-on-occupied-input REPLACES the edge in 1 patch|V14a,V32,V34
T182|x|previews default-on for visible texture nodes: composition root derives visible set → explicit sink list (V28a) ∀ compile. `ui.preview` becomes a PIN. today a disconnected node renders nothing|V28b,V28c,V28a,V25
T183|x|`.subTrigger[data-state="open"]` uses `--bg-raise` while `.item[data-highlighted]` uses `--bg-active` ∴ the highlight visibly CHANGES when a submenu opens. open parent ! look identical to highlighted|V17
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
**⊥ `git add -A` | `git add .` while tracks live.** explicit paths ONLY. a track swept 7 files of another session's uncommitted work into its commit; repaired w/ `git restore --staged` (index only, ⊥ worktree) & disclosed. `-A` is ⊥ a convenience here, it is a cross-session data hazard — the sweeping track cannot know what it took.

**GATES THAT LIE — ! know which command actually checks:**
- bare `tsc --noEmit` @ root checks NOTHING & exits 0 (references-only tsconfig, `files: []`). ! `pnpm typecheck`.
- `vitest` ⊥ typecheck. a suite is green while the types are red.
- a unit test on shader SOURCE (`toContain("frameU.time")`) is ⊥ evidence a pixel moved (V147, B15).
∀ 3 have already produced a false green this project. a gate you ⊥ verified is a gate you ⊥ have.

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
| A design system + shell | T2 T3 T5 T4 T6 T169 T170 T171 T191 T192 T193 T259 T261 T265 T266 T267 T271 | `src/ui/**` `src/app/**` |
| B domain + bus | T11 T12 T10 T50 T52 T53 T65 T66 T174 T175 T176 T177 T202 T203 T205 T207 T214 T221 T222 T225 | `src/domain/graph/**` `src/domain/parameters/**` `src/domain/commands/**` |
| C gpu backend | T13 T14 T16 T17 T67 | `src/runtime/backend/**` `src/runtime/execution/**` |
| D guardrails | T7 T8 T64 T244 T260 | `eslint.config.*` `vitest.config.*` `playwright.config.*` `.github/**` |

### wave 2 — 5 tracks
| track | tasks | owns |
|---|---|---|
| E compiler | T24 T25 T26 T27 T72 T28 T75 T29 T30 T31 T32 T33 T147 T149 T151 T164 | `src/compiler/**` |
| F graph view | T18 T19 T227 T248 | `src/editor/graph-canvas/**` `src/editor/nodes/**` `src/editor/edges/**` |
| G controls | T37 T38 T73 T39 T167 T178 T182 T183 T184 T185 T186 T187 T188 T189 T196 T197 T198 T200 T201 T204 T218 T219 T220 T224 T228 T245 T246 T247 T269 T270 | `src/editor/inspector/**` `src/editor/library/**` `src/ui/controls/**` |
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
| K node catalog | T273 T274 T275 T276 T277 T70 T40 T152 T165 T166 T190 T194 T210 T211 T216 T223 T226 T231 T232 T234 T235 T236 T237 T238 T239 T240 T241 T242 T243 T262 T263 T264 | `src/nodes/definitions/**` `src/nodes/shaders/**` |
| L telemetry | T41 T42 T99 T145 T146 | `src/runtime/telemetry/**` |
| M persistence | T43 T44 T91 T139 T230 | `src/domain/project/**` `src/domain/migrations/**` |
| N export | T68 T82 T111 | `src/runtime/export/**` |

barrier: **T51** route ∀ human action through bus — toolbar, menu, keybind, inspector, drag-connect.
serial, crosses `src/editor/**` + `src/app/**`. ! before wave 4: agent tools assume bus = only mutation path (V29).

### wave 4 — 2 tracks
| track | tasks | owns |
|---|---|---|
| O agent surface | T54 T55 T56 T57 T58 T59 T60 | `src/agent/**` |
| P tests | T45 T46 T47 T69 T48 T61 T157 T162 | `src/tests/**` |
| R hardening | T229 T217 T215 T199 T195 T173 T179 T180 T181 T172 T95 T96 T97 T98 T102 T103 T109 T138 T140 T141 T142 T143 T144 T158 T159 T160 T161 T163 | `src/runtime/backend/**` `src/domain/graph/**` |
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
B9|2026-08-29|**V9 BROKEN ON REAL DEVICE.** vgpu raises `VGPU-COMPILE-FAILED` from an ASYNC pipeline-store path ∴ ⊥ caught by `resources.ts` try/catch — lands as an unhandled rejection on stderr. `compile()` RESOLVES, broken program installed, previous VALID program RELEASED, `stale` stays false, ZERO diagnostics reach `onDiagnostic`. picture "looks retained" only because Dawn drops the whole command buffer. **the mock test PASSES** — mock rejects sync, Dawn ⊥ — a gate greener than the product|T217 ✓
B10|2026-08-29|**V15 BROKEN ∈ the composed app.** an 80px slider drag shows ONE value until release; arrow-key hold same. `parameter-editor.ts` + `coalesce.ts` correct in isolation & unit-tested; `NumberField` does emit live. suspect `inspector.tsx` builds the editor ∈ `useMemo` + disposes ∈ effect cleanup → disposed coalescer cancels the pending frame, swallowing live values while commit (immediate) still works. ∴ ∀ of V5's uniform-only path is UNREACHABLE from the UI|T218
B11|2026-08-29|**DATA LOSS.** shader edit discarded when clicking empty canvas: the click blurs the editor AND clears selection, `ShaderPane` hits its `nodeId === null` branch and unmounts `ShaderEditor` BEFORE the onBlur commit lands. status strip then reads "saved" — a lie on top of the loss|T219 ✓
B24|2026-08-30|**a DECLARED pointset topology ⊥ connect to a consumer asking for none.** `port-compat.ts` compared topology by STRICT INEQUALITY ∴ `undefined` was a VALUE, ⊥ an absent claim. ⊥ visible today (nothing declares topology ∴ both sides `undefined` ∴ equal) — it bites the FIRST generator honest enough to declare `topology:"points"`, which then fails to connect to `renderPoints`. the reward for precision would have been a graph that refuses to wire. same rule colour space already follows ∈ the same file|V13
B23|2026-08-30|**`render_preview` was DEAD ∈ the product.** built, schema'd, unit-tested — & NOTHING ∈ `src/app` ever handed the surface a preview port; the only `ExportInterface` construction ∈ the tree was inside the ACCEPTANCE TEST. so the test proved the tool works against a fixture nobody ships. 3rd instance of the shape (B12, T264 media, this)|V193
B22|2026-08-30|**`scale` resolution override ALIASES today.** ⊥ mipmaps anywhere + 1 shared sampler ∴ a node overridden to `scale: 1/4` minifies by point-sampling → shimmer on any moving high-frequency content (noise, checker, edges). ⊥ found by a test; found by reading the sampler contract. the override reads as "cheaper" & is quietly "worse"|T285
B21|2026-08-30|**`time * k` animates JITTERY.** owner guessed JS rounding; ⊥ — `liveClock` accumulates WALL deltas & rAF jitters ~±several ms ∴ time advances unevenly & a linear expression steps unevenly. clock already does the 2 hard things right (clamped delta, epoch 0 for f32). missing piece = a TIMELINE clock, uniform by construction. workaround today: `frame * k` (`frame` IS ∈ scope)|V176
B20|2026-08-30|**a WORKING LFO reports as PRUNED.** value trio has ⊥ ports ∴ never enters the plan; `pruneToActiveSinks` walks edges ∴ lists them ∈ `plan.pruned`. `node-info-popup` renders `<Badge tone="warn">pruned</Badge>` & the perf panel counts them. the node works — the driven channel resolves off the DOCUMENT — & the UI says it's dead. found by writing E7, ⊥ by a test|V173
B19|2026-08-30|**DISPATCH RAN BEFORE ALL RENDER PASSES, same frame.** vgpu computes have ⊥ frame-level pass API — `compute.dispatch()` makes its OWN encoder & SUBMITS IMMEDIATELY; render passes submit @ frame close. ∴ ∈ 1 frame every dispatch executed before every render pass regardless of plan order. Analyze read all-zeros; `textureToAttribute` (TOP→POP bridge) has sampled the PREVIOUS frame SINCE IT LANDED & its Dawn test tolerated it. ⊥ visible ∈ any mock, ⊥ per-layer test failed. fixed for the DIRECT path (segmented encoding); LOOP path keeps 1-frame effect→dispatch latency until vgpu gains a frame compute hook|V168
B16|2026-08-30|**BYPASS & MUTE DO NOTHING.** `ui.bypassed`/`ui.muted` have toggles, badges & edge-flow styling; `compile.ts` NEVER READS THEM. classifier already calls them structural (`recompile-region`) ∴ the edit is classified right & then ignored. user toggles bypass, sees the badge, picture ⊥ change|V25
B17|2026-08-30|**`renderedThisFrame` is VACUOUS.** `hub.ts:noteFrame()` bumps ∀ node ∈ plan ∀ frame ∴ node info popup ALWAYS reads true. ⊥ a lie today (nothing IS skipped) but 0 information, & becomes a lie the moment T254 lands|V85
B18|2026-08-30|**§V25 pruning effectively DISABLED.** `use-graph-compile.ts:visiblePreviewSinks()` declares EVERY texture-producing node a preview sink ∴ a 200-node graph encodes 200+ passes/frame regardless of what's on screen. correct per §V28b/§V142 as written; the sink definition is what's wrong|V158,V25
B14|2026-08-29|**`Time Speed` is a SILENT NO-OP on default noise type.** default `type` = `perlin2d`; 2D field has ⊥ 4th dim ∴ `baseNoise` uses `q.xy` & `frameU.time * speed` is discarded. user adds Noise, sees Time Speed, sets it, hits play → still image, having done ∀ right. shader matches TD; TD DIMS inapplicable params & we ⊥. ∴ reads as "nothing animates". engine verified fine on perlin4d @ Dawn|V146
B15|2026-08-29|**⊥ test asserted the picture MOVES.** transport, frame block & `noise.test.ts` (`toContain("frameU.time")` — a STRING test) ∀ green while nobody checked a texel changed between frames. same shape as B9/B10. also: `speed` ≤ 10 ∴ @ 60fps 1 frame moves field < 1/255 → naive per-frame assert fails on a WORKING build; claim ! be "1 second of playback moves picture"|V147
B13|2026-08-29|**flicker on camera move.** MEASURED: compile +0, surface registration +0 ∴ candidates (a) & (c) INNOCENT — viewport never reached the plan. mover = `setPreviewProgram` (pan +1, zoom +2). (b) confirmed: tile sized from on-screen rect ∴ carries zoom (`64x36`→`96x54` mid-gesture, ladder-quantised ∴ "occasionally"). pan: a preview off screen SURRENDERED its tile → reinstall. amplifier ∴ "in sync": `buildPreviewHost` uses `emptyCarryOver` → any program change destroys & recreates EVERY tile. ∀ node previews flicker black for 1 frame together while panning/zooming. IN SYNC ∴ 1 shared cause, ⊥ per-node. candidates: (a) surface set re-registered on viewport change → presentation seam re-created → whole plan's targets reallocate; (b) preview canvas size derived from ZOOM → reconfigure per zoom step → 1 undefined frame each; (c) preview mount keyed on a value the transform touches → remount. ⊥ guess — instrument compile count + surface-registration count while panning, THEN fix|V142
B12|2026-08-29|`createAgentToolSurface` has NO CALLER anywhere ∈ `src/app/**` — the agent surface is built, tested & not wired into the product|T220
B1|2026-08-29|`formatFallback` w/ unsupported `depth24plus` + `allowsDepth` → falls back to `supported[0]` = a COLOR format, warning only. depth output silently becomes color|T158 ✓
B2|2026-08-29|`formatNoFallback` error path RETURNS the unsupported format ∴ plan carries a format the device ⊥ allocate|T158 ✓
B3|2026-08-29|`resolveSinks` doc says caller may narrow preview list; impl unconditionally unions ∀ `ui.preview===true`. doc ≠ code|T159 ✓
B8|2026-08-29|TWO parameter eval paths ∴ V61 already drifted: `src/editor/inspector/parameter-resolver.ts` (decodes display→linear) & `src/compiler/validate.ts::resolveParameterValues` (⊥ decodes). T148's fix reaches the INSPECTOR, ⊥ the GPU — rendered color still wrong|T168 ✓
B5|2026-08-29|`data` space unshippable — `colorSpaceForFormat` derives `data` only ← `r32float`, but plan binds 1 shared LINEAR sampler ∀ textures & r32float ⊥ filterable on Tier B w/o `float32-filterable`. ∴ a V56-flagged displacement field ⊥ renders|T83+T150 ✓
B6|2026-08-29|Output node target size/format follows its INPUT, ⊥ project. `outputNode` declares no resolution/format policy; its own doc says project surface. E5 presents 2048² ⊥ project 1280×720|T165 ✓
B7|2026-08-29|`customWgsl.compile()` emits ⊥ `uniformBinding`/`sharedBinding` ∴ kernel ⊥ receive uniforms or time. shipped default `source` DECLARES a `params` block bound to nothing = trap for anyone editing it|T166 ✓
B4|2026-08-29|⊥ Dawn host ∈ `src/runtime/backend/vgpu/` ∴ ⊥ V3-clean way to get a headless device. V47/T67/T69 were untestable; parity harness had to `eslint-disable` V3|T160 ✓
