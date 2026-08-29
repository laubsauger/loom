import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, connect, focusGraph, modKey, openApp } from "./app.ts";

/**
 * T48 — shader editing, and the half of "error recovery" that this environment can run.
 *
 * ## What CANNOT run here, stated rather than skipped
 *
 * The criterion is "a visible shader error followed by recovery" (doc §27). Producing a
 * WGSL error requires a device that compiles WGSL, and **there is no WebGPU in Playwright's
 * Chromium on this machine** — `navigator.gpu` is `undefined` in the bundled Chromium and
 * in system Chrome, headless and headed, with and without `--enable-unsafe-webgpu`. So the
 * app runs in its `gpu.unavailable` state, no plan is compiled against a device, and no
 * WGSL is ever validated. There is nothing here that could produce a shader error to
 * recover from, and a spec that pretended otherwise would be asserting against a product
 * that never ran the code path.
 *
 * That half is gated in `src/tests/acceptance/phase0-exit.test.ts`, on Dawn, where a real
 * device really refuses a real shader — see the FAILING GATE note there, which is where
 * the §V9 defect this criterion depends on is recorded.
 *
 * The `test.fixme` at the bottom names the blocker in the runner's own output, so
 * `npx playwright test` reports the gap instead of a clean green tick that has quietly
 * skipped the interesting case.
 *
 * ## What DOES run here
 *
 * The editing loop around the error: selecting a shader node opens its source and an edit
 * commits as ONE undo entry through the bus (§V29, §V34); and the honest degradation
 * §V12 requires — with no capability report there is no compile at all, so the app says
 * what is missing rather than painting nodes red on a judgement nothing made.
 */

test.use({ viewport: APP_VIEWPORT });

test("editing WGSL commits through the bus as one undo entry (§V29, §V34)", async ({ page }) => {
  await openApp(page);
  const mod = await modKey(page);

  const fx = await addNode(page, "shader", "Custom WGSL");
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();

  const editor = page.getByTestId("shader-editor-surface");
  await expect(editor).toBeVisible();
  // The pane says what is true about this build rather than claiming a compile happened.
  await expect(page.getByRole("tabpanel")).toContainText(/shader compile/i);

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// edited by the e2e suite");
  await expect(page.getByRole("tabpanel")).toContainText("unsaved");

  // Blur to the library's search box: somewhere neutral that does NOT clear the node
  // selection. Clicking the canvas would also blur the editor — and would lose the edit;
  // that is its own test below.
  await page.locator('input[aria-label="Search nodes"]').click();
  await expect(page.getByRole("tabpanel")).toContainText("saved");
  await expect(editor).toContainText("edited by the e2e suite");

  // ONE undo takes the whole typing burst back and leaves the node in place. A
  // per-keystroke commit would need one undo per character and this would still show
  // the edited text.
  await focusGraph(page);
  await page.keyboard.press(`${mod}+z`);
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();
  await expect(editor).not.toContainText("edited by the e2e suite");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
});

/**
 * FAILING GATE — a shader edit is silently lost when you click the canvas.
 *
 * Measured: type into the shader editor, then click empty canvas — the most ordinary way
 * to leave a pane. The click blurs the editor AND clears the selection. `ShaderPane` reads
 * `nodeId === null` and returns its "No shader selected" branch, so `ShaderEditor`
 * unmounts; the `onBlur` commit does not survive that, and the typing is gone. The status
 * strip afterwards reads "saved", which is the worst part: the UI reports that the text
 * was stored, and it was not.
 *
 * Blurring anywhere that does NOT change the selection (the library search box, above)
 * commits correctly, which is what locates this: the commit path works, the unmount races
 * it. The fix belongs in `src/app/dock-panes.tsx` — commit before the pane can lose its
 * subject, or keep the pane mounted on the last node it was editing.
 *
 * Left red deliberately. This is data loss, and a test that avoided the gesture would
 * report a product that does not have this bug.
 */
test("a shader edit survives clicking away onto the canvas", async ({ page }) => {
  await openApp(page);

  const fx = await addNode(page, "shader", "Custom WGSL");
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// typed, then clicked away");
  await expect(page.getByRole("tabpanel")).toContainText("unsaved");

  await focusGraph(page);
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();

  await expect(
    page.getByTestId("shader-editor-surface"),
    "the edit was discarded when the canvas click cleared the selection",
  ).toContainText("typed, then clicked away");
});

test("with no device the app says so, and invents no compile result (§V12)", async ({ page }) => {
  await openApp(page);

  const fx = await addNode(page, "shader", "Custom WGSL");
  const output = await addNode(page, "output", "Output");
  await connect(page, { nodeId: fx, portId: "out" }, { nodeId: output, portId: "input" });

  // §V12: with no capability report there is NO compile — the app does not invent a
  // device to validate against. That is why no compiler diagnostic can appear here, and
  // why the §V27 attribution below is a fixme rather than a weakened assertion.
  await page.getByRole("tab", { name: /problems/ }).click();
  const problems = page.getByRole("tabpanel");
  await expect(problems).toContainText(/webgpu/i);
  await expect(problems).toContainText(/editing still works/i);

  // The node is not painted as broken, because nothing has judged it.
  await expect(page.locator(`[data-testid="node-${fx}"]`)).toHaveAttribute("data-status", "idle");
});

/**
 * BLOCKED, not skipped. Needs `navigator.gpu`, which this environment does not have, so
 * `useGraphCompile` never runs (§V12) and no compiler diagnostic can reach the panel.
 *
 * What it would assert: a Custom WGSL node whose required input is unconnected produces a
 * `compiler/input-missing` error, that error appears in the problems tab, and the node
 * itself carries `data-status="error"` — §V27's two surfaces, from one diagnostic.
 * `src/tests/integration/compile-real-nodes.test.ts` covers the diagnostic; what is
 * missing here is only that it reaches the two places a user looks.
 */
test.fixme(
  "a compiler error reaches the problems tab and the node badge (§V27) — needs navigator.gpu, absent in this environment",
  () => {
    // Intentionally empty: a body that skipped itself would report this as a pass.
  },
);

/**
 * BLOCKED, not skipped. Recorded as a fixme so the runner prints it every run.
 *
 * Needs: `navigator.gpu` in the browser under test. Measured absent in Playwright's
 * bundled Chromium and in system Chrome on this machine, headless and headed, with and
 * without `--enable-unsafe-webgpu`. A runner with a GPU-capable Chromium (or a Chrome
 * channel where WebGPU is enabled) can turn this into a real test; nothing in the app
 * needs to change for it.
 *
 * The steps it would take: select the Custom WGSL node, replace its source with WGSL that
 * does not compile, blur to commit, assert the viewer still shows the previous image and
 * the problems tab shows a `shader/compile-error` with a line and column, then restore a
 * valid source and assert the error clears and the image updates.
 */
test.fixme(
  "an invalid shader keeps the last valid image and shows an error, then recovers (§V9) — needs navigator.gpu, absent in this environment",
  () => {
    // Intentionally empty: see the note above. Writing a body that skips itself would
    // report this as a pass.
  },
);
