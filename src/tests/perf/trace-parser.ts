/**
 * A parser for Chromium trace-event JSON (`Tracing.start` over CDP), sized for one job:
 * attribute a headed profile of Loom's main thread to the parts of the tree that spend it
 * (T1235). Pure and headless; the Playwright harness in `src/tests/e2e/perf/` feeds it.
 *
 * ## What it reads
 *
 * Two instruments arrive in one trace and are kept apart in the output, because they
 * measure different things and can legitimately overlap:
 *
 *   1. **The V8 sampling profiler** (`disabled-by-default-v8.cpu_profiler`): `Profile` +
 *      `ProfileChunk` events carrying a call tree and timestamped samples. Every sample is
 *      attributed to ONE category by walking its stack LEAF-FIRST and taking the first
 *      frame whose script URL matches a rule (`categorize`). "Who is on the CPU right now"
 *      is the question, so React reconciling a node is `react`, the node's own render body
 *      is `editor`, and a compile inside the frame driver's animate hook is `compile`. A
 *      second, ROOT-FIRST walk records the ENTRY — the outermost non-root frame — so the
 *      same sample also says which loop it lives under (the preview rAF tick, the vgpu
 *      frame loop, React's scheduler, an input handler, a timer).
 *   2. **The timeline's own events** (`devtools.timeline`): `UpdateLayoutTree`, `Layout`,
 *      `Paint`/`PrePaint`/`Layerize`/`Commit`, GC and `RunTask`. These are wall-clock
 *      durations, not samples, so a forced synchronous layout inside a script shows up in
 *      BOTH instruments — as `Layout` here and as `(program)` or native time there. The
 *      report prints both columns and says so rather than netting them.
 *
 * ## What a "frame" is here
 *
 * The main thread runs every `requestAnimationFrame` callback of a display frame inside ONE
 * top-level task, so a frame window opens at each top-level task that contains at least
 * one `FireAnimationFrame` and closes at the next such task. Everything the main thread
 * does in between — the rAF task itself, timers, input, React's scheduler tasks, GC — is
 * charged to that window. The window's `interval` is therefore the display cadence the page
 * actually achieved, and `busy` is how much of it the main thread was occupied.
 *
 * Input latency is measured to the main thread's next `Commit` (the frame handed to the
 * compositor), which is the last thing the main thread can be blamed for; compositor and
 * GPU-process time after that is not in this trace's scope.
 */

export interface TraceEvent {
  readonly pid: number;
  readonly tid: number;
  readonly ts: number;
  readonly ph: string;
  readonly cat: string;
  readonly name: string;
  readonly dur?: number;
  readonly id?: string | number;
  readonly args?: Record<string, unknown>;
}

/** Where a sample's time is charged. Order is the order the report prints them. */
export type Category =
  | "react"
  | "xyflow"
  | "frame-driver"
  | "backend"
  | "compile"
  | "previews"
  | "telemetry"
  | "domain"
  | "editor"
  | "ui"
  | "app"
  | "state"
  | "codemirror"
  | "vendor"
  | "gc"
  | "program"
  | "harness"
  | "other";

export const CATEGORIES: readonly Category[] = [
  "react",
  "xyflow",
  "frame-driver",
  "backend",
  "compile",
  "previews",
  "telemetry",
  "domain",
  "editor",
  "ui",
  "app",
  "state",
  "codemirror",
  "vendor",
  "gc",
  "program",
  "harness",
  "other",
];

interface Rule {
  readonly category: Category;
  readonly test: (url: string, functionName: string) => boolean;
}

const includes =
  (...needles: readonly string[]) =>
  (url: string): boolean =>
    needles.some((needle) => url.includes(needle));

/**
 * The attribution table. LEAF-FIRST, first match wins, so the ORDER of rules matters only
 * where one URL could match two rules — none do today (every rule names a distinct path).
 *
 * The URLs are the ones the Vite DEV server hands the browser: app modules under
 * `/src/...`, dependencies pre-bundled under `/node_modules/.vite/deps/<name>.js`. A
 * production bundle would need a source-map pass; this harness measures the dev server
 * and the report says so.
 */
const RULES: readonly Rule[] = [
  { category: "backend", test: includes("/src/runtime/backend/", "/deps/vgpu", "/vgpu/") },
  { category: "compile", test: includes("/src/compiler/") },
  { category: "frame-driver", test: includes("/src/runtime/execution/", "/src/app/use-frame-loop", "/src/app/animate-parameters") },
  {
    category: "previews",
    test: includes("/src/runtime/previews/", "/src/app/use-node-previews", "/src/app/preview-sinks", "/src/app/use-graph-background"),
  },
  {
    category: "telemetry",
    test: includes(
      "/src/runtime/telemetry/",
      "/src/editor/inspect/performance-panel",
      "/src/app/gpu-readout",
      "/src/app/timeline-readout",
      "/src/editor/nodes/node-timing-overlay",
    ),
  },
  { category: "domain", test: includes("/src/domain/", "/src/nodes/", "/src/points/") },
  { category: "xyflow", test: includes("/deps/@xyflow", "/@xyflow/", "/deps/d3-", "/d3-zoom", "/d3-drag", "/d3-selection") },
  {
    category: "react",
    test: includes("/deps/react-dom", "/deps/react.js", "/deps/react_", "/deps/scheduler", "/react-dom/", "/deps/chunk-"),
  },
  { category: "state", test: includes("/deps/zustand", "/deps/immer", "/zustand/", "/immer/") },
  { category: "codemirror", test: includes("/deps/@codemirror", "/@codemirror/", "/deps/@lezer") },
  { category: "editor", test: includes("/src/editor/") },
  { category: "ui", test: includes("/src/ui/") },
  { category: "app", test: includes("/src/app/", "/src/main.tsx", "/src/agent/", "/src/mcp/", "/src/devices/") },
  { category: "vendor", test: includes("/node_modules/") },
];

export function categorize(url: string, functionName: string): Category | null {
  if (url === "") {
    if (functionName === "(garbage collector)") return "gc";
    if (functionName === "(program)") return "program";
    if (functionName.startsWith("__perf")) return "harness";
    return null;
  }
  if (functionName.startsWith("__perf")) return "harness";
  for (const rule of RULES) if (rule.test(url, functionName)) return rule.category;
  return null;
}

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { functionName: string; url: string; lineNumber?: number };
  parent: number | null;
  category: Category | null;
  /** Resolved lazily: the leaf-first category of THIS node's stack. */
  leafCategory?: Category;
  entryCategory?: Category;
  entryLabel?: string;
}

export interface Sample {
  readonly ts: number;
  readonly weight: number;
  readonly leaf: Category;
  readonly entry: Category;
  readonly entryLabel: string;
  readonly isIdle: boolean;
  readonly nodeId: number;
}

export interface Span {
  readonly name: string;
  readonly ts: number;
  readonly dur: number;
  readonly args?: Record<string, unknown>;
}

export interface MainThread {
  readonly pid: number;
  readonly tid: number;
  readonly tasks: readonly Span[];
  readonly spans: readonly Span[];
  readonly samples: readonly Sample[];
  readonly idleSampleUs: number;
  /** ts of every top-level task that fired at least one rAF callback. */
  readonly rafTasks: readonly Span[];
}

/** Which renderer process holds the page: the one `TracingStartedInBrowser` lists for the URL. */
export function findMainThread(events: readonly TraceEvent[], pageUrlPrefix: string): { pid: number; tid: number } {
  let pid: number | null = null;
  for (const event of events) {
    if (event.name !== "TracingStartedInBrowser") continue;
    const data = (event.args?.["data"] ?? {}) as { frames?: Array<{ url?: string; processId?: number }> };
    for (const frame of data.frames ?? []) {
      if (typeof frame.url === "string" && frame.url.startsWith(pageUrlPrefix) && typeof frame.processId === "number") {
        pid = frame.processId;
      }
    }
  }
  if (pid === null) {
    // Fall back to the renderer with the most rAF fires: the page under test is the only
    // one animating at 60 Hz.
    const counts = new Map<number, number>();
    for (const event of events) {
      if (event.name === "FireAnimationFrame") counts.set(event.pid, (counts.get(event.pid) ?? 0) + 1);
    }
    let best = -1;
    for (const [candidate, count] of counts) if (count > best) [pid, best] = [candidate, count];
    if (pid === null) throw new Error("the trace holds no renderer that fired an animation frame");
  }
  let tid: number | null = null;
  for (const event of events) {
    if (event.ph === "M" && event.name === "thread_name" && event.pid === pid) {
      const name = (event.args?.["name"] ?? "") as string;
      if (name === "CrRendererMain") tid = event.tid;
    }
  }
  if (tid === null) throw new Error(`renderer ${pid} has no CrRendererMain thread in the trace`);
  return { pid, tid };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Turns `Profile`/`ProfileChunk` events for the main thread into categorized samples. */
export function collectSamples(events: readonly TraceEvent[], pid: number, tid: number): { samples: Sample[]; idleUs: number } {
  const nodes = new Map<number, ProfileNode>();
  const raw: Array<{ ts: number; nodeId: number }> = [];
  const startById = new Map<string, number>();

  // The `Profile` header sits on the sampled thread; its `ProfileChunk`s are emitted from
  // V8's own `v8:ProfEvntProc` thread in the same process (verified on a capture), so
  // chunks are matched by the profile id, never by thread.
  for (const event of events) {
    if (event.pid !== pid || event.tid !== tid) continue;
    if (event.name === "Profile") {
      const data = (event.args?.["data"] ?? {}) as { startTime?: number };
      startById.set(String(event.id), data.startTime ?? event.ts);
    }
  }
  const cursor = new Map<string, number>();
  for (const event of events) {
    if (event.pid !== pid || event.name !== "ProfileChunk" || !startById.has(String(event.id))) continue;
    const data = (event.args?.["data"] ?? {}) as {
      cpuProfile?: { nodes?: unknown[]; samples?: number[] };
      timeDeltas?: number[];
    };
    const key = String(event.id);
    for (const entry of data.cpuProfile?.nodes ?? []) {
      if (!isRecord(entry)) continue;
      const id = entry["id"] as number;
      const callFrame = entry["callFrame"] as ProfileNode["callFrame"];
      const parent = typeof entry["parent"] === "number" ? (entry["parent"] as number) : null;
      nodes.set(id, { id, callFrame, parent, category: categorize(callFrame.url ?? "", callFrame.functionName ?? "") });
    }
    let at = cursor.get(key) ?? startById.get(key) ?? event.ts;
    const samples = data.cpuProfile?.samples ?? [];
    const deltas = data.timeDeltas ?? [];
    for (let index = 0; index < samples.length; index += 1) {
      at += deltas[index] ?? 0;
      raw.push({ ts: at, nodeId: samples[index] as number });
    }
    cursor.set(key, at);
  }
  raw.sort((a, b) => a.ts - b.ts);

  const resolve = (node: ProfileNode): void => {
    if (node.leafCategory !== undefined) return;
    // leaf-first: this node, then its ancestors
    let leaf: Category = "other";
    let entry: Category = "other";
    let entryLabel = "(root)";
    let cur: ProfileNode | undefined = node;
    let found = false;
    const chain: ProfileNode[] = [];
    while (cur !== undefined) {
      chain.push(cur);
      if (!found && cur.category !== null) {
        leaf = cur.category;
        found = true;
      }
      cur = cur.parent === null ? undefined : nodes.get(cur.parent);
    }
    // root-first: the outermost frame that is not (root)/(program)/(idle)
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const frame = chain[index] as ProfileNode;
      const name = frame.callFrame.functionName;
      if (name === "(root)" || name === "(program)" || name === "(idle)" || name === "(garbage collector)") continue;
      entry = frame.category ?? "other";
      entryLabel = `${name || "(anonymous)"} @ ${shortUrl(frame.callFrame.url ?? "")}`;
      break;
    }
    node.leafCategory = leaf;
    node.entryCategory = entry;
    node.entryLabel = entryLabel;
  };

  const out: Sample[] = [];
  let idleUs = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index] as { ts: number; nodeId: number };
    const next = raw[index + 1];
    const weight = next === undefined ? 0 : next.ts - current.ts;
    const node = nodes.get(current.nodeId);
    if (node === undefined) continue;
    resolve(node);
    const isIdle = node.callFrame.functionName === "(idle)";
    if (isIdle) idleUs += weight;
    out.push({
      ts: current.ts,
      weight,
      leaf: node.leafCategory ?? "other",
      entry: node.entryCategory ?? "other",
      entryLabel: node.entryLabel ?? "(root)",
      isIdle,
      nodeId: current.nodeId,
    });
  }
  return { samples: out, idleUs };
}

export function shortUrl(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
  return path.replace(/^\/node_modules\/\.vite\/deps\//, "deps/");
}

const TOP_LEVEL = "RunTask";
const STYLE = new Set(["UpdateLayoutTree", "ScheduleStyleRecalculation"]);
const LAYOUT = new Set(["Layout", "HitTest"]);
const PAINT = new Set(["PrePaint", "Paint", "Layerize", "Commit", "UpdateLayerTree", "CompositeLayers"]);
/**
 * The OUTER GC spans only. Chromium nests `V8.GC_SCAVENGER_*` phases inside `MinorGC`
 * (verified on a capture: 35 `MinorGC`, 35 of each phase), so a regex over `GC` would
 * count every collection several times over.
 */
const GC = new Set(["MinorGC", "MajorGC", "V8.GCFinalizeMC", "V8.GCCompactor", "BlinkGC.AtomicPhase", "V8.GCScavenger"]);

/** Main-thread spans of interest, as (ts, dur) with the trace's own names. */
export function collectSpans(events: readonly TraceEvent[], pid: number, tid: number): { tasks: Span[]; spans: Span[] } {
  const tasks: Span[] = [];
  const spans: Span[] = [];
  const open = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.pid !== pid || event.tid !== tid) continue;
    if (event.ph === "X" && typeof event.dur === "number") {
      const span: Span = { name: event.name, ts: event.ts, dur: event.dur, ...(event.args === undefined ? {} : { args: event.args }) };
      if (event.name === TOP_LEVEL) tasks.push(span);
      else spans.push(span);
    } else if (event.ph === "B") {
      const stack = open.get(event.name) ?? [];
      stack.push(event);
      open.set(event.name, stack);
    } else if (event.ph === "E") {
      const begin = open.get(event.name)?.pop();
      if (begin === undefined) continue;
      const span: Span = { name: event.name, ts: begin.ts, dur: event.ts - begin.ts, ...(begin.args === undefined ? {} : { args: begin.args }) };
      if (event.name === TOP_LEVEL) tasks.push(span);
      else spans.push(span);
    }
  }
  tasks.sort((a, b) => a.ts - b.ts);
  spans.sort((a, b) => a.ts - b.ts);
  return { tasks, spans };
}

export function parseMainThread(events: readonly TraceEvent[], pageUrlPrefix: string): MainThread {
  const { pid, tid } = findMainThread(events, pageUrlPrefix);
  const { tasks, spans } = collectSpans(events, pid, tid);
  const { samples, idleUs } = collectSamples(events, pid, tid);
  const rafFires = spans.filter((span) => span.name === "FireAnimationFrame");
  const rafTasks: Span[] = [];
  let fireIndex = 0;
  for (const task of tasks) {
    while (fireIndex < rafFires.length && (rafFires[fireIndex] as Span).ts < task.ts) fireIndex += 1;
    const fire = rafFires[fireIndex];
    if (fire !== undefined && fire.ts >= task.ts && fire.ts < task.ts + task.dur) rafTasks.push(task);
  }
  return { pid, tid, tasks, spans, samples, idleSampleUs: idleUs, rafTasks };
}

export interface FrameWindow {
  readonly ts: number;
  readonly intervalMs: number;
  readonly busyMs: number;
  readonly scriptMs: Readonly<Record<Category, number>>;
  readonly entryMs: Readonly<Record<Category, number>>;
  readonly styleMs: number;
  readonly layoutMs: number;
  readonly paintMs: number;
  readonly gcMs: number;
  readonly rafCallbacks: number;
}

function zeroRecord(): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const category of CATEGORIES) out[category] = 0;
  return out;
}

/**
 * Charges everything on the main thread to the rAF window it happened in.
 *
 * `from`/`to` bound the measurement (µs, trace clock) so a warm-up and the harness's own
 * bookkeeping outside the window are not counted. The first and last partial windows are
 * dropped: a window is only a frame when both of its edges were observed.
 */
export function frameWindows(thread: MainThread, from: number, to: number): FrameWindow[] {
  const edges = thread.rafTasks.filter((task) => task.ts >= from && task.ts <= to);
  if (edges.length < 2) return [];
  const windows: FrameWindow[] = [];
  let taskIndex = 0;
  let spanIndex = 0;
  let sampleIndex = 0;
  const { tasks, spans, samples } = thread;
  const skipTo = (array: readonly { ts: number }[], index: number, ts: number): number => {
    let cursor = index;
    while (cursor < array.length && (array[cursor] as { ts: number }).ts < ts) cursor += 1;
    return cursor;
  };
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const start = (edges[index] as Span).ts;
    const end = (edges[index + 1] as Span).ts;
    let busy = 0;
    taskIndex = skipTo(tasks, taskIndex, start);
    for (let cursor = taskIndex; cursor < tasks.length && (tasks[cursor] as Span).ts < end; cursor += 1) {
      busy += (tasks[cursor] as Span).dur;
    }
    let style = 0;
    let layout = 0;
    let paint = 0;
    let gc = 0;
    let raf = 0;
    spanIndex = skipTo(spans, spanIndex, start);
    for (let cursor = spanIndex; cursor < spans.length && (spans[cursor] as Span).ts < end; cursor += 1) {
      const span = spans[cursor] as Span;
      if (STYLE.has(span.name)) style += span.dur;
      else if (LAYOUT.has(span.name)) layout += span.dur;
      else if (PAINT.has(span.name)) paint += span.dur;
      else if (GC.has(span.name)) gc += span.dur;
      else if (span.name === "FireAnimationFrame") raf += 1;
    }
    const script = zeroRecord();
    const entry = zeroRecord();
    sampleIndex = skipTo(samples, sampleIndex, start);
    for (let cursor = sampleIndex; cursor < samples.length && (samples[cursor] as Sample).ts < end; cursor += 1) {
      const sample = samples[cursor] as Sample;
      if (sample.isIdle) continue;
      script[sample.leaf] += sample.weight;
      entry[sample.entry] += sample.weight;
    }
    const toMs = (record: Record<Category, number>): Record<Category, number> => {
      const out = zeroRecord();
      for (const category of CATEGORIES) out[category] = record[category] / 1000;
      return out;
    };
    windows.push({
      ts: start,
      intervalMs: (end - start) / 1000,
      busyMs: busy / 1000,
      scriptMs: toMs(script),
      entryMs: toMs(entry),
      styleMs: style / 1000,
      layoutMs: layout / 1000,
      paintMs: paint / 1000,
      gcMs: gc / 1000,
      rafCallbacks: raf,
    });
  }
  return windows;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] as number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export interface WindowSummary {
  readonly frames: number;
  readonly intervalMs: { p50: number; p95: number; mean: number };
  readonly busyMs: { p50: number; p95: number; mean: number };
  /** Mean ms per window, by leaf category. */
  readonly scriptMs: Readonly<Record<Category, number>>;
  readonly entryMs: Readonly<Record<Category, number>>;
  readonly styleMs: number;
  readonly layoutMs: number;
  readonly paintMs: number;
  readonly gcMs: number;
  readonly scriptTotalMs: number;
  readonly rafCallbacksMean: number;
}

export function summarize(windows: readonly FrameWindow[]): WindowSummary {
  const stat = (values: readonly number[]) => ({ p50: percentile(values, 50), p95: percentile(values, 95), mean: mean(values) });
  const script = zeroRecord();
  const entry = zeroRecord();
  for (const window of windows) {
    for (const category of CATEGORIES) {
      script[category] += window.scriptMs[category];
      entry[category] += window.entryMs[category];
    }
  }
  const n = Math.max(1, windows.length);
  for (const category of CATEGORIES) {
    script[category] /= n;
    entry[category] /= n;
  }
  let scriptTotal = 0;
  for (const category of CATEGORIES) scriptTotal += script[category];
  return {
    frames: windows.length,
    intervalMs: stat(windows.map((window) => window.intervalMs)),
    busyMs: stat(windows.map((window) => window.busyMs)),
    scriptMs: script,
    entryMs: entry,
    styleMs: mean(windows.map((window) => window.styleMs)),
    layoutMs: mean(windows.map((window) => window.layoutMs)),
    paintMs: mean(windows.map((window) => window.paintMs)),
    gcMs: mean(windows.map((window) => window.gcMs)),
    scriptTotalMs: scriptTotal,
    rafCallbacksMean: mean(windows.map((window) => window.rafCallbacks)),
  };
}

/**
 * The heaviest stacks by ENTRY label — which top-level callback the time lives under —
 * and by self function, for the report's "what is that, exactly" column.
 */
export function topEntries(samples: readonly Sample[], from: number, to: number, limit = 12): Array<{ label: string; ms: number }> {
  const totals = new Map<string, number>();
  for (const sample of samples) {
    if (sample.ts < from || sample.ts >= to || sample.isIdle) continue;
    totals.set(sample.entryLabel, (totals.get(sample.entryLabel) ?? 0) + sample.weight);
  }
  return [...totals]
    .map(([label, us]) => ({ label, ms: us / 1000 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

export interface Latency {
  readonly inputTs: number;
  readonly type: string;
  readonly toCommitMs: number | null;
  readonly handlerMs: number;
}

/**
 * For every input event of the named types, the time from its dispatch to the end of the
 * next main-thread `Commit` — the first frame handed to the compositor after the input,
 * whether or not later inputs were coalesced into it. Null when no commit followed inside
 * the measured window.
 */
export function inputLatencies(thread: MainThread, types: ReadonlySet<string>, from: number, to: number): Latency[] {
  const dispatches = thread.spans.filter((span) => {
    if (span.name !== "EventDispatch" || span.ts < from || span.ts > to) return false;
    const data = (span.args?.["data"] ?? {}) as { type?: string };
    return typeof data.type === "string" && types.has(data.type);
  });
  const commits = thread.spans.filter((span) => span.name === "Commit" || span.name === "Paint");
  const out: Latency[] = [];
  let commitIndex = 0;
  for (const dispatch of dispatches) {
    while (commitIndex < commits.length && (commits[commitIndex] as Span).ts + (commits[commitIndex] as Span).dur < dispatch.ts) commitIndex += 1;
    const commit = commits[commitIndex];
    const data = (dispatch.args?.["data"] ?? {}) as { type?: string };
    const landed = commit !== undefined && commit.ts + commit.dur <= to;
    out.push({
      inputTs: dispatch.ts,
      type: data.type ?? "",
      toCommitMs: landed && commit !== undefined ? (commit.ts + commit.dur - dispatch.ts) / 1000 : null,
      handlerMs: dispatch.dur / 1000,
    });
  }
  return out;
}

/** Total main-thread busy time between two trace timestamps, in ms. */
export function busyBetween(thread: MainThread, from: number, to: number): number {
  let total = 0;
  for (const task of thread.tasks) {
    if (task.ts + task.dur < from || task.ts > to) continue;
    total += Math.min(task.ts + task.dur, to) - Math.max(task.ts, from);
  }
  return total / 1000;
}

/** Script ms by leaf category between two trace timestamps (samples, idle excluded). */
export function scriptBetween(thread: MainThread, from: number, to: number): Record<Category, number> {
  const out = zeroRecord();
  for (const sample of thread.samples) {
    if (sample.ts < from || sample.ts >= to || sample.isIdle) continue;
    out[sample.leaf] += sample.weight / 1000;
  }
  return out;
}

/** Counts of named timeline spans between two timestamps, for "what ran" questions. */
export function countSpans(thread: MainThread, from: number, to: number): Record<string, { count: number; ms: number }> {
  const out: Record<string, { count: number; ms: number }> = {};
  for (const span of thread.spans) {
    if (span.ts < from || span.ts >= to) continue;
    const entry = (out[span.name] ??= { count: 0, ms: 0 });
    entry.count += 1;
    entry.ms += span.dur / 1000;
    // Input events also count under `EventDispatch:<type>`, so a reader can tell a real
    // pointer move from the `slotchange` bursts the DOM raises with no one at the mouse.
    if (span.name === "EventDispatch") {
      const type = (span.args?.["data"] as { type?: string } | undefined)?.type;
      if (typeof type === "string") {
        const typed = (out[`EventDispatch:${type}`] ??= { count: 0, ms: 0 });
        typed.count += 1;
        typed.ms += span.dur / 1000;
      }
    }
  }
  return out;
}
