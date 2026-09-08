import { describe, expect, it } from "vitest";
import {
  categorize,
  collectSamples,
  findMainThread,
  frameWindows,
  inputLatencies,
  parseMainThread,
  percentile,
  summarize,
} from "./trace-parser.ts";
import type { TraceEvent } from "./trace-parser.ts";

/**
 * The parser is what turns a raw Chromium trace into the numbers in
 * `docs/perf-profile-*.md`, so what these tests pin is the ACCOUNTING — that a µs of
 * main-thread time lands in the category, window and instrument the report says it does.
 * Every fixture here is a hand-built event list shaped like a real capture (the shapes
 * were read off one: `ProfileChunk` on V8's own thread, `MinorGC` wrapping its phases,
 * rAF fires nested in `RunTask`).
 */
const PID = 42;
const MAIN = 7;
const PROF = 99;
const URL = "http://localhost:5211";

function meta(): TraceEvent[] {
  return [
    {
      pid: PID,
      tid: MAIN,
      ts: 0,
      ph: "I",
      cat: "disabled-by-default-devtools.timeline",
      name: "TracingStartedInBrowser",
      args: { data: { frames: [{ processId: PID, url: `${URL}/` }] } },
    },
    { pid: PID, tid: MAIN, ts: 0, ph: "M", cat: "__metadata", name: "thread_name", args: { name: "CrRendererMain" } },
    { pid: PID, tid: PROF, ts: 0, ph: "M", cat: "__metadata", name: "thread_name", args: { name: "v8:ProfEvntProc" } },
  ];
}

function x(name: string, ts: number, dur: number, args?: Record<string, unknown>): TraceEvent {
  return { pid: PID, tid: MAIN, ts, dur, ph: "X", cat: "devtools.timeline", name, ...(args === undefined ? {} : { args }) };
}

/** A profile whose samples sit at the given timestamps on the given nodes. */
function profile(
  nodes: Array<{ id: number; fn: string; url: string; parent?: number }>,
  samples: Array<{ ts: number; node: number }>,
): TraceEvent[] {
  const start = 1000;
  let last = start;
  const deltas = samples.map((sample) => {
    const delta = sample.ts - last;
    last = sample.ts;
    return delta;
  });
  return [
    { pid: PID, tid: MAIN, ts: start, ph: "P", cat: "disabled-by-default-v8.cpu_profiler", name: "Profile", id: "0x1", args: { data: { startTime: start } } },
    {
      pid: PID,
      tid: PROF,
      ts: start,
      ph: "P",
      cat: "disabled-by-default-v8.cpu_profiler",
      name: "ProfileChunk",
      id: "0x1",
      args: {
        data: {
          cpuProfile: {
            nodes: nodes.map((node) => ({
              id: node.id,
              callFrame: { functionName: node.fn, url: node.url },
              ...(node.parent === undefined ? {} : { parent: node.parent }),
            })),
            samples: samples.map((sample) => sample.node),
          },
          timeDeltas: deltas,
        },
      },
    },
  ];
}

describe("categorize", () => {
  it("charges a frame to the part of the tree its URL names", () => {
    expect(categorize(`${URL}/src/runtime/backend/vgpu/vgpu-backend.ts`, "render")).toBe("backend");
    expect(categorize(`${URL}/node_modules/.vite/deps/vgpu.js`, "tick")).toBe("backend");
    expect(categorize(`${URL}/src/compiler/compile.ts`, "compileGraph")).toBe("compile");
    expect(categorize(`${URL}/src/runtime/execution/frame-driver.ts`, "tick")).toBe("frame-driver");
    expect(categorize(`${URL}/src/app/use-node-previews.ts`, "tick")).toBe("previews");
    expect(categorize(`${URL}/src/runtime/telemetry/hub.ts`, "noteFrame")).toBe("telemetry");
    expect(categorize(`${URL}/src/editor/inspect/performance-panel.tsx`, "CostCell")).toBe("telemetry");
    expect(categorize(`${URL}/node_modules/.vite/deps/react-dom_client.js`, "performWorkUntilDeadline")).toBe("react");
    expect(categorize(`${URL}/node_modules/.vite/deps/@xyflow_react.js`, "useStore")).toBe("xyflow");
    expect(categorize(`${URL}/src/editor/nodes/node-view.tsx`, "NodeView")).toBe("editor");
    expect(categorize(`${URL}/node_modules/.vite/deps/zustand.js`, "setState")).toBe("state");
  });

  it("names V8's own pseudo-frames and the harness, and leaves an unknown frame unclaimed", () => {
    expect(categorize("", "(garbage collector)")).toBe("gc");
    expect(categorize("", "(program)")).toBe("program");
    expect(categorize("", "(root)")).toBeNull();
    expect(categorize(`${URL}/src/app/app.tsx`, "__perfWalk")).toBe("harness");
    expect(categorize("chrome-extension://abc/x.js", "f")).toBeNull();
  });
});

describe("findMainThread", () => {
  it("picks the renderer TracingStartedInBrowser lists for the page and its CrRendererMain thread", () => {
    expect(findMainThread(meta(), URL)).toEqual({ pid: PID, tid: MAIN });
  });

  it("fails loudly when the renderer has no main thread in the trace", () => {
    const events = meta().filter((event) => event.name !== "thread_name");
    expect(() => findMainThread(events, URL)).toThrow(/CrRendererMain/);
  });
});

describe("collectSamples", () => {
  const nodes = [
    { id: 1, fn: "(root)", url: "" },
    { id: 2, fn: "tick", url: `${URL}/node_modules/.vite/deps/vgpu.js`, parent: 1 },
    { id: 3, fn: "render", url: `${URL}/src/runtime/backend/vgpu/vgpu-backend.ts`, parent: 2 },
    { id: 4, fn: "compileGraph", url: `${URL}/src/compiler/compile.ts`, parent: 3 },
    { id: 5, fn: "(idle)", url: "", parent: 1 },
    { id: 6, fn: "(garbage collector)", url: "", parent: 1 },
  ];

  it("charges a sample leaf-first — the compile inside the backend's frame is compile, not backend", () => {
    const events = [...meta(), ...profile(nodes, [{ ts: 1000, node: 4 }, { ts: 1500, node: 3 }, { ts: 1800, node: 3 }])];
    const { samples } = collectSamples(events, PID, MAIN);
    expect(samples.map((sample) => [sample.leaf, sample.weight])).toEqual([
      ["compile", 500],
      ["backend", 300],
      ["backend", 0],
    ]);
    // …and root-first the same sample lives under the vgpu frame loop.
    expect(samples[0]?.entry).toBe("backend");
    expect(samples[0]?.entryLabel).toBe("tick @ deps/vgpu.js");
  });

  it("weights a sample by the gap to the NEXT sample and keeps idle out of the categories", () => {
    const events = [...meta(), ...profile(nodes, [{ ts: 1000, node: 5 }, { ts: 3000, node: 6 }, { ts: 3100, node: 5 }])];
    const { samples, idleUs } = collectSamples(events, PID, MAIN);
    expect(idleUs).toBe(2000);
    expect(samples[1]).toMatchObject({ leaf: "gc", weight: 100, isIdle: false });
  });

  it("reads chunks by profile id, because V8 emits them from its own thread", () => {
    const events = [...meta(), ...profile(nodes, [{ ts: 1000, node: 3 }, { ts: 1200, node: 3 }])];
    const chunk = events.find((event) => event.name === "ProfileChunk");
    expect(chunk?.tid).toBe(PROF);
    expect(collectSamples(events, PID, MAIN).samples).toHaveLength(2);
  });
});

describe("frameWindows", () => {
  /**
   * Three rAF tasks at 0, 10, 20 ms; a timer task between the first two; a GC nested
   * inside the second window's rAF task.
   */
  function tasks(): TraceEvent[] {
    return [
      x("RunTask", 0, 3000),
      x("FireAnimationFrame", 100, 2800),
      x("Paint", 2000, 500),
      x("RunTask", 5000, 1000),
      x("TimerFire", 5000, 1000),
      x("RunTask", 10_000, 4000),
      x("FireAnimationFrame", 10_100, 2000),
      x("FireAnimationFrame", 12_200, 500),
      x("MinorGC", 13_000, 800),
      x("V8.GC_SCAVENGER", 13_100, 600),
      x("UpdateLayoutTree", 13_800, 100),
      x("Layout", 13_900, 100),
      x("RunTask", 20_000, 1000),
      x("FireAnimationFrame", 20_100, 800),
    ];
  }

  it("opens a window at every top-level task that fires a rAF and charges everything until the next one to it", () => {
    const thread = parseMainThread([...meta(), ...tasks()], URL);
    expect(thread.rafTasks.map((task) => task.ts)).toEqual([0, 10_000, 20_000]);
    const windows = frameWindows(thread, 0, 30_000);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ intervalMs: 10, busyMs: 4, paintMs: 0.5, rafCallbacks: 1 });
    expect(windows[1]).toMatchObject({ intervalMs: 10, busyMs: 4, gcMs: 0.8, styleMs: 0.1, layoutMs: 0.1, rafCallbacks: 2 });
  });

  it("counts a collection once — the outer MinorGC, not each nested phase", () => {
    const thread = parseMainThread([...meta(), ...tasks()], URL);
    const [, second] = frameWindows(thread, 0, 30_000);
    expect(second?.gcMs).toBe(0.8);
  });

  it("drops partial windows: a window needs both of its edges inside the bounds", () => {
    const thread = parseMainThread([...meta(), ...tasks()], URL);
    expect(frameWindows(thread, 5000, 30_000)).toHaveLength(1);
    expect(frameWindows(thread, 0, 15_000)).toHaveLength(1);
  });

  it("splits a window's samples by category and sums them into the summary", () => {
    const nodes = [
      { id: 1, fn: "(root)", url: "" },
      { id: 2, fn: "tick", url: `${URL}/src/app/use-node-previews.ts`, parent: 1 },
      { id: 3, fn: "render", url: `${URL}/src/runtime/backend/vgpu/vgpu-backend.ts`, parent: 2 },
      { id: 4, fn: "(idle)", url: "", parent: 1 },
    ];
    const events = [
      ...meta(),
      ...tasks(),
      ...profile(nodes, [
        { ts: 1000, node: 2 },
        { ts: 2000, node: 3 },
        { ts: 3000, node: 4 },
        { ts: 11_000, node: 3 },
        { ts: 13_000, node: 4 },
        { ts: 25_000, node: 4 },
      ]),
    ];
    const thread = parseMainThread(events, URL);
    const windows = frameWindows(thread, 0, 30_000);
    expect(windows[0]?.scriptMs).toMatchObject({ previews: 1, backend: 1 });
    expect(windows[0]?.entryMs).toMatchObject({ previews: 2, backend: 0 });
    expect(windows[1]?.scriptMs).toMatchObject({ previews: 0, backend: 2 });
    const summary = summarize(windows);
    expect(summary.frames).toBe(2);
    expect(summary.scriptMs.backend).toBe(1.5);
    expect(summary.scriptTotalMs).toBe(2);
    expect(summary.busyMs.p50).toBe(4);
  });
});

describe("inputLatencies", () => {
  it("measures each input to the end of the next Commit — coalesced inputs share one — and reports null past the last commit", () => {
    const events = [
      ...meta(),
      x("RunTask", 0, 1000),
      x("EventDispatch", 100, 400, { data: { type: "pointermove" } }),
      x("RunTask", 5000, 2000),
      x("Commit", 6000, 500),
      x("EventDispatch", 8000, 100, { data: { type: "pointermove" } }),
      x("EventDispatch", 9000, 100, { data: { type: "pointermove" } }),
      x("Commit", 12_000, 300),
      x("EventDispatch", 15_000, 100, { data: { type: "pointermove" } }),
    ];
    const thread = parseMainThread(events, URL);
    const latencies = inputLatencies(thread, new Set(["pointermove"]), 0, 20_000);
    expect(latencies.map((latency) => latency.toCommitMs)).toEqual([6.4, 4.3, 3.3, null]);
    expect(latencies[0]?.handlerMs).toBe(0.4);
  });
});

describe("percentile", () => {
  it("is nearest-rank: p50 of 1..10 is 5, p95 is 10", () => {
    const values = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
  });
});
