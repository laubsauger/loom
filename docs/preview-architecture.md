# Preview architecture — design note

**Task T113.** Written before `src/runtime/previews/**` and `src/editor/viewer/**` exist, because
the spec makes it a deliverable: getting the surface model wrong means rewriting the preview
system rather than adjusting it.

Cites: §V7 (previews GPU→GPU), §V8 (no allocation in the frame loop), §V16 (preview pixels never
enter the document store, UI ≤ 10 Hz), §V28 (only visible or pinned previews scheduled), §V47
(execution renders offscreen without a surface), §V48 (readback only behind the export interface),
§V59 (`OutputRef = {nodeId, portId}`), §V64/§V70 (surfaces handed to the runtime, N per output),
doc §12.

---

## 1. The question

Handoff doc §12.2 says "do not use one canvas per node" and recommends "a single GPU preview atlas
or shared preview canvas". Those are two different things, and the spec's own wording ("preview
atlas design note … atlas-behind-DOM vs per-node canvas") collapses them. Three designs are
actually on the table:

| | presentation surfaces | preview render targets | sub-rect rendering needed |
|---|---|---|---|
| **A** per-node `<canvas>` | N (one context + swapchain per node) | N small targets | no |
| **B** one canvas + one atlas texture | 1 | 1 large texture, tiles are sub-rects | **yes** |
| **C** one canvas + pooled tile targets | 1 | N pooled targets, keyed by size+format | no |

## 2. Conclusion

**C: one shared preview surface behind the DOM, fed by a pool of fixed-size offscreen tile
targets.** Per-node canvases (A) are rejected outright. A literal single-texture atlas (B) is
rejected for this codebase, and the reason is specific rather than aesthetic.

### Why not A (per-node canvas)

The cost that matters is not "a canvas element" — it is the WebGPU canvas *context*. Each one owns
a swapchain (≥ 2 textures at device-pixel size), needs `configure()` on every resize and every
device-pixel-ratio change, produces a `getCurrentTexture()` that is only valid inside one frame,
and gets its own browser compositor layer.

Concretely, at the spec's default preview size (192 CSS px long edge, §I `ProjectSettings.previewLongEdge`)
on a dpr-2 display, one `rgba8unorm` tile is 192 × 108 × 2 (dpr) → 384 × 216 × 4 B ≈ 332 KB, so a
double-buffered swapchain is ≈ 0.65 MB, plus per-context driver state. Forty visible previews is
≈ 26 MB of swapchain nobody asked for and, worse, forty compositor layers that the browser must
re-composite on every pan frame — while React Flow is already animating a CSS transform over the
whole viewport. The single-surface path costs one swapchain and one layer whatever the node count.

There is a second, harder problem: device loss (§V23) and worker migration (§C "renderer-in-worker
COMMITTED Phase 2"). Rebuilding N contexts after a device loss is N times the failure surface, and
`OffscreenCanvas` transfer is per-canvas — moving the renderer into a worker with forty transferred
canvases is a different program from moving it with one.

Doc §12.2 permits A "as an acceptable proof-of-concept fallback". We do not implement it. A fallback
we never build cannot rot, and the architecture explicitly must not depend on it.

### Why not B (single atlas texture, tiles as sub-rects)

B is the textbook answer and it is the wrong one *here*, for a reason that is about this codebase
rather than about atlases:

**The plan IR has no viewport or scissor.** `EffectPassDescriptor` in `src/runtime/backend/plan.ts`
names a `target` resource id and renders to the whole of it. Rendering into a sub-rect of a shared
texture requires either a `viewport` field on the pass descriptor or a per-tile UV-offset
convention baked into every preview shader. The pass and resource kinds are closed unions that the
compiler and backend switch on exhaustively (§V58) — growing them is a barrier-level contract
change owned by the compiler and backend tracks, not something the preview track may do mid-wave
(§P "track ⊥ edit file outside owned paths"). Buying a sub-rect mechanism costs a cross-track
contract change; the thing it buys is described below and is worth much less.

What B actually buys over C is **one texture allocation instead of N**, which pays when the tiles
are numerous, tiny, and uniform — a glyph cache. Preview tiles are none of those. There are ~40 at
the high end, each ~330 KB, each with **its own aspect ratio** (the source output's) and **its own
size**, which steps whenever the graph zoom crosses a ladder step (§4). Packing rectangles of
varying size into a fixed page is a bin-packing problem with fragmentation, and it has to be
re-solved whenever a tile resizes — so a texture atlas would repack, and therefore invalidate
tiles, on exactly the gesture (zoom) that C handles by swapping a handful of pooled targets.
That is the reallocation churn §V8 exists to prevent, reintroduced by the mechanism that was
supposed to avoid it.

(One thing that does *not* argue against B, and is worth recording so nobody re-derives it as a
reason: preview tiles are all the same format. The debug effects end with an explicit display
encode (§V56), so a tile holds display-ready `rgba8unorm` whatever the source was — `rgba16float`,
`r32float` or 8-bit. Format diversity lives on the *source* side of the preview pass, not the tile
side.)

**C keeps the atlas's actual benefits.** The benefits of an atlas that matter for previews are (i)
one presentation surface, (ii) stable allocation across pan/zoom, (iii) a bounded tile count. C
gets (i) from the shared canvas, (ii) from pooling on a quantised size ladder (§4), and (iii) from
the same budget logic an atlas would need anyway. What C gives up is a marginal reduction in
texture-object count, and one draw call per tile instead of one instanced draw — both of which are
noise next to a single compositor layer.

**The threshold, stated concretely.** Per-node surfaces are defensible only while the visible
preview count stays below roughly **four**: at four 192 px dpr-2 tiles the per-node swapchain
memory (≈ 2.6 MB) and layer count are comparable to a single screen-sized shared surface, so
neither design is clearly cheaper. Above four, per-node loses on memory, on compositor work per pan
frame, on device-loss recovery, and on worker transfer, simultaneously. A graph the spec is sized
for — §P/§T talk about 200-node graphs — is never below the threshold, so the threshold exists in
this note only to record that it was computed, not because we intend to sit near it.

### The invariant this buys

Because there is exactly one preview surface and its tiles are pooled by `(width, height, format)`,
the set of preview *resources* changes only when the set of active previews changes or when a tile
crosses a size-ladder step. It does **not** change when the graph pans, zooms, or when a preview
refreshes. That is §V8 ("no render-target allocation inside the frame loop") holding by
construction rather than by discipline.

---

## 3. How tiles track pan and zoom

The shared preview surface is a sibling of the React Flow viewport, covering the graph pane, and is
**not** transformed by the viewport. Node chrome (title, ports, badges) stays in the DOM; the
preview region of each node is a transparent hole punched through it, and the tile is composited
underneath at that hole's screen rect. This is doc §12.2 step 4 — "place lightweight DOM node
chrome over or around the corresponding visual area".

Two things then have to stay in sync, and they run at different rates:

- **Tile content** — rendering the source output through a debug preview effect into the tile
  target. Runs at `ProjectSettings.previewFps` (15–30, default 20), independently per preview, and
  independently of the main output's rate.
- **Tile placement** — compositing tiles onto the surface at their current screen rects. Runs every
  display frame, because a pan gesture moves every rect every frame while changing no pixels inside
  any tile.

Separating those is the whole reason `PreviewFrameCommand` distinguishes `refresh` (which previews
re-render) from `composite` (where every live tile lands). Fusing them would either re-render every
preview during a pan — the exact "graph scrolling becomes expensive" failure doc §12.2 warns about —
or smear stale tiles across the surface at the wrong positions.

**Rects are computed, never measured.** The naive implementation calls `getBoundingClientRect()` on
each preview slot every frame; with 40 slots inside a transformed subtree that is 40 forced layouts
per frame during the one gesture where the browser is already busiest. Instead the rect is derived
analytically from data we already have:

```
screen = (graphPosition + slotOffsetWithinNode) * zoom + pan
size   = slotSize * zoom
```

`graphPosition` is domain data (`GraphNode.position`), `slotOffset`/`slotSize` are fixed by the
node's CSS box, and `(pan, zoom)` is the viewport transform React Flow already reports. `geometry.ts`
holds that as pure functions, so it is testable without a DOM and cannot thrash layout. A slot may
still measure itself **once** when its CSS box changes; it never measures per frame.

**Off-surface culling falls out of the same math.** A rect that does not intersect the surface is
offscreen, which is §V28's first suspension reason, and it is decided from arithmetic rather than
from an `IntersectionObserver` whose callbacks arrive a frame late.

---

## 4. devicePixelRatio × graph zoom

These two multiply, and treating either one as "the" scale is the classic way to get a blurry or a
ruinously expensive preview.

The **CSS** size of a tile on screen is `previewLongEdge * zoom`. The **physical** size it must be
rendered at to look sharp is `previewLongEdge * zoom * dpr`. So:

```
onScreenLongEdge = previewLongEdge * zoom          // what the slot occupies, CSS px
requested        = onScreenLongEdge * devicePixelRatio
physical         = ladderSnap(min(requested, previewLongEdge * MAX_TILE_SCALE))
```

`tileSizeFor` takes `onScreenLongEdge` directly rather than re-deriving it from zoom, so the same
function sizes a node tile and the viewer pane's much larger one, and neither can drift from what
the user is actually looking at.

Four decisions are folded into that line, each of which has a wrong alternative:

1. **Snap to a ladder** (64, 96, 128, 192, 256, 384) instead of using the exact number. Zoom is
   continuous; a continuous physical size would reallocate every tile target on every frame of a
   zoom gesture, which is §V8 violated in the most expensive possible way. Snapping means a zoom
   gesture crosses at most a handful of ladder steps, and each crossing is a pool swap of a handful
   of targets. Ladder steps are ~1.5× apart, so the worst-case sharpness error is ~22 %, which is
   invisible at thumbnail scale.

2. **Snap up, not to nearest.** A tile is filtered down to its destination rect; downsampling is
   cheap and looks fine, upsampling is what reads as "broken". `ladderSnap` therefore takes the
   first step ≥ requested.

3. **Cap at `previewLongEdge * 2`** (384 px by default). Uncapped, dpr 2 × the graph's max zoom of
   2.5 gives 960 px per tile — a "thumbnail" costing 3.7 MB. Past the cap, a zoomed-in node preview
   goes deliberately soft, and the honest answer to "I need to see this properly" is the large
   viewer pane (T36), which renders the output at its own pane size. Writing the cap down is the
   point: the alternative is a preview system whose cost is unbounded in a UI gesture.

4. **Floor at the ladder's first step, and suspend below a minimum on-screen size.** The ladder's
   own first entry (64 px) is the floor, so no separate constant is needed. When the graph is zoomed
   out far enough that a preview would occupy fewer than ~24 CSS px on its long edge, the tile
   carries no information a user can read, and rendering it is pure cost. That is a §V28 suspension
   with reason `too-small`, and it is what makes zooming out over a 200-node graph get *cheaper*
   rather than more expensive.

**dpr is an input, never a global read.** `src/runtime/**` is lint-banned from `window` and
`document` (T92, §V63) so the runtime stays worker-movable, and `devicePixelRatio` is a `window`
property. It is therefore passed in from the editor. That also makes the "user drags the window to
a different-density monitor" case a normal input change — dpr moves, `requested` moves, the ladder
may or may not step, and the pool handles it exactly like a zoom.

---

## 5. Where readback is and is not

§V7 is a hard line: nothing on the scheduling or refresh path reads pixels back. Concretely, no
module under `src/runtime/previews/` names `readOutput`, `mapAsync`, or `copyTextureToBuffer`; a
test asserts that by scanning the sources, rather than by a comment nobody re-reads.

The one permitted exception is the viewer's "pixel value under the cursor" (T36), which is
explicit pixel inspection — precisely what §V7 carves out. It goes through the export interface
(§V48) as a **1 × 1 window** readback returning a descriptor plus bytes (§V60), throttled to
≤ 10 Hz (§V16), issued only while the pointer is over the image, and never from the frame loop. A
full-frame readback to sample one pixel would be the wrong shape by three orders of magnitude and
is not what the interface offers.

---

## 6. Scheduling model (T34)

Per display frame, given the current preview requests and the frame input:

1. **Classify.** Each request is `active` or suspended with a stated reason — `collapsed`,
   `offscreen`, `occluded`, `too-small`, `not-visible` (not visible and not pinned), or `budget`.
   Pinned previews skip the visibility reasons entirely: pinning is the user saying "keep this
   alive even when I scroll away", which is exactly what §V28's "visible **or** pinned" means.
2. **Budget.** If more previews survive classification than there are tiles, the surplus is
   suspended with reason `budget`, ordered deterministically: pinned first, then larger on-screen
   area, then `nodeId:portId` as a tiebreak so the result never depends on map iteration order.
   Determinism here is not fussiness — a nondeterministic budget produces previews that flicker in
   and out between frames for no visible reason.
3. **Due.** An active preview refreshes when `time - lastRefresh >= 1 / fps`. `fps` defaults to
   `ProjectSettings.previewFps` and is per-preview overridable. The main output's rate is not
   consulted anywhere, so a 60 fps output with 15 fps previews renders previews on roughly every
   fourth frame, and a paused output still lets a pinned preview tick if something upstream moved.
4. **Compose.** Every active preview composites every frame, due or not (§3).

Suspension **releases the tile**. A suspended preview holding its target would make §V28 a
scheduling optimisation rather than a memory one, and the 200-node graph would still melt.

---

## 7. The seam (T87) — implemented

`backend.previewHost(canvas)` returns `PreviewHostHandle`, which is this directory's
`PreviewRuntimeHost` plus a `dispose()`. The backend imports the interface type-only from
`src/runtime/previews/types.ts`, so neither track edited the other's files and the interface is
the single thing keeping them in step — `host-contract.test.ts` fails to compile if it drifts.

```ts
interface PreviewRuntimeHost {
  setPreviewProgram(program: PreviewProgram): void;  // allocates; OUTSIDE frame encoding (§V8)
  presentPreviews(command: PreviewFrameCommand): void; // never allocates; inside a frame or not
}
```

`PreviewProgram` is plain data — `ResourceDescriptor[]` and `EffectPassDescriptor[]` from the
existing plan IR — so it is structured-clone-safe (§V63) and needed no growth of the closed pass
or resource unions (§V58). Tile passes sample the main program's outputs as **external bindings**
(lookup-only: never rendered into, never destroyed by preview lifecycle), which is what lets a
preview reference a compiled output without owning it.

**The phase split follows from the seam, and is the one thing the design changed to meet it.**
`setPreviewProgram` builds tile targets and pipelines, so the backend guards it with
`assertOutsideFrame` — and `backend.loop(onFrame)` runs its callback with a frame already open.
A single `update()` that did both would therefore throw the first time a debug mode changed
while driving previews from inside `loop()`. So `PreviewSystem` exposes:

- `plan(input)` — schedule, build, hand over the program. Outside the frame.
- `present(command)` — encode the due passes, composite every tile. Inside or outside.
- `update(input)` — both, for a standalone tick.

That is not a workaround for the guard; it is §4's stable/per-frame distinction showing up a
second time, now as a hard boundary rather than a convention.

**Two things the implementation settled that this note had guessed at.**

*Compositing needs no scissor.* vgpu supports a **viewport per pass**, so each tile blits to the
shared surface at its own dpr-scaled viewport. The atlas rejection in §2 rested on
`EffectPassDescriptor` having no viewport or scissor for **rendering into** a sub-rect, which is
still true and still the reason tiles are pooled targets. Compositing **out of** them turned out
to be free. The bin-packing argument against a texture atlas — varying aspect ratios, sizes that
step with the zoom ladder, repacking on the one gesture that must stay cheap — stands on its own.

*Refresh cadence costs a set membership.* `PreviewFrameCommand.refresh` names pass ids and the
host encodes only those, which is the pass-subset capability §6 needed. Cadence therefore never
rebuilds a plan.

### Ordering: a program before the first main compile

A preview program installed before the first main compile builds its tiles but leaves the
main-output external bindings unresolved until the compile fires `refreshPreviewExternals` — one
blank tick.

**This cannot happen through the intended wiring, so no lazy rebind is needed.** A
`PreviewRequest` carries `source.resourceId`, which only exists once `CompiledGraph.outputs` has
been produced. There is nothing to reference before the first compile, so the composition root
has nothing to request and `plan()` emits an empty program. The ordering constraint is satisfied
by the shape of the data rather than by a rule anyone has to remember.

### Recompiles, device loss, and §V28a

External bindings are re-pointed after every main compile and ping-pong sources per frame, so a
structural recompile does not interrupt previews. Device loss rebuilds the surface and tiles from
the retained program; `PreviewSystem.reset()` remains the caller's way to drop **cadence** state
(refresh clocks and tile keys), which the backend cannot know about.

§V28a — an explicit sink list is authoritative, an empty list means none — matches the scheduler's
existing shape exactly: `PreviewSystemFrame.requests` is the only thing consulted, nothing is
unioned with document `ui.preview` flags, and an empty array frees every tile rather than leaving
the previous frame's live. Both halves are asserted in `system.test.ts`, because "empty means
nothing was said" is precisely the plausible-looking mistake V28a was written against.
