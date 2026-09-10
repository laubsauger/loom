import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { APP_VIEWPORT, addNode, fitAll, focusGraph, moveNode, openApp, viewportSettled } from "./app.ts";

/**
 * T1257 — the network overview map, TD-style: drag it to pan, click it to jump, `o` to
 * toggle, and the toggle is a preference that survives a reload.
 *
 * ## What is asserted, and to what precision
 *
 * Every number here is derived from what the browser is showing — the map's own
 * `viewBox` and the viewport's own transform — never from a tolerance around a hoped-for
 * value. The map draws the graph at `viewBox width / map width` graph units per map
 * pixel (with `offsetScale` 0 the viewBox and the element share an aspect ratio, so
 * that ratio is the whole story — see `graph-minimap.tsx`), so a drag of Δ map pixels
 * moves the viewport by exactly Δ × that ratio in graph units, and a click at a map
 * pixel names exactly one graph point.
 *
 * The comparisons are `toBeCloseTo` at the precision the browser's own arithmetic
 * allows, not a band around a hoped-for value. The drag is held to 9 decimals: the
 * expected value is the product of a `viewBox` float and a transform float in an order
 * React Flow's arithmetic does not share, so the last bit can differ. The click is held
 * to 3: React Flow maps the pointer through `SVGPoint.matrixTransform`, which Chromium
 * computes in SINGLE precision (measured: a click that names graph x 511.84645 arrives
 * as 511.846435546875, a float32), so the quantisation is the browser's, not the map's.
 * Neither is a tolerance a defect can hide in — a missing zoom factor, a padding term or
 * an aspect-ratio drift shows up in the first decimal place.
 */
test.use({ viewport: APP_VIEWPORT });

const MAP = '[data-testid="rf__minimap"]';
const MAP_SVG = `${MAP} svg`;

/**
 * The viewport as the MAP draws it: the cut-out in its mask is the visible graph
 * rectangle, `M x,y h width v height`, written by React Flow from its own transform at
 * full float precision. Not the `.react-flow__viewport` transform: Chromium re-serialises
 * a CSS `translate()` to six significant digits on read-back, which at a translate of a
 * thousand pixels is a hundredth of a pixel — far coarser than the arithmetic under test.
 */
async function viewport(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate((selector) => {
    const mask = document.querySelector<SVGPathElement>(`${selector} .react-flow__minimap-mask`);
    if (mask === null) throw new Error("no minimap mask");
    const d = mask.getAttribute("d") ?? "";
    const cutOut = d.slice(d.lastIndexOf("M"));
    const match = /^M([-\d.e+]+),([-\d.e+]+)h([-\d.e+]+)v([-\d.e+]+)/.exec(cutOut);
    if (match === null) throw new Error(`unexpected mask path: ${d}`);
    return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  }, MAP);
}

/** The zoom React Flow wrote — coarse (see `viewport`), but enough to see that it did not change. */
async function zoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (element === null) throw new Error("no react-flow viewport");
    return new DOMMatrix(getComputedStyle(element).transform).a;
  });
}

interface MapGeometry {
  /** The SVG's box on screen. */
  box: { x: number; y: number; width: number; height: number };
  /** The graph rectangle the SVG shows. */
  view: { x: number; y: number; width: number; height: number };
  /** Graph units per map pixel. */
  scale: number;
}

async function mapGeometry(page: Page): Promise<MapGeometry> {
  return page.evaluate((selector) => {
    const svg = document.querySelector<SVGSVGElement>(selector);
    if (svg === null) throw new Error("no minimap svg");
    const rect = svg.getBoundingClientRect();
    const parts = (svg.getAttribute("viewBox") ?? "").split(" ").map(Number);
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      throw new Error(`unexpected viewBox: ${svg.getAttribute("viewBox")}`);
    }
    const [x, y, width, height] = parts as [number, number, number, number];
    // The size is the stylesheet's `--minimap-width`/`--minimap-height` (T1257 owner
    // feedback: half of React Flow's default) — and the number React Flow was handed is
    // the number on screen, or the viewBox below would be describing a different map.
    const host = svg.closest<HTMLElement>('[data-testid="graph-canvas"] > :not(.react-flow)');
    if (host === null) throw new Error("no minimap host");
    const declared = {
      width: Number.parseFloat(getComputedStyle(host).getPropertyValue("--minimap-width")),
      height: Number.parseFloat(getComputedStyle(host).getPropertyValue("--minimap-height")),
    };
    if (declared.width !== rect.width || declared.height !== rect.height) {
      throw new Error(`the map is ${rect.width}×${rect.height} but CSS declares ${declared.width}×${declared.height}`);
    }
    return {
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      view: { x, y, width, height },
      scale: width / rect.width,
    };
  }, MAP_SVG);
}

/** Two nodes far apart, framed, so the map shows a graph rather than just the viewport. */
async function openWithGraph(page: Page): Promise<void> {
  await openApp(page);
  await addNode(page, "generator", "Noise");
  const second = await addNode(page, "generator", "Solid");
  await fitAll(page);
  await moveNode(page, second, 400, 250);
  await fitAll(page);
  await expect(page.locator(MAP)).toBeVisible();
}

test("dragging the map pans the viewport by exactly the drag over the map's scale", async ({ page }) => {
  await openWithGraph(page);

  const map = await mapGeometry(page);
  // With no padding the viewBox and the element agree on BOTH axes — the one fact that
  // makes "graph units per map pixel" a single number rather than two.
  expect(map.view.height / map.box.height).toBeCloseTo(map.scale, 6);

  const before = await viewport(page);
  const zoomBefore = await zoom(page);
  const at = { x: Math.round(map.box.x + map.box.width / 2), y: Math.round(map.box.y + map.box.height / 2) };
  const DRAG = { x: 30, y: -20 } as const;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  // One move: React Flow reads the scale once per move event, and the viewBox changes
  // under the drag as the viewport rectangle moves — a single step is the one gesture
  // whose scale is the one read above.
  await page.mouse.move(at.x + DRAG.x, at.y + DRAG.y, { steps: 1 });
  await page.mouse.up();
  await viewportSettled(page);

  const after = await viewport(page);
  expect(await zoom(page), "a drag on the map must not change the zoom").toBe(zoomBefore);
  // The visible rectangle moved by the drag over the map's scale — it followed the
  // pointer 1:1 across the map.
  expect(after.x - before.x).toBeCloseTo(DRAG.x * map.scale, 9);
  expect(after.y - before.y).toBeCloseTo(DRAG.y * map.scale, 9);
  // Non-vacuity: the camera really moved — by more than a screen pixel.
  expect(Math.abs(after.x - before.x) * zoomBefore).toBeGreaterThan(1);
});

test("clicking the map puts the clicked graph point at the canvas centre, zoom kept", async ({ page }) => {
  await openWithGraph(page);

  const map = await mapGeometry(page);
  const zoomBefore = await zoom(page);
  // Off-centre on purpose, so a jump to the map's middle would not pass; integer client
  // coordinates, so the point the browser delivers is the point computed here.
  const at = { x: Math.round(map.box.x) + 41, y: Math.round(map.box.y) + 23 };
  const target = {
    x: map.view.x + (at.x - map.box.x) * map.scale,
    y: map.view.y + (at.y - map.box.y) * map.scale,
  };
  await page.mouse.click(at.x, at.y);
  await viewportSettled(page);

  expect(await zoom(page)).toBe(zoomBefore);
  const after = await viewport(page);
  const centre = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
  expect(centre.x).toBeCloseTo(target.x, 3);
  expect(centre.y).toBeCloseTo(target.y, 3);

  // Two quick jumps are two jumps — not the canvas's double-click, which opens the node
  // browser under the map.
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.getByTestId("node-search")).toHaveCount(0);
});

test("`o` hides the map through view.toggleMinimap, and the choice survives a reload", async ({ page }) => {
  await openWithGraph(page);
  await focusGraph(page);

  await page.keyboard.press("o");
  await expect(page.locator(MAP)).toHaveCount(0);

  // Per person, persisted: a hidden map that comes back on reload is a setting that
  // does not work. The same key the command wrote is what the boot reads.
  await page.reload();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.locator(MAP)).toHaveCount(0);

  await focusGraph(page);
  await page.keyboard.press("o");
  await expect(page.locator(MAP)).toBeVisible();
});
