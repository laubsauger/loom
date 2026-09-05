import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APP_VIEWPORT, addNode, fitAll, openApp } from "./app.ts";

/**
 * T1168 — A VALUE NODE'S BODY IS THE SAME HEIGHT IN A PORTRAIT PROJECT, MEASURED.
 *
 * ## The report
 *
 * The owner, on E56 Vesper once it was authored 720x1280: "somehow the value / audio nodes
 * in Vesper are super tall and stretched. Don't get why that is. Lots of empty space in
 * them now." Every node reserved a preview slot shaped to the PROJECT's aspect (T668,
 * `--preview-aspect`), and the 22 node types that publish value channels have no picture to
 * put in one — they draw a plot, which is plain DOM of its own size. MEASURED before the
 * fix: an LFO body 148px at 1280x720 and 362px at 720x1280, with the curve inside it 78px
 * either way. 43 of the 44 shipped examples are 16:9 and the rest are square, so this was
 * latent from T344 until the first portrait document existed (T1159).
 *
 * ## What is asserted, and why it is a geometry claim rather than a style one
 *
 * `offsetHeight` off the rendered node — the same measurement `node-box.spec.ts` takes, and
 * for the same reason: React Flow scales the viewport with a CSS transform, so a bounding
 * box is screen pixels at whatever zoom the fit landed on while the offset pair is the
 * node's own graph-space box. Reading `--preview-aspect` back, or the `.plotSlot` class,
 * would only restate the fix to itself; the claim is the height the user sees.
 *
 * ## Why the headless lane
 *
 * This is chrome layout, not pixels: a node's body is the same size whether or not its
 * preview ever receives a frame (`app.ts` on what this lane has — `navigator.gpu` present,
 * no adapter). `node-box.spec.ts` gates the whole size model here for exactly that reason,
 * and the value plot draws its curve from the definition with no device at all. The headed
 * lane's window and its own vite buy nothing here.
 *
 * ## The fixture, pinned (§V906)
 *
 * 720x1280 and 1280x720 written down here, never the app's current default: the claim is
 * about a portrait document specifically, and a default that moved would quietly turn this
 * into a test of nothing. The landscape pass is the CONTROL and it runs first.
 */

test.use({ viewport: APP_VIEWPORT });

const LANDSCAPE = { width: 1280, height: 720 } as const;
const PORTRAIT = { width: 720, height: 1280 } as const;

/** A slot fitted inside a node lands on fractional CSS px; the aspect is not fractional. */
const ASPECT_TOLERANCE = 0.02;

async function typeInto(page: Page, label: string, value: string): Promise<void> {
  const field = page.locator(`input[aria-label="${label}"]`);
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await field.fill(value);
  await field.press("Enter");
}

/** Sets the project resolution through the real dialog — the same path the owner drove. */
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
}

/** Every rendered node's own graph-space height, keyed by id. */
function bodyHeights(page: Page): Promise<Record<string, number>> {
  return page.$$eval(".react-flow__node", (nodes) =>
    Object.fromEntries(
      nodes.map((node) => [
        node.getAttribute("data-id") ?? "?",
        (node as HTMLElement).offsetHeight,
      ]),
    ),
  );
}

async function slotAspect(page: Page, nodeId: string): Promise<number> {
  // The CONTENT box, which is the box the ratio governs and the tile is fitted into: since
  // T540 `.preview` is `content-box`, so the hairline below it is outside the ratio and
  // `offsetHeight` would report 16:(9 + hairline).
  return await page.getByTestId(`node-preview-${nodeId}`).evaluate((slot) => {
    const box = slot as HTMLElement;
    return box.clientWidth / box.clientHeight;
  });
}

test("a value node's body does not follow the project's aspect; a texture node's does", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openApp(page);

  // An LFO is the archetype the owner named. ANALYZE is the case a naive fix breaks: it is
  // a declared sink AND publishes channels, and `renderPreview` gives it the plot, so the
  // slot has to follow the plot branch rather than the sink branch. CHECKER is the control
  // — a real texture output, which must keep following the project.
  const lfo = await addNode(page, "value", "LFO");
  const analyze = await addNode(page, "value", "Analyze");
  const checker = await addNode(page, "generator", "Checker");
  await fitAll(page);

  await setProjectResolution(page, LANDSCAPE);
  await expect
    .poll(async () => (await slotAspect(page, checker)).toFixed(2), {
      message: "the 1280x720 project never reached the node preview slots",
    })
    .toBe((LANDSCAPE.width / LANDSCAPE.height).toFixed(2));
  const landscape = await bodyHeights(page);

  await setProjectResolution(page, PORTRAIT);

  /*
   * THE CONTROL, and it is what makes the claim below mean anything: a TEXTURE slot still
   * takes the project's shape (T668 — the owner's decision, and this must not become the
   * fix). Deleting `--preview-aspect` altogether would satisfy "the value node did not
   * change" perfectly and fail right here.
   */
  await expect
    .poll(async () => (await slotAspect(page, checker)).toFixed(2), {
      message: "a 720x1280 project did not reshape the texture node's preview slot",
    })
    .toBe((PORTRAIT.width / PORTRAIT.height).toFixed(2));
  const portrait = await bodyHeights(page);
  expect(
    Math.abs((await slotAspect(page, checker)) - PORTRAIT.width / PORTRAIT.height),
  ).toBeLessThan(ASPECT_TOLERANCE);
  // And the control node's BODY really did grow with it — hundreds of pixels, not rounding.
  expect(portrait[checker]).toBeGreaterThan((landscape[checker] ?? 0) + 100);

  /*
   * THE CLAIM, LAST (§V910): the nodes that draw a PLOT are the same height in the portrait
   * document as in the landscape one. Exact pixels, both nodes in one object so a failure
   * names each that drifted — "super tall and stretched, lots of empty space in them now"
   * is precisely this number moving.
   */
  expect({ lfo: portrait[lfo], analyze: portrait[analyze] }).toEqual({
    lfo: landscape[lfo],
    analyze: landscape[analyze],
  });
});
