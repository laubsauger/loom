# POPs we have, POPs we don't — measured against derivative.ca/UserGuide/Category:POPs

Read 2026-09-02. Compared against our nine point-family nodes: `pointKernel`,
`pointKernelAdvanced`, `pointProximity`, `pointRay`, `pointsFromTexture`,
`pointTopology`, `textureToAttribute`, `renderPoints`, `geometry`.

## The framing that matters

**A kernel is a `map`.** `fn process(p: Point, ctx: PointCtx) -> Point` runs once per point
and returns one point. That subsumes a large slice of TD's POP list outright — Math, Math
Combine, Math Mix, Noise, Transform, Trig, Limit, ReRange, Normalize, Quantize, Random,
Twist and Force Radial are all "write four lines of WGSL".

So the gaps are not the operators a kernel can express. **The gaps are the shapes a kernel
cannot be**: we have no `reduce`, no `sort`, and no `merge`.

| shape | TD POPs | ours |
|---|---|---|
| map | Math, Noise, Transform, Trig, Limit, ReRange, Normalize, Quantize, Random | `pointKernel` ✓ |
| spawn / kill | Particle, Sprinkle, Delete | `pointKernelAdvanced` ✓ (T744) |
| neighbourhood | Proximity, Neighbor | `pointProximity` ✓ (T819) |
| sample a field | Lookup Texture, Texture Map, Ray | `pointsFromTexture`, `textureToAttribute`, `pointRay` ✓ |
| connectivity | Topology, Connectivity | `pointTopology` ✓ (grid/points only) |
| **reduce** | **Analyze, Histogram, Line Metrics** | **— none** |
| **sort** | **Sort** | **— none** |
| **merge** | **Merge, Copy, Blend** | **— none** |
| **schema** | **Attribute, Attribute Combine, Attribute Convert** | **— none (a string on a kernel)** |
| history | Trail, Cache, Feedback, Time Filter | — none for points |

## The owner's two, in order of what they unlock

### Attribute POP — the schema is currently invisible

Today a pointset's attributes are declared as a **string parameter on whichever kernel
happens to compute them** (`points.ts:92` parses it; empty falls back to
`DEFAULT_POINT_ATTRIBUTES`). So the schema of the data flowing down a wire is buried in a
text field on an unrelated-looking node, and there is no operator that *is* the schema.

An Attribute node — create, rename, delete, convert — would put it in the graph where it
can be read. It also makes §V588's four-attribute budget legible: right now you learn you
have spent it by hitting the wall.

### Point POP — you must write WGSL to touch a point

Every per-point edit goes through `pointKernel`, which means WGSL. TD's Point POP sets
attribute values from per-attribute expressions. **There is currently no non-programmer path
to "colour by height" or "size by distance"** — the two most common things a person wants.

This is the same shape as the value graph versus `customWgsl`: we have the powerful one and
not the approachable one.

## The three structural holes, ranked

**1. Merge.** A kernel operates on one pointset. **Two point systems cannot be combined into
one draw.** Every example with two populations either fakes it with a group predicate or
draws twice. This is the one that limits "elaborate patches" most directly.

**2. Reduce / Analyze.** We have `analyze` for *textures*, and it closed T797's exposure
problem by letting an image drive a parameter from its own content. The point equivalent —
bounding radius, mean speed, live count, attribute min/max as a channel — would let a point
system drive itself. T819's live-count claim had to read the link buffer through a test-only
`probeBuffers` seam because no node can do this.

**3. Sort.** Additive blending has no depth test (§V792). A depth sort is the difference
between a transparent point cloud that reads and one that doesn't. Also: sort by attribute
for ordered reveals.

## Worth noting, not urgent

- **Trail / Cache for points** — history over frames. `cache` exists for textures only.
- **Connectivity / Neighbor** — `pointTopology` is grid/points only; no derived connectivity.
- **Line family** (Line, Line Resample, Line Smooth, Line Divide, Line Metrics) — an entire
  vocabulary we have none of, and the thing "cool line work" would eventually want.
- **Group** — we have WGSL predicate strings, not named persistent groups.

## Not gaps

Copy (that is `renderInstances`), GLSL/GLSL Advanced (that is our kernels), Grid/Circle/
Sphere/Box/Torus/Rectangle (generators — check which we actually ship), File In/Out,
Alembic, DMX, ZED, OAK, CPlusPlus, Script, DAT/CHOP/SOP/TOP-to.
