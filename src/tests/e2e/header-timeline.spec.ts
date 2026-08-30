import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { APP_VIEWPORT } from "./app.ts";

/**
 * T433 — THE HEADER DOES NOT GET TALLER (§V339).
 *
 * This spec exists because the owner's constraint is GEOMETRIC and jsdom paints nothing.
 * "The timeline sits WITH the transport and the readouts, not above or below them" cannot
 * be asserted in a DOM-existence test: §B54 lived in the DOM with a real client rect and
 * rendered zero pixels for months, with a green presence test the whole time. So the
 * claims are measured here, in real Chromium, with `boundingBox()`.
 *
 * `timeline-scrubber.test.tsx` carries the arithmetic and the commands; this carries the
 * pixels, and neither pretends to be the other.
 *
 * ## What this CANNOT show
 *
 * There is no WebGPU in Playwright's Chromium here (see `app.ts`), so no frame is ever
 * rendered: the playhead does not move, and nothing about SEEKING, looping or rendering
 * the range out is observable. Those need a device. What is observable — and what the
 * owner's constraint is actually about — is where the strip is and how tall the bar is.
 */

/** The header's fixed grid row. A timeline that needed a band of its own would change it. */
const TOPBAR_HEIGHT = 32;

async function openShell(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible();
  const rect = await locator.boundingBox();
  expect(rect, "the element has no box at all").not.toBeNull();
  return rect as { x: number; y: number; width: number; height: number };
}

test.use({ viewport: { width: APP_VIEWPORT.width, height: APP_VIEWPORT.height } });

test.describe("T433 — the timeline lives in the header's existing row", () => {
  test("the header is still one 32px bar", async ({ page }) => {
    await openShell(page);
    const header = await box(page.locator("header").first());
    // The owner's hard constraint, as a number. A strip that wrapped, or a control taller
    // than the row, would push this past 32 or clip — and only a browser can tell.
    expect(header.height).toBe(TOPBAR_HEIGHT);
  });

  test("the scrubber is PAINTED, with real width, inside the bar", async ({ page }) => {
    await openShell(page);
    const header = await box(page.locator("header").first());
    const timeline = await box(page.getByRole("group", { name: "Timeline", exact: true }));

    // §B54's shape: in the DOM, zero pixels. A track narrower than this is not a timeline.
    expect(timeline.width).toBeGreaterThan(120);
    expect(timeline.height).toBeGreaterThan(8);

    // Inside the bar, top and bottom. Not above it, not below it, not overflowing it.
    expect(timeline.y).toBeGreaterThanOrEqual(header.y - 1);
    expect(timeline.y + timeline.height).toBeLessThanOrEqual(header.y + header.height + 1);
  });

  test("it sits BETWEEN the transport and the readouts, on the same row", async ({ page }) => {
    await openShell(page);
    const transport = await box(page.getByRole("group", { name: "Transport" }));
    const timeline = await box(page.getByRole("group", { name: "Timeline", exact: true }));
    const frame = await box(page.getByRole("textbox", { name: "Frame", exact: true }));

    // Left to right: transport, then the timeline, then the numeric readouts.
    expect(timeline.x).toBeGreaterThanOrEqual(transport.x + transport.width - 1);
    expect(frame.x).toBeGreaterThanOrEqual(timeline.x + timeline.width - 1);

    // And all three share the row — vertical centres within a few pixels of each other.
    const centre = (rect: { y: number; height: number }): number => rect.y + rect.height / 2;
    expect(Math.abs(centre(timeline) - centre(transport))).toBeLessThan(4);
    expect(Math.abs(centre(frame) - centre(transport))).toBeLessThan(4);
  });

  test("the timeline gives its space back before the readouts do", async ({ page }) => {
    await openShell(page);
    const wide = await box(page.getByRole("group", { name: "Timeline", exact: true }));

    await page.setViewportSize({ width: 1100, height: APP_VIEWPORT.height });
    const header = await box(page.locator("header").first());
    const narrow = await box(page.getByRole("group", { name: "Timeline", exact: true }));

    // The strip is the header's one growable element, so it is what shrinks — and the
    // bar is still one row, which is the claim that matters when space runs out.
    expect(narrow.width).toBeLessThan(wide.width);
    expect(header.height).toBe(TOPBAR_HEIGHT);
    // Still painted rather than collapsed to nothing.
    expect(narrow.width).toBeGreaterThan(80);
  });
});
