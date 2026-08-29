# POP-Family Plan: GPU Pointsets, Compute, Geometry — 2026-08-29

**Audience:** orchestrator. Purpose: extend SPEC (§C/§I/§V/§T) with the point-operator family and schedule its slices. Companion to `docs/gap-analysis-2026-08-29.md` (its plan-IR compute/buffer unions and `OutputRef`/`readBuffer` contract changes are prerequisites — this doc assumes they land).

**Positioning.** TouchDesigner's POP family (GPU-resident point data + compute operators, feeding instancing and rendering) is what turns a texture compositor into an instrument: particles, sims, instanced geometry, data-driven visuals. It maps almost 1:1 onto WebGPU storage buffers + compute — better than it maps onto anything TD had when SOPs were designed. We are greenfield: no SOP legacy to carry, so we unify what TD splits.

---

## 1. Locked decisions (owner interview, 2026-08-29)

1. **Unified pointset.** One data model for geometry and particles: attribute buffers + count + optional topology/index. Mesh = pointset with topology; particle system = pointset without. Every operator that doesn't need topology works on both. No SOP/POP split.
2. **Arbitrary named attributes from day 1.** Attributes are named + typed; WGSL struct layouts are code-generated from attribute schemas. No fixed built-in struct.
3. **Timing: first slice (P3a) lands late Phase 2**, alongside audio-reactive. Audio-driven particles is the flagship demo. Mesh/glTF/materials remain Phase 3.
4. **Render spine: sprites → instances → mesh.** Each step ships usable.
5. **GPU-driven lifecycle from the start.** Variable point counts: emission, death, compaction, indirect dispatch/draw in the first slice — not fixed pools. (Owner call, see §4.3 for the determinism consequence and its mitigation — this is the one place the choice costs architecture care.)
6. **Neighbor/spatial queries in P3b**, after core sims. Kernel ABI designed so neighbor iteration slots in as a library later.
7. **Inspection: 3D points viewer AND attribute spreadsheet in the first slice.**
8. **Custom per-point WGSL kernel node in the first slice** — the family's escape hatch, same philosophy as CustomWGSL TOP.

---

## 2. Data model: `PointSet`

The compiled-plan value flowing along a `pointset` edge:

```ts
interface PointSetDescriptor {
  attributes: AttributeSchema[];        // ordered, canonical
  capacity: number;                     // allocated slots (buffer sizing)
  countSource: "fixed" | "gpu";         // gpu → count lives in a GPU counter buffer
  topology?: {
    kind: "points" | "lines" | "line-strip" | "triangles";
    index?: { format: "uint32"; count: number };
  };
  bounds?: { min: [number,number,number]; max: [number,number,number] }; // optional, coarse
}

interface AttributeSchema {
  name: string;                         // "position", "velocity", "myCustomThing"
  type: "f32" | "vec2f" | "vec3f" | "vec4f" | "u32" | "vec4u";
  semantic?: "position" | "color" | "size" | "id" | "life";  // well-known hints for renderers/viewers
  default: number[];                    // value for newly emitted points
}
```

Rules:

- **Storage: structure-of-arrays.** One storage buffer per attribute (or per small attribute group), not one interleaved struct buffer. Reasons: WGSL struct layout/alignment pain disappears; operators touching 2 of 9 attributes bind 2 buffers; attribute add/remove doesn't relayout everything; ping-pong per-attribute only where an op writes it. The code-generated `Point` struct in kernels is assembled from per-buffer loads by the codegen, invisible to the user.
- **Well-known names, not required names.** `position: vec3f` is conventional (generators emit it, renderers require it via port constraints) but nothing hardcodes it. `semantic` hints let the viewer/renderer auto-pick without magic strings scattered in kernels.
- **Count.** `countSource: "gpu"` means alive-count lives in a small GPU buffer (written by emission/compaction, consumed by indirect dispatch/draw). `fixed` for pure geometry (grid of 40k points has no lifecycle). UI count readout comes from a throttled ≤10Hz readback of the counter — the one legal steady readback, routed through the export/inspect interface (V48) and never in the render path.
- **Port typing.** New port kind: `{ kind: "pointset"; requires: AttributeRequirement[] }` where a requirement = name/semantic + exact type + optional. Compat (V13 spirit): every required attribute present with exact type → connectable; extra attributes always flow through untouched. Mismatch names the missing/mistyped attribute in the diagnostic. Note: the SPEC §I port union and code (`schemas.ts`) already drifted (gap doc D16) — fix both in one amendment, adding `pointset`, and decide whether the declared-but-unimplemented `geometry` kind is *replaced* by `pointset` (recommended: yes — unified model makes a separate geometry kind redundant; keep `camera`, add `material` later).

---

## 3. Execution model

### 3.1 Passes

POP nodes compile to compute passes over the pointset, using the plan-IR pass union from the gap doc. Additional pass/resource kinds needed:

- pass: `{ kind: "compute" }` (already reserved), plus `dispatch: { source: "fixed", workgroups } | { source: "indirect", counterRef }`.
- pass: `{ kind: "draw" }` — sprites/instances/mesh rendering, `drawSource: "fixed" | "indirect"`.
- resource: `buffer` (already reserved) with `pingPong` variant (vgpu `pingPongStorage` exists), plus small `counter`/`indirect-args` buffers.

Per-node dispatch first (one node = one or more compute passes) — same explicit-pass philosophy as the texture graph, same observability rationale. **Kernel fusion (chaining per-point ops into one dispatch) is the later perf mode**, symmetric with pass fusion in handoff §15, and the biggest known perf lever — the kernel ABI below is designed so fusion is a codegen change, not a node rewrite.

### 3.2 Kernel ABI (built-ins and custom share it)

Every per-point operator is authored as a pure function; the codegen wraps it:

```wgsl
// author writes (custom kernel node = exactly this surface):
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.velocity += vec3f(0.0, -9.8, 0.0) * ctx.frame.deltaSeconds;
  return q;
}
// codegen provides: struct Point {…from attribute schema…}
// struct PointCtx { frame: FrameUniforms, index: u32, count: u32, rand: … }
// + the dispatch wrapper: load attributes → process → store attributes
```

- `Point` struct generated from the *resolved* attribute schema of the input edge; the node declares which attributes it reads/writes → only those buffers bound, only written ones ping-ponged.
- `ctx.rand`: seeded per-point RNG = `hash(projectSeed, nodeSeed, pointId, frameIndex)` — V45 holds per point. `pointId` is a persistent u32 attribute assigned at emission, NOT the slot index (slots move under compaction).
- No raw buffer access in the v1 custom-kernel contract (neighbors later add a read-only neighborhood iterator to `ctx` — that is the P3b extension point, reserved now in the ABI's design, absent from its surface).
- ABI is versioned in the node manifest, like the WGSL TOP contract.

### 3.3 GPU-driven lifecycle — determinism ruling

Owner chose GPU-driven counts from the start. The naive implementation (atomicAdd to claim slots) makes slot assignment depend on GPU thread scheduling → same seed + frame produces different buffers → V45/V46 replay broken and headless parity tests (T69) become flaky. **Ruling: lifecycle uses scan-based (prefix-sum) compaction and rank-based emission, not atomic-append.**

- Death: kernel writes alive flag → prefix-sum over flags → scatter survivors to compacted slots. Deterministic (scan order is data order).
- Emission: emitter computes this-frame emission count deterministically (rate × dt + seeded jitter, accumulated remainder), new points written at `aliveCount + rank`. Deterministic.
- Cost: 2–3 extra small passes per lifecycle system per frame. Acceptable; scan utilities are also the P3b neighbor-grid prerequisite, so the work is reused.
- New invariant proposal: *point identity = persistent `pointId` attribute; slot index is never identity (echoes the doc-wide "no array index as identity" rule at the GPU level). Lifecycle passes are deterministic — no atomic whose ordering affects output values. A node that cannot meet this declares `deterministicReplay: false` in its manifest (V46) and the compiler surfaces it on the node.*

### 3.4 Sim state & feedback

Stateful sims (integrate, springs) = buffer ping-pong, same V22 semantics: stable pair, swap after all current-frame consumers, reset triggers identical (resolution→capacity change, format→schema change, user reset, device loss). Checkpoint/reset declarations per V46 apply unchanged. `FrameEvaluationInput` is the only time source (V44 lint already covers `src/nodes/**`).

---

## 4. Rendering bridge (the spine)

1. **RenderPoints (P3a):** billboarded sprites — size/color/rotation from attributes (semantic-picked, overridable), circular/soft/textured sprite modes (sprite texture = `texture2d` input: first TOP→POP render bridge), additive/alpha blend, depth-sorted option (uses the scan machinery). Output: `texture2d` (color; depth optional secondary output — `OutputRef` port-scoping from gap doc pays off immediately). Camera input.
2. **RenderInstances (P3b):** one primitive/mesh drawn per point via instancing — transform from position/rotation/scale attributes, per-instance color; TD's killer instancing workflow. Indirect draw count from the alive counter.
3. **RenderMesh + Render3D (P3c):** topology'd pointsets, glTF loader, unlit → PBR materials, lights, MRT outputs (color/depth/normals/objectId as separate output ports) feeding the TOP graph — handoff §32.4's boundary, unchanged.

**Camera:** `camera` port kind becomes real in P3a: Camera node (perspective/ortho params) + OrbitCamera controller node (pointer-driven via existing pointer input, NOT DOM events). Renderers require a camera input; viewer supplies a built-in default camera when unconnected.

## 5. TOP↔POP bridges (what makes it one instrument, not two apps)

- **TextureToAttribute (P3a):** sample a texture at each point's UV/position → write attribute. Noise TOP driving particle velocity = day-one workflow.
- **AttributeToTexture / splat (P3b):** scatter/accumulate points into a texture (density, trails via feedback).
- **Audio → sim params (P3a, free):** resolver seam from the gap doc; audio features modulate emission rate, forces, sprite size. This pairing is the flagship demo.
- **Pointer → attractor (P3a):** existing shared pointer uniform as a force input.

## 6. Inspection (both in first slice, per decision)

- **Points viewer:** the existing large-viewer pane grows a 3D mode — orbit default camera, attribute-as-color mapping dropdown, point-size control, bounds/axes overlay. GPU→GPU (V7): it is just RenderPoints with a debug palette, scheduled like any preview (V28).
- **Attribute spreadsheet:** windowed readback (N rows around a scroll position, not the whole buffer), ≤10Hz, behind the export/inspect interface (V48), sortable, "follow point" by `pointId`. Dock tab next to problems/performance. Also: alive-count + capacity + per-system memory in the performance tab (V24's budget reporting extends to buffers).
- **Agent surface:** `render_preview` already covers the viewer output; add `read_points` (windowed attribute readback, same bounds as the spreadsheet) to the deferred-tools list — agents debugging sims need numbers, not just pixels.

## 7. Node catalog

**P3a (first slice):** PointGrid, Line, Circle, ScatterInVolume · Emitter (rate/burst, spawn attribute defaults) · SetAttribute, AttributeMath, AttributeNoise (curl option), TextureToAttribute · Force (gravity/wind/drag), Attract (point/pointer), Turbulence, Integrate, Limit (bounds/speed, kill-on-exit) · Delete (condition), lifecycle compaction (internal) · CustomKernel · RenderPoints, Camera, OrbitCamera · viewer + spreadsheet.
**P3b:** Neighbor grid (spatial hash) → Flock, ProximityForce · Sort · Trails (history ring) · AttributeToTexture splat · RenderInstances · ScatterOnMesh (needs P3c loader for meshes; on procedural surfaces earlier) · SpringMesh.
**P3c:** mesh topology ops, glTF loader (asset registry from Phase 2), Materials/Lights, Render3D MRT, GPU deform (the handoff §35.6 showcase).

TD POP/SOP names = reference vocabulary, same §C guideline as TOPs: map where it maps, don't clone; parity notes in manifests.

## 8. Contract impacts to weave in NOW (cheap now, breaking later)

Additions to the gap-doc broadcast list — same treatment (in-flight tracks informed before building against old shapes):

1. `pointset` port kind + `AttributeRequirement` compat rules; resolve the `geometry`-kind question (recommend: `pointset` replaces it).
2. Plan-IR additions: `dispatch` source union (fixed|indirect), `draw` pass kind, `counter`/`indirect-args` buffer roles, buffer ping-pong resource. Track E's exhaustive switches grow now, implementations stub.
3. Determinism invariant (§3.3) + `pointId`-is-identity rule into §V.
4. Kernel ABI versioning field in `NodeDefinition` (shared with the WGSL TOP contract — one `contractVersion`, not two mechanisms).
5. Caps (V24/T44) extend to buffers: max capacity, max dispatch, per-system memory estimate — same table, not a parallel system.
6. `read_points` in the agent tool roster (deferred list is fine; name it so schemas don't collide later).

## 9. Sub-phase gates (executable-spec style)

- **P3a exit:** audio-reactive particle graph — Emitter → Turbulence+Attract(pointer) → Integrate → RenderPoints → composite over a TOP background; emission rate driven by audio band via resolver; 100k points at 60fps/1080p on baseline tier; same seed + fixed-step transport → identical frame N in browser and headless (proves §3.3); spreadsheet shows live attributes; agent builds a variant via `apply_graph_patch` and verifies via `render_preview` + `read_points`.
- **P3b exit:** flocking (neighbor grid) at 50k points; instanced boxes per point via indirect draw; trails via splat+feedback stable for 10 min (resource-count gate, T49 style).
- **P3c exit:** handoff §35.6 (Grid → GPU deform → Render3D → Bloom → Output) runs; glTF loads via asset registry; MRT depth feeds a TOP depth-fog.

## 10. Risks

- **Codegen complexity is the project's new center of gravity.** Attribute-schema→WGSL generation (struct assembly, load/store wrappers, bind-group layouts) must be a small, heavily-tested pure module (headless, V11) — it is to POPs what the compiler is to TOPs. Budget it as its own task, not a side effect of the first node.
- **Scan/compaction correctness** — subgroup-free prefix-sum first (portable), optimize later; property-test against CPU reference.
- **Per-node dispatch overhead** at long chains — accepted (observability first), fusion is the known lever; GPU timers (T41) must attribute per-POP-pass cost from day 1 so the fusion decision is data-driven.
- **vgpu coverage:** compute/storage/pingPongStorage/indirect confirmed present (runtime review); mock-level testing of indirect paths unverified — track C to confirm early; this is the likeliest "leaks through the adapter" spot after the gap-doc findings.
- **Baseline tier:** 100k×~8 attributes ≈ tens of MB storage + multiple dispatches — fine on Tier B desktop; caps (item 5 above) keep low-end from device-lossing.
