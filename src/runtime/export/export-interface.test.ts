import { describe, expect, it, vi } from "vitest";
import type { ReadbackImage, ReadbackRegion } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { PixelProbe } from "../previews/pixel-probe.ts";
import { decodePixel } from "../previews/pixel-probe.ts";
import { createExportInterface, createPixelProbe } from "./export-interface.ts";
import { alignedRowStride, cropReadback, readbackSourceFromBackend } from "./outputs.ts";
import type { ExportInterface, ExportOutput, ReadbackSource } from "./types.ts";
import { ExportError, outputRef } from "./types.ts";

/**
 * §V48 says this is the ONLY place readback happens, which makes these tests the only place
 * the rules about readback can be checked at all. Two things are being defended:
 *
 *  - the descriptor is complete and TRUE (§V60) — bytes that cannot be interpreted are the
 *    original defect this interface exists to fix;
 *  - readback never quietly happens during playback (§V7).
 */

const COLOR = outputRef("noise1");
const SECOND = outputRef("noise1", "mask");

function output(partial: Partial<ExportOutput> = {}): ExportOutput {
  return {
    ref: COLOR,
    resourceId: "target:noise1:out",
    width: 2,
    height: 2,
    format: "rgba8unorm",
    ...partial,
  };
}

/** A 2x2 image whose rows are 256-byte aligned, exactly as a real copy would produce. */
function paddedRgba8(): ReadbackImage {
  const rowStride = alignedRowStride(2, "rgba8unorm");
  const bytes = new Uint8Array(rowStride * 2);
  bytes.set([10, 20, 30, 255, 40, 50, 60, 255], 0);
  bytes.set([70, 80, 90, 255, 100, 110, 120, 255], rowStride);
  return { width: 2, height: 2, format: "rgba8unorm", rowStride, bytes };
}

function paddedHalf(): ReadbackImage {
  const rowStride = alignedRowStride(2, "rgba16float");
  const bytes = new Uint8Array(rowStride * 2);
  const view = new DataView(bytes.buffer);
  // 1.0, 0.5, -1.0, 1.0 on the second row's second pixel — the value the test reads back.
  const half = [0x3c00, 0x3800, 0xbc00, 0x3c00];
  half.forEach((value, index) => view.setUint16(rowStride + 8 + index * 2, value, true));
  return { width: 2, height: 2, format: "rgba16float", rowStride, bytes };
}

function sourceReturning(image: ReadbackImage): ReadbackSource {
  return {
    read: (_target, region) =>
      Promise.resolve(
        region.width === image.width && region.height === image.height
          ? image
          : cropReadback(image, region),
      ),
  };
}

function make(
  image: ReadbackImage,
  extra: {
    outputs?: ReadonlyArray<ExportOutput>;
    isPlaying?: () => boolean;
    onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  } = {},
): ExportInterface {
  return createExportInterface({
    source: sourceReturning(image),
    outputs: () => extra.outputs ?? [output({ format: image.format })],
    ...(extra.isPlaying ? { isPlaying: extra.isPlaying } : {}),
    ...(extra.onDiagnostic ? { onDiagnostic: extra.onDiagnostic } : {}),
  });
}

describe("§V60 — readback returns a descriptor whose bytes are interpretable", () => {
  it("returns width, height, format, rowStride and bytes, not bare bytes", async () => {
    const image = await make(paddedRgba8()).read(COLOR);
    expect(image).toMatchObject({ width: 2, height: 2, format: "rgba8unorm" });
    expect(image.rowStride).toBe(256);
    expect(image.bytes).toBeInstanceOf(Uint8Array);
  });

  it("decodes rgba8unorm at the padded stride, where a naive reader breaks", async () => {
    // Row 1 does not start at width*4. A reader that assumed it would report pixel (0,1) as
    // whatever padding happens to hold — usually zero, which looks like a black band.
    const image = await make(paddedRgba8()).read(COLOR);
    const pixel = decodePixel(image, 0, 1);
    expect(pixel?.rgba[0]).toBeCloseTo(70 / 255, 6);
    expect(pixel?.rgba[1]).toBeCloseTo(80 / 255, 6);
  });

  it("decodes rgba16float, which is uninterpretable without the format in the descriptor", async () => {
    const image = await make(paddedHalf()).read(COLOR);
    expect(image.format).toBe("rgba16float");
    const pixel = decodePixel(image, 1, 1);
    expect(pixel?.rgba).toEqual([1, 0.5, -1, 1]);
  });

  it("refuses a source that hands back a descriptor its own bytes cannot satisfy", async () => {
    // A lying descriptor is worse than none: every consumer trusts it.
    const api = createExportInterface({
      source: {
        read: () =>
          Promise.resolve({
            width: 2,
            height: 2,
            format: "rgba8unorm" as const,
            rowStride: 4,
            bytes: new Uint8Array(4),
          }),
      },
      outputs: () => [output()],
    });
    await expect(api.read(COLOR)).rejects.toThrow(/not decodable/i);
  });
});

describe("§V59 — output identity is port-scoped", () => {
  it("resolves a ref by node AND port", async () => {
    const api = make(paddedRgba8(), {
      outputs: [
        output({ ref: COLOR, resourceId: "target:noise1:out" }),
        output({ ref: SECOND, resourceId: "target:noise1:mask" }),
      ],
    });
    expect(api.describe(SECOND)?.resourceId).toBe("target:noise1:mask");
    expect(api.describe(COLOR)?.resourceId).toBe("target:noise1:out");
  });

  it("refuses an unknown port on a known node rather than falling back to the node", async () => {
    // The bug this prevents: `outputId === nodeId`, where asking for a port that does not
    // exist silently hands back "the node's output" and the caller never learns it asked
    // for something else.
    const api = make(paddedRgba8());
    await expect(api.read(SECOND)).rejects.toBeInstanceOf(ExportError);
    await expect(api.read(SECOND)).rejects.toThrow(/no output "noise1:mask"/i);
    expect(api.stats.readbacks).toBe(0);
    expect(api.stats.refused).toBe(2);
  });

  it("refuses an unknown node with the known outputs named", async () => {
    const api = make(paddedRgba8());
    await expect(api.read(outputRef("ghost"))).rejects.toThrow(/known outputs: noise1:out/i);
  });
});

describe("§V7 — readback never quietly stalls playback", () => {
  it("refuses a full-frame read while the frame loop is running", async () => {
    const api = make(paddedRgba8(), { isPlaying: () => true });
    await expect(api.read(COLOR)).rejects.toThrow(/while the frame loop is running/i);
    expect(api.stats.readbacks).toBe(0);
  });

  it("allows an explicit one, and marks it — once as a diagnostic, always in the stats", async () => {
    const onDiagnostic = vi.fn();
    const api = make(paddedRgba8(), { isPlaying: () => true, onDiagnostic });
    await api.read(COLOR, { whilePlaying: "allow" });
    await api.read(COLOR, { whilePlaying: "allow" });
    expect(api.stats.duringPlayback).toBe(2);
    // Marked, not spammed: a 60Hz warning stream is a warning nobody reads.
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      severity: "warning",
      code: "export/readback-during-playback",
    });
  });

  it("does not count a paused read as a playback read", async () => {
    const api = make(paddedRgba8(), { isPlaying: () => false });
    await api.read(COLOR);
    expect(api.stats.duringPlayback).toBe(0);
    expect(api.stats.readbacks).toBe(1);
  });

  it("lets the viewer inspect a small window while playing, but not a frame", async () => {
    // §V7 names inspect as allowed; the bound is what keeps it from becoming a frame grab.
    const api = createExportInterface({
      source: sourceReturning(paddedRgba8()),
      outputs: () => [output({ width: 1920, height: 1080 })],
      isPlaying: () => true,
      maxLiveInspectPixels: 16,
    });
    await expect(
      api.read(COLOR, { region: { x: 0, y: 0, width: 1, height: 1 }, reason: "inspect" }),
    ).resolves.toMatchObject({ width: 1, height: 1 });
    await expect(
      api.read(COLOR, { region: { x: 0, y: 0, width: 64, height: 64 }, reason: "inspect" }),
    ).rejects.toThrow(/exceeds the 16-pixel live window/i);
  });

  it("allows the recorder to read every frame — that is what recording is", async () => {
    const api = make(paddedRgba8(), { isPlaying: () => true });
    await api.read(COLOR, { reason: "recording" });
    expect(api.stats.readbacks).toBe(1);
    expect(api.stats.duringPlayback).toBe(1);
  });
});

describe("windowed reads", () => {
  it("returns a tightly packed descriptor for the window, not the whole frame", async () => {
    const api = make(paddedRgba8());
    const image = await api.read(COLOR, { region: { x: 1, y: 1, width: 1, height: 1 } });
    expect(image).toMatchObject({ width: 1, height: 1, rowStride: 4 });
    expect([...image.bytes]).toEqual([100, 110, 120, 255]);
  });

  it("refuses a window that misses the output entirely", async () => {
    const api = make(paddedRgba8());
    await expect(
      api.read(COLOR, { region: { x: 9, y: 9, width: 1, height: 1 } }),
    ).rejects.toThrow(/does not overlap/i);
  });
});

describe("the viewer's PixelProbe (T36) is satisfied by this module", () => {
  it("is assignable to the shape the preview track declared", async () => {
    // A compile-time claim as much as a runtime one: `PixelProbe` is imported from
    // src/runtime/previews/pixel-probe.ts, so this line fails to typecheck the moment the
    // two shapes drift. Neither module imports the other's implementation.
    const probe: PixelProbe = createPixelProbe(make(paddedRgba8()));
    const window: ReadbackRegion = { x: 0, y: 0, width: 1, height: 1 };
    const image = await probe.read(COLOR, window);
    expect(decodePixel(image, 0, 0)?.rgba[0]).toBeCloseTo(10 / 255, 6);
  });
});

describe("readback source over the real backend (T173)", () => {
  it("delegates read straight through, region included — no inference left", async () => {
    const calls: Array<{ id: string; region: ReadbackRegion | undefined }> = [];
    const image: ReadbackImage = {
      width: 2,
      height: 2,
      format: "rgba8unorm",
      rowStride: 8,
      bytes: new Uint8Array(16).fill(9),
    };
    const api = createExportInterface({
      source: readbackSourceFromBackend({
        readOutput: (id, region) => {
          calls.push({ id, region });
          return Promise.resolve(image);
        },
      }),
      outputs: () => [output()],
    });

    const got = await api.read(COLOR);
    expect(got).toBe(image);
    expect(calls[0]?.id).toBe(output().resourceId);
  });
});
