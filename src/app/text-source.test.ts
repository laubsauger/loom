import { describe, expect, it } from "vitest";

import { createTextMediaSource, cssColor } from "./text-source.ts";
import type { TextCanvas, TextRaster } from "./text-source.ts";

/**
 * Rasterizing a string into a media source (T243).
 *
 * The rasterizer is structurally typed against a canvas, which is what makes this a
 * headless test rather than a browser one — and the point of that typing: a text layout
 * whose only test needs a real browser is a text layout nobody checks.
 */

interface DrawCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fillStyle: string;
  readonly font: string;
  readonly align: string;
  readonly baseline: string;
}

/** Records what was asked of it. The size changes are as interesting as the draws. */
function recordingCanvas() {
  const draws: DrawCall[] = [];
  const fills: Array<{ style: string; width: number; height: number }> = [];
  const sizes: Array<[number, number]> = [];
  const state = { fillStyle: "", font: "", textAlign: "start", textBaseline: "alphabetic" };

  const context = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: string) {
      state.fillStyle = value;
    },
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(value: string) {
      state.textAlign = value;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(value: string) {
      state.textBaseline = value;
    },
    clearRect() {},
    fillRect(_x: number, _y: number, width: number, height: number) {
      fills.push({ style: state.fillStyle, width, height });
    },
    fillText(text: string, x: number, y: number) {
      draws.push({
        text,
        x,
        y,
        fillStyle: state.fillStyle,
        font: state.font,
        align: state.textAlign,
        baseline: state.textBaseline,
      });
    },
  };

  const canvas: TextCanvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  };
  // Width/height are plain properties on a real canvas too, so record assignments.
  const tracked = new Proxy(canvas, {
    set(target, property, value: number) {
      if (property === "width" || property === "height") {
        Reflect.set(target, property, value);
        sizes.push([target.width, target.height]);
        return true;
      }
      return Reflect.set(target, property, value);
    },
  });

  return { canvas: tracked, draws, fills, sizes };
}

const RASTER: TextRaster = {
  text: "Hello",
  font: "sans-serif",
  size: 100,
  color: [1, 0, 0, 1],
  background: [0, 0, 0, 0],
  align: "center",
  valign: "middle",
  lineSpacing: 1.2,
  width: 400,
  height: 200,
};

function sourceOver(canvas: TextCanvas) {
  return createTextMediaSource({ createCanvas: () => canvas });
}

describe("text rasterizer (T243)", () => {
  it("advances the frame id only when something changed (§V136)", () => {
    // The whole cost story. An unchanged frame id means the backend uploads nothing, and a
    // Text node's content changes when someone types — approximately never, in frame
    // terms. A source that bumped on every ask would re-upload a full-resolution canvas
    // sixty times a second to show a word that has not moved, and the texture would be
    // identical every time.
    const { canvas, draws } = recordingCanvas();
    const source = sourceOver(canvas);

    source.update(RASTER);
    const first = source.source.currentFrame()?.frameId;
    source.update({ ...RASTER });
    expect(source.source.currentFrame()?.frameId).toBe(first);
    expect(draws).toHaveLength(1);

    source.update({ ...RASTER, text: "Hello!" });
    expect(source.source.currentFrame()?.frameId).not.toBe(first);
    expect(draws).toHaveLength(2);
  });

  it("counts the resolved SIZE as a change, because the upload asserts extents (T312)", () => {
    // A generated source has no intrinsic size, so the node's resolved size is the only
    // correct extent — and it can change under the node (a resolution override, a project
    // resize). Redrawing at the new size is not cosmetic: `copyExternalImageToTexture`
    // refuses a canvas whose extents differ from the target's, so a stale canvas is a
    // failed upload rather than a scaled picture.
    const { canvas, sizes } = recordingCanvas();
    const source = sourceOver(canvas);

    source.update(RASTER);
    const first = source.source.currentFrame()?.frameId;
    source.update({ ...RASTER, width: 800, height: 600 });

    expect(source.source.currentFrame()?.frameId).not.toBe(first);
    expect(sizes.at(-1)).toEqual([800, 600]);
  });

  it("paints the colour the user picked, with no conversion in JS (§V56)", () => {
    // The canvas paints sRGB and the external texture is `rgba8unorm-srgb`, so the one
    // decode to linear happens in hardware when the shader samples. Applying a curve here
    // as well would decode twice and render a visibly washed-out string — B8's shape,
    // which is why the hook reads `entries[].value` (display space) and not `values`.
    const { canvas, draws } = recordingCanvas();
    sourceOver(canvas).update(RASTER);
    expect(draws[0]?.fillStyle).toBe("rgba(255, 0, 0, 1)");
    expect(cssColor([0.5, 0.5, 0.5, 0.25])).toBe("rgba(128, 128, 128, 0.25)");
  });

  it("centres a multi-line block as a block, not line by line", () => {
    // Only visible with two lines, and wrong in a way people notice: placing each line at
    // the centre independently would stack them from the middle downward, so adding a
    // second line pushes the first one off centre. Growing symmetrically is what someone
    // centring a caption means.
    const { canvas, draws } = recordingCanvas();
    sourceOver(canvas).update({ ...RASTER, text: "one\ntwo" });

    expect(draws.map((draw) => draw.text)).toEqual(["one", "two"]);
    const [first, second] = draws;
    const centre = RASTER.height / 2;
    expect((first as DrawCall).y).toBeLessThan(centre);
    expect((second as DrawCall).y).toBeGreaterThan(centre);
    // Symmetric about the centre: same distance either side.
    expect(centre - (first as DrawCall).y).toBeCloseTo((second as DrawCall).y - centre, 6);
  });

  it("anchors to the edge it is aligned to", () => {
    // The x it draws at is the anchor the canvas aligns against, so `right` has to be the
    // right EDGE and not the centre — an alignment that reads correct in the menu and puts
    // every string in the middle is the classic version of this bug.
    for (const [align, x] of [
      ["left", 0],
      ["center", RASTER.width / 2],
      ["right", RASTER.width],
    ] as const) {
      const { canvas, draws } = recordingCanvas();
      sourceOver(canvas).update({ ...RASTER, align });
      expect(draws[0]?.x, align).toBe(x);
      expect(draws[0]?.align, align).toBe(align);
    }
  });

  it("has no frame at all before the first update", () => {
    // §V135: the source contract says `currentFrame()` is undefined until there is one,
    // and the backend leaves the texture black. A frame of blank pixels would be a lie
    // that uploads.
    const { canvas } = recordingCanvas();
    expect(sourceOver(canvas).source.currentFrame()).toBeUndefined();
  });

  it("fills the background across the whole frame before drawing", () => {
    const { canvas, fills } = recordingCanvas();
    sourceOver(canvas).update({ ...RASTER, background: [0, 0, 1, 1] });
    expect(fills.at(-1)).toEqual({ style: "rgba(0, 0, 255, 1)", width: 400, height: 200 });
  });
});
