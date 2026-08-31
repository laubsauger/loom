import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { APP_VIEWPORT, addNode, fitAll, moveNode, openApp, selectNode } from "./app.ts";

/**
 * T720 / T145 — the node info popup, and the "Info" row that has never opened it.
 *
 * ## What was wrong, measured before it was fixed
 *
 * `ui.showNodeInfo` had no entry in the context menu's input builder table, so the row
 * dispatched its STATIC input — empty — and the command fell back to what a bare keypress
 * means: describe the SELECTED node. A right-click does not select (measured: selected
 * node count 0 before and after), so the ordinary gesture — right-click a node, choose
 * Info — resolved to no target at all and the command refused. The row was enabled
 * throughout (`aria-disabled` null), which is what made it a dead affordance rather than
 * an honestly unavailable one.
 *
 * §B87 had already written this failure down in `input.ts`: "a command whose input must
 * carry a TARGET but has no builder dispatches its static input — empty — and rejects
 * with 'no target' while every unit suite stays green." The seam gate that came out of it
 * only covered the toggles the menus guard, and `ui.showNodeInfo` is not a toggle, so it
 * walked straight through the hole.
 *
 * ## Why a "the popup opened" assertion is not enough (§V656)
 *
 * The same missing builder has a second, quieter symptom: with a DIFFERENT node selected,
 * the row opens the popup for the SELECTED node rather than the clicked one. A count-only
 * gate is green for that — a popup did open — while the user is reading the wrong node's
 * resolution and GPU time and has no way to tell. So every assertion here is about WHICH
 * NODE the popup describes, which is the only reading that separates the two.
 *
 * Real pointer events for this file's usual reason (§V472): the menu row's other cause
 * was Radix restoring focus to the trigger after the popup mounted, and no synthetic
 * event reproduces that ordering.
 */

test.use({ viewport: APP_VIEWPORT });

/** The popup's own label carries the node it is describing — that is the assertion. */
function infoPopup(page: Page) {
  return page.locator('[aria-label^="Node info for"]');
}

/** Right-clicks a node's header and chooses a row from the menu that opens. */
async function chooseOnNode(page: Page, nodeId: string, row: RegExp): Promise<void> {
  await page
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .click({ button: "right", position: { x: 60, y: 10 } });
  await page.locator('[role="menuitem"]', { hasText: row }).first().click();
}

test("the Info row opens the popup for the node it was opened on", async ({ page }) => {
  await openApp(page);
  const noise = await addNode(page, "generator", "Noise");
  await fitAll(page);

  /*
   * NOTHING SELECTED — the ordinary gesture, and the one that was dead. A right-click
   * does not select, so this is what a user gets the first time they try the row: before
   * the fix, no popup at all.
   */
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

  await chooseOnNode(page, noise, /^Info/);

  await expect(infoPopup(page)).toBeVisible();
  await expect(infoPopup(page)).toHaveAttribute("aria-label", new RegExp(`Node info for .*`));
  // And it is describing THE NODE THAT WAS CLICKED. The popup names the node's label, so
  // the assertion is that the label belongs to the node we right-clicked.
  await expect(infoPopup(page)).toContainText("noise");
});

test("the Info row describes the CLICKED node, not the selected one", async ({ page }) => {
  /*
   * The quiet half of the same bug, and the reason the test above is not sufficient.
   *
   * With the builder missing, the row dispatched empty input and the command described
   * whatever was SELECTED. Select A, right-click B, and the popup opened — for A. A gate
   * asserting only that a popup appeared passes while the user reads the wrong node's
   * numbers (§V656: the reading is true and the wiring is wrong).
   */
  await openApp(page);
  const noise = await addNode(page, "generator", "Noise");
  const checker = await addNode(page, "generator", "Checker");
  // The library drops every node at the same default position, so without this the two
  // nodes sit exactly on top of each other and a right-click aimed at B lands on A.
  await moveNode(page, checker, 700, 380);
  await fitAll(page);

  /*
   * A is selected — and it must STILL be selected when B is right-clicked, or this test
   * silently degenerates into the one above. `selectNode` fits first, so both nodes are
   * on screen; a second `fitAll` here would call `focusGraph`, whose pane click clears the
   * selection, and the assertion would then pass for the wrong reason (measured: it did).
   */
  await selectNode(page, noise);
  await expect(page.locator(`.react-flow__node[data-id="${noise}"].selected`)).toHaveCount(1);

  // ...and B is right-clicked, with A still selected.
  await chooseOnNode(page, checker, /^Info/);
  await expect(page.locator(`.react-flow__node[data-id="${noise}"].selected`)).toHaveCount(1);

  await expect(infoPopup(page)).toBeVisible();
  await expect(infoPopup(page)).toContainText("checker");
  await expect(infoPopup(page)).not.toContainText("noise");
});

test("the keyboard route still describes the SELECTED node", async ({ page }) => {
  /*
   * The fix must not be a swap. `ui.showNodeInfo` with no `nodeId` means "the node the
   * surface considers current", which is what the `?` binding and a bare palette run
   * both send — the selection fallback is the whole reason that route works at all, and
   * a builder that made the command demand a target would kill it (§V516: the guard must
   * be scoped to the trigger, and this one is scoped to the MENU).
   */
  await openApp(page);
  const noise = await addNode(page, "generator", "Noise");
  await selectNode(page, noise);

  await page.keyboard.press("Shift+/");

  await expect(infoPopup(page)).toBeVisible();
  await expect(infoPopup(page)).toContainText("noise");
});

test("the middle-click route still describes the node under the pointer", async ({ page }) => {
  // TouchDesigner's gesture, and the one route that always worked — it resolves the node
  // from the click rather than from the command input, so it never depended on the
  // builder. Here so the fix cannot regress it silently.
  await openApp(page);
  const checker = await addNode(page, "generator", "Checker");
  await fitAll(page);

  const box = await page.locator(`.react-flow__node[data-id="${checker}"]`).boundingBox();
  if (box === null) throw new Error("the node has no box on screen");
  await page.mouse.move(box.x + 60, box.y + 10);
  await page.mouse.down({ button: "middle" });
  await page.mouse.up({ button: "middle" });

  await expect(infoPopup(page)).toBeVisible();
  await expect(infoPopup(page)).toContainText("checker");
});
