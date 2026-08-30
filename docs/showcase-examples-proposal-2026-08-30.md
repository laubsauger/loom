# Showcase examples — the pitch

**T475. Written 2026-08-30. PROPOSAL ONLY — nothing here is built.** No `.loom.json`, no
`src/` change, no `build-examples` run (§V345). The owner rules on these, then someone
builds the ones that survive.

Nine candidates. Four are small (5–9 nodes), five are deep (12–22). Each carries the five
things T475 asked for: what you SEE, the graph, which axis, which unexampled types it
retires, and what could go wrong. §1 is the part I would read first — it is five hard
walls I hit while checking these against the code, and two of them kill pitches that
sound obviously good.

---

## 0. What I read, and what I measured

- All 17 shipped examples (`.md` and `.loom.json`), and their **actual node counts**,
  parsed from the JSON rather than the prose:

  | | | | |
  |---|---|---|---|
  | E9 3 | E3 4 | E8 4 | E10 4 |
  | E11 4 | E5 5 | E7 5 | E16 5 |
  | E4 6 | E6 6 | E1 7 | E12 9 |
  | E2 11 | E13 17 | E20 17 | E25 21 |
  | E24 29 | | | |

  **The median shipped example is six nodes.** That reframes T475's second axis: we are
  not short of small graphs, we are short of small graphs whose *result* is out of
  proportion to them. E5 Kaleidoscope is five nodes and looks like five nodes' worth.

- `docs/catalogue-survey-td-pops-notch-2026-08-30.md` in full, including its rejections.
- The node definitions for everything I name below — parameters, ports and refusals read
  from source, not from memory.
- SPEC rows T402, T407–T413, T417–T420, T422, T425, T445, T473, T474; §V147, §V345,
  §V362, §V363, §V383.

---

## 1. Five walls, found by checking rather than by assuming

These reshaped the list. Two of them kill pitches I started writing.

### W1 — a point kernel cannot read the value graph

`PointCtx` carries `index, count, time, delta, frameIndex`, plus `pointer` (T367) and
`dim` (T472, in `src/points/codegen.ts` now; the SPEC row is still open). That is the
whole channel. `kernel`, `attributes` and `group` are `compileTime: true` strings; there
is no per-frame numeric a wire can push into a kernel.

**Consequence for every particle pitch:** an LFO cannot drive a kernel. Anything that
oscillates inside the point domain has to compute its own oscillation from `ctx.time`,
in WGSL. So the *shape* of every point animation lives in a text field, not in the graph.
E13 says this outright and works around it; every pitch below inherits it.

This is also why the Attractor pitch (S4) ranks lower than its picture deserves.

### W2 — points cannot be advected by a field, and E16 does not flock

Two facts compose into one wall.

1. `pointKernel` with the T401 input connected reads shared attributes from **upstream**
   and writes its own `out_*` pairs. So a chained processor holds no cross-frame state
   for any attribute the upstream also carries — including `position`.
2. `pointKernel` with the input *unconnected* owns both halves and is fully stateful, but
   it is a SOURCE: no texture input exists on it. `textureToAttribute` is the only
   texture→points bridge, and it is a separate node downstream.

There is no feedback node for pointsets, so `gen → bridge → kernel → bridge` cannot close.
**Therefore: a particle cannot accumulate motion from a texture field it samples at its
own current position.** "Sparks carried by E12's fluid" — the obvious next example and
the one I most wanted to pitch — is not currently expressible.

The survey already noted the related half (`codegen.ts:24`, no neighbour reads; E16's own
doc admits its flock is a shared noise field). This is the other half, and it is cheaper
to fix: **an optional texture input on `pointKernel`, sampled at `p.position`**, would
unblock advection, flow-field particles, terrain-following, and image-driven forces in one
addition — without the storage-buffer negotiation that gates the neighbour grid. I would
put that above `pointTrail` on the survey's own ranking. Not proposing it here; naming it.

### W3 — the new render pipeline has no per-point colour, and refuses counted sets

`geometry` reads `parameters` and `inputs` only; it never touches `parameterMaps`. Its
one colour control is `tint`, a per-object multiplier. And it refuses outright:

> `the point set carries a GPU live count; scene geometry draws a fixed capacity. Draw
> counted sets through renderPoints/renderInstances for now.`

So the render pipeline (camera/lights/materials/render) **cannot draw E9's spawning
particles and cannot draw E13's 2400 individually coloured points.** Per-point colour
still lives only on the legacy `renderPoints`/`renderInstances`, which have their own
built-in camera and no light list.

Practical effect: an example either gets *lit, materialled, multi-camera* geometry with a
uniform colour, or it gets *per-point colour* with legacy shading. Not both. Every deep
3D pitch below picks a side, and I say which.

The route around it that does work is E25's: colour that varies across a *surface* arrives
as a texture through the material's `albedo` map, sampled by the surface's grid uv. That
is exactly registered with a grid pointset's displacement, which is what makes D1 possible.

### W4 — `analyze` is unwired, so E14 is blocked

T236 is `~`: GPU half built, CPU half unwired (B25/T305). **T408 / E14 Self-Regulating
Bloom — the only true image→parameter→image loop, and the thing §V144 exists for — cannot
be built today.** I am not pitching it. It should stay specced and it should be the reason
someone finishes T236, but proposing it as a showcase item now would be proposing a
blocked task.

### W5 — no tone map, so every bright example clips

T474: `outputNode.parameters` is `{}`, `displayTransform` is srgb-or-none, working format
is `rgba16float`. Highlights hard-clip at the encode. Three of the pitches below
(Interference, Attractor, Infinity Room) are additive-light images that live in exactly
the range that clips. **They will each need a `level` gain trimmed by hand at the look
pass, and they will each look better the day T474 lands.** Stating it now so it is not
rediscovered three times.

---

## 2. The small tier — 5 to 9 nodes

The measure I applied here is not node count. It is: **is the graph the artifact, or is
the graph a frame around a text field?** For a node tool, a seven-node graph whose magic
is entirely visible as wires is worth more than a four-node graph whose magic is ten lines
of WGSL inside one of them. That test reorders this tier, and it is why the prettiest
picture in it is ranked last.

---

### S1 — **Interference** · moiré from one generator and a rotation

**What you see.** A field of fine concentric rings, cool and dim. A second copy of the
same rings, rotated by two degrees and breathing very slightly in scale, lies on top. What
you actually look at is neither: enormous soft rosettes and hyperbolic fans, far larger and
far slower than anything in either layer, sweeping through the frame and reversing
direction when the rotation crosses zero. The output moves at a speed nothing in the graph
is set to.

**The graph.** 7 nodes, one fan-out and one join.

```
rings1(ramp: radial, period 24, constant) ─┬──────────────────► beat1(difference).in1
                                           └─► spin1(transform) ► beat1.in2
                                                    ▲
                                            slow1(lfo, triangle) ┄drives┄ spin1.r, spin1.s

beat1 ─► tint1(lookup) ◄─ palette1(ramp)  ─► out1
```

**Axis: SMALL AND STRIKING.** It earns its place because it is the only example we would
ship with **no WGSL anywhere and no simulation** whose output is nonetheless not obviously
derivable from its inputs. It also teaches §V6 concretely and cheaply: the ring field is
generated **once** and consumed twice, and the whole effect is that fan-out. Every other
example demonstrating §V6 does so as a footnote.

**Retires.** Honestly, close to nothing: `difference` is class (a) — it shares
`blendShaderFor` with the exampled `over`/`add`. **Coverage yield: 0 of the 18.** I am
pitching it anyway, and I think that is the right call: it is the cheapest item in this
document and it is the one most likely to get screenshotted.

**What could go wrong.**
- **Aliasing.** `interpolation: constant` gives hard rings, which is what makes the beat
  crisp — and hard rings at 24 periods will shimmer and crawl under the rotation. The
  honest mitigation is `smooth` interpolation plus a per-node resolution override upward
  (§V50, E5's precedent), and accepting a softer beat. **This is the risk that decides
  whether the example is good or is a screen door.** It is also cheap to find out — this
  is a twenty-minute experiment before anyone writes a doc.
- **Rotation alone can read as "a spinning texture".** The scale breath is what makes the
  rosettes grow and collapse rather than merely turn; if it is too subtle the effect reads
  as rotation and the surprise is lost.
- It clips (W5). Additive it is not, but a white-on-white beat region saturates.

---

### S2 — **Life** · Conway's rule as a colour ramp

**What you see.** A dark field crawling with gliders, blinkers and spreading colonies —
unmistakably Conway's Game of Life, at full frame rate, in colour, with new cells raining
in sparsely so it never settles. Nothing about the graph says "cellular automaton".

**The graph.** 9 nodes, one feedback loop.

```
              ┌──────────────────────── state1(feedback, source: rain1) ◄─┐
              ▼                                                           │
   count1(convolve: [[1,1,1],[1,10,1],[1,1,1]], normalize)                 │
              │                                                           │
              ▼                                                           │
   rule1(lookup) ◄─ table1(ramp: horizontal, interpolation CONSTANT)       │
              │                                                           │
              ├─────────────────► rain1(screen) ◄─ seed1(threshold) ◄─ noise1
              │                                                           │
              └───────────────────────────────────────────────────────────┘

   rule1 ─► colour1(lookup) ◄─ palette1(ramp)  ─► out1
```

**The teaching, and it is a genuinely good one: the rule table is a colour ramp.**
`convolve` with a centre weight of 10 and `normalize` on produces
`(neighbours + 10·self) / 18` — a single number that encodes both the neighbour count and
the cell's own state. Life is then exactly three bands on that number: born at `3/18`,
survives at `12/18` and `13/18`, dead everywhere else. A `ramp` with
`interpolation: "constant"` **is** a step function, so the entire rule is four stops in a
gradient editor. Drag a stop and you are running a different automaton — HighLife, Seeds,
Day & Night — with no code and no recompile.

**Axis: SMALL AND STRIKING.** Nine nodes, zero WGSL, and the headline writes itself.

**Retires.** `convolve` (class c — own shader, no GPU test, no example) and exercises
`threshold`'s use as a sparse gate. **Coverage yield: 1 of the 18**, plus the first
non-trivial use of `ramp`'s `constant` interpolation anywhere in the set.

**What could go wrong.** Ranked by how much it worries me.
1. **Quantisation.** The whole thing rests on `12/18` and `13/18` surviving a round trip
   through `rgba16float`, a normalised convolve and a lookup's texture sampling. I believe
   it does — the values are ~0.667 and ~0.722 in a 10-bit mantissa, and constant
   interpolation means the band only has to be hit *within* its stop pair, not exactly —
   but I have not run it. **If this fails the whole pitch fails**, and it fails as
   "everything dies in four frames", which is at least loud.
2. **Cell size vs. resolution.** At project resolution a cell is a pixel and Life reads as
   noise. It wants a per-node resolution override down to something like 320×180, then an
   upscale — and a bilinear upscale of hard cells looks like blurry mush. This is a look-pass
   problem with a real chance of needing a second idea.
3. **`convolve`'s tap offsets** must be exactly ±1 texel at the node's own resolution. If
   they are derived from a different resolution the neighbourhood is wrong and the rule
   silently becomes a different rule that still looks like *something*. That is the §V383
   failure shape exactly, so the concept test should assert a known pattern's period — a
   blinker has period 2, and a test that a specific texel oscillates with period 2 is a
   real motion assertion (§V147) that no other automaton passes.
4. Life settles. The noise rain is what satisfies T402, and its rate is a tuning knob
   between "dead field" and "static".

---

### S3 — **Descent** · the Droste feedback tunnel

**What you see.** A word — say the project's name — hangs in the middle of the frame,
then falls away from you down a spiralling tunnel of itself, each copy smaller, rotated a
little further and shifted a little further around the hue wheel, receding to a point.
New copies keep being born at the front. It is the analog video-feedback look: a camera
pointed at its own monitor.

**The graph.** 8 nodes.

```
word1(text) ─► glow1(blur) ─► seed1(over).in1
                                  ▲
   loop1(feedback) ─► fade1(level) ─► fall1(transform: s 1.06, r 3°) ─► shift1(hsv) ─┘
                                                                                     │
   seed1 ────────────────────────────────────────────────────────────► loop1 ────────┘
   seed1 ─► out1
```

**Axis: SMALL AND STRIKING.** Eight nodes, no WGSL, and the effect is one everyone
recognises and nobody expects from eight boxes.

**Retires.** `text` (class c). **Coverage yield: 1 of the 18** — and `text` is a node with
its own canvas-rasterisation path that nothing in the repo currently puts a pixel through.

**What could go wrong.**
- **It is E1 with more knobs, and a reviewer will say so.** E1 Feedback Echo is already
  "fade + transform inside a loop", seven nodes. My defence: E1 is a *smear*, this is a
  *tunnel*, and the two differences that make it one — scale > 1 with a pivot, and a hue
  rotation inside the loop — are exactly the two things E1 does not do. But the owner may
  reasonably rule that the set does not need two feedback-loop examples, and if so this is
  the one to drop.
- **Saturation.** Hue-rotating inside a loop with any gain ≥ 1 goes to white mush within
  seconds. `fade1`'s gain has to sit just under unity and it is a narrow window.
- **`text` at depth.** The receding copies are resampled repeatedly; type turns to mud
  fast. Wanting a chunky short word is a constraint on the example, not a bug.

---

### S4 — **Attractor** · a de Jong map as a point system

**What you see.** Thousands of sparks settle out of a uniform haze onto a luminous
filigree — smoke and lace and stretched wings, the classic strange-attractor image — and
then the whole structure turns itself inside out continuously as the map's coefficients
drift. Additive, so where the orbit is dense it burns white.

**The graph.** 6 nodes.

```
orbit1(pointKernel, 200k pts, iterating x' = sin(a·y) − cos(b·x), …)
   └─► sparks1(renderPoints, additive, colour ← per-point speed, size ← per-point speed)
          └─► trail1(feedback) ─► fade1(level) ─► bloom-ish ─► out1
```

**Axis: SMALL AND STRIKING**, and it has the best picture-per-node ratio in this document.

**Retires.** Nothing. **Coverage yield: 0.**

**What could go wrong — and why I rank it fourth despite the picture.**
- **The graph is not the artifact; the kernel text is.** Six boxes, five of which are
  plumbing, and the entire piece is eight lines of WGSL inside one of them. That is the
  T388 criticism of old E2 ("just an ugly shader") wearing a different hat, and for the
  axis T475 defines — *the shareable artifact is the graph beside the result* — this is
  arguably the wrong kind of small. A screenshot of it teaches nothing about the tool.
- **W1 makes it worse.** The coefficient drift that keeps it alive cannot come from an
  LFO; it has to be `sin(ctx.time * k)` written in the kernel. So even the animation is
  invisible in the graph.
- **Divergence.** De Jong is bounded; Clifford and Lorenz variants are not, and a NaN
  propagates through the pair and never leaves. Needs a clamp, and the clamp needs to be
  in the doc.
- Clips hard (W5).

I would build this, but as a fifth or sixth item, and I would want its doc to be honest
that the kernel is the piece.

---

## 3. The deep tier

---

### D1 — **Living Skin** (T418 / E21) — **BUILT AND ABANDONED, 2026-08-30**

> **Outcome: does not land. Do not rebuild from this pitch without the unblock below.**
>
> Nine tuning passes on a real device. Every one traded one artifact for another, because
> the cause is structural rather than aesthetic: **`textureToAttribute` reads with
> `textureLoad` — nearest, unfiltered — and a reaction-diffusion is a near-binary field.**
> A displaced SURFACE is then trapped between two failures with no setting in between.
> Mesh coarser than the field: a front narrower than the vertex spacing falls between two
> vertices and renders as a spike (the first build was a sea urchin). Mesh finer: every
> vertex inside one texel shares a height, so the surface steps, and no upstream blur can
> remove it because the quantisation happens at the READ. The only stable point is one
> vertex per texel, which forces a rectangular sheet — and then the field's feature size
> IS the frame's feature size, so the result is a bas-relief of a 2D picture rather than
> the crossing the pitch promised. A blur wide enough to fix the undersampling is a blur
> wide enough to delete the chemistry.
>
> E20 survives the same bridge only because **noise is smooth at every scale**; a
> simulation is not. The pitch was wrong to assume the two were interchangeable.
>
> The unblock is one of: a FILTERED read mode on `textureToAttribute` (its `textureLoad`
> is deliberate, for r32float data fields — so this wants to be a mode, not a change), or
> a normal-mapped shading path so relief does not have to come from displaced vertices at
> all. Neither is small enough to have done inside this task.
>
> What survived: E27 Relief was built on the same bridge and works, because POINTS have no
> shared edge to tear or facet. That is the finding worth keeping.

The pitch as originally written follows.

### D1 — **Living Skin** (T418 / E21, re-read against today)

**What you see.** A lit, shaded organic form — somewhere between a coral and a lung —
turning slowly under two lights. A reaction-diffusion pattern crawls across its surface in
colour, and the same pattern is what is deforming it: the ridges of the chemistry *are*
the ridges of the form, so the surface visibly grows and heals as the fronts divide and
collide. The camera orbits; the light rakes across the relief.

**The graph.** ~20 nodes, in three groups.

```
  the chemistry (E2's spine, ~9 nodes):
     broad1(noise) ─► warp1(displace) ◄─ detail1(noise)
       └─► fk1(remap|level) ─► rd1(customWgsl) ◄─ state1(feedback, substeps 20)
       rd1 ─► skin1(lookup) ◄─ palette1(ramp)

  the form (~6 nodes):
     grid1(pointGrid 96×96) ─► topo1(pointTopology, wrapUV)
       └─► bridge1(textureToAttribute ◄ rd1) ─► push1(pointKernel, processor)
       └─► body1(geometry: surface, material coral1)

  the look (~5 nodes):
     coral1(materialPhong, albedo ◄ skin1)   key1(light)   rim1(light)
     eye1(camera, eye.x/.z ┄ two LFOs)       shot1(render) ─► out1
```

**The claim, and it is one sentence: one texture is both the colour and the shape.**
`skin1` goes into the material's `albedo` map — sampled by the surface's grid uv — while
`rd1` goes through `textureToAttribute` into a displacement along the surface normal.
Because the albedo is sampled by the *same* grid uv the displacement is indexed by, the
pattern and the relief are exactly registered. That registration is not a coincidence to
be arranged; it falls out of the topology, and that is the teaching.

**Axis: DEEP.** It earns its place as the crossing T420 asks for, in both directions at
once, and it is the one the owner already flagged as having clip appeal.

**Retires.** Nothing on the 18. **Coverage yield: 0.** Worth saying plainly: this is the
strongest pitch in the document and it buys no coverage at all. It also **fixes the E20
doc/file drift the survey found** as a side effect — E20's `.md` names `renderSurface`
three times and its `.json` contains it zero times; whoever builds this will be in exactly
that code and should repair E20's prose in the same pass (or restore its `renderSurface`
path, which is a separate ruling).

**What could go wrong.**
- **It becomes E20 with a pattern on it.** E20 is already noise → attribute → displacement
  → lit surface, and the §V383 look pass called E20 "flat putty". If the displacement is
  timid and the pattern is low-contrast, this is E20 with texture — technically a second
  crossing, visually a rerun. **This is the main risk and it is a look-pass risk, not a
  structural one.** The mitigations I would try first: displacement amplitude high enough
  that the silhouette changes; a rim light so the relief reads at the edge; and a palette
  with a hard value break rather than a smooth ramp, so the fronts cast visible shadow.
- **RD needs to be evolving at a watchable rate on a surface you are also orbiting.** Two
  motions at different speeds can read as neither. Substeps around 20 and a slow orbit.
- The chemistry can die into a fixed point (E24's own warning); the feed/kill band needs
  the same safe bounds E24 established.
- Sixty-plus percent of this graph already exists in E2 and E20, which is a schedule
  advantage and a novelty risk at the same time.

---

### D2 — **Relief** · the understudy pattern, and the retirement of `webcam`

**What you see.** A moving picture standing up off the screen: a field of points on a
plane, each pushed toward the camera in proportion to the brightness under it, drawn as
glowing scanlines and orbited by a slow camera. It reads as a Rutt–Etra video synthesizer
— a face or a shape rendered as a landscape of luminous contour lines that swim as the
source moves. **On open it is fed by a synthetic performer** (a small lit 3D scene we
render ourselves, tumbling). One switch index, and it is your webcam.

**The graph.** ~17 nodes.

```
  the understudy (~7 nodes):
     stand1(pointTorus) ─► stand2(geometry: instances, mat) ─► standshot1(render)
        + standcam1(camera, driven) + standkey1(light)
  the real thing (1 node):
     cam1(webcam)
  the choice (1 node):
     source1(switch, index 0)  ◄ standshot1.out, cam1.out     ← index 1 is your camera

  the relief (~8 nodes):
     source1 ─► prep1(level) ─► grid1(pointGrid 240×135) ─► topo1(pointTopology)
        └─► lift1(textureToAttribute ◄ prep1) ─► push1(pointKernel processor: z += sample.r)
        └─► lines1(renderPoints | geometry: points) ─► out1
     eye1(camera, orbiting)   glow1(blur) + add1  ─► out1
```

**The structural idea, and I think it is the most reusable thing in this document.**
§V363 says a demo must demonstrate itself, which has so far meant "no example may contain
a live input at all" — and that is precisely why `webcam` shipped dead for months (B39).
The **understudy pattern** dissolves the conflict: a `switch` whose default branch is a
synthetic source we render ourselves, and whose second branch is the real device. The file
opens playing. The webcam node is nonetheless **in the graph, in the plan, and compiled by
`examples.gpu.test.ts` on Dawn** — which is the integration gate §V362 says is the only one
we have, and the exact gate B39 escaped. Switching a texture picks a resource; both
branches were going to be built anyway, so this costs nothing at runtime.

Same pattern generalises straight to `audioIn`/`audioFileIn`, the other two class-(c)
nodes that §V363 currently makes unexampleable. I would not build that in this example,
but I would name the pattern in its doc so the next one inherits it.

**Axis: DEEP.**

**Retires.** `webcam` and `switch` — both class (c), and `switch` is the only routing node
in the catalogue and appears in nothing. Add `movieFileIn` as a third switch branch and it
is three. **Coverage yield: 2, or 3 for one extra node.** Highest of any pitch here except D3.

**What could go wrong.**
- **W2 bites.** The points do not move *through* the image; a grid point samples the
  texture at its own fixed (x,y) and is pushed in z. That is genuinely a relief, not a
  particle system, and if the doc oversells it as particles the look pass will disagree.
  Written honestly it is fine — Rutt–Etra is a relief.
- **W3 bites.** A displaced grid drawn through `geometry` gets lights and materials but a
  uniform colour; drawn through `renderPoints` it gets per-point colour but no lights and
  the legacy built-in camera. **I would take `renderPoints` with additive blend and colour
  mapped from the sampled luminance** — the glowing-scanline look wants additive light, not
  shading — but that is a choice the look pass should re-litigate.
- **The synthetic understudy has to be worth watching on its own**, because that is what
  99% of people who open the file will see. If it is a grey torus the example is a grey
  torus. It should be the most interesting thing we can render in seven nodes.
- Webcam permission: the second branch shows black until the user grants access, and if
  they flip the switch and get black they will read it as broken. The doc is not enough
  (§V363 is explicit that a doc line is not a UI state) — the honest version needs the
  webcam node's own inspector to say "waiting for camera permission", the way
  `audioFileIn` says "Waiting for a file". **That may be a small `src/` change riding
  along with this example.** Flagging it rather than hiding it.

---

### D3 — **Machine** · the kaleidoscope as a beat-cut VJ instrument (T412 + T422)

**What you see.** A hard-edged chrome-and-neon mandala, six-fold, breathing. On every kick
it *snaps* — a different symmetry, a different crop, a different hue register — and holds
until the next one. The source it is folding is not a still: it is a live 3D render
turning behind the mirrors, so the mandala has depth and specular glints in it rather than
the flat look every kaleidoscope demo has.

**The graph.** ~22 nodes.

```
  source (~7):  spin1(pointTorus)+geo1+mat1+cam1+light1 ─► shot1(render)
  three folds (~9):
     A: mirror1 ─► tile1 ─► hsv1
     B: crop1 ─► mirror2(rotate 30°) ─► flip1
     C: uv1 ─► warp1(remap ◄ a driven noise) ─► hsv2
  the cut (~4):
     beat1(audioPattern) ─► onset1(valueTrigger) ─► step1(valueMath) ┄drives┄ cut1(switch).index
     cut1 ◄ A, B, C
  out (~2): cut1 ─► trail1(feedback) ─► out1
```

**Axis: DEEP**, and it is the only pitch here that is an *instrument* rather than a piece.

**Retires.** `mirror`, `flip`, `crop`, `switch` — four class-(c) nodes — plus `uv` and
`remap` from class (b), which the survey argues is worth more than the entire 21-node Notch
warp family because those two are the capability nobody can currently discover.
**Coverage yield: 4 of the 18, the highest here.**

**What could go wrong.**
- **Kaleidoscopes read as screensavers**, and we already ship one (E5). The thing that
  makes this not-E5 is the beat cut and the live 3D source, and if either is weak it
  collapses back into E5 with more sliders. I rate that risk as real — maybe one in three.
- **The cut must land ON the beat.** `valueTrigger` on `onsetCount` into a stepped switch
  index is the right chain (E24's precedent), but if the index advances a frame late, or
  advances on sustained loudness rather than on rising events, the cuts read as random and
  the whole conceit dies. E24's regression signature for exactly this bug should be copied.
- **Twenty-two nodes for a 2D effect.** T420 says a 2D-only stack is a shader anyone can
  write elsewhere. This one is saved from that only by the 3D source and the audio, and
  those are the two parts most likely to get trimmed for simplicity while it is being built.
- Three fold chains that all look similar is the boring failure. They need to differ in
  *kind* — one mirrored, one cropped-and-repeated, one warped — not in degree.

---

### D4 — **Infinity Room** · the temporal boundary crossing the 3D pipeline

**What you see.** A dark box with four mirrored walls. In the middle, one lit tumbling
object. Every wall shows the room itself, and inside that reflection the room again, and
again — a lattice of copies receding to a point, each one dimmer and hue-shifted from the
last, the whole lattice parallaxing as the camera drifts. Kusama's infinity room, or the
back of a lift with mirrors on both sides.

**The graph.** ~17 nodes.

```
   shot1(render) ─► decay1(level, gain 0.86) ─► hue1(hsv) ─► past1(feedback)
                                                                │
   past1 ──────────────► walls1(materialUnlit, albedo ◄ past1)   │
                              ▲                                  │
   room1(pointGrid) ─► wallgeo1(geometry: surface, walls1) ──────┐│
   core1(pointKernel) ─► coregeo1(geometry: instances, glow1)    ││
   eye1(camera, drifting)  key1(light)  fill1(light)             ││
   shot1(render, scenes "wallgeo1 coregeo1") ────────────────────┴┘─► out1
```

**The claim.** E25 proved a render can be a material map. This proves a render can be
**its own** material map one frame later — that `feedback`, the explicit temporal boundary
(§V4/§V22), composes with the render pipeline rather than sitting beside it. That is a
structural statement nothing in the set currently makes, and it is the natural sequel to
E25 rather than a repeat of it.

**Axis: DEEP.**

**Retires.** Nothing. **Coverage yield: 0.**

**What could go wrong — this is the riskiest pitch here and I want that on the record.**
- **The recursion may not read as depth.** A wall showing a picture of the room is only an
  infinite corridor if the camera is nearly perpendicular to it and the picture is
  perspective-correct at that angle. It is not — it is last frame's *camera A* view pasted
  flat onto a quad. Get the geometry wrong and this is E25 again: a screen in a room. **I
  am about 50/50 that the illusion lands**, and I would want a throwaway experiment before
  anyone writes a doc.
- **Saturation or death.** A gain of 0.86 in a loop that also passes through lighting can
  bloom to white or fall to black within a second, and the window between them is narrow.
- **Frame lag on the recursion** means the deepest copies are seconds behind the nearest,
  which is either the best thing about it (motion trails receding into the mirror) or a
  smeary mess.
- W5: it is an additive-light image with no tone map.

**Recommendation: greenlight this only if the owner wants a swing.** The ceiling is the
highest in the document and the floor is "E25 with a fade".

---

### D5 — **Dissolve** (T419 / E22, re-read)

**What you see.** A word, made of forty thousand sparks. It hangs, then blows apart into a
slow drifting cloud that loses all trace of the letterform, then draws itself back together
— the sparks arriving from every direction and settling into type. Over and over.

**The graph.** ~12 nodes.

```
   word1(text) ─► soft1(blur) ─► grid1(pointGrid 200×200) ─► lift1(textureToAttribute)
      └─► shatter1(pointKernel processor: mix(gridPos, hash-scatter, wave(ctx.time)))
      └─► sparks1(renderPoints, additive, colour ← sample, size ← sample)
      └─► glow1(blur) ─► add1 ─► out1
```

**Axis: DEEP** by node count, but it behaves like a small one — and it is by some distance
the **most shareable** shape in the document. Everyone recognises it and it reads at
thumbnail size.

**Retires.** `text` (class c). If a `valueTrigger` drives a colour flash on reassembly
through `renderPoints`'s driven `color`, two. **Coverage yield: 1–2.**

**What could go wrong.**
- **W1 again**: the dissolve wave has to be `ctx.time` inside the kernel, so the timing of
  the piece is invisible in the graph. Contrast S1 and S2, where every timing decision is a
  wire.
- **Only the lit points should exist.** Sampling a 200×200 grid over a word means most
  points sit on black background and must be either killed (needs
  `pointKernelAdvanced`, which is a SOURCE and cannot chain — T401's scoped-out work) or
  hidden by making their size zero. Size-zero works; it means the graph allocates 40k
  points to draw maybe 8k, which is fine and should be said.
- Type legibility at grid resolution: a 200×200 sample of a word gives blocky letters. It
  wants a short, fat, high-contrast word.
- It conflicts with **S3** over `text`. Whichever lands first retires it; the second gets
  no coverage credit. That is fine, but it should not be double-counted when ranking.

---

## 4. Ranking — the three I would build first

**1. D1 Living Skin.** The deep one. Every dependency landed today (substeps, compositional
RD, geometry/materials/render, `textureToAttribute`), it is the crossing T420 asks for in
both directions, the owner has already called out its clip appeal, and its risk is a look
risk rather than a structural one — which is the risk we now have a gate for (§V383). It
buys zero coverage, and I still put it first.

**2. S1 Interference.** The small one, and the cheapest item in the document. Seven nodes,
no WGSL, no simulation, no new machinery, and an output that does not look like its inputs.
It is also a real §V6 demonstration instead of a footnote. If the aliasing experiment fails,
we have lost an afternoon; **run that experiment before committing to it.**

**3. D2 Relief.** Because it retires `webcam` — a node that shipped dead for months and is
still the standing example of what an unexampled capability costs — and because the
**understudy pattern** it establishes is what unblocks every future live-input example under
§V363. Two class-(c) types retired, three for one more node. It also crosses 2D→3D with a
source that has *meaning* in it, which nothing else in the set does.

**Then, in order:** S2 Life (best headline in the document, one genuine unknown), D3 Machine
(the coverage sweep and the only instrument), D5 Dissolve (most shareable), S3 Descent
(cheap, overlaps E1), S4 Attractor (best picture, weakest graph).

**D4 Infinity Room is a separate decision.** It is not ranked with the others because its
ceiling and its floor are further apart than anything else here. If the owner wants a swing,
it is the swing.

**Not proposed:** E14 Self-Regulating Bloom (blocked on T236, W4), E17 Time Ribbon (the
survey is right that it wants a `pointTrail` node that does not exist; faking time-as-geometry
through `cache` would be a worse example than none), E19 Component Triptych (a real gap —
components are a headline feature with almost no example presence — but it is a *structural*
example, not a showcase one, and T475 asked for showcase).

---

## 5. What the medium is known for that we have not attempted — and where we should not

The owner asked for range, so here is the honest inventory of what I considered and did not
pitch.

**Not possible today, and why:**

| Effect | Blocker |
|---|---|
| Boids with real separation/cohesion | No neighbour reads in `PointCtx` (survey §4.4), gated behind the storage-buffer negotiation |
| Cloth, springs, SPH, particle collision | Same |
| Sparks carried by a fluid; flow-field particles | **W2** — no advection. The cheapest unblock in this document: a texture input on `pointKernel` |
| Pixel sorting, datamosh | Needs a sort; nothing in the catalogue orders anything |
| Text on a path, kinetic typography beyond dissolve | `text` renders a rectangle of type; there is no glyph-level access |
| Anything with an imported mesh | Survey rejected it correctly: a subsystem, not a node |
| An image that measures itself | **W4** — `analyze`'s CPU half |

**Possible but I would not build it:**

- **A raymarched volume / SDF scene.** It would be the most spectacular single image we
  could produce and it would be one `customWgsl` node. That is precisely the thing T388
  condemned old E2 for: the graph would teach nothing and the example would be a shader we
  happen to host. If we ever want it, it belongs in a *starter component* library, not the
  example set.
- **Voronoi / crystal growth.** Jump-flood needs log(n) passes with per-pass parameters; we
  have no loop-with-varying-parameter construct. Substeps iterate the *same* pass.
- **A wave-equation ripple tank.** Needs `u[t] − u[t−1]`, and there is no subtract in the
  composite family (`difference` is absolute). Expressible through `level` with a negative
  gain plus `add`, but that is three nodes of arithmetic obfuscation for one operation, and
  the honest fix is a `subtract` blend preset — which is free, since it shares
  `blendShaderFor` with five siblings by our own §V140 convention. Worth a one-line §T row.
- **Chladni / cymatics.** The audio→3D corner is genuinely empty (E24 is audio+2D, E25 is
  3D+no-audio) and it is the most obvious hole in the set. But the closed form wants a
  `customWgsl` blob, and the simulation route wants the wave equation above. **The cheap
  way to fill that corner is to give D1 an audio input** — the bass driving the RD substeps
  exactly as E24 does, so the skin grows faster on the beat. That is two nodes on top of D1
  and it makes D1 the audio+3D example as well. I did not fold it in because it doubles D1's
  look-pass surface; I would build D1 first and add it second.

---

## 6. Coverage ledger

The 18 class-(c) types (own shader, no GPU test, no example) from T473:

> `rectangle` `flip` `mirror` `crop` `premultiply` `edge` `convolve` `mask` `null`
> `switch` `constant` `timer` `webcam` `text` `valueSlope` `valueFilter` `audioIn`
> `audioFileIn`

| Pitch | Retires | Count |
|---|---|---|
| D3 Machine | `mirror` `flip` `crop` `switch` | **4** |
| D2 Relief | `webcam` `switch` (+`movieFileIn`, class b) | **2** |
| D5 Dissolve | `text` (+`valueTrigger`, already covered) | **1** |
| S3 Descent | `text` | **1** |
| S2 Life | `convolve` | **1** |
| S1, S4, D1, D4 | — | **0** |

Building D1 + S1 + D2 retires **2**. Building D3 + D2 + S2 retires **7** and is a much
worse showcase. That tension is real and the owner should decide it, not me — but my read
is that T475 is right that coverage is not the point, and that D1 and S1 are the two things
most likely to make someone want to use the tool.

**Nine would remain after all nine pitches:** `rectangle`, `premultiply`, `edge`, `mask`,
`null`, `constant`, `timer`, `valueSlope`, `valueFilter` — plus `audioIn`/`audioFileIn`,
which **cannot be retired by an example at all** under §V363 unless the understudy pattern
(D2) is applied to them. That is worth knowing: two of the eighteen are not an example
problem, they are a §V363 problem, and D2 is the proposal that solves it.

---

## 7. What I am unsure of

Stated plainly, because a pitch labelled risky is worth more than a confident one that
disappoints.

1. **S2 Life's quantisation.** The single largest unknown here. I reasoned it through and
   did not run it. It is a twenty-minute experiment and it should happen before the pitch is
   greenlit, not after.
2. **S1 Interference's aliasing.** Same class, same fix: try it before committing.
3. **D4 Infinity Room's illusion.** I am genuinely 50/50 that it reads as depth rather than
   as a picture on a wall.
4. **D1's distinctness from E20.** I believe the lit-and-patterned version is a different
   image from the putty ball. The §V383 look pass on E20 is a warning that I might be wrong
   about what a surface with a displacement on it actually looks like.
5. **`ctx.dim`** is in `src/points/codegen.ts` and its SPEC row (T472) is still open, so
   another track is mid-flight there. D1, D2 and D5 all want it (all three run a kernel over
   a grid) and all three would otherwise hard-code the grid size in WGSL — which is B85.
   Whoever builds these should confirm T472 is closed first.
6. **W3's per-point-colour-vs-lighting fork.** I asserted the fork from `geometry`'s
   compile, which never reads `parameterMaps`. If a track lands per-point colour on
   `geometry` today, D2's renderer choice reverses and D1 could drop its albedo route.
7. I have not tried to estimate build effort for any of these. Node counts are honest
   estimates from comparable shipped graphs; they are not schedules.
