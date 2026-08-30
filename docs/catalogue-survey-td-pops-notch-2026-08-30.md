# Catalogue survey — TouchDesigner POPs, Notch, and "Sentinel"

**T445. Written 2026-08-30. Read-only survey; no `src/` changes.**

This is a judgement, not a wish list. Every candidate below is scored on one question:
**what work does it unblock that is impossible or painful today, and does it survive our
constraints?** A node name copied out of someone's manual scores zero.

Half the document is about *our* catalogue, because T445's own framing is right: adding to
a catalogue where a third is invisible makes the catalogue worse.

---

## 0. What I actually observed, and what I did not

**Observed directly.**

- The full TouchDesigner POPs catalogue — 106 wiki pages — read from
  `docs.derivative.ca/Category:POPs` and the individual operator pages, with the
  one-line summary each page carries. `docs.derivative.ca` times out from this
  environment on both `curl` and the fetch tool; it was reached through the
  `r.jina.ai` text proxy. Content is the wiki's own, page timestamp 2025-10-28.
- The full Notch node reference — every category and node name — from
  `manual.notch.one/2026.1/en/docs/reference/nodes/` plus the Particles subtree.
- Our own catalogue: **78 registered node types** (enumerated by importing
  `allNodeDefinitions`, not by grepping), 17 shipped examples, 5 starter components.
- Coverage, measured today by walking every `examples/*.loom.json` and
  `examples/components/*.json`: **45 of 78 types appear in at least one shipped file;
  33 appear in none.**

**Not observed — stated plainly rather than inferred.**

- **I have not run TouchDesigner or Notch.** Everything about them here is
  documentation, not behaviour. Where a POP's summary is ambiguous about *how* it
  achieves something (Neighbor POP's acceleration structure, Copy POP's memory
  behaviour), I say so rather than guessing. Notch is Windows/DirectX desktop
  software; a trial was not attempted and I do not claim its runtime characteristics.
  This is the V378 discipline applied honestly: I am reporting metadata, and labelling
  it as metadata.
- I did not read all 106 POP pages in full — I read the catalogue index, every
  page summary, and the full text of the pages that back a recommendation
  (`Points, Vertices and Primitives in POPs`, `Dimension`, `Attribute POP`,
  `Learning About POPs`, and the POP↔TOP/CHOP/DAT bridges).

### "Sentinel" — RESEARCH GAP, unresolved (§V355)

I could not establish that a node-based realtime graphics tool called **Sentinel**
exists. Five searches across product, community, and developer framings returned only
unrelated artifacts sharing the name:

- Microsoft Sentinel (security analytics; added "custom graphs" in preview April 2026 —
  a graph *visualisation* feature for threat data, not a node compositor)
- Sentinel (sentinel.co) — decentralised VPN
- Sentinel — Phil Tippett stop-motion feature film (SIGGRAPH 2026 session)
- Navam Sentinel — agent-testing tool with a visual canvas
- Redis Sentinel, Roblox Sentinel, various security products

This is exactly the V355 shape: a product name that resolves to several unrelated
things, none of which is the one described. **I am not going to describe a tool I
could not find.** If the owner has a link, a screenshot, or the name of whoever makes
it, thirty minutes closes this.

One genuinely recent node-based tool in the adjacent space *did* surface and may be
what was half-remembered: **JangaFX IlluGen**, a node-based procedural asset generator
released 2025-07-28 (tiling noise, normal maps, flowmaps, masks, 3D FX meshes). I read
one article about it and nothing else — I have not tried it and make no claim about its
node set.

---

## 1. Our catalogue, measured — and three corrections T407 needs

**78 registered types. 45 exampled. 33 not.**

T407 records "42 of ~70". Both halves have drifted, in our favour and against:

1. **The count is 78, not ~70**, and 45 are covered, not 28. E20 and E24 shipped after
   that measurement and retired `cache`, `textureToAttribute`, `pointTopology`,
   `valueTrigger` and `valueLimit` from the uncovered list.

2. **T407 names `pulse` as an uncovered node type. `pulse` is not a node type.** It is a
   *parameter* kind (`src/nodes/registry/registry.ts:55-57`, `test-nodes.ts:164`) — the
   momentary trigger a stateful node exposes for its reset. Nothing to example.

3. **`renderSurface` went backwards.** `examples/E20-Gooeyball.md` names it three times;
   `examples/E20-Gooeyball.loom.json` contains it zero times — the T446/T447 references
   redirect rewrote the graph to `geometry` + `materialPhong` + `render`. So the shipped
   doc describes a graph the shipped file is not, and the one node E20 was supposed to
   retire is uncovered again. **This is a real defect, not a survey observation.**

### The cost model — "uncovered" is not one risk, it is three

A blanket "example or delete the 33" would be wrong, because our own §V140 convention
means several unexampled nodes share a compile path with an exampled sibling. Splitting
the 33 by *what is actually unexercised*:

**(a) Cheap — shared implementation, exercised by an exampled sibling.** No action.
`composite`, `multiply`, `screen`, `difference` share `blendShaderFor` with the exampled
`over`/`add` (`composite.ts:190`, §V140, pinned by
`composite.test.ts:60`). `pointGenerator`, `pointLine`, `pointCircle`, `pointTube` share
one compile with the exampled `pointGrid`/`pointSphere`/`pointTorus`
(`point-generators.ts:14`). Nine nodes, near-zero risk.

**(b) Covered at the pixel by a GPU test, just not by an example.** `solid`, `uv`,
`remap`, `analyze`, `materialPbr`, `movieFileIn`, `renderSurface`. V147's rule still
applies to *claims about the picture*, but these are not the B42 class — something
compiles and reads them back.

**(c) The B39/B42 class — own compile, own shader, no GPU test, no example.**
**Eighteen nodes.** This is the real list:

> `rectangle`, `flip`, `mirror`, `crop`, `premultiply`, `edge`, `convolve`, `mask`,
> `null`, `switch`, `constant`, `timer`, `webcam`, `text`, `valueSlope`, `valueFilter`,
> `audioIn`, `audioFileIn`

Every one has its own fragment shader or its own compile branch
(`transforms.ts:145,255,333`; `color.ts:623`; `composite.ts:378`), and nothing anywhere
in the repo puts a pixel through it. `webcam` is on this list, and `webcam` is B39.

---

## 2. Example or delete — what should land BEFORE anything new

Ranked by exposure, not by effort.

| # | Action | Why now |
|---|---|---|
| 1 | **Fix E20's doc/file drift** (`renderSurface`) | A shipped `.md` describing a graph the shipped `.json` is not. Smallest item here and the only one that is currently *wrong* rather than merely uncovered. Either restore the `renderSurface` path or rewrite the prose. |
| 2 | **T412 / E18 Kaleidoscope Machine** | Retires the largest block of class (c) in one graph: `mirror`, `flip`, `crop`, `uv`, `hsv`, `remap`, `switch`. Already specced. See §4 — it also kills the strongest *apparent* catalogue gap in this whole survey. |
| 3 | **T409 / E15 Camera Particles** | `webcam` + `movieFileIn` + `textureToAttribute`. B39 shipped precisely because no example used `webcam`; it is still true today. |
| 4 | **T408 / E14 Self-Regulating Bloom** — and finish T236 | `analyze`'s CPU half is unwired (T236 `~`). This is worse than uncovered: a node in the library whose advertised job cannot complete. Either finish it or take it out of `allNodeDefinitions`. |
| 5 | **An audio example that is not `audioPattern`** | `audioIn` and `audioFileIn` are both class (c). E24 deliberately uses the synthetic `audioPattern` (§V363, "a demo must demonstrate itself") — correct for CI, but it means the two nodes that touch a real device or file have never been run by anything. |
| 6 | **`text`, `constant`, `timer`, `valueSlope`, `valueFilter`** | T419/E22 (Dissolve) covers `text`; T411/E17 covers `timer`. `constant`, `valueSlope`, `valueFilter` have no planned home — they are small, but they are class (c). |

**Delete candidates: I found none I would argue for.** The two families that look like
padding (`composite`×6, point generators ×7) are one implementation each by deliberate
convention, so deleting a preset saves no code and costs a name TD users reach for. The
honest deletion argument is against `analyze` *if* T236 is not going to be finished —
and against `renderSurface` *if* the references redirect has genuinely superseded it,
which is a question for whoever owns T447, not for this survey.

---

## 3. The catalogues, for reference

**TouchDesigner POPs — 106 pages.** Generators (Box, Circle, Curve, Grid, Line,
Pattern, Plane, Point, Point Generator, Primitive, Rectangle, Sphere, Torus, Tube,
Text); attribute ops (Attribute, Attribute Combine, Attribute Convert, Accumulate,
Math, Math Mix, Math Combine, Limit, Normalize, Quantize, Random, ReRange, Trig,
Projection, Phaser, Time Filter); topology (Connectivity, Convert, Delete, Dimension,
Facet, Extrude, Merge, Polygonize, Primitive, Revolve, Skin, Subdivide, Topology,
Triangulate, Twist, Normal, Texture Map); spatial (Neighbor, Proximity, Ray, Sort,
Sprinkle, Field, Force Radial, Particle); temporal (Cache, Cache Blend, Cache Select,
Feedback, Trail); line ops (Line Break, Line Divide, Line Metrics, Line Resample, Line
Smooth, Line Thick, Trace); lookups (Lookup Attribute, Lookup Channel, Lookup Texture);
bridges (CHOP to POP, DAT to POP, SOP to POP, TOP to POP, POP to TOP/CHOP/DAT, File In,
File Out, Point File In, Alembic In/Out, Import Select); routing (In, Out, Null, Select,
Switch, Group, Import Select); scripting (GLSL, GLSL Advanced, GLSL Copy, GLSL Select,
CPlusPlus, Script); analysis (Analyze, Histogram, Blend); output (DMX Fixture, DMX Out);
devices (ZED, OAK).

**Notch — 20+ categories, several hundred nodes.** The families that matter to us:
Post-FX (~110 nodes across Blur, Colour, Distortion, Image Processing, Stylisation,
Warping); Particles (Emitters ×11, Affectors ×29, Shading ×12, Rendering ×11, Weights
×4); Cloning (15 cloners + 14 effectors); Deformers (~90 across Topology, Vertex,
Weights, Splines, Physics); Fields (2D/3D volumetric sim); Modifiers (~40 — this is
Notch's CHOP-equivalent, and it attaches to a parameter rather than wiring, which is
the same idea as our driven parameters); Generators, Shading, Materials, Video,
Text-FX, Logic.

The headline structural difference: **Notch's catalogue is wide and preset-shaped**
(fourteen separate "Effector" nodes, twenty warps), **TD's is narrow and
composition-shaped** (one Math POP with 70 operations). We are TD-shaped, deliberately
(one `pointKernel` where Notch has 29 Affectors). That is the right call for a tool
whose escape hatch is WGSL, and it means most of Notch's node *count* is not a gap.

---

## 4. Ranked candidates

### 1. `valueRemap` — range and curve mapping on the value graph

*TD: ReRange POP, Curve POP, Lookup Attribute POP. Notch: Range Remap, Curve Remap,
Gradient Remap.*

**The gap, in our own numbers.** E24 Audio Reaction-Diffusion is 29 nodes, of which
**eleven** are value plumbing: 6× `valueMath`, 2× `valueLimit`, 2× `valueLag`, 1×
`valueTrigger`. E13 Prism does the same thing at smaller scale. We have arithmetic and
we have clamping; we have no way to say "map 0.2–0.8 into 1–4 with an ease-in" without
three nodes and a mental model of the algebra. Every audio-reactive and LFO-driven graph
we will ever build pays this tax, and T422 (VJ examples) is a whole track of them.

**Fits.** It is a CPU-side value node: no GPU cost, no new resource, stateless (so §V155
does not apply and there is no §V181 reset to declare). Nothing about the browser
constrains it.

**Scope honestly.** The full Notch/TD version needs a *curve*, which means a curve-editor
control and a serialisable curve parameter. We already have that shape once — `stops` for
colour ramps (§V196), with the editor to match. Minimum viable version is
in-range/out-range plus a named ease enum and no editor at all; that alone collapses the
E24 chain and can ship first.

**Rank 1** because it is the cheapest thing here, it closes a gap that shows up in our two
largest graphs, and it needs no new machinery class.

---

### 2. `pointTrail` — time as a spatial axis for points

*TD: Trail POP ("captures and retains all the points of the input for the most recent N
frames … then optionally creates primitives that connect the points"). Notch: Trail
Emitter, Trail Renderer, Node Trail.*

**The gap.** We can freeze *textures* over time (`cache`, a GPU ring of N frames) and we
can bend time per-pixel (`slitScan`). We have nothing at all for points over time.
T411/E17 "Time Ribbon" is a planned example that currently has to fake it through `cache`
— time as pixels — because the node that would make time into geometry does not exist.

**Fits, and reuses three things we already built.**
- Output shape is `capacity × frames`, both compile-time → allocatable outside the frame
  loop (§V8), no readback (§V7/§V48), no per-frame resize (§V21).
- The published topology is exactly `grid:{capacity}x{frames}` — the string grammar in
  `src/points/topology.ts` already expresses it.
- `renderSurface` and `renderInstances` already consume grid topology, so a trail renders
  as a ribbon on day one with no renderer work.
- It declares state → §V155 unskippable, §V181 reset, §V170 not scrub-accurate backward.
  All three already have vocabulary; `cache` is the precedent.
- §V228 says the cost goes on the knob: capacity 4096 × 32 frames × 16 B ≈ 2 MiB per
  attribute. Modest, and statable.

**Rank 2** because it unblocks an already-designed example, reuses existing topology and
renderers rather than adding a machinery class, and it is the kind of crossing T420 says
examples should spend their complexity on.

---

### 3. Tone map and exposure on the Output node

*Notch: Tone Map, Colour Grading, Colour Curves, Local Contrast (Post-FX ▸ Colour).*

**Observed, not inferred.** `outputNode.parameters` is `{}` — the node has **no
parameters at all** (`src/nodes/definitions/output.ts:53`). The project's colour policy
offers `displayTransform: "srgb" | "none"` (`src/domain/types/graph.ts:181`,
`schemas.ts:223`) — an sRGB *encode*, and nothing else. Grepping the runtime and shader
trees for a tone curve returns nothing.

**Why that is a gap.** §V56 says "encode + tonemap ONLY at output|display node". The
encode half is built (T375/B47); **the tonemap half is named by the invariant and does
not exist.** Meanwhile the working format is `rgba16float` by default and E4 Bloom exists
specifically to make values exceed 1. Today those values hard-clip at the encode. We
support an HDR working space and offer no way to look at it.

**Fits.** One more branch in the shader the present pass already runs, plus two
parameters (exposure, curve). No new pass, no new resource, no state.

**Rank 3** on cost-to-value: it is small, it closes a stated-invariant gap rather than a
comparative one, and it changes how every existing example looks.

---

### 4. Neighbour access in the kernel ABI

*TD: Neighbor POP (k-nearest indices into an array attribute `Nebr`), Proximity POP.
Notch: Flocking Affector, Particle-Particle Collision, Spring, Mesh Distance Field.*

**The gap, admitted in our own source twice.**

`src/points/codegen.ts:24-28`: *"No raw buffer access exists in the contract; neighbor
iteration arrives later as an addition to `PointCtx`."*

And in E16, the example literally named **Murmuration**, its own flock kernel says:

> *"The 'flock': one shared flow field, phase-keyed by the anchor, so neighbours on the
> formation swirl together **without any neighbour reads**."*

We ship a flocking example that does not flock. It looks right, and it is a shared noise
field. Every genuine agent behaviour — separation, cohesion, collision, springs, SPH — is
out of reach.

**The borrowable thing is the semantics, not the node.** TD's Neighbor POP writes an
*array attribute* (`Nebr`). Our attribute types are
`f32 | vec2f | vec3f | vec4f | u32 | vec4u` (`src/points/attributes.ts:15`) — there are
no array attributes, so TD's node shape does not port. The right shape for us is what
`codegen.ts` already anticipated: an addition to `PointCtx`.

**Feasibility — the encouraging half.** A uniform-grid spatial hash is a *counting sort*:
histogram cells → exclusive prefix scan → scatter. That is the same three-stage,
atomics-free, deterministic machinery already sitting in `src/points/lifecycle.ts`
(`scanLocal` → `scanBlocks` → `scatter`), which exists precisely because §V74 forbids
atomics in the lifecycle path. The determinism problem is already solved here.

**Feasibility — the blocking half, stated as a dependency and not a promise (§V328).**
The per-stage storage-buffer budget. `codegen.ts:44-52` records that the lifecycle kernel
spends `2·(n−1)+2` buffers and the default schema lands **exactly at 8**, the WebGPU
baseline, with one more attribute busting it — silently (B33/§V240). A neighbour grid
adds at least cell-count, cell-start and sorted-index buffers. **This cannot land before
the §V256/T328 limit negotiation** (request `maxStorageBuffersPerShaderStage` from
`adapter.limits` and validate the budget against the real device). I would not start the
grid before that lands.

**Rank 4**, not higher, purely on that dependency. On capability alone it is the largest
gap in the whole survey.

---

### 5. `ctx.dim` — grid coordinates from the topology we already publish

*TD: the `Dimension` concept, with built-in per-point attributes `_NumDim`,
`_DimSize[0]`, `_DimI[0]`, `_DimU[0]`, `_DimCy[0]` available in every attribute
parameter.*

**This is the cheapest genuine improvement I found, and it is a live hazard today.**

E20 Gooeyball builds a 64×64 sheet. The number `64` appears **five times** in that one
graph: `pointGrid.cols: 64`, `pointGrid.rows: 64`, `pointTopology.cols: 64`,
`pointTopology.rows: 64`, and twice hard-coded inside the WGSL kernel:

```wgsl
let col = f32(ctx.index % 64u);
let row = f32(ctx.index / 64u);
```

Change the grid's `cols` knob and the kernel silently computes the wrong thing. That is
§V349 exactly — "a hardcoded constant in a shader is a parameter the user cannot reach" —
except worse, because here the parameter *does* exist and the shader just cannot see it.

`PointCtx` today carries `index, count, time, delta, frameIndex` and optionally `pointer`.
The topology string is already parsed and already on the edge. Handing the kernel
`ctx.dim.i / .j / .u / .v` from data the compiler has in hand costs nothing new, and
§V309's "optional stages cost nothing by existing" is already the established pattern for
adding a `PointCtx` member (`ctx.pointer`, T367, generates byte-identical WGSL when
unused).

**Rank 5** by impact, but **first by ratio.** If one thing from this survey ships, this
is the one I would ship.

---

### 6. Routing parity — `switch` for pointsets and for values

*TD: Switch POP, Switch TOP, Switch CHOP — routing exists per operator family. Notch:
Select Input, Select Child Node, Input Selector Modifier.*

**Observed.** `switchNode`'s variadic input is `RGBA_TEXTURE` (`switch.ts:58-66`). It is
the only routing node we have, and it routes textures only. There is no way to cut
between two point systems, and no way to select between two values.

**The gap it blocks.** T412 wants `switch` flipping modes live; T422 wants beat-gated
cuts. Both are texture-side and work today. But "cut between two particle behaviours on
the beat" — the obvious VJ move — has no expression at all.

**Design question, honestly.** A texture switch is cheap because both branches render
anyway and the switch picks a resource. A *pointset* switch with a driven index means both
simulations must run every frame (they are stateful — §V155 says a skipped stateful node
diverges permanently), so the switch saves nothing and only picks. That is fine, but it
should be said on the node. A **value** switch is trivial and has none of this.

**Rank 6.** Ship the value switch (small, no design risk); treat the pointset switch as a
design item with the §V155 cost written on it.

---

### 7. Copy / stamp — a pointset at each point of another pointset

*TD: Copy POP. Notch: the entire Cloning family (Mesh, Particle, Grid, Radial, Spline,
Volume, Procedural cloners plus 14 effectors).*

**The gap.** `renderInstances` draws one of three hardcoded shapes
(`INSTANCE_SHAPES = ["quad","box","octahedron"]`, generated in the vertex shader from
`vertexIndex`) at each point. We cannot place an arbitrary *pointset* at each point of
another. "A circle of points at every point of a torus" — the bread-and-butter
procedural move in both TD and Notch — is not expressible.

**Fits, on paper.** Output capacity is `capA × capB`, both compile-time, so it allocates
outside the frame loop and stays deterministic. Nothing here violates an invariant.

**Cost.** It doubles buffer pressure per attribute and lands on the same storage-buffer
ceiling as candidate 4. And it is a genuinely large piece of work — a new pointset
operator that owns fresh pairs and a stamping kernel.

**Rank 7** because, unlike 1/2/3/5/6, **nothing we have planned is currently blocked on
it.** It is the biggest expressive win available and it should wait for a use that wants
it.

---

### 8. Analyze, finished — and then generalised to point attributes

*TD: Analyze POP ("analyzes any point, vertex or primitive attributes … outputs a single
point containing the resulting statistics"), Histogram POP.*

Not a new node. T236 is `~`: the GPU half is built, the CPU half is unwired (B25/T305),
and T408/E14 — the only true image→parameter→image loop in the tool, which §V144 exists
for — is blocked on it. **Finish the texture half first.**

The borrowable idea, once it works, is TD's generalisation: the *same* reduction over
point attributes, not just texture pixels. "Average velocity of the flock" is a value we
cannot compute today by any route. Note the constraint: any reduction that has to reach a
CPU parameter crosses §V7/§V48's no-readback-in-the-loop line, which is exactly what
T236's unwired half is about — so the pointset version inherits whatever answer T236
lands on, and should not invent a second one.

**Rank 8** as an addition; **rank very high as a repair** — see §2, item 4.

---

### 9. Chroma key / colour key

*Notch: Chroma Key, Key Colour Mask, Auto Key Colour Mask, Background Plate Subtract.*

Obviously useful the moment live video is real, and cheap (one fragment pass, `mask`
already exists to consume the result). **Ranked last deliberately, and gated:** adding it
before T409/E15 gives `webcam` an example would be the B39 pattern executed on purpose —
a keying node nobody can point a camera at.

---

## 5. Rejected, with reasons

**The Notch warp family (Polar, Twirl, Droste, Moebius, Ripple, Sine, Barrel, Four
Point, Bezier, Screen, Curl Noise — 21 nodes) — this is a coverage failure, not a
catalogue gap.**
We have `remap` (source + map texture, `filters.ts`) and `uv`. Every one of those warps
is a UV field fed into `remap`. The capability is *there*. It reads as missing because
`remap` and `uv` are both in the uncovered 33, so nothing demonstrates it and no user
would ever discover it. **T412/E18 is worth more than all 21 nodes.** This is the
sharpest illustration in the survey of why T445's own weighting clause is right.

**Mesh / geometry import (TD File In, Alembic In, Import Select, SOP to POP; Notch 3D
Object).**
Not a node — a subsystem. Our model is points plus an *analytic topology claim*, stated
in `render-surface.ts:32`: "topology comes from the edge, not a mesh". There is no index
buffer anywhere. Importing geometry means a new payload kind, per-vertex indices, an
asset pipeline, and a parser in the browser. Worth noting separately: `gltf` already
exists as a **dead string literal** in four schema unions
(`domain/types/parameters.ts:78`, `graph.ts:159`, `schemas.ts:182`,
`components/schemas.ts:67`) with nothing consuming it. A name in a union that nothing
implements is worse than an absence — it will read as a capability to the next person who
greps. Either promote it to a §T row or take it out.

**Delete POP / point filtering as a chainable node.**
Needs a variable output count. `points.ts:243-247` already refuses a counted upstream
*by name*: "the incoming pointset carries a GPU live count, and this kernel processes a
fixed capacity — running process() over the dead tail would resurrect it." The answer is
not a Delete node; it is T401's scoped-out work — letting `pointKernelAdvanced` accept an
input so the lifecycle family can chain. **That known gap is the blocker behind an entire
class of POPs** (Delete, Sprinkle, Polygonize, Trace, Connectivity), and it is worth more
than any of them individually.

**Sprinkle POP / Point Generator POP (scatter on a surface).** Blocked behind mesh
import. The *volume* half — scatter inside an analytic primitive — is cheap and does not
need a mesh; if anyone wants this, that is the half to build.

**Sort POP.** `renderPoints` offers `blend: "additive" | "alpha"` (`points.ts:584,634`),
and alpha-blended particles are order-dependent, so a depth sort would be *correct*.
Bitonic sort is deterministic and atomics-free, so it satisfies §V74. But no example or
open §T row is blocked on it and it costs log²n passes. Below the line; revisit if an
example ever ships alpha-blended points.

**Sharpen, Dilate, Erode, Median, Kuwahara (Notch Image Processing).** Sharpen is a
`convolve` preset — not new. Dilate/erode/median/kuwahara are *non-linear* and genuinely
do not fall out of `convolve`. Real additions, but they rank below everything in §4.

**Notch's Cloning Effectors (Plain, Random, Sine, Ripple, Target, Turbulence, Sound,
Spring, Quantise, Smoothing, Colour Ramp, Kill Box, Rigid Body, Image — 14 nodes).**
These are our `pointKernel` with a kernel written in it. TD makes the same choice we did
(one Math POP with 70 operations, not 70 nodes). **The borrowable idea is presets on the
kernel — a starting-kernel library — not fourteen node types.** Our starter components
are already the right mechanism for this and cost nothing new.

**Comment / Region annotation nodes (TD Comment/Annotate; Notch Region, Comment,
Selection Set).** Cheap, zero GPU, and genuinely useful at our current graph sizes (E24
is 29 nodes, E25 is 21). But it competes for the same budget as auto-layout and
find-in-graph, which help *every* graph without anyone having to place them by hand.
Below both.

---

## 6. On the "known gaps" T445 listed

Two of the five need correcting before anyone works from them.

**"No auto-layout (`L` unbound)" — `L` is bound. The *command* is missing.**
`src/editor/keymap/defaults.ts:184-198` binds `L` → `graph.layout` and `l` →
`graph.layoutAll`, both `unconfirmed: true`. Both name *planned* commands
(`domain/types/commands.ts:112,124`) that nothing registers on the bus, so pressing them
returns `status: "unresolved"` — pinned by
`src/tests/integration/keymap-dispatch.test.tsx:160-198`. The canvas menu shows "Layout"
disabled (`editor/menus/schemas.ts:88`). This is T440's exact complaint: a key that does
nothing while the surface looks present reads as broken, not unbuilt.
`nodeBox` (`src/editor/nodes/node-box.ts:124`) is pure `(GraphNode, NodeDefinition) →
{x,y,width,height}` with no DOM measure, so it is sufficient — with the caveat its own
header states, that it deliberately models neither the diagnostic row, the agent-activity
row, nor the `controls` region, all of which only make a node *taller*. A layout must
carry a vertical gutter, as `src/examples/layout.test.ts` already does. Note also that a
`layoutGraph`/`placeRelative` module already exists at
`src/domain/graph/layout.ts` — used only by the agent tool, and it does **not** consult
`nodeBox`. Two layout implementations that disagree would violate §V189's determinism
promise the first time an agent and a human both pressed the button.

**"No find-in-graph (`mod+f` unbound)" — correct, and deliberately so.** The rationale is
written at `defaults.ts:21-30` and gated by `defaults.test.ts:154-163`, which *fails* if
any binding names `ui.findInGraph`. Confirmed: no surface anywhere searches node
*instances* — `mod+k` searches commands (`editor/palette/entries.ts`), the library pane
and the component pane search *definitions* (`editor/library/search.ts`). One small note:
the comment at `defaults.ts:21-30` says `ui.findInGraph` is "left in `PLANNED_COMMANDS`",
and it is not in the current `PlannedCommandName` union — that half of the comment is
stale.

**"`color.r` component-slot maps honoured by no consumer" — confirmed.** Exactly two
nodes read `parameterMaps`, and both match bare compound names only:
`render-instances.ts:155,170` and `points.ts:694-697,710,744`. Nothing looks up a
`color.r` key. The sharp edge is that `points.ts:487-490` *suggests* `"color.r"` in its
own error message, and the same function's caller then rejects it as unhonoured.

**"`pointKernelAdvanced` still a SOURCE" — confirmed**, `inputs: []` at
`point-kernel-advanced.ts:64`. Flagged above as the blocker behind a whole POP class.

**"Normal maps deferred (T428)" — confirmed, and there is no tangent frame anywhere.**
`renderInstances` uses analytic per-vertex normals rotated by the instance rotation
(`render-instances.wgsl.ts:146-153`); `renderSurface` uses central differences over grid
neighbours (`render-surface.wgsl.ts:48,75`). Grepping for `tangent` across the render
tree returns nothing. Worth noting for whoever picks this up: Notch ships **Generate
Normal Map** as a Post-FX node and again in the Video family, and we have `slope` — a
gradient — which is most of a height-to-normal conversion already. The 2D half of T428 is
much closer than the tangent-frame half.

---

## 7. If only three things ship

1. **`ctx.dim`** (§4.5) — smallest change, removes a live silent-wrong hazard, makes
   every gridded kernel readable.
2. **T412 / E18** (§2) — retires seven class-(c) nodes and makes the `remap`+`uv` warp
   capability visible, which is worth more than twenty warp nodes.
3. **`valueRemap`** (§4.1) — collapses the plumbing that eats a third of E24.

None of the three needs the storage-buffer negotiation, a new machinery class, or a
design decision that is not already made.
