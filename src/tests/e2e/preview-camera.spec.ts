import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { buildProjectFile } from "@domain/project/project-file.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import { document, edge, expressionSlot, graph, named, settings } from "@/examples/documents/builders.ts";
import { APP_VIEWPORT, fitAll, focusGraph, modKey, openApp, selectNode, viewportSettled } from "./app.ts";

/**
 * T1655b — EVERY 3D PREVIEW OFFERS A CAMERA THAT ANSWERS A DRAG, OR SAYS WHY NOT. THE APP'S HALF.
 *
 * `compiler/preview-camera-coverage.test.ts` holds that the compiler SAYS it for every node
 * type in the registry. This holds that the app DOES it, on the real GPU, for the handful
 * of cases the walk found broken while every unit suite was green:
 *
 *  - the VIEWER presented a pointset on a second canvas and kept its orbit gestures on the
 *    first, which is hidden: the bar said "drag to orbit" and no drag moved it. jsdom
 *    dispatches to a hidden element, so the tests that dragged it passed (§V461);
 *  - a camera with exactly ONE Render had no control at all, because it borrows that
 *    Render's row and the gizmo asked a field the borrowed row does not have;
 *  - a camera NOTHING renders through had the control, and its own tile did not move when
 *    the drag wrote the pose: a synthesized tile never saw a values-only edit;
 *  - a Render and a fully driven camera showed an empty corner, which is what a broken
 *    control shows.
 *
 * Every claim is asserted on what the user sees or on what the document holds: tile pixels
 * taken off the glass, the inspector's own number, the sentence on the tile. Never a class
 * name, and never "the handler was called".
 *
 * GPU LANE ONLY (`playwright.config.ts` routes it by basename): a tile is live, and a plan
 * is installed at all, only on a real adapter.
 */
test.use({ viewport: APP_VIEWPORT });

const CELL = { x: 380, y: 440 } as const;
const at = (column: number, row: number): readonly [number, number] => [column * CELL.x, row * CELL.y];

async function open(page: Page, slug: string, nodes: GraphNode[], wires: ReadonlyArray<readonly [string, string, string]>): Promise<void> {
  const project = document(
    slug,
    `Preview camera ${slug}`,
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

/** The fraction of pixels that differ between two screenshots of the same box. */
async function changed(page: Page, before: Buffer, after: Buffer): Promise<number> {
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
      const two = await decode(right as string);
      if (one.width !== two.width || one.height !== two.height) throw new Error("the two shots are not the same box");
      let differing = 0;
      for (let index = 0; index < one.data.length; index += 4) {
        const delta = Math.max(
          Math.abs(one.data[index]! - two.data[index]!),
          Math.abs(one.data[index + 1]! - two.data[index + 1]!),
          Math.abs(one.data[index + 2]! - two.data[index + 2]!),
        );
        if (delta > 12) differing += 1;
      }
      return differing / (one.data.length / 4);
    },
    [before.toString("base64"), after.toString("base64")],
  );
}

/**
 * A picture MOVED when more than this fraction of it changed, and stood STILL below
 * `STILL`. Measured on the walk (static documents): a drag that reaches a camera changes
 * 2 % to 30 % of a tile, and two shots of an untouched tile differ by exactly 0.
 */
const MOVED = 0.01;
const STILL = 0.002;

const tile = (page: Page, nodeId: string): Locator => page.getByTestId(`node-preview-${nodeId}`);

/** The tile's picture off the glass, inset so the node frame and the corner chrome are not in it. */
async function picture(page: Page, nodeId: string): Promise<Buffer> {
  const box = await tile(page, nodeId).boundingBox();
  if (box === null) throw new Error(`the tile of ${nodeId} is not on screen`);
  const inset = Math.min(box.width, box.height) * 0.16;
  return page.screenshot({ clip: { x: box.x + inset, y: box.y + inset, width: box.width - inset * 2, height: box.height - inset * 2 } });
}

async function live(page: Page, nodeId: string): Promise<void> {
  await expect(tile(page, nodeId).locator("[data-preview-state]")).toHaveAttribute("data-preview-state", "live");
  // Two equal shots: the first frames after a tile goes live are not its picture yet.
  await expect
    .poll(async () => {
      const first = await picture(page, nodeId);
      await page.waitForTimeout(150);
      return changed(page, first, await picture(page, nodeId));
    })
    .toBeLessThan(STILL);
}

/** Alt+drag on the tile: the path that needs no chrome (T675). The pointer is parked off it after. */
async function altDrag(page: Page, nodeId: string): Promise<void> {
  const box = await tile(page, nodeId).boundingBox();
  if (box === null) throw new Error(`the tile of ${nodeId} is not on screen`);
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(centre.x + box.width * 0.22, centre.y + box.height * 0.1, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
}

/** The camera toggle is DRAWN: on top at its own centre, opaque, and a size a pointer can hit. */
async function expectToggleVisible(page: Page, nodeId: string): Promise<void> {
  const toggle = page.getByTestId(`preview-inspect-${nodeId}`);
  await expect(toggle).toHaveCount(1);
  const facts = await toggle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = window.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { onTop: top === element, opacity: getComputedStyle(element).opacity, width: rect.width };
  });
  // T675's lesson: found by a test id and clicked, this control passed for months while
  // painted under the tile, and before that at opacity 0.35 until hovered.
  expect(facts.onTop, "the toggle is painted under something").toBe(true);
  expect(facts.opacity).toBe("1");
  expect(facts.width).toBeGreaterThanOrEqual(8);
}

async function eyeX(page: Page, nodeId: string): Promise<number> {
  await selectNode(page, nodeId);
  return Number(await page.locator('input[aria-label="Eye x"]').inputValue());
}

test("a pointset: its tile orbits on alt+drag, and so does the viewer when it is the viewer's subject", async ({ page }) => {
  await open(page, "points", [named("source", "pointGrid", at(0, 0), { cols: 12, rows: 12 })], []);
  await live(page, "grid_source");
  await expectToggleVisible(page, "grid_source");

  const before = await picture(page, "grid_source");
  await altDrag(page, "grid_source");
  await expect.poll(async () => changed(page, before, await picture(page, "grid_source")), { message: "alt+drag on a pointset tile did not turn it" }).toBeGreaterThan(MOVED);

  // The viewer, on the same node. `v` points it here (the keymap's own row).
  await page.getByTestId("node-name-grid_source").click();
  await page.keyboard.press("v");
  await expect(page.getByTestId("viewer-output-select")).toHaveValue("grid_source:out");
  // The canvas that is ON SCREEN for a synthesized row. The first one is hidden, and it is
  // where the gestures used to be.
  const canvas = page.getByTestId("viewer-synthesis-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await expect
    .poll(async () => {
      const first = await canvas.screenshot();
      await page.waitForTimeout(150);
      return changed(page, first, await canvas.screenshot());
    })
    .toBeLessThan(STILL);
  const viewerBefore = await canvas.screenshot();
  await page.mouse.down();
  await page.mouse.move(centre.x + box.width * 0.3, centre.y + box.height * 0.15, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(centre.x, centre.y);
  await expect
    .poll(async () => changed(page, viewerBefore, await canvas.screenshot()), { message: "a drag on the viewer's picture of a pointset did not orbit it" })
    .toBeGreaterThan(MOVED);
});

/** A camera, a sun and a grid of boxes, framed by one Render. */
async function openShot(page: Page): Promise<void> {
  await open(
    page,
    "shot",
    [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("boxes", "geometry", at(1, 0), { mode: "instances", scale: 0.12 }),
      named("key", "light", at(2, 0)),
      // Eye and Look At STORED, as on any camera that has been touched once: a write is then a
      // values-only revision from the first frame of the drag (a first write that ADDS the key
      // is structural, compiles in full, and would hide a values lane that carries nothing).
      named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }),
      named("shot", "render", at(1, 1)),
    ],
    [
      ["grid_source", "geometry_boxes", "points"],
      ["geometry_boxes", "render_shot", "scenes"],
      ["camera_shot", "render_shot", "camera"],
      ["light_key", "render_shot", "lights"],
    ],
  );
  await live(page, "camera_shot");
  await live(page, "render_shot");
}

test("§T1732b a camera with ONE Render: alt-drag LOOKS around, both tiles turn, the camera stays, h returns to it", async ({ page }) => {
  await openShot(page);
  // Both tiles carry the pair: C looks (view only), M moves the camera (an edit). The Render
  // said whose camera it was in that corner; the sentence now rides on the toggles' hover text.
  await expectToggleVisible(page, "render_shot");
  await expectToggleVisible(page, "camera_shot");
  await expect(page.getByTestId("preview-move-render_shot")).toHaveAttribute("aria-label", "Move camera_shot");
  await expect(page.getByTestId("preview-move-camera_shot")).toHaveAttribute("aria-label", "Move camera_shot");
  await expect(page.getByTestId("preview-camera-note-render_shot")).toHaveCount(0);
  await expect(page.getByTestId("preview-inspect-render_shot")).toHaveAttribute("title", /Framed by camera_shot\.$/);

  const startX = await eyeX(page, "camera_shot");
  await fitAll(page);
  await live(page, "render_shot");
  const cameraBefore = await picture(page, "camera_shot");
  const renderBefore = await picture(page, "render_shot");

  await altDrag(page, "render_shot");

  // SETTLED first: the look's first drag asks for its picture, and the plan that draws it is
  // installed a moment later, so a shot taken in between is a transition, not the look.
  await live(page, "render_shot");
  expect(await changed(page, renderBefore, await picture(page, "render_shot")), "a look on the Render's tile did not turn its picture").toBeGreaterThan(MOVED);
  // One picture, one look: the camera's tile shows the Render's picture, so it turned too.
  await live(page, "camera_shot");
  expect(await changed(page, cameraBefore, await picture(page, "camera_shot")), "the camera's tile did not show the Render's look").toBeGreaterThan(MOVED);
  await expect(page.getByTestId("preview-inspect-render_shot")).toHaveAttribute("aria-pressed", "true");
  // A look writes nothing: the camera is where it was.
  expect(await eyeX(page, "camera_shot")).toBe(startX);

  // h over the tile goes home, which is the camera's own picture again.
  await fitAll(page);
  await tile(page, "render_shot").hover();
  await page.keyboard.press("h");
  await expect(page.getByTestId("preview-inspect-render_shot")).toHaveAttribute("aria-pressed", "false");
  await viewportSettled(page);
  await expect.poll(async () => changed(page, renderBefore, await picture(page, "render_shot")), { message: "home did not return to the camera's picture" }).toBeLessThan(STILL);
});

test("a camera with ONE Render: M on the Render's tile moves the camera, both pictures follow, one undo puts it back", async ({ page }) => {
  await openShot(page);
  const startX = await eyeX(page, "camera_shot");
  await fitAll(page);
  await live(page, "camera_shot");
  const cameraBefore = await picture(page, "camera_shot");
  const renderBefore = await picture(page, "render_shot");

  const move = page.getByTestId("preview-move-render_shot");
  await move.click();
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await altDrag(page, "render_shot");

  await expect.poll(async () => changed(page, renderBefore, await picture(page, "render_shot")), { message: "the Render through the moved camera did not move" }).toBeGreaterThan(MOVED);
  await expect.poll(async () => changed(page, cameraBefore, await picture(page, "camera_shot")), { message: "the camera's own tile did not move" }).toBeGreaterThan(MOVED);
  // What moved is the DOCUMENT (T692), not a view of it.
  const movedX = await eyeX(page, "camera_shot");
  expect(Math.abs(movedX - startX)).toBeGreaterThan(0.1);

  // One gesture, one undo step, landing back where the drag began (§V15).
  await focusGraph(page);
  await page.keyboard.press(`${await modKey(page)}+z`);
  expect(await eyeX(page, "camera_shot")).toBe(startX);
  await fitAll(page);
  // M off again (it is lit, and the lit button reaches into the picture's clip). Not an edit.
  await move.click();
  await expect(move).toHaveAttribute("aria-pressed", "false");
  expect(await eyeX(page, "camera_shot")).toBe(startX);
  await fitAll(page);
  await viewportSettled(page);
  await expect.poll(async () => changed(page, renderBefore, await picture(page, "render_shot")), { message: "undo did not put the Render's picture back" }).toBeLessThan(STILL);
});

test("a camera NOTHING renders through: the drag moves its own tile, which draws the document's pose", async ({ page }) => {
  // The stock scene through the camera's matrix is a SYNTHESIZED tile, and a synthesized
  // tile's values live on its row, not in the main plan. A drag here wrote the pose and the
  // tile it was dragged on stayed still.
  // Stored Eye and Look At, for the reason given on `camera_shot` above: with them the whole
  // drag is values-only, which is the road that used to leave this tile where it was.
  await open(page, "free", [named("free", "camera", at(0, 0), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] })], []);
  await live(page, "camera_free");
  await expectToggleVisible(page, "camera_free");
  const before = await picture(page, "camera_free");
  await altDrag(page, "camera_free");
  await expect.poll(async () => changed(page, before, await picture(page, "camera_free")), { message: "the camera wrote its pose and its own tile did not follow" }).toBeGreaterThan(MOVED);
});

test("a fully driven camera offers no control, and says why where the control would be", async ({ page }) => {
  // The owner's own camera has all six channels of Eye and Look At on expressions. A gizmo
  // there could only replace the rig (§T970), so there is none; and an empty corner is what a
  // broken control looks like, so the corner says it.
  await open(
    page,
    "driven",
    [
      named(
        "driven",
        "camera",
        at(0, 0),
        {},
        {
          parameters: {
            "eye.x": expressionSlot("3 * sin(abstime * 0.5)", 0),
            "eye.y": expressionSlot("0.5 + 0.2 * sin(abstime)", 0.5),
            "eye.z": expressionSlot("3 * cos(abstime * 0.5)", 3),
            "lookAt.x": expressionSlot("0.1 * sin(abstime)", 0),
            "lookAt.y": expressionSlot("0.1 * cos(abstime)", 0),
            "lookAt.z": expressionSlot("0", 0),
          },
        },
      ),
    ],
    [],
  );
  await expect(tile(page, "camera_driven").locator("[data-preview-state]")).toHaveAttribute("data-preview-state", "live");
  await expect(page.getByTestId("preview-camera-note-camera_driven")).toHaveText("Driven by expressions (Eye, Look At).");
  await expect(page.getByTestId("preview-inspect-camera_driven")).toHaveCount(0);
  // And the sentence is drawn where it can be read: on top, at its own centre.
  const readable = await page.getByTestId("preview-camera-note-camera_driven").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, opacity: getComputedStyle(element).opacity };
  });
  expect(readable.width).toBeGreaterThan(20);
  expect(readable.opacity).toBe("1");
});

test("chrome is not painted on the node in front: a covered Render's controls are not drawn on the node that covers it", async ({ page }) => {
  /*
   * The owner's document overlaps its nodes, and the chrome layer sits above all of them.
   * There, a covered geometry's "No object drawn on this tile." lay across the material tile
   * in front of it, which draws one: a sentence on the wrong node is a false sentence.
   */
  await open(
    page,
    "overlap",
    [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("boxes", "geometry", at(1, 0), { mode: "instances", scale: 0.12 }),
      named("key", "light", at(2, 0)),
      named("shot", "camera", at(3, 0)),
      named("covered", "render", at(0, 1)),
      named("clear", "render", at(2, 1)),
      // Over the first Render's corner. Selected below, which is what puts a node in front.
      named("front", "noise", [at(0, 1)[0] + 110, at(0, 1)[1] + 70]),
    ],
    [
      ["grid_source", "geometry_boxes", "points"],
      ["geometry_boxes", "render_covered", "scenes"],
      ["camera_shot", "render_covered", "camera"],
      ["light_key", "render_covered", "lights"],
      ["geometry_boxes", "render_clear", "scenes"],
      ["camera_shot", "render_clear", "camera"],
      ["light_key", "render_clear", "lights"],
    ],
  );
  await live(page, "render_clear");
  // Bring the overlapping node to the front the way a user does: by selecting it. Its header
  // is pressed on the part that sticks out to the right of the Render it overlaps.
  const front = await page.locator('.react-flow__node[data-id="noise_front"]').boundingBox();
  if (front === null) throw new Error("the overlapping node is not on screen");
  await page.mouse.click(front.x + front.width * 0.66, front.y + front.height * 0.04);
  await viewportSettled(page);
  // The premise: the corner of the covered Render's tile IS under the other node.
  const corner = await tile(page, "render_covered").boundingBox();
  if (corner === null) throw new Error("the covered Render has no tile on screen");
  const owner = await page.evaluate(
    ([x, y]) => window.document.elementFromPoint(x as number, y as number)?.closest(".react-flow__node")?.getAttribute("data-id") ?? null,
    [corner.x + corner.width - 8, corner.y + corner.height - 8],
  );
  expect(owner, "the fixture no longer covers the Render's corner, so nothing is being gated").toBe("noise_front");

  // The legitimate case first: the Render nothing covers carries its camera controls (§T1732b:
  // look and move, where it used to say only whose camera it is).
  await expect(page.getByTestId("preview-inspect-render_clear")).toHaveCount(1);
  // And the covered one draws nothing on the node in front of it.
  await expect(page.getByTestId("preview-inspect-render_covered")).toHaveCount(0);
  await expect(page.getByTestId("preview-move-render_covered")).toHaveCount(0);
  await expect(page.getByTestId("preview-camera-note-render_covered")).toHaveCount(0);
});

test("a camera that comes on screen after the plan is installed shows its Render's picture, not \"no signal\"", async ({ page }) => {
  /*
   * A camera with one Render previews by BORROWING that Render's row (T546): no pass, no
   * resource, no synthesis. So when its tile comes on screen and nothing else changes, the
   * plan that holds its row has the same signature as the plan before, and the App was
   * never told (§B188's key was blind to it): the tile said "no signal" beside a Render
   * drawing the shot. The fixture makes "nothing else changes" true: the other 3D nodes have
   * their previews switched off, so no synthesized row comes or goes while the view moves.
   */
  const off = { ui: { preview: false } };
  const far = 9000;
  await open(
    page,
    "late",
    [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }, off),
      named("boxes", "geometry", at(1, 0), { mode: "instances", scale: 0.12 }, off),
      named("key", "light", at(2, 0), {}, off),
      named("shot", "render", at(0, 1)),
      named("final", "output", at(1, 1)),
      // Far from everything: off screen, or a few pixels wide, until the view goes to it.
      named("shot", "camera", [far, 0], { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }),
    ],
    [
      ["grid_source", "geometry_boxes", "points"],
      ["geometry_boxes", "render_shot", "scenes"],
      ["camera_shot", "render_shot", "camera"],
      ["light_key", "render_shot", "lights"],
      ["render_shot", "output_final", "input"],
    ],
  );
  // Let the first plan land with the camera's tile too small to be asked for.
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
  await page.waitForTimeout(1500);

  // Go to the camera: wheel in about a cursor placed so the camera lands inside the pane at 100 %.
  const pane = await page.getByTestId("graph-canvas").boundingBox();
  if (pane === null) throw new Error("the graph canvas has no box on screen");
  const view = await page.evaluate(() => {
    const element = window.document.querySelector<HTMLElement>(".react-flow__viewport");
    if (element === null) throw new Error("no react-flow viewport");
    const { a, e, f } = new DOMMatrix(getComputedStyle(element).transform);
    return { zoom: a, tx: e, ty: f };
  });
  const anchor = { x: (far + view.tx - 300) / (1 - view.zoom), y: (0 + view.ty - 200) / (1 - view.zoom) };
  await page.mouse.move(pane.x + anchor.x * view.zoom + view.tx, pane.y + anchor.y * view.zoom + view.ty);
  for (let step = 0; step < 200; step += 1) {
    const zoom = await page.evaluate(() => new DOMMatrix(getComputedStyle(window.document.querySelector(".react-flow__viewport") as HTMLElement).transform).a);
    if (zoom >= 0.98) break;
    await page.mouse.wheel(0, -30);
    await page.waitForTimeout(20);
  }
  await viewportSettled(page);
  await expect(tile(page, "camera_shot")).toBeVisible();

  await expect(tile(page, "camera_shot").locator("[data-preview-state]"), "the camera's tile never got its Render's row").toHaveAttribute(
    "data-preview-state",
    "live",
  );
  // And with the row comes the control: it is the camera that frames the shot.
  await expectToggleVisible(page, "camera_shot");
});

test("3D preview tiles drag their nodes whenever camera controls are off", async ({ page }) => {
  await open(page, "node-drag", [
    named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
    named("boxes", "geometry", at(1, 0), { mode: "instances", scale: 0.12 }),
    named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }),
    named("key", "light", at(1, 1)),
  ], [["grid_source", "geometry_boxes", "points"]]);

  for (const nodeId of ["geometry_boxes", "grid_source", "camera_shot", "light_key"]) {
    await live(page, nodeId);
    const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    const toggle = page.getByTestId(`preview-inspect-${nodeId}`);
    const readPosition = async () => {
      const box = await node.boundingBox();
      if (box === null) throw new Error(`${nodeId} has no node box`);
      return { x: box.x, y: box.y };
    };
    const dragTile = async () => {
      const box = await tile(page, nodeId).boundingBox();
      if (box === null) throw new Error(`${nodeId} has no preview box`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 24, { steps: 8 });
      await page.mouse.up();
    };
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const home = await readPosition();
    await dragTile();
    // React Flow starts dragging on the first move past its activation threshold,
    // so the press-to-first-move part is not included in the node's displacement.
    await expect.poll(async () => (await readPosition()).x - home.x, { message: `${nodeId} cannot drag in home mode` }).toBeGreaterThan(30);
    expect((await readPosition()).x - home.x).toBeLessThanOrEqual(40.5);
    expect((await readPosition()).y - home.y).toBeGreaterThan(18);

    // Camera control owns an ordinary drag only while it is enabled.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const adjustable = await readPosition();
    await dragTile();
    expect(await readPosition()).toEqual(adjustable);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const off = await readPosition();
    await dragTile();
    await expect.poll(async () => (await readPosition()).x - off.x, { message: `${nodeId} cannot drag after camera control is turned off` }).toBeGreaterThan(30);
    expect((await readPosition()).x - off.x).toBeLessThanOrEqual(40.5);
    expect((await readPosition()).y - off.y).toBeGreaterThan(18);
  }
});
