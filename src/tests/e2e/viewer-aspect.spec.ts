import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APP_VIEWPORT, addNode, connect, fitAll, moveNode, openApp } from "./app.ts";

/**
 * T1158 — the viewer shows the PROJECT'S aspect, measured on the glass.
 *
 * ## The report, and why every other surface looked fine
 *
 * The owner set a 720×1280 portrait project: "it shows the resolution correctly everywhere
 * and all the previews are looking good, but the viewer itself is set to fit basically —
 * and even if I crunch it down, it's gonna stay in the initial 16:9 aspect ratio." The
 * viewer's frame was pinned at `aspect-ratio: 16 / 9` in `panes.module.css` and the canvas
 * filled it, so the present blit STRETCHED the output across a shape the project had never
 * asked for. Node tiles have letterboxed since §V118, which is exactly why the numbers, the
 * readouts and the tiles were all correct while the one big picture was wrong.
 *
 * ## Why this lane, and why the canvas rather than a style
 *
 * `chromium-headed-gpu` is the only project with a real WebGPU adapter (§V895), and this
 * assertion is about LAYOUT under a live presentation: the canvas has to be the picture the
 * compositor draws, sized by the same `ResizeObserver`/`fitInsideRegion` path the product
 * runs, with a backend actually blitting into it. So the numbers here come from
 * `boundingBox()` and from the canvas's own backing store — never from the inline style
 * that produced them, which would only restate the code back to itself.
 *
 * ## The fixture, pinned (§V906)
 *
 * 720×1280 written down here, not read from the app's defaults. It is portrait, its aspect
 * (0.5625) is the exact reciprocal of the 16:9 the frame used to force, and the landscape
 * control below uses the same two numbers the other way round — so an implementation that
 * ignored the output and kept ANY constant shape fails one of the two cases whichever
 * constant it picked.
 */

test.use({ viewport: APP_VIEWPORT });

const PORTRAIT = { width: 720, height: 1280 } as const;
const LANDSCAPE = { width: 1280, height: 720 } as const;

/** The pane is a few hundred px; a picture that fits inside it lands on fractional CSS px. */
const ASPECT_TOLERANCE = 0.02;

async function typeInto(page: Page, label: string, value: string): Promise<void> {
  const field = page.locator(`input[aria-label="${label}"]`);
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.fill(value);
  await field.press("Enter");
}

/** Sets the project resolution through the real dialog, and waits for the plan to carry it. */
async function setProjectResolution(
  page: Page,
  size: { readonly width: number; readonly height: number },
): Promise<void> {
  await page.getByRole("button", { name: "Project settings" }).click();
  await typeInto(page, "width", String(size.width));
  await typeInto(page, "height", String(size.height));
  // The settings dialog is MODAL — its overlay swallows every pointer event while open.
  await page.keyboard.press("Escape");
  await expect(page.locator('input[aria-label="width"]')).toHaveCount(0);
  // The edit must have APPLIED, or this measures the previous project's shape.
  await expect(
    page.getByRole("tabpanel", { name: "viewer" }).locator('dl[aria-label="Resolved output"]'),
  ).toContainText(`${size.width} × ${size.height}`, { timeout: 10_000 });
}

interface Measured {
  /** The canvas's CSS box, from `getBoundingClientRect` — what the compositor draws. */
  readonly box: { readonly width: number; readonly height: number };
  /** The backing store the runtime blits into, in device pixels. */
  readonly store: { readonly width: number; readonly height: number };
  /** The frame the picture has to fit inside. */
  readonly frame: { readonly width: number; readonly height: number };
}

async function measure(page: Page): Promise<Measured> {
  const canvas = page.getByTestId("viewer-canvas");
  const surface = page.getByTestId("viewer-surface");
  const box = await canvas.boundingBox();
  const frame = await surface.boundingBox();
  if (box === null || frame === null) throw new Error("the viewer canvas is not laid out");
  const store = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }));
  return { box: { width: box.width, height: box.height }, store, frame: { width: frame.width, height: frame.height } };
}

/** Checker → Output, built through the real UI, so the viewer has a declared sink. */
async function buildPicture(page: Page): Promise<void> {
  const checker = await addNode(page, "generator", "Checker");
  const output = await addNode(page, "output", "Output");
  await fitAll(page);
  await moveNode(page, output, 260, 240);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await connect(page, { nodeId: checker, portId: "out" }, { nodeId: output, portId: "input" });
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 2000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
  // A picture is only on the glass once the runtime has actually presented into it.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const probe = (
            window as unknown as {
              loomViewerProbe?: () => Promise<{
                presentation: { presentedFrames: number; sourceBound: boolean } | null;
              }>;
            }
          ).loomViewerProbe;
          const presentation = (await probe?.())?.presentation ?? null;
          return presentation !== null && presentation.sourceBound && presentation.presentedFrames > 0;
        }),
      { message: "the runtime never presented a frame into the viewer canvas" },
    )
    .toBe(true);
}

test("the viewer letterboxes the project's aspect instead of stretching to the pane", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);
  await buildPicture(page);

  /*
   * THE CONTROL, FIRST, and it is what makes the portrait case mean something: at 1280×720
   * the picture is landscape. A build that had simply swapped one hardcoded constant for
   * another would pass exactly one of these two, and this is the one it would pass.
   */
  await setProjectResolution(page, LANDSCAPE);
  await expect
    .poll(async () => {
      const { box } = await measure(page);
      return box.width > box.height;
    }, { message: "a 1280x720 project did not produce a landscape picture" })
    .toBe(true);
  const landscape = await measure(page);
  expect(
    Math.abs(landscape.box.width / landscape.box.height - LANDSCAPE.width / LANDSCAPE.height),
  ).toBeLessThan(ASPECT_TOLERANCE);

  await setProjectResolution(page, PORTRAIT);

  // The layout follows the resolution asynchronously (compile, then the ResizeObserver).
  await expect
    .poll(async () => {
      const { box } = await measure(page);
      return box.height > box.width;
    }, { message: "a 720x1280 project still showed a picture wider than it is tall" })
    .toBe(true);

  const portrait = await measure(page);

  /*
   * IT IS LETTERBOXED, NOT OVERFLOWING. "Portrait" alone would be satisfied by a canvas
   * that simply took the project's aspect and ran off the bottom of the pane; the whole
   * point is that the picture FITS the frame the way a node tile fits its slot (§V118).
   * A fraction of a pixel of rounding is allowed, a bar of it is not.
   */
  expect(portrait.box.width).toBeLessThanOrEqual(portrait.frame.width + 1);
  expect(portrait.box.height).toBeLessThanOrEqual(portrait.frame.height + 1);
  // And it FILLS one axis of the frame — a fit that is merely small is not a fit.
  expect(
    Math.max(
      portrait.box.width / portrait.frame.width,
      portrait.box.height / portrait.frame.height,
    ),
  ).toBeGreaterThan(0.98);

  /*
   * THE BACKING STORE AGREES. The runtime blits into `canvas.width/height`, so if the store
   * kept the old shape the picture would be resampled back into a wrong aspect even with a
   * correctly shaped CSS box. This is the number the GPU actually writes.
   */
  expect(portrait.store.width).toBeLessThan(portrait.store.height);

  /*
   * THE CLAIM, LAST (§V910): the picture on the glass has the PROJECT'S aspect. Not "it is
   * portrait" — 0.5625, the ratio the owner set, which the 16:9 frame could never produce.
   */
  expect(
    Math.abs(portrait.box.width / portrait.box.height - PORTRAIT.width / PORTRAIT.height),
  ).toBeLessThan(ASPECT_TOLERANCE);
});
