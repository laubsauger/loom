import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, dragNumber, focusGraph, modKey, openApp, selectNode } from "./app.ts";

/**
 * T48 — dragging a parameter (§V15, §V20).
 *
 * ## The two claims, and why both have to be here
 *
 * §V15: "continuous drag coalesced → 1 history entry, live values still applied." Those
 * pull in opposite directions and a test that checks one is satisfied by a product that
 * fails the other — a control that only commits on release has one entry and no live
 * update; a control that commits per pointer move is live and leaves eighty undo entries.
 * So the drag records every distinct value the field showed WHILE the pointer was down,
 * and the history claim is made by counting undos: exactly one restores the original
 * value, and the node added before the drag is still there afterwards.
 *
 * §V20: the same gesture must not pan the graph, drag the node, or change the selection.
 * That is asserted by the things that must NOT have moved.
 *
 * History: the live half was once a deliberately red FAILING GATE — during a drag the
 * field's value never changed, it jumped once on pointer-up, so the document received only
 * the commit and the second half of §V15 was not happening. The break was between the
 * control and the editor instance in the composed app (the inspector's `useMemo` editor
 * disposed its coalescer in an effect cleanup, cancelling the pending live frame), not
 * inside `parameter-editor.ts` or `coalesce.ts`, which were unit-tested doing the right
 * thing. Fixed and confirmed passing (§T798); kept as the regression gate for both halves.
 *
 * Do not relax the live assertion to "the value changed by the end" — that passes against
 * the old broken behaviour, where the only change arrived on release.
 */

test.use({ viewport: APP_VIEWPORT });

test("a drag applies values live and lands as ONE undo entry (§V15)", async ({ page }) => {
  await openApp(page);
  const mod = await modKey(page);

  const noise = await addNode(page, "generator", "Noise");
  await selectNode(page, noise);

  const drag = await dragNumber(page, "Amplitude", 80);

  // Half one: the gesture reached the document at all.
  expect(drag.after).not.toBe(drag.before);

  // Half two: it reached the document WHILE the pointer was down. `during` holds every
  // distinct value the field showed between pointerdown and pointerup; a control that
  // only commits on release contributes exactly one entry, the starting value.
  expect(
    drag.during.filter((value) => value !== drag.before),
    `the value never moved during the gesture (saw ${JSON.stringify(drag.during)}); ` +
      "it only appeared on release, so live values are not applied (§V15)",
  ).not.toEqual([]);

  await focusGraph(page);
  await page.keyboard.press(`${mod}+z`);

  await selectNode(page, noise);
  await expect(page.locator('input[aria-label="Amplitude"]')).toHaveValue(drag.before);
  // …and the node the drag was performed on is still here, which is what makes the
  // previous assertion mean "one entry" rather than "the whole session was undone".
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});

test("a drag on a control never pans the graph or moves the node (§V20)", async ({ page }) => {
  await openApp(page);

  const noise = await addNode(page, "generator", "Noise");
  await selectNode(page, noise);

  const node = page.locator(`.react-flow__node[data-id="${noise}"]`);
  const beforeBox = await node.boundingBox();
  const beforeTransform = await page
    .locator(".react-flow__viewport")
    .evaluate((element) => element.style.transform);

  await dragNumber(page, "Amplitude", 90);

  const afterBox = await node.boundingBox();
  const afterTransform = await page
    .locator(".react-flow__viewport")
    .evaluate((element) => element.style.transform);

  expect(afterBox?.x).toBeCloseTo(beforeBox?.x ?? Number.NaN, 1);
  expect(afterBox?.y).toBeCloseTo(beforeBox?.y ?? Number.NaN, 1);
  expect(afterTransform, "the control drag panned the canvas").toBe(beforeTransform);
  // The gesture belongs to the control: the node it sits on is still the selection.
  // T1124: read from `data-node-id`, not from the panel's text — the header names the
  // node (T954/§B170) and never prints the id a labelled node is addressed by.
  await expect(
    page.getByRole("tabpanel", { name: "inspector" }).locator(`[data-node-id="${noise}"]`),
  ).toHaveCount(1);
});

test("typing a value into the field commits it, and one undo takes it back", async ({ page }) => {
  await openApp(page);
  const mod = await modKey(page);

  const noise = await addNode(page, "generator", "Noise");
  await selectNode(page, noise);

  const field = page.locator('input[aria-label="Amplitude"]');
  await field.scrollIntoViewIfNeeded();
  const before = await field.inputValue();

  // A press that never moves hands the field to the keyboard (a double click is the
  // reset-to-default gesture, which is a different thing).
  await field.click();
  await expect(field).not.toHaveAttribute("readonly", /.*/);
  await field.fill("0.25");
  await field.press("Enter");

  // Quantised to the parameter's step, so the assertion is "it moved", not a literal.
  const typed = await field.inputValue();
  expect(typed).not.toBe(before);

  await focusGraph(page);
  await page.keyboard.press(`${mod}+z`);
  await selectNode(page, noise);
  await expect(page.locator('input[aria-label="Amplitude"]')).toHaveValue(before);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});

/**
 * §B159 / §V776 — the owner's report, driven with REAL KEYSTROKES.
 *
 * The test above types with `fill()`, which sets the value and dispatches an input event.
 * That is not what the owner did and it is why the bug shipped: `fill()` never presses a
 * key, so it cannot see a control that swallows the keystroke. Measured here before the
 * fix — focus the field, press `5`, and the field stayed `readonly` showing `1.00`.
 *
 * The second press is the other half of §V776. A control that opened the edit but seeded
 * it with the OLD value would pass "typing works" and still lose the digit; asserting the
 * field reads `52` after `5` then `2` pins both the seed AND the caret sitting after it.
 */
test("a focused field takes the digit that opened it, and appends the next (§B159)", async ({
  page,
}) => {
  await openApp(page);

  const noise = await addNode(page, "generator", "Noise");
  await selectNode(page, noise);

  const field = page.locator('input[aria-label="Amplitude"]');
  await field.scrollIntoViewIfNeeded();
  const before = await field.inputValue();

  // No click, no Enter, no F2 — the field is merely where the keyboard is.
  await field.focus();
  await expect(field).toHaveAttribute("readonly", /.*/);

  await page.keyboard.press("5");
  await expect(field, "the keystroke that starts the edit IS the edit").toHaveValue("5");
  await expect(field).not.toHaveAttribute("readonly", /.*/);

  await page.keyboard.press("2");
  await expect(field, "the caret sits after the seed, so the next digit appends").toHaveValue("52");

  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  expect(await field.inputValue()).not.toBe(before);

  // A letter is nobody's number: it opens no edit, so the graph keymap still owns it.
  await page.keyboard.press("Escape");
  await field.focus();
  await page.keyboard.press("q");
  await expect(field).toHaveAttribute("readonly", /.*/);
});

/**
 * T1033 — the two halves of "grabbing the slider is awkward. It's a bit weak".
 *
 * Both need a REAL pointer, which is why they are here and not in jsdom. The first is a
 * gesture whose failure is invisible to every synthetic test that fires pointerdown and
 * pointermove in the same tick: the drag only broke when the press PAUSED, and pausing is
 * what a deliberate user does. The second is a hit target, and jsdom lays nothing out, so
 * "is this pixel inside the grab surface" is a question only a browser can answer.
 */
/**
 * Selection, WITHOUT `selectNode` from `app.ts` — deliberately, and this note is the
 * reason rather than a preference.
 *
 * That helper asserts the inspector's tab panel CONTAINS the node id as text, and the
 * inspector renders the node's NAME ("noise1") while ids are opaque ("nd_97b8d77dc4ae1").
 * The assertion cannot pass, and it fails ahead of every test that calls it — six in this
 * file and this spec's neighbours before T1033 touched anything. Not this task's to fix:
 * `app.ts` is shared, the repair is the owning track's call, and the durable contract it
 * should be reading is the `data-node-id` attribute the inspector has always set
 * (`PARAMETER_NODE_ATTRIBUTE`). That is what this reads, so these two gates can run.
 */
async function showInInspector(page: Page, nodeId: string): Promise<void> {
  await page.getByTestId(`node-name-${nodeId}`).click();
  await expect(page.locator(`[data-node-id="${nodeId}"]`).first()).toBeVisible();
}

test("a press that pauses before it moves still drags (T1033)", async ({ page }) => {
  await openApp(page);

  const noise = await addNode(page, "generator", "Noise");
  await showInInspector(page, noise);

  const field = page.locator('input[aria-label="Amplitude"]').last();
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (box === null) throw new Error("Amplitude has no box on screen");
  const before = await field.inputValue();

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  // Longer than LADDER_HOLD_MS. Before T1033 the hold nulled the drag ref, so everything
  // after this line landed on nothing and the value came back exactly `before` — measured
  // in the running app at 500 ms and 80 px of travel.
  await page.waitForTimeout(700);
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(box.x + 30 + step * 8, y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  expect(
    await field.inputValue(),
    "the press sat still for 700 ms and then dragged 80 px, and the value did not move",
  ).not.toBe(before);

  // And the popout the pause opened is gone: a drag must not leave chrome over the rows
  // below it (§V90).
  await expect(page.getByRole("listbox", { name: /drag magnitude/ })).toHaveCount(0);
});

test("the grab surface reaches past the field's painted box (T1033)", async ({ page }) => {
  await openApp(page);

  const noise = await addNode(page, "generator", "Noise");
  await showInInspector(page, noise);

  const field = page.locator('input[aria-label="Amplitude"]').last();
  await field.scrollIntoViewIfNeeded();
  // The PAINTED field, not the input inside it: the input is a centred flex child and is
  // shorter than the box whose edge this test is about.
  const painted = field.locator("xpath=..");
  const box = await painted.boundingBox();
  if (box === null) throw new Error("Amplitude's field has no box on screen");
  const before = await field.inputValue();

  // One pixel ABOVE the paint — dead space until T1033 gave the row's own padding to the
  // host as hit area. A press here used to land on nothing at all.
  const y = box.y - 1;
  await page.mouse.move(box.x + 30, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(box.x + 30 + step * 8, y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  expect(
    await field.inputValue(),
    "a press 1px above the field's border did not start its drag, so the target is still " +
      "only as tall as the paint",
  ).not.toBe(before);
});
