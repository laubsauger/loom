import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { APP_VIEWPORT } from "./app.ts";

/**
 * T426 — the right sidebar runs the FULL height of the window (§V339).
 *
 * This spec exists because the claim is GEOMETRIC and jsdom paints nothing. §B54 is the
 * precedent: a layer that was in the DOM, had a real client rect and rendered zero pixels
 * for months, with a green presence test the whole time. "The sidebar is taller than the
 * bottom dock" cannot be asserted anywhere but a real browser, so it is asserted here, by
 * measuring boxes.
 *
 * The unit suites (`app-shell.test.tsx`, `layout-storage.test.ts`) carry the STRUCTURE
 * and the record; this carries the pixels.
 */

/**
 * Opens the app and waits for the SHELL.
 *
 * Deliberately not `openApp` from `./app.ts`: that helper waits on a node-library
 * section that is not rendering on this working tree (every spec in this directory fails
 * on it, before and without any change here), and this spec is about the shell's
 * geometry, which does not need the library's contents to exist.
 */
async function openShell(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.locator('[data-panel-id="panel-split-columns-b"]')).toBeVisible();
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible();
  const rect = await locator.boundingBox();
  expect(rect, "the element has no box at all").not.toBeNull();
  return rect as { x: number; y: number; width: number; height: number };
}

test.use({ viewport: { width: APP_VIEWPORT.width, height: APP_VIEWPORT.height } });

test.describe("T426 — the default layout", () => {
  test("the right sidebar spans the body, and the bottom dock stops short of it", async ({ page }) => {
    await openShell(page);

    const body = await box(page.locator('[data-panel-group][data-panel-group-id="group-split-columns"]'));
    const sidebar = await box(page.locator('[data-panel-id="panel-split-columns-b"]'));
    const bottom = await box(page.locator('section[data-pane-leaf="leaf-bottom"]'));

    // Full height: the sidebar is as tall as the whole body, to within a divider.
    expect(sidebar.height).toBeGreaterThan(body.height - 4);
    expect(sidebar.y).toBeLessThanOrEqual(body.y + 2);

    // …and it really is taller than the region the bottom dock used to cut it down to.
    expect(sidebar.height).toBeGreaterThan(bottom.y - body.y);

    // The bottom dock ends where the sidebar begins: no overlap, nothing underneath it.
    expect(bottom.x + bottom.width).toBeLessThanOrEqual(sidebar.x + 2);
  });

  test("the sidebar is split horizontally: viewer on top, inspector beneath", async ({ page }) => {
    await openShell(page);

    const top = await box(page.locator('section[data-pane-leaf="leaf-right"]'));
    const lower = await box(page.locator('section[data-pane-leaf="leaf-rightBottom"]'));

    // Both are PAINTED — a zero-height section is the §B54 failure, not a layout.
    expect(top.height).toBeGreaterThan(50);
    expect(lower.height).toBeGreaterThan(50);
    expect(top.width).toBeGreaterThan(100);

    // Stacked, not side by side, and in that order.
    expect(lower.y).toBeGreaterThan(top.y + top.height - 4);
    expect(Math.abs(lower.x - top.x)).toBeLessThan(2);

    // The pane each section holds is the one T426 named.
    await expect(page.locator('section[data-pane-leaf="leaf-right"] [role="tab"]')).toHaveText(["viewer"]);
    await expect(page.locator('section[data-pane-leaf="leaf-rightBottom"] [role="tab"]')).toHaveText([
      "inspector",
    ]);
  });

  test("the inspector gets real height, not a third of a column", async ({ page }) => {
    await openShell(page);

    const lower = await box(page.locator('section[data-pane-leaf="leaf-rightBottom"]'));
    const body = await box(page.locator('[data-panel-group][data-panel-group-id="group-split-columns"]'));

    // The complaint was that the parameters were squeezed. A third of the body's height
    // is the floor this layout has to clear.
    expect(lower.height).toBeGreaterThan(body.height / 3);
  });
});

/**
 * T436 — the layout menu saves, names and restores. Driven here because the round trip
 * crosses `localStorage` and a reload, which is the part a component test fakes.
 */
test.describe("T436 — named layouts", () => {
  test("saves the arrangement under a name and restores it after a reload", async ({ page }) => {
    await openShell(page);

    // Rearrange: put the inspector in the bottom dock.
    await page.getByRole("button", { name: "Move inspector" }).click();
    await page.getByRole("button", { name: "Bottom dock", exact: true }).click();
    await expect(page.locator('section[data-pane-leaf="leaf-bottom"] [role="tab"]')).toContainText([
      "inspector",
    ]);

    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("button", { name: "Save as…" }).click();
    await page.getByRole("textbox", { name: "New layout name" }).fill("Inspector below");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // Go back to the stock arrangement, then reload and restore the saved one.
    await page.getByRole("button", { name: /^Default/ }).click();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator('section[data-pane-leaf="leaf-rightBottom"] [role="tab"]')).toHaveText([
      "inspector",
    ]);

    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("button", { name: /^Inspector below/ }).click();

    await expect(page.locator('section[data-pane-leaf="leaf-bottom"] [role="tab"]')).toContainText([
      "inspector",
    ]);
  });
});

/**
 * §V307 — the layout menu has three doors, and this is the one that proves the other two
 * are real: the command palette, in the COMPOSED app, in a real browser.
 *
 * Registration is not invocability (§V342) and a registered command can still be
 * unreachable (§V351). The unit test mounts the shell inside the runtime provider; only
 * this can show that the shipped app actually put it there.
 */
test.describe("V307 — the layout menu opens from the command palette", () => {
  test("lists the command and opens the menu when it is run", async ({ page }) => {
    await openShell(page);

    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("open layouts");
    await page.keyboard.press("Enter");

    // The verbs the menu exists for, on screen — not merely a command that dispatched.
    await expect(page.getByRole("button", { name: "Save as…" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Default/ })).toBeVisible();
  });
});

/**
 * T404 — the pane TREE'S geometry, which only a browser can certify (V383): jsdom
 * computes no layout, so a split that renders at ZERO HEIGHT — invisible, useless —
 * passes every structural test. Split an area, assign the new leaf a role, and both
 * halves must hold real painted area; close it and the space must come back.
 */
test.describe("T404 — splitting an area yields two REAL areas", () => {
  test("split down, pick a role, both halves have height; close returns the space", async ({ page }) => {
    await openShell(page);

    const before = await box(page.locator('section[data-pane-leaf="leaf-center"]'));

    // Split the centre area downward from its own menu (T406's control).
    await page
      .locator('section[data-pane-leaf="leaf-center"]')
      .getByRole("button", { name: "Split or close this pane area" })
      .click();
    await page.getByRole("button", { name: "Split down" }).click();

    // The fresh leaf opens EMPTY with the role picker — the user says what it shows.
    const fresh = page.locator('section[data-pane-leaf^="leaf-graph-"]');
    await expect(fresh.locator('[data-testid^="leaf-picker-"]')).toBeVisible();
    await fresh.getByRole("button", { name: "viewer", exact: true }).click();
    await expect(fresh.locator('[role="tab"]')).toHaveText(["viewer"]);

    // Two REAL areas — the B54/V383 claim, as boxes.
    const centre = await box(page.locator('section[data-pane-leaf="leaf-center"]'));
    const freshBox = await box(fresh);
    expect(centre.height).toBeGreaterThan(80);
    expect(freshBox.height).toBeGreaterThan(80);
    // Stacked: the split was DOWN, inside the old centre area.
    expect(freshBox.y).toBeGreaterThan(centre.y + centre.height - 4);
    expect(freshBox.height + centre.height).toBeLessThanOrEqual(before.height + 8);

    // Close the new area from its own menu; the centre takes the space back.
    await fresh.getByRole("button", { name: "Split or close this pane area" }).click();
    await page.getByRole("button", { name: "Close area" }).click();
    const after = await box(page.locator('section[data-pane-leaf="leaf-center"]'));
    expect(after.height).toBeGreaterThan(before.height - 8);
  });
});
