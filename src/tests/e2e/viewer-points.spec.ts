import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { buildProjectFile } from "@domain/project/project-file.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import { document, edge, graph, named, settings } from "@/examples/documents/builders.ts";
import { APP_VIEWPORT, fitAll, openApp } from "./app.ts";

/**
 * B305 / T1823b — A POINTS NODE CAN BE CHOSEN IN THE VIEWER, AND SO CAN ITS NULL (T1822b).
 *
 * ## The report
 *
 * The owner: "I can't choose like a point node as an output properly in the output viewer …
 * and without another node I also can't test." Measured in this lane before the fix: open a
 * document holding one Grid and nothing else. The viewer's surface says "No output", and its
 * selector SHOWS `grid_source:out`. The pane binds the select to "" (nothing pinned, and a
 * points-only graph has no declared sink: the Output takes a picture), "" matched no option,
 * and a browser then displays the first option. A native select fires `change` only when its
 * selection MOVES, so the option it already shows cannot be picked: with one points node, the
 * viewer could never be pointed at it. A second node makes a second option, which is why one
 * more node "fixed" it.
 *
 * The jsdom suites could not see it: `fireEvent.change` dispatches whatever the selection is,
 * which is the one thing a browser does not do (§V461). So the gesture here is the browser's
 * own — the select focused and the node's name typed, the type-to-select every platform's
 * closed select answers to — and the picture is read off the glass.
 *
 * ## The Null's half
 *
 * A points Null is a wire (§V130's splice), so its row was its producer's pointset MARKER,
 * which nothing can present. It now carries a splat of its own of its producer's points. The
 * claim checked is the user's: the Null's picture IS its producer's.
 *
 * GPU LANE ONLY (`playwright.config.ts` routes it by basename): a plan is installed, and a
 * picture drawn, only on a real adapter.
 */
test.use({ viewport: APP_VIEWPORT });

async function open(page: Page, slug: string, nodes: GraphNode[], wires: ReadonlyArray<readonly [string, string, string]>): Promise<void> {
  const project = document(
    slug,
    `Viewer points ${slug}`,
    settings({ outputResolution: { width: 640, height: 360 } }),
    graph(
      nodes,
      wires.map(([from, to, port], index) => edge(`e${String(index)}`, [from, "out"], [to, port])),
    ),
  );
  const file = buildProjectFile({ document: project, now: () => project.updatedAt });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: `${slug}.loom.json`, mimeType: "application/json", buffer: Buffer.from(file.text) });
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length);
  await fitAll(page);
}

/** Decodes one or two PNGs in the page: how much of the first is lit, how much the two differ. */
async function measure(page: Page, shot: Buffer, other?: Buffer): Promise<{ lit: number; changed: number }> {
  return page.evaluate(
    async ([left, right]) => {
      const decode = async (base64: string): Promise<ImageData> => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const copy = window.document.createElement("canvas");
        copy.width = image.naturalWidth;
        copy.height = image.naturalHeight;
        const context = copy.getContext("2d", { willReadFrequently: true });
        if (context === null) throw new Error("No 2D context for screenshot decoding");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, copy.width, copy.height);
      };
      const one = await decode(left as string);
      const two = right === "" ? one : await decode(right as string);
      if (one.width !== two.width || one.height !== two.height) throw new Error("the two shots are not the same box");
      let lit = 0;
      let changed = 0;
      for (let index = 0; index < one.data.length; index += 4) {
        const r = one.data[index]!;
        const g = one.data[index + 1]!;
        const b = one.data[index + 2]!;
        if (Math.max(r, g, b) > 96) lit += 1;
        const delta = Math.max(Math.abs(r - two.data[index]!), Math.abs(g - two.data[index + 1]!), Math.abs(b - two.data[index + 2]!));
        if (delta > 12) changed += 1;
      }
      const pixels = one.data.length / 4;
      return { lit: lit / pixels, changed: changed / pixels };
    },
    [shot.toString("base64"), other === undefined ? "" : other.toString("base64")],
  );
}

/**
 * A splat of a 12×12 grid lights a few percent of the viewer's picture; an empty or black
 * picture lights none.
 */
const POINTS_VISIBLE = 0.002;
/** Two shots of one still picture differ by exactly 0 here; a different picture by far more. */
const SAME_PICTURE = 0.002;

const viewerSelect = (page: Page): Locator => page.getByTestId("viewer-output-select");
const viewerPicture = (page: Page): Locator => page.getByTestId("viewer-synthesis-canvas");

/** The viewer's picture once it holds points and has stopped changing. */
async function settledPoints(page: Page): Promise<Buffer> {
  const canvas = viewerPicture(page);
  await expect(canvas).toBeVisible();
  let shot = await canvas.screenshot();
  await expect
    .poll(
      async () => {
        const first = await canvas.screenshot();
        await page.waitForTimeout(150);
        shot = await canvas.screenshot();
        const { lit, changed } = await measure(page, first, shot);
        return lit > POINTS_VISIBLE && changed < SAME_PICTURE;
      },
      { message: "the viewer never showed a still picture of points" },
    )
    .toBe(true);
  return shot;
}

test("B305: with nothing chosen the selector says so, and the only points node can be chosen", async ({ page }) => {
  await open(page, "lone-grid", [named("source", "pointGrid", [0, 0], { cols: 12, rows: 12 })], []);
  const surface = page.getByTestId("viewer-surface");
  await expect(surface).toContainText("No output");

  // The selector shows what the surface shows: nothing. Before the fix this read
  // `grid_source:out` — an option claiming a picture the pane was not presenting.
  await expect(viewerSelect(page)).toHaveValue("");
  expect(await viewerSelect(page).evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent)).toBe(
    "no output",
  );

  // The browser's own gesture: type-to-select on the focused select. It fires `change` only
  // if the selection moves — which is exactly what it could not do when the node's own
  // option was already the one displayed.
  await viewerSelect(page).focus();
  await page.keyboard.type("grid");
  await expect(viewerSelect(page)).toHaveValue("grid_source:out");
  await expect(surface).not.toContainText("No output");
  await settledPoints(page);
});

test("T1822b: a points Null shows its producer's points in the viewer, as its producer does", async ({ page }) => {
  await open(
    page,
    "points-null",
    [named("source", "pointGrid", [0, 0], { cols: 12, rows: 12 }), named("points", "pointNull", [380, 0])],
    [["grid_source", "null_points", "in"]],
  );

  await viewerSelect(page).selectOption("null_points:out");
  await expect(viewerSelect(page)).toHaveValue("null_points:out");
  const throughNull = await settledPoints(page);

  await viewerSelect(page).selectOption("grid_source:out");
  await expect(viewerSelect(page)).toHaveValue("grid_source:out");
  const direct = await settledPoints(page);

  // Same points, same stock framing, same picture: the Null is a name, not a transform.
  expect((await measure(page, throughNull, direct)).changed).toBeLessThan(SAME_PICTURE);

  // And its own tile on the canvas draws them too.
  const tile = page.getByTestId("node-preview-null_points");
  await expect(tile.locator("[data-preview-state]")).toHaveAttribute("data-preview-state", "live");
  await expect
    .poll(async () => (await measure(page, await tile.screenshot())).lit, { message: "the Null's tile never showed its points" })
    .toBeGreaterThan(POINTS_VISIBLE);
});
