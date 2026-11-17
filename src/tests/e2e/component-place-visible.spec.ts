import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, openApp, viewportSettled } from "./app.ts";

/**
 * §B300 — A COMPONENT CLICKED IN THE LIBRARY LANDS WHERE THE USER IS LOOKING.
 *
 * Reported 2026-11-12: "clicking components in the sidebar is not spawning them in the
 * graph somehow. or at least they are not visible somehow." The instance WAS added, and
 * selected; it was placed at the graph origin, because the Components pane sent no position
 * and `component.instantiate` defaults to (0, 0). A node type's click has always gone to the
 * viewport's centre. In a project laid out far from the origin, the new instance was off
 * screen.
 *
 * The repro is that project's shape: E47 Hologram, which embeds a component library, with
 * every node moved far from the origin, so the fitted view does not contain (0, 0). The
 * claim is what the user reads back: the new instance's box is inside the canvas.
 * Geometry only, so the headless lane: no GPU.
 */

test.use({ viewport: APP_VIEWPORT });

const FAR = { x: 24000, y: 16000 } as const;

test("a component clicked in the library is placed inside the view of a project far from the origin", async ({ page }) => {
  const shipped = JSON.parse(await readFile(join(process.cwd(), "examples/E47-Hologram.loom.json"), "utf8")) as {
    graph: { nodes: Record<string, { position: { x: number; y: number } }> };
  };
  for (const node of Object.values(shipped.graph.nodes)) {
    node.position = { x: node.position.x + FAR.x, y: node.position.y + FAR.y };
  }
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "far.loom.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(shipped)) });
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(Object.keys(shipped.graph.nodes).length);
  await viewportSettled(page);
  const before = new Set(await nodes.evaluateAll((all) => all.map((node) => node.getAttribute("data-id"))));

  await page.getByRole("tab", { name: "components" }).click();
  // The row's main button is the linked placement; "copy" is its sibling.
  await page.getByRole("button", { name: /^DepthPoints v\d+ / }).click();

  await expect(nodes).toHaveCount(before.size + 1);
  await viewportSettled(page);
  const ids = await nodes.evaluateAll((all) => all.map((node) => node.getAttribute("data-id")));
  const added = ids.find((id) => !before.has(id));
  if (added === null || added === undefined) throw new Error("the placed instance carries no data-id");

  const canvas = await page.getByTestId("graph-canvas").boundingBox();
  const box = await page.locator(`.react-flow__node[data-id="${added}"]`).boundingBox();
  if (canvas === null || box === null) throw new Error("the canvas or the placed instance has no box");
  // Its top-left corner is the viewport's centre, as for a node type's click.
  expect(box.x).toBeGreaterThan(canvas.x);
  expect(box.x).toBeLessThan(canvas.x + canvas.width);
  expect(box.y).toBeGreaterThan(canvas.y);
  expect(box.y).toBeLessThan(canvas.y + canvas.height);
  // And it is the selection, so the inspector and the next keystroke are on it.
  await expect(page.locator(`.react-flow__node[data-id="${added}"]`)).toHaveClass(/selected/);
});
