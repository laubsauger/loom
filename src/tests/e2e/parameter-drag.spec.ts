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
  await expect(page.getByRole("tabpanel", { name: "inspector" })).toContainText(noise);
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
