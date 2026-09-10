import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { fitAll, viewportSettled } from "../app.ts";
import { markTrace, startTrace, traceTsOfMark } from "./cdp.ts";
import { drainReactCounts, readControls, setFiberWalk } from "./page-hooks.ts";
import type { CommitRecord, ControlReading } from "./page-hooks.ts";
import { assertWalkNotBlind, classifyWalk } from "../../perf/fiber-walk.ts";
import {
  busyBetween,
  countSpans,
  frameWindows,
  inputLatencies,
  parseMainThread,
  percentile,
  scriptBetween,
  summarize,
  topEntries,
} from "../../perf/trace-parser.ts";
import type { Category, Latency, TraceEvent, WindowSummary } from "../../perf/trace-parser.ts";
import { keepRawTraces } from "./prune-traces.ts";
import { writeFileSync } from "node:fs";

/**
 * The scenarios of T1235, each as: controls → trace on → mark → gesture/wait → mark →
 * trace off → parse. One trace per scenario keeps a capture at ~5 s (≈130k events per
 * 3 s measured), which is what a 5 s window at 100 Hz costs, and the trace start/stop
 * sit outside the marks so their cost is never inside a window.
 */
export interface ScenarioResult {
  readonly scenario: string;
  readonly variant: string;
  readonly pass: number;
  readonly controls: ControlReading;
  readonly windowMs: number;
  readonly frames: WindowSummary | null;
  readonly busyMs: number;
  readonly scriptMs: Record<Category, number>;
  readonly topEntries: Array<{ label: string; ms: number }>;
  readonly spans: Record<string, { count: number; ms: number }>;
  readonly reactCommits: { count: number; actualDurationMs: number[]; performedFibers: (number | null)[]; signatures: (string | null)[] };
  readonly renders: Record<string, number>;
  /**
   * The idle scenarios measure the frame budget with the fiber walk OFF, so their windows
   * carry no render counts at all (T1260). This is a SECOND, short, UNTRACED window taken
   * right after, with the walk on: it says what the idle commits actually are without a
   * single one of its own samples landing in the numbers above. `null` where the scenario
   * walked its own window.
   */
  readonly walkProbe: WalkProbe | null;
  readonly latencies: Latency[] | null;
  readonly hub: Record<string, string> | null;
  readonly note: string;
  /** The raw CDP trace on disk, or `null` — the default (T1277). See `capture` below. */
  readonly traceFile: string | null;
}

export interface WalkProbe {
  readonly ms: number;
  readonly count: number;
  readonly actualDurationMs: number[];
  readonly performedFibers: (number | null)[];
  readonly signatures: (string | null)[];
  readonly renders: Record<string, number>;
}

export interface ScenarioContext {
  readonly page: Page;
  readonly outDir: string;
  readonly fixture: string;
  readonly baseUrl: string;
}

interface Captured {
  readonly events: TraceEvent[];
  readonly startNow: number;
  readonly endNow: number;
  readonly commits: CommitRecord[];
  readonly renders: Record<string, number>;
  readonly controls: ControlReading;
  readonly traceFile: string | null;
}

/**
 * T1277 / §B206 — THE RAW TRACE IS OPT-IN, and the reason the switch can be this blunt is
 * that NOTHING IN THE HARNESS READS THE FILE BACK. `analyse` below parses the event array
 * `tracer.stop()` returns, in memory, and `summarize.ts` reads only `<fixture>.json` (it
 * filters `.trace.json` out by name). The file was only ever a keepsake to open in
 * DevTools → Performance → Load profile — and at 27–110 MB per scenario, ~14 scenarios per
 * fixture, it cost 18 GB before anyone loaded one.
 *
 * So the default does not write it, rather than writing it and deleting it afterwards.
 * That ordering is the point: a scenario that throws mid-run (§B204 did, tonight) skips
 * every cleanup path there is, and bytes that were never written cannot be orphaned by a
 * crash. `PERF_KEEP_TRACES=1` brings the file back for the run that actually wants a flame
 * chart; `prune-traces.ts` is what takes those bytes back later.
 */
const KEEP_TRACES = keepRawTraces(process.env);

/** Wraps a gesture in a trace with marks on either side; the gesture runs inside. */
async function capture(
  context: ScenarioContext,
  key: string,
  walk: boolean,
  body: () => Promise<void>,
): Promise<Captured> {
  const { page } = context;
  const controls = await readControls(page);
  await drainReactCounts(page);
  await setFiberWalk(page, walk);
  const tracer = await startTrace(page);
  const startNow = await markTrace(page, `perf:${key}:start`);
  await body();
  const endNow = await markTrace(page, `perf:${key}:end`);
  const events = await tracer.stop();
  await setFiberWalk(page, false);
  const { commits, renders } = await drainReactCounts(page);
  let traceFile: string | null = null;
  if (KEEP_TRACES) {
    traceFile = `${context.outDir}/${context.fixture}-${key}.trace.json`;
    writeFileSync(traceFile, JSON.stringify(events));
  }
  return { events, startNow, endNow, commits, renders, controls, traceFile };
}

/**
 * A short walked window with NO trace running, taken after an idle scenario has already
 * been measured (T1260). Its whole job is to answer "what are those idle commits?" for a
 * window whose own numbers must not carry the walk's cost — and to be the place where a
 * walk that has stopped seeing React's work gets caught, because on any live fixture these
 * commits provably render something.
 */
const WALK_PROBE_MS = 1500;

async function walkProbe(context: ScenarioContext, label: string, ms: number): Promise<WalkProbe> {
  const { page } = context;
  await drainReactCounts(page);
  await setFiberWalk(page, true);
  await page.waitForTimeout(ms);
  await setFiberWalk(page, false);
  const { commits, renders } = await drainReactCounts(page);
  const performedFibers = commits.map((commit) => commit.performed);
  assertWalkNotBlind(`${label} walk probe`, classifyWalk(performedFibers));
  return {
    ms,
    count: commits.length,
    actualDurationMs: commits.map((commit) => commit.actualDuration),
    performedFibers,
    signatures: commits.map((commit) => commit.signature),
    renders,
  };
}

function analyse(
  context: ScenarioContext,
  captured: Captured,
  key: string,
  meta: { scenario: string; variant: string; pass: number; note: string; latencyTypes?: ReadonlySet<string>; hub?: Record<string, string> | null; walkProbe?: WalkProbe | null },
): ScenarioResult {
  const thread = parseMainThread(captured.events, context.baseUrl);
  const from = traceTsOfMark(captured.events, `perf:${key}:start`);
  const to = traceTsOfMark(captured.events, `perf:${key}:end`);
  const windows = frameWindows(thread, from, to);
  const commits = captured.commits.filter((commit) => commit.t >= captured.startNow && commit.t <= captured.endNow);
  const performedFibers = commits.map((commit) => commit.performed);
  // §V936 — the check that makes the number safe. A window that was WALKED and reports not
  // one rendered fiber is the instrument failing, not the app resting; it must stop the
  // run rather than print an empty column that reads like a zero (T1260).
  assertWalkNotBlind(`${meta.scenario} ${meta.variant} pass ${meta.pass}`, classifyWalk(performedFibers));
  return {
    scenario: meta.scenario,
    variant: meta.variant,
    pass: meta.pass,
    controls: captured.controls,
    windowMs: (to - from) / 1000,
    frames: windows.length >= 2 ? summarize(windows) : null,
    busyMs: busyBetween(thread, from, to),
    scriptMs: scriptBetween(thread, from, to),
    topEntries: topEntries(thread.samples, from, to, 15),
    spans: countSpans(thread, from, to),
    reactCommits: {
      count: commits.length,
      actualDurationMs: commits.map((commit) => commit.actualDuration),
      performedFibers,
      signatures: commits.map((commit) => commit.signature),
    },
    renders: captured.renders,
    walkProbe: meta.walkProbe ?? null,
    latencies: meta.latencyTypes === undefined ? null : inputLatencies(thread, meta.latencyTypes, from, to),
    hub: meta.hub ?? null,
    note: meta.note,
    traceFile: captured.traceFile,
  };
}

/** The hub's own numbers, read out of the DOM the panel and top bar render. */
export async function readHub(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const text = (selector: string): string => document.querySelector(selector)?.textContent?.trim() ?? "(absent)";
    const out: Record<string, string> = {
      fps: text('[aria-label="Frames per second"]'),
      gpuTopBar: text('[aria-label="GPU time per frame"]'),
    };
    const panel = document.querySelector('[data-testid="performance-panel"]');
    if (panel === null) {
      out["panel"] = "(absent)";
      return out;
    }
    const frame = panel.querySelector('section[aria-label="Frame"]');
    out["frame"] = frame?.textContent?.replace(/\s+/g, " ").trim() ?? "(absent)";
    const cost = panel.querySelector('section[aria-label="Cost"]');
    const rows = cost === null ? [] : [...cost.querySelectorAll("tbody tr")];
    out["cost"] = rows.map((row) => [...row.querySelectorAll("th,td")].map((cell) => cell.textContent?.trim() ?? "").join("|")).join(" ; ");
    const plan = panel.querySelector('section[aria-label="Plan"]');
    out["plan"] = plan?.textContent?.replace(/\s+/g, " ").trim() ?? "(absent)";
    return out;
  });
}

async function selectDockTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole("tab", { name });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** A — idle, playing, with the bottom dock on the named tab. 3 s warm-up, 5 s window. */
export async function scenarioIdlePlaying(context: ScenarioContext, pass: number, tab: "examples" | "performance"): Promise<ScenarioResult> {
  const { page } = context;
  await selectDockTab(page, tab);
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.waitForTimeout(3000);
  const key = `A-${tab}-${pass}`;
  const captured = await capture(context, key, false, () => page.waitForTimeout(5000));
  const hub = await readHub(page);
  const probe = await walkProbe(context, key, WALK_PROBE_MS);
  return analyse(context, captured, key, {
    scenario: "A",
    variant: `dock tab: ${tab}`,
    pass,
    note: "idle, transport playing, no input; 3 s warm-up before the window",
    hub,
    walkProbe: probe,
  });
}

/** B — idle, paused: what still runs at display rate with the transport stopped. */
export async function scenarioIdlePaused(context: ScenarioContext, pass: number): Promise<ScenarioResult> {
  const { page } = context;
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await page.waitForTimeout(1500);
  const key = `B-${pass}`;
  const captured = await capture(context, key, false, () => page.waitForTimeout(5000));
  const hub = await readHub(page);
  const probe = await walkProbe(context, key, WALK_PROBE_MS);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  return analyse(context, captured, key, {
    scenario: "B",
    variant: "transport paused",
    pass,
    note: "idle, transport paused; 1.5 s after the pause click",
    hub,
    walkProbe: probe,
  });
}

/** F — select a node and wait for the inspector to show it. */
export async function scenarioSelect(context: ScenarioContext, pass: number, nodeId: string): Promise<ScenarioResult> {
  const { page } = context;
  await fitAll(page);
  // Deselect first so the selection actually changes.
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await page.waitForTimeout(500);
  const key = `F-${pass}`;
  const name = page.getByTestId(`node-name-${nodeId}`);
  let wallMs = Number.NaN;
  const captured = await capture(context, key, true, async () => {
    const before = await page.evaluate(() => performance.now());
    await name.click({ timeout: 10_000 });
    await expect(page.getByRole("tabpanel", { name: "inspector" }).locator(`[data-node-id="${nodeId}"]`)).toHaveCount(1);
    const after = await page.evaluate(() => performance.now());
    wallMs = after - before;
    await page.waitForTimeout(300);
  });
  return analyse(context, captured, key, {
    scenario: "F",
    variant: `select ${nodeId}`,
    pass,
    note: `page wall time from before the click to the inspector showing the node (upper bound, includes two driver round trips): ${wallMs.toFixed(1)} ms; the inspector's tab panel was queried, not made visible`,
    latencyTypes: new Set(["mousedown", "click", "pointerdown"]),
  });
}

const MOVES = 120;
const GESTURE_MS = 2000;

/** C — drag a numeric field in the inspector: ~120 moves over 2 s. */
export async function scenarioKnobDrag(context: ScenarioContext, pass: number, nodeId: string, label: string): Promise<ScenarioResult> {
  const { page } = context;
  const panel = page.getByRole("tabpanel", { name: "inspector" });
  if ((await panel.locator(`[data-node-id="${nodeId}"]`).count()) === 0) {
    await fitAll(page);
    // The same sequence F uses: a pane click first, so the name is not under whatever a
    // preceding drag left hovering, and a bounded click so a covered target fails loudly
    // instead of retrying for the test's whole timeout.
    await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
    await page.waitForTimeout(300);
    await page.getByTestId(`node-name-${nodeId}`).click({ timeout: 10_000 });
    await expect(panel.locator(`[data-node-id="${nodeId}"]`)).toHaveCount(1);
  }
  const field = page.locator(`input[aria-label="${label}"]`);
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (box === null) throw new Error(`"${label}" has no box on screen`);
  const startX = box.x + 30;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.waitForTimeout(300);
  const key = `C-${pass}`;
  const before = await field.inputValue();
  let after = before;
  const captured = await capture(context, key, true, async () => {
    await page.mouse.down();
    await pacedMoves(page, (step) => ({ x: startX + (step * 160) / MOVES, y }));
    await page.mouse.up();
    after = await field.inputValue();
    await page.waitForTimeout(300);
  });
  // Put the value back through the same gesture so the fixture is not left drifted.
  await page.mouse.move(startX + 160, y);
  await page.mouse.down();
  await pacedMoves(page, (step) => ({ x: startX + 160 - (step * 160) / MOVES, y }));
  await page.mouse.up();
  return analyse(context, captured, key, {
    scenario: "C",
    variant: `${nodeId}.${label}`,
    pass,
    note: `${MOVES} pointer moves over ${GESTURE_MS} ms on "${label}"; value ${before} → ${after}`,
    latencyTypes: new Set(["pointermove", "mousemove"]),
  });
}

/** Moves the mouse on a fixed cadence; the driver round trip is inside the budget. */
async function pacedMoves(page: Page, at: (step: number) => { x: number; y: number }): Promise<void> {
  const start = Date.now();
  for (let step = 1; step <= MOVES; step += 1) {
    const point = at(step);
    await page.mouse.move(point.x, point.y);
    const due = start + (step * GESTURE_MS) / MOVES;
    const wait = due - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  }
}

/** D — drag a node on the canvas, 120 moves over 2 s. */
export async function scenarioNodeDrag(context: ScenarioContext, pass: number, nodeId: string): Promise<ScenarioResult> {
  const { page } = context;
  await fitAll(page);
  const name = page.getByTestId(`node-name-${nodeId}`);
  const box = await name.boundingBox();
  if (box === null) throw new Error(`node "${nodeId}" name has no box on screen`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.waitForTimeout(300);
  const key = `D-${pass}`;
  const captured = await capture(context, key, true, async () => {
    await page.mouse.down();
    await pacedMoves(page, (step) => ({ x: x + (step * 200) / MOVES, y: y + (step * 80) / MOVES }));
    await page.mouse.up();
    await page.waitForTimeout(300);
  });
  // Drag it back from where it actually landed (snapping moves it off the pointer).
  const landed = await name.boundingBox();
  if (landed === null) throw new Error(`node "${nodeId}" name left the screen after the drag`);
  const lx = landed.x + landed.width / 2;
  const ly = landed.y + landed.height / 2;
  await page.mouse.move(lx, ly);
  await page.mouse.down();
  await pacedMoves(page, (step) => ({ x: lx - (step * 200) / MOVES, y: ly - (step * 80) / MOVES }));
  await page.mouse.up();
  return analyse(context, captured, key, {
    scenario: "D",
    variant: `drag ${nodeId}`,
    pass,
    note: `${MOVES} pointer moves over ${GESTURE_MS} ms, 200×80 screen px, from the fit-all zoom`,
    latencyTypes: new Set(["pointermove", "mousemove"]),
  });
}

/** E — wheel zoom in and out over the canvas centre, then a middle-button pan. */
export async function scenarioPanZoom(context: ScenarioContext, pass: number): Promise<ScenarioResult> {
  const { page } = context;
  await fitAll(page);
  const pane = await page.locator(".react-flow__pane").boundingBox();
  if (pane === null) throw new Error("the canvas pane has no box");
  const cx = pane.x + pane.width / 2;
  const cy = pane.y + pane.height / 2;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  const key = `E-${pass}`;
  const captured = await capture(context, key, true, async () => {
    for (let step = 0; step < 20; step += 1) {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(40);
    }
    for (let step = 0; step < 20; step += 1) {
      await page.mouse.wheel(0, 60);
      await page.waitForTimeout(40);
    }
    await page.mouse.down({ button: "middle" });
    await pacedMoves(page, (step) => ({ x: cx + (step * 300) / MOVES, y: cy + (step * 100) / MOVES }));
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(300);
  });
  await fitAll(page);
  await viewportSettled(page);
  return analyse(context, captured, key, {
    scenario: "E",
    variant: "wheel zoom ×40 then middle-button pan",
    pass,
    note: `20 wheel steps in, 20 out (40 ms apart), then ${MOVES} pan moves over ${GESTURE_MS} ms`,
    latencyTypes: new Set(["wheel", "pointermove", "mousemove"]),
  });
}

export function p50p95(values: readonly number[]): { p50: number; p95: number } {
  return { p50: percentile(values, 50), p95: percentile(values, 95) };
}
