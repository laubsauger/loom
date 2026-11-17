import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { addNode, fitAll, openApp, viewportSettled } from "./app.ts";

/**
 * §I.ui, T1724b — the graph navigates as TouchDesigner's network editor does, in a real
 * browser: what a person's hand does, through Chromium's own event order.
 *
 * `navigation.test.tsx` holds the same gestures in jsdom; this spec exists for the one thing
 * jsdom cannot say, WHEN Chromium sends `contextmenu` for the right button (on press on
 * macOS, on release elsewhere). A right drag must select and open no menu, a right click
 * must still open the canvas menu, and a left drag on the empty canvas must pan.
 */

const transformOf = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "");

const openMenu = (page: Page) => page.locator('[role="menu"][data-state="open"]');

/** Both nodes' screen box, and a corner of the canvas the pane is under, to start a drag from. */
async function layout(page: Page) {
  const canvas = await page.getByTestId("graph-canvas").boundingBox();
  if (canvas === null) throw new Error("the canvas has no box");
  const boxes = await page.locator(".react-flow__node").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }),
  );
  const around = {
    left: Math.min(...boxes.map((box) => box.left)) - 40,
    top: Math.min(...boxes.map((box) => box.top)) - 40,
    right: Math.max(...boxes.map((box) => box.right)) + 40,
    bottom: Math.max(...boxes.map((box) => box.bottom)) + 40,
  };
  const onPane = (x: number, y: number): Promise<boolean> =>
    page.evaluate(([px, py]) => document.elementFromPoint(px as number, py as number)?.closest(".react-flow__pane") != null && document.elementFromPoint(px as number, py as number)?.closest(".react-flow__node") == null, [x, y]);
  expect(await onPane(around.left, around.top), "the drag would not start on empty canvas").toBe(true);
  return { canvas, around, onPane };
}

async function setUp(page: Page) {
  await openApp(page);
  await addNode(page, "generator", "Noise");
  await addNode(page, "output", "Output");
  await fitAll(page);
  // Room around the pair: zoomed out, so the box around them is empty canvas.
  await page.getByTestId("graph-canvas").hover();
  await page.mouse.wheel(0, 400);
  await viewportSettled(page);
}

test("a LEFT drag on the empty canvas pans and selects nothing", async ({ page }) => {
  await setUp(page);
  const { around } = await layout(page);
  const before = await transformOf(page);
  await page.mouse.move(around.left, around.top);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(around.left + 120, around.top + 80, { steps: 12 });
  await page.mouse.up({ button: "left" });
  await viewportSettled(page);
  expect(await transformOf(page)).not.toBe(before);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
});

test("a RIGHT drag around both nodes selects them and opens no menu", async ({ page }) => {
  await setUp(page);
  const { around } = await layout(page);
  const before = await transformOf(page);
  await page.mouse.move(around.left, around.top);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(around.right, around.bottom, { steps: 16 });
  await page.mouse.up({ button: "right" });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expect(openMenu(page)).toHaveCount(0);
  expect(await transformOf(page)).toBe(before);
});

test("a RIGHT click on the empty canvas still opens the canvas menu", async ({ page }) => {
  await setUp(page);
  const { around } = await layout(page);
  await page.mouse.click(around.left, around.top, { button: "right" });
  await expect(openMenu(page)).toHaveCount(1);
  await expect(openMenu(page).getByRole("menuitem", { name: "Add annotation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(openMenu(page)).toHaveCount(0);
});
