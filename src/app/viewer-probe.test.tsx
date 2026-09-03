import { afterEach, describe, expect, it, vi } from "vitest";
import { formatViewerReading, readViewer } from "./viewer-probe.ts";
import type { PresentationHandle, PresentationReport } from "@runtime/backend/backend-types.ts";

/**
 * T739 — the probe must SPLIT the fork it exists for.
 *
 * The owner reports a popped-out viewer that does not paint, and nobody working on this
 * project can look: there is no WebGPU in our browser environment and no DOM in Dawn. The
 * probe is the substitute for looking, so the only gate worth having is the one that
 * asserts it DISTINGUISHES the two bugs hiding under that one symptom:
 *
 *   - blits are landing and the result is black   ("presenting-black")
 *   - no blit is reaching the surface at all      ("not-presenting")
 *
 * §V655 is the reason this file does not simply assert "the report has fields" or "luma is
 * finite": a probe that answered the same thing in both cases would satisfy any structural
 * check and still be the tenth reader-that-cannot-see. So every case below is pinned to a
 * DIFFERENT verdict, and the two halves of the fork are asserted to differ from each
 * other directly — that assertion fails the moment someone collapses them.
 */

const NOW = 100_000;

function stubReadback(rgba: readonly [number, number, number, number] | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((id: string) => {
    if (id !== "2d" || rgba === null) return null;
    return {
      clearRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: Uint8ClampedArray.from(rgba) }),
    };
  }) as unknown as HTMLCanvasElement["getContext"]);
}

function canvasWithBox(css: { w: number; h: number }, store: { w: number; h: number }) {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: css.w });
  Object.defineProperty(canvas, "clientHeight", { value: css.h });
  canvas.width = store.w;
  canvas.height = store.h;
  document.body.appendChild(canvas);
  return canvas;
}

function handleWith(report: Partial<PresentationReport>): PresentationHandle {
  const full: PresentationReport = {
    id: "present-1",
    outputId: "out",
    surfaceConfigured: true,
    blitReady: true,
    sourceBound: true,
    presentedFrames: 4200,
    lastPresentTime: NOW - 8,
    deviceGeneration: 1,
    ...report,
  };
  return {
    id: full.id,
    outputId: full.outputId,
    setOutput: () => {},
    dispose: () => {},
    describe: () => full,
  };
}

function read(handle: PresentationHandle | null, canvas: HTMLCanvasElement, generation = 1) {
  return readViewer({
    canvas,
    handle,
    deviceGeneration: generation,
    appDocument: document,
    now: NOW,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("the fork the probe exists to split", () => {
  it("calls a surface that IS being blitted into, and reads black, painting black", async () => {
    stubReadback([0, 0, 0, 255]);
    const reading = await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("presenting-black");
    expect(reading.readback).toEqual({ luma: 0, alpha: 1, mechanism: "drawImage" });
  });

  it("calls a surface no blit has reached recently NOT painting at all", async () => {
    stubReadback([0, 0, 0, 255]);
    // Every other fact is identical to the case above — same box, same store, same black
    // pixels, same configured surface. ONLY the present age differs, which is precisely
    // the evidence that separates the two bugs.
    const stale = handleWith({ lastPresentTime: NOW - 9_000 });
    const reading = await read(stale, canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("not-presenting");
  });

  it("never reports the two as the same thing", async () => {
    stubReadback([0, 0, 0, 255]);
    const box = { w: 640, h: 360 };
    const store = { w: 1280, h: 720 };
    const painting = (await read(handleWith({}), canvasWithBox(box, store))).verdict;
    const silent = (
      await read(handleWith({ lastPresentTime: NOW - 9_000 }), canvasWithBox(box, store))
    ).verdict;
    expect(painting).not.toBe(silent);
  });

  it("a surface that has NEVER presented is not painting at all, not merely black", async () => {
    stubReadback([0, 0, 0, 255]);
    const never = handleWith({ lastPresentTime: null, presentedFrames: 0 });
    const reading = await read(never, canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("not-presenting");
    expect(reading.presentAgeMs).toBeNull();
  });

  it("says the GPU path is FINE when pixels are actually there, so the hunt moves downstream", async () => {
    stubReadback([0, 180, 0, 255]);
    const reading = await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("presenting");
    expect(reading.readback?.luma).toBeGreaterThan(0);
  });
});

describe("the three suspects T739 names, each with its own answer", () => {
  it("(a) §V659 — a remounted element whose surface was never configured", async () => {
    stubReadback([0, 0, 0, 255]);
    const reading = await read(
      handleWith({ surfaceConfigured: false, deviceGeneration: null, blitReady: false }),
      canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }),
    );
    expect(reading.verdict).toBe("not-configured");
  });

  it("(b) §V658 — a 1x1 backing store beats every later verdict, healthy runtime or not", async () => {
    stubReadback([0, 0, 0, 255]);
    // The runtime side is entirely healthy here: configured, bound, presenting this
    // millisecond. A probe that reported "presenting-black" would send the reader at the
    // source shader when the real fault is a dead ResizeObserver.
    const reading = await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1, h: 1 }));
    expect(reading.verdict).toBe("store-collapsed");
  });

  it("(b') a canvas with no laid-out box at all in its window", async () => {
    stubReadback([0, 0, 0, 255]);
    const reading = await read(handleWith({}), canvasWithBox({ w: 0, h: 0 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("no-css-box");
  });

  it("a surface that outlived the device it was configured against (§V23)", async () => {
    stubReadback([0, 0, 0, 255]);
    const reading = await read(
      handleWith({ deviceGeneration: 1 }),
      canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }),
      2,
    );
    expect(reading.verdict).toBe("stale-device");
  });

  it("an output that resolves to no source is not a popout fault", async () => {
    stubReadback([0, 0, 0, 255]);
    const reading = await read(
      handleWith({ sourceBound: false }),
      canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }),
    );
    expect(reading.verdict).toBe("no-source");
  });

  it("no handle at all reads as no handle, not as a black picture", async () => {
    stubReadback([0, 0, 0, 255]);
    const reading = await read(null, canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("no-handle");
  });

  it("unreadable pixels are never folded into black", async () => {
    stubReadback(null);
    const reading = await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.readback).toBeNull();
    expect(reading.verdict).toBe("presenting-unreadable");
  });

  it("§V897 — an all-zero read convicts the read path, never the picture", async () => {
    // T1093's literal shape: Chromium 151 returns [0,0,0,0] from `drawImage` of a WebGPU
    // canvas that is presenting a correct picture. The viewer surface is opaque-configured
    // (T674), so composited alpha is 1.0 by construction and alpha 0 is a reading of the
    // probe's OWN blindness. The legitimate case this control could swallow — a genuinely
    // black frame — reads [0,0,0,255] through a working mechanism and stays
    // "presenting-black" (asserted above); zero-ALPHA must land on unreadable instead.
    // (In jsdom the encode fallback is also unavailable, which is exactly the
    // both-mechanisms-blind case; the fallback SEEING is gated in the headed e2e lane,
    // presentation-pixels.spec.ts, on a real WebGPU canvas.)
    stubReadback([0, 0, 0, 0]);
    const reading = await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.verdict).toBe("presenting-unreadable");
    expect(reading.verdict).not.toBe("presenting-black");
    expect(reading.readback).toBeNull();
  });
});

describe("placement, and the one line the owner reads", () => {
  it("names the window the canvas is actually in", async () => {
    stubReadback([0, 0, 0, 255]);
    const docked = await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(docked.placement).toBe("docked");

    const other = document.implementation.createHTMLDocument("child");
    const floated = other.createElement("canvas");
    Object.defineProperty(floated, "clientWidth", { value: 640 });
    Object.defineProperty(floated, "clientHeight", { value: 360 });
    floated.width = 1280;
    floated.height = 720;
    expect((await read(handleWith({}), floated)).placement).toBe("floated");
  });

  it("carries the discriminating numbers, or it is not a report", async () => {
    stubReadback([0, 0, 0, 255]);
    // The claim being defended is "the owner reads ONE line". If the present count, the
    // present age or the luma is missing from it, that claim is false and the owner is
    // back to pasting screenshots.
    const line = formatViewerReading(
      await read(handleWith({}), canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 })),
    );
    expect(line).toContain("viewer[docked]");
    expect(line).toContain("640x360css");
    expect(line).toContain("1280x720store");
    expect(line).toContain("presents=4200");
    expect(line).toContain("last=8ms");
    expect(line).toContain("luma=0.0000");
    expect(line).toContain("via=drawImage");
    expect(line).toContain("-> presenting-black");
  });

  it("says so when the handle cannot describe itself, rather than inventing a runtime answer", async () => {
    stubReadback([0, 0, 0, 255]);
    const bare: PresentationHandle = {
      id: "p",
      outputId: "out",
      setOutput: () => {},
      dispose: () => {},
    };
    const reading = await read(bare, canvasWithBox({ w: 640, h: 360 }, { w: 1280, h: 720 }));
    expect(reading.presentation).toBeNull();
    expect(formatViewerReading(reading)).toContain("runtime=unavailable");
    // The pixels are still worth reporting, so the verdict comes from what CAN be seen.
    expect(reading.verdict).toBe("presenting-black");
  });
});
