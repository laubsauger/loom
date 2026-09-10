import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { APP_VIEWPORT, addNode, fitAll, openApp, viewportSettled } from "./app.ts";

/**
 * B195, THE LEGITIMATE CASE THE FIX COULD SWALLOW.
 *
 * While the pan key is held, `xyflow-theme.css` makes every node transparent to the
 * pointer so alt+drag pans wherever it lands — including on the one preview tile that
 * fills the canvas at zoom 8 (`max-zoom-gestures.spec.ts`). One tile is the exception:
 * an ORBITABLE tile owns alt+drag as its camera (T675), and the same rule keeps it opaque
 * through `[data-inspect]`. This gate is that exception, at the zoom where the rule
 * matters: alt+drag over a points tile moves the camera 0 px, and the press reaches the
 * tile — which is asserted on the value the tile publishes, not on a listener. A press
 * with alt down COMMITS the peek (`node-preview-slot.tsx`), so `data-inspect` stays
 * `adjustable` after alt is released only if the press reached the tile rather than
 * the pane beneath it.
 *
 * HEADED LANE ONLY. A tile is orbitable when the INSTALLED plan says its output has a
 * camera (`graph-pane.tsx` reads `installedPlan.outputs`), and a plan is installed only
 * on a real adapter — the headless lane resolves none (§V895), so there `data-inspect`
 * never appears and this test could not even start. `playwright.config.ts` routes it by
 * basename.
 */
test.use({ viewport: APP_VIEWPORT });

/** React Flow's viewport transform, as the browser is applying it. */
async function camera(page: Page): Promise<{ zoom: number; tx: number; ty: number }> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (element === null) throw new Error("no react-flow viewport");
    const { a, e, f } = new DOMMatrix(getComputedStyle(element).transform);
    return { zoom: a, tx: e, ty: f };
  });
}

/** The pane's max zoom (`graph-canvas.tsx`), reached with the wheel over `at`. */
const MAX_ZOOM = 8;
async function wheelZoomToMax(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y);
  for (let step = 0; step < 60; step += 1) {
    if ((await camera(page)).zoom >= MAX_ZOOM) break;
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(20);
  }
  await viewportSettled(page);
  expect((await camera(page)).zoom, "the wheel never reached the pane's max zoom").toBe(MAX_ZOOM);
}

/** Screen px of the gesture. */
const DRAG = { x: 160, y: 96 } as const;

/**
 * Adds one node, zooms the wheel to max over its preview and returns the canvas centre —
 * asserted to be INSIDE a tile that is wider than the canvas. Without that precondition
 * a test could pass by pressing on the pane, which panned fine before the fix.
 */
async function zoomIntoTile(
  page: Page,
  category: string,
  title: string,
): Promise<{ nodeId: string; at: { x: number; y: number } }> {
  const nodeId = await addNode(page, category, title);
  await fitAll(page);

  const slot = page.getByTestId(`node-preview-${nodeId}`);
  const box = await slot.boundingBox();
  if (box === null) throw new Error("the preview slot has no box on screen");
  await wheelZoomToMax(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  const canvas = await page.getByTestId("graph-canvas").boundingBox();
  if (canvas === null) throw new Error("the graph canvas has no box on screen");
  const at = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  const under = await page.evaluate(
    ({ at, nodeId }) => {
      const element = document.elementFromPoint(at.x, at.y);
      return element?.closest(`[data-testid="node-preview-${nodeId}"]`) !== null;
    },
    { at, nodeId },
  );
  expect(under, "the canvas centre is not over the preview tile, so nothing is being gated").toBe(
    true,
  );
  const zoomed = await slot.boundingBox();
  if (zoomed === null) throw new Error("the preview slot left the screen");
  expect(zoomed.width, "the tile does not fill the canvas — the pane is still reachable").toBeGreaterThan(
    canvas.width,
  );
  return { nodeId, at };
}

/** Alt+drag from `at` — `panActivationKeyCode`, the trackpad's only pan gesture. */
async function altDrag(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(at.x + DRAG.x, at.y + DRAG.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
}

test("at max zoom, alt+drag over an orbitable tile is still its camera, not a pan (T675)", async ({
  page,
}) => {
  await openApp(page);
  const { nodeId, at } = await zoomIntoTile(page, "points", "Grid Points");
  const tile = page.getByTestId(`node-preview-${nodeId}`).locator("[data-inspect]");
  await expect(tile, "a points tile is orbitable, and says so").toHaveAttribute("data-inspect", "home");

  const before = await camera(page);
  await altDrag(page, at);
  const after = await camera(page);
  expect(
    { dx: after.tx - before.tx, dy: after.ty - before.ty },
    "alt+drag over an orbitable tile panned the canvas instead of reaching the camera",
  ).toEqual({ dx: 0, dy: 0 });
  // A press with alt down COMMITS the peek (node-preview-slot.tsx): the tile stays
  // adjustable after alt is released only if the press reached it rather than the pane.
  await expect(tile, "the press never reached the tile").toHaveAttribute("data-inspect", "adjustable");
});
