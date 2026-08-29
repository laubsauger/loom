# WebGPU Visual Node Compositor

## Implementation Handoff Specification

**Status:** Proposed architecture and implementation plan  
**Primary rendering foundation:** [`vercel-labs/vgpu`](https://github.com/vercel-labs/vgpu)  
**Primary graph UI:** [`@xyflow/react`](https://reactflow.dev/)  
**Initial product target:** An agent-ready, browser-native, TouchDesigner TOP-style visual compositor with WGSL effects, arbitrary branching, live previews, layers, feedback, compute-driven simulations, and reusable graph components.

---

## 1. Executive decision

Build this as a new visual WebGPU compositor inspired by TouchDesigner and Notch, not as a literal compatibility clone.

The initial product should focus on the part of TouchDesigner that maps naturally to WebGPU:

- Texture and image processing graphs
- Fullscreen WGSL effects
- Layering and compositing
- Branching and arbitrary intermediate previews
- Feedback and frame history
- Procedural generators
- Compute shaders and GPU simulations
- GPU particles
- Basic geometry, instancing, cameras, materials, and post-processing
- Schema-driven, expressive parameter controls

Do not make full TouchDesigner or Notch parity an MVP requirement. Native video I/O, NDI, Spout, Syphon, capture cards, proprietary codecs, native plugins, and a complete audio or geometry operator ecosystem are separate product programs.

`vgpu` is suitable as the rendering substrate because it already provides explicit frames and passes, offscreen targets, fullscreen effects, compute, storage buffers, ping-pong resources, reflection, instancing, blending, depth, MSAA, indirect drawing, GPU timers, browser execution, headless Node execution, and deterministic mocks.

It is not a node system. The application must own:

- The canonical graph model
- Typed connection validation
- Graph compilation and scheduling
- Temporal feedback semantics
- Texture and buffer lifetime management
- Node manifests
- Parameter metadata and automation
- Preview rendering
- Shader editing and diagnostics
- Persistence, undo, redo, import, and export
- Performance instrumentation

The implementation should place `vgpu` behind an internal rendering adapter because the repository is pre-1.0 and its public API may evolve.

---

## 2. Product definition

### 2.1 Product statement

A real-time visual programming environment where users connect generators, media, shaders, transforms, composites, feedback loops, simulations, and outputs in a node graph. Every meaningful branch can be inspected live. Parameters are editable directly on nodes or in a detailed inspector. Custom WGSL shaders are first-class nodes.

The same semantic operations available to a human should be available to authorized agents through structured tools. Agents should be able to inspect the current project, discover node definitions, build and edit graphs, author shaders, load approved assets, run validation, render previews, diagnose problems, and package reusable components without manipulating the DOM.

### 2.2 MVP experience

A user must be able to:

1. Create a graph from an empty canvas.
2. Add generator, transform, filter, composite, feedback, and output nodes.
3. Connect typed ports with immediate validation.
4. See a live thumbnail on any visible visual node.
5. Open any node output in a larger viewer.
6. Change parameters without recompiling unaffected pipelines.
7. Write or paste WGSL and receive mapped compilation diagnostics.
8. Create a legal feedback loop through an explicit Feedback node.
9. Save and reopen the graph without semantic changes.
10. See frame time and per-pass GPU timing.

### 2.3 Initial non-goals

- Loading TouchDesigner `.toe` projects
- Loading Notch projects
- Feature parity with TouchDesigner SOP, CHOP, DAT, MAT, and COMP families
- Native plugin ABI support
- NDI, Spout, Syphon, DeckLink, or capture-card support
- DAW-grade low-latency audio graph processing
- Multi-window native output and projector mapping
- Collaborative editing in the first version
- Automatic fusion of all possible shader nodes in the first version
- A marketplace in the first version

Collaboration and agent control are nevertheless architectural requirements. The document model, command system, IDs, transactions, and audit trail must not make either capability expensive to add later. A minimal agent interface should arrive much earlier than full real-time collaboration.

### 2.4 Confirmed product commitments

- The first product is browser-only.
- Electron or another desktop wrapper may be considered later, but core architecture must not depend on it.
- Live, continuously running, real-time visuals are the primary experience.
- A timeline compositor is a later product layer, not part of the core MVP.
- Offline and headless rendering are future requirements and should influence clock, transport, asset, and execution boundaries now.
- Multiplayer collaboration begins only after the core graph compiler, renderer, project format, and editing model are stable.
- Agent control remains an early architectural requirement and does not wait for multiplayer.

---

## 3. Technology choices

### 3.1 Recommended application stack

| Concern | Recommended choice | Rationale |
| --- | --- | --- |
| Application | React + TypeScript + Vite | Fast iteration and a mature UI ecosystem |
| Graph UI | `@xyflow/react` | Highly customizable React nodes, handles, edges, selection, viewport, grouping, minimap, and resizing |
| Canonical state | Zustand with Immer or equivalent | Selective subscriptions and explicit transactional edits |
| GPU runtime | `vgpu` | Small explicit WebGPU API with suitable render, compute, target, and ping-pong primitives |
| Shader editor | Monaco or CodeMirror 6 | Diagnostics, syntax support, completion, and source mapping hooks |
| UI primitives | Radix UI or React Aria | Accessible low-level components that can be fully restyled |
| Styling | CSS variables plus CSS modules or Tailwind | Themeable, high-fidelity visual system |
| Validation | Zod or Valibot | Runtime validation for graph files and node manifests |
| Tests | Vitest + Playwright | Unit, compiler, browser, visual, and interaction coverage |
| Persistence | Versioned JSON document | Portable project format with explicit migrations |

### 3.2 React Flow decision

Use React Flow only for presentation and interaction.

Do not use the React Flow node array as the execution engine's mutable source of truth. Maintain a domain graph independent of React Flow and derive the visible graph from it.

React Flow owns:

- Node placement and dimensions
- Selection and viewport
- Dragging and connection gestures
- Edge rendering
- Group boxes and comments
- Visible node components

The domain layer owns:

- Node identity and type
- Port definitions
- Connections
- Parameters
- Shader source references
- Subgraph identity
- Timeline and automation data
- Runtime and compilation state

### 3.3 Why not use Rete.js as the execution engine

Rete.js is a viable graph editor with dataflow and control-flow engines, but GPU scheduling requires product-specific behavior:

- Previous-frame dependencies
- Render and compute pass boundaries
- Resolution and texture-format propagation
- Resource aliasing and pooling
- Multi-output targets
- Pipeline caching
- Selective branch evaluation
- Preview instrumentation
- Future shader-pass fusion

These semantics should remain under application control. Rete.js can be reconsidered if a non-React editor or a plugin-oriented graph shell becomes strategically important.

---

## 4. High-level architecture

The system is divided into five layers.

### 4.1 Editor layer

Responsible for graph interaction, node rendering, inspector controls, keyboard commands, menus, search, layout, and user feedback.

The editor never issues WebGPU commands directly.

### 4.2 Domain graph layer

The canonical serializable project model. It contains nodes, ports, edges, parameters, automation, metadata, and document versions.

### 4.3 Compiler layer

Transforms a domain graph into an immutable execution plan.

Compilation stages:

1. Resolve node definitions.
2. Validate node parameters and port connections.
3. Separate current-frame edges from temporal edges.
4. Reject illegal cycles.
5. Topologically sort the current-frame graph.
6. Propagate texture dimensions, formats, color spaces, and sample requirements.
7. Determine active sinks and prune unreachable nodes.
8. Materialize outputs required by branches, previews, feedback, readback, or debugging.
9. Assign logical resources.
10. Perform lifetime analysis and map logical resources to pooled physical targets where safe.
11. Create or reuse `vgpu` effects, draws, compute programs, targets, buffers, samplers, and ping-pong pairs.
12. Pre-warm pipelines for known target signatures.
13. Emit an execution plan with diagnostics and performance metadata.

### 4.4 Runtime layer

Runs the current immutable execution plan once per frame. It updates time-varying uniforms, encodes passes, swaps temporal resources, updates previews, collects timing results, and handles device loss.

The runtime must not depend on React rendering frequency.

### 4.5 GPU adapter layer

An internal abstraction around `vgpu`. Keep all direct imports in a small package or module boundary.

Suggested public shape:

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

This boundary reduces migration cost if `vgpu` changes or if lower-level WebGPU access is needed for a feature it does not expose.

---

## 5. Canonical graph model

Use stable opaque string IDs. Never use array indices as identities.

```ts
type NodeId = string;
type EdgeId = string;
type PortId = string;

interface ProjectDocument {
  schemaVersion: number;
  projectId: string;
  name: string;
  graph: GraphDocument;
  settings: ProjectSettings;
  assets: AssetReference[];
  createdAt: string;
  updatedAt: string;
}

interface GraphDocument {
  nodes: Record<NodeId, GraphNode>;
  edges: Record<EdgeId, GraphEdge>;
  groups: Record<string, GraphGroup>;
  viewport?: ViewportState;
}

interface GraphNode {
  id: NodeId;
  type: string;
  definitionVersion: number;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parameters: Record<string, ParameterValue>;
  state?: Record<string, unknown>;
  ui?: {
    collapsed?: boolean;
    preview?: boolean;
    bypassed?: boolean;
    muted?: boolean;
    color?: string;
  };
}

interface GraphEdge {
  id: EdgeId;
  source: { nodeId: NodeId; portId: PortId };
  target: { nodeId: NodeId; portId: PortId };
}
```

Store semantic graph state separately from ephemeral runtime state. Do not serialize GPU resources, compiled pipelines, live media elements, object URLs, or transient diagnostics.

---

## 6. Typed ports

### 6.1 Port families

Start with these port kinds:

```ts
type PortType =
  | { kind: "texture2d"; sample: "float" | "unfilterable-float" | "depth"; channels?: 1 | 2 | 4 }
  | { kind: "buffer"; element: string; access: "read" | "write" | "read-write" }
  | { kind: "scalar"; scalar: "f32" | "i32" | "u32" | "bool" }
  | { kind: "vector"; scalar: "f32" | "i32" | "u32"; size: 2 | 3 | 4 }
  | { kind: "matrix"; columns: 3 | 4; rows: 3 | 4 }
  | { kind: "geometry" }
  | { kind: "camera" }
  | { kind: "event" }
  | { kind: "audioFeatures" };
```

### 6.2 Connection rules

- Require exact port compatibility by default.
- Support deliberate adapters through visible conversion nodes.
- Allow only one incoming edge on ordinary input ports.
- Allow multiple incoming edges only on ports explicitly declared as variadic.
- Permit arbitrary fan-out from an output.
- Reject current-frame cycles.
- Permit a cycle only when it passes through a node whose output is explicitly temporal.
- Never silently insert color-space, texture-format, scalar-vector, or resolution conversions in the first version.

Visible conversion nodes make graph behavior explainable and previewable.

---

## 7. Node definition and extension API

Every built-in and custom node is described by a versioned manifest plus a compile implementation.

```ts
interface NodeDefinition {
  type: string;
  version: number;
  title: string;
  category: string;
  description?: string;
  tags?: string[];
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  parameters: ParameterSchema;
  resolutionPolicy?: ResolutionPolicy;
  formatPolicy?: FormatPolicy;
  temporal?: TemporalDefinition;
  capabilities?: CapabilityRequirement[];
  compile(context: NodeCompileContext): CompiledNodeDescription;
  migrate?(oldVersion: number, data: unknown): MigrationResult;
}
```

### 7.1 Node categories for the first usable release

**Input**

- Image
- Video
- Webcam, where supported
- External canvas
- Mouse and pointer
- Time
- Audio features, analysis only

**Generator**

- Solid color
- Gradient
- UV coordinates
- Noise
- Checkerboard
- Shape or SDF generator
- Custom WGSL

**Transform**

- Translate, rotate, scale
- Crop
- Tile and mirror
- Fit and aspect
- Polar transform

**Filter**

- Levels
- HSV or HSL adjustment
- Blur
- Sharpen
- Edge detection
- Threshold
- Chroma key
- Displacement
- Pixelate
- Posterize

**Composite**

- Over
- Add
- Multiply
- Screen
- Difference
- Min and max
- Mask
- Multi-layer composite

**Temporal and simulation**

- Feedback
- Frame delay
- Accumulator
- Reaction-diffusion example
- Particle simulation example

**Output and debug**

- Viewer output
- Texture export or readback
- Channel viewer
- Histogram or luminance meter
- Performance marker

---

## 8. Parameter system

WGSL reflection can identify binding names and types. It cannot infer good authoring controls. The node definition must provide presentation and behavior metadata.

```ts
type ParameterDefinition =
  | NumberParameter
  | BooleanParameter
  | EnumParameter
  | ColorParameter
  | VectorParameter
  | StringParameter
  | AssetParameter
  | CurveParameter;

interface NumberParameter {
  type: "number";
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  scale?: "linear" | "log";
  unit?: "px" | "percent" | "degrees" | "radians" | "seconds" | "hz";
  precision?: number;
  animatable?: boolean;
  compileTime?: boolean;
  group?: string;
}
```

### 8.1 Parameter interaction requirements

- Drag left and right on numeric values.
- Shift modifies slowly and Alt or Option modifies quickly.
- Double-click resets to default.
- Text entry supports arithmetic expressions where safe.
- Parameters show units and constrained ranges.
- Color values support linear and display color representations.
- Node controls remain compact; the inspector exposes the complete control set.
- Controls must not begin graph drags or node selection gestures accidentally.
- Parameter updates must be coalesced to animation frames.
- Uniform-only changes must not trigger graph recompilation.
- Compile-time overrides and shader-structure changes must trigger targeted recompilation.

### 8.2 Future parameter capabilities

Design the schema so it can later support:

- Keyframes and curves
- Expressions
- MIDI and OSC mapping
- Audio-reactive modulation
- Parameter linking
- Presets
- Randomization ranges
- Exposed subgraph parameters

Do not implement all of these in the proof of concept.

---

## 9. Shader authoring

### 9.1 Runtime WGSL

`vgpu.effect()` accepts a raw string or a `ShaderSource`, allowing runtime-generated WGSL.

Use fullscreen effects for texture nodes whose output is a rendered texture. Use compute for simulations and workloads better expressed through storage textures or buffers. Use draw calls for geometry.

### 9.2 Custom shader node contract

The first custom shader node should use a constrained contract:

```wgsl
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

struct Params {
  time: f32,
  amount: f32,
};

@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}
```

Later versions can support multiple inputs, multiple color outputs, storage resources, custom vertex stages, and compute entry points.

### 9.3 Shader diagnostics

- Compile asynchronously when possible.
- Preserve the last valid compiled program while a new edit contains errors.
- Map WebGPU compilation messages to editor line and column.
- Display errors on the node and in a detailed problems panel.
- Show warnings separately from errors.
- Never replace the main output with an empty frame solely because an in-progress edit is invalid.
- Debounce shader compilation while typing.
- Cache by normalized shader text, entry points, target signature, constants, and binding layout.

### 9.4 Static modules versus runtime modules

Static `.wgsl` imports can use the repository's loader and module resolver. Arbitrary user-authored runtime imports may require a small application-level module resolver that generates a standalone WGSL string before calling `vgpu`.

Do not assume build-time typed imports automatically work for runtime-authored modules.

---

## 10. Graph compilation semantics

### 10.1 Recompilation classes

Classify edits so the minimum necessary work is repeated.

| Change | Required action |
| --- | --- |
| Uniform value | Update existing uniform only |
| Node position, size, selection | Editor update only |
| Preview visibility | Update preview plan only |
| Connection topology | Recompile affected graph region |
| Shader source | Recompile affected shader and downstream resource plan if interfaces changed |
| Output resolution | Recompute resolution propagation and recreate affected targets |
| Texture format | Recompute formats and affected pipelines |
| Compile-time WGSL override | Recompile affected pipeline |
| Feedback size or format | Recreate pair and reset history |

### 10.2 Active sink analysis

The compiler should evaluate only nodes needed by active sinks.

Sinks include:

- Main output viewers
- Visible node previews
- Pinned inspectors
- Export or recording nodes
- Readback nodes
- Feedback history that must advance
- Debug captures

Trace dependencies backward from active sinks. Prune everything else unless a node explicitly declares a side effect.

### 10.3 Branching

If an output feeds several consumers, render it once and reuse its texture or buffer. Do not recompute a node independently per branch.

### 10.4 Resolution propagation

Every texture-producing node declares a policy:

```ts
type ResolutionPolicy =
  | { kind: "inherit"; input: PortId }
  | { kind: "fixed"; width: number; height: number }
  | { kind: "scale"; input: PortId; factor: number }
  | { kind: "project" }
  | { kind: "custom" };
```

Resolution changes belong to compilation or resize handling, not ordinary per-frame parameter updates.

### 10.5 Format propagation

Support at least:

- `rgba8unorm` for ordinary display-oriented content
- `rgba16float` for HDR, feedback, simulation, and intermediate precision
- Depth formats for geometry paths

Start with explicit node or project format choices. Add inference only where deterministic and visible to the user.

---

## 11. Feedback and temporal edges

### 11.1 Rule

An ordinary cycle is an error. A cycle is valid only if every cycle path crosses an explicit temporal boundary such as Feedback or Frame Delay.

### 11.2 Compilation model

1. Mark the Feedback node's output edge as previous-frame data.
2. Remove that temporal edge when topologically sorting the current frame.
3. Allocate two stable render targets or buffers.
4. Bind `read` as the previous-frame input.
5. Render the new value into `write`.
6. Swap only after all current-frame consumers have completed encoding.

Use `vgpu.pingPong()` for textures and `vgpu.pingPongStorage()` for buffers.

### 11.3 Reset behavior

Reset feedback history when:

- The user presses Reset
- Resolution changes
- Texture format changes
- The relevant shader interface changes
- The project is loaded without serialized history
- The device is recreated

Provide a clear-color or seed-input option.

### 11.4 Multiple frame delays

The first version needs one-frame feedback only. A later History node can maintain a ring of N textures for longer delays.

---

## 12. Preview architecture

### 12.1 Required behavior

Any texture-producing node can show:

- An inline live thumbnail
- A large inspection view
- Individual RGBA channels
- Alpha over checkerboard
- HDR exposure controls
- False color
- Pixel coordinate and sampled value under the cursor
- Resolution, format, and GPU timing

### 12.2 Do not use one canvas per node

Avoid a separate WebGPU canvas context for every node. It creates lifecycle complexity and can make graph scrolling expensive.

Preferred implementation:

1. Use a single GPU preview atlas or shared preview canvas.
2. Allocate atlas tiles only for visible or pinned previews.
3. Render each inspected output through a small preview effect into its tile.
4. Place lightweight DOM node chrome over or around the corresponding visual area.
5. Update tile coordinates when the graph viewport changes.
6. Use reduced preview resolution, commonly 128 to 256 pixels on the long edge.
7. Allow preview refresh rates below the main output frame rate.
8. Suspend previews for off-screen, collapsed, or occluded nodes.

An acceptable proof-of-concept fallback is one small canvas per visible preview, but the architecture should not depend on it.

### 12.3 No routine GPU readback

Live previews must remain GPU-to-GPU. Use readback only for explicit export, pixel inspection, screenshots, tests, or debugging.

### 12.4 Debug preview shaders

Implement reusable preview effects for:

- Normal color display
- Single-channel grayscale
- Alpha visualization
- HDR exposure and tonemapping
- Depth linearization
- Vector-field direction and magnitude
- NaN and infinity highlighting
- Signed-value visualization

---

## 13. Frame execution

The runtime should use one explicit `vgpu.frame()` or `frameLoop()` execution per display frame.

Conceptual structure:

```ts
frameLoop(gpu, (frame) => {
  updateSharedUniforms();

  for (const pass of executionPlan.passes) {
    encodePass(frame, pass);
  }

  encodePreviewPasses(frame, executionPlan.previews);
  encodeMainOutput(frame, executionPlan.output);
  swapTemporalResources(executionPlan.temporalResources);
});
```

Important rules:

- Create effects, draws, targets, samplers, and buffers outside the frame loop.
- Update only values that changed.
- Pre-warm pipelines before first visible use.
- Use shared uniform objects for time, frame, pointer, resolution, camera, and global exposure.
- Do not allocate render targets every frame.
- Use stable ping-pong identities.
- Bundle static repeated draws where useful.
- Use instancing instead of per-particle draw calls.
- Use GPU timer spans, not CPU encoding duration, to identify expensive passes.

---

## 14. Resource lifetime and pooling

### 14.1 Logical and physical resources

The compiler should distinguish a logical node output from the physical GPU allocation backing it.

In the proof of concept, one persistent target per materialized texture output is acceptable.

In the optimized runtime, perform liveness analysis:

1. Record the first and last scheduled pass that uses each logical resource.
2. Resources with non-overlapping lifetimes may reuse a physical allocation if size, format, usage, sample count, and depth requirements match.
3. Never alias resources that are pinned for previews, used by feedback, exposed for readback, or required after frame completion.

### 14.2 Target pool key

```ts
interface TargetPoolKey {
  width: number;
  height: number;
  format: GPUTextureFormat;
  sampleCount: 1 | 4;
  depthFormat?: GPUTextureFormat;
  colorAttachmentCount: number;
}
```

### 14.3 Resource budgets

Track estimated GPU memory and display it in diagnostics. Allow project-level limits for preview resolution, maximum intermediate resolution, and HDR usage.

---

## 15. Pass fusion strategy

Do not implement general pass fusion in the proof of concept.

Initially, compile each visual processing node into an explicit pass. This maximizes observability, simplifies intermediate previews, and makes error isolation predictable.

Later, fuse compatible adjacent operations when all conditions hold:

- One consumer
- No active preview on the intermediate result
- No feedback or temporal boundary
- No compute boundary
- Compatible texture formats and resolution
- No blend or multi-render-target boundary
- Both nodes expose fusible pure fragment functions

Provide two modes:

- **Debug mode:** explicit passes and maximum observability
- **Performance mode:** approved pass fusion and resource aliasing

The compiler must be able to explain which nodes were fused and why another boundary was retained.

---

## 16. Media, color, and timing

### 16.1 Video input

Start with ordinary browser video elements and supported external texture or upload paths. Hide the implementation behind a media-source abstraction.

Expect browser and device-specific differences. Do not promise zero-copy video in all configurations.

### 16.2 Color management

Define color semantics early.

Minimum policy:

- Project working space is linear RGB.
- Decode display-oriented images and video to the working representation.
- Effects operate in linear space unless explicitly documented otherwise.
- Convert and tone-map at display output.
- Label data textures so they bypass color conversion.

Do not let nodes silently mix encoded sRGB values and linear values.

### 16.3 Clock

Expose a shared clock containing:

- Time in seconds
- Delta time
- Frame index
- Playback state
- Optional fixed-step simulation tick

GPU simulations should support a fixed-step mode with a capped number of catch-up iterations.

### 16.4 Future timeline and offline-render compatibility

The initial app is live and real-time, but the runtime must not permanently couple graph evaluation to `requestAnimationFrame` or wall-clock time.

Define a transport-independent frame input:

```ts
interface FrameEvaluationInput {
  timeSeconds: number;
  deltaSeconds: number;
  frameIndex: number;
  mode: "realtime" | "fixed-step" | "offline";
  randomSeed: number;
}
```

The live scheduler supplies these values from the browser clock. A future timeline supplies them from playhead state. A future offline renderer supplies exact frame numbers and fixed time steps.

`vgpu` already contributes important offline-render foundations:

- The same rendering API can run in the browser and headless Node through Dawn.
- Frames and passes are explicit.
- Offscreen targets can be rendered and read back.
- A software renderer can provide a display-free fallback.
- Deterministic mocks support command-level testing.

The application must still provide:

- Timeline, clips, tracks, keyframes, and interpolation
- Deterministic transport and frame stepping
- Rules for feedback and stateful simulations when seeking
- Seeded randomness
- Media decoding synchronized to exact output frames
- Render queues, cancellation, progress, and retry
- Frame-sequence or video encoding
- Color-management and output-format policy
- Asset packaging and render-worker distribution

Design requirements now:

- Every time-dependent node consumes explicit frame input rather than reading wall-clock time directly.
- Random generators accept a project or node seed.
- Stateful nodes declare whether they support reset, deterministic replay, checkpoints, and random access.
- The execution plan can render to an offscreen target without a visible surface.
- Main output readback is isolated behind an export interface.
- Browser live rendering and future Node offline rendering use the same domain graph and compiler wherever possible.

Do not build the timeline or encoder in the core milestone. Preserve the seam.

---

## 17. Editor UX requirements

### 17.1 Graph interactions

- Searchable add-node menu
- Drag from a port and search for compatible nodes
- Type-compatible connection highlighting
- Box selection
- Multi-node movement
- Copy, paste, duplicate, delete
- Undo and redo for every semantic edit
- Groups, frames, comments, and colors
- Collapse and expand nodes
- Bypass and mute
- Solo preview
- Auto-layout as an optional command
- Keyboard-first commands

### 17.2 Node visual language

- Input ports on the left and outputs on the right
- Consistent port colors by family
- Compact title bar with status, timing, preview, bypass, and error indicators
- Optional preview region
- Important controls embedded in the node
- Complete controls in a side inspector
- Clear states for compiling, valid, warning, error, bypassed, and device-lost

### 17.3 Performance isolation

Do not push per-frame preview pixels, time values, or GPU metrics through the entire React node tree.

- Memoize node components.
- Subscribe nodes only to their own UI and parameter state.
- Keep animation-frame data outside canonical document state.
- Update metrics at a human-readable rate such as 4 to 10 Hz.
- Virtualize or suspend expensive controls where practical.

---

## 18. Error handling and recovery

Errors should be represented as structured diagnostics:

```ts
interface RuntimeDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  nodeId?: NodeId;
  portId?: PortId;
  source?: { file?: string; line?: number; column?: number };
  suggestion?: string;
}
```

Required cases:

- Unsupported WebGPU
- Adapter unavailable
- Missing optional feature
- Device lost
- Invalid port connection
- Illegal graph cycle
- Missing node definition
- Node-definition version mismatch
- Shader compilation failure
- Binding mismatch
- Resource limit exceeded
- Unsupported texture format
- Out-of-memory or allocation failure
- Media permission denied
- Asset missing

On shader or graph recompilation failure, retain the last valid execution plan where safe. Show that the displayed output is stale.

On device loss, stop frame submission, report the reason, recreate the backend when possible, rebuild resources from the domain graph, and reset temporal history.

---

## 19. Persistence, migrations, and undo

### 19.1 Project format

- Store a top-level schema version.
- Store a version for every node definition instance.
- Use deterministic JSON serialization where practical.
- Store asset references separately from binary asset contents.
- Do not serialize caches or runtime state.

### 19.2 Migrations

Migrations must be explicit, ordered, and tested. A node definition owns migrations for its own parameter or port changes. The project loader owns document-wide schema migrations.

Never silently discard unknown nodes. Preserve their serialized data and display them as unresolved placeholders.

### 19.3 Undo and redo

Use semantic commands or document patches. Do not include runtime recompilation state in history.

Coalesce continuous slider drags into one undoable action while still applying live intermediate values.

---

## 20. Testing strategy

### 20.1 Unit tests

- Port compatibility
- Cycle and temporal-edge validation
- Topological ordering
- Active-sink pruning
- Resolution propagation
- Format propagation
- Resource liveness
- Project migrations
- Parameter coercion and validation

### 20.2 Runtime tests

Use `vgpu/mock` for deterministic command-level tests where appropriate.

Use Dawn-backed headless Node rendering for:

- Shader compilation
- Reference render snapshots
- Readback validation
- Feedback progression
- Compute behavior
- Resource recreation

### 20.3 Browser integration tests

- Graph editing and connection gestures
- Undo and redo
- Parameter interaction
- Shader error recovery
- Preview activation and suspension
- Save and reload
- Device capability fallback

### 20.4 Visual regression tests

Maintain a small set of canonical graphs:

- Gradient and levels
- Transform and composite
- Blur chain
- Feedback trails
- Reaction-diffusion
- Particle simulation
- HDR bloom
- Basic lit geometry

Compare output with tolerances appropriate for cross-GPU floating-point variation.

---

## 21. Performance targets

Initial desktop targets:

- Main output: 1920 × 1080 at 60 FPS for representative moderate graphs
- Editor: responsive pan and zoom with at least 200 visible lightweight nodes
- Parameter latency: visible response within the next animation frame
- Shader editing: keep last valid output while compiling
- Preview resolution: configurable, default around 192 pixels on the long edge
- Preview refresh: configurable, default 15 to 30 FPS
- No routine CPU readback during normal playback
- No per-frame render-target allocation

Treat these as engineering targets, not universal promises. Actual performance depends on GPU, browser, formats, shader complexity, resolution, and active previews.

---

## 22. Capability tiers

At initialization, inspect adapter features and limits and produce a capability report.

Suggested tiers:

### Tier A: Core compositor

- Fullscreen render passes
- Standard sampled textures
- `rgba8unorm`
- Basic video or image input
- Layering and simple feedback

### Tier B: HDR and simulation

- `rgba16float` rendering and sampling as required
- Storage buffers and compute
- Higher resource limits
- Timestamp queries where available

### Tier C: Advanced rendering

- Indirect drawing
- Larger storage requirements
- Optional WebGPU features used by advanced nodes
- More demanding particle and geometry systems

Nodes with unmet capability requirements should be visibly disabled with a clear explanation.

---

## 23. Security and user-authored code

WGSL executes under WebGPU validation but can still consume substantial GPU time or memory.

Implement:

- Resolution limits
- Dispatch-size limits
- Buffer-size limits
- Project memory budgets
- A way to pause rendering before opening an untrusted graph
- Safe-mode loading with custom shaders disabled
- Compile and runtime diagnostics
- Recovery from device loss or validation failure

Do not evaluate arbitrary JavaScript from node packages in the browser as the primary extension mechanism. Prefer declarative manifests plus WGSL and narrowly scoped implementation APIs.

---

## 24. Implementation phases

### Phase 0: Technical spike, 1 to 2 weeks

Deliver:

- React Flow graph with three custom node types
- One `vgpu` context and one output surface
- Solid generator, custom WGSL effect, and output node
- Offscreen target between nodes
- Uniform slider updates without shader recompilation
- One inline preview
- Basic shader diagnostics

Exit criteria:

- Changing a uniform updates the output live.
- Editing valid WGSL recompiles the effect.
- Invalid WGSL keeps the last valid output and shows an error.

### Phase 1: Graph renderer proof of concept, 3 to 6 weeks

Deliver:

- Canonical domain graph
- Typed ports
- Compiler with topological sort and active-sink pruning
- Resolution propagation
- Branching
- Feedback with ping-pong targets
- Shared preview mechanism
- Save and load versioned JSON
- Undo and redo
- Ten to fifteen core visual nodes
- Main GPU timing display
- Semantic command bus shared by UI and automation
- Read-only agent inspection tools
- Agent graph-patch tool with validation and undo grouping

Exit criteria:

- A feedback graph can run for ten minutes without accumulating GPU resources.
- One output can feed multiple consumers without duplicate execution.
- Any visible branch can show a live preview without readback.

### Phase 2: Credible compositor, 2 to 4 months

Deliver:

- Thirty to fifty reliable nodes
- Inspector and refined parameter system
- Image and video assets
- Color-management policy
- Multiple feedback and simulation examples
- Per-pass GPU timing
- Preview atlas and visibility scheduling
- Robust device-loss handling
- Headless reference rendering tests
- Project migrations
- Export or snapshot workflow
- Progressive WebMCP adapter where supported
- Conventional MCP server adapter for external clients
- Reusable subgraph components with exposed ports and parameters
- Local image and video media nodes with portable asset references

Exit criteria:

- Representative 1080p compositions meet performance targets on the chosen baseline hardware.
- Graphs reopen deterministically across application versions covered by migrations.
- Shader, connection, and capability errors are actionable.

### Phase 3: Advanced visual engine, 4 to 12 additional months

Possible deliverables:

- Compute-particle framework
- Basic geometry graph
- Cameras and materials
- Depth-aware effects
- Multi-render targets
- Timeline, automation, and curves
- MIDI and OSC input
- Subgraphs and exposed parameters
- Presets
- Resource pooling and approved pass fusion
- Recording and higher-quality export

### Phase 4: Ecosystem direction

Possible long-term work:

- Extension SDK
- Trusted node packages
- Shared node libraries
- Collaboration
- Desktop wrapper for broader media and hardware integration
- Native helper process for NDI, Spout, Syphon, codecs, and capture devices

---

## 25. Initial repository structure

```text
src/
  app/
  editor/
    graph-canvas/
    nodes/
    edges/
    inspector/
    commands/
  domain/
    graph/
    project/
    parameters/
    migrations/
  compiler/
    validation/
    scheduling/
    resolution/
    formats/
    resources/
    diagnostics/
  runtime/
    backend/
      vgpu/
    execution/
    previews/
    media/
    telemetry/
  nodes/
    definitions/
    shaders/
    registry/
  ui/
  tests/
```

Keep built-in node definitions outside editor components. A node should be executable in headless tests without React Flow.

---

## 26. First implementation backlog

### Foundation

- Create the React, TypeScript, and Vite application.
- Add React Flow and a minimal custom visual theme.
- Initialize one `vgpu` device and surface.
- Create the internal backend adapter.
- Add capability and device-loss reporting.

### Domain model

- Define project, graph, node, edge, port, and parameter schemas.
- Add validation and schema versioning.
- Implement graph commands and undo or redo.
- Implement the node registry.

### Compiler

- Resolve node definitions.
- Validate connections.
- Detect cycles.
- Extract feedback temporal edges.
- Topologically order passes.
- Trace dependencies from active sinks.
- Propagate resolution.
- Create persistent logical targets.
- Emit structured diagnostics.

### Runtime

- Compile effects from WGSL strings.
- Update uniforms in place.
- Encode multiple passes in one frame.
- Support branching reuse.
- Implement ping-pong feedback.
- Pre-warm pipelines.
- Add time and pointer shared uniforms.
- Add GPU timer spans.

### Preview system

- Implement one debug preview effect.
- Preview selected output in the main inspector.
- Add inline preview tiles.
- Schedule only visible previews.
- Add channel and alpha views.

### Authoring

- Add the shader editor.
- Surface line and column diagnostics.
- Preserve the last valid program.
- Add manifest-driven parameter controls.
- Support draggable numeric values, reset, ranges, units, and color.

### Persistence and tests

- Save and load project JSON.
- Add migration scaffolding.
- Add compiler unit tests.
- Add a Dawn-backed render snapshot.
- Add one browser editing test.

---

## 27. Proof-of-concept acceptance test

Build and save a sample graph with this shape:

```text
Noise ──→ Displace ──→ Levels ──→ Composite ──→ Output
  │          ↑                         ↑
  │          └──── Feedback ←──────────┘
  └────────→ Colorize ─────────────────┘
```

The graph must demonstrate:

- Fan-out from Noise
- Two branches evaluated once where shared
- An explicit one-frame feedback boundary
- A multi-input composite
- Live previews on Noise, Colorize, Feedback, and Composite
- Uniform parameter updates without graph recompilation
- A custom WGSL edit on one node
- A visible shader error followed by recovery
- Per-pass timing
- Save and reload
- Stable GPU resource counts over prolonged playback

---

## 28. Key engineering rules

1. The domain graph is the source of truth. React Flow is a view and interaction layer.
2. React components never encode GPU commands.
3. Current-frame execution is a DAG. Temporal cycles require explicit temporal nodes.
4. Every branch output is reusable. Never recompute it per consumer.
5. Live previews remain GPU-to-GPU.
6. Allocate long-lived resources outside the frame loop.
7. Uniform updates do not trigger graph recompilation.
8. Preserve the last valid plan during recoverable editing errors.
9. Start with explicit passes. Add fusion only after profiling proves the need.
10. Keep `vgpu` behind an internal backend boundary.
11. Every serialized structure is versioned and migratable.
12. A built-in node must be testable without the visual editor.
13. Optional GPU features must be discovered, never assumed.
14. GPU timing, resource counts, and active preview costs must be observable.
15. Browser-native limitations must be expressed honestly in the product.

---

## 29. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `vgpu` API churn | Isolate behind the backend adapter and pin exact versions |
| Too many intermediate textures | Active-sink pruning, preview throttling, memory reporting, then lifetime-based pooling |
| Too many preview canvases | Shared preview atlas or shared canvas |
| React rerender cost | Selective state subscriptions, memoized nodes, and runtime data outside document state |
| Shader editing hitches | Debounce, async compile, cache pipelines, retain last valid program |
| Feedback bugs | Explicit temporal model, stable ping-pong resources, deterministic tests |
| Browser differences | Capability tiers, feature checks, baseline browser policy, reference tests |
| GPU device loss | Structured recovery and full resource reconstruction from the graph |
| Unbounded custom shaders | Safe mode, resource caps, pause-before-load, recovery paths |
| Scope explosion toward full TouchDesigner | Maintain the TOP-style compositor boundary through Phase 2 |

---

## 30. Agent-first architecture

Agent control is a product capability, not a UI automation trick. Agents must interact with the same validated domain commands used by human actions.

### 30.1 One semantic command bus

Create an application-level command bus before exposing WebMCP or MCP.

```ts
interface AppCommandBus {
  query<TName extends QueryName>(
    name: TName,
    input: QueryInput<TName>,
    context: InvocationContext,
  ): Promise<QueryOutput<TName>>;

  execute<TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
    context: InvocationContext,
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

All of these should call the same command bus:

- Toolbar and menu actions
- Keyboard commands
- Inspector edits
- Drag-and-connect operations
- WebMCP tools in the active browser tab
- A conventional MCP server
- Future collaboration messages
- Tests and scripted examples

No agent adapter may mutate Zustand, React Flow arrays, or GPU resources directly.

### 30.2 Three adapters

| Adapter | Purpose | Status |
| --- | --- | --- |
| Human UI | Direct manipulation and inspector controls | Required |
| WebMCP | Let an in-browser agent drive the live authenticated app session | Progressive enhancement |
| MCP server | Let external agent hosts inspect and edit projects through standard MCP tools and resources | Stable integration path |

WebMCP is a proposed browser standard for exposing structured page tools through declarative HTML or imperative JavaScript APIs. It is a natural fit for operating the live app with its current session and page state, but it must not be the only agent interface while browser availability and the specification are still evolving.

The WebMCP adapter should register tools only when the browser API is present. Its absence must have no effect on ordinary app operation.

### 30.3 Agent tool design

Prefer a small, composable, versioned tool surface. Avoid exposing hundreds of UI-shaped tools.

Read-only tools:

- `get_project_summary`
- `get_graph`
- `get_selection`
- `list_node_definitions`
- `get_node_definition`
- `get_node`
- `get_diagnostics`
- `get_runtime_metrics`
- `get_asset_catalog`
- `render_preview`
- `inspect_output_pixel`

Mutation tools:

- `apply_graph_patch`
- `add_node`
- `remove_nodes`
- `connect_ports`
- `disconnect_ports`
- `set_parameters`
- `set_shader_source`
- `create_component`
- `instantiate_component`
- `expose_component_port`
- `expose_component_parameter`
- `set_output`
- `reset_feedback`
- `undo`
- `redo`

Workflow tools:

- `validate_project`
- `compile_project`
- `play`
- `pause`
- `seek`
- `save_project`
- `export_snapshot`
- `package_component`

The most important mutation tool is `apply_graph_patch`. It should apply an ordered batch atomically and return structured results.

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

Use client-generated temporary IDs inside a patch and return their stable resolved IDs. This allows an agent to add several nodes and connect them in one atomic request.

### 30.4 Agent resources and observations

A conventional MCP server should expose resources in addition to tools.

Suggested resource URIs:

- `graph://project/current`
- `graph://project/current/selection`
- `graph://project/current/diagnostics`
- `graph://project/current/metrics`
- `graph://node-definitions/index`
- `graph://node-definitions/{type}`
- `graph://components/index`
- `graph://assets/index`
- `graph://renders/{outputId}`

Return compact structured summaries by default. Let agents request detailed node parameters, shader text, or images explicitly. Do not resend the entire graph after every mutation.

`render_preview` should be able to return a PNG or other supported image representation of any texture output at a bounded size. This gives a multimodal agent a direct visual verification loop:

1. Inspect graph.
2. Apply patch.
3. Validate and compile.
4. Render selected outputs.
5. Examine previews and diagnostics.
6. Refine the graph.

### 30.5 Agent transactions, plans, and safety

- Every mutation identifies its actor.
- Every mutation produces an audit entry.
- Batch operations are atomic.
- Mutations accept a base revision and reject or rebase stale work explicitly.
- Destructive tools support `dryRun`.
- A graph patch becomes one undo group unless explicitly split.
- Asset access, network access, export, recording, and project deletion require separate capability grants.
- Agents cannot acquire permissions merely by calling a tool.
- Tool results are structured data, never instructions to the calling model.
- Third-party node descriptions and project text must be treated as untrusted content.
- Long-running renders and simulations require cancellation.

For consequential operations, return a proposed plan or preview before requesting human confirmation. Routine reversible graph edits can use ordinary undo rather than confirmation after every step.

### 30.6 Agent-authored nodes

Agents should be able to create a custom shader node without writing arbitrary application JavaScript.

An agent-authored node package may contain:

- Versioned node manifest
- WGSL source
- Parameter schema
- Port schema
- Preview metadata
- Capability requirements
- Test graph or fixture
- Optional documentation

Validate the package, compile its WGSL, run bounded reference tests, and show requested permissions before installation.

---

## 31. Reusable subgraphs and components

Reusable components are essential. They are the visual equivalent of functions, modules, and TouchDesigner components.

### 31.1 Component definition

A component packages an internal graph behind a stable external interface.

```ts
interface GraphComponentDefinition {
  componentId: string;
  version: number;
  name: string;
  description?: string;
  graph: GraphDocument;
  inputs: ExposedComponentPort[];
  outputs: ExposedComponentPort[];
  parameters: ExposedComponentParameter[];
  capabilities?: CapabilityRequirement[];
  preview?: ComponentPreviewDefinition;
  migrations?: ComponentMigration[];
}
```

Each component instance stores the component identity, version, instance-level parameter values, and optional overrides. It does not duplicate the complete internal graph unless it is detached.

### 31.2 Required component behavior

- Enter a component to edit its internal graph.
- Show breadcrumbs for nested editing.
- Expose selected internal inputs and outputs as external ports.
- Expose selected internal parameters with new names, ranges, defaults, and grouping.
- Nest components.
- Save a selection as a component.
- Duplicate as a linked instance or detached copy.
- Upgrade linked instances to a newer component version through an explicit migration.
- Package components with shaders, manifests, small assets, examples, and tests.
- Preview a component without opening it.

### 31.3 Compilation model

Initially flatten component instances into the parent logical graph during compilation while preserving source paths for diagnostics and profiling.

Example diagnostic path:

```text
MainGraph / DreamyFeedback_2 / Blur_1 / shader.wgsl:42
```

Recursion is forbidden initially. Detect direct and indirect recursive component references when saving or loading.

### 31.4 Component examples

Ship these early:

- `FeedbackEcho`: transform, fade, blur, and composite around a temporal boundary
- `Bloom`: threshold, downsample, separable blur, and add
- `DisplacementStack`: noise, directional scaling, displacement, and edge behavior
- `MediaGrade`: exposure, contrast, saturation, lift, gamma, and gain
- `Kaleidoscope`: polar conversion, repeat, mirror, and rotation
- `ParticleTrails`: particle render plus temporal accumulation
- `Render3DWithPost`: scene render, depth-aware fog, bloom, and tone mapping

---

## 32. 3D geometry and scene handling

3D should be a related graph domain with explicit types. Do not disguise geometry, materials, cameras, or scenes as textures.

### 32.1 3D port types

Extend the type system with:

```ts
type GeometryPort = {
  kind: "geometry";
  topology: "triangle-list" | "triangle-strip" | "line-list" | "point-list";
  attributes: GeometryAttributeSchema[];
};

type ScenePort = { kind: "scene" };
type MaterialPort = { kind: "material"; model: "unlit" | "pbr" | "custom" };
type CameraPort = { kind: "camera" };
type LightPort = { kind: "light" };
type TransformPort = { kind: "transform3d" };
```

### 32.2 Geometry representation

A geometry value should describe GPU resources and metadata:

```ts
interface GeometryValue {
  topology: GPUPrimitiveTopology;
  attributes: Record<string, GeometryAttributeBuffer>;
  index?: GeometryIndexBuffer;
  vertexCount: number;
  indexCount?: number;
  instanceCount?: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  revision: number;
}
```

Start with GPU-ready immutable or infrequently rebuilt geometry. CPU-heavy mesh editing should run outside the render loop, preferably in a worker. GPU deformation and simulation should use compute or vertex shaders without CPU readback.

### 32.3 Initial 3D nodes

Geometry:

- Plane
- Box
- UV sphere
- Grid
- glTF mesh loader
- Transform geometry
- Compute deformation
- Normals generation, if needed
- Instancer

Scene:

- Scene or merge
- Object
- Camera
- Orbit camera controller
- Directional light
- Point light
- Environment light
- Unlit material
- Basic PBR material
- Custom WGSL material

Rendering:

- Render 3D
- Shadow map, later
- Depth output
- Normal output
- Object ID output
- Motion-vector output, later

### 32.4 Render outputs

`Render3D` should produce a structured set of texture outputs rather than only one color texture:

- Color
- Depth
- Normals, optional
- Object ID, optional
- Motion vectors, optional later

These outputs then enter the ordinary texture compositor. This is the clean boundary between 3D scene construction and TOP-style post-processing.

### 32.5 Material and geometry scope control

Do not begin with a Blender-style general mesh editor. The initial goal is procedural primitives, loaded assets, transforms, instancing, GPU deformation, materials, cameras, lights, and rendering into the texture graph.

---

## 33. Media and asset pipeline

Local image and video workflows must be first-class because they are core to visual experimentation.

### 33.1 Asset registry

Media nodes should reference an asset registry entry, not a raw local path or DOM object.

```ts
interface AssetReference {
  assetId: string;
  kind: "image" | "video" | "audio" | "gltf" | "binary";
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  source:
    | { kind: "project"; relativePath: string }
    | { kind: "fileHandle"; handleId: string }
    | { kind: "objectUrl"; sessionId: string }
    | { kind: "remote"; url: string; integrity?: string };
  metadata?: Record<string, unknown>;
}
```

Project serialization must not pretend that an ephemeral object URL or local filesystem path is portable. On reopening, unresolved assets should retain their identity and offer a relink flow.

### 33.2 Image Loader node

Required controls and outputs:

- Choose or drop a local file
- Relink asset
- Respect or override orientation
- Color-space interpretation
- Alpha interpretation
- Filter and wrap modes
- Native dimensions
- Texture output
- Loading, ready, missing, and error states

Decode with browser-native image facilities such as `createImageBitmap` where appropriate, then upload once unless the asset changes.

### 33.3 Video Loader node

Required controls:

- Choose or drop local video
- Play, pause, seek, loop, playback rate
- In and out points
- Audio enabled or muted
- Frame stepping where supported
- Color interpretation
- Decode status and dropped-frame metrics

Outputs:

- Video texture
- Native resolution
- Current time
- Duration
- Frame-ready event
- Optional audio-analysis features

Keep decoding behind an abstraction. Begin with an `HTMLVideoElement` path. Add WebCodecs or optimized external-texture paths when they provide measurable benefits and the target browsers support the required behavior.

Advance the graph when a new frame is available rather than uploading the same frame repeatedly. Do not read video pixels back to the CPU during normal playback.

### 33.4 Webcam and live inputs

Add later through the same media-source interface. Permission denial, device changes, stream interruption, and privacy indicators must be explicit.

### 33.5 Project packaging

Support two save modes eventually:

- Lightweight project: references external media and may require relinking.
- Portable project bundle: includes selected assets, component packages, shaders, and the versioned graph.

Agents need explicit permission before reading local files, following remote URLs, embedding assets, or exporting portable bundles.

---

## 34. Collaboration model

Full collaboration can follow the compositor MVP, but the command and document architecture should support it from the start.

### 34.1 Collaboration scope

Collaborative state:

- Graph nodes and edges
- Node positions and groups
- Parameters
- Component definitions
- Shader and expression text
- Comments
- Timeline and automation data

Ephemeral awareness:

- Presence
- Cursor position
- Current selection
- Current graph or component path
- Who is editing a parameter or shader
- Agent activity and proposed changes

Do not synchronize GPU textures, compiled pipelines, live video frames, or per-frame metrics as document state.

### 34.2 Consistency model

Use a CRDT-backed document or an equivalently well-defined operation log. Yjs or Automerge are candidates, but the product-level semantics matter more than the library choice.

Required semantic rules:

- Nodes and edges use globally unique stable IDs.
- Deleting a node removes or tombstones its incident edges deterministically.
- Concurrent parameter edits use an explicit last-writer or per-field rule.
- Continuous drags broadcast ephemeral values and commit a final semantic value.
- Shader text uses collaborative text semantics rather than last-writer replacement.
- Graph patches are atomic transactions.
- Undo is actor-local and does not erase unrelated remote work.
- Asset availability is tracked separately from graph references.

### 34.3 Agents as collaborators

Agents should appear as named actors with presence, status, and audit entries. A user should be able to inspect an agent's patch before applying it, follow its current selection, or revert its transaction as one unit.

Avoid invisible background mutation. The graph should visibly communicate when an agent is planning, editing, compiling, or waiting for approval.

### 34.4 Collaboration server responsibilities

- Authentication and project authorization
- Document synchronization
- Presence
- Revision and operation history
- Asset metadata and upload coordination
- Component version distribution
- Audit trail
- Optional render-worker coordination later

The collaboration service must not become the authoritative renderer. Each client renders from the synchronized graph and its own supported capability tier.

---

## 35. Reference components and showcase projects

The examples are executable specifications. Each should be packaged as a project, used in visual regression tests where practical, and documented with the concepts it proves.

### 35.1 Feedback Echo

Graph:

```text
Media Loader → Composite → Output
                   │
                   ↓
                Feedback → Transform → Blur → Level
                   ↑                            │
                   └────────────────────────────┘
```

Proves:

- Local image or video texture
- Explicit temporal boundary
- Fade and transform inside the loop
- Branch previews
- Feedback reset
- Stable ping-pong resources

### 35.2 Video Displacement Lab

```text
Video Loader ───────────────→ Displace → Grade → Output
Noise → Levels → Transform ──────↑
```

Proves:

- Local video playback and seeking
- Procedural displacement map
- Fan-out and preview of the displacement texture
- Live scalar and vector parameters
- Color handling

### 35.3 Two-Source Media Mixer

```text
Image Loader → Transform ─┐
                          ├→ Composite → Effects Rack → Output
Video Loader → Transform ─┘
```

Proves:

- Multiple local assets
- Independent aspect and transform policies
- Blend modes and masks
- A reusable `Effects Rack` component

### 35.4 Reaction-Diffusion Canvas

Proves compute or iterative render feedback, painting into simulation state, pause, step, reset, seeded state, and HDR visualization.

### 35.5 Particle Trails

Proves storage-buffer ping-pong, compute update, instanced rendering, indirect counts if supported, and temporal trail accumulation.

### 35.6 3D Texture Displacement

```text
Grid Geometry → GPU Deform → Object ─┐
Noise Texture ────────────────↑       ├→ Scene → Render3D → Bloom → Output
Camera + Light + Material ────────────┘
```

Proves geometry ports, texture-driven GPU deformation, material bindings, scene assembly, depth rendering, and 2D post-processing.

### 35.7 Agent-Built Visual

An agent receives a prompt such as:

> Build a monochrome video-feedback tunnel with subtle RGB separation, expose speed and decay, and keep the output below 8 ms GPU time on the current device.

The agent must:

1. Discover compatible node types.
2. Apply one or more graph patches.
3. Add or edit WGSL where necessary.
4. Validate and compile.
5. Render intermediate and final previews.
6. Inspect GPU timings.
7. Adjust the graph.
8. Package the result as a reusable component.

This is the primary acceptance project for agent readiness.

### 35.8 Collaborative Shader Jam

Two humans and one agent edit a project. One user changes media and composition, another edits shader text, and the agent proposes an optimized reusable component. This should eventually test presence, collaborative text, agent identity, atomic patches, and actor-local undo.

---

## 36. Product decisions and remaining clarifications

The implementation can begin before every answer is known, but these decisions materially affect architecture and sequencing.

### 36.1 Deployment target: decided

The initial product is browser-only. Build against browser security, storage, media, file-permission, and WebGPU constraints.

Electron or another desktop wrapper may be explored later. Treat it as an adapter around the browser application, not a reason to introduce native assumptions into the core graph or renderer.

A desktop wrapper becomes strategically useful if native media protocols, unrestricted project folders, broader codec support, capture hardware, multi-window output, or native plugins become priorities.

### 36.2 Baseline browser and hardware

Define:

- First supported browser and minimum version
- Whether mobile is supported, preview-only, or excluded initially
- Minimum GPU capability tier
- Baseline hardware for the 1080p performance target

### 36.3 Project and asset portability

Decide whether the primary save format is:

- A single JSON file plus external assets
- A folder project
- A portable archive
- Cloud-native storage with optional export

This changes local media permissions, relinking, collaboration, and agent access.

### 36.4 Agent authority

Decide which operations are:

- Always allowed when the project is open
- Allowed but undoable without confirmation
- Proposed for review before applying
- Always confirmation-gated
- Never available to third-party agents

At minimum, distinguish graph edits, local-file access, remote network access, asset upload, export, recording, component installation, and project deletion.

### 36.5 Timeline and transport: direction decided

The first serious release is live, continuously running, and optimized for real-time visual creation and performance.

Timeline compositing, keyframes, deterministic seeking, and offline export come later. The core runtime must still accept explicit time, delta, frame index, seed, and execution mode so these features can be added without rewriting node semantics.

The remaining timeline question is when deterministic media seeking and stateful-simulation checkpoints enter the roadmap.

### 36.6 3D scope

Confirm whether Phase 3 means:

- Loaded and procedural geometry rendered into the texture graph
- A full scene hierarchy and material system
- A general procedural modeling system

The first option is strongly recommended.

### 36.7 Collaboration timing: decided

Multiplayer collaboration begins only after the core renderer, graph compiler, document format, editing commands, and component model are stable.

Before then, preserve collaboration-ready foundations: stable IDs, atomic commands, actor metadata, revisions, audit entries, deterministic migrations, and separation between document and runtime state.

Real-time multiplayer will later require CRDT semantics, presence, asset coordination, and actor-aware undo. It remains a dedicated product phase, not a small networking feature.

### 36.8 Extension trust model

Choose whether third-party components may include:

- Declarative graph and WGSL only
- Sandboxed worker code
- Trusted signed JavaScript packages
- Desktop-native plugins

Begin with declarative graph, manifests, and WGSL.

### 36.9 Recording and export: phased direction decided

The architecture must support a progression from live output to timeline compositing and offline rendering.

Recommended order:

1. Screenshot and still-image export.
2. Real-time browser recording where supported.
3. Deterministic frame-sequence rendering.
4. Headless Node render queue using `vgpu/node`.
5. Video encoding, alpha or HDR formats, and distributed rendering according to product need.

The remaining decision is which exact real-time recording format and offline delivery formats the first export milestone promises.

---

## 37. Reference links

- [`vercel-labs/vgpu`](https://github.com/vercel-labs/vgpu)
- [`vgpu` README](https://github.com/vercel-labs/vgpu/blob/main/README.md)
- [`vgpu` effect implementation](https://github.com/vercel-labs/vgpu/blob/main/packages/vgpu-api/src/effect.ts)
- [`vgpu` frame implementation](https://github.com/vercel-labs/vgpu/blob/main/packages/vgpu-api/src/frame.ts)
- [`vgpu` offscreen target implementation](https://github.com/vercel-labs/vgpu/blob/main/packages/vgpu-api/src/target-offscreen.ts)
- [`vgpu` ping-pong implementation](https://github.com/vercel-labs/vgpu/blob/main/packages/vgpu-api/src/ping-pong.ts)
- [`vgpu` performance playbook](https://github.com/vercel-labs/vgpu/blob/main/docs/topics/performance-playbook.docs.md)
- [`vgpu` changelog](https://github.com/vercel-labs/vgpu/blob/main/CHANGELOG.md)
- [React Flow documentation](https://reactflow.dev/)
- [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [React Flow handles](https://reactflow.dev/learn/customization/handles)
- [React Flow performance guidance](https://reactflow.dev/learn/advanced-use/performance)
- [Rete.js documentation](https://retejs.org/docs/)
- [WebGPU API on MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- [WebGPU specification](https://www.w3.org/TR/webgpu/)
- [WebMCP proposal](https://github.com/webmachinelearning/webmcp)
- [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
- [WebMCP and MCP comparison](https://developer.chrome.com/docs/ai/webmcp/compare-mcp)
- [Model Context Protocol architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP resources specification](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)

---

## 38. Instruction to the implementation agent

Begin with Phase 0 and Phase 1 only.

Before implementing optimization features, prove the complete semantic loop:

1. Edit graph.
2. Validate graph.
3. Compile graph.
4. Render multiple passes.
5. Preview arbitrary branches.
6. Update uniforms live.
7. Run explicit feedback.
8. Report useful errors.
9. Save and reload.

Do not begin with pass fusion, an extension marketplace, complex 3D, collaboration, native media bridges, or a large built-in node catalog.

The first architectural checkpoint should include a short decision record for:

- Canonical graph representation
- Runtime versus editor state separation
- Feedback edge semantics
- Resolution and format propagation
- Preview rendering approach
- `vgpu` adapter boundary
- Project schema migration strategy

If a requested feature conflicts with the key engineering rules in Section 28, stop and document the tradeoff before changing the architecture.
