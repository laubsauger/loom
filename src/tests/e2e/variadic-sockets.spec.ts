import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { APP_VIEWPORT, addNode, connect, expectEndsOnSocket, fitAll, focusGraph, openApp } from "./app.ts";

/**
 * A VARIADIC INPUT IS N SOCKETS PLUS A SPARE, AND A DROP ON ONE REPLACES IT (T695).
 *
 * The owner's report is two sentences and the second is the load-bearing one: one socket
 * taking every wire is "a bit confusing", and it "prevents us from drop replacing new
 * connections onto existing ones". The second is not a missing feature — it is a thing
 * that cannot be said. With one socket there is no target to aim at, so the only gesture
 * the port supports is "add another".
 *
 * ## Why the assertions come in pairs
 *
 * Counting edges after the replacing drop proves almost nothing on its own: an APPEND
 * that also deleted the old wire counts identically — three layers in, three layers out —
 * while putting the user's new wire at the bottom of a stack they aimed at the middle of.
 * For Composite the layer order IS the operation (§V131), so that is a wrong picture, not
 * a cosmetic difference. So every claim here is made twice: what the document holds, and
 * WHERE on the node the wire lands.
 *
 * The "where" is measured off the rendered path rather than read off an attribute, for the
 * reason §V634 gives: the socket exists and is correctly placed whether or not the edge
 * goes to it, so any assertion that only looks for the socket shares the bug's blindness.
 *
 * ## The sibling this creates
 *
 * Wiring a layer ADDS A ROW, which on a node the user has resized moves every socket below
 * it without changing the node's own rectangle — the one thing React Flow's internal
 * `ResizeObserver` cannot see. That is T694, and its gate is `handle-alignment.spec.ts`.
 */

test.use({ viewport: APP_VIEWPORT });

/** The composite's variadic input renders one socket per edge plus a spare. */
function sockets(page: Page, nodeId: string): Locator {
  return page.locator(`.react-flow__handle.target[data-nodeid="${nodeId}"][data-handleid^="in2#"]`);
}

/**
 * Tidy, then frame everything.
 *
 * Every node the library adds lands at the same default spot, so four of them are a stack
 * and a press aimed at one node's handle lands on whichever is painted last. `l` is the
 * app's own layout-all command, which reads the same `nodeBox` model that grows a node for
 * each socket — so the arrangement stays honest as the wiring changes it.
 */
async function tidy(page: Page): Promise<void> {
  await focusGraph(page);
  await page.keyboard.press("l");
  await fitAll(page);
}

/** A Composite with three layers wired into `in2`, in that order. */
async function threeLayers(page: Page): Promise<{ comp: string; layers: string[] }> {
  await openApp(page);
  const comp = await addNode(page, "composite", "Composite");
  const layers = [
    await addNode(page, "generator", "Noise"),
    await addNode(page, "generator", "Noise"),
    await addNode(page, "generator", "Noise"),
  ];
  await tidy(page);

  // An unwired variadic port is ONE socket — the spare — so it looks exactly as it did
  // before T695 until the user starts using it (§V90).
  await expect(sockets(page, comp)).toHaveCount(1);

  for (const [index, layer] of layers.entries()) {
    // The socket the wire is aimed at only exists because the previous one was filled.
    await connect(page, { nodeId: layer, portId: "out" }, { nodeId: comp, portId: `in2#${String(index)}` });
    await expect(page.locator(".react-flow__edge")).toHaveCount(index + 1);
    await tidy(page);
  }
  return { comp, layers };
}

test("three wires into a variadic input make four sockets", async ({ page }) => {
  const { comp, layers } = await threeLayers(page);

  await expect(sockets(page, comp)).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  // And each wire ends on ITS socket rather than all three piling onto one, which is the
  // half a count could never see.
  for (const [index, layer] of layers.entries()) {
    await expectEndsOnSocket(page, `Edge from ${layer} to ${comp}`, comp, `in2#${String(index)}`, "with three layers wired");
  }
});

test("a drop on an occupied socket replaces that layer where it stood", async ({ page }) => {
  const { comp, layers } = await threeLayers(page);
  const [first, second, third] = layers;

  const replacement = await addNode(page, "generator", "Solid");
  await tidy(page);
  await connect(page, { nodeId: replacement, portId: "out" }, { nodeId: comp, portId: "in2#1" });
  await tidy(page);

  // Half one: the count is unchanged and it is the SECOND layer that went.
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(sockets(page, comp)).toHaveCount(4);
  await expect(page.locator(`.react-flow__edge[aria-label="Edge from ${second} to ${comp}"]`)).toHaveCount(0);
  await expect(page.locator(`.react-flow__edge[aria-label="Edge from ${replacement} to ${comp}"]`)).toHaveCount(1);

  // Half two, and the one an append would pass the first half without: the new wire is in
  // the slot the user aimed at, and the layer that was below it did not move up.
  await expectEndsOnSocket(page, `Edge from ${first} to ${comp}`, comp, "in2#0", "after the replacing drop");
  await expectEndsOnSocket(page, `Edge from ${replacement} to ${comp}`, comp, "in2#1", "after the replacing drop");
  await expectEndsOnSocket(page, `Edge from ${third} to ${comp}`, comp, "in2#2", "after the replacing drop");
});
