import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  APP_VIEWPORT,
  addNode,
  connect,
  edgeEndpointOffset,
  expectEndsOnSocket,
  fitAll,
  focusGraph,
  openApp,
} from "./app.ts";

/**
 * AN EDGE ENDS WHERE ITS SOCKET IS DRAWN, AFTER THE NODE HAS REFLOWED UNDER IT (T694).
 *
 * ## What the lead said, and what the browser said
 *
 * The lead was that `updateNodeInternals` appears nowhere in `src/`, that React Flow caches
 * handle bounds, and that a resize therefore leaves edges pointing at stale ones. The first
 * two are true. The third is not, and it was worth an hour to find out: @xyflow/react
 * 12.11.5 puts its OWN `ResizeObserver` on every node element and recomputes the bounds
 * with `force: true` whenever that element's box changes. Measured on this tree before any
 * fix: grow, shrink, top-left resize (which moves the node as well as sizing it), undo and
 * redo all report **0.00 px** of drift, and so do all 23 edges of E33 Obol after four of
 * its nodes are resized.
 *
 * The mechanism the lead named is real; the trigger is not the resize itself. It is:
 *
 *   **a handle moving while the node's own box does not change.**
 *
 * A `ResizeObserver` is blind to that by construction. Measured, again before the fix: a
 * 30px shift of the ports block inside an unchanged node box leaves the wire exactly
 * **30.00 px** behind. And the state in which that happens all the time is a node the user
 * has RESIZED — `node.size` fixes the outer box, and from then on `.preview` absorbs every
 * change around it (§V117), so the ports slide inside a rectangle that never moves. Which
 * is why the owner saw this on nodes they had resized, and why the first test below is a
 * PIN (green before the fix, kept so the claim stays refutable) while the second is the
 * gate (red before it).
 *
 * ## Why the numbers are numbers
 *
 * §V649 — a tolerance that is never stated is a verdict with its population hidden. Every
 * assertion here reports the distance measured, in graph pixels, against a tolerance
 * `app.ts` names and justifies. And it is measured off the path the browser painted, not
 * looked up in the DOM: the socket is present and correctly positioned in the broken tree
 * too, so a query for it cannot see this bug (§V634).
 */

test.use({ viewport: APP_VIEWPORT });

async function tidy(page: Page): Promise<void> {
  await focusGraph(page);
  await page.keyboard.press("l");
  await fitAll(page);
}

/** Fixes the node's box by dragging its bottom-right grip, which is what `node.size` is. */
async function resize(page: Page, nodeId: string, dx: number, dy: number): Promise<void> {
  await page.getByTestId(`node-name-${nodeId}`).click();
  const grip = page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__resize-control.handle.bottom.right`,
  );
  await expect(grip).toBeVisible();
  const box = await grip.boundingBox();
  if (box === null) throw new Error("the resize grip has no box on screen");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 3, y + dy / 3, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test("resizing a node keeps its wire on its socket", async ({ page }) => {
  await openApp(page);
  const source = await addNode(page, "generator", "Noise");
  const sink = await addNode(page, "output", "Output");
  await tidy(page);
  await connect(page, { nodeId: source, portId: "out" }, { nodeId: sink, portId: "input" });
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await tidy(page);

  const label = `Edge from ${source} to ${sink}`;
  const before = await edgeEndpointOffset(page, label, sink, "input");
  await resize(page, sink, 60, 90);
  const after = await edgeEndpointOffset(page, label, sink, "input");

  // Stated as the pair, so the test carries its own evidence rather than a boolean: both
  // numbers are 0 today, and the point of keeping it is that a future change to how the
  // resize gesture commits would move the second one and say so.
  expect({ before, after }).toEqual({ before: 0, after: 0 });
});

/**
 * The gate. Red before `useHandleBoundsInSync`, measured: the older wire is left 16 px —
 * exactly one port row — above the socket it belongs to.
 *
 * A variadic input grows a socket per wire (T695), so wiring a second layer adds a ROW.
 * On a node whose size the user has fixed, that row is absorbed inside the existing box:
 * the ports block moves, the node's rectangle does not, and React Flow's own observer
 * never fires. It is the same shape as every other internal reflow — a diagnostic row
 * arriving under the ports, a definition gaining a socket — which is why the fix measures
 * the handles instead of listing the things that move them.
 */
test("adding a port row to a resized node keeps every wire on its socket", async ({ page }) => {
  await openApp(page);
  const comp = await addNode(page, "composite", "Composite");
  const first = await addNode(page, "generator", "Noise");
  const second = await addNode(page, "generator", "Solid");
  await tidy(page);

  await connect(page, { nodeId: first, portId: "out" }, { nodeId: comp, portId: "in2#0" });
  await tidy(page);
  await expectEndsOnSocket(page, `Edge from ${first} to ${comp}`, comp, "in2#0", "before the resize");

  // From here the node's outer box is fixed and its content reflows inside it.
  await resize(page, comp, 60, 90);
  await expectEndsOnSocket(page, `Edge from ${first} to ${comp}`, comp, "in2#0", "after the resize");

  // The second layer adds a row INSIDE that fixed box. The first wire's socket moves; the
  // first wire has to move with it, and nothing in React Flow will notice on its own.
  await connect(page, { nodeId: second, portId: "out" }, { nodeId: comp, portId: "in2#1" });
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expectEndsOnSocket(page, `Edge from ${first} to ${comp}`, comp, "in2#0", "after a row was added");
  await expectEndsOnSocket(page, `Edge from ${second} to ${comp}`, comp, "in2#1", "after a row was added");
});
