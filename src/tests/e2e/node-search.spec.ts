import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { APP_VIEWPORT, openApp } from "./app.ts";

/**
 * T709 — the background double-click opens the node browser, and B107/B120 — the
 * right-click add-node path it competes with. Driven through a real browser (§V15, §V472).
 *
 * ## Why these three claims live in ONE spec, and why they must be here
 *
 * T709 asked for a new ENTRY POINT into node creation. The other two rows are the two ways
 * the existing entry point is broken, and a new door into a broken room is worth nothing —
 * so the same spec walks both doors.
 *
 * §V472 is the reason none of this can be a jsdom test. B107 was a REAL-POINTER death:
 * Radix's `SubContent` closes on focus-outside, React 19.2's pointerdown-driven focus
 * landed before the flag, and the parent sub read its own child's item as outside and
 * closed mid-press. The keyboard path worked throughout, so every jsdom test stayed green
 * while no node was reachable from the menu at all. `context-menu-host.test.tsx` already
 * walks the menu with the keyboard and passes; it passed while the bug was live. Only real
 * pointerdown/pointerup can distinguish the two.
 *
 * ## The trap avoided (§V655)
 *
 * "The browser opened" proves nothing about T709. The row's actual requirement is
 * POSITIONAL — open at the cursor, place the node THERE — and a browser that opens at the
 * viewport centre and drops its node at a default spot satisfies "a browser opened"
 * perfectly while being the worse-than-nothing outcome the row calls out. So every
 * assertion below is about WHERE: the popover's box against the click point, and the
 * created node's box against the same point. A default-spot regression fails on geometry,
 * which is the only thing that can catch it.
 */

test.use({ viewport: APP_VIEWPORT });

/** Where on the canvas to act — deliberately off-centre, so "centred" cannot pass. */
const CURSOR = { x: 900, y: 640 } as const;

/** Open menus, by Radix's own state attribute. Stacking (B120) shows up as a count. */
function openMenus(page: Page) {
  return page.locator('[role="menu"][data-state="open"]');
}

test("double-clicking the graph background opens the node browser at the cursor", async ({
  page,
}) => {
  await openApp(page);
  const canvas = page.getByTestId("graph-canvas");

  const before = await page.locator(".react-flow__node").count();

  // The graph point under the cursor, computed from the LIVE viewport before the gesture.
  // This is what the app should project the click to, worked out independently of it.
  const expected = await graphPointUnder(page, CURSOR);

  await canvas.dblclick({ position: await offsetWithin(page, CURSOR) });

  const search = page.getByTestId("node-search");
  await expect(search).toBeVisible();

  /*
   * AT THE CURSOR, measured. The popover is anchored to a zero-size fixed point at the
   * click, and Radix places the content beside that point — so the content's own box is
   * what proves the anchor was the cursor rather than the pane. The tolerance is for
   * Radix's collision padding and the side offset, not for slop: a browser opening at the
   * viewport centre (800, 500) or at the pane origin is hundreds of px away and fails.
   */
  const box = await search.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x - CURSOR.x)).toBeLessThan(60);
  expect(Math.abs(box!.y - CURSOR.y)).toBeLessThan(60);

  // The browser is SEARCHABLE — the row's word. Typing narrows to a ranked hit.
  await page.locator('[data-testid="node-search"] input[aria-label="Search nodes"]').fill("blur");
  const hit = page.locator('[data-testid="node-search"] [data-node-type]').first();
  await expect(hit).toBeVisible();
  await hit.click();

  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);

  /*
   * AND THE NODE LANDS THERE. This is the half the row says is worse than no gesture when
   * it is wrong, and the half a "the node was created" assertion cannot see.
   *
   * Asserted in GRAPH coordinates against a projection this spec computed itself, rather
   * than in screen pixels: the claim is that the node is placed where the cursor was, and
   * that stays true — and stays checkable — however the viewport is framed afterwards. A
   * screen-space assertion would silently be testing the framing instead, and this graph
   * is empty until the add, so React Flow's `fitView` fires the moment there is something
   * to fit and moves the node on screen after it is correctly placed (measured: zoom 5.0,
   * a 2761px pan). The tolerance is a pixel of rounding, not slop: the default drop spot
   * this row exists to prevent is the viewport centre, hundreds of graph units away.
   */
  const added = page.locator(".react-flow__node").nth(before);
  const placed = await graphPositionOf(added);
  expect(Math.abs(placed.x - expected.x)).toBeLessThan(2);
  expect(Math.abs(placed.y - expected.y)).toBeLessThan(2);
});

test("double-clicking a node does not open the browser over it", async ({ page }) => {
  await openApp(page);
  // Guards the target resolution rather than the gesture: a double-click that opened a
  // node browser on top of every node would pass the positional test above and still be
  // wrong, because node double-click already means dive-in and rename.
  await page
    .locator('section[aria-label="generator"] button', { hasText: /^Noise/ })
    .first()
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  await page.locator(".react-flow__node").first().dblclick({ position: { x: 40, y: 8 } });
  await expect(page.getByTestId("node-search")).toHaveCount(0);
});

test("the canvas menu's Search nodes row opens the same browser, at the same point", async ({
  page,
}) => {
  /*
   * The third door (§V78/§V307), and the one that was silently dead. The row ran the
   * command and the handler was reached with the right position, but Radix restores focus
   * to the menu's trigger as it closes, that restoration landed on the graph pane after
   * the popover had mounted, and the popover read it as focus leaving itself and closed
   * within a frame. Nothing threw; the row simply did nothing.
   *
   * Asserted positionally like the double-click, because the menu carries a cursor
   * position too — the same command with the same input has to put the browser in the
   * same place however it was reached, or "one command, three doors" is a fiction.
   */
  await openApp(page);
  const canvas = page.getByTestId("graph-canvas");

  await canvas.click({ button: "right", position: await offsetWithin(page, CURSOR) });
  await page.locator('[role="menuitem"]', { hasText: "Search nodes" }).first().click();

  const search = page.getByTestId("node-search");
  await expect(search).toBeVisible();
  const box = await search.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x - CURSOR.x)).toBeLessThan(60);
  expect(Math.abs(box!.y - CURSOR.y)).toBeLessThan(60);

  // And it still closes on demand — the focus fix must not have wedged it open.
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});

test("B107 — a depth-2 category in the add-node menu expands and its node is reachable", async ({
  page,
}) => {
  await openApp(page);
  const canvas = page.getByTestId("graph-canvas");
  const before = await page.locator(".react-flow__node").count();

  await canvas.click({ button: "right", position: await offsetWithin(page, CURSOR) });
  await expect(openMenus(page)).toHaveCount(1);

  // Depth 1: the "Add node" submenu.
  await page.locator("[data-menu-submenu]", { hasText: "Add node" }).first().click();
  await expect(openMenus(page)).toHaveCount(2);

  /*
   * Depth 2: a CATEGORY. This is the click B107 reported as collapsing the whole branch —
   * with a real pointer, the press landed on the item and the release landed on <html>,
   * so Radix's pointerup-driven select never fired and no node was reachable. Asserting
   * the submenu is open after the click is the direct inverse of the reported symptom.
   */
  await page.locator('[data-menu-submenu="filter"]').click();
  await expect(openMenus(page)).toHaveCount(3);

  // And the leaf actually selects — the end of the chain the bug severed.
  await page.locator('[role="menuitem"]', { hasText: /^Blur/ }).first().click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
});

test("B120 — browsing sibling categories does not stack their submenus", async ({ page }) => {
  await openApp(page);
  const canvas = page.getByTestId("graph-canvas");

  await canvas.click({ button: "right", position: await offsetWithin(page, CURSOR) });
  await page.locator("[data-menu-submenu]", { hasText: "Add node" }).first().click();
  await page.locator('[data-menu-submenu="filter"]').click();
  await expect(openMenus(page)).toHaveCount(3);

  /*
   * The other half of the veto, and the reason it must not be unconditional. Moving to a
   * SIBLING category is the legitimate close: T524's blanket `onFocusOutside`
   * preventDefault fixed "closes too eagerly" by producing "never closes", and every
   * browsed category stayed standing over the next. The count is the assertion — three
   * open menus means root + "Add node" + exactly one category, whichever one it is.
   */
  await page.locator('[data-menu-submenu="generator"]').click();
  await expect(openMenus(page)).toHaveCount(3);
  await expect(page.locator('[data-menu-submenu="filter"]')).toHaveAttribute(
    "data-state",
    "closed",
  );

  await page.locator('[data-menu-submenu="color"]').click();
  await expect(openMenus(page)).toHaveCount(3);
});

/**
 * Playwright's `position` is relative to the element, and every assertion here compares
 * against VIEWPORT coordinates — so the two must be reconciled once, explicitly, rather
 * than by assuming the canvas starts at the origin. It does not: the topbar and the
 * library pane are in front of it.
 */
/**
 * The graph coordinate under a viewport point, derived from the canvas rect and React
 * Flow's own viewport matrix — the same arithmetic `screenToFlowPosition` does, worked
 * out here from the DOM rather than asked of the app. Asking the app would make the
 * assertion agree with the implementation by construction, which is §V650's two-zeros
 * failure: it would pass just as happily if both were wrong.
 */
async function graphPointUnder(page: Page, viewportPoint: { x: number; y: number }) {
  const box = await page.getByTestId("graph-canvas").boundingBox();
  if (box === null) throw new Error("the graph canvas has no box");
  const matrix = await page.evaluate(() => {
    const el = document.querySelector(".react-flow__viewport");
    if (el === null) throw new Error("no react-flow viewport");
    const { a, e, f } = new DOMMatrix(getComputedStyle(el).transform);
    return { zoom: a, tx: e, ty: f };
  });
  return {
    x: (viewportPoint.x - box.x - matrix.tx) / matrix.zoom,
    y: (viewportPoint.y - box.y - matrix.ty) / matrix.zoom,
  };
}

/** A rendered node's own graph position, read off the transform React Flow gives it. */
async function graphPositionOf(node: Locator) {
  return node.evaluate((element) => {
    const { e, f } = new DOMMatrix((element as HTMLElement).style.transform);
    return { x: e, y: f };
  });
}

async function offsetWithin(page: Page, viewportPoint: { x: number; y: number }) {
  const box = await page.getByTestId("graph-canvas").boundingBox();
  if (box === null) throw new Error("the graph canvas has no box");
  const position = { x: viewportPoint.x - box.x, y: viewportPoint.y - box.y };
  if (position.x < 0 || position.y < 0 || position.x > box.width || position.y > box.height) {
    throw new Error(
      `(${viewportPoint.x}, ${viewportPoint.y}) is outside the canvas — the test would click another pane`,
    );
  }
  return position;
}
