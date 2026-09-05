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

/**
 * §B188 — the POINTSET half of the same dive, which T1051's gate above cannot see.
 *
 * E51's TimeGrid is textures end to end, and a texture output is materialized by the
 * compiler whether anyone previews it or not: its row is in `plan.outputs` from the
 * first compile, so the tile above binds it and lights. A POINTSET output is not. Its
 * row is a MARKER (`resourceKind: "pointset"`, T373) with nothing bindable; the tile
 * only ever has a picture once the node is a PREVIEW SINK and the recompile attaches a
 * `synthesis` — the splat pass and the target the preview program owns.
 *
 * That synthesis mints NO plan resource and NO plan pass (`ResolvedOutput.synthesis`
 * says so), so the plan that carries it is byte-identical, under
 * `planStructureSignature(resources, passes)`, to the plan that does not — measured on
 * this very document. `use-frame-loop` announced `installedPlan` only when that
 * signature moved, so the plan carrying every synthesis was compiled, handed to the
 * backend, and never announced: `compiledOutputs` stayed a compile behind for ever and
 * every pointset tile in the document read "no signal" over the marker row's own facts
 * (`1280 × 720 · rgba16float` — a TEXTURE description on a node that produces points,
 * which is how the owner's screenshot named the defect).
 *
 * So this is the shape §B177 was the first face of, and it is not confined to a dive —
 * the instance's own tile at the root fails the same way, which is why both are asserted
 * here. E47 is the artefact the owner was looking at (§V844), and the assertions name
 * the tiles by node so a failure says WHICH half went dark rather than counting.
 */
test("a component's interior POINTSET previews light, and so does the instance's own (B188)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    win["showSaveFilePicker"] = undefined;
    win["showOpenFilePicker"] = undefined;
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles("examples/E47-Hologram.loom.json");
  await expect(page.locator('.react-flow__node[data-id="holo"]')).toBeVisible();

  /*
   * THE PRECONDITION, measured on the adapter itself rather than on a tile.
   *
   * T1051's gate above can use "no root tile is dark" for this because on E51 that is
   * true at HEAD. Here it is exactly what is under test, so the premise has to be
   * established independently or the gate cannot tell "no GPU" from "the bug".
   */
  const adapter = await page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return gpu === undefined ? null : ((await gpu.requestAdapter()) ?? null);
  });
  expect(
    adapter,
    "no WebGPU adapter in this Chromium — the preview path cannot run, so this gate can measure nothing",
  ).not.toBeNull();

  /**
   * "Has a picture to show", which is the claim the owner's report is the negation of.
   *
   * `idle` is the state whose label is literally "no signal" (`node-preview.tsx`), and it
   * is the one the defect pinned every pointset tile in. `suspended` is NOT a failure and
   * must not be asserted against: E47 opens fit to twenty-five nodes, so a tile can be
   * legitimately off-screen or under the scheduler's size floor — it has its output, it
   * just is not being drawn this second (§V455), and it says so in its own words.
   */
  const hasSignal = async (key: string): Promise<string | null> =>
    page.getByTestId(`preview-slot-${key}`).first().getAttribute("data-preview-state");
  const expectSignal = async (key: string): Promise<void> => {
    await expect
      .poll(() => hasSignal(key), { timeout: 20_000, message: `${key} never got a picture` })
      .not.toBe("idle");
  };

  /*
   * FRAME THE INSTANCE FIRST, and both halves of that are load-bearing.
   *
   * `fitView` runs at mount against a pane that has not finished laying out, so E47's
   * twenty-five nodes settle with the left column's geometric rects OUTSIDE the canvas
   * element — clipped by its overflow, still reported by `getBoundingClientRect`, and
   * therefore still "visible" to Playwright (the app.ts docblock's lesson, one pane
   * over). A click at those coordinates lands on the LIBRARY panel behind them, which
   * quietly ADDS A NODE instead of selecting anything; measured here before it was a
   * mystery. `F` re-frames against the pane's real size, which is all this needs: the
   * claim below is "has a picture", never "is being drawn at this zoom".
   */
  const cbox = await page.getByTestId("graph-canvas").boundingBox();
  if (cbox === null) throw new Error("the graph canvas has no bounding box");
  await page.mouse.click(cbox.x + cbox.width - 8, cbox.y + cbox.height - 8);
  await page.keyboard.press("Shift+F");
  const holo = page.locator('.react-flow__node[data-id="holo"]');
  await expect
    .poll(async () => ((await holo.boundingBox())?.x ?? -1) > cbox.x, { timeout: 10_000 })
    .toBe(true);
  /*
   * THE OUTSIDE HALF — §B177's own face, held so it cannot regress.
   *
   * Stated honestly: this one was already GREEN at HEAD, and the reason is timing rather
   * than health. The first sink set is published immediately (`preview-sinks.ts` exempts
   * it from the settle window), so on a load it can reach the compiler before the plan
   * the boundary installs — and then the instance's synthesis rides in on the plan that
   * IS announced. Every LATER change to the sink set, which is what a dive is, could not.
   */
  await expectSignal("holo:out");

  // TD's gesture: double-click the instance body enters it (T602, `graph.diveIn`).
  const box = await holo.boundingBox();
  if (box === null) throw new Error("holo instance has no bounding box");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  await expect(page.locator('.react-flow__node[data-id="grid"]')).toBeVisible();

  // THE SPLIT, asserted as a split. `in_field`/`in_field_2` are the component's TEXTURE
  // input boundaries and they drew fine throughout the defect; the four pointset tiles
  // are the ones that were dark. Both are named so a regression says which half moved.
  for (const key of ["in_field:out", "in_field_2:out"]) await expectSignal(key);
  // `out_out` is the component's Out boundary: its own flat row is a bare marker, so its
  // tile resolves THROUGH the boundary to the producer wired into it (T1019) — which is
  // a synthesized pointset preview like the other three.
  for (const key of ["grid:out", "carve:out", "paint:out", "out_out:out"]) await expectSignal(key);

  /*
   * §B188's second half, measured rather than eyeballed: THE BOUNDARY LEADS.
   *
   * The owner: "not seeing connections from the out node to the parent, like from the
   * socket to the floating thing that is there … the same is true for the inputs — the
   * connecting line doesn't go to the socket, it just goes to the node itself". Two
   * symptoms of one cause (`node-view.module.css`): the lead shared `::before` with the
   * status hairline, so it inherited `inset: 0 0 auto 0` — which over-constrained the OUT
   * lead into drawing inside the node's LEFT edge (CSS drops `right` in LTR), left the IN
   * lead painted solid by the hairline's background, and pinned both to the NODE's
   * midpoint instead of the socket's row.
   *
   * Used values off the live cascade, which is the only place this could have been seen:
   * a CSS-module class name says nothing about what the cascade did with it.
   */
  const leads = await page.evaluate(() => {
    const read = (id: string, rowClass: string) => {
      const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] > div`);
      const row = [...(node?.querySelectorAll<HTMLElement>("li") ?? [])].find((li) =>
        li.className.includes(rowClass),
      );
      if (node === undefined || node === null || row === undefined) return null;
      const line = getComputedStyle(row, "::before");
      const plug = getComputedStyle(row, "::after");
      const px = (value: string): number => Number.parseFloat(value);
      return {
        rowWidth: row.getBoundingClientRect().width,
        // The row's own box, so 0 is the socket's edge and negative is outside the node.
        lineLeft: px(line.left),
        lineRight: px(line.right),
        lineWidth: px(line.width),
        lineBackground: line.backgroundColor,
        plugLeft: px(plug.left),
        plugRight: px(plug.right),
        // The status hairline, which the lead used to eat.
        hairline: px(getComputedStyle(node, "::before").height),
      };
    };
    return { in: read("in_field", "portIn"), out: read("out_out", "portOut") };
  });
  const inLead = leads.in;
  const outLead = leads.out;
  if (inLead === null || outLead === null) throw new Error("a boundary node has no socket row");

  // THE COLLISION: the node's own `::before` is the 1px status hairline again, on both.
  expect(inLead.hairline).toBe(1);
  expect(outLead.hairline).toBe(1);
  // ...so the lead is a LINE, not a bar filled with the hairline's status colour.
  expect(inLead.lineBackground).toBe("rgba(0, 0, 0, 0)");
  expect(outLead.lineBackground).toBe("rgba(0, 0, 0, 0)");

  // THE IN LEAD reaches the socket from OUTSIDE, on the left: the whole box is left of 0.
  expect(inLead.lineLeft + inLead.lineWidth).toBeLessThanOrEqual(0);
  expect(inLead.plugLeft).toBeLessThan(inLead.lineLeft);
  // THE OUT LEAD does the same on the right — this is the one that had no line at all,
  // because the inherited `left: 0` won and drew it inside the node.
  expect(outLead.lineRight).toBeLessThan(0);
  expect(outLead.lineLeft).toBeGreaterThanOrEqual(outLead.rowWidth);
  expect(outLead.plugRight).toBeLessThan(outLead.lineRight);

  // And the sentence the owner actually wrote, over the whole dived pane.
  await expect
    .poll(async () => page.getByText("no signal", { exact: true }).count(), { timeout: 20_000 })
    .toBe(0);
});
