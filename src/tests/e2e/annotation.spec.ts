import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";

import { APP_VIEWPORT, addNode, fitAll, openApp, viewportSettled } from "./app.ts";

/**
 * T1262 — annotation boxes, driven through a real browser.
 *
 * Every claim here is one jsdom cannot make. WHERE the box lands is React Flow's
 * `screenToFlowPosition` of a real right-click; how BIG it gets is a real pointer on a
 * real resize grip divided by a real zoom; what is ON TOP is the compositor's answer to
 * `elementFromPoint`, not a z-index somebody wrote; what COLOUR it is is the computed
 * style after the stylesheet has resolved a `color-mix` of a token; and what SURVIVES is
 * the bytes the app wrote to disk and read back through `<input type="file">`.
 *
 * The one deliberate deviation from the row: the box's size is `GraphNode.size` (§V116),
 * not a `width`/`height` parameter pair — the same field and the same one-patch commit a
 * graph node's grips use — so "resize" here is asserted on the wrapper React Flow lays
 * out FROM the document, and on the saved file, not on the inspector.
 */

test.use({ viewport: APP_VIEWPORT });

/**
 * Off-centre, so a box that landed at the viewport centre could not pass — and high
 * enough that a fresh box's bottom-right grip (≈ 160×100 screen px below and right of it
 * after `seedNodeAndClearRoom`) is still inside the graph pane, which ends near y = 727
 * at `APP_VIEWPORT`; the dock below it would swallow the resize gesture.
 */
const CURSOR = { x: 900, y: 480 } as const;
/** A fresh box's CSS size (`annotation-node.module.css`), before any grip is touched. */
const FRESH = { width: 320, height: 200 } as const;
/** The move that crosses React Flow's 1 px `nodeDragThreshold` and opens a gesture (T1246). */
const OPENING_MOVE_PX = 2;

function annotationWrapper(page: Page): Locator {
  return page.locator(".react-flow__node").filter({ has: page.locator('[data-testid^="annotation-"]') });
}

async function idOf(wrapper: Locator): Promise<string> {
  const id = await wrapper.getAttribute("data-id");
  if (id === null) throw new Error("the annotation wrapper carries no data-id");
  return id;
}

/**
 * React Flow's camera, read from ITS STORE — not from the DOM. `panZoom` writes the
 * viewport transform straight to `style.transform`, and Chromium serialises that back at
 * six significant digits (`getComputedStyle` goes through float32 besides), while this
 * spec asserts positions equal to the double `screenToFlowPosition` divided by. The store
 * is the `value` of a context Provider above the viewport element, found by walking the
 * React fiber tree; a React internal, so the key is discovered, not spelled.
 */
async function camera(page: Page): Promise<{ zoom: number; tx: number; ty: number }> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (element === null) throw new Error("no react-flow viewport");
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
    type Fiber = { return: Fiber | null; memoizedProps?: { value?: { getState?: () => { transform?: unknown } } } };
    let fiber = key === undefined ? null : ((element as unknown as Record<string, Fiber | null>)[key] ?? null);
    while (fiber !== null) {
      const transform = fiber.memoizedProps?.value?.getState?.()?.transform;
      if (Array.isArray(transform) && transform.length === 3) {
        const [tx, ty, zoom] = transform as [number, number, number];
        return { tx, ty, zoom };
      }
      fiber = fiber.return;
    }
    throw new Error("no React Flow store above the viewport");
  });
}

/**
 * The wrapper's position as React WROTE it, read off React's props on the DOM node: the
 * same double the document holds, where `style.transform` would come back rounded.
 */
function reactTransformOf(element: Element): string {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  const props = key === undefined ? undefined : (element as unknown as Record<string, { style?: { transform?: unknown } }>)[key];
  const transform = props?.style?.transform;
  if (typeof transform !== "string") throw new Error(`no React transform on ${element.className}`);
  return transform;
}

/**
 * The graph point under a viewport point — `screenToFlowPosition`'s own arithmetic: the
 * click less the `.react-flow` container's rect, less the camera, over the zoom.
 */
async function graphPointUnder(page: Page, viewportPoint: { x: number; y: number }) {
  const box = await page.evaluate(() => {
    const element = document.querySelector(".react-flow");
    if (element === null) throw new Error("no react-flow container");
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
  const { zoom, tx, ty } = await camera(page);
  return { x: (viewportPoint.x - box.x - tx) / zoom, y: (viewportPoint.y - box.y - ty) / zoom };
}

/** The wrapper's position as React Flow wrote it — the same double the document holds. */
async function graphPositionOf(node: Locator): Promise<{ x: number; y: number }> {
  return node.evaluate((element, read) => {
    const readTransform = new Function("element", `return (${read})(element)`) as (element: Element) => string;
    const transform = readTransform(element);
    const match = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)/.exec(transform);
    if (match === null) throw new Error(`unexpected node transform: ${transform}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }, reactTransformOf.toString());
}

async function offsetWithin(page: Page, viewportPoint: { x: number; y: number }) {
  const box = await page.getByTestId("graph-canvas").boundingBox();
  if (box === null) throw new Error("the graph canvas has no box");
  return { x: viewportPoint.x - box.x, y: viewportPoint.y - box.y };
}

/**
 * One graph node, then room to work. The first node added to an empty document fires
 * React Flow's fit-on-init, which would otherwise move a freshly placed box after the
 * placement assertion had read it; and that fit frames the lone node so tightly that a
 * right-click anywhere hits the node's menu rather than the pane's. Three wheel notches
 * out (d3-zoom: 2^(-1500 × 0.002) = ÷8) leave `CURSOR` over empty canvas — asserted, so a
 * chrome change that framed differently fails here and not in a menu lookup.
 */
async function seedNodeAndClearRoom(page: Page): Promise<string> {
  const noise = await addNode(page, "generator", "Noise");
  await fitAll(page);
  const canvas = await page.getByTestId("graph-canvas").boundingBox();
  if (canvas === null) throw new Error("the graph canvas has no box");
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, 1500);
  await viewportSettled(page);
  const under = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.getAttribute("data-id") ?? null,
    CURSOR,
  );
  if (under !== null) throw new Error(`CURSOR is over node ${under}; the seed leaves no room`);
  return noise;
}

/** Right-click → "Add annotation" at `at`; returns the wrapper and the graph point clicked. */
async function addAnnotationAt(page: Page, at: { x: number; y: number }) {
  const before = await page.locator(".react-flow__node").count();
  const expected = await graphPointUnder(page, at);
  await page.getByTestId("graph-canvas").click({ button: "right", position: await offsetWithin(page, at) });
  await page.locator('[role="menuitem"]', { hasText: "Add annotation" }).first().click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  const wrapper = annotationWrapper(page).last();
  await expect(wrapper).toBeVisible();
  return { wrapper, expected, id: await idOf(wrapper) };
}

/** The wrapper's laid-out size, as React Flow wrote it from the document. */
async function wrapperSize(wrapper: Locator): Promise<{ width: string; height: string }> {
  return wrapper.evaluate((element) => ({
    width: (element as HTMLElement).style.width,
    height: (element as HTMLElement).style.height,
  }));
}

/** Drags the bottom-right grip by a screen delta, with the opening move first (T1246). */
async function resizeAnnotation(page: Page, id: string, dx: number, dy: number): Promise<void> {
  await page.getByTestId(`annotation-title-${id}`).click();
  const grip = page.locator(`.react-flow__node[data-id="${id}"] .react-flow__resize-control.handle.bottom.right`);
  await expect(grip).toBeVisible();
  const box = await grip.boundingBox();
  if (box === null) throw new Error("the resize grip has no box on screen");
  // Whole pixels, so the pointer's Δ is exactly `dx`/`dy` whatever the event rounds to.
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + OPENING_MOVE_PX, y + OPENING_MOVE_PX);
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

interface SavedNode {
  type: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parameters: Record<string, { value?: unknown } | unknown>;
}

/**
 * Saves through the real download path and parses the bytes. The document's doubles
 * survive only here: the DOM serialises a `translate()` to six significant digits, so a
 * position read back off a wrapper is the app's number rounded, not the app's number.
 */
async function saveProject(page: Page, testInfo: TestInfo): Promise<{ path: string; nodes: Record<string, SavedNode> }> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("project-save").click();
  const download = await downloadPromise;
  const directory = await mkdtemp(join(tmpdir(), "shaderloom-annotation-"));
  const path = join(directory, download.suggestedFilename());
  await download.saveAs(path);
  testInfo.attachments.push({ name: "project", path, contentType: "application/json" });
  const saved = JSON.parse(await readFile(path, "utf8")) as { graph: { nodes: Record<string, SavedNode> } };
  return { path, nodes: saved.graph.nodes };
}

/** Resolves a CSS colour expression the way the page does, via a throwaway probe element. */
async function resolvedColor(page: Page, expression: string): Promise<string> {
  return page.evaluate((expr) => {
    const probe = document.createElement("div");
    probe.style.color = expr;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, expression);
}

test("right-click → Add annotation places the box at the clicked graph point", async ({ page }, testInfo) => {
  await openApp(page);
  await seedNodeAndClearRoom(page);

  const { wrapper, expected, id } = await addAnnotationAt(page, CURSOR);
  // EXACT: the menu's builder hands `screenToFlowPosition` of the click straight to the
  // patch — no snapping, no rounding — the wrapper is laid out at that double, and the
  // bytes the app writes hold it.
  expect(await graphPositionOf(wrapper)).toEqual(expected);
  const { nodes } = await saveProject(page, testInfo);
  expect(nodes[id]?.position).toEqual(expected);
  // And it is a box, not a node: no ports, no chrome, the title the definition defaults to.
  await expect(wrapper.locator(".react-flow__handle")).toHaveCount(0);
  await expect(page.getByTestId(`annotation-title-${id}`)).toHaveText("Note");
});

test("a grip drag resizes the box by exactly Δ / zoom, committed to the document", async ({ page }) => {
  await openApp(page);
  await seedNodeAndClearRoom(page);
  const { wrapper, id } = await addAnnotationAt(page, CURSOR);
  // Fresh: no stored size, so the wrapper carries none and the stylesheet's box shows.
  expect(await wrapperSize(wrapper)).toEqual({ width: "", height: "" });
  const box = page.getByTestId(`annotation-${id}`);
  await expect(box).toHaveCSS("width", `${FRESH.width}px`);
  await expect(box).toHaveCSS("height", `${FRESH.height}px`);
  const { zoom } = await camera(page);

  const DRAG = { x: 150, y: 90 } as const;
  await resizeAnnotation(page, id, DRAG.x, DRAG.y);

  // The document's size: the fresh box plus the gesture in graph units. `Math.floor` is
  // React Flow's own (`getDimensionsAfterResize` floors the pointer distance before adding
  // it to the measured start size, so the view's size is already whole); §V116's
  // `Math.round` in apply-patch then has nothing left to move. A gesture that reached the
  // document as the VIEW's float would fail on the fraction, a rejected commit on the
  // empty string the wrapper had before, a rounded distance on the odd unit.
  const expected = {
    width: `${FRESH.width + Math.floor(DRAG.x / zoom)}px`,
    height: `${FRESH.height + Math.floor(DRAG.y / zoom)}px`,
  };
  await expect.poll(() => wrapperSize(wrapper), { message: "the resize did not commit" }).toEqual(expected);
  // Non-vacuity: the gesture actually changed something at this zoom.
  expect(Math.floor(DRAG.x / zoom)).toBeGreaterThan(0);
  expect(Math.floor(DRAG.y / zoom)).toBeGreaterThan(0);
});

test("a node dragged over the box is drawn ABOVE it — even while the box is selected", async ({ page }) => {
  await openApp(page);
  const noise = await seedNodeAndClearRoom(page);
  const { wrapper, id } = await addAnnotationAt(page, CURSOR);

  // Select the box: React Flow lifts a selected node by 1000, which is exactly the case
  // a "behind" that only held for unselected boxes would fail.
  await page.getByTestId(`annotation-title-${id}`).click();
  await expect(wrapper).toHaveClass(/selected/);

  // Drag the node until its header sits over the box's middle.
  const target = await page.getByTestId(`annotation-${id}`).boundingBox();
  const node = page.locator(`.react-flow__node[data-id="${noise}"]`);
  const from = await node.boundingBox();
  if (target === null || from === null) throw new Error("no boxes on screen");
  const grab = { x: from.x + 60, y: from.y + 8 };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + OPENING_MOVE_PX, grab.y);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await viewportSettled(page);

  // The compositor's answer: the element under the point inside BOTH is the node's.
  const onTop = await page.evaluate(
    ({ x, y, noise }) => document.elementFromPoint(x, y)?.closest(`.react-flow__node[data-id="${noise}"]`) !== null,
    { x: to.x, y: to.y, noise },
  );
  expect(onTop, "the node is not the topmost element over the annotation").toBe(true);
  // And the stacking React Flow computed: the selected box still below the unselected node.
  const z = await page.evaluate(
    ({ id, noise }) => ({
      box: Number(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.style.zIndex),
      node: Number(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${noise}"]`)?.style.zIndex ?? "0"),
    }),
    { id, noise },
  );
  expect(z.box).toBeLessThan(z.node);
  expect(z.box).toBeLessThan(0);
});

test("the colour parameter paints the box from that category's token, wash and border", async ({ page }) => {
  await openApp(page);
  await seedNodeAndClearRoom(page);
  const { id } = await addAnnotationAt(page, CURSOR);
  const box = page.getByTestId(`annotation-${id}`);

  // Selecting the box puts it in the inspector; the colour is an ordinary enum control.
  await page.getByTestId(`annotation-title-${id}`).click();
  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  await expect(inspector.locator(`[data-node-id="${id}"]`)).toHaveCount(1);
  await inspector.locator('select[aria-label="Colour"]').selectOption("points");
  await expect(box).toHaveAttribute("data-color", "points");

  // Computed against the page's own resolution of the same expressions — exact strings.
  const token = await resolvedColor(page, "var(--category-points)");
  const wash = await resolvedColor(page, "color-mix(in srgb, var(--category-points) 16%, transparent)");
  expect(token).not.toBe(wash);
  await expect(box).toHaveCSS("border-top-color", token);
  await expect(box).toHaveCSS("background-color", wash);
  // And the previous hue is gone: the default's border is a different colour.
  expect(await resolvedColor(page, "var(--category-utility)")).not.toBe(token);
});

test("title, body, colour and size survive save → reload → open", async ({ page }, testInfo) => {
  await openApp(page);
  await seedNodeAndClearRoom(page);
  const { wrapper, id } = await addAnnotationAt(page, CURSOR);

  // Title: in place.
  await page.getByTestId(`annotation-title-${id}`).dblclick();
  const field = page.getByTestId(`annotation-title-input-${id}`);
  await field.fill("Chemistry");
  await field.press("Enter");
  await expect(page.getByTestId(`annotation-title-${id}`)).toHaveText("Chemistry");

  // Body and colour: the inspector.
  await page.getByTestId(`annotation-title-${id}`).click();
  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  await expect(inspector.locator(`[data-node-id="${id}"]`)).toHaveCount(1);
  const body = inspector.locator('textarea[aria-label="Body"]');
  await body.fill("Gray-Scott plate\nseeded on onsets");
  await body.blur();
  await expect(page.getByTestId(`annotation-body-${id}`)).toHaveText("Gray-Scott plate\nseeded on onsets");
  await inspector.locator('select[aria-label="Colour"]').selectOption("filter");
  await expect(page.getByTestId(`annotation-${id}`)).toHaveAttribute("data-color", "filter");

  // Size: a grip.
  await resizeAnnotation(page, id, 120, 60);
  const size = await expect
    .poll(() => wrapperSize(wrapper))
    .not.toEqual({ width: "", height: "" })
    .then(() => wrapperSize(wrapper));
  const width = Number.parseInt(size.width, 10);
  const height = Number.parseInt(size.height, 10);
  expect(width).toBeGreaterThan(FRESH.width);
  expect(height).toBeGreaterThan(FRESH.height);

  // The bytes: an ordinary node of type `annotate`, its words as parameters, its box as size.
  const { path: savedPath, nodes } = await saveProject(page, testInfo);
  const note = nodes[id];
  expect(note?.type).toBe("annotate");
  expect(note?.size).toEqual({ width, height });
  const stored = (key: string) => {
    const slot = note?.parameters[key];
    return slot !== null && typeof slot === "object" && "value" in slot ? (slot as { value: unknown }).value : slot;
  };
  expect(stored("title")).toBe("Chemistry");
  expect(stored("body")).toBe("Gray-Scott plate\nseeded on onsets");
  expect(stored("color")).toBe("filter");

  // A fresh page, then the file: everything on screen again comes from the bytes.
  await page.reload();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooserPromise).setFiles(savedPath);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);

  const reopened = annotationWrapper(page).first();
  await expect(reopened).toHaveAttribute("data-id", id);
  await expect(page.getByTestId(`annotation-title-${id}`)).toHaveText("Chemistry");
  await expect(page.getByTestId(`annotation-body-${id}`)).toHaveText("Gray-Scott plate\nseeded on onsets");
  await expect(page.getByTestId(`annotation-${id}`)).toHaveAttribute("data-color", "filter");
  expect(await wrapperSize(reopened)).toEqual({ width: `${width}px`, height: `${height}px` });
});

test("the overview map shows the box in its own colour", async ({ page }) => {
  await openApp(page);
  await seedNodeAndClearRoom(page);
  const { id } = await addAnnotationAt(page, CURSOR);
  await page.getByTestId(`annotation-title-${id}`).click();
  await page.getByRole("tabpanel", { name: "inspector" }).locator('select[aria-label="Colour"]').selectOption("points");
  await expect(page.getByTestId(`annotation-${id}`)).toHaveAttribute("data-color", "points");

  const map = page.getByTestId("rf__minimap");
  await expect(map).toBeVisible();
  // One box per node, and the annotation's is the category token its colour names — the
  // same variable the canvas border resolves — not the sink tone a portless node would get.
  await expect
    .poll(() =>
      map.locator(".react-flow__minimap-node").evaluateAll((boxes) => boxes.map((box) => (box as SVGElement).style.fill).sort()),
    )
    .toEqual(["var(--category-points)", "var(--port-texture2d)"]);
});
