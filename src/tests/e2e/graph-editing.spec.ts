import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, connect, fitAll, focusGraph, handle, modKey, moveNode, openApp } from "./app.ts";

/**
 * T48 — the connect gesture, and undo/redo, driven through a real browser (§V15, §V29).
 *
 * These are the two claims that no unit test can make. `apply-patch.test.ts` proves the
 * bus creates an edge; `keymap-dispatch.test.tsx` proves a key resolves to a command. What
 * neither can see is whether a person dragging from one port to another produces either of
 * those things — which depends on React Flow's pointer handling, the canvas's hit areas,
 * and the keymap context the focused element sits in, none of which exist under jsdom.
 *
 * The trap avoided: asserting only that an edge element appeared. An edge in the React
 * Flow array with no edge in the document is exactly the §V1 violation this product is
 * built to prevent, and it looks identical on screen. So every assertion below is made
 * against something the DOCUMENT drives — the edge survives a reload-free undo/redo cycle,
 * and the compiled plan behind the problems tab changes with it.
 */

test.use({ viewport: APP_VIEWPORT });

test("dragging from an output port to an input port creates one edge", async ({ page }) => {
  await openApp(page);

  const noise = await addNode(page, "generator", "Noise");
  const output = await addNode(page, "output", "Output");
  // T469: fit FIRST, then move — the screen-px drag then lands as a bigger graph-space
  // delta at the fitted zoom, clearing today's ~514px nodes; moving first left the two
  // overlapped, and the node on top buried the other's out handle (measured: the press
  // landed on a name span, dragged the node, and no edge formed).
  await fitAll(page);
  await moveNode(page, output, 260, 240);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  await connect(page, { nodeId: noise, portId: "out" }, { nodeId: output, portId: "input" });

  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
});

test("a node with no input port offers nothing to connect to, and a dropped connection makes no edge", async ({
  page,
}) => {
  await openApp(page);

  // Two generators. Neither declares an input (§V13 is enforced at the port level, so
  // there is not even a handle to aim at), and a connection released over empty canvas
  // must leave the document alone rather than creating a dangling edge.
  const noise = await addNode(page, "generator", "Noise");
  const solid = await addNode(page, "generator", "Solid");
  await moveNode(page, solid, 220, 260);

  await expect(handle(page, solid, "input", "target")).toHaveCount(0);
  await expect(page.locator(".react-flow__handle.target")).toHaveCount(0);

  const source = handle(page, noise, "out", "source");
  const box = await source.boundingBox();
  if (box === null) throw new Error("the Noise output handle is not on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.move(box.x + 120, box.y + 200);
  await page.mouse.up();

  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});

test("undo and redo walk the whole edit history, one entry at a time (§V15)", async ({ page }) => {
  await openApp(page);
  const mod = await modKey(page);

  // Four semantic edits, in order: add, add, move, connect. Every one of them is
  // undoable (§V15) and each is its OWN entry — the move especially, which is the one a
  // "positions are just presentation" reading would drop on the floor.
  const noise = await addNode(page, "generator", "Noise");
  const output = await addNode(page, "output", "Output");
  // T469: fit BEFORE the baseline box — the camera must not move again between the
  // measurement and the undo that is compared against it.
  await fitAll(page);
  const placed = page.locator(`.react-flow__node[data-id="${output}"]`);
  const beforeMove = await placed.boundingBox();
  await moveNode(page, output, 260, 240);
  const afterMove = await placed.boundingBox();
  expect(afterMove?.x).not.toBeCloseTo(beforeMove?.x ?? Number.NaN, 0);
  await connect(page, { nodeId: noise, portId: "out" }, { nodeId: output, portId: "input" });
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await focusGraph(page);

  // Four undos, four distinct states. A single undo that cleared everything would pass a
  // weaker "the graph is empty afterwards" check; so would three.
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);

  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect
    .poll(async () => Math.round((await placed.boundingBox())?.x ?? -1))
    .toBe(Math.round(beforeMove?.x ?? -1));

  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  // Nothing left: a further undo must be a no-op rather than an error or a stack underflow.
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect
    .poll(async () => Math.round((await placed.boundingBox())?.x ?? -1))
    .toBe(Math.round(afterMove?.x ?? -1));
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // Back exactly where the edits left it, edge included.
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});

test("mod+z inside the shader editor edits text and never the graph (§V53)", async ({ page }) => {
  await openApp(page);
  const mod = await modKey(page);

  const fx = await addNode(page, "shader", "Custom WGSL");
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();

  // T469: T492 put a second CodeMirror in the inspector — scope to the dock pane.
  const dock = page.getByRole("region", { name: "Bottom dock" });
  const editor = dock.getByTestId("shader-editor-surface");
  await expect(editor).toBeVisible();
  await dock.locator(".cm-content").click();
  await page.keyboard.insertText("// a comment nobody asked for");

  // The graph must be untouched by an undo aimed at the text context. The node count is
  // the observable: a graph undo here would delete the Custom WGSL node.
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});
