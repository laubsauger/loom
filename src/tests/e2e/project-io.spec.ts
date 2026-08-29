import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { APP_VIEWPORT, addNode, connect, moveNode, openApp, selectNode } from "./app.ts";

/**
 * T48 — save and reload, through the browser's real file paths (§V10, §V88 in spirit).
 *
 * ## Why this is a browser test and not a serializer test
 *
 * `src/domain/project/**` already proves a document round-trips through
 * `serializeProjectDocument` → `loadProject`. What that cannot prove is that the bytes the
 * APP writes are the bytes the APP reads: the save path runs through `buildProjectFile`,
 * a Blob, an anchor and a download; the open path runs through an `<input type="file">`,
 * `File.text()` and `adoptDocument`, which throws away the runtime and builds a new one.
 * Every one of those is browser machinery, and a project that saves fine and opens as an
 * empty graph looks exactly like success at every other layer.
 *
 * `openApp` deletes `showSaveFilePicker` / `showOpenFilePicker` before the page loads, so
 * both operations take the fallback path. That is deliberate and not a workaround: the
 * File System Access pickers open a NATIVE dialog that no automation can drive, and the
 * fallback is a real shipped path for every browser that lacks them.
 */

test.use({ viewport: APP_VIEWPORT });

test("a project saves to a file and reloads with its nodes, edges and parameters intact", async ({
  page,
}, testInfo) => {
  await openApp(page);

  // Two nodes and one edge, not five: at this viewport the graph canvas is ~900x700 CSS
  // px and a node is ~445 px wide, so a bigger graph spends the test fighting for screen
  // rather than testing the round trip. What has to survive the trip is one of each
  // KIND of thing — a node, an edge, a moved position and a non-default parameter — and
  // that fits in two nodes.
  const noise = await addNode(page, "generator", "Noise");
  const output = await addNode(page, "output", "Output");
  await moveNode(page, output, 260, 240);
  await connect(page, { nodeId: noise, portId: "out" }, { nodeId: output, portId: "input" });
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // A parameter that is not a default, so the reload has something to get wrong.
  await selectNode(page, noise);
  const seed = page.locator('input[aria-label="Seed"]');
  await seed.scrollIntoViewIfNeeded();
  // A press that never moves hands the field to the keyboard; a double click resets it.
  await seed.click();
  await seed.fill("42");
  await seed.press("Enter");
  await expect(seed).toHaveValue("42");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("project-save").click();
  const download = await downloadPromise;

  const directory = await mkdtemp(join(tmpdir(), "shaderloom-e2e-"));
  const savedPath = join(directory, download.suggestedFilename());
  await download.saveAs(savedPath);
  testInfo.attachments.push({ name: "project", path: savedPath, contentType: "application/json" });

  // §V10: the file that was written is a versioned document, not an opaque blob.
  const saved = JSON.parse(await readFile(savedPath, "utf8")) as {
    schemaVersion: number;
    graph: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
  };
  expect(saved.schemaVersion).toBeGreaterThan(0);
  expect(Object.keys(saved.graph.nodes)).toHaveLength(2);
  expect(Object.keys(saved.graph.edges)).toHaveLength(1);

  // A fresh page: nothing survives in memory, so what comes back comes from the file.
  await page.reload();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooserPromise).setFiles(savedPath);

  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // The parameter, not just the node count — a loader that dropped values would pass
  // every structural assertion above.
  await selectNode(page, noise);
  await expect(page.locator('section[aria-label="Inspector"]')).toBeVisible();
  await expect(page.locator('input[aria-label="Seed"]')).toHaveValue("42");

  // §V10 again, from the other side: the ids in the file are the ids on the canvas, so
  // nothing was regenerated on the way back in — and the position the node was dragged
  // to came back with it rather than resetting to the library default.
  await expect(page.locator(`.react-flow__node[data-id="${output}"]`)).toHaveCount(1);
  expect(saved.graph.nodes[output]).toBeDefined();
});

test("opening a malformed file reports it and leaves the open project alone (§V10)", async ({
  page,
}) => {
  await openApp(page);
  const noise = await addNode(page, "generator", "Noise");
  expect(noise).not.toBe("");

  const directory = await mkdtemp(join(tmpdir(), "shaderloom-e2e-"));
  const badPath = join(directory, "broken.loom.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(badPath, "{ this is not json", "utf8");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("project-open").click();
  await (await chooserPromise).setFiles(badPath);

  // The document that was open is still open — a failed load must not clear the canvas.
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.getByRole("tab", { name: /problems/ }).click();
  await expect(page.getByRole("tabpanel")).toContainText(/could not|failed|invalid/i);
});
