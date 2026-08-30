import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, moveNode, openApp, selectNode } from "./app.ts";

/**
 * T457 (V387) — the plumbing is invisible, and the picture that replaces it PAINTS.
 *
 * Two claims only a real browser can make. jsdom shows the reference-fed rows filtered
 * from the React tree, but not whether the node reads sanely without them — and B54 was
 * months of reference lines present in the DOM painting zero pixels, so "the line
 * element exists" proves nothing. Both are asserted here as geometry: the render node
 * offers no target handle anywhere on screen, and the camera reference line's bounding
 * box has real extent between the two nodes.
 */

test.use({ viewport: APP_VIEWPORT });

test("a render node offers no input sockets, and a named camera paints a hued reference line", async ({
  page,
}, testInfo) => {
  await openApp(page);

  // The camera first, dragged well clear of the library's drop point — the render
  // node is added second and is large enough to bury anything still sitting there,
  // and a buried node cannot be dragged (the press lands on whatever is on top).
  // Overlapping nodes also draw no line: between intersecting rects there is no
  // exterior segment, and not drawing one is correct.
  const cam = await addNode(page, "value", "Camera");
  await moveNode(page, cam, -350, -180);

  const render = await addNode(page, "generator", "Render");
  await moveNode(page, render, 300, 200);

  // (a) Every input of Render is reference-fed plumbing: no target handle exists to
  // invite a wire apply-patch would refuse (port.sourceReference). The output stays.
  await expect(page.locator(`.react-flow__handle.target[data-nodeid="${render}"]`)).toHaveCount(0);
  await expect(page.locator(`.react-flow__handle.source[data-nodeid="${render}"]`)).toHaveCount(1);
  const camName = (await page.getByTestId(`node-name-${cam}`).innerText()).trim();
  expect(camName.length).toBeGreaterThan(0);

  await selectNode(page, render);
  const field = page.locator('input[aria-label="Camera"]');
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.fill(camName);
  await field.press("Enter");

  // (b) B54's lesson, as pixels: the line is in the DOM AND spans real distance, hued
  // as the camera relationship (T248/T391) — the visibility the socket used to fake.
  const line = page.getByTestId(`reference-line-${cam}-${render}`);
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute("data-kind", "camera");
  const box = await line.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.width ?? 0) + (box?.height ?? 0)).toBeGreaterThan(24);

  // V383 evidence for the look pass: the two nodes and the line between them.
  await page.screenshot({ path: testInfo.outputPath("scene-reference-look.png") });
});
