import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * T1195 — SHIFT+F INSIDE A SUBGRAPH, AS A KEYSTROKE AND A CAMERA MOVE.
 *
 * Owner: *"Shift+F doesn't even work in a subgraph. It doesn't do anything for me —
 * definitely doesn't bring it into the center, while it works perfectly outside."*
 *
 * `component-boundary-surfaces.test.tsx` gates the CAUSE — the view holder was filled on
 * the pane's session bus alone, so the root bus every door dispatches on held `null` and
 * `view.frameAll` answered `view.noCanvas`. It executes on the bus directly, which leaves
 * two links of the owner's gesture unmeasured: that the KEY reaches that bus from inside a
 * component, and that the camera actually MOVES. Both are the report, so both are here.
 *
 * ## Why the assertion is "the nodes end up on screen" and not "the transform changed"
 *
 * §V123: `fitView` silently ignores an id it does not know, and a wrong-pane fit is still
 * a real camera move — it frames the WRONG graph. A transform-changed check would pass on
 * exactly the defect being fixed if the root pane had answered instead. So the claim is
 * the owner's own words: after the key, the component's interior is in the canvas.
 *
 * The displacement is asserted rather than assumed. Without a start state where the
 * interior is off screen, "it is on screen afterwards" is true of a dead key too.
 */

/** React Flow's live camera, read off the viewport element rather than any app state. */
async function viewportTransform(page: Page): Promise<string> {
  return page.locator(".react-flow__viewport").first().evaluate((el) => el.style.transform);
}

/** How many of the interior nodes are fully inside the canvas element's rectangle. */
async function nodesOnScreen(page: Page): Promise<{ inside: number; total: number }> {
  const canvas = await page.getByTestId("graph-canvas").boundingBox();
  if (canvas === null) throw new Error("the graph canvas has no bounding box");
  const boxes = await page.locator(".react-flow__node").all();
  let inside = 0;
  for (const node of boxes) {
    const box = await node.boundingBox();
    if (box === null) continue;
    if (
      box.x >= canvas.x &&
      box.y >= canvas.y &&
      box.x + box.width <= canvas.x + canvas.width &&
      box.y + box.height <= canvas.y + canvas.height
    ) {
      inside += 1;
    }
  }
  return { inside, total: boxes.length };
}

test("Shift+F frames the interior once the canvas is inside a component (T1195)", async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    win["showSaveFilePicker"] = undefined;
    win["showOpenFilePicker"] = undefined;
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles("examples/E51-Chorus.loom.json");
  const wall = page.locator('.react-flow__node[data-id="wall"]');
  await expect(wall).toBeVisible();

  const surface = page.locator('[data-keymap-context="graph"]').first();

  /*
   * The CONTROL, and the owner's own comparison: the key works outside. Measured first so
   * a failure inside cannot be blamed on the binding, the focus model or the document.
   */
  await surface.focus();
  const rootBefore = await viewportTransform(page);
  await page.keyboard.press("Shift+F");
  await expect.poll(async () => viewportTransform(page)).not.toBe(rootBefore);

  /*
   * Dive. The double-click on the instance BODY is TD's gesture (T602) and the same one
   * `component-dive-previews.spec.ts` uses on this document. It runs before any fit has
   * had a chance to settle a column outside the canvas, so the coordinate is honest.
   */
  const box = await wall.boundingBox();
  if (box === null) throw new Error("the wall instance has no bounding box");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  await expect(page.locator('.react-flow__node[data-id="grid"]')).toBeVisible();

  /*
   * Displace the camera so a fit has somewhere to come back FROM, and hold the pointer
   * over the canvas rather than dragging: `selectionOnDrag` is on, so a drag here would
   * marquee-select instead of panning, and the test would be measuring a selection.
   */
  const canvasBox = await page.getByTestId("graph-canvas").boundingBox();
  if (canvasBox === null) throw new Error("the graph canvas has no bounding box");
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, -240);

  const displaced = await nodesOnScreen(page);
  expect(displaced.total).toBeGreaterThan(1);
  // The precondition. If the zoom left everything on screen anyway there is nothing for
  // the key to prove, and this says so rather than passing vacuously (§V707).
  expect(
    displaced.inside,
    "zooming in did not push any interior node off the canvas, so the frame below would prove nothing",
  ).toBeLessThan(displaced.total);

  /*
   * THE REPORT. `Shift+F`, from inside the component, on the canvas the user is looking at.
   *
   * `focus()` rather than a click, and the first draft's click is worth the sentence: at
   * the pane's top-left inside a component sits the COMPONENT BAR's "Main" crumb, so a
   * coordinate click there hits the breadcrumb and never reaches the canvas. The keymap
   * wants the pane focused, not clicked, and T639(e) already hands it focus on the dive —
   * this only makes the precondition explicit instead of inherited.
   */
  await surface.focus();
  await page.keyboard.press("Shift+F");

  await expect
    .poll(async () => (await nodesOnScreen(page)).inside, {
      timeout: 5_000,
      message: "Shift+F inside a component did not bring the interior into view",
    })
    .toBe(displaced.total);
});
