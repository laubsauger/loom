import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { buildProjectFile } from "@domain/project/project-file.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import { FLY_BOOST, FLY_RADII_PER_SECOND } from "@editor/viewer/orbit-gestures.ts";
import { document, edge, expressionSlot, graph, named, namedInstance, node, settings } from "@/examples/documents/builders.ts";
import { APP_VIEWPORT, fitAll, focusGraph, modKey, openApp, selectNode, viewportSettled } from "./app.ts";

/**
 * §T970 — FLY A CAMERA FROM THE VIEWER. THE REAL GESTURES, ON THE REAL GPU.
 *
 * The owner, twice: "i'm still missing a way to actually change the position of the camera
 * in the camera node via flying around in that preview instead of manually having to deal
 * with it". The viewer locks to the camera its picture is drawn through, by a button that
 * names it, and then its drag, wheel and fly keys are edits to that camera.
 *
 * Every claim here is on what the user has afterwards: the camera's STORED pose, read off
 * the inspector's own fields, and the picture on the glass. Not "the handler ran".
 *
 * GPU LANE ONLY (`playwright.config.ts` routes it by basename): the viewer has a picture,
 * and a plan is installed at all, only on a real adapter.
 */
test.use({ viewport: APP_VIEWPORT });
/* Each test is 10 to 14 s on an idle machine and was seen at 30 s with another session's
   heavy run beside it, where the default limit cut a green test off mid-read. */
test.describe.configure({ timeout: 90_000 });

const CELL = { x: 380, y: 440 } as const;
const at = (column: number, row: number): readonly [number, number] => [column * CELL.x, row * CELL.y];

async function open(page: Page, slug: string, nodes: GraphNode[], wires: ReadonlyArray<readonly [string, string, string]>): Promise<void> {
  const project = document(
    slug,
    `Camera fly ${slug}`,
    settings({ outputResolution: { width: 640, height: 360 } }),
    graph(
      nodes,
      // A source is a node, or `node:port` for an output other than `out`.
      wires.map(([from, to, port], index) => {
        const [source = from, sourcePort = "out"] = from.split(":");
        return edge(`e${String(index)}`, [source, sourcePort], [to, port]);
      }),
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

/** A scene with something to see move: boxes on a grid, one light, a Render framed by `camera`. */
function shot(camera: GraphNode, render: Record<string, boolean> = {}): { nodes: GraphNode[]; wires: Array<readonly [string, string, string]> } {
  return {
    nodes: [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("boxes", "geometry", at(1, 0), { mode: "instances", scale: 0.12 }),
      named("key", "light", at(2, 0)),
      camera,
      named("shot", "render", at(1, 1), render),
      named("final", "output", at(2, 1)),
    ],
    wires: [
      ["grid_source", "geometry_boxes", "points"],
      ["geometry_boxes", "render_shot", "scenes"],
      [camera.id, "render_shot", "camera"],
      ["light_key", "render_shot", "lights"],
      ["render_shot", "output_final", "input"],
    ],
  };
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

/** A picture MOVED above this fraction and stood STILL below `STILL` (as `preview-camera.spec.ts` measures them). */
const MOVED = 0.01;
const STILL = 0.002;

type Vec3 = readonly [number, number, number];

/**
 * The camera's STORED pose, as the inspector shows it: the document, not a view of it.
 *
 * SETTLED: a gesture's writes go to the bus one after another, so on a loaded machine the
 * document is still catching up with a flight for a moment after the key comes up (seen
 * here with six specs in parallel: a pose read at once was a frame the flight had already
 * left). Two equal reads are the pose the gesture ended on.
 */
async function storedPose(page: Page, nodeId: string, eyeLabel = "Eye"): Promise<{ eye: Vec3; lookAt: Vec3 }> {
  await selectNode(page, nodeId);
  const field = async (label: string): Promise<number> => Number(await page.locator(`input[aria-label="${label}"]`).inputValue());
  const read = async (): Promise<{ eye: Vec3; lookAt: Vec3 }> => ({
    eye: [await field(`${eyeLabel} x`), await field(`${eyeLabel} y`), await field(`${eyeLabel} z`)],
    lookAt: [await field("Look At x"), await field("Look At y"), await field("Look At z")],
  });
  let previous = await read();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await read();
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  throw new Error(`the stored pose of ${nodeId} never settled`);
}

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const size = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * Points the viewer at a node (`v`, the keymap's own row) and waits for its picture to settle.
 * `stock`: a node with no target of its own (a projector, a camera nothing renders through)
 * is shown as its stock scene, on the viewer's second canvas.
 */
async function view(page: Page, nodeId: string, stock = false): Promise<Locator> {
  await page.getByTestId(`node-name-${nodeId}`).click();
  await page.keyboard.press("v");
  await expect(page.getByTestId("viewer-output-select")).toHaveValue(`${nodeId}:out`);
  const canvas = page.getByTestId(stock ? "viewer-synthesis-canvas" : "viewer-canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => {
      const first = await canvas.screenshot();
      await page.waitForTimeout(150);
      return changed(page, first, await canvas.screenshot());
    })
    .toBeLessThan(STILL);
  return canvas;
}

/**
 * THE CLOCK A FLIGHT IS INTEGRATED OVER, recorded in the page: every animation frame's time,
 * and, for each key event, how many frames had run before it. Installed before the app
 * loads. A held key moves the camera by pace × the seconds of the frames it was held for,
 * so the test reads those frames instead of trusting that two holds of its own clock were
 * equal (they are not, on a machine other sessions share).
 */
async function recordFlightClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const clock = { frames: [] as number[], keys: [] as Array<{ type: string; key: string; frame: number; at: number }> };
    (window as unknown as { __flightClock: typeof clock }).__flightClock = clock;
    const tick = (at: number): void => {
      clock.frames.push(at);
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
    for (const type of ["keydown", "keyup"]) {
      window.addEventListener(type, (event) => {
        const pressed = event as KeyboardEvent;
        if (!pressed.repeat) clock.keys.push({ type, key: pressed.key.toLowerCase(), frame: clock.frames.length, at: performance.now() });
      }, true);
    }
  });
}

/**
 * The seconds the LAST hold of `key` flew for, as the pane integrates them: the first frame
 * after the key goes down starts the clock, every later frame until it comes up adds its
 * own length, and a frame longer than 0.1 s counts as 0.1 (`MAX_FRAME_SECONDS`).
 */
async function flownSeconds(page: Page, key: string): Promise<{ seconds: number; frames: number; wall: number }> {
  return page.evaluate((held) => {
    const clock = (window as unknown as { __flightClock: { frames: number[]; keys: Array<{ type: string; key: string; frame: number; at: number }> } }).__flightClock;
    const last = (type: string): { frame: number; at: number } => {
      const found = clock.keys.filter((entry) => entry.type === type && entry.key === held).at(-1);
      if (found === undefined) throw new Error(`no ${type} of ${held} was seen`);
      return found;
    };
    const [down, up] = [last("keydown"), last("keyup")];
    let seconds = 0;
    for (let index = down.frame + 1; index < up.frame; index += 1) {
      seconds += Math.min(0.1, (clock.frames[index]! - clock.frames[index - 1]!) / 1000);
    }
    return { seconds, frames: up.frame - down.frame, wall: (up.at - down.at) / 1000 };
  }, key);
}

async function undo(page: Page): Promise<void> {
  await focusGraph(page);
  await page.keyboard.press(`${await modKey(page)}+z`);
}

test("the viewer flies the camera its Render is framed by: hold W, the stored pose and the picture move, one undo puts both back", async ({ page }) => {
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "lock", nodes, wires);
  const start = await storedPose(page, "camera_shot");
  expect(start).toEqual({ eye: [0, 0.5, 3], lookAt: [0, 0, 0] });

  // The viewer shows the RENDER. Its button names the node the gestures will write.
  const canvas = await view(page, "render_shot");
  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText("Fly camera_shot");
  await expect(button).toHaveAttribute("aria-pressed", "false");

  // Not armed, nothing here is an edit: a key and a drag leave the document alone.
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await canvas.focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(250);
  await page.keyboard.up("w");
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y + 20, { steps: 6 });
  await page.mouse.up();
  expect(await storedPose(page, "camera_shot"), "the viewer moved a camera it was not locked to").toEqual(start);

  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Flying camera_shot: every move is an edit, undo steps back.");
  // §T1732b: the unarmed drag above LOOKED around; arming sends the look home, so the picture
  // the flight starts from is the camera's own, once it has settled there.
  await expect
    .poll(async () => {
      const first = await canvas.screenshot();
      await page.waitForTimeout(150);
      return changed(page, first, await canvas.screenshot());
    })
    .toBeLessThan(STILL);
  const before = await canvas.screenshot();

  // HOLD W. A held key is a flight (the keymap says which key; the pane integrates it).
  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");

  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "the picture did not move with the flight" }).toBeGreaterThan(MOVED);
  const flown = await storedPose(page, "camera_shot");
  const moved = minus(flown.eye, start.eye);
  // Forward is toward Look At: the eye sat at +z looking at the origin, so z went DOWN.
  expect(moved[2], "W did not carry the camera forward").toBeLessThan(-0.3);
  // The whole rig translated: Look At went with the eye, so the heading is unchanged.
  const target = minus(flown.lookAt, start.lookAt);
  expect(size(minus(target, moved)), "Eye and Look At did not travel together").toBeLessThan(1e-4);
  // And along the camera's own view axis (from [0, 0.5, 3] toward the origin), not along world z.
  expect(moved[1] / moved[2]).toBeCloseTo(0.5 / 3, 3);
  expect(Math.abs(moved[0])).toBeLessThan(1e-4);

  // A SECOND flight, sideways. Each flight is its own undo step: the first key coming up
  // closed the first, so they do not run together into one.
  await canvas.focus();
  await page.keyboard.down("d");
  await page.waitForTimeout(400);
  await page.keyboard.up("d");
  const strafed = await storedPose(page, "camera_shot");
  expect(strafed.eye[0] - flown.eye[0], "D did not carry the camera to its right").toBeGreaterThan(0.2);

  // ONE flight is ONE undo step: one undo lands exactly where the second flight began…
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(flown);
  // …and the next lands exactly where the first began, with the picture.
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(start);
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "undo did not put the picture back" }).toBeLessThan(STILL);
});

test("locked, a drag on the viewer orbits the camera itself, and Home leaves the lock without an edit", async ({ page }) => {
  // Depth Output ON and READ, as on the owner's Render: its rows are then `depth` and `out`,
  // and `v` must still show the PICTURE (§T1659b item 2: it showed `depth`, the first row
  // by key, which is not what anyone pressed `v` on a Render for).
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }), { depthOutput: true });
  nodes.push(named("lens", "camera", at(3, 0)), named("haze", "cameraBlur", at(3, 1)));
  wires.push(["render_shot", "camerablur_haze", "input"], ["render_shot:depth", "camerablur_haze", "depth"], ["camera_lens", "camerablur_haze", "camera"]);
  await open(page, "orbit", nodes, wires);
  // The premise: the depth row IS there to be picked first (it sorts before `out`).
  await expect(page.getByTestId("viewer-output-select").locator('option[value="render_shot:depth"]')).toHaveCount(1);
  const start = await storedPose(page, "camera_shot");
  const canvas = await view(page, "render_shot");
  const button = page.getByTestId("viewer-fly-camera");

  // `c` is the lock's key (a keymap row in the viewer context), from the picture.
  await canvas.focus();
  await page.keyboard.press("c");
  await expect(button).toHaveAttribute("aria-pressed", "true");

  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + box.width * 0.25, centre.y, { steps: 8 });
  await page.mouse.up();

  const orbited = await storedPose(page, "camera_shot");
  // An orbit: the eye went round Look At at the same distance, and Look At stayed.
  expect(orbited.lookAt).toEqual(start.lookAt);
  expect(Math.abs(orbited.eye[0] - start.eye[0])).toBeGreaterThan(0.3);
  expect(size(minus(orbited.eye, orbited.lookAt))).toBeCloseTo(size(minus(start.eye, start.lookAt)), 4);

  // HOME leaves the mode and is NOT an edit: the flown pose stands, the lock is off.
  await canvas.focus();
  await page.keyboard.press("h");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  expect(await storedPose(page, "camera_shot")).toEqual(orbited);
  // The way back from an edit is undo, and the drag was one step.
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(start);
});

test("a key held in a text field does not fly the camera", async ({ page }) => {
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "typing", nodes, wires);
  const start = await storedPose(page, "camera_shot");
  await view(page, "render_shot");
  await page.getByTestId("viewer-fly-camera").click();
  await expect(page.getByTestId("viewer-fly-camera")).toHaveAttribute("aria-pressed", "true");

  // Typing a name that has a W in it, with the lock armed.
  const search = page.locator('input[aria-label="Search nodes"]');
  await search.click();
  await page.keyboard.down("w");
  await page.waitForTimeout(400);
  await page.keyboard.up("w");
  await expect(search).toHaveValue(/^w+$/);
  expect(await storedPose(page, "camera_shot"), "typing flew the camera").toEqual(start);
});

/** The camera's parameters as the SAVED FILE holds them: the document, through the app's own save. */
async function savedParameters(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-save").click();
  const path = await (await download).path();
  if (path === null) throw new Error("the saved project has no local download");
  const saved = JSON.parse(await readFile(path, "utf8")) as { graph: GraphDocument };
  const node = saved.graph.nodes[nodeId];
  if (node === undefined) throw new Error(`${nodeId} is not in the saved file`);
  return node.parameters as Record<string, unknown>;
}

test("⚑ a driven rig is flown through Origin: the rig's expressions stand, the flight is an offset, undo returns it", async ({ page }) => {
  /*
   * THE OWNER'S SHAPE (§T970, §T1656b). Their camera follows a robot by expressions on Eye
   * and Look At, so a flown view could only be kept by replacing the rig with numbers. Here
   * the rig is where it belongs: Origin and Heading on expressions (all six channels), and
   * Eye and Look At plain offsets. The flight must write the offsets and nothing else.
   */
  const rig = {
    "origin.x": expressionSlot("1.5", 1.5),
    "origin.y": expressionSlot("0.25", 0.25),
    "origin.z": expressionSlot("0.5", 0.5),
    "heading.x": expressionSlot("1", 1),
    "heading.y": expressionSlot("0", 0),
    "heading.z": expressionSlot("0 - 1", -1),
  };
  const { nodes, wires } = shot(named("rig", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }, { parameters: rig }));
  /*
   * A plain camera placed BY HAND where the rig puts this one, and a Render through it. The
   * frame faces (1, 0, −1), so its back is (−1, 0, 1)/√2: the offset (0, 0.5, 3) is half
   * above the Origin and three behind it, and Look At, at the frame's own origin, IS Origin.
   */
  const behind = 3 / Math.SQRT2;
  nodes.push(
    named("plain", "camera", at(0, 2), { eye: [1.5 - behind, 0.75, 0.5 + behind], lookAt: [1.5, 0.25, 0.5] }),
    named("plain", "render", at(1, 2)),
  );
  wires.push(["geometry_boxes", "render_plain", "scenes"], ["camera_plain", "render_plain", "camera"], ["light_key", "render_plain", "lights"]);
  await open(page, "rig", nodes, wires);
  const start = await storedPose(page, "camera_rig");
  expect(start).toEqual({ eye: [0, 0.5, 3], lookAt: [0, 0, 0] });

  // ORIGIN AND HEADING REACH THE PICTURE: the rigged Render draws what the hand-placed one draws.
  const byHand = await (await view(page, "render_plain")).screenshot();
  const canvas = await view(page, "render_shot");
  const before = await canvas.screenshot();
  expect(await changed(page, byHand, before), "the rig's Origin and Heading did not place the camera").toBeLessThan(STILL);

  const button = page.getByTestId("viewer-fly-camera");
  // It IS offered: nothing the flight writes is driven.
  await expect(button).toHaveText("Fly camera_rig");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");

  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "the picture did not move with the flight" }).toBeGreaterThan(MOVED);
  // The OFFSET moved, in the frame: forward is the frame's own −z, whichever way the rig faces.
  const flown = await storedPose(page, "camera_rig");
  const moved = minus(flown.eye, start.eye);
  expect(moved[2], "W did not carry the offset forward").toBeLessThan(-0.3);
  expect(size(minus(minus(flown.lookAt, start.lookAt), moved))).toBeLessThan(1e-4);

  // THE RIG STANDS, as the saved file holds it: six expressions, exactly as written.
  const saved = await savedParameters(page, "camera_rig");
  for (const [key, slot] of Object.entries(rig)) {
    expect([key, saved[key]], "the flight replaced a channel of the rig").toEqual([key, slot]);
  }
  // And what the flight wrote is plain numbers on Eye and Look At, with no slot minted on them.
  expect(saved["eye"]).toEqual([...flown.eye]);
  expect(saved["lookAt"]).toEqual([...flown.lookAt]);
  for (const key of ["eye.x", "eye.y", "eye.z", "lookAt.x", "lookAt.y", "lookAt.z"]) expect([key, saved[key]]).toEqual([key, undefined]);

  // One undo: the offset is back where the flight began, and so is the picture.
  await undo(page);
  expect(await storedPose(page, "camera_rig")).toEqual(start);
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "undo did not put the picture back" }).toBeLessThan(STILL);
});

test("a rig on Eye and Look At themselves is not offered a flight, and the viewer says whose camera and why", async ({ page }) => {
  // The owner's file as it stands today: all six channels of Eye and Look At on expressions.
  // A flight there could only replace them, so there is no button, on the Render or anywhere.
  const driven = {
    "eye.x": expressionSlot("0", 0),
    "eye.y": expressionSlot("0.5", 0.5),
    "eye.z": expressionSlot("3", 3),
    "lookAt.x": expressionSlot("0", 0),
    "lookAt.y": expressionSlot("0", 0),
    "lookAt.z": expressionSlot("0", 0),
  };
  const { nodes, wires } = shot(named("rig", "camera", at(0, 1), {}, { parameters: driven }));
  await open(page, "driven", nodes, wires);
  await view(page, "render_shot");
  await expect(page.getByTestId("viewer-fly-camera")).toHaveCount(0);
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Framed by camera_rig. Driven by expressions (Eye, Look At).");
});

test("at 35 % zoom the tile's camera toggle is still 12 px and on top, and a partly driven camera says what it holds", async ({ page }) => {
  const { nodes, wires } = shot(
    named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }, { parameters: { "eye.x": expressionSlot("0", 0) } }),
  );
  await open(page, "small", nodes, wires);
  const toggle = page.getByTestId("preview-inspect-camera_shot");
  await expect(toggle).toHaveCount(1);
  // §T1659b item 6: it flies on five channels and holds one, and now says which, on the
  // control that moves it (§T1732b: M; C only looks, and holds nothing back).
  await expect(page.getByTestId("preview-move-camera_shot")).toHaveAttribute("title", /Stays driven: Eye x \(Expression\)\.$/);

  // Wheel out, about the middle of the canvas, to about 35 %.
  const pane = await page.getByTestId("graph-canvas").boundingBox();
  if (pane === null) throw new Error("the graph canvas has no box on screen");
  const zoom = (): Promise<number> =>
    page.evaluate(() => new DOMMatrix(getComputedStyle(window.document.querySelector(".react-flow__viewport") as HTMLElement).transform).a);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  for (let step = 0; step < 80; step += 1) {
    if ((await zoom()) <= 0.36) break;
    await page.mouse.wheel(0, 30);
    await page.waitForTimeout(25);
  }
  await viewportSettled(page);
  expect(await zoom()).toBeLessThanOrEqual(0.36);

  const facts = await toggle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = window.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { width: rect.width, height: rect.height, onTop: top === element, opacity: getComputedStyle(element).opacity };
  });
  // 16 px scaled by 0.35 would be 5.6. It holds 12 (measured on the glass, not on a style).
  expect(facts.width).toBeCloseTo(12, 1);
  expect(facts.height).toBeCloseTo(12, 1);
  expect(facts.onTop, "the toggle is painted under something").toBe(true);
  expect(facts.opacity).toBe("1");
  // And it is still ON the tile's corner, not beside the tile.
  const tile = await page.getByTestId("node-preview-camera_shot").boundingBox();
  const box = await toggle.boundingBox();
  if (tile === null || box === null) throw new Error("the tile or its toggle is not on screen");
  expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(tile.y + tile.height + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(tile.x - 0.5);
});

/**
 * Slice 1e — THE OTHER THREE KINDS THAT GET THE BUTTON BY CONSTRUCTION. The compiler says a
 * projector, and a Render Surface or Render Instances with no camera named, are drawn
 * through their own Eye and Look At (`pose`), so the viewer offers each the lock without a
 * line of code naming them. "By construction" was a reading; this is each of them flown.
 */
async function flies(page: Page, options: { subject: string; button: string; eyeLabel?: string; stock?: boolean }): Promise<void> {
  const start = await storedPose(page, options.subject, options.eyeLabel);
  const canvas = await view(page, options.subject, options.stock === true);
  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText(options.button);
  const resting = await canvas.boundingBox();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("viewer-camera-note")).toHaveText(new RegExp(`^Flying ${options.subject}:`));
  // §T1710b: arming fills the note's line, which was held empty, so the picture does not move
  // under the pointer. These three kinds say nothing before the flight; the jump was 7.7 px.
  expect(await canvas.boundingBox(), `${options.subject}: arming the flight moved the picture`).toEqual(resting);
  const before = await canvas.screenshot();
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("w");
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: `${options.subject}: the picture did not move with the flight` }).toBeGreaterThan(MOVED);
  const flown = await storedPose(page, options.subject, options.eyeLabel);
  const moved = minus(flown.eye, start.eye);
  // Forward, along its own view axis, Look At with it.
  const axis = minus(start.lookAt, start.eye);
  const along = (moved[0] * axis[0] + moved[1] * axis[1] + moved[2] * axis[2]) / size(axis);
  expect(along, `${options.subject}: W did not carry it forward`).toBeGreaterThan(0.2);
  expect(Math.abs(size(moved) - along), `${options.subject}: the flight left its view axis`).toBeLessThan(1e-3);
  expect(size(minus(minus(flown.lookAt, start.lookAt), moved))).toBeLessThan(1e-4);
  await undo(page);
  expect(await storedPose(page, options.subject, options.eyeLabel)).toEqual(start);
}

test("a projector is flown from the viewer: its stock scene moves with its stored aim", async ({ page }) => {
  await open(page, "projector", [named("wall", "projector", at(0, 0), { eye: [2, 2, 3], lookAt: [0, 0, 0] })], []);
  await flies(page, { subject: "projector_wall", button: "Fly projector_wall", stock: true });
});

test("a Render Surface with no camera named is flown by its own Eye and Look At", async ({ page }) => {
  await open(
    page,
    "surface",
    [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("sheet", "pointTopology", at(1, 0), { connectivity: "grid", cols: 8, rows: 8 }),
      named("cloth", "renderSurface", at(2, 0), { eye: [0.6, 0.4, 3], lookAt: [0, 0, 0] }),
    ],
    [
      ["grid_source", "topology_sheet", "points"],
      ["topology_sheet", "surface_cloth", "points"],
    ],
  );
  await flies(page, { subject: "surface_cloth", button: "Fly surface_cloth", eyeLabel: "Camera Eye" });
});

test("a Render Instances with no camera named is flown by its own Eye and Look At", async ({ page }) => {
  await open(
    page,
    "instances",
    [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("crowd", "renderInstances", at(1, 0), { eye: [0.6, 0.4, 3], lookAt: [0, 0, 0], scale: 0.08 }),
    ],
    [["grid_source", "instances_crowd", "points"]],
  );
  await flies(page, { subject: "instances_crowd", button: "Fly instances_crowd", eyeLabel: "Camera Eye" });
});

test("a Render Surface that NAMES a camera offers that camera, and its own Eye stays where it was", async ({ page }) => {
  // A named camera replaces the inline pose (`camera-reference.ts`), so writing the inline one
  // would move nothing: the button must name the camera that frames the picture.
  await open(
    page,
    "named",
    [
      named("source", "pointGrid", at(0, 0), { cols: 8, rows: 8 }),
      named("sheet", "pointTopology", at(1, 0), { connectivity: "grid", cols: 8, rows: 8 }),
      named("main", "camera", at(0, 1), { eye: [0.6, 0.4, 3], lookAt: [0, 0, 0] }),
      named("cloth", "renderSurface", at(2, 0), { eye: [0, 0, 5], lookAt: [0, 0, 0] }),
    ],
    [
      ["grid_source", "topology_sheet", "points"],
      ["topology_sheet", "surface_cloth", "points"],
      ["camera_main", "surface_cloth", "camera"],
    ],
  );
  const inline = await storedPose(page, "surface_cloth", "Camera Eye");
  const start = await storedPose(page, "camera_main");
  await view(page, "surface_cloth");
  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText("Fly camera_main");
  await button.click();
  await page.keyboard.down("w");
  await page.waitForTimeout(400);
  await page.keyboard.up("w");
  expect(size(minus((await storedPose(page, "camera_main")).eye, start.eye))).toBeGreaterThan(0.2);
  expect(await storedPose(page, "surface_cloth", "Camera Eye")).toEqual(inline);
});

test("locked: the wheel dollies the camera toward what it looks at, and a held key flies at the pace the rule gives, four times it with shift", async ({ page }) => {
  await recordFlightClock(page);
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "wheel", nodes, wires);
  const start = await storedPose(page, "camera_shot");
  const canvas = await view(page, "render_shot");
  const button = page.getByTestId("viewer-fly-camera");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");

  // Unlocked, the wheel over the picture edits nothing.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(600);
  expect(await storedPose(page, "camera_shot"), "the wheel moved a camera the viewer was not locked to").toEqual(start);

  await button.click();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await page.mouse.wheel(0, -240);
  // The wheel has no button-up: its undo step closes itself after a short idle.
  await page.waitForTimeout(700);
  const dollied = await storedPose(page, "camera_shot");
  // Closer to Look At, along the same line, and Look At itself unmoved: a dolly, not a flight.
  expect(dollied.lookAt).toEqual(start.lookAt);
  expect(size(dollied.eye)).toBeLessThan(size(start.eye) - 0.2);
  expect(dollied.eye[1] / dollied.eye[2]).toBeCloseTo(start.eye[1] / start.eye[2], 4);
  // One burst of the wheel is one undo step.
  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(start);

  /*
   * THE PACE, AND SHIFT AS THE THROTTLE. Each hold is held against ITS OWN frames: the
   * distance the stored pose moved is the pace × the distance to Look At × the seconds of
   * the frames the key was held for (read from the page), × four with shift. This was a
   * ratio of two real holds ("more than 2.2 times as far"), and two equal holds gave 2.36
   * and 1.68 on a loaded machine: that measured the machine. `use-viewer-fly.test.tsx`
   * holds the same rule on a clock it owns.
   *
   * It is also the literal sequence of a bug this found: a flight AFTER AN UNDONE DOLLY. The
   * wheel's idle commit kept its local pose, so the flight started from the dollied eye and
   * landed the dolly's length too far (1.45 times the rule's distance here, in both holds,
   * which is why a ratio of the two never saw it).
   */
  const reach = size(minus(start.eye, start.lookAt));
  const fly = async (shift: boolean): Promise<{ flown: number; byRule: number; held: string }> => {
    await canvas.focus();
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.down("w");
    await page.waitForTimeout(500);
    await page.keyboard.up("w");
    if (shift) await page.keyboard.up("Shift");
    const held = await flownSeconds(page, "w");
    const flown = await storedPose(page, "camera_shot");
    await undo(page);
    expect(await storedPose(page, "camera_shot")).toEqual(start);
    return { flown: size(minus(flown.eye, start.eye)), byRule: FLY_RADII_PER_SECOND * reach * held.seconds * (shift ? FLY_BOOST : 1), held: JSON.stringify(held) };
  };
  const cruise = await fly(false);
  expect(cruise.flown).toBeGreaterThan(0.2);
  // Six digits are stored a frame; over a hold that is well inside one part in a thousand.
  expect(cruise.flown / cruise.byRule, `cruise flew ${String(cruise.flown)}, the rule gives ${String(cruise.byRule)} for ${cruise.held}`).toBeCloseTo(1, 3);
  const boosted = await fly(true);
  expect(boosted.flown / boosted.byRule, `with shift it flew ${String(boosted.flown)}, the rule gives ${String(boosted.byRule)} for ${boosted.held}`).toBeCloseTo(1, 3);
});

test("at the default window the bar keeps its pickers whole beside a named button, which is not clipped", async ({ page }) => {
  /*
   * Slice 1e. At a 308 px viewer the named button arrived in a row whose two pickers shared
   * every pixel of shortage: the Display picker was 25 px wide and showed no letter of
   * "RGBA", and the button's own text was cut at both ends. The Display picker now never
   * shrinks, and the button takes a second row before anything in the first is squeezed.
   */
  await page.setViewportSize({ width: 1280, height: 720 });
  const { nodes, wires } = shot(named("overhead_follow", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "bar", nodes, wires);
  const display = page.locator("#viewer-alpha-display");
  const widthOf = async (locator: Locator): Promise<number> => (await locator.boundingBox())?.width ?? 0;

  // A pointset in the viewer: the one-letter inspection button. What the Display picker measures there is its whole self.
  await view(page, "grid_source", true);
  const whole = await widthOf(display);
  expect(whole).toBeGreaterThan(40);

  await view(page, "render_shot");
  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText("Fly camera_overhead_follow");
  expect(await widthOf(display), "the named button changed the width of the Display picker").toBe(whole);
  // The button shows all of its name: nothing of it is scrolled out of its own box.
  const clipped = await button.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
  // And the Output picker still shows which node it is (it used to read "render_s").
  expect(await widthOf(page.locator("#viewer-output"))).toBeGreaterThan(110);
});

test("⚑ a directed shot on an Aimed frame is flown whole: nothing stays driven, W runs down the directed view, E up the picture, a drag is a turntable about the world's vertical", async ({ page }) => {
  /*
   * THE CONSUMER'S SHAPE (§T1671b). A table of directed shots: where the camera is, on
   * Origin; where it looks, on Heading, read WHOLE (Frame: Aimed), so the aim is straight
   * down the frame and Look At is 0, 0, −d as a plain number. On a Level frame the aim's
   * height and distance had to stay in Look At as expressions, and two of the six channels
   * a flight writes were driven. Here all six are free.
   *
   * The shot: from (0, −3, 4), below and in front of the grid, looking up a 3-4-5 climb at
   * its centre, five away.
   */
  const rig = {
    "origin.x": expressionSlot("0", 0),
    "origin.y": expressionSlot("0 - 3", -3),
    "origin.z": expressionSlot("4", 4),
    "heading.x": expressionSlot("0", 0),
    "heading.y": expressionSlot("3", 3),
    "heading.z": expressionSlot("0 - 4", -4),
  };
  const { nodes, wires } = shot(named("rig", "camera", at(0, 1), { frame: "aimed", eye: [0, 0, 0], lookAt: [0, 0, -5], ...rig } as never));
  // The same pose placed by hand on a plain camera, and a Render through it.
  nodes.push(named("plain", "camera", at(0, 2), { eye: [0, -3, 4], lookAt: [0, 0, 0] }), named("plain", "render", at(1, 2)));
  wires.push(["geometry_boxes", "render_plain", "scenes"], ["camera_plain", "render_plain", "camera"], ["light_key", "render_plain", "lights"]);
  await open(page, "aimed", nodes, wires);
  const start = await storedPose(page, "camera_rig");
  expect(start).toEqual({ eye: [0, 0, 0], lookAt: [0, 0, -5] });

  // THE FRAME REACHES THE PICTURE: the directed Render draws what the hand-placed one draws.
  /* The pointer over each picture FIRST: the viewer then shows its pixel line and keeps it
     for that output, and the picture sits 8 px higher for it. The drag below would bring that line in half
     way through, and a shot from before it is not the same box as one from after. */
  const probed = async (canvas: Locator): Promise<Locator> => {
    await canvas.hover();
    await expect(page.getByTestId("viewer-readout")).toContainText("pixel");
    return canvas;
  };
  const byHand = await (await probed(await view(page, "render_plain"))).screenshot();
  const canvas = await probed(await view(page, "render_shot"));
  const before = await canvas.screenshot();
  expect(await changed(page, byHand, before), "the Aimed frame did not place the camera").toBeLessThan(STILL);

  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText("Fly camera_rig");
  await button.click();
  // NOTHING STAYS DRIVEN: the sentence ends where it does for a plain camera.
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Flying camera_rig: every move is an edit, undo steps back.");

  // W RUNS DOWN THE DIRECTED VIEW: the frame's own −z, Look At with it, nothing to the side or up.
  await page.keyboard.down("w");
  await page.waitForTimeout(600);
  await page.keyboard.up("w");
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "the picture did not move with the flight" }).toBeGreaterThan(MOVED);
  const flown = await storedPose(page, "camera_rig");
  const advanced = minus(flown.eye, start.eye);
  expect(advanced[2], "W did not advance along the directed view").toBeLessThan(-0.3);
  expect(Math.hypot(advanced[0], advanced[1]), "W left the directed view").toBeLessThan(1e-4);
  expect(size(minus(minus(flown.lookAt, start.lookAt), advanced)), "Look At did not travel with the eye").toBeLessThan(1e-4);

  // E RISES ALONG THE PICTURE'S UP. The shot looks down its frame, so that is the frame's
  // +y. Along the WORLD's up, (0, 0.8, −0.6) in this frame, it would also have gone −z.
  await canvas.focus();
  await page.keyboard.down("e");
  await page.waitForTimeout(500);
  await page.keyboard.up("e");
  const risen = await storedPose(page, "camera_rig");
  const rose = minus(risen.eye, flown.eye);
  expect(rose[1], "E did not raise the camera").toBeGreaterThan(0.3);
  expect(Math.hypot(rose[0], rose[2]), "E did not run along the picture's up").toBeLessThan(1e-4);
  expect(size(minus(minus(risen.lookAt, flown.lookAt), rose))).toBeLessThan(1e-4);

  // A SIDEWAYS DRAG IS A TURNTABLE ABOUT THE WORLD'S VERTICAL through Look At: the eye goes
  // round the aim at the distance and at the WORLD height it had. About the frame's own up,
  // which is what every other pose turns about, its world height would have changed.
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + box.width * 0.25, centre.y, { steps: 8 });
  await page.mouse.up();
  const orbited = await storedPose(page, "camera_rig");
  const WORLD_UP: Vec3 = [0, 0.8, -0.6];
  const height = (offset: Vec3): number => offset[0] * WORLD_UP[0] + offset[1] * WORLD_UP[1] + offset[2] * WORLD_UP[2];
  const [from, to] = [minus(risen.eye, risen.lookAt), minus(orbited.eye, orbited.lookAt)];
  expect(orbited.lookAt).toEqual(risen.lookAt);
  expect(Math.abs(to[0] - from[0]), "the drag did not carry the eye round").toBeGreaterThan(0.3);
  expect(size(to)).toBeCloseTo(size(from), 4);
  expect(height(to), "the orbit was not about the world's vertical").toBeCloseTo(height(from), 4);
  // The premise of that line: the same turn about the frame's +y changes the world height by this much.
  const turned = Math.atan2(to[0], to[2]);
  expect(Math.abs(height([size(from) * Math.sin(turned), 0, size(from) * Math.cos(turned)]) - height(from))).toBeGreaterThan(0.05);

  // THE RIG STANDS, as the saved file holds it, and the Frame is still Aimed.
  const saved = await savedParameters(page, "camera_rig");
  for (const [key, slot] of Object.entries(rig)) expect([key, saved[key]], "a gesture replaced a channel of the rig").toEqual([key, slot]);
  expect(saved["frame"]).toBe("aimed");
  for (const key of ["eye.x", "eye.y", "eye.z", "lookAt.x", "lookAt.y", "lookAt.z"]) expect([key, saved[key]]).toEqual([key, undefined]);

  // UNDO RETURNS, a step a gesture: the drag, the rise, the advance, and the picture with them.
  await undo(page);
  expect(await storedPose(page, "camera_rig")).toEqual(risen);
  await undo(page);
  expect(await storedPose(page, "camera_rig")).toEqual(flown);
  await undo(page);
  expect(await storedPose(page, "camera_rig")).toEqual(start);
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "undo did not put the picture back" }).toBeLessThan(STILL);
});

test("⚑ v pressed in the same breath as a click shows the node just clicked, not the one selected before", async ({ page }) => {
  /*
   * Found by this file failing under load, on the line every test here starts with: click a
   * node's name, press `v`. The keymap read the selection the app had last RENDERED, which
   * lands one commit after the click, so a key that arrived first opened the viewer on the
   * node selected BEFORE the click (and did nothing at all when nothing was). Sent with
   * nothing between them, the click and the key lost that race every time, on an idle
   * machine. The keymap now reads the selection the canvas last reported.
   */
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "breath", nodes, wires);
  const select = page.getByTestId("viewer-output-select");
  const centreOf = async (nodeId: string): Promise<{ x: number; y: number }> => {
    const box = await page.getByTestId(`node-name-${nodeId}`).boundingBox();
    if (box === null) throw new Error(`${nodeId} has no name on screen`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await selectNode(page, "camera_shot");
  await page.keyboard.press("v");
  await expect(select).toHaveValue("camera_shot:out");

  // Another node selected before: the click and the key go down the wire together.
  const render = await centreOf("render_shot");
  await Promise.all([page.mouse.click(render.x, render.y), page.keyboard.press("v")]);
  await expect(select).toHaveValue("render_shot:out");

  // Nothing selected before: the same.
  const source = await centreOf("grid_source");
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await Promise.all([page.mouse.click(source.x, source.y), page.keyboard.press("v")]);
  await expect(select).toHaveValue("grid_source:out");
});

/**
 * A CAMERA INSIDE A COMPONENT. The owner, on PillarPreviz (2026-11-06): *"that's the camera
 * that doesn't show these controls. neither on the top level nor inside the subcomponent
 * where the camera actually is… hitting C doesn't do anything and I don't see any button"*,
 * while the same camera at the root had both. Slice 1 listed "a camera inside a component"
 * as NOT CHECKED.
 *
 * The shot from `shot()` is wrapped whole in a component (`ShotRig`), and the root holds one
 * instance of it and the Output. Inside, the plan's rows carry FLAT ids (`shotrig_rig/camera_shot`)
 * while the dived canvas and its bus speak the component's own (`camera_shot`).
 */
async function openRig(page: Page, camera: GraphNode): Promise<void> {
  const { nodes, wires } = shot(camera);
  const inner = nodes.filter((each) => each.type !== "output");
  const out = node("out_shot", "componentOut", at(2, 1), {}, { label: "shot" });
  const rig: GraphComponentDefinition = {
    componentId: "shotRig",
    version: 1,
    name: "ShotRig",
    graph: graph(
      [...inner, out],
      [
        ...wires.filter(([, to]) => to !== "output_final").map(([from, to, port], index) => {
          const [source = from, sourcePort = "out"] = from.split(":");
          return edge(`e${String(index)}`, [source, sourcePort], [to, port]);
        }),
        edge("e-out", ["render_shot", "out"], ["out_shot", "in"]),
      ],
    ),
    inputs: [],
    outputs: [{ externalId: "shot", label: "shot", nodeId: "out_shot", portId: "in" }],
    parameters: [],
  };
  const project = document(
    "rig",
    "Camera fly in a component",
    settings({ outputResolution: { width: 640, height: 360 } }),
    graph(
      [namedInstance("rig", "ShotRig", "component:shotRig@1", at(0, 0)), named("final", "output", at(1, 0))],
      [edge("e0", ["shotrig_rig", "shot"], ["output_final", "input"])],
    ),
  );
  const file = buildProjectFile({ document: project, components: [rig], now: () => project.updatedAt });
  await openApp(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByTestId("project-open").click();
  await (await chooser).setFiles({ name: "rig.loom.json", mimeType: "application/json", buffer: Buffer.from(file.text) });
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await fitAll(page);
}

async function diveInto(page: Page, id: string): Promise<void> {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (box === null) throw new Error(`the instance "${id}" has no bounding box`);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  await expect(page.locator('.react-flow__node[data-id="camera_shot"]')).toBeVisible();
  await fitAll(page);
}

test("⚑ inside a component, the camera's tile offers its camera and the viewer flies it: the edit lands in the component, one undo puts it back", async ({ page }) => {
  await openRig(page, named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await diveInto(page, "shotrig_rig");

  // THE TILES: the camera's own toggle, and a scene tile's inspection orbit, as at the root.
  await expect(page.getByTestId("preview-inspect-camera_shot")).toHaveCount(1);
  await expect(page.getByTestId("preview-inspect-geometry_boxes")).toHaveCount(1);

  // THE VIEWER, pointed at the Render from inside: the button names the camera.
  const start = await storedPose(page, "camera_shot");
  expect(start).toEqual({ eye: [0, 0.5, 3], lookAt: [0, 0, 0] });
  await page.getByTestId("node-name-render_shot").click();
  await page.keyboard.press("v");
  await expect(page.getByTestId("viewer-output-select")).toHaveValue("shotrig_rig/render_shot:out");
  const canvas = page.getByTestId("viewer-canvas");
  await expect(canvas).toBeVisible();
  const button = page.getByTestId("viewer-fly-camera");
  await expect(button).toHaveText("Fly camera_shot");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");

  const before = await canvas.screenshot();
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("w");
  await expect.poll(async () => changed(page, before, await canvas.screenshot()), { message: "the picture did not move with the flight" }).toBeGreaterThan(MOVED);
  const flown = await storedPose(page, "camera_shot");
  expect(flown.eye[2] - start.eye[2], "W did not carry the camera inside the component forward").toBeLessThan(-0.2);

  await undo(page);
  expect(await storedPose(page, "camera_shot")).toEqual(start);
});

test("at the root, a picture framed by a camera inside a component says where that camera is, and offers no flight it cannot make", async ({ page }) => {
  await openRig(page, named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await page.getByTestId("viewer-output-select").selectOption("shotrig_rig/render_shot:out");
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
  await expect(page.getByTestId("viewer-fly-camera")).toHaveCount(0);
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Framed by shotrig_rig/camera_shot. Dive into shotrig_rig to fly camera_shot.");
});

/**
 * §T1732b — LOOK: the viewer's and the tiles' default camera on a picture drawn through a
 * camera node. View only: the picture turns and the document does not move, so a camera
 * whose pose is driven (the owner's PillarPreviz guest camera) can be looked around too.
 */
test("§T1732b not locked, a drag on the viewer LOOKS around the Render: the picture turns, the camera stays, h returns to the camera", async ({ page }) => {
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await open(page, "look", nodes, wires);
  const start = await storedPose(page, "camera_shot");
  const canvas = await view(page, "render_shot");
  const before = await canvas.screenshot();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the viewer's picture has no box");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const drag = async (dx: number): Promise<void> => {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + box.width * dx, centre.y + box.height * 0.1, { steps: 8 });
    await page.mouse.up();
  };

  await drag(0.25);
  await expect(page.getByTestId("viewer-camera-note")).toHaveText("Looking around: view only, the camera does not move. H returns to the camera.");
  await expect(page.getByTestId("viewer-fly-camera")).toHaveAttribute("aria-pressed", "false");
  // Compared look against look, under the same sentence: the readout's line changed with the
  // first drag, and a line that wraps differently resizes the picture by itself.
  const looked = await settled(page, () => canvas.screenshot());
  await drag(0.2);
  expect(await changed(page, looked, await settled(page, () => canvas.screenshot())), "a drag on the viewer did not look around the Render").toBeGreaterThan(MOVED);
  expect(await storedPose(page, "camera_shot"), "a look wrote the camera").toEqual(start);

  await canvas.focus();
  await page.keyboard.press("h");
  expect(await changed(page, before, await settled(page, () => canvas.screenshot())), "h did not return to the camera's picture").toBeLessThan(STILL);
  expect(await storedPose(page, "camera_shot")).toEqual(start);
});

test("§T1732b a fully driven camera is looked around from its Render's tile, and nothing is written", async ({ page }) => {
  // Every channel of Eye and Look At on an expression: MOVE is not offered, LOOK is.
  const channels = {
    "eye.x": expressionSlot("0.6", 0),
    "eye.y": expressionSlot("0.5", 0.5),
    "eye.z": expressionSlot("3", 3),
    "lookAt.x": expressionSlot("0", 0),
    "lookAt.y": expressionSlot("0", 0),
    "lookAt.z": expressionSlot("0", 0),
  };
  const { nodes, wires } = shot(named("shot", "camera", at(0, 1), {}, { parameters: channels }));
  await open(page, "driven-look", nodes, wires);
  await expect(page.getByTestId("preview-inspect-render_shot")).toHaveCount(1);
  await expect(page.getByTestId("preview-move-render_shot")).toHaveCount(0);
  await settledTile(page, "render_shot");
  const before = await tilePicture(page, "render_shot");
  await altDragTile(page, "render_shot");
  expect(await changed(page, before, await settled(page, () => tilePicture(page, "render_shot"))), "a look did not turn the driven camera's picture").toBeGreaterThan(MOVED);
  // The expressions stand, as the saved file holds them: six, exactly as written.
  const saved = await savedParameters(page, "camera_shot");
  for (const [key, slot] of Object.entries(channels)) expect([key, saved[key]], "a look replaced a channel").toEqual([key, slot]);
});

test("§T1732b inside a component, the Render's tile looks around without writing the camera in the component", async ({ page }) => {
  await openRig(page, named("shot", "camera", at(0, 1), { eye: [0, 0.5, 3], lookAt: [0, 0, 0] }));
  await diveInto(page, "shotrig_rig");
  const start = await storedPose(page, "camera_shot");
  await fitAll(page);
  await expect(page.getByTestId("preview-inspect-render_shot")).toHaveCount(1);
  await expect(page.getByTestId("preview-move-render_shot")).toHaveAttribute("aria-label", "Move camera_shot");
  await settledTile(page, "render_shot");
  const before = await tilePicture(page, "render_shot");
  await altDragTile(page, "render_shot");
  expect(await changed(page, before, await settled(page, () => tilePicture(page, "render_shot"))), "a look inside the component did not turn the Render's tile").toBeGreaterThan(MOVED);
  expect(await storedPose(page, "camera_shot"), "a look wrote the camera inside the component").toEqual(start);
});

/** A tile's picture off the glass, inset clear of the node frame and the corner chrome. */
async function tilePicture(page: Page, nodeId: string): Promise<Buffer> {
  const box = await page.getByTestId(`node-preview-${nodeId}`).boundingBox();
  if (box === null) throw new Error(`the tile of ${nodeId} is not on screen`);
  const inset = Math.min(box.width, box.height) * 0.16;
  return page.screenshot({ clip: { x: box.x + inset, y: box.y + inset, width: box.width - inset * 2, height: box.height - inset * 2 } });
}

async function settledTile(page: Page, nodeId: string): Promise<void> {
  await expect(page.getByTestId(`node-preview-${nodeId}`).locator("[data-preview-state]")).toHaveAttribute("data-preview-state", "live");
  await expect
    .poll(async () => {
      const first = await tilePicture(page, nodeId);
      await page.waitForTimeout(150);
      return changed(page, first, await tilePicture(page, nodeId));
    })
    .toBeLessThan(STILL);
}

/** Alt+drag on a tile, the path that needs no chrome; the pointer is parked off it after. */
async function altDragTile(page: Page, nodeId: string): Promise<void> {
  const box = await page.getByTestId(`node-preview-${nodeId}`).boundingBox();
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

/** A picture once two shots of it agree: what is ON screen, not a frame of a plan being installed. */
async function settled(page: Page, shoot: () => Promise<Buffer>): Promise<Buffer> {
  let previous = await shoot();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(150);
    const next = await shoot();
    if ((await changed(page, previous, next)) < STILL) return next;
    previous = next;
  }
  throw new Error("the picture never settled");
}
