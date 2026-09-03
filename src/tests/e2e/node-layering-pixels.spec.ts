import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APP_VIEWPORT, addNode, fitAll, moveNode, openApp } from "./app.ts";

/**
 * T1102 — WHOSE PIXELS ARE ON TOP WHERE TWO NODES OVERLAP.
 *
 * Runs in the `chromium-headed-gpu` project only, for the reason
 * `presentation-pixels.spec.ts` sets out at length: headless Chromium on this machine
 * resolves no WebGPU adapter, so a preview tile there is not a picture and nothing in this
 * file could be measured. That spec solved the geometry, the screenshot read and the
 * exact-value discipline; this one reuses the shape and asserts a different claim, so the
 * two live side by side rather than one growing a second subject.
 *
 * ## Why this needs pixels at all
 *
 * The bug was never a z-index bug. Node CHROME is DOM and stacks by React Flow's
 * z-index; EVERY preview pixel in a pane comes from one shared canvas that sits at a
 * single depth in the page (§V106). Two stacking systems that cannot see each other, so a
 * node's preview painted over the node the browser had drawn in front of it. Every seam
 * below the glass can be green — the request carries a clip, the composite carries a
 * scissor — and the user still sees the wrong node on top. That is the §V628 shape, and
 * the only instrument for it is the compositor's own output.
 *
 * ## Why the two pictures are Checker and Solid, and why the claim is exact
 *
 * Checker's defaults are BLACK and WHITE and Solid's default is opaque BLACK, so the
 * question "whose preview is in this region" has a two-valued answer in bytes: a region
 * showing the Checker contains pure white (255,255,255) somewhere, and a region showing
 * the Solid contains none anywhere. 0 and 255 are fixed points of the sRGB encode, of
 * 8-bit quantisation, of premultiplication at alpha 1 and of any display profile a headed
 * screenshot picks up (`presentation-pixels.spec.ts` derives each of those), so no
 * tolerance band is involved and none is allowed (§V147).
 *
 * White is the SIGNAL and black is the background here, deliberately: "no white in the
 * overlap" alone would also be true of a canvas that never painted, so every assertion of
 * that form below is paired with a control on the same screenshot — the Checker's exposed
 * half, which must be showing white at the same moment.
 *
 * ## What the three phases separate
 *
 *  1. Solid dragged over Checker: the drag SELECTS the Solid, React Flow elevates a
 *     selected node, so the Solid is in front — the overlap must be its black.
 *  2. Click the Checker: selection moves, elevation moves, the overlap must flip to
 *     Checker white with no document edit at all. This is the derived half.
 *  3. Press `]` (`node.bringToFront`) and then DESELECT: the elevation that was carrying
 *     phase 2 is gone, so if the arrangement survives it is because it was written to the
 *     document. This is the half that a view-state implementation cannot pass, and it is
 *     the assertion behind "place nodes above others" meaning something after a reload.
 */

test.use({ viewport: APP_VIEWPORT });

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A node's preview slot in viewport coordinates — the box its picture is drawn into. */
async function previewBox(page: Page, nodeId: string): Promise<Rect> {
  const slot = page.getByTestId(`node-preview-${nodeId}`);
  // React Flow re-renders the node on selection and on drag commit, so a box read taken
  // across one of those transitions can come back null on a detached element. Waiting for
  // visibility first is the difference between a measurement and a race.
  await expect(slot).toBeVisible();
  const box = await slot.boundingBox();
  if (box === null) throw new Error(`node "${nodeId}" has no preview slot on screen`);
  return box;
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Samples a grid of pixels inside `region` from a screenshot of the graph pane.
 *
 * The read is a compositor screenshot decoded through a lossless PNG round-trip, not
 * `drawImage` on the WebGPU canvas: measured on this Chromium, that reads all-zero
 * through a healthy canvas (§V897, and `presentation-pixels.spec.ts`'s docblock).
 *
 * Coordinates arrive as viewport CSS px and are rebased onto the pane's own box and scaled
 * by the screenshot's device ratio, so the caller never has to know either.
 */
async function sampleGrid(
  page: Page,
  region: Rect,
  steps = 11,
): Promise<ReadonlyArray<ReadonlyArray<number>>> {
  const pane = page.getByTestId("graph-canvas");
  const paneBox = await pane.boundingBox();
  if (paneBox === null) throw new Error("the graph pane has no box on screen");
  const shot = await pane.screenshot();
  const local = {
    x: region.x - paneBox.x,
    y: region.y - paneBox.y,
    width: region.width,
    height: region.height,
  };
  return page.evaluate(
    async ({ base64, local, paneBox, steps }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const copy = document.createElement("canvas");
      copy.width = image.naturalWidth;
      copy.height = image.naturalHeight;
      const ctx = copy.getContext("2d", { willReadFrequently: true });
      if (ctx === null) return [];
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
      const scale = copy.width / paneBox.width;
      const samples: number[][] = [];
      for (let row = 1; row < steps; row += 1) {
        for (let col = 1; col < steps; col += 1) {
          const x = Math.round((local.x + (local.width * col) / steps) * scale);
          const y = Math.round((local.y + (local.height * row) / steps) * scale);
          if (x < 0 || y < 0 || x >= copy.width || y >= copy.height) continue;
          const base = (y * copy.width + x) * 4;
          samples.push([data[base] ?? -1, data[base + 1] ?? -1, data[base + 2] ?? -1]);
        }
      }
      return samples;
    },
    { base64: shot.toString("base64"), local, paneBox, steps },
  );
}

const isWhite = (pixel: ReadonlyArray<number>): boolean =>
  pixel[0] === 255 && pixel[1] === 255 && pixel[2] === 255;

/** How many of the sampled pixels are the Checker's white — the "is this Checker" number. */
const whiteCount = (samples: ReadonlyArray<ReadonlyArray<number>>): number =>
  samples.filter(isWhite).length;

test("the node in front owns the overlap, and the arrangement survives deselection", async ({
  page,
}) => {
  await openApp(page);

  const checker = await addNode(page, "generator", "Checker");
  const solid = await addNode(page, "generator", "Solid");
  await fitAll(page);

  // Drag the Solid so its preview covers roughly the right half of the Checker's. Both
  // slots are the same size (same default node size, same square source), so half of one
  // slot's width is the offset that produces a half-and-half overlap.
  const checkerSlot = await previewBox(page, checker);
  const solidSlot = await previewBox(page, solid);
  await moveNode(
    page,
    solid,
    Math.round(checkerSlot.x + checkerSlot.width / 2 - solidSlot.x),
    Math.round(checkerSlot.y - solidSlot.y),
  );

  const overlap = intersect(await previewBox(page, checker), await previewBox(page, solid));
  expect(
    Math.min(overlap.width, overlap.height),
    "the drag did not produce an overlap to measure — the rest of this spec is vacuous",
  ).toBeGreaterThan(40);
  // The Checker's exposed half: the control every "no white" assertion below is paired
  // with, so a canvas that simply never painted cannot pass as a correct occlusion.
  const exposed = {
    ...checkerSlot,
    width: Math.max(1, overlap.x - checkerSlot.x - 4),
  };

  // The previews are live once the Checker's exposed half is showing its white squares.
  // Polled rather than waited on: first paint is a compile plus a scheduler round trip.
  await expect
    .poll(async () => whiteCount(await sampleGrid(page, exposed)), {
      message: "the Checker's preview never reached the glass — nothing below is measurable",
      timeout: 20000,
    })
    .toBeGreaterThan(0);

  // PHASE 1 — the Solid was just dragged, so it is selected, so React Flow drew it in
  // front. Its preview must own the overlap: before T1102 the tile order was independent
  // of the DOM's and the Checker painted straight over the node on top of it.
  await expect
    .poll(async () => whiteCount(await sampleGrid(page, overlap)), {
      message: "the front node's black preview does not own the overlap — the tile behind it is painting through",
      timeout: 10000,
    })
    .toBe(0);
  expect(
    whiteCount(await sampleGrid(page, exposed)),
    "control: the Checker must still be showing white outside the overlap",
  ).toBeGreaterThan(0);

  // PHASE 2 — select the Checker. Nothing about the document changes; only which node
  // React Flow elevates. The pixels in the overlap must follow.
  // Aimed at the Checker's own top-left corner rather than its centre: the centre is
  // inside the overlap, where the node in front legitimately intercepts the pointer, and
  // Playwright would retry the click for the full timeout without ever landing it.
  await page.getByTestId(`node-${checker}`).click({ position: { x: 12, y: 8 } });
  await expect
    .poll(async () => whiteCount(await sampleGrid(page, overlap)), {
      message: "selecting the back node did not bring its preview forward",
      timeout: 10000,
    })
    .toBeGreaterThan(0);

  // PHASE 3 — persist the arrangement, then take the selection away. `]` is
  // `node.bringToFront`, which writes `ui.z`; the click on empty canvas removes the
  // elevation that was doing the work in phase 2. If the Checker stays in front now, it
  // is because the order is in the document — which is what surviving a reload means.
  await page.keyboard.press("]");
  const paneBox = await page.getByTestId("graph-canvas").boundingBox();
  if (paneBox === null) throw new Error("the graph pane has no box on screen");
  await page.mouse.click(paneBox.x + 20, paneBox.y + paneBox.height - 20);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

  await expect
    .poll(async () => whiteCount(await sampleGrid(page, overlap)), {
      message:
        "the stacking order did not survive deselection — it is view state, not a placement",
      timeout: 10000,
    })
    .toBeGreaterThan(0);
});
