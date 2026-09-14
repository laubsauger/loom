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

/**
 * T1340b — THE COLOUR CODING, measured in a real browser.
 *
 * Owner: *"make up clear and concise CATEGORIES and then give them a COLOR CODING so that
 * it becomes clear like 'hey we need this shit here'."* The hue is a CSS var keyed off
 * `data-category`, so jsdom — which resolves no custom properties and lays out no flex —
 * cannot tell a working tint from a missing one. It could not tell before, either: the
 * class these badges asked for (`styles.requirementTag`) did not exist in the stylesheet,
 * so `undefined` reached `className` and the seven tags rendered in the badge's default
 * grey while every comment still called them warning-tinted.
 */
test("each requirement category is a distinct colour, and the unsatisfiable one is not one of them", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "examples", exact: true }).click();
  const colourOf = async (rowName: string, label: string) => {
    const row = page.getByRole("button", { name: new RegExp(`^${rowName}`) });
    await row.scrollIntoViewIfNeeded();
    const badge = row.getByText(label, { exact: true });
    await expect(badge).toBeVisible();
    return badge.evaluate(element => getComputedStyle(element).color);
  };
  const host = await colourOf("E71 Syphon Loopback", "Desktop only");
  const platform = await colourOf("E71 Syphon Loopback", "macOS");
  const external = await colourOf("E72 NDI Loopback", "NDI SDK");
  const unsupported = await colourOf("E74 Spout Loopback Preparation", "Not implemented");
  // Three actionable hues the reader can learn, all different from each other.
  expect(new Set([host, platform, external]).size).toBe(3);
  // ⚑ AND THE ONE NOBODY CAN ACT ON IS NOT DRESSED AS ONE OF THEM. Painting "Not
  // implemented" like "Desktop only" sends the reader to find a Windows machine that
  // cannot help — a lie they act on.
  expect(unsupported).not.toBe(host);
  expect(unsupported).not.toBe(platform);
  expect(unsupported).not.toBe(external);
  // The same tag is the same colour wherever it appears: one vocabulary, not one per pane.
  expect(await colourOf("E73 Native Person Mask", "Desktop only")).toBe(host);
  expect(await colourOf("E74 Spout Loopback Preparation", "Windows")).toBe(platform);
});

/**
 * T1340b — THE NODE ITSELF CARRIES THE WARNING, in a real browser, in the chrome every
 * other problem already uses.
 *
 * Owner: *"ideally THE NODE ITSELF would also be highlighted as if there's a warning on it,
 * with the usual warning text exposed ON THE NODE as we do with all other kinds of warnings
 * and errors."*
 *
 * ⚑ THE DEFECT'S OWN SIGNATURE: a Syphon graph opened in a browser tab showed a perfectly
 * clean node. The library row knew the file needed macOS and the desktop app, the inspector
 * said so in grey under a disabled dropdown, and the node — the thing you are looking at —
 * said nothing at all. This runs in Chromium, which IS a browser tab with no `loomDesktop`,
 * so the host fact under test is the real one rather than a fake.
 */
test("a Syphon node opened in a browser tab carries the warning on the node", async ({ page }, testInfo) => {
  await openApp(page);
  await page.getByRole("tab", { name: "examples", exact: true }).click();
  const row = page.getByRole("button", { name: /^E71 Syphon Loopback/ });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  // The warning rides the node's ordinary message line — the same element a compiler
  // diagnostic uses — so finding it there is what makes it the SAME chrome and not a
  // lookalike built beside it.
  const warning = page.locator(".react-flow__node").getByText(/Syphon In cannot run on this machine/);
  await expect(warning.first()).toBeVisible();
  // And it is COUNTED as a warning everywhere warnings are counted: the dock's tally is a
  // different derivation from a different array, so agreement here is the claim that the
  // node badge and the panel cannot disagree.
  // …and the SAME warning is in the problems pane, which is a different derivation over a
  // different array. Agreement here is the whole claim: a node badge that says one and a
  // panel that says none teaches the user to trust whichever they saw first.
  await page.getByRole("tab", { name: /problems/ }).click();
  await expect(page.getByRole("tabpanel", { name: "problems" }))
    .toContainText(/Syphon In cannot run on this machine/);
  await page.screenshot({ path: testInfo.outputPath("syphon-node-warning.png") });
});

/**
 * T1341b — WHERE THE MARK GOES IS A §V1016 QUESTION, AND THE ROW HAS A TRAP IN IT.
 *
 * `.exampleRow` is a three-track grid whose every cell pins `grid-row: 1`, because grid
 * auto-placement is SPARSE: a new cell that names a column and no row lands on row TWO, and
 * the list reads as two lines again (§T1278, fixed the same night). The mark is deliberately
 * NOT a grid item — it is a flex child of the badge strip, which is already one pinned cell
 * — and this is what proves that rather than asserting it in a comment: the mark's top must
 * line up with the title's, at every width, and the row must never scroll sideways.
 *
 * jsdom lays out no grid and no flex, so none of this is knowable on the test ladder, and a
 * screenshot at ONE width cannot distinguish a fix from a non-fix.
 */
test("the run-here mark shares the title's row and never widens it, across a width sweep", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "examples", exact: true }).click();
  const report: string[] = [];
  for (const width of [1440, 1280, 1100, 960, 820]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["E71 Syphon Loopback", "E72 NDI Loopback", "E74 Spout Loopback Preparation"]) {
      const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
      await row.scrollIntoViewIfNeeded();
      const measured = await row.evaluate((element) => {
        const mark = element.querySelector<HTMLElement>('[role="img"]');
        const title = element.firstElementChild as HTMLElement;
        return {
          overflow: element.scrollWidth - element.clientWidth,
          markTop: mark?.getBoundingClientRect().top ?? null,
          titleTop: title.getBoundingClientRect().top,
          rowHeight: element.getBoundingClientRect().height,
        };
      });
      report.push(`${width}px ${name}: overflow ${measured.overflow}px, height ${Math.round(measured.rowHeight)}px`);
      // The mark exists on all three of these — every one declares something a browser tab
      // cannot satisfy — so a null here is the mark having gone missing, not a pass.
      expect(measured.markTop, `${name} at ${width}px has no mark`).not.toBeNull();
      // ONE LINE: the mark's box overlaps the title's, which a row-two cell cannot do.
      expect(Math.abs(measured.markTop! - measured.titleTop), `${name} at ${width}px`).toBeLessThan(14);
      expect(measured.overflow, `${name} at ${width}px`).toBeLessThanOrEqual(1);
    }
  }
  console.log(report.join("\n"));
});
