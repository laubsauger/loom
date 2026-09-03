import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Shared driving for the browser suite (T48, §V15).
 *
 * ## What this environment can and cannot run, measured PER LANE (§V895, T1086)
 *
 * **WebGPU here is a property of the Playwright project, not of Playwright.** Measured
 * 2026-09-03, bundled Chromium 151.0.7922.34 on macOS, against a real http origin — the
 * broader sentence that used to live here ("`navigator.gpu` is undefined … headless and
 * headed — measured, not assumed") was a real measurement of a `data:` URL, an opaque
 * origin where WebGPU is correctly absent, over-generalised into a platform verdict;
 * §V895 is that lesson filed:
 *
 *   - **Headless** — the default `chromium` project, i.e. every spec that imports this
 *     file: `navigator.gpu` is PRESENT and `requestAdapter()` resolves null. No device.
 *     The app degrades honestly (`gpu.unavailable`, "Editing still works"), which is
 *     what makes these specs possible at all: connecting, undo/redo, parameter drag and
 *     save/reload are editor-and-domain behaviour and none of them needs a device. What
 *     the missing adapter rules out IN THIS LANE is anything about pixels: a live
 *     preview, a viewer image, a rendered output, and the half of "shader error
 *     recovery" that is about the last valid output continuing to render.
 *
 *   - **Headed** — the `chromium-headed-gpu` project (`playwright.config.ts`):
 *     `requestAdapter()` returns a real `apple`/`metal-3` adapter and the app renders
 *     for real. Pixel claims about what the user SEES — the actual viewer canvas,
 *     through the presentation blit — live in `presentation-pixels.spec.ts`, whose
 *     first test re-measures this adapter split so the claim above can never rot into a
 *     docblock again.
 *
 * The Dawn suites (`src/tests/headless/**`, `src/tests/acceptance/**`) still carry the
 * exact-pixel claims that need no browser. Nothing here is written as a spec that skips
 * itself into a green tick — see `shader-errors.spec.ts` for how a genuinely unrunnable
 * half is recorded instead.
 *
 * ## Two mechanical facts that cost an afternoon each
 *
 * 1. **`scrollIntoViewIfNeeded()` before any pointer gesture in the inspector.** The
 *    inspector's parameter list scrolls inside a pane, and `getBoundingClientRect` —
 *    which is what Playwright's `boundingBox()` reports — gives the geometric rect even
 *    when an ancestor's overflow has clipped the element off-screen. Dragging at those
 *    coordinates silently lands on whatever pane is actually there, the gesture does
 *    nothing, and the assertion fails with no clue why.
 * 2. **A connect gesture needs intermediate moves.** React Flow starts a connection on
 *    pointerdown over a handle and only completes it if it sees movement before the
 *    pointerup. A straight down/up, or a single jump to the target, produces no edge.
 */

export const APP_VIEWPORT = { width: 1600, height: 1000 } as const;

/** Opens the app and waits for the shell rather than for a network idle guess. */
export async function openApp(page: Page): Promise<void> {
  // Force the download / <input type="file"> paths for save and open. The File System
  // Access pickers exist in Chromium and open a NATIVE dialog no automation can drive,
  // so a spec that let them through would hang. Both fallbacks are real shipped paths.
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    // ASSIGN undefined rather than delete (T469): the pickers live on the Window
    // prototype in current Chromium, so `delete` on the instance removed nothing and
    // the app still saw a function — the native dialog opened and the filechooser
    // event the spec waits for never fired. An own undefined shadows the prototype.
    win["showSaveFilePicker"] = undefined;
    win["showOpenFilePicker"] = undefined;
  });
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  // The library pane is ready when its search box is: T427 dissolved the old
  // "Node Library" wrapper section, so the search box is the stable landmark.
  await expect(page.locator('input[aria-label="Search nodes"]')).toBeVisible();
}

/** Adds a node from the library by its category and title, and returns its React Flow id. */
export async function addNode(page: Page, category: string, title: string): Promise<string> {
  const before = await page.locator(".react-flow__node").count();
  await page
    .locator(`section[aria-label="${category}"] button`, { hasText: new RegExp(`^${title}`) })
    .first()
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  const added = page.locator(".react-flow__node").nth(before);
  const id = await added.getAttribute("data-id");
  if (id === null) throw new Error(`the node added for "${title}" carries no data-id`);
  return id;
}

/** A node's own handle, port-scoped — `nodeId` alone is never enough (§V59). */
export function handle(page: Page, nodeId: string, portId: string, kind: "source" | "target"): Locator {
  return page.locator(
    `.react-flow__handle.${kind}[data-nodeid="${nodeId}"][data-handleid="${portId}"]`,
  );
}

/**
 * HOW FAR AN EDGE'S FAR END SITS FROM THE SOCKET IT SHOULD BE TOUCHING, IN GRAPH PIXELS.
 *
 * A number, not a verdict (§V649). "The endpoint is near the handle" is a claim with its
 * population hidden — near by how much, and how much drift would still have passed? The
 * caller compares this against a tolerance it states out loud, and a failure reports the
 * distance that was actually measured.
 *
 * ## What is measured, and why it is not a DOM query
 *
 * React Flow draws edges to a per-node CACHE of handle positions, so the socket can be in
 * the DOM, correctly placed, and rendered nowhere near the wire that claims it (T694).
 * Any assertion that only asks whether the socket exists shares that blindness (§V634).
 * So this reads the END OF THE PATH THE BROWSER PAINTED — `getPointAtLength` at the full
 * length — and compares it against the socket's own client rect.
 *
 * Both are pushed through the path's `getScreenCTM`, which is what makes the answer a
 * GRAPH-pixel distance: the canvas's zoom appears in that matrix and divides straight back
 * out, so the same drift reports the same number whatever the camera is doing.
 *
 * The anchor is the MIDDLE OF THE HANDLE'S OUTER EDGE, not the centre of the dot —
 * measured, and it is React Flow's rule for both ends of every wire. Aiming this at the
 * centre would report a permanent half-dot offset and make the tolerance meaningless.
 */
export function edgeEndpointOffset(
  page: Page,
  edgeLabel: string,
  nodeId: string,
  handleId: string,
): Promise<number> {
  return page.evaluate(
    ({ edgeLabel, nodeId, handleId }) => {
      const path = document.querySelector<SVGPathElement>(
        `.react-flow__edge[aria-label="${edgeLabel}"] .react-flow__edge-path`,
      );
      const dot = document.querySelector<HTMLElement>(
        `.react-flow__handle.target[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`,
      );
      if (path === null) throw new Error(`no edge "${edgeLabel}" is rendered`);
      if (dot === null) throw new Error(`no socket "${nodeId}:${handleId}" is rendered`);
      const ctm = path.getScreenCTM();
      if (ctm === null) throw new Error("the edge path is not rendered into a screen");
      const end = path.getPointAtLength(path.getTotalLength());
      const box = dot.getBoundingClientRect();
      const distance = Math.hypot(
        end.x * ctm.a + end.y * ctm.c + ctm.e - box.x,
        end.x * ctm.b + end.y * ctm.d + ctm.f - (box.y + box.height / 2),
      );
      return Math.round((distance / ctm.a) * 100) / 100;
    },
    { edgeLabel, nodeId, handleId },
  );
}

/**
 * The largest drift that is rounding rather than a bug, in graph pixels.
 *
 * A transformed SVG point and a client rect round differently, so an exact tie is not
 * available. The bug this bounds is a WHOLE PORT ROW out — 16px — and every measurement
 * taken while writing it read 0.0 or 30.0, never anything between, so the tolerance is
 * nowhere near the signal it has to separate.
 */
export const ENDPOINT_TOLERANCE_PX = 1;

/** Asserts the wire lands on the socket, reporting the distance it actually landed at. */
export async function expectEndsOnSocket(
  page: Page,
  edgeLabel: string,
  nodeId: string,
  handleId: string,
  when: string,
): Promise<void> {
  await expect
    .poll(async () => edgeEndpointOffset(page, edgeLabel, nodeId, handleId), {
      message: `${when}: "${edgeLabel}" should end on socket ${handleId}, in graph px`,
    })
    .toBeLessThanOrEqual(ENDPOINT_TOLERANCE_PX);
}

/**
 * The connect gesture, as a human performs it: press on the output handle, move, release
 * on the input handle. Deliberately NOT `dragTo` — that dispatches a down and an up with
 * one move between, which React Flow does not read as a connection.
 *
 * `portId` is the HANDLE id, which since T695 is not always the port id: a variadic input
 * renders one socket per edge plus a spare, addressed `in2#0`, `in2#1`, … So "wire this
 * into the second layer" is `in2#1`, and the socket a spec aims at only exists once the
 * one before it is filled.
 *
 * ## The target is measured TWICE, and the second one is the one that counts
 *
 * React Flow auto-pans while a connection is in the air (`autoPanOnConnect`), so a box
 * taken before the press describes a viewport that has since moved under the cursor. It
 * lands within a few pixels, which is invisible on a node with one input and decisive on a
 * variadic port whose sockets are 16px apart: the release resolves through
 * `document.elementFromPoint`, so a few pixels of drift silently wires the layer BELOW the
 * one the spec named, and the spec then fails somewhere else entirely. Measured: a drop
 * aimed at `in2#1` arriving as `in2#2`.
 */
export async function connect(
  page: Page,
  from: { nodeId: string; portId: string },
  to: { nodeId: string; portId: string },
): Promise<void> {
  const source = handle(page, from.nodeId, from.portId, "source");
  const target = handle(page, to.nodeId, to.portId, "target");
  const a = await source.boundingBox();
  const approach = await target.boundingBox();
  if (a === null || approach === null) throw new Error("a connect endpoint has no box on screen");

  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;

  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 20, ay + 10);
  await page.mouse.move(
    (ax + approach.x + approach.width / 2) / 2,
    (ay + approach.y + approach.height / 2) / 2,
  );
  await page.mouse.move(approach.x + approach.width / 2, approach.y + approach.height / 2);

  /*
   * Then release only once REACT FLOW says the pointer is on the handle we named.
   *
   * `connectingto` is the class it puts on the handle a release would land on, so this is
   * its own answer to "what am I about to connect", not our guess at it. Polling that
   * instead of trusting the coordinates is what makes the gesture deterministic: the
   * viewport can still be auto-panning, and the box we measured before the press can be a
   * few pixels stale by the time the pointer arrives — invisible on a node with one input,
   * and on a variadic port whose sockets are 16px apart it silently wires the layer BELOW
   * the one the spec named. Measured, twice: a drop aimed at `in2#1` arriving as `in2#2`.
   */
  let aimed = false;
  for (let attempt = 0; attempt < 12 && !aimed; attempt += 1) {
    const settled = await target.boundingBox();
    if (settled === null) throw new Error("the connect target left the screen mid-gesture");
    await page.mouse.move(settled.x + settled.width / 2, settled.y + settled.height / 2);
    aimed = await target.evaluate((node) => node.classList.contains("connectingto"));
  }
  if (!aimed) {
    // Released anyway, this would land on whatever React Flow thinks is nearest — very
    // likely the neighbouring socket — and the spec would fail three assertions later on
    // something that looks like a product bug. Say what actually went wrong, here.
    await page.mouse.up();
    throw new Error(
      `the connection never came to rest on ${to.nodeId}:${to.portId}; releasing would have wired a different socket`,
    );
  }
  await page.mouse.up();
}

/**
 * Drags a node to a new place on the canvas.
 *
 * Needed because every node the library adds lands at the same default position, and
 * overlapping nodes hide each other's handles — a connect gesture then presses on
 * whichever node happens to be on top and produces no edge.
 */
export async function moveNode(page: Page, nodeId: string, dx: number, dy: number): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const box = await node.boundingBox();
  if (box === null) throw new Error(`node "${nodeId}" has no box on screen`);
  const x = box.x + 60;
  const y = box.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/**
 * Zoom-to-fit — the keymap's own F (T469).
 *
 * Nodes render at hundreds of px each since the design system landed, so absolute drag
 * offsets overflow any fixed viewport eventually (measured: a connect target handle at
 * y=1162 in a 1000px window — every mouse event aimed at it landed nowhere). Fitting
 * after layout puts every handle on screen at whatever size nodes are this year.
 */
export async function fitAll(page: Page): Promise<void> {
  await focusGraph(page);
  // "F" is frame-ALL; lowercase "f" is frame-selected and a no-op with nothing selected.
  await page.keyboard.press("Shift+F");
  await viewportSettled(page);
}

/**
 * Waits until the canvas has stopped moving, rather than for a duration.
 *
 * A fit ANIMATES the viewport transform. Anything that measures a handle while that is in
 * flight is measuring a position the node is about to leave — which reads as flake, gets
 * "fixed" with a `waitForTimeout`, and comes back on a slower machine. Under six parallel
 * workers on this suite it is not rare: measured, a connect aimed at a socket during a
 * fit released onto its neighbour, and the spec failed three assertions downstream.
 *
 * Two identical reads of the transform are the settle condition, so a canvas that never
 * moved costs one frame and one that is mid-flight costs as long as it actually takes.
 */
export async function viewportSettled(page: Page): Promise<void> {
  const read = (): Promise<string> =>
    page.evaluate(
      () => document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "",
    );
  let previous = await read();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const current = await read();
    if (current === previous) return;
    previous = current;
  }
}

/** Selects a node so the inspector shows its parameters. Clicks the header, not the body. */
export async function selectNode(page: Page, nodeId: string): Promise<void> {
  // Frame first. T469 moved this to the NAME element because a fixed header offset landed
  // on the dock's tab strip; the name can end up under that strip too, once a gesture has
  // panned the canvas — and then Playwright reports "tablist intercepts pointer events"
  // from a helper that has nothing to do with what the spec is testing. Framing puts every
  // node back inside the pane, and it is what a user does before clicking something they
  // cannot see.
  await fitAll(page);
  // The NAME element, not a fixed header offset (T469): after a fit the node's top
  // few px can sit under the dock's tab strip, and a click at {40,8} lands on the
  // strip instead. The name is what a user clicks, and it is always inside the header.
  await page.getByTestId(`node-name-${nodeId}`).click();
  // The inspector lives in a dock tab panel titled by its pane (T436 layout shell).
  await expect(page.getByRole("tabpanel", { name: "inspector" })).toContainText(nodeId);
}

/**
 * A horizontal drag on a numeric control, in the increments a real drag produces.
 *
 * Returns every distinct value the field showed WHILE the pointer was down, because
 * §V15's claim has two halves — one history entry AND live values — and only the values
 * seen mid-gesture can speak to the second one.
 */
export async function dragNumber(
  page: Page,
  label: string,
  pixels: number,
): Promise<{ before: string; during: readonly string[]; after: string }> {
  const field = page.locator(`input[aria-label="${label}"]`);
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (box === null) throw new Error(`"${label}" has no box on screen`);
  const before = await field.inputValue();

  const startX = box.x + 30;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();

  // Every distinct value the field showed WHILE the pointer was down, recorded inside
  // the page on its own animation frames. Sampling over the wire instead would make a
  // missing live update indistinguishable from a slow round trip.
  await page.evaluate((name) => {
    const win = window as unknown as { __loomSeries?: string[] };
    win.__loomSeries = [];
    const tick = (): void => {
      const element = document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
      const series = win.__loomSeries;
      if (element !== null && series !== undefined && series[series.length - 1] !== element.value) {
        series.push(element.value);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, label);

  const steps = 20;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(startX + (pixels * step) / steps, y);
    await page.waitForTimeout(20);
  }
  const during = await page.evaluate(
    () => (window as unknown as { __loomSeries?: string[] }).__loomSeries ?? [],
  );
  await page.mouse.up();

  return { before, during, after: await field.inputValue() };
}

/** Focuses the graph so keyboard commands resolve in the `graph` keymap context (§V53). */
export async function focusGraph(page: Page): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 60, y: 60 } });
}

/**
 * The `mod` key, resolved the way the KEYMAP resolves it (`detectPlatform`, §V52).
 *
 * Asked of the page rather than of `process.platform`: the binding is data and the
 * platform test that reads it runs in the browser, so a spec that guessed from Node
 * would send Control on a mac runner and the command would simply not fire.
 */
export function modKey(page: Page): Promise<"Meta" | "Control"> {
  return page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(`${navigator.platform} ${navigator.userAgent}`)
      ? ("Meta" as const)
      : ("Control" as const),
  );
}
