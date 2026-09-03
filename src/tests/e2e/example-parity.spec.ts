import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APP_VIEWPORT, openApp } from "./app.ts";

/**
 * T1096 — a shipped example, rendered by the LIVE APP, compared per-pixel against Dawn.
 *
 * The checker gate (`presentation-pixels.spec.ts`) proved the presentation layer
 * byte-exact for a graph built in the test. What it cannot say is whether a SHIPPED
 * example still looks like itself through the app — the E14 black viewer and the E54
 * stale digest both lived in that gap: §V885's look baselines run through Dawn headless
 * and never touch the app path (compile, animator, transport, presentation, compositing).
 *
 * ## The clock, and why Dawn frames are addressed BY ABS (§T1098)
 *
 * No shipped example is timeline-anchored throughout — measured: every animated document
 * carries at least one free-running input (an LFO, or a Noise `speed`, whose axis is
 * `frameU.absTime`, "FREE-RUNNING (§V436, T497)" in `noise.wgsl.ts` — E3's own document
 * docblock still says `timeSeconds` and is stale). The live absolute clock is NOT reset
 * by seek (§T467 resets it only in the render path), so the app's picture at a seeked
 * frame depends on how many frames the session has ever rendered.
 *
 * So the gate treats abs as what it is — an INPUT — and measures it from the app through
 * a product path: a disconnected Constant node whose Value carries the expression
 * `abstime * fps`, read from the inspector's live display. Disconnected means pruned
 * (§V25): the probe changes no pixel, and the Dawn twin compiles the ORIGINAL document
 * to the identical pruned plan. E3 is chosen because abs is its ONLY clock — nothing in
 * the graph reads timeline time, no audio, no media, no points, no temporal state — so
 * Dawn's ordinary frame k (where time = abs = k/fps) shows exactly the picture the app
 * holds at abs k, and no synthetic transport is needed at all.
 *
 * ## Why the comparison can be EXACT (2/255, derived not tuned)
 *
 *  - **Resolution.** The blit stretches the project-res target over the pane-sized
 *    canvas, so the spec dissolves the resampling instead of tolerating it: the canvas
 *    is pinned to integer page geometry (a fractional CSS box measured 389.5×218.5
 *    invites the compositor to rasterise off the device-pixel grid), and the PROJECT
 *    RESOLUTION is set to the same size through the real settings UI. A 1:1 blit is
 *    §V47's exact regime, and §V627 cannot open a gap: both sides render identical
 *    accumulation at one resolution.
 *
 *  - **Readback.** Measured (T1096 derisk): a WebGPU canvas presenting (0.25, 0.5,
 *    0.75, 1) screenshots as exactly [64,128,191,255] — the compositor is byte-lossless
 *    for arbitrary values, not just the 0/255 fixed points the checker leaned on.
 *
 *  - **Encoding.** No transfer function appears anywhere in the comparison: whatever the
 *    Output node's display pass writes into `$target` (the §T1091 question), the app
 *    blits it unchanged to the glass and Dawn reads the same bytes back — so the spec
 *    quantises Dawn's float target with round(clamp(v)·255) and compares bytes. The
 *    residual is cross-implementation float difference (`TOLERANCE_CROSS_GPU`, one 8-bit
 *    quantum) which can land the two quantisations on adjacent quanta: the bound is 2
 *    byte-steps per channel. E3's noise lattice is integer-hashed (bit-exact across
 *    implementations); only its cos/sin gradients carry ULP room. A SYSTEMATIC offset
 *    instead of scattered adjacent quanta would be a real finding about what the surface
 *    view encodes — report it, never widen the bound (§V147).
 *
 *  - **Alpha.** The viewer surface is opaque-configured (T674): composited glass alpha
 *    is 255 regardless of source alpha, RGB passes through unpremultiplied. RGB is
 *    compared against Dawn; alpha is asserted 255.
 *
 * ## The standing red-verify: the gate sees the clock
 *
 * After the exact match at abs k, the SAME glass is compared against Dawn's frame k+1
 * and required to FAIL. A parity gate that cannot distinguish adjacent clock states
 * would pass on a frozen app — the E14/E54 class this gate exists to catch — and this
 * assertion keeps that proof in every run instead of in one red-verify anecdote. The
 * two pinned states are also required to differ from each other on the glass.
 */

test.use({ viewport: APP_VIEWPORT });

const EXAMPLE_FILE = "E3-Animated-Noise-Field.loom.json";
const EXAMPLE_CARD = /E3 Animated Noise Field/;
/** Two pinned states, addressed by timeline seeks; their abs values are read, not assumed. */
const SEEKS = [0, 90] as const;
/** Canvas pin: integer origin and size, 16:9 like the example. */
const STORE = { width: 384, height: 216 } as const;

test("Dawn renders a shipped example inside the Playwright worker", async () => {
  // T1096's single point of failure, kept as the lane's premise test: `vgpu/node` (a
  // native module) loading in Playwright's node worker through the tsconfig aliases.
  const { nodeGpuHost, probeDawn } = await import("@runtime/backend/vgpu/node-gpu-host.ts");
  const probe = await probeDawn();
  expect(probe.error, `Dawn is unavailable in this worker: ${probe.error ?? ""}`).toBeUndefined();

  const { renderHeadless } = await import("@/tests/headless/render-harness.ts");
  const { document: doc } = await loadExample();
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: doc.graph,
    settings: doc.settings,
    frames: 1,
    capture: [0],
    animate: true,
    outputNodeId: "out",
  });
  expect(result.frames[0]?.bytes.length).toBeGreaterThan(0);
});

async function loadExample() {
  const { listExamples } = await import("@/examples/catalogue.ts");
  const { requireExample } = await import("@/examples/runner.ts");
  const file = listExamples().find((entry) => entry.fileName === EXAMPLE_FILE);
  if (file === undefined) throw new Error(`${EXAMPLE_FILE} is not shipped`);
  return requireExample(file);
}

/** Raw RGBA bytes of the viewer canvas, read off the compositor (see the file docblock). */
async function glassBytes(page: Page): Promise<{ width: number; height: number; bytes: Buffer }> {
  const shot = await page.getByTestId("viewer-canvas").screenshot();
  const raw = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const copy = document.createElement("canvas");
    copy.width = image.naturalWidth;
    copy.height = image.naturalHeight;
    const ctx = copy.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("no 2d context for the decode copy");
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let binary = "";
    for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index] ?? 0);
    return { width: copy.width, height: copy.height, base64: btoa(binary) };
  }, shot.toString("base64"));
  return { width: raw.width, height: raw.height, bytes: Buffer.from(raw.base64, "base64") };
}

/** Click-to-edit, type, commit — the NumberField contract parameter-drag.spec pinned. */
async function typeInto(page: Page, label: string, value: string): Promise<void> {
  const field = page.locator(`input[aria-label="${label}"]`);
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await expect(field).not.toHaveAttribute("readonly", /.*/);
  await field.fill(value);
  await field.press("Enter");
}

test("E3 through the live app matches Dawn per-pixel, addressed by the absolute clock", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openApp(page);

  // Open the shipped example through the real open path. Keyboard activation,
  // deliberately: the library's hover card opens over the row on pointer hover and can
  // swallow the click that follows; focus + Enter is the same button activation with no
  // pointer to intercept.
  await page.getByRole("tab", { name: "examples" }).click();
  const card = page.getByRole("button", { name: EXAMPLE_CARD }).first();
  await card.focus();
  await card.press("Enter");
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 15_000 });

  // A frame must have reached the glass before anything below means anything.
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const probe = (
            window as unknown as {
              loomViewerProbe?: () => Promise<{
                presentation: { presentedFrames: number; sourceBound: boolean } | null;
              }>;
            }
          ).loomViewerProbe;
          const presentation = (await probe?.())?.presentation ?? null;
          return presentation !== null && presentation.sourceBound && presentation.presentedFrames > 0;
        }),
      { message: "the runtime never presented the example into the viewer canvas" },
    )
    .toBe(true);

  const { document: doc } = await loadExample();
  const { projectFps } = await import("@domain/types/graph.ts");
  const fps = projectFps(doc.settings);

  // The abs probe: a DISCONNECTED Constant whose Value is the expression `abstime*fps`.
  // Pruned from the plan (§V25), so it changes no pixel — it exists so the app itself
  // reports the one input the timeline does not determine (§T1098). The library card
  // opened the examples tab, so switch the dock back to the node library first.
  await page.getByRole("tab", { name: "node library" }).click();
  // NOT `addNode`: its "the new node is the nth React Flow child" assumption holds on
  // an empty canvas and breaks on a loaded example, where render order is not append
  // order — measured: it handed back "warp", and the spec then drove the wrong node.
  const idsOf = () =>
    page.$$eval(".react-flow__node", (nodes) => nodes.map((node) => node.getAttribute("data-id")));
  const before = await idsOf();
  await page
    .locator('section[aria-label="value"] button', { hasText: /^Constant/ })
    .first()
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before.length + 1);
  const after = await idsOf();
  const added = after.filter((id) => id !== null && !before.includes(id));
  expect(added, `expected exactly one new node, got ${added.join(",")}`).toHaveLength(1);
  const probeId = added[0] ?? "";
  // The library drops the new node at a default spot that in E3 sits under warp's live
  // preview, which intercepts every click aimed at it — so untangle with the product's
  // own layout-all (`l`, `graph.layoutAll`; positions are not render inputs) and then
  // select by clicking the name. Not `selectNode`: it asserts the node ID appears in
  // the inspector, and the panel titles itself with the NAME ("constant1"), not the
  // generated id ("nd_…") — the Value row appearing IS the selection check.
  const { fitAll, focusGraph } = await import("./app.ts");
  await focusGraph(page);
  await page.keyboard.press("l");
  await fitAll(page);
  const valueField = page.locator('input[aria-label="Value"]');
  for (let attempt = 0; ; attempt += 1) {
    await page.getByTestId(`node-name-${probeId}`).click();
    await page.waitForTimeout(400);
    if (await valueField.isVisible()) break;
    if (attempt >= 3) throw new Error("the Constant's Value row never appeared in the inspector");
    await fitAll(page);
  }
  // The mode panel is collapsed until asked for; the parameter's LABEL is the button
  // that expands it. Then Expression mode, then the payload.
  const inspector = page.getByRole("tabpanel", { name: "inspector" });
  await inspector.getByRole("button", { name: "Value", exact: true }).click();
  await inspector
    .getByRole("group", { name: "Value mode" })
    .getByRole("button", { name: /^Expression/ })
    .click();
  const expression = page.locator('input[aria-label="Value expression"]');
  await expect(expression).toBeVisible();
  await expression.fill(`abstime * ${fps}`);
  await expression.press("Enter");

  // Pause, VERIFIED by the label flip — the header buttons live inside tooltip wrappers
  // that can swallow a pointer click.
  const pauseButton = page.getByRole("button", { name: "Pause", exact: true });
  await pauseButton.focus();
  await pauseButton.press("Enter");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  /*
   * Pin the canvas to INTEGER page geometry. The pane layout hands the canvas a
   * fractional CSS box (measured: 389.5×218.5 → an element screenshot of 390×219 with a
   * row of neighbour pixels), and a fractional origin invites the compositor to
   * rasterise the layer off the device-pixel grid — a half-pixel smear constant regions
   * cannot see and a noise field cannot survive. The presentation path is untouched:
   * same element, same GPU context, same blit; the ResizeObserver sizes the store to
   * the pinned box exactly as it would for any pane resize.
   */
  await page.evaluate(({ width, height }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-testid="viewer-canvas"]');
    if (canvas === null) throw new Error("no viewer canvas");
    canvas.style.position = "fixed";
    canvas.style.left = "8px";
    canvas.style.top = "300px";
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.zIndex = "2147483647";
  }, STORE);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            'canvas[data-testid="viewer-canvas"]',
          );
          return canvas === null ? "gone" : `${canvas.width}x${canvas.height}`;
        }),
      { message: "the ResizeObserver never resized the store to the pinned box" },
    )
    .toBe(`${STORE.width}x${STORE.height}`);

  // Dissolve the resampling from the stable side: project resolution := the store.
  await page.getByRole("button", { name: "Project settings" }).click();
  await typeInto(page, "width", String(STORE.width));
  await typeInto(page, "height", String(STORE.height));
  // The settings dialog is MODAL — its overlay swallows every pointer event while open.
  await page.keyboard.press("Escape");
  await expect(page.locator('input[aria-label="width"]')).toHaveCount(0);
  // And the edit must have APPLIED, or the blit still resamples and the whole
  // comparison measures a blur: the viewer's own resolved-output readout is the check.
  await expect(
    page.getByRole("tabpanel", { name: "viewer" }).locator('dl[aria-label="Resolved output"]'),
  ).toContainText(`${STORE.width} × ${STORE.height}`, { timeout: 10_000 });

  const { nodeGpuHost } = await import("@runtime/backend/vgpu/node-gpu-host.ts");
  const { renderHeadless } = await import("@/tests/headless/render-harness.ts");
  const { decodeComponents } = await import("@/tests/headless/pixel-compare.ts");

  /** Dawn's frame k, quantised to glass bytes with round(clamp(v)*255). Cached per k. */
  const dawnCache = new Map<number, Uint8ClampedArray>();
  const dawnAt = async (abs: number): Promise<Uint8ClampedArray> => {
    const cached = dawnCache.get(abs);
    if (cached !== undefined) return cached;
    // E3's only clock is abs, and Dawn's ordinary frame k carries abs = k — so the
    // reference for abs k is simply frame k, plus k+1 for the standing red-verify.
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: doc.graph,
      settings: {
        ...doc.settings,
        outputResolution: { width: STORE.width, height: STORE.height },
        /*
         * THE LIVE-SEED PIN (found by this gate, T1096; reported for its own T-number).
         *
         * The live app never wires `settings.randomSeed` into its transport:
         * `use-frame-loop.ts` builds `liveClock({ fps, presenting })` with no seed and
         * calls `transport.reset()` with no seed, so `liveClock` line 111 leaves it 0,
         * `shared-uniforms.ts:91` writes that 0 into `frameU.randomSeed` every frame,
         * and every generator XORs with 0 — the project's Determinism seed reaches
         * offline renders and every headless test, and never a live picture (§V45's
         * live half). E3 ships `randomSeed: 7`, so the glass and the Dawn baseline
         * show two different noise fields with identical statistics — measured here:
         * ~70% of components off with a flat dawn→glass mapping, then byte-exact the
         * moment the twin renders with seed 0.
         *
         * So the twin pins seed 0 — the app's ACTUAL input, measured, like abs — and
         * the tripwire below fails the day the app starts honouring the project seed,
         * so this pin cannot outlive the defect.
         */
        randomSeed: 0,
      },
      frames: abs + 2,
      capture: [abs, abs + 1],
      animate: true,
      outputNodeId: "out",
    });
    for (const frame of result.frames) {
      const components = decodeComponents(frame.bytes, frame.format);
      const bytes = new Uint8ClampedArray(components.length);
      for (let index = 0; index < components.length; index += 1) {
        bytes[index] = Math.round(Math.min(1, Math.max(0, components[index] ?? 0)) * 255);
      }
      dawnCache.set(frame.frameIndex, bytes);
    }
    const wanted = dawnCache.get(abs);
    if (wanted === undefined) throw new Error(`Dawn returned no frame ${abs}`);
    return wanted;
  };

  /** Byte-level compare, RGB within `bound` quanta, alpha exactly 255. A number, not a verdict. */
  const compare = (
    glass: Buffer,
    reference: Uint8ClampedArray,
    bound: number,
  ): { failing: number; total: number; worst: string } => {
    let failing = 0;
    let worstDiff = 0;
    let worst = "none";
    const pixels = Math.floor(reference.length / 4);
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        const index = pixel * 4 + channel;
        const seen = glass[index] ?? -1;
        const want = channel === 3 ? 255 : (reference[index] ?? -1);
        const diff = Math.abs(seen - want);
        const limit = channel === 3 ? 0 : bound;
        if (diff > limit) {
          failing += 1;
          if (diff > worstDiff) {
            worstDiff = diff;
            worst = `pixel ${pixel} channel ${channel}: glass ${seen}, dawn ${want} (diff ${diff})`;
          }
        }
      }
    }
    return { failing, total: pixels * 4, worst };
  };

  // Cross-implementation float difference lands the two quantisations on adjacent
  // quanta at most: 1 quantum of float disagreement + 1 of rounding = 2. Derived in the
  // file docblock; never to be widened past it — a systematic offset is a finding.
  const BOUND = 2;

  /** The probe's live display: the app's own report of its absolute clock, in frames. */
  const absFrames = async (): Promise<number> => {
    const text = await page.locator('input[aria-label="Value"]').inputValue();
    const value = Number(text);
    expect(Number.isFinite(value), `the abs probe read "${text}"`).toBe(true);
    return Math.round(value);
  };

  const seek = async (frame: number): Promise<void> => {
    await typeInto(page, "Frame", String(frame));
    await expect(page.locator('input[aria-label="Frame"]')).toHaveValue(String(frame));
  };

  const captured: Buffer[] = [];
  const absAt: number[] = [];
  for (const seekTo of SEEKS) {
    await seek(seekTo);
    await expect
      .poll(
        async () => {
          // Read abs, read the glass, read abs again: a recompile or replay landing
          // between the two renders a picture belonging to a different clock, and the
          // comparison must never blame the pixels for that race.
          const before = await absFrames();
          const glass = await glassBytes(page);
          const after = await absFrames();
          if (before !== after) return `abs moved ${before} -> ${after} mid-read`;
          if (glass.width !== STORE.width || glass.height !== STORE.height) {
            return `canvas is ${glass.width}x${glass.height}, expected ${STORE.width}x${STORE.height}`;
          }
          const result = compare(glass.bytes, await dawnAt(before), BOUND);
          if (result.failing === 0) {
            captured[seekTo] = glass.bytes;
            absAt[seekTo] = before;

            // The standing red-verify: the SAME glass against Dawn's NEXT clock state
            // must fail, or the gate cannot see the clock and would pass frozen.
            const offByOne = compare(glass.bytes, await dawnAt(before + 1), BOUND);
            expect(
              offByOne.failing,
              "glass at abs k also matches Dawn at k+1 — the gate cannot see the clock",
            ).toBeGreaterThan(0);
            return "match";
          }
          return `abs ${before}: ${result.failing}/${result.total} components outside ±${BOUND}; worst ${result.worst}`;
        },
        { message: `the picture at seek(${seekTo}) never matched Dawn at the app's own abs`, timeout: 60_000 },
      )
      .toBe("match");
  }

  // And the two pinned states differ on the glass — a frozen picture matching one clock
  // state twice is the other half of the E14/E54 class.
  const first = captured[SEEKS[0]];
  const second = captured[SEEKS[1]];
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect(
    first !== undefined && second !== undefined && first.equals(second),
    "the app's picture did not change between the pinned states",
  ).toBe(false);

  // THE LIVE-SEED TRIPWIRE (see the pin above): with the defect present, Dawn at the
  // PROJECT's own seed must NOT match the glass. The day the app wires the project seed
  // into its live transport, this fails — and the fix is to delete the `randomSeed: 0`
  // pin and this assertion together, restoring the project seed as the twin's input.
  const projectSeed = doc.settings.randomSeed ?? 0;
  expect(projectSeed, "E3 no longer ships a non-zero seed; the tripwire is inert").not.toBe(0);
  const firstAbs = absAt[SEEKS[0]];
  expect(firstAbs).toBeDefined();
  if (first !== undefined && firstAbs !== undefined) {
    const seeded = await renderHeadless({
      host: nodeGpuHost(),
      graph: doc.graph,
      settings: { ...doc.settings, outputResolution: { width: STORE.width, height: STORE.height } },
      frames: firstAbs + 1,
      capture: [firstAbs],
      animate: true,
      outputNodeId: "out",
    });
    const seededFrame = seeded.frames[0];
    expect(seededFrame).toBeDefined();
    if (seededFrame !== undefined) {
      const components = decodeComponents(seededFrame.bytes, seededFrame.format);
      const bytes = new Uint8ClampedArray(components.length);
      for (let index = 0; index < components.length; index += 1) {
        bytes[index] = Math.round(Math.min(1, Math.max(0, components[index] ?? 0)) * 255);
      }
      expect(
        compare(first, bytes, BOUND).failing,
        "the glass now matches the PROJECT seed — the live-seed defect is fixed: remove the randomSeed: 0 pin and this tripwire",
      ).toBeGreaterThan(0);
    }
  }
});
