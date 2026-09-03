import { expect, test } from "@playwright/test";

/**
 * T1051 — previews INSIDE a component, in a real browser on a real GPU.
 *
 * The owner reported "no signal inside wall1" three times, and it survived two
 * plan-level verifications, because the plan was never what failed: `app.tsx` starved
 * the dived pane twice over — `compiledOutputs` emptied and `previewBackend` nulled
 * behind `insideComponent`, both guards predating the T1019 `flatOf` translation that
 * made flat plan rows addressable from a dived pane. The preview hook's loop is keyed
 * on its backend, so the null KILLED THE LOOP the moment the dive began: seventeen of
 * nineteen TimeGrid interiors dark, on a build carrying every "fix".
 *
 * This gate is the lesson operationalized (§V844: verify the artefact that failed):
 * it opens the shipped E51, checks previews work at the ROOT (the GPU precondition,
 * asserted rather than assumed), dives into the wall, and requires ZERO "no signal"
 * tiles inside. It runs Chromium with WebGPU enabled — unlike the rest of the e2e
 * suite this spec NEEDS pixels, and it fails loudly (at the root assertion, with this
 * sentence in the trace) on a machine whose Chromium has no adapter, never silently.
 */

test.use({
  launchOptions: {
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--headless=new"],
  },
});

test("diving into a component keeps every interior preview live (T1051)", async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    win["showSaveFilePicker"] = undefined;
    win["showOpenFilePicker"] = undefined;
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles("examples/E51-Chorus.loom.json");
  await expect(page.locator('.react-flow__node[data-id="wall"]')).toBeVisible();

  // ROOT precondition: on a working GPU no root tile says "no signal". If THIS fails,
  // the machine's Chromium has no WebGPU adapter — the gate cannot run, and it says so
  // here rather than passing vacuously or failing confusingly inside the dive.
  await expect
    .poll(async () => page.getByText("no signal", { exact: true }).count(), {
      timeout: 15_000,
      message:
        "root previews never lit — this Chromium likely has no WebGPU adapter, so the dive gate cannot measure anything",
    })
    .toBe(0);

  // TD's gesture: double-click the instance body enters it (T602, `graph.diveIn`).
  const wall = page.locator('.react-flow__node[data-id="wall"]');
  const box = await wall.boundingBox();
  if (box === null) throw new Error("wall instance has no bounding box");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));

  // Inside: the TimeGrid definition's own nodes, on the dived canvas.
  await expect(page.locator('.react-flow__node[data-id="grid"]')).toBeVisible();

  // THE CLAIM: no interior tile is dark. Polled, because tiles materialize over a few
  // recompiles (sink registration → compile → paint); the failure mode this defends
  // is PERMANENT darkness (a starved pane never converges), not slow first paint.
  await expect
    .poll(async () => page.getByText("no signal", { exact: true }).count(), { timeout: 15_000 })
    .toBe(0);
});
