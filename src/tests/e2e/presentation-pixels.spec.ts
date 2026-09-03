import { expect, test } from "@playwright/test";
import { APP_VIEWPORT, addNode, connect, fitAll, moveNode, openApp } from "./app.ts";

/**
 * T1086 — pixels through the APP, on the real canvas (§V895, §V885, §V628).
 *
 * This file runs ONLY in the `chromium-headed-gpu` project (`playwright.config.ts`):
 * headed Chromium on this machine has a real Metal WebGPU adapter, which the headless
 * lane never gets. That makes this the one suite in the project that can assert what a
 * user actually SEES — app boot → command bus → compile → vgpu backend → frame driver →
 * presentation blit → the viewer's own `<canvas>`, composited at whatever size the pane
 * gave it. Every other pixel gate (`src/tests/headless/**`) renders through Dawn with no
 * browser and no presentation surface; §V628 records six preview gates staying green
 * while the product presented black, precisely because nothing gated this path.
 *
 * ## Why the picture is a default 8x8 Checker, and why the assertion can be EXACT (§V147)
 *
 * The graph is built through the real UI (library click, drag-to-connect): Checker →
 * Output, all parameters at their defaults. Three properties make the canvas bytes
 * analytically derivable rather than tolerance-banded:
 *
 *  1. **Only 0.0 and 1.0 leave the shader.** Checker's default colours are BLACK
 *     [0,0,0,1] and WHITE [1,1,1,1], and 0 and 1 are fixed points of every transform on
 *     the road to the glass — sRGB decode of the display-space parameter, the sRGB
 *     encode/clamp in the Output pass (`toneMap: "none"`), 8-bit quantisation on the
 *     surface, and premultiplication at alpha 1. A canvas byte is exactly 0 or 255 or
 *     something is wrong.
 *
 *  2. **Resampling cannot touch a cell centre.** The blit stretches the project-res
 *     target over the pane-sized canvas, so individual texels are interpolated — but a
 *     probe at the centre of a cell is surrounded by identical texels for tens of pixels
 *     in every direction, and any filter's weighted average of a constant is that
 *     constant, exactly.
 *
 *  3. **Orientation is pinned WITHOUT assuming the uv convention.** The checker pass and
 *     the blit pass draw with the same fullscreen-triangle helper, so if its `uv.y` is
 *     flipped relative to texture memory, the flip is applied once when the checker is
 *     WRITTEN and once when it is SAMPLED, and cancels: canvas row r always shows checker
 *     `uv.y = r/height`, both axes alike. Hence the canvas's top-left cell is cell (0,0)
 *     — `parity = fract(0 * 0.5) = 0` — which is `color1`, BLACK, with no appeal to
 *     which way any one pass's v axis points.
 *
 * ## Why the read is a compositor screenshot, not `drawImage`
 *
 * The product's own probe technique (`viewer-probe.ts`, `readCanvasTexel`) — copy the
 * WebGPU canvas through a 2D context — reads ALL-ZERO on this browser: measured
 * 2026-09-03 in bundled Chromium 151.0.7922.34 headed, on an isolated page, red cleared
 * to a WebGPU canvas, `drawImage` + `getImageData` returned [0,0,0,0] under both
 * `opaque` and `premultiplied`, before and after present. (Which also means the T739
 * verdict "presenting-black" is a FALSE POSITIVE on this Chromium — a healthy presenting
 * canvas reads luma 0, alpha 0. Reported with T1086; the product fix is not this file's.)
 * So the read here is Playwright's element screenshot — the compositor's own pixels, the
 * literal glass, display-encoded (§V618) — decoded back to bytes through a lossless PNG
 * round-trip in the page. 0 and 255 are also fixed points of any display color-profile
 * conversion a headed screenshot might pick up, so exactness survives that too.
 */

test.use({ viewport: APP_VIEWPORT });

test("this lane's premise: headed Chromium has a real WebGPU adapter", async ({ page }) => {
  // The claim `app.ts` carries — "headless has no adapter, headed does" — as a standing
  // gate rather than a docblock, so it can never rot into §V895's shape again. Measured
  // against the app's own origin, NOT a data: URL: the original over-broad claim was a
  // real measurement of an opaque origin where WebGPU is correctly absent.
  await page.goto("/");
  const probe = await page.evaluate(async () => {
    if (navigator.gpu === undefined) return { gpu: false as const, adapter: null };
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) return { gpu: true as const, adapter: null };
    return {
      gpu: true as const,
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
    };
  });
  expect(probe.gpu, "navigator.gpu is undefined — not even the interface exists").toBe(true);
  expect(
    probe.adapter,
    "navigator.gpu exists but requestAdapter() resolved null — this lane is running without " +
      "a GPU (headless? no display session?), and every pixel claim in this file is untestable",
  ).not.toBeNull();
});

/** What the canvas showed at each of the 64 cell centres, or null while it cannot be read. */
interface GridReading {
  readonly width: number;
  readonly height: number;
  /** Row-major, 4 bytes per cell, straight from `getImageData`. */
  readonly cells: ReadonlyArray<ReadonlyArray<number>>;
}

test("a checker built through the UI reaches the glass with exact values", async ({ page }) => {
  await openApp(page);

  const checker = await addNode(page, "generator", "Checker");
  const output = await addNode(page, "output", "Output");
  await fitAll(page);
  await moveNode(page, output, 260, 240);
  /*
   * The connect gesture is retried, bounded. Under a live GPU the whole app renders
   * while the wire is in the air — node previews, the viewer, the frame loop — and
   * React Flow occasionally drops a release that its own `connectingto` class had
   * blessed a frame earlier (observed once in this suite's first runs: gesture
   * completed, zero edges). The retry re-performs the SAME user gesture; the claim
   * under test — pixels on the glass — is downstream of however many attempts the
   * wire took.
   */
  for (let attempt = 0; ; attempt += 1) {
    try {
      await connect(page, { nodeId: checker, portId: "out" }, { nodeId: output, portId: "input" });
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 2000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }

  // The viewer mounts its canvas once a declared sink exists and the runtime presents
  // into it (§V64). `loomViewerProbe` (T739) separates "nothing attached" from "the
  // picture is wrong": presentedFrames > 0 with a bound source means blits are landing.
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
      { message: "the runtime never presented a frame into the viewer canvas" },
    )
    .toBe(true);

  const readGrid = async (): Promise<GridReading | null> => {
    // The compositor's pixels, not the canvas's back buffer — see the file docblock for
    // why `drawImage` cannot supply this read on this browser.
    const shot = await page.getByTestId("viewer-canvas").screenshot();
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      // A store this small cannot hold 8 distinguishable columns; read it as "not yet".
      if (image.naturalWidth < 64 || image.naturalHeight < 64) return null;
      const copy = document.createElement("canvas");
      copy.width = image.naturalWidth;
      copy.height = image.naturalHeight;
      const ctx = copy.getContext("2d", { willReadFrequently: true });
      if (ctx === null) return null;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
      const cells: number[][] = [];
      for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
          const x = Math.round(((col + 0.5) / 8) * copy.width);
          const y = Math.round(((row + 0.5) / 8) * copy.height);
          const base = (y * copy.width + x) * 4;
          cells.push([
            data[base] ?? -1,
            data[base + 1] ?? -1,
            data[base + 2] ?? -1,
            data[base + 3] ?? -1,
          ]);
        }
      }
      return { width: copy.width, height: copy.height, cells };
    }, shot.toString("base64"));
  };

  // K = color1 BLACK, W = color2 WHITE: parity of (row + col), cell (0,0) top-left black
  // — see the file docblock for why that holds under any uv convention.
  const legend = (cell: ReadonlyArray<number>): string => {
    if (cell[0] === 0 && cell[1] === 0 && cell[2] === 0 && cell[3] === 255) return "K";
    if (cell[0] === 255 && cell[1] === 255 && cell[2] === 255 && cell[3] === 255) return "W";
    return "?";
  };
  const expected = Array.from({ length: 8 }, (_unused, row) =>
    Array.from({ length: 8 }, (_unused2, col) => ((row + col) % 2 === 0 ? "K" : "W")).join(""),
  ).join("/");

  // Poll first: the compile and the first presented frame land asynchronously after the
  // connect gesture. The poll's subject is already the full exact claim, so the terminal
  // failure prints which cells missed and by what bytes.
  await expect
    .poll(async () => (await readGrid())?.cells.map(legend).join("") ?? "unreadable", {
      message: `the canvas never showed the checker (expected rows ${expected})`,
    })
    .toBe(expected.replaceAll("/", ""));

  // And once stable, state the byte-level claim outright — the legend collapses 4
  // channels to one letter, this holds every channel to its exact value.
  const grid = await readGrid();
  expect(grid, "the canvas became unreadable after the poll passed").not.toBeNull();
  const failures: string[] = [];
  grid?.cells.forEach((cell, index) => {
    const row = Math.floor(index / 8);
    const col = index % 8;
    const want = (row + col) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255];
    if (!want.every((channel, c) => cell[c] === channel)) {
      failures.push(`cell(${row},${col}) expected ${want.join(",")} got ${cell.join(",")}`);
    }
  });
  expect(failures, failures.join("; ")).toEqual([]);

  // T1093 regression: with this exact picture on the glass, the probe used to report
  // `presenting-black` — drawImage of a WebGPU canvas reads [0,0,0,0] on this Chromium,
  // and the old verdict took the blind read for a black frame. §V897's control now
  // routes a zero-alpha read through the encode fallback, so a canvas showing a checker
  // must read as PRESENTING, with a readback that passed the opaque-alpha control.
  const verdict = await page.evaluate(async () => {
    const probe = (
      window as unknown as {
        loomViewerProbe?: () => Promise<{
          verdict: string;
          readback: { luma: number; alpha: number; mechanism: string } | null;
        }>;
      }
    ).loomViewerProbe;
    return (await probe?.()) ?? null;
  });
  expect(verdict?.verdict).toBe("presenting");
  expect(verdict?.readback?.alpha).toBe(1);
});

test("a genuinely black frame still reads presenting-black (§V897's legitimate case)", async ({
  page,
}) => {
  // The failure mode a positive control invites is a probe that stops reporting the
  // fault at all. Solid's default colour is opaque black, so this canvas is genuinely,
  // correctly black — and the probe must still say so, through whichever mechanism
  // passed the alpha control.
  await openApp(page);
  const solid = await addNode(page, "generator", "Solid");
  const output = await addNode(page, "output", "Output");
  await fitAll(page);
  await moveNode(page, output, 260, 240);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await connect(page, { nodeId: solid, portId: "out" }, { nodeId: output, portId: "input" });
      await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 2000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
  await expect(page.getByTestId("viewer-canvas")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const probe = (
            window as unknown as {
              loomViewerProbe?: () => Promise<{
                verdict: string;
                readback: { alpha: number } | null;
              }>;
            }
          ).loomViewerProbe;
          const reading = (await probe?.()) ?? null;
          return reading === null ? "no-probe" : `${reading.verdict}:alpha=${reading.readback?.alpha}`;
        }),
      { message: "a black frame must still be reported black, with the alpha control passed" },
    )
    .toBe("presenting-black:alpha=1");
});
