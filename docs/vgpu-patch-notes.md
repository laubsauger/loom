# vgpu 0.3.1 — the four things we patch, and why

Loom is a browser WebGPU node compositor built entirely on `vgpu` (0.3.1 when this was written; pinned 0.4.1 since T1261, see the end). We carry a
patch against the published `dist` (pnpm `patchedDependencies` → `patches/vgpu.patch`,
sixteen hunks across twelve files, four independent themes). We would rather not: a pinned
dependency's diff is maintenance forever, and a silently dropped patch returns each bug
with no error.

So this is a question, not a diff. For each item: what we needed, what 0.3.1 does
today, why our workaround sits where it does, and — the part we actually want answered
— **whether there is a supported way we missed.** Every hunk carries the same reasoning
inline as a `// shaderloom patch (Tnnn)` comment, so the code and this note cannot
drift apart.

Two of the first three read to us like oversights rather than positions, and we say so.
The third we suspect is a deliberate performance default that we are simply an unusual
consumer of, and we say that too. The fourth (T1243) is a missing figure: the timer
resolves the raw timestamps and discards them after computing per-span durations, and
the frame's extent cannot be recovered from the durations.

---

## 1. Multi-pass MSAA: `storeOp: "discard"` kills samples at every pass boundary

**What we needed.** Anti-aliased geometry in a chain that reads its own render target
mid-chain: `render → cut → blur → glow → clip`. Aliased edges going into a bloom get
amplified, so the AA has to happen before the post chain, not after.

**What 0.3.1 does.** `colorAttachment()` sets `storeOp: msaa ? "discard" : "store"`,
`depthAttachment()` sets `depthStoreOp` / `stencilStoreOp` to `"discard"` whenever
`sampleCount > 1`, and `Frame.pass` refuses `clear: false` into a 4× target outright:

```
VGPU-PASS-PRESERVE-MSAA — clear:false cannot preserve MSAA; use a non-MSAA target.
```

**Why that is a problem for us and maybe not for you.** For a single-pass renderer,
discarding the multisample attachment after the resolve is exactly right — it is free
bandwidth on tilers and the samples are genuinely dead. Our chain is the case where
they are not: a later pass preserves into the same target, and the target's
multisampled texture persists across passes, so preserving is legal WebGPU. With
`discard`, the second pass loads garbage, and a preserve pass depth-tests against a
depth buffer that no longer exists.

**Our patch.** `storeOp: "store"` for colour and depth/stencil, resolve on every pass so
a mid-chain reader sees current resolved colour, and the refusal in `Frame.pass`
removed. Non-MSAA passes are untouched.

**Repro.** Any two-pass chain into one MSAA target where the second pass sets
`clear: false`. Today it throws `VGPU-PASS-PRESERVE-MSAA` before it can render.

**Is there a supported way we missed?** We could not find one — a second target plus an
explicit copy loses the samples, which is the whole point. If `discard` is the intended
default (we assume it is), the shape we would want is per-target or per-pass opt-in:
`target({ msaa: 4, preserveSamples: true })`, or having `Frame.pass` accept
`clear: false` on an MSAA target and switch that target's store op for the frame.
We would delete this hunk the day either exists.

---

## 2. A raw `GPUBufferBinding` is not recognised as a resource

**What we needed.** Point attributes packed into one storage buffer with per-attribute
regions, bound by byte offset, so a kernel spends 2 bindings regardless of attribute
count instead of 2 per attribute (WebGPU's baseline 8 storage buffers per stage was
capping us at four attributes). vgpu can bind a buffer at an offset, which is what made
this worth doing: every consuming shader keeps its `array<vec3f>` declaration unchanged.

**What 0.3.1 does.**

```js
function hasAnyResourceShape(value) {
  const record = value;
  return "gpu" in record || "bindGroup" in record || "createView" in record || "resourceIdentity" in record;
}
```

A bare `{ buffer, offset, size }` matches none of those, so `set()` classifies it as a
plain JS uniform value and throws:

```
VGPU-RING1-UNSUPPORTED — Binding '<name>' needs a compatible resource, not JS.
```

**This one looks like an oversight, not a position.** `normalizeBufferResource()`, in
the same file, already handles that exact shape via `isGPUBufferBinding` — it just never
gets the chance, because the classifier runs first and routes the value away. The
classifier and the normaliser disagree about what counts as a resource. Our patch adds
`|| isGPUBufferBinding(record)` to the classifier — one line, using the predicate the
file already defines.

**The second half, which we did not expect.** Fixing the classifier was necessary and
not sufficient. `normalizeBufferResource` identifies a `GPUBufferBinding` by
`syntheticIdentity(value.buffer)` — the buffer alone — so every region of one buffer
shares one identity. Two consequences, both wrong for us:

- the bind-group cache cannot tell two attributes apart, so an offset change does not
  invalidate the entry;
- `#preflightAliasing` reports two **non-overlapping writable** regions of one buffer as
  an alias and refuses the dispatch (`VGPU-R1-STORAGE-ALIASING`). Three of our kernels
  bind 3–4 regions of one buffer and all three broke on it.

Our patch lets a region carry its own `resourceIdentity`, falling back to the synthetic
one when absent.

**Repro.** `pipeline.set({ positions: { buffer, offset: 0, size: 4096 }, velocities: { buffer, offset: 4096, size: 4096 } })`
where both are `read_write` — `VGPU-RING1-UNSUPPORTED` before the classifier fix,
`VGPU-R1-STORAGE-ALIASING` after it.

**Is there a supported way we missed?** Passing `gpu: buffer` alongside the region does
get past the classifier, which is what we did first — but it is an undocumented shape
and it does not help with identity or aliasing. What we would want upstream is a first
class region binding, e.g. `buffer.region(offset, size)` returning something with its
own `resourceIdentity`, with `#preflightAliasing` comparing `[offset, offset+size)`
intervals rather than buffer identity. That is strictly more correct than what we
patched in, and we would delete both hunks for it.

Measured, in case it is useful: packing costs nothing at runtime. 1M points, 64
dispatches/frame, Dawn/Metal — separate `array<T>` with 8 bindings 0.759 ms
(144 GB/s), packed `array<u32>` with 2 bindings 0.755 ms (144 GB/s); the packed form
was never slower across two runs, and at eight attributes it still saturates 139 GB/s.

---

## 3. `clearDraw` exists with no callers, and nothing can reach it

**What we needed.** A way to stop `GPUBindGroup` objects accumulating for the life of
the device in an editing session that rebuilds programs continuously.

**What 0.3.1 does.** The gpu's one bind-group cache keys entries on
`` `${drawId}:${group}:${identities}` ``, and `bind-cache.js` defines exactly the
method we want:

```js
clearDraw(drawId) {
  const prefix = `${drawId}:`;
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}
```

It has no callers anywhere in the package, and no consumer can reach it: the cache is a
private kernel service, `kernelOf` is exported from no entrypoint, `package.json`
`exports` publishes only `.`, `./node`, `./mock`, `./scene`, `./client` and `./core`,
`drawId` is a closure-local counter, and `Draw` / `Effect` / `Compute` expose no
lifecycle method at all — no `destroy`, no `dispose`. That combination is what reads to
us like an unfinished API rather than a refusal.

**The two ways entries become unreachable.** Both are live in our app and neither has an
exit today.

1. **A discarded drawable.** Every `Draw`/`Effect` mints `nextDrawId++`, so a rebuilt
   program's replaced Effects leave their entries behind permanently.
   `subscribeEviction` reclaims an entry only when a resource the entry *names* is
   destroyed, so entries over surviving resources — a shader edit that rebinds the same
   target — survive with it.

2. **A live drawable whose binding slot rotates.** This is the one that actually cost
   us, and we think it is the more interesting bug. The eviction subscription is per
   binding **slot**, not per cache entry: `set()`ing a slot to a new resource
   unsubscribes the previous one, so the entry naming the old resource outlives that
   resource's `destroy()` with nothing listening. Our tile compositor is one long-lived
   `Effect` whose single texture slot is re-pointed at each of N tiles every frame; it
   ends up holding one entry per tile it has *ever* been shown, subscribed to one of
   them.

**Measured.** Headless, our real backend over `vgpu/mock`, with a closed-loop camera so
cycle N does byte-identical work to cycle 1 (40 nodes, 16 tiles, 5-second cycles),
counting *retained* bind groups by `WeakRef` after a forced GC rather than
`createBindGroup` calls:

| | control | patched |
|---|---|---|
| panning, per identical 5 s cycle | +12 unreachable, never decaying | 0 (flat at 35) |
| shader edit on a pass with no uniform block | +2 per edit | 0 (flat at 5) |

Notably it is **not** a CPU slowdown: per-identical-cycle wall time stayed flat out to
5606 entries. It is unbounded object growth over a long session.

**Our patch.** `evictBindGroups()` on `InternalDraw`, `InternalEffect` and
`ComputePipeline`, each calling the cache's own `clearDraw` with its own id. We call it
when a program's drawables are discarded and when the compositor's tiles are replaced.
It is safe by construction — the id prefix is unique per drawable and
`setCore.bindGroups()` calls `getOrCreate` on every encode, so an over-eager evict costs
a `createBindGroup`, never a wrong bind group.

We did look at cutting our own call rate instead, since 13–14 program rebuilds per five
seconds of panning is what feeds this. We could not: measured, the rebuilds are driven by
previews arriving at the viewport edge and by tile sizes changing on the zoom ladder, and
holding either back means holding back a picture the user is looking at. The cost of the
eviction itself is the other direction — the compositor re-mints one entry per live tile
after each evict, about 180 extra `createBindGroup` calls per five seconds of panning
(49 → 229). We took that trade against unbounded growth, but it is the trade that a
per-entry subscription (option 2 below) would remove entirely.

**Is there a supported way we missed?** We could not find one; `gpu.dispose()` is the
only exit and it takes the device with it. Three shapes would each work for us, in
increasing order of how much we would prefer them:

1. export `clearDraw` — or a `destroy()`/`dispose()` on `Draw`/`Effect`/`Compute` that
   calls it. Smallest possible change; it is already written.
2. make the eviction subscription **per cache entry** rather than per binding slot, so
   an entry dies with any resource it names, whoever is bound now. That fixes case 2
   without any consumer having to know the cache exists, and it is what we would
   actually recommend.
3. bound the cache (LRU per drawId, or a `maxBindGroups` on the gpu).

**One more thing we noticed and did not patch.** `nextDrawId` (draw.js) and
`nextComputeId` (compute.js) are separate counters that both key into the *same* cache,
so a draw and a compute can share an id. The identity tuple has to match too, so we have
not seen it bite, and the consequence of a collision would be a bind group built with
one layout handed to a pipeline expecting another. It may be worth a single shared
counter regardless.

---

## 4. The timer discards the raw timestamps, and per-pass spans cannot be summed into a frame

**What we needed.** One GPU figure for the frame: how long the GPU spent on the submit,
first pass begin to last pass end. It sits beside the per-pass column in the performance
panel and is what "is this document GPU-bound?" is answered from.

**What 0.3.1 does.** `Timer` attaches one `timestampWrites` pair per span, resolves the
query set once the frame's readback buffer maps, and `#dispatch` converts each pair to a
duration in ms and hands listeners `Readonly<Record<string, number>>`. The raw
timestamps are only ever seen inside `#dispatch`, and are dropped there.

**Why the durations are not enough.** We measured on Dawn/Metal (Apple silicon), 24 render
passes in one command buffer, each sampling the previous one's output: every pass's BEGIN
timestamp lands within 0.1 ms of the command buffer's start (0.000, 0.014, 0.026, 0.080 …)
while the ENDs are sequential (1.45, 2.89, 4.32 … 8.5 ms). Stage-boundary sampling on a
tiler: the vertex stages of every pass run up front, the "begin" is where the encoder
started, not where the fragment work did. The spans NEST, and their sum is ~(N+1)/2 × the
frame — 11.7× for N = 24, which is the ~10× disagreement the row was opened on. An empty
marker pass appended to the frame does not help either: it ENDS early (1.5 ms into a 9 ms
frame), because the GPU overlaps independent passes. Only `max(end) − min(begin)` over the
raw pairs is the frame, and only `#dispatch` has the raw pairs.

**Our patch** (`dist/timer.js`, `dist/timer.d.ts`, plus the `TimerFrameExtent` re-export
in the four entry `.d.ts` files): `#dispatch` computes the extent over the valid pairs of
the frame and hands listeners a second argument, `{ extentMs, frame }`, where `frame` is
the vgpu `Frame` the spans were attached to — that is how the caller ties a result back to
the submit it encoded, since results arrive a frame or two behind. No behaviour changes
for a listener that ignores the second argument.

**What we would prefer.** Either the same second argument upstream, or an `onRawResults`
that hands the resolved `BigUint64Array` with the span layout so the consumer computes
whatever figure it needs. Exposing the timestamps is the smaller ask; the extent is one
`min`/`max` away from them.

---

## What we would delete

Every hunk, immediately, for: an MSAA preserve opt-in (1), a first-class region binding
with interval-based aliasing (2), either an exported eviction call or a per-entry
eviction subscription (3), and a frame extent or raw-timestamp callback on the timer (4). We are happy to send patches upstream against any of these if
the shapes above are close to what you would want.

---

## Upstream status 2026-09-10

Audit for T1255 against `vercel-labs/vgpu` (`main` = v0.4.1 + docs commits at `96ced572`;
`canary` = the PR target, 102 commits past v0.4.1, unreleased).

**0.3.1 → 0.4.1 changes nothing this patch touches.** `compute.ts`, `draw.ts`, `effect.ts`,
`set-resources.ts`, `target-utils.ts`, `timer.ts`, `init.ts` and `bind-cache.ts` are
byte-identical between the two tags; `frame.ts` changed (0.4.0 made `frame(gpu, cb)` and
`frameLoop` cancel the frame on throw instead of submitting on finally — `2d137a4`) but not
in the `passPreserveMsaaError` region our hunk edits. The entry files only add
`ShaderFunctionExport`; `package.json` adds a `./three` export and an optional `three` peer.
The four themes are all **still needed, unchanged**: nothing upstream fixes any of them.

| Theme | 0.4.1 | canary (next release) |
|---|---|---|
| 1 MSAA `storeOp` | needed, applies clean | needed; `target-utils.ts` `validateTargetOptions` and `target-offscreen.ts` (`#currentColors`) moved adjacent lines — context conflict only |
| 2 raw `GPUBufferBinding` + region identity | needed, applies clean | needed; `set-resources.ts` grew (+70 lines: destroyed-binding wrapper, storage textures, `resourceLabel`) but `hasAnyResourceShape` and the `isGPUBufferBinding` line are unchanged — context conflict only |
| 3 `evictBindGroups` | needed, applies clean | **semantic conflict**: canary keys a compute's cache slot `compute:${id}` (fixing the draw/compute id collision noted above), so our `this.cache.clearDraw(this.id)` in `compute.js` must become `clearDraw(\`compute:${this.id}\`)` or evict nothing |
| 4 `TimerFrameExtent` | needed, applies clean | needed; `timer.ts` byte-identical to main — cherry-picks clean |

**Trial upgrade to 0.4.1** (scratch copy, own install): `pnpm install` applied the patch with
zero warnings (`frame.js` hunk with offset); `pnpm typecheck` clean; Dawn gates
`bind-group-eviction`, `point-packed-attributes`, `scene-antialias`, `dawn-render`,
`matte-coverage`, `frame-extent`, `headless-parity` all green; `pnpm test:gates` green;
`src/runtime/backend/vgpu` 283/283. One failure, `cook-oracle.test.ts` E66-Meter
"auto is byte-identical to always", fails identically on 0.3.1 at HEAD — pre-existing, not the
upgrade. The one thing the numbers do not cover: 0.4.0's cancel-on-throw at
`vgpu-backend.ts` `frameLoop` / `frame(gpu, …)` call sites is a semantic change (a throwing
encode used to submit whatever was encoded; now it submits nothing). Review those three sites
before bumping the pin.

**Patches by case** were prepared as one branch per theme on upstream `main`, each with a
`PR.md`, changeset, tests (upstream had none for themes 3 and 4's contracts) and green
typecheck/build/bundle-check: `loom/msaa-discard-store` (opt-in `preserveSamples`, not a
default flip), `loom/buffer-binding-resource` (classifier + range identity + interval-based
aliasing preflight), `loom/clear-draw` (`evictBindGroups()` on Draw/Effect/Compute with the
`compute:` key), `loom/timer-frame-extent`. Not pushed; see the T1255 report for paths.

## Pinned 0.4.1 (T1261, 2026-09-10)

`package.json` pins `vgpu` 0.4.1; `patches/vgpu.patch` is byte-identical and its lockfile
hash unchanged (`fp5cunzchnnbwyhn5a36cnah3q`) — pnpm applied it with the `frame.js` hunk
offset only. The one semantic change 0.4.0 brought, `frame(gpu, cb)` / `frameLoop`
cancel-on-throw, was decided per encode site in `src/runtime/backend/vgpu/vgpu-backend.ts`
and pinned on Dawn by `frame-throw.gpu.test.ts`:

- **loop path** (`runFrame`): partial submit, unchanged — the T98 catch inside the callback
  is what keeps it so; a throw that escaped would now also stop the `frameLoop`.
- **direct path** (`encodeSegmented`): partial submit, opted in with `f.submit()` in the
  callback's own catch — the same state as the loop path (§V47), consistent with the CPU-side
  swaps and self-submitting dispatches that are never rolled back. `render()` still rethrows.
- **temporal-history clear**: dropped whole, vgpu's new default accepted — a reset that throws
  leaves every pair as it was rather than one half cleared.

The four patch themes are still needed, unchanged (see the audit above).
