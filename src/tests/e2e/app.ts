import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Shared driving for the browser suite (T48, §V15).
 *
 * ## What this environment can and cannot run, stated once
 *
 * **There is no WebGPU in Playwright's Chromium here.** `navigator.gpu` is `undefined` in
 * the bundled Chromium and in system Chrome, headless and headed, with and without
 * `--enable-unsafe-webgpu` — measured, not assumed. The app degrades honestly in that
 * case (`gpu.unavailable`, "Editing still works"), which is what makes the specs in this
 * directory possible at all: connecting, undo/redo, parameter drag and save/reload are
 * all editor-and-domain behaviour and none of them needs a device.
 *
 * What that rules out is anything about PIXELS: a live preview, a viewer image, a
 * rendered output, and the half of "shader error recovery" that is about the last valid
 * output continuing to render. Those claims live in the Dawn suites
 * (`src/tests/headless/**`, `src/tests/acceptance/**`), where a real GPU exists with no
 * browser. Nothing here is written as a spec that skips itself into a green tick — see
 * `shader-errors.spec.ts` for how the unrunnable half is recorded instead.
 *
 * ## Two mechanical facts that cost an afternoon each
 *
 * 1. **`scrollIntoViewIfNeeded()` before any pointer gesture in the inspector.** The
 *    inspector's parameter list scrolls inside a pane, and `getBoundingClientRect` —
 *    which is what Playwright's `boundingBox()` reports — gives the geometric rect even
 *    when an ancestor's overflow has clipped the element off-screen. Dragging at those
 *    coordinates silently lands on whatever pane is actually there, the gesture does
 *    nothing, and the assertion fails with no clue why.
 * 2. **A connect gesture needs intermediate moves.** React Flow starts a connection on
 *    pointerdown over a handle and only completes it if it sees movement before the
 *    pointerup. A straight down/up, or a single jump to the target, produces no edge.
 */

export const APP_VIEWPORT = { width: 1600, height: 1000 } as const;

/** Opens the app and waits for the shell rather than for a network idle guess. */
export async function openApp(page: Page): Promise<void> {
  // Force the download / <input type="file"> paths for save and open. The File System
  // Access pickers exist in Chromium and open a NATIVE dialog no automation can drive,
  // so a spec that let them through would hang. Both fallbacks are real shipped paths.
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    delete win["showSaveFilePicker"];
    delete win["showOpenFilePicker"];
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  // The library pane is ready when its search box is: T427 dissolved the old
  // "Node Library" wrapper section, so the search box is the stable landmark.
  await expect(page.locator('input[aria-label="Search nodes"]')).toBeVisible();
}

/** Adds a node from the library by its category and title, and returns its React Flow id. */
export async function addNode(page: Page, category: string, title: string): Promise<string> {
  const before = await page.locator(".react-flow__node").count();
  await page
    .locator(`section[aria-label="${category}"] button`, { hasText: new RegExp(`^${title}`) })
    .first()
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  const added = page.locator(".react-flow__node").nth(before);
  const id = await added.getAttribute("data-id");
  if (id === null) throw new Error(`the node added for "${title}" carries no data-id`);
  return id;
}

/** A node's own handle, port-scoped — `nodeId` alone is never enough (§V59). */
export function handle(page: Page, nodeId: string, portId: string, kind: "source" | "target"): Locator {
  return page.locator(
    `.react-flow__handle.${kind}[data-nodeid="${nodeId}"][data-handleid="${portId}"]`,
  );
}

/**
 * The connect gesture, as a human performs it: press on the output handle, move, release
 * on the input handle. Deliberately NOT `dragTo` — that dispatches a down and an up with
 * one move between, which React Flow does not read as a connection.
 */
export async function connect(
  page: Page,
  from: { nodeId: string; portId: string },
  to: { nodeId: string; portId: string },
): Promise<void> {
  const source = handle(page, from.nodeId, from.portId, "source");
  const target = handle(page, to.nodeId, to.portId, "target");
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (a === null || b === null) throw new Error("a connect endpoint has no box on screen");

  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;

  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 20, ay + 10);
  await page.mouse.move((ax + bx) / 2, (ay + by) / 2);
  await page.mouse.move(bx, by);
  await page.mouse.move(bx, by);
  await page.mouse.up();
}

/**
 * Drags a node to a new place on the canvas.
 *
 * Needed because every node the library adds lands at the same default position, and
 * overlapping nodes hide each other's handles — a connect gesture then presses on
 * whichever node happens to be on top and produces no edge.
 */
export async function moveNode(page: Page, nodeId: string, dx: number, dy: number): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const box = await node.boundingBox();
  if (box === null) throw new Error(`node "${nodeId}" has no box on screen`);
  const x = box.x + 60;
  const y = box.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Selects a node so the inspector shows its parameters. Clicks the header, not the body. */
export async function selectNode(page: Page, nodeId: string): Promise<void> {
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click({ position: { x: 40, y: 8 } });
  // The inspector lives in a dock tab panel titled by its pane (T436 layout shell).
  await expect(page.getByRole("tabpanel", { name: "inspector" })).toContainText(nodeId);
}

/**
 * A horizontal drag on a numeric control, in the increments a real drag produces.
 *
 * Returns every distinct value the field showed WHILE the pointer was down, because
 * §V15's claim has two halves — one history entry AND live values — and only the values
 * seen mid-gesture can speak to the second one.
 */
export async function dragNumber(
  page: Page,
  label: string,
  pixels: number,
): Promise<{ before: string; during: readonly string[]; after: string }> {
  const field = page.locator(`input[aria-label="${label}"]`);
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (box === null) throw new Error(`"${label}" has no box on screen`);
  const before = await field.inputValue();

  const startX = box.x + 30;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();

  // Every distinct value the field showed WHILE the pointer was down, recorded inside
  // the page on its own animation frames. Sampling over the wire instead would make a
  // missing live update indistinguishable from a slow round trip.
  await page.evaluate((name) => {
    const win = window as unknown as { __loomSeries?: string[] };
    win.__loomSeries = [];
    const tick = (): void => {
      const element = document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
      const series = win.__loomSeries;
      if (element !== null && series !== undefined && series[series.length - 1] !== element.value) {
        series.push(element.value);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, label);

  const steps = 20;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(startX + (pixels * step) / steps, y);
    await page.waitForTimeout(20);
  }
  const during = await page.evaluate(
    () => (window as unknown as { __loomSeries?: string[] }).__loomSeries ?? [],
  );
  await page.mouse.up();

  return { before, during, after: await field.inputValue() };
}

/** Focuses the graph so keyboard commands resolve in the `graph` keymap context (§V53). */
export async function focusGraph(page: Page): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
}

/**
 * The `mod` key, resolved the way the KEYMAP resolves it (`detectPlatform`, §V52).
 *
 * Asked of the page rather than of `process.platform`: the binding is data and the
 * platform test that reads it runs in the browser, so a spec that guessed from Node
 * would send Control on a mac runner and the command would simply not fire.
 */
export function modKey(page: Page): Promise<"Meta" | "Control"> {
  return page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(`${navigator.platform} ${navigator.userAgent}`)
      ? ("Meta" as const)
      : ("Control" as const),
  );
}
