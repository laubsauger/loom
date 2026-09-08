import { test, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openApp } from "../app.ts";
import { installPageHooks } from "./page-hooks.ts";
import { buildSyntheticChain, CHAIN_200 } from "./synthetic-chain.ts";
import {
  scenarioIdlePaused,
  scenarioIdlePlaying,
  scenarioKnobDrag,
  scenarioNodeDrag,
  scenarioPanZoom,
  scenarioSelect,
} from "./scenarios.ts";
import type { ScenarioContext, ScenarioResult } from "./scenarios.ts";

/**
 * T1235 — the main-thread profile of the running app, per fixture and scenario.
 *
 * One test per fixture, each in ITS OWN browser (launched and closed here, not the
 * runner's shared one), run sequentially: two Chromiums on one GPU would each be the
 * other's noise. Every fixture is opened through the product's own open path — the
 * `project-open` button and the file chooser — never a shortcut into the store.
 *
 * Order is alternated inside a fixture (§V933): pass 1 runs the scenarios forward, pass
 * 2 runs the interactive ones in reverse and the idle ones in the other tab order, so no
 * scenario only ever sits in the tail of one particular predecessor.
 *
 * Output: `PERF_OUT_DIR/<fixture>.json` with every scenario's parsed numbers, plus the
 * raw trace of each scenario next to it. `summarize.ts` turns the JSON into the tables
 * in `docs/perf-profile-*.md`.
 */
interface Fixture {
  readonly name: string;
  readonly path?: string;
  readonly synthetic?: true;
  readonly knob: { nodeId: string; label: string };
  readonly dragNodeId: string;
  readonly scaling?: true;
}

const ROOT = resolve(import.meta.dirname, "../../../..");

const FIXTURES: readonly Fixture[] = [
  {
    name: "E24",
    path: resolve(ROOT, "examples/E24-Audio-Reaction-Diffusion.loom.json"),
    knob: { nodeId: "chem", label: "Brightness" },
    dragNodeId: "chem",
  },
  {
    name: "E55",
    path: resolve(ROOT, "examples/E55-Reactor.loom.json"),
    knob: { nodeId: "cut", label: "Brightness" },
    dragNodeId: "cut",
  },
  {
    name: "untitled-8",
    path: "/Users/flo/work/untitled-8.loom.json",
    knob: { nodeId: "nd_47c233565b2316", label: "Value" },
    dragNodeId: "nd_47c233565b2316",
  },
  {
    name: "chain-200",
    synthetic: true,
    knob: { nodeId: "", label: "Brightness" },
    dragNodeId: "",
    scaling: true,
  },
];

const OUT_DIR = process.env["PERF_OUT_DIR"] ?? resolve(ROOT, "scratchpad/perf/latest");
const ONLY = process.env["PERF_FIXTURES"]?.split(",").map((name) => name.trim()) ?? null;
/** `PERF_SCENARIOS=A,C` narrows a debugging run; the report's runs never set it. */
const SCENARIOS = process.env["PERF_SCENARIOS"]?.split(",").map((name) => name.trim()) ?? null;
/**
 * `PERF_PROBE_CSS='[aria-label=Timeline]{display:none}'` — a subtraction probe: hide one
 * piece of the page and re-measure, so a per-frame cost can be pinned on the element
 * that writes it. The report's runs never set it; a probe run says so in its output name.
 */
const PROBE_CSS = process.env["PERF_PROBE_CSS"] ?? null;
const BASE_URL = "http://localhost:5211";

test.describe.configure({ mode: "serial" });

for (const fixture of FIXTURES) {
  test(`profile ${fixture.name}`, async ({ playwright }) => {
    test.skip(ONLY !== null && !ONLY.includes(fixture.name), `PERF_FIXTURES excludes ${fixture.name}`);
    mkdirSync(OUT_DIR, { recursive: true });
    const browser: Browser = await playwright.chromium.launch({ headless: false });
    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, baseURL: BASE_URL });
      const page = await context.newPage();
      await installPageHooks(page);
      await openApp(page);

      let path = fixture.path ?? "";
      let knob = fixture.knob;
      let dragNodeId = fixture.dragNodeId;
      let counts = { nodeCount: 0, edgeCount: 0 };
      if (fixture.synthetic === true) {
        const chain = await buildSyntheticChain(CHAIN_200);
        path = resolve(OUT_DIR, "chain-200.loom.json");
        writeFileSync(path, chain.text);
        knob = { nodeId: chain.knobNodeId, label: fixture.knob.label };
        dragNodeId = chain.dragNodeId;
        counts = { nodeCount: chain.nodeCount, edgeCount: chain.edgeCount };
      }
      await openProject(page, path);
      if (fixture.synthetic !== true) {
        counts = await page.evaluate(() => ({
          nodeCount: document.querySelectorAll(".react-flow__node").length,
          edgeCount: document.querySelectorAll(".react-flow__edge").length,
        }));
      }
      await waitForPresentedFrames(page);
      if (PROBE_CSS !== null) await page.addStyleTag({ content: PROBE_CSS });
      const gpu = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter();
        return adapter === null || adapter === undefined ? "none" : `${adapter.info.vendor}/${adapter.info.architecture}`;
      });
      const display = await page.evaluate(
        () =>
          new Promise<number>((done) => {
            const stamps: number[] = [];
            const tick = (t: number): void => {
              stamps.push(t);
              if (stamps.length < 30) requestAnimationFrame(tick);
              else done(((stamps[29] as number) - (stamps[0] as number)) / 29);
            };
            requestAnimationFrame(tick);
          }),
      );

      const scenarioContext: ScenarioContext = { page, outDir: OUT_DIR, fixture: fixture.name, baseUrl: BASE_URL };
      const results: ScenarioResult[] = [];
      const run = async (scenario: string, step: () => Promise<ScenarioResult>): Promise<void> => {
        if (SCENARIOS !== null && !SCENARIOS.includes(scenario)) return;
        const result = await step();
        results.push(result);
        console.log(
          `${fixture.name} ${result.scenario} [${result.variant}] pass ${result.pass}: busy ${result.busyMs.toFixed(0)} ms of ${result.windowMs.toFixed(0)} ms` +
            (result.frames === null ? "" : `, frame p50 ${result.frames.busyMs.p50.toFixed(2)} / p95 ${result.frames.busyMs.p95.toFixed(2)} ms busy, interval p50 ${result.frames.intervalMs.p50.toFixed(2)} ms`) +
            `, controls cheap ${median(result.controls.cheapMs).toFixed(2)} dear ${median(result.controls.dearMs).toFixed(2)} ms`,
        );
      };

      if (fixture.scaling === true) {
        await run("A", () => scenarioIdlePlaying(scenarioContext, 1, "examples"));
        await run("A", () => scenarioIdlePlaying(scenarioContext, 1, "performance"));
        await run("D", () => scenarioNodeDrag(scenarioContext, 1, dragNodeId));
        await run("E", () => scenarioPanZoom(scenarioContext, 1));
        await run("E", () => scenarioPanZoom(scenarioContext, 2));
        await run("D", () => scenarioNodeDrag(scenarioContext, 2, dragNodeId));
        await run("A", () => scenarioIdlePlaying(scenarioContext, 2, "performance"));
        await run("A", () => scenarioIdlePlaying(scenarioContext, 2, "examples"));
      } else {
        await run("A", () => scenarioIdlePlaying(scenarioContext, 1, "examples"));
        await run("A", () => scenarioIdlePlaying(scenarioContext, 1, "performance"));
        await run("B", () => scenarioIdlePaused(scenarioContext, 1));
        await run("F", () => scenarioSelect(scenarioContext, 1, knob.nodeId));
        await run("C", () => scenarioKnobDrag(scenarioContext, 1, knob.nodeId, knob.label));
        await run("D", () => scenarioNodeDrag(scenarioContext, 1, dragNodeId));
        await run("E", () => scenarioPanZoom(scenarioContext, 1));
        await run("E", () => scenarioPanZoom(scenarioContext, 2));
        await run("D", () => scenarioNodeDrag(scenarioContext, 2, dragNodeId));
        await run("C", () => scenarioKnobDrag(scenarioContext, 2, knob.nodeId, knob.label));
        await run("F", () => scenarioSelect(scenarioContext, 2, knob.nodeId));
        await run("B", () => scenarioIdlePaused(scenarioContext, 2));
        await run("A", () => scenarioIdlePlaying(scenarioContext, 2, "performance"));
        await run("A", () => scenarioIdlePlaying(scenarioContext, 2, "examples"));
      }

      const userAgent = await page.evaluate(() => navigator.userAgent);
      writeFileSync(
        resolve(OUT_DIR, `${fixture.name}.json`),
        JSON.stringify(
          {
            fixture: fixture.name,
            path,
            ...counts,
            gpu,
            displayIntervalMs: display,
            userAgent,
            when: new Date().toISOString(),
            results,
          },
          null,
          1,
        ),
      );
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** The product's open path: the toolbar button, the file chooser, the discard prompt if any. */
async function openProject(page: Page, path: string): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  const discard = page.getByRole("button", { name: "Discard" });
  const chooser = await Promise.race([
    chooserPromise,
    discard.waitFor({ timeout: 2000 }).then(() => null, () => null),
  ]);
  if (chooser === null) {
    await discard.click();
    await (await chooserPromise).setFiles(path);
  } else {
    await chooser.setFiles(path);
  }
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
}

async function waitForPresentedFrames(page: Page): Promise<void> {
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const probe = (
            window as unknown as {
              loomViewerProbe?: () => Promise<{ presentation: { presentedFrames: number; sourceBound: boolean } | null }>;
            }
          ).loomViewerProbe;
          const presentation = (await probe?.())?.presentation ?? null;
          return presentation !== null && presentation.sourceBound && presentation.presentedFrames > 0;
        }),
      { message: "the runtime never presented the project into the viewer canvas", timeout: 30_000 },
    )
    .toBe(true);
}
