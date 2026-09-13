import { expect, test } from "@playwright/test";
import { openApp } from "./app.ts";

test("example rows expose requirements and tags without overflowing the library", async ({ page }, testInfo) => {
  await openApp(page);
  await page.getByRole("tab", { name: "examples", exact: true }).click();
  for (const [name, requirements, tags] of [
    ["E52 Presence", ["Device helper", "macOS"], ["vision"]],
    ["E71 Syphon Loopback", ["Desktop only", "macOS"], ["video", "device"]],
    ["E72 NDI Loopback", ["Desktop only", "NDI SDK"], ["video", "device"]],
    ["E73 Native Person Mask", ["Desktop only", "Apple Silicon"], ["vision"]],
    ["E74 Spout Loopback Preparation", ["Desktop only", "Windows", "Not implemented"], ["video", "device"]],
  ] as const) {
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await row.scrollIntoViewIfNeeded();
    for (const label of [...requirements, ...tags]) await expect(row.getByText(label, { exact: true })).toBeVisible();
    const requirementColor = await row.getByText(requirements[0], { exact: true }).evaluate(element => getComputedStyle(element).color);
    const tagColor = await row.getByText(tags[0], { exact: true }).evaluate(element => getComputedStyle(element).color);
    expect(requirementColor).not.toBe(tagColor);
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    for (const badge of await row.locator('span[title]').all()) {
      const inside = await badge.evaluate(element => {
        const button = element.closest('button')!.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return bounds.left >= button.left && bounds.right <= button.right + 1;
      });
      expect(inside).toBe(true);
    }
  }
  await page.screenshot({ path: testInfo.outputPath("example-requirements.png") });
});
