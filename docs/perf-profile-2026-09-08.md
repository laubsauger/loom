# Main-thread profile — 2026-09-08 (T1235)

A measurement, not a fix. The question it answers: on a graph of a few dozen nodes, with
the transport playing, where does the browser's main thread spend a frame, and what
changes under the interactions that feel slow? Every number below carries how it was
measured, N, and a same-run control (§V929). Every interactive scenario ran twice in
opposite order (§V933). The shares are a claim about THIS tree at commit `d8eabb8`
(chain-200 at `971056b`, probe at `d589457`; the intervening commits are T1229 timeline-read fix, T1236 E66 example and SPEC rows)
under a dev build, and they expire the moment the biggest item moves (§V934) — after a
fix, re-run, do not subtract.

Harness: `src/tests/e2e/perf/` (Playwright + CDP `Tracing.start`, own parser in
`src/tests/perf/trace-parser.ts`). Run: `src/tests/e2e/perf/run.sh <out dir>`. It is not
part of `pnpm test:e2e`; only its own config matches `*.perf.ts`.

## 1. The ranked tree

Shares are of the busy main thread inside the scenario's window, mean per display frame
where a frame is one `FireAnimationFrame` interval. `busy` = sum of `RunTask` spans;
`(program)` = V8's native/external state (WebGPU and canvas bindings, style/layout/paint
driven from script) and OVERLAPS the trace-event columns, so columns do not add up.

### 1.1 Idle, transport playing (scenario A) — the cost of doing nothing

E24 (74 nodes / 76 edges), 100 Hz display, 4 passes (2 dock tabs × 2 orders), N = 479–491
frames each. Frame interval p50 9.98 ms; busy p50 5.6–6.5 ms, p95 14–17 ms, mean 6.6–7.0
ms. Controls: cheap spin 0.36–0.38 ms, dear spin 9.8–10.0 ms, identical across all 14
E24 windows, so the machine did not drift inside the run.

| rank | item | ms per 5 s window (E24 idle) | ms / frame | evidence | file(s) |
|---|---|---|---|---|---|
| 1 | React render + commit driven by the 10 Hz samplers | 600–709 ms across 243–251 commits | 1.2–1.5 | devtools hook, `actualDuration` sum; commit groups below | `src/editor/nodes/value-plot.tsx`, `src/editor/inspect/performance-panel.tsx`, `src/app/timeline-scrubber.tsx` |
| 2 | vgpu frame loop (`runFrame` → encode/submit) | 741–768 ms | 1.5 | inclusive time of `tick @ vgpu.js`; leaf `backend` 1.19–1.25 + part of `(program)` | `src/runtime/backend/vgpu/vgpu-backend.ts` |
| 3 | Render pipeline: Layout+PrePaint+Paint+Layerize+Commit every frame | 621 ms (480 full-viewport Paints, 412 Layouts, 457 Layerize) | 1.3 | trace spans; paint clip 1920×1200 on 480/2421 Paint events; no forced layouts (0 stack traces) | `src/app/timeline-scrubber.tsx:148-149` writes `style.width` + `style.left` per rAF (see §3, probe) |
| 4 | Node preview tick | 470–489 ms | 1.0 | `tick @ use-node-previews.ts` inclusive: `previews/system update` 393, `buildPreviewProgram` 149 (70 self) | `src/app/use-node-previews.ts`, `src/runtime/previews/system.ts:131` |
| 5 | Per-frame full `compileGraph` (animated document, §V163) | 347 ms | 0.7 | `compileGraph` inclusive; leaf `compile` 0.32–0.36 ms/frame; `passStructureKey` 104 (95 self) inside it | `src/app/use-graph-compile.ts:449-480`, `src/runtime/backend/plan.ts:508` |
| 6 | ValuePlot (34 plots, 10 Hz) | 322 ms (project 134 self) | 0.65 | function time; 61 commits `ValuePlot×34` at 5.5 ms each in the knob window | `src/editor/nodes/value-plot.tsx:167` |
| 7 | React dev-only instrumentation | `jsxDEV` 411 (self ~280), `measure` ≈ 120, `logComponentRender` | 0.8–1.0 | dev build only; absent in `pnpm build` output | vendor |
| 8 | Graph background tick | 73–116 ms | 0.2 | `tick @ use-graph-background.ts` | `src/app/use-graph-background.ts` |
| 9 | Value-graph evaluate (§T1179 suspect) | 75 ms | 0.15 | function time | `src/app/use-value-graph.ts` |
| 10 | Telemetry hub flush/notify | 1.5–2.4 ms | <0.01 | function time of `hub.ts` flush; leaf `telemetry` 0.03–0.04 ms/frame | `src/runtime/telemetry/hub.ts` |
| — | GC | 65 ms (MinorGC ~45×) | 0.13 | trace | — |

Leaf-category means per frame, E24 idle, pass 1 examples tab / performance tab
(`react 1.61/1.47, backend 1.25/1.19, compile 0.36/0.34, previews 0.57/0.61, domain
0.43/0.43, editor 0.37/0.36, gc 0.15/0.13, (program) 1.79/2.15`). The dock tab makes no
difference to the total (6.77 vs 6.83 ms mean): every dock pane stays mounted
(`pane-portal`), so the performance panel's 94 `CostCell`s re-render at 10 Hz whether or
not the tab is showing.

Same scenario, other fixtures (mean busy ms/frame; leaf react / backend / previews / program):

| fixture | nodes/edges | interval p50 | busy p50 / p95 / mean | react | backend | previews | compile | program |
|---|---|---|---|---|---|---|---|---|
| E24 | 74/76 | 9.98 | 5.6 / 16.9 / 6.8 | 1.6 | 1.25 | 0.57 | 0.36 | 1.8 |
| E55 | 42/42 | 19.7–27.5 (GPU-bound) | 5.3 / 17.0 / 7.2 | 2.5 | 0.64 | 0.31 | 0.22 | 2.1 |
| untitled-8 | 30/20 | 10.00 | 2.7 / 12.4 / 3.5 | 1.1 | 0.53 | 0.30 | 0.18 | 1.0 |
| chain-200 | 200/199 | 10.00 | 5.9 / 27.8 / 9.1 | 3.2 | 0.98 | 0.07 | — | 2.5 |

(chain-200 row: A performance-tab pass 1, the one idle window of that fixture with no foreign
input; see §5. The chain has no animated parameter, so no per-frame compile; `previews`
leaf is small because most of its 200 tiles are off screen and the `tick` cost lands in
`program`/react instead — `tick @ use-node-previews.ts` is still 465 ms/5 s inclusive.)

### 1.2 Paused (scenario B)

E24 paused: busy p50 1.3 ms, mean 1.4 ms, 51 commits/5 s, NO Paint or Layout at all —
confirming that the per-frame render pipeline in idle-playing is a consequence of the
transport, not of the page. What remains at 100 Hz while paused: `tick @
use-node-previews.ts` 450–470 ms/5 s (0.9 ms/frame, 65 % of the paused busy time), the
graph-background tick 14–21 ms, the scrubber `paint` rAF 0.4–0.6 ms. The preview tick runs
at display rate whether or not anything changed.

### 1.3 Knob drag (scenario C) — the one that saturates the thread

E24 `chem.Brightness`, 120 pointer moves over 2 s per pass, 2 passes: busy mean 13.5–14.3
ms per 9.1–9.3 ms interval — the main thread is over budget on every move. Input latency
(dispatch → end of next `Commit`) p50 29.5–30.0 ms, p95 64–80 ms, max 88 ms, N = 120/232.
Leaf `react` 5.3–5.8 ms/frame; 611–615 commits in 8.1–8.7 s.

What React does per document change (devtools hook, pass 1, 611 commits):

| commits | fibers rendered | render ms each | total | what |
|---|---|---|---|---|
| 118× | `NodeIdentity×108 CostCell×94 Presence×44` (971 fibers p50) | 15.7 | 1851 ms | `App` re-renders on every document revision; the node LIBRARY (108 rows), the performance panel and the help/pipeline panels re-render with it |
| 61× | `ValuePlot×34 FunctionPlot×2` | 5.5 | 337 ms | 10 Hz sampler |
| 58× | `CostCell×94 Stat×13 PerformancePanel×1` | 1.6 | 91 ms | 10 Hz hub sampler |
| 113× | `Button×11 ComponentLibrary×1 LibraryPanel×1` | 0.3 | 37 ms | per document change |
| 123× | `Tooltip×2 TimelineReadout×1 Popper×1` | 0.2 | 22 ms | ~15 Hz |

React total 3.9 s of 8.1 s busy (render 2.5, commit 1.3, passive effects 0.9). Dev-only
`measure` 672 ms and `jsxDEV` 993 ms (430 self) are inside that. The per-frame animate
compile is 684 ms (8.1 s window); the document-change compile path is ≈160 ms total ≈
1.3 ms per move — §T1176's full-compile-per-move is gone, and the compile is not what
the knob waits on.

The same knob on untitled-8 (30 nodes): busy mean 12.5–12.7, react 7.0–7.3 ms/frame,
latency p50 22.6–23.6 ms. On E55 (42 nodes): react 7.6–8.8, latency p50 25.5–26.6 ms.
The knob-drag cost is therefore NOT bound by node count — it is bound by what `App`
re-renders on a revision (the library's 108 rows are the same on every fixture).

### 1.4 Node drag (scenario D)

E24: busy p50 9.0–10.0 / p95 17–20 ms, latency p50 5.9–6.2 ms, N = 240 per pass. Only the
two connected edges re-render (100× `NodeToggle×3 EdgeWrapper×2 SignalEdge2×2`, 0.84 ms
each) — §T1187's "every edge draws every render" does NOT show in drag or pan. The `App`
re-render fires twice (drag start / drag end, 36 ms each). xyflow leaf ≤ 0.2 ms/frame.
Paint 486 ms per 3.4 s window (the moving node repaints the canvas layer).

chain-200: busy p50 7.5–7.9 / p95 31–35 ms, latency p50 3.1–3.4 ms, max 53–105 ms. The
`App` re-render (`CostCell×334 NodeIdentity×107 Presence×42`, 1159 fibers, 15.6–16.6 ms
each) fires 14–17× inside the 2 s drag, not twice — every one of them is a > 1 frame
stall, and they are the p95 tail.

### 1.5 Pan / zoom (scenario E)

E24: interval p50 15.3–15.8 ms — frames are DROPPED on a 100 Hz display; busy p50
10.4–10.6 / p95 20–21 ms; latency p50 6.6–6.7 ms. `(program)` 1.58 s of 4.04 s busy ≈
Paint 364 + Layerize 306 + Commit 219 + Layout 210 + HitTest 140 ms. The 10 Hz samplers
keep committing underneath the gesture (51× `ValuePlot×34` 340 ms + 57× `CostCell×94`
210 ms = 550 ms of a 5.8 s window).

chain-200: busy p50 11.0–11.4 / p95 55–60 ms, 6.1–6.3 s busy of 6.6–6.8 s; latency p50
8.2–8.3, p95 55, max 109–134 ms. Paint 17.7 k events / 741 ms, Commit 468–484, Layout
273–277, EventDispatch 507–648 ms (the wheel handler itself: handler p50 0.94 ms).
React 2.6 s inclusive; `App` re-render group fires ≈ 40× (13+10+5+2+6+… commits of
1087–1174 fibers at 12–38 ms each) — the zoom steps change the document (viewport is
persisted), and each change re-renders the library and the performance panel's 334
`CostCell`s. HitTest: Chrome re-hit-tests the stationary pointer after every layout
(`HitTest move:true` on `.react-flow__pane`), ≈ 1 ms/frame at 200 nodes, 352 ms/5 s even
idle.

### 1.6 Select + inspector (scenario F)

E24: 3 clicks, latency 33–62 ms each (N = 3 per pass, both passes), 27 commits; one
`NodeIdentity×108 CostCell×94` `App` re-render at 13–15 ms per selection change plus one
57 ms on untitled-8 pass 1. Too few samples for a p95; reported as the raw values.

## 2. Suspects the §T row named — confirmed or cleared

| suspect | verdict | measurement |
|---|---|---|
| §T1179 value-graph topology rebuilt per frame | present, MINOR | `use-value-graph` evaluate 75 ms/5 s = 0.15 ms/frame on E24 idle (N = 480 frames). Fixing it buys ≈ 2 % of the idle frame. |
| §T1182 uniform-only path | CONFIRMED lead among compiler items | `compileGraph` 347 ms/5 s idle (0.7 ms/frame), 684 ms/8.1 s under knob drag; runs every frame because `hasAnimatedParameters(flatGraph)` is true for E24 (`use-graph-compile.ts:449`). |
| §T1183 resource-only rebuild | secondary | `passStructureKey` 104 ms/5 s (95 self) — inside the per-frame compile above, so it goes when §T1182 goes. |
| §T1187 every edge draws every render | NOT observed in drag/pan | 100× `SignalEdge2×2` in E24 drag — the two edges of the dragged node only. Not exercised: a document change that touches many edges at once. |
| §T1212 pass count | NOT measurable from the CPU side | the trace's `GPUTask` is GPU-process CPU (1055 ms/5 s on E24), not GPU execution; see §4 on the hub's own GPU number. |
| preview tiles blitting at full rate while off-screen | CONFIRMED as a per-frame cost, magnitude modest | `tick @ use-node-previews.ts` 470–489 ms/5 s playing AND 450–470 paused on E24; 465 on chain-200 where most tiles are off screen. Inside it `buildPreviewProgram` is rebuilt EVERY tick and compared by signature (`system.ts:131`): 147–149 ms/5 s. |
| telemetry hub `noteFrame`/flush | CLEARED | hub flush 1.5–2.4 ms per 5 s; leaf `telemetry` 0.03–0.04 ms/frame. |
| the 10 Hz sampler re-rendering the panel tree | CONFIRMED, top item at idle | 243–251 commits/5 s summing 600–709 ms on E24 idle; `PerformancePanel` group 2–4 ms each, `ValuePlot×34` 5.5 ms each, ~10 Hz each; on chain-200 the `CostCell×334` group is 5–12 ms each. |

## 3. The per-frame render pipeline (item 3) — what writes the DOM every frame

Idle-playing E24 shows 480 Paints with a full-viewport clip (1920×1200) in 480 frames, 412
Layouts (dirty objects p50 12, max 634, zero forced — no `stackTrace`, so nothing reads
layout from script), 457 Layerize. Paused: none. The code has one per-rAF DOM writer on
the playing path: `timeline-scrubber.tsx:148-149` sets `style.width` on the elapsed bar and
`style.left` on the playhead each display frame (T456, deliberately outside React). `left`
and `width` invalidate layout, and a layout dirties the pointer hit-test.

**Subtraction probe** (`PERF_PROBE_CSS='[role=group][aria-label=Timeline]{display:none}'`,
E24 scenario A only, HEAD `d589457`, 4 windows of 475–495 frames each, controls cheap
0.36–0.38 / dear 9.8–10.1 ms):

| per 5 s window | scrubber hidden (probe) | run1, same display (DPR 1, 100 Hz) | control, same session (landed on a DPR 2 / 120 Hz display, 570–580 frames) |
|---|---|---|---|
| Layout events | 126–149 (0.26–0.31 / frame) | 412 (0.86 / frame) | 389–409 (0.68–0.71 / frame) |
| Layout ms | 76–138 | 108 | 103–125 |
| HitTest events | 29–160 | 390 | 376–400 |
| Layerize events / ms | 414–435 / **59–62** | 457 / **199** | 533–540 / **233–263** |
| Paint events / ms | 1582–1866 / 97–122 | 2421 / 141 | 1875–2626 / 139–163 |
| Commit events | 477–496 | 480 | 571–581 |
| busy, mean ms per frame | 5.8–6.6 | 6.6–7.0 | 5.6–6.0 (8.3 ms frames) |

Hiding the scrubber removed the per-frame Layout and the per-frame pointer re-hit-test,
and cut Layerize from 199–263 ms to 59–62 ms per 5 s; Commit, PrePaint and Paint stay one
per frame because a WebGPU canvas presents every frame regardless. The remaining ~140
layouts per window are the 10 Hz samplers' commits. Net: the scrubber's two style writes
cost 0.4–0.8 ms of every 10 ms frame on E24 (the range spans the two comparisons; the
same-session control landed on a different display, so its per-frame figure is not
directly comparable and the per-window totals are what the row compares). The fix is two
lines (§6).

## 4. Instruments that disagree — read before trusting a number

- **Hub "GPU time" vs the presented frame.** The performance panel's frame GPU time is
  the SUM of per-pass timestamp spans (`hub.ts frameBucket()`). It read 88–105 ms on E24
  while the page presented every 10.0 ms; 243–357 ms on E55 at a 20–27 ms interval; on
  chain-200 it climbed from 4.98 to 55.2 ms across the four idle windows while the rAF
  interval stayed at 10.0 ms. A GPU number ≥ 5× the presented interval cannot be the
  frame's GPU time; per-pass spans overlap or include queue wait. Control: the rAF
  interval, same window. Not a fix here — a §T row for the instrument.
- **Trace `GPUTask`** is GPU-process CPU, not GPU execution; do not read it as the
  compositor's cost.
- **`(program)` samples** overlap Layout/Paint/Layerize spans; the category table and the
  span table are two views of one thread, not two thread halves.
- **Dev build.** All numbers are `pnpm dev` (StrictMode, React dev runtime with
  `jsxDEV`/`measure`/`logComponentRender`, un-minified). React's own dev overhead is
  0.8–1.0 ms/frame idle and ≈ 1.6 s of the 8 s knob window. The ranking of items 1–5
  survives a production build only if re-measured; the harness takes
  `PERF_SERVER_COMMAND` for a `vite preview` server, not run here.
- **100 Hz display.** Frame budget is 10 ms, not 16.7; p95 numbers above 10 ms are
  dropped frames on this machine and would not be on a 60 Hz one.

## 5. What was discarded, and the noise around the runs

- chain-200 in the first run: a real mouse crossed the window (102 pointermoves, 16 wheels,
  3 clicks inside an "idle" window). Whole fixture re-run (`run1-chain`). In the re-run
  three of four idle windows again carried real input (144 / 28 pointermoves, 5 keydowns +
  10 scrolls); only `A performance pass 1` was clean and it is the one quoted. `D` and `E`
  windows carry their own scripted input and were kept. `summarize.ts` now flags any idle
  window with > 3 pointer/wheel/key dispatches. The `slotchange` bursts (108 per window)
  are the DOM's own, not input.
- Machine load at the start of the chain re-run: another session's `pnpm vitest run
  src/examples/channel-integrity…` at 33 % + 26 % CPU, FSEvents 25–31 %. Controls stayed at
  cheap 0.36–0.38 / dear 9.7–10.2 ms through it, so no contamination is visible in the
  numbers; still, said. At the probe runs: the user's own Chrome at 60 % and 33 % CPU,
  and the two control runs opened on a second display (DPR 2, 120 Hz; the harness does not
  choose the display), which is why §3 compares per-window totals and not per-frame means.
- HEAD moved between run1 (`d8eabb8`), the chain re-run (`971056b`: T1229 timeline read
  fix + SPEC) and the probe (`d589457`: + T1236 E66 Meter example + SPEC); none of the
  intervening commits touch the measured paths, and the probe's own numbers are compared
  within the probe run first.
- Playwright drives a real mouse in a headed Chromium with `--enable-unsafe-webgpu` off;
  GPU adapter apple/metal-3.

## 6. What each item would cost to fix (estimates, not commitments)

| item | fix sketch | size |
|---|---|---|
| 1 / knob-drag `App` re-render | stop `App` from subscribing to the whole document (`useGraphCompile` line 344 `useSyncExternalStore<GraphDocument>`) or memoize the pane subtree so a revision re-renders only the canvas + inspector; the library's 108 `NodeIdentity` rows and the perf panel must not depend on `document` identity | medium: one composition-root change, verified by the devtools commit groups in this harness (`NodeIdentity×108` must vanish from scenario C) |
| 1 / 10 Hz samplers | `PerformancePanel` and `ValuePlot` subscribe per row with a value-equality selector, or render only when the pane is visible (all panes are mounted today) | small–medium |
| 3 / per-frame layout | move the playhead by `transform: translateX()` and the elapsed bar by `transform: scaleX()` (compositor-only), or write only when the percent string changed | small (two lines + CSS); verify with `PERF_PROBE_CSS` before/after |
| 4 / preview tick | build the preview program only when the allocated set or a tile size changed (the signature's own inputs), not every tick; skip the tick when paused and nothing is due | small |
| 5 / §T1182 | uniform-only fast path when the animated parameters do not change the pass structure; `passStructureKey` cached on the flat graph revision | medium (SPEC row exists) |
| 6 / ValuePlot | project only the new samples; canvas 2D draw at 10 Hz is already the cheap part | small |
| E / pan-zoom document writes | debounce the viewport persist so a wheel step does not bump the document revision (each bump costs an `App` re-render) | small |
| hub GPU instrument | union of pass spans per frame, or one frame-level timestamp pair | small; separate row |

Everything in this table is a claim about the tree at `d8eabb8`. Fix item 1 and the
shares of every other item change; measure again with the same harness rather than
carrying these numbers forward.

## Appendix A — per-scenario frame budget, all fixtures, all passes

Columns: N frames; interval p50 / p95; busy p50 / p95 / mean; script mean; style;
layout; paint; gc (ms per frame); React commits in the window; control cheap / dear.

### E24 — 74 nodes / 76 edges (`d8eabb8`)

| scenario | variant | pass | N | interval | busy | script | style | layout | paint | gc | commits | control |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | dock tab: examples | 1 | 479 | 9.98 / 18.85 | 5.61 / 16.92 / 6.77 | 6.79 | 0.06 | 0.26 | 0.97 | 0.13 | 243 | 0.36 / 9.81 |
| A | dock tab: performance | 1 | 484 | 9.99 / 16.01 | 6.49 / 15.43 / 6.83 | 6.87 | 0.06 | 0.38 | 1.27 | 0.12 | 251 | 0.37 / 9.88 |
| B | transport paused | 1 | 500 | 10.00 / 10.95 | 1.35 / 2.18 / 1.45 | 1.50 | 0.00 | 0.00 | 0.08 | 0.02 | 51 | 0.39 / 10.00 |
| F | select chem | 1 | 47 | 9.79 / 27.82 | 6.57 / 27.81 / 8.76 | 8.78 | 0.10 | 0.54 | 1.74 | 0.15 | 27 | 0.36 / 9.92 |
| C | chem.Brightness | 1 | 545 | 9.11 / 36.73 | 8.14 / 36.72 / 14.31 | 14.31 | 0.08 | 0.46 | 2.53 | 0.29 | 611 | 0.35 / 9.87 |
| D | drag chem | 1 | 326 | 9.99 / 17.13 | 8.98 / 17.11 / 9.46 | 9.47 | 0.10 | 0.46 | 3.00 | 0.13 | 384 | 0.35 / 9.81 |
| E | wheel zoom ×40 then pan | 1 | 359 | 15.84 / 25.31 | 10.60 / 20.02 / 11.20 | 11.21 | 0.12 | 0.97 | 2.70 | 0.17 | 435 | 0.38 / 10.22 |
| E | wheel zoom ×40 then pan | 2 | 357 | 15.30 / 25.42 | 10.41 / 20.73 / 11.00 | 11.01 | 0.12 | 0.95 | 2.71 | 0.16 | 406 | 0.37 / 10.12 |
| D | drag chem | 2 | 274 | 10.42 / 22.40 | 9.95 / 19.57 / 10.87 | 10.88 | 0.12 | 0.55 | 3.53 | 0.15 | 376 | 0.37 / 10.04 |
| C | chem.Brightness | 2 | 615 | 9.30 / 35.30 | 8.40 / 35.29 / 13.51 | 13.51 | 0.08 | 0.47 | 2.49 | 0.27 | 615 | 0.36 / 9.92 |
| F | select chem | 2 | 43 | 10.01 / 21.60 | 6.96 / 21.58 / 9.09 | 9.10 | 0.09 | 0.56 | 1.71 | 0.16 | 27 | 0.38 / 9.96 |
| B | transport paused | 2 | 501 | 10.00 / 10.96 | 1.28 / 2.20 / 1.38 | 1.43 | 0.00 | 0.01 | 0.07 | 0.02 | 51 | 0.38 / 10.16 |
| A | dock tab: performance | 2 | 489 | 9.93 / 16.73 | 5.80 / 15.85 / 7.00 | 7.02 | 0.06 | 0.40 | 1.33 | 0.13 | 242 | 0.38 / 9.97 |
| A | dock tab: examples | 2 | 491 | 9.98 / 15.93 | 5.64 / 14.06 / 6.58 | 6.60 | 0.06 | 0.27 | 1.06 | 0.13 | 246 | 0.36 / 9.96 |

Input latency E24 (dispatch → end of next Commit): C p50 30.0 / p95 79.9 / max 88.1 ms
(N = 120), pass 2 29.5 / 64.4 / 80.1 (N = 232); D 5.9 / 6.9 / 7.6 and 6.2 / 6.8 / 7.1
(N = 240); E 6.7 / 8.2 / 12.2 and 6.6 / 7.9 / 9.4 (N = 280); F 33.5–62.3 (N = 3).

### E55 — 42 nodes / 42 edges (`d8eabb8`)

| scenario | variant | pass | N | interval | busy | script | style | layout | paint | gc | commits | control |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | dock tab: examples | 1 | 256 | 19.66 / 40.08 | 5.29 / 17.02 / 7.21 | 7.24 | 0.10 | 0.38 | 1.14 | 0.09 | 248 | 0.37 / 9.97 |
| A | dock tab: performance | 1 | 223 | 24.23 / 42.22 | 6.89 / 18.23 / 8.47 | 8.50 | 0.12 | 0.59 | 1.53 | 0.15 | 247 | 0.44 / 12.26 |
| B | transport paused | 1 | 501 | 10.00 / 10.96 | 0.75 / 1.72 / 0.85 | 0.91 | 0.00 | 0.00 | 0.07 | 0.01 | 51 | 0.43 / 11.24 |
| F | select cut | 1 | 28 | 10.73 / 40.63 | 5.45 / 27.16 / 8.21 | 8.23 | 0.14 | 0.52 | 1.58 | 0.11 | 26 | 0.38 / 10.99 |
| C | cut.Brightness | 1 | 366 | 10.66 / 34.50 | 8.55 / 32.17 / 14.60 | 14.61 | 0.10 | 0.44 | 2.21 | 0.27 | 550 | 0.39 / 11.28 |
| D | drag cut | 1 | 200 | 15.09 / 30.39 | 8.43 / 19.88 / 10.10 | 10.10 | 0.16 | 0.56 | 2.90 | 0.13 | 354 | 0.41 / 10.75 |
| E | wheel zoom ×40 then pan | 1 | 340 | 16.11 / 51.01 | 7.93 / 25.14 / 9.54 | 9.56 | 0.14 | 0.92 | 1.96 | 0.12 | 516 | 0.41 / 11.34 |
| E | wheel zoom ×40 then pan | 2 | 320 | 21.54 / 46.19 | 7.52 / 23.80 / 9.31 | 9.34 | 0.13 | 0.88 | 1.93 | 0.12 | 502 | 0.39 / 12.20 |
| D | drag cut | 2 | 190 | 22.67 / 44.10 | 9.60 / 24.91 / 11.20 | 11.22 | 0.18 | 0.68 | 3.24 | 0.15 | 410 | 0.39 / 11.05 |
| C | cut.Brightness | 2 | 339 | 14.81 / 41.50 | 9.14 / 38.93 / 16.34 | 16.35 | 0.11 | 0.51 | 2.49 | 0.27 | 571 | 0.38 / 10.34 |
| F | select cut | 2 | 29 | 12.32 / 32.37 | 6.04 / 27.54 / 9.28 | 9.27 | 0.16 | 0.64 | 1.81 | 0.11 | 25 | 0.45 / 13.38 |
| B | transport paused | 2 | 501 | 10.00 / 10.96 | 0.76 / 1.63 / 0.83 | 0.88 | 0.00 | 0.00 | 0.07 | 0.01 | 51 | 0.44 / 12.23 |
| A | dock tab: performance | 2 | 263 | 20.39 / 38.25 | 5.25 / 15.99 / 6.81 | 6.82 | 0.10 | 0.52 | 1.40 | 0.09 | 232 | 0.38 / 10.13 |
| A | dock tab: examples | 2 | 194 | 27.46 / 49.89 | 6.62 / 17.00 / 8.02 | 8.04 | 0.12 | 0.47 | 1.41 | 0.14 | 235 | 0.37 / 9.99 |

E55 is GPU-bound at idle: the rAF interval is 20–27 ms while the main thread is busy 1.9
s of 5 s. Nothing on the main thread explains its frame rate; the hub's 243–357 ms "GPU
time" is the wrong instrument to say how much (§4). Latency: C p50 25.5–26.6 / p95 43–55
/ max 85–89 ms; D 3.9 / 4.4; E 4.0–4.3 / 5.2–5.3 (max 60–65). The dear control reads
10.3–13.4 ms here against 9.8–10.2 elsewhere — the GPU-bound page makes the main thread's
spin slower, a same-run hint that E55's numbers are not comparable frame-for-frame with
E24's.

### untitled-8 — 30 nodes / 20 edges (`d8eabb8`)

| scenario | variant | pass | N | interval | busy | script | style | layout | paint | gc | commits | control |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | dock tab: examples | 1 | 500 | 10.00 / 14.04 | 2.69 / 12.42 / 3.45 | 3.51 | 0.02 | 0.07 | 0.46 | 0.04 | 249 | 0.38 / 10.29 |
| A | dock tab: performance | 1 | 501 | 10.00 / 12.93 | 2.83 / 10.63 / 3.52 | 3.55 | 0.02 | 0.18 | 0.63 | 0.05 | 251 | 0.39 / 10.23 |
| B | transport paused | 1 | 494 | 10.00 / 10.95 | 0.55 / 1.62 / 1.01 | 1.07 | 0.03 | 0.02 | 0.09 | 0.02 | 59 | 0.44 / 11.55 |
| F | select nd_47c2… | 1 | 41 | 9.99 / 15.80 | 3.19 / 15.77 / 6.02 | 6.04 | 0.06 | 0.26 | 0.86 | 0.09 | 28 | 0.39 / 10.21 |
| C | nd_47c2….Value | 1 | 359 | 9.70 / 28.16 | 6.14 / 28.15 / 12.49 | 12.50 | 0.09 | 0.31 | 1.48 | 0.22 | 531 | 0.37 / 9.99 |
| D | drag nd_47c2… | 1 | 230 | 10.00 / 11.39 | 5.49 / 9.21 / 5.96 | 5.98 | 0.06 | 0.28 | 1.59 | 0.06 | 346 | 0.37 / 10.16 |
| E | wheel zoom ×40 then pan | 1 | 507 | 9.99 / 12.19 | 3.46 / 10.64 / 4.29 | 4.32 | 0.04 | 0.37 | 1.01 | 0.04 | 414 | 0.38 / 10.29 |
| E | wheel zoom ×40 then pan | 2 | 501 | 9.99 / 11.28 | 4.26 / 9.56 / 4.39 | 4.41 | 0.04 | 0.38 | 1.04 | 0.06 | 412 | 0.38 / 10.23 |
| D | drag nd_47c2… | 2 | 233 | 9.99 / 11.88 | 5.32 / 10.25 / 5.89 | 5.89 | 0.06 | 0.24 | 1.61 | 0.07 | 349 | 0.38 / 9.86 |
| C | nd_47c2….Value | 2 | 325 | 9.73 / 26.07 | 6.46 / 26.06 / 12.74 | 12.77 | 0.09 | 0.32 | 1.51 | 0.22 | 524 | 0.39 / 10.59 |
| F | select nd_47c2… | 2 | 41 | 9.99 / 12.79 | 3.06 / 12.77 / 5.75 | 5.78 | 0.06 | 0.28 | 0.89 | 0.08 | 26 | 0.36 / 9.88 |
| B | transport paused | 2 | 502 | 10.00 / 10.96 | 0.66 / 1.48 / 0.77 | 0.83 | 0.00 | 0.00 | 0.05 | 0.01 | 51 | 0.45 / 11.75 |
| A | dock tab: performance | 2 | 500 | 10.00 / 12.40 | 2.43 / 10.78 / 3.49 | 3.52 | 0.03 | 0.19 | 0.66 | 0.04 | 248 | 0.37 / 9.91 |
| A | dock tab: examples | 2 | 501 | 10.00 / 11.92 | 2.50 / 10.33 / 3.22 | 3.24 | 0.03 | 0.11 | 0.45 | 0.06 | 251 | 0.42 / 11.16 |

Latency: C p50 22.6–23.6 / p95 28–31 / max 67–80 ms; D 2.3–2.6 / 3.0–3.2; E 3.0–3.3 /
4.4–4.6; F 21.2 and 62.7.

### chain-200 — 200 nodes / 199 edges, synthetic through the command bus (`971056b`)

| scenario | variant | pass | N | interval | busy | script | style | layout | paint | gc | commits | control | input |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | dock tab: examples | 1 | 413 | 10.00 / 22.30 | 5.78 / 22.28 / 8.93 | 8.96 | 0.03 | 0.24 | 1.53 | 0.16 | 438 | 0.38 / 9.97 | FOREIGN: 144 pointermoves |
| A | dock tab: performance | 1 | 410 | 10.00 / 28.39 | 5.89 / 27.77 / 9.13 | 9.15 | 0.03 | 0.56 | 2.34 | 0.14 | 194 | 0.36 / 9.82 | clean |
| D | drag | 1 | 240 | 10.02 / 30.78 | 7.47 / 30.77 / 11.08 | 11.09 | 0.04 | 1.47 | 2.81 | 0.14 | 123 | 0.36 / 9.72 | scripted |
| E | wheel zoom ×40 then pan | 1 | 382 | 11.30 / 60.26 | 11.02 / 60.23 / 16.41 | 16.43 | 0.06 | 1.59 | 4.42 | 0.25 | 418 | 0.36 / 10.00 | scripted |
| E | wheel zoom ×40 then pan | 2 | 373 | 11.69 / 55.23 | 11.40 / 55.21 / 16.33 | 16.33 | 0.12 | 1.55 | 4.57 | 0.26 | 416 | 0.37 / 10.16 | scripted |
| D | drag | 2 | 264 | 10.01 / 34.68 | 7.90 / 34.65 / 11.96 | 11.97 | 0.05 | 1.46 | 2.75 | 0.18 | 151 | 0.37 / 10.02 | scripted |
| A | dock tab: performance | 2 | 369 | 10.10 / 37.39 | 6.34 / 36.97 / 11.09 | 11.10 | 0.27 | 1.21 | 2.59 | 0.15 | 204 | 0.37 / 9.93 | FOREIGN: keyboard + scroll |
| A | dock tab: examples | 2 | 412 | 10.00 / 35.67 | 5.09 / 33.34 / 8.62 | 8.64 | 0.03 | 0.99 | 1.26 | 0.14 | 213 | 0.36 / 9.73 | FOREIGN: 28 pointermoves |

Scaling, idle (clean window only): busy mean 9.1 ms vs E24's 6.8 and untitled-8's 3.5;
React inclusive 1364 ms/5 s (`performWorkOnRoot`), previews tick 465, vgpu frame 318,
`(program)` 1374, passive effects 392 ms; the `PerformancePanel` group is 5–12 ms per
commit at 334 `CostCell`s. Layout 0.56, paint 2.34 ms/frame against 0.38 / 1.27 on E24.

## Appendix B — how to read the raw output

`run.sh <out>` writes `<out>/<fixture>.json` (every scenario's parsed numbers),
`<out>/<fixture>-<key>.trace.json` (the raw CDP trace), `commit.txt`, and `summary.md`
(the tables above, plus heaviest entry points, span counts, hub readings and per-commit
component groups). `node --import ./src/tooling/alias-hooks.ts
src/tests/e2e/perf/summarize.ts <out>` regenerates the summary. Trace files open in
Chrome DevTools → Performance → Load profile for the flame chart.
