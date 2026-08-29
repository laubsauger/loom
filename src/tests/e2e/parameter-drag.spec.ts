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
 * ## FAILING GATE — the live half is not met, and the test is left red
 *
 * Measured, in the running app, on this machine: during a drag the field's value never
 * changes. It jumps once, to the final value, when the pointer comes up. The same is true
 * of a held arrow key, which takes the same `"live"` → `"commit"` path. So the document
 * receives ONLY the commit, and the second half of §V15 is not happening.
 *
 * What that costs: a slider drag shows no feedback until it is released, which is the
 * single most important interaction in a compositor. Everything downstream that §V5 exists
 * to make cheap — the uniform-only update path, the live preview — is unreachable from the
 * UI, because nothing asks for it until the gesture is over.
 *
 * Where it is NOT: `src/editor/inspector/parameter-editor.ts` and
 * `src/ui/controls/coalesce.ts` both do the right thing in isolation and are unit-tested
 * doing it (`parameter-editor.test.ts` drives `"live"` values straight in and sees the
 * patches). `NumberField` calls `emit(next, "live")` on every pointer move — proven by the
 * final value, which is read off the drag state that only `onPointerMove` writes. So the
 * break is between the control and the editor instance in the composed app, not inside
 * either piece. `src/editor/inspector/inspector.tsx` builds its own editor in a `useMemo`
 * and disposes it in an effect cleanup; a disposed coalescer cancels its pending frame,
 * which would swallow exactly the live values and leave the commit path (which sends
 * immediately) working. That is the first place to look.
 *
 * Do not relax this to "the value changed by the end". That assertion passes against the
 * behaviour described above.
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
  await expect(page.locator('section[aria-label="Inspector"]')).toContainText(noise);
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
