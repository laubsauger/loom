import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { APP_VIEWPORT, addNode, fitAll, openApp, viewportSettled } from "./app.ts";

/**
 * B195 — "OUR GRAPH SEEMS TO HAVE A MAX SIZE, CAUSING UIs TO NOT BE ABLE TO DRAG AROUND AT
 * MAX ZOOM LEVEL."
 *
 * ## What reproduced, and what did not
 *
 * None of the three leads in the row. Measured headed, on Chromium 151, at zoom 8 with the
 * viewport translate at -675 000 px (E24 stretched 20x, node at graph x=84 400): the node
 * dragged and the canvas panned exactly as at the origin. Distance from the origin, the
 * magnitude of the translate, the composited layer's size — none of them is the bug.
 *
 * What did reproduce needs no far node at all. Zoom 8 makes a 175px preview tile 1400px
 * wide, larger than the canvas, so wheel-zooming into a picture — the one thing max zoom
 * is FOR (T490) — leaves nothing under the pointer but a node. React Flow gives every
 * node wrapper its `nopan` class and its node-drag filter ignores modifier keys, so
 * alt+drag — the only pan gesture a trackpad has — starts a node drag on a header and is
 * refused outright on the preview tile (whose own wrapper is `nodrag nopan`). The wheel
 * still works, which is why zooming OUT always frees the user — and why it reads as "the
 * graph has a maximum size". A middle button would have panned (React Flow lets button 1
 * through before the `nopan` check), and the owner is on a trackpad.
 *
 * The same classes refuse the same gesture at zoom 1, on the same tile; at zoom 1 there
 * is a pane beside it to grab instead, so nobody noticed.
 *
 * ## The gate
 *
 * The literal situation: one node, zoomed to 8 over its preview until the tile covers the
 * canvas centre (asserted as a precondition — a test that happened to land on the pane
 * would pass on the broken tree). Then alt+drag at that one point, asserted on the value
 * the user reads back: the camera's translate. It was 0 on the tree before the fix.
 *
 * T1246 — the drag half. The same tile refused a plain drag too: `node-view.tsx` put
 * `nodrag nopan` on every preview wrapper, so the picture that filled the canvas moved
 * nothing. Now only the tile that owns a gesture (orbitable, T675) opts out, and a plain
 * drag on any other picture moves the node exactly as a drag on its header does — the
 * node's graph position changes by the pointer's screen distance over the zoom.
 *
 * The legitimate case the fix could swallow — on an ORBITABLE tile alt+drag is the
 * camera (T675), and a press there must keep reaching the tile — needs an installed plan
 * to mark the tile orbitable, i.e. a real adapter, i.e. the headed lane; that lane's
 * spec list lives in `playwright.config.ts`, outside B195's paths. It was verified by
 * hand (headed, Grid Points at zoom 8: alt+drag moved the camera 0 px and left the tile
 * `data-inspect="adjustable"`) and is not gated here.
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

/** A node's own graph position, read off the transform React Flow gives it. */
async function graphPosition(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.locator(`.react-flow__node[data-id="${nodeId}"]`).evaluate((element) => {
    const { e, f } = new DOMMatrix((element as HTMLElement).style.transform);
    return { x: e, y: f };
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

/** Screen px of the gesture — at zoom 8 exactly 20×12 graph px, no rounding to hide in. */
const DRAG = { x: 160, y: 96 } as const;
/** The move that crosses React Flow's 1 px `nodeDragThreshold` and opens a node drag. */
const OPENING_MOVE_PX = 2;

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

test("at max zoom, alt+drag over a preview tile that fills the canvas still pans (B195)", async ({
  page,
}) => {
  await openApp(page);
  const { at } = await zoomIntoTile(page, "generator", "Noise");

  const before = await camera(page);
  await altDrag(page, at);
  const panned = await camera(page);
  expect(
    { dx: panned.tx - before.tx, dy: panned.ty - before.ty },
    "alt+drag over the preview tile did not pan the camera",
  ).toEqual({ dx: DRAG.x, dy: DRAG.y });
});

test("at max zoom, a plain drag on a preview tile that fills the canvas moves the node (T1246)", async ({
  page,
}) => {
  await openApp(page);
  const { nodeId, at } = await zoomIntoTile(page, "generator", "Noise");

  const before = await graphPosition(page, nodeId);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  /*
   * React Flow's drag STARTS on the first move that travels more than `nodeDragThreshold`
   * (1 screen px) and snapshots the pointer-to-node offset THERE, so the move that opens
   * the drag is not part of the distance the node travels (`XYDrag`, `startDrag`). One
   * opening move, then the gesture proper — which the node then follows exactly.
   */
  await page.mouse.move(at.x + OPENING_MOVE_PX, at.y);
  await page.mouse.move(at.x + OPENING_MOVE_PX + DRAG.x, at.y + DRAG.y, { steps: 8 });
  await page.mouse.up();
  // Polled: the position is what the document holds once the drag COMMITS through the
  // bus, and the wrapper re-renders from the store — a rejected commit snaps back to
  // `before`, which this would then report.
  await expect
    .poll(
      async () => {
        const after = await graphPosition(page, nodeId);
        return { dx: after.x - before.x, dy: after.y - before.y };
      },
      { message: "a plain drag on the preview tile did not move the node" },
    )
    .toEqual({ dx: DRAG.x / MAX_ZOOM, dy: DRAG.y / MAX_ZOOM });
});
