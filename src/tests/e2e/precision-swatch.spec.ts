import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, openApp, selectNode } from "./app.ts";

/**
 * T912 — the magnitude ladder's visible way in, and its width.
 *
 * ## Why this one is here and not in `decade-ladder.test.tsx`
 *
 * The jsdom file next to the component owns the BEHAVIOUR: three entry points onto one
 * `ladderOpen`, a swatch whose press cannot reach the drag surface or any ancestor, the
 * rung that governs the next drag. It cannot own the claims below. jsdom applies no
 * stylesheet and computes no layout, so a width comparison there is `0 < 0` — it would
 * pass just as happily against the `min-width: 100%` this task removed, which is the
 * exact defect; and "hidden until hovered" is a stylesheet, not a render.
 *
 * So: a real browser, real fonts, real geometry. The width assertion reports the numbers
 * it measured rather than a verdict (§V649) — "narrower" is only meaningful next to how
 * much narrower and how much drift would still have passed.
 *
 * ## What is NOT here, stated rather than skipped
 *
 * There is no "pressing the swatch does not drag the NODE" spec, because nothing in the
 * app renders `variant="node"` controls inside a React Flow node today — every numeric
 * field on screen is in the inspector, which is outside the canvas. A spec written for it
 * would pass by finding the inspector's field and prove nothing about React Flow (§V634).
 * The guarantee is held instead where it is real and falsifiable: the swatch carries
 * `nodrag`, and its `pointerdown` reaches no ancestor listener at all — both asserted in
 * `decade-ladder.test.tsx`, and both are exactly what React Flow consults.
 */

test.use({ viewport: APP_VIEWPORT });

const FIELD = 'input[aria-label="Amplitude"]';
const SWATCH = 'button[aria-label="Amplitude drag magnitude"]';
const LADDER = '[role="listbox"][aria-label="Amplitude drag magnitude"]';

test("the swatch appears on hover and opens a popout NARROWER than the field", async ({ page }) => {
  await openApp(page);
  const noise = await addNode(page, "generator", "Noise");
  await selectNode(page, noise);

  const field = page.locator(FIELD);
  await field.scrollIntoViewIfNeeded();

  // Ambient state: the affordance is present but invisible, and the field's left edge is
  // still drag surface because the swatch takes no pointer events until it is shown.
  const swatch = page.locator(SWATCH);
  await expect(swatch).toHaveCount(1);
  expect(await swatch.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  expect(await swatch.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

  // Hovering the row reveals it. This is the half a keyboard user gets from `:focus-visible`
  // instead; the jsdom file covers that the button is in the tab order at all.
  await field.hover();
  await expect
    .poll(async () => swatch.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");

  await swatch.click();
  const ladder = page.locator(LADDER);
  await expect(ladder).toBeVisible();
  await expect(ladder.getByRole("option")).toHaveCount(6);

  const fieldBox = await page.locator(FIELD).boundingBox();
  const ladderBox = await ladder.boundingBox();
  if (fieldBox === null || ladderBox === null) throw new Error("field or ladder has no box");

  // THE DEFECT, in numbers: with `min-width: 100%` this measured >= the field's width and
  // the popout read as that input's <select>. Six short magnitudes need a fraction of it.
  expect(
    ladderBox.width,
    `the popout is ${String(Math.round(ladderBox.width))}px wide and the field is ` +
      `${String(Math.round(fieldBox.width))}px — it must be narrower than the input it hangs ` +
      `under, not stretched to it (T912)`,
  ).toBeLessThan(fieldBox.width);
});
