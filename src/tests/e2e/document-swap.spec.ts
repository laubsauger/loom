import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * B185 — LOADING ONE DOCUMENT OVER ANOTHER, WHEN THE TWO COMPILE TO THE SAME PLAN SHAPE.
 *
 * The owner: "I can load the example Alembic, everything is fine. If I then try to load
 * Snarl, everything is broken, everything says no signal. If I then refresh the page and
 * directly load Snarl, everything is fine and dandy. If I then click on Alembic,
 * everything is broken again."
 *
 * THE SHAPE IS THE DIAGNOSIS: A→B broken, fresh→B fine, B→A broken. Neither document is
 * at fault — the PAIR is, and what they share is what collides. §T1171 ships E58 Alembic,
 * E59 Vault, E60 Snarl, E61 Skein and E62 Rake as one instrument at five parameter
 * coordinates: the same three node ids (`alembic`, `out`, `palette`) over the same
 * `alembic.wgsl.ts`. Their plans are therefore BYTE-IDENTICAL in every structural key, so
 * every signature-equality short-circuit in the app treats a swap between them as "the
 * same program, new values". That is correct — provided the app still knows a document
 * boundary happened. It did not: `useGraphCompile`'s memo advanced `lastCompile.current`
 * DURING RENDER, so `<StrictMode>`'s second invocation classified the incoming document
 * against itself and committed `documentBoundary: false`. `useFrameLoop` then never
 * cleared `installedSignatureRef`, the incoming plan was skipped as already installed,
 * and `app.tsx` — which clears its `installedPlan` latch at every boundary (§T1163) — was
 * left holding null for good. Zero compile diagnostics the whole way.
 *
 * ## Why this spec and not a unit test
 *
 * Every component in the chain was individually right. The defect is the composition, and
 * it needs three things a unit test cannot supply together: the DEV React build (only
 * there does `<StrictMode>` double-invoke a memo), the real load command, and two SHIPPED
 * documents whose ids and WGSL collide exactly as they do on disk. So it opens
 * `examples/*.loom.json` through the product's own open path and reads the two surfaces
 * the owner read: the node tiles, and the viewer's output list.
 *
 * ## Both directions, because the bug is symmetric
 *
 * A one-way check would pass on a fix that only repaired the first swap of a session. The
 * spec loads A, then B, then A again, and requires every load after the first to be as
 * live as a cold one.
 */

test.use({
  launchOptions: {
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-gpu", "--headless=new"],
  },
});

/** The three ids E58–E62 share verbatim — the collision this gate is about. */
const SHARED_NODE_IDS = ["alembic", "out", "palette"] as const;

async function openProject(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles(file);
  // The document is on screen once its nodes are: all five carry the same three ids, so
  // this waits for the CANVAS, not for the swap — the assertions below do that.
  for (const id of SHARED_NODE_IDS) {
    await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible();
  }
}

/**
 * What the owner saw, read back from the app: no tile says "no signal", and the viewer
 * has an output to show. The second half is the sharper of the two — with the boundary
 * flag lost, `installedPlan` is null rather than stale, so the select goes DISABLED and
 * reads "no outputs" on a document that compiled without a single diagnostic.
 */
async function expectLiveSignal(page: Page, what: string): Promise<void> {
  await expect
    .poll(async () => page.getByText("no signal", { exact: true }).count(), {
      timeout: 20_000,
      message: `${what}: node previews never lit. On a machine whose Chromium has no WebGPU adapter this gate cannot measure anything and says so here rather than passing vacuously.`,
    })
    .toBe(0);
  const output = page.getByTestId("viewer-output-select");
  await expect(output, `${what}: the viewer holds no installed plan to show`).toBeEnabled();
  await expect(output).not.toHaveValue("");
}

test("a document loaded over one with the same plan shape still renders (B185)", async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    win["showSaveFilePicker"] = undefined;
    win["showOpenFilePicker"] = undefined;
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  // FIRST LOAD — the case that always worked, kept as the GPU precondition. If this
  // fails the machine cannot run the gate at all, and the message above says which.
  await openProject(page, "examples/E58-Alembic.loom.json");
  await expectLiveSignal(page, "E58 Alembic, loaded first");

  // THE BUG: the same three node ids and the same WGSL, arriving over a live document.
  await openProject(page, "examples/E60-Snarl.loom.json");
  await expectLiveSignal(page, "E60 Snarl, loaded over E58 Alembic");

  // AND BACK, because the owner's report is symmetric: the pair collides, not one file.
  await openProject(page, "examples/E58-Alembic.loom.json");
  await expectLiveSignal(page, "E58 Alembic, loaded back over E60 Snarl");
});
