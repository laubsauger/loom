import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, connect, fitAll, focusGraph, modKey, moveNode, openApp } from "./app.ts";

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

  // T492 put a second CodeMirror in the inspector, so every editor locator scopes to
  // the dock pane this test actually opened (T469).
  const dock = page.getByRole("region", { name: "Bottom dock" });
  const editor = dock.getByTestId("shader-editor-surface");
  await expect(editor).toBeVisible();
  // The pane says what is true about this build rather than claiming a compile happened.
  await expect(dock.getByRole("tabpanel")).toContainText(/shader compile/i);

  await dock.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// edited by the e2e suite");
  await expect(dock.getByRole("tabpanel")).toContainText("unsaved");

  // Blur to the library's search box: somewhere neutral that does NOT clear the node
  // selection. Clicking the canvas would also blur the editor — and would lose the edit;
  // that is its own test below.
  await page.locator('input[aria-label="Search nodes"]').click();
  await expect(dock.getByRole("tabpanel")).toContainText("saved");
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
 * A shader edit survives the most ordinary way of leaving the pane: clicking the canvas,
 * which blurs the editor AND clears the selection in one gesture. The commit must land
 * before the pane can lose its subject — an unmount racing the `onBlur` commit is
 * silent data loss with a status strip that says "saved".
 *
 * History: this documented a real data-loss bug as a deliberately red FAILING GATE
 * (T62, bff428a) that was fixed in 7304d96 — and then sat green-but-masked behind
 * strict-mode selector noise until T469 scoped it; kept as a regression gate (§V569).
 */
test("a shader edit survives clicking away onto the canvas", async ({ page }) => {
  await openApp(page);

  const fx = await addNode(page, "shader", "Custom WGSL");
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();

  // T469: scoped to the dock (T492's inspector editor would strict-violate a bare
  // locator) so that when this gate fails, it fails on the ASSERTION it exists for —
  // the data loss — and never on selector noise in front of it.
  const dock = page.getByRole("region", { name: "Bottom dock" });
  await dock.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n// typed, then clicked away");
  await expect(dock.getByRole("tabpanel")).toContainText("unsaved");

  await focusGraph(page);
  await page.locator(`.react-flow__node[data-id="${fx}"]`).click({ position: { x: 40, y: 8 } });
  await page.getByRole("tab", { name: /shader editor/ }).click();

  await expect(
    dock.getByTestId("shader-editor-surface"),
    "the edit was discarded when the canvas click cleared the selection",
  ).toContainText("typed, then clicked away");
});

test("with no device the app says so, and invents no compile result (§V12)", async ({ page }) => {
  await openApp(page);

  const fx = await addNode(page, "shader", "Custom WGSL");
  const output = await addNode(page, "output", "Output");
  // Fit, then separate, exactly as `graph-editing.spec.ts` does and for its reason
  // (T469): two library-added nodes overlap at this size, and the one painted on top
  // buries the other's handle. The connect here is setup rather than the claim, which is
  // why it went unnoticed — `connect` now refuses to release when it cannot tell which
  // socket it is over, and said so.
  await fitAll(page);
  await moveNode(page, output, 260, 240);
  await connect(page, { nodeId: fx, portId: "out" }, { nodeId: output, portId: "input" });

  // §V12: with no capability report there is NO compile — the app does not invent a
  // device to validate against. That is why no compiler diagnostic can appear here, and
  // why the §V27 attribution below is a fixme rather than a weakened assertion.
  await page.getByRole("tab", { name: /problems/ }).click();
  // T469: the pane tree renders one tabpanel per pane; name the one this test opened.
  const problems = page.getByRole("tabpanel", { name: "problems" });
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
