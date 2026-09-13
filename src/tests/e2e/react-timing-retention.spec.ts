import { expect, test } from "@playwright/test";

test("development timing cleanup preserves custom entries and recorded DevTools events", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("project-open")).toBeVisible();
  // Exercise the installed React build, not only a fabricated tag. A dependency
  // upgrade that changes its track metadata must not silently bypass retention.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType("measure").length)).toBe(0);
  const cdp = await page.context().newCDPSession(page);
  const events: Array<Record<string, unknown>> = [];
  cdp.on("Tracing.dataCollected", data => events.push(...data.value));
  await cdp.send("Tracing.start", { categories: "blink.user_timing", transferMode: "ReportEvents" });
  await page.evaluate(() => {
    performance.measure("loom-timing-collision", { start: 0, duration: 1, detail: { custom: true } });
    performance.measure("loom-timing-collision", { start: 0, duration: 1, detail: { devtools: { track: "Components ⚛" } } });
    performance.measure("loom-react-timing-probe", { start: 0, duration: 1, detail: { devtools: { track: "Components ⚛" } } });
  });
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName("loom-react-timing-probe", "measure").length)).toBe(0);
  expect(await page.evaluate(() => performance.getEntriesByName("loom-timing-collision", "measure").length)).toBe(2);
  const done = new Promise<void>(resolve => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.end"); await done;
  expect(events.some(event => event.name === "loom-react-timing-probe")).toBe(true);
  await cdp.detach();
});
