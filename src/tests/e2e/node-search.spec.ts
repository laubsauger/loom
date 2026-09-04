import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { APP_VIEWPORT, addNode, focusGraph, modKey, openApp } from "./app.ts";

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

/**
 * T732 — the category tabs, and the one property the row is actually about: THE TWO
 * FILTERS COMPOSE.
 *
 * The owner asked for tabs "in addition to the typing search". A tab strip that WORKS but
 * clears the query when you pick a category satisfies "there are tabs" and fails the row,
 * so none of these tests assert that a strip exists — they assert that a category and a
 * query applied in either order produce the same list, that neither clears the other, and
 * that the whole thing is reachable from the keyboard that opened the surface.
 *
 * Real pointer events for the reason every other test in this file uses them (§V472):
 * every bug this surface has had was focus ordering — a result that created nothing on
 * click while Enter worked, and a menu row dead because focus returned to its trigger
 * after the popover mounted. jsdom sees none of it.
 */

/** The node types the browser is currently offering, in the order it offers them. */
function resultTypes(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="node-search"] [data-node-type]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-node-type") ?? ""),
    );
}

function searchBox(page: Page): Locator {
  return page.locator('[data-testid="node-search"] input[aria-label="Search nodes"]');
}

/** Opens the browser by the double-click door, at CURSOR unless told otherwise. */
async function openBrowser(page: Page, at: { x: number; y: number } = CURSOR): Promise<void> {
  await page.getByTestId("graph-canvas").dblclick({ position: await offsetWithin(page, at) });
  await expect(page.getByTestId("node-search")).toBeVisible();
}

test("a category and a query compose, in either order, to the same list", async ({ page }) => {
  await openApp(page);

  /*
   * "re" is chosen because it spans categories — `rectangle` is a generator and
   * `renderPoints` is a render node, and both match. A query confined to one category
   * could not tell a composing filter from one that ignores the category entirely.
   */
  await openBrowser(page);
  await searchBox(page).fill("re");
  const acrossEverything = await resultTypes(page);
  expect(acrossEverything).toContain("rectangle");
  expect(acrossEverything).toContain("renderPoints");

  // DIRECTION ONE: type across everything, then narrow by category.
  await page.getByTestId("node-search-tab-generator").click();
  const queryThenCategory = await resultTypes(page);

  // The category bit, and it bit on top of the query rather than instead of it.
  expect(queryThenCategory).toContain("rectangle");
  expect(queryThenCategory).not.toContain("renderPoints");
  expect(queryThenCategory.length).toBeLessThan(acrossEverything.length);
  expect(queryThenCategory.length).toBeGreaterThan(0);

  // NEITHER FILTER CLEARED THE OTHER. This is the whole of "in addition to".
  await expect(searchBox(page)).toHaveValue("re");
  await expect(page.getByTestId("node-search-tab-generator")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // DIRECTION TWO: pick the category first, then type into it.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("node-search")).toHaveCount(0);
  await openBrowser(page);
  await page.getByTestId("node-search-tab-generator").click();
  await searchBox(page).fill("re");
  const categoryThenQuery = await resultTypes(page);

  /*
   * The row's actual requirement. Two orders, one list — and asserted as the WHOLE list
   * in order, not as "both contain rectangle", because a containment check passes just as
   * happily when one order silently drops half the results (§V656's shape: the reading is
   * true and the wiring is wrong).
   */
  expect(categoryThenQuery).toEqual(queryThenCategory);
});

test("a category filter still places its node at the cursor", async ({ page }) => {
  // T709's positional claim must survive the new filter — a browser that opens at the
  // cursor and then drops a category-picked node at a default spot is the same
  // worse-than-nothing outcome the original row named.
  await openApp(page);
  const before = await page.locator(".react-flow__node").count();
  const expected = await graphPointUnder(page, CURSOR);

  await openBrowser(page);
  await page.getByTestId("node-search-tab-generator").click();
  await searchBox(page).fill("rect");
  const hit = page.locator('[data-testid="node-search"] [data-node-type="rectangle"]');
  await expect(hit).toBeVisible();
  await hit.click();

  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  const placed = await graphPositionOf(page.locator(".react-flow__node").nth(before));
  expect(Math.abs(placed.x - expected.x)).toBeLessThan(2);
  expect(Math.abs(placed.y - expected.y)).toBeLessThan(2);
});

test("categories the query cannot reach are dimmed, so composition is visible", async ({
  page,
}) => {
  /*
   * The legibility half. Two filters that silently intersect produce the surface's worst
   * moment — an empty list with no visible reason — and the row asks for the composition
   * to be obvious rather than clever. Dimming answers "which constraint is biting" before
   * it is asked.
   */
  await openApp(page);
  await openBrowser(page);
  await searchBox(page).fill("blur");

  await expect(page.getByTestId("node-search-tab-filter")).toHaveAttribute(
    "data-empty",
    "false",
  );
  await expect(page.getByTestId("node-search-tab-generator")).toHaveAttribute(
    "data-empty",
    "true",
  );
  // And with nothing typed, nothing is dimmed — every category is reachable.
  await searchBox(page).fill("");
  await expect(page.getByTestId("node-search-tab-generator")).toHaveAttribute(
    "data-empty",
    "false",
  );
});

test("the strip is reachable and usable from the keyboard that opened the browser", async ({
  page,
}) => {
  /*
   * The browser opens on a KEY. A category filter that needs the mouse therefore breaks
   * the gesture that summons it — you reach for the keyboard to open it and the mouse to
   * use it — so this walks the whole thing without a pointer, starting from the `tab`
   * binding itself.
   */
  await openApp(page);

  // First: the `tab` binding really is the door, and it leaves the caret in the search
  // box — which is what makes "one more Tab reaches the categories" the natural gesture
  // rather than a chord someone has to be told about.
  await focusGraph(page);
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("node-search")).toBeVisible();
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("node-search")).toHaveCount(0);

  /*
   * ⚠ AND NOW AT THE CURSOR, WHICH IS THE ONLY PLACE THE NEXT ASSERTION CAN SEE ANYTHING.
   *
   * This test first opened the browser with `tab`, and a bare `tab` has no cursor, so it
   * opens at the VIEWPORT CENTRE by design. The failure guarded against below is a
   * re-anchor to the viewport centre — which, measured from a browser already sitting at
   * the viewport centre, moves it by zero. The gate would have shared the bug's own
   * blindness exactly the way §V634's `elementFromPoint` did, and passed identically
   * before and after the fix. Caught by this spec's own red-verify, not by reading it.
   *
   * So the geometry is done on a browser opened AT THE CURSOR, and everything from here
   * is keyboard-only — which is the claim: the filter is reachable without the mouse, not
   * that the mouse never opened anything.
   */
  await openBrowser(page);
  await expect(searchBox(page)).toBeFocused();
  const anchored = await page.getByTestId("node-search").boundingBox();
  expect(anchored).not.toBeNull();
  expect(Math.abs(anchored!.y - CURSOR.y)).toBeLessThan(60);

  // Into the strip. The roving tabindex means ONE Tab reaches it, landing on "all".
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("node-search-tab-all")).toBeFocused();

  // Travel: all → color → component → composite → filter. Selection follows focus, so
  // the list narrows as we go rather than after a separate commit key.
  for (let step = 0; step < 4; step += 1) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("node-search-tab-filter")).toBeFocused();
  await expect(page.getByTestId("node-search-tab-filter")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const narrowed = await resultTypes(page);
  expect(narrowed).toContain("blur");
  expect(narrowed).not.toContain("rectangle");

  /*
   * Tab OUT of the strip leaves it for the results, and the browser stays where it was.
   *
   * The tolerance is 8px against a MEASURED population, not a guess. Focus landing in the
   * scrollable result list makes Radix recompute its position, and the recompute lands on
   * a different subpixel: 1.22, 1.25 and 1.54px over three runs.
   */
  await page.keyboard.press("Tab");
  const afterTab = await page.getByTestId("node-search").boundingBox();
  expect(afterTab).not.toBeNull();
  expect(Math.abs(afterTab!.x - anchored!.x)).toBeLessThan(8);
  expect(Math.abs(afterTab!.y - anchored!.y)).toBeLessThan(8);

  // Enter hands focus back to the search box — "narrowed it, now let me type" — and the
  // category survives the trip, which is composition reached entirely by keyboard.
  await page.getByTestId("node-search-tab-filter").focus();
  await page.keyboard.press("Enter");
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.type("bl");
  await expect(searchBox(page)).toHaveValue("bl");
  const composed = await resultTypes(page);
  expect(composed).toContain("blur");
  expect(composed).not.toContain("rectangle");
});

test("the tabs and the library pane's dropdown offer the SAME categories", async ({ page }) => {
  /*
   * §V487, asserted across the two surfaces rather than trusted.
   *
   * We now have two affordances for one filter. They share `categoriesOf` in the source,
   * but "they share a function" is a claim about today's code; what protects the user is
   * that the two RENDERED lists agree. This compares them, in order, so a future surface
   * that quietly hand-lists its categories — or sorts them differently — fails here
   * rather than in a bug report about a node nobody can find.
   */
  await openApp(page);

  /*
   * T1124 — the NODE library's dropdown, named by what the pane searches rather than by
   * where the pane sits.
   *
   * `button[aria-label="Filter by category"]` is no longer unique: the EXAMPLE library
   * ships the same control, and since T1123/T1125 the default arrangement has a node
   * library in the left dock and an examples pane open in the bottom one, so the bare
   * locator resolves to two elements and the click refuses in strict mode. Scoping to
   * `data-pane-leaf="leaf-left"` would only re-break the day the docks move again
   * (§V906); scoping to the tab panel that holds the node SEARCH BOX names the pane by
   * what it is, and it is the same pane `openBrowser` compares against below.
   */
  const libraryPane = page
    .getByRole("tabpanel")
    .filter({ has: page.locator('input[aria-label="Search nodes"]') });
  await expect(libraryPane).toHaveCount(1);
  await libraryPane.getByLabel("Filter by category").click();
  const fromPane = await page
    .locator('[data-radix-popper-content-wrapper] button')
    .allTextContents();
  await page.keyboard.press("Escape");

  await openBrowser(page);
  const fromTabs = await page.locator('[data-testid="node-search"] [role="tab"]').allTextContents();

  /*
   * The catch-all row is an AFFORDANCE, not a category, and the two surfaces spell it
   * differently: the strip renders a lowercase `all` tab, the pane's chip an "All". That
   * is a copy difference and it is deliberately not what this gate is about — the claim
   * is that the CATEGORIES agree — so the catch-all comes off both lists case-blind.
   * (T1124: matching it exactly meant "All" survived the filter on one side only, and the
   * comparison failed on a word neither list is really offering.)
   */
  const strip = (names: string[]): string[] =>
    names.map((name) => name.trim()).filter((name) => name.toLowerCase() !== "all");
  expect(strip(fromTabs)).toEqual(strip(fromPane));
  // A guard on the guard: if either list ever came back empty this would pass vacuously.
  expect(strip(fromTabs).length).toBeGreaterThan(5);
});

test("the category strip does not leak keystrokes to the global keymap", async ({ page }) => {
  /*
   * §V53's classic bug, arriving through the one target shape the context rule cannot see.
   *
   * The keymap derives its `text` context FROM THE EVENT TARGET, which is what stops ⌘Z in
   * the search box undoing a graph edit. A category tab is a <button>, so that rule does
   * not cover it. And the popover is portaled to document.body, so there is no
   * `data-keymap-context` ancestor either and the keymap falls back to `environment.context`
   * — measured as `"global"`, not `"graph"`.
   *
   * That measurement is the whole point of this test, and it corrected the fix's own
   * comment: GRAPH-context bindings genuinely cannot fire from in here, so `tab` re-opening
   * the browser on itself is NOT the hazard and the mutation written to prove it declined
   * to fail (§V666 doing its job). GLOBAL bindings are live, though, and `mod+z` is
   * `graph.undo`. Without the strip stopping propagation, browsing categories with the
   * keyboard silently undoes the user's last edit.
   *
   * The node count is the assertion because the damage is to the DOCUMENT, not to the
   * popover — a test that only checked the browser stayed open would pass while the graph
   * quietly lost a node.
   */
  await openApp(page);
  await addNode(page, "generator", "Noise");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  await focusGraph(page);
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("node-search")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("node-search-tab-all")).toBeFocused();

  await page.keyboard.press(`${await modKey(page)}+z`);

  // The edit survives, and the surface is still there to keep browsing.
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByTestId("node-search")).toBeVisible();
});
