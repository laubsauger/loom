import type { MediaSource, MediaSourceFrame } from "@runtime/backend/index.ts";

/**
 * Rasterizing a string into a `MediaSource` (T243, §V135, §V136).
 *
 * A Text node's pixels come from the browser drawing into a canvas, which makes it a
 * CPU-supplied texture arriving on its own schedule — the same seam a decoded video frame
 * arrives through (T262). So the node declares an external scratch like every media node,
 * and this module is what registers behind its sourceId. Nothing about the graph side
 * knows text exists.
 *
 * ## Why the whole string, not a glyph atlas
 *
 * The browser already does shaping, kerning, bidi, font fallback and emoji. We have no
 * per-glyph quad path, and TD's Text TOP is a full-frame layer with alignment rather than
 * a tight bounding box — so per-glyph granularity would cost a layout engine and buy
 * nothing the node wants.
 *
 * ## The frameId rule, which is the whole cost story
 *
 * §V136: an unchanged `frameId` means "nothing new" and the backend uploads nothing. Text
 * changes when someone types, which is approximately never in frame terms, so the id
 * advances only when the rasterized INPUTS change — the string, the style, or the size it
 * is drawn at. A source that bumped on every ask would re-upload a full-resolution canvas
 * sixty times a second to show a word that has not moved.
 *
 * ## Structural canvas typing
 *
 * The handful of members used here, not `CanvasRenderingContext2D`, so a test can hand in
 * a recording double and the browser can hand in an `OffscreenCanvas` — the same reason
 * `MediaElement` and `PresentableCanvas` are structural. Node has no canvas at all, and a
 * rasterizer that could only run in a browser could only be tested in one.
 */

export interface TextCanvasContext {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
}

export interface TextCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): TextCanvasContext | null;
}

export type TextAlign = "left" | "center" | "right";
export type TextVerticalAlign = "top" | "middle" | "bottom";

/** Everything that decides what the canvas holds. Two equal requests draw equal pixels. */
export interface TextRaster {
  readonly text: string;
  readonly font: string;
  /** Font size in pixels OF THE OUTPUT, so it scales with the node's resolution. */
  readonly size: number;
  /** Display-space (sRGB) rgba, 0..1 — the space a canvas paints in (§V56). */
  readonly color: readonly [number, number, number, number];
  readonly background: readonly [number, number, number, number];
  readonly align: TextAlign;
  readonly valign: TextVerticalAlign;
  /** Multiple of the font size between baselines. */
  readonly lineSpacing: number;
  /** The node's RESOLVED size (T312), not the project's — the upload asserts extents. */
  readonly width: number;
  readonly height: number;
}

export interface TextMediaSource {
  readonly source: MediaSource;
  /** Redraws if anything changed, and only then advances the frame id (§V136). */
  update(raster: TextRaster): void;
  dispose(): void;
}

export interface TextSourceOptions {
  /** Injectable so a test needs no DOM. Defaults to OffscreenCanvas, then a DOM canvas. */
  readonly createCanvas?: (width: number, height: number) => TextCanvas | null;
}

/** 0..1 display-space rgba to a CSS colour. The canvas paints sRGB; so does this. */
export function cssColor(rgba: readonly [number, number, number, number]): string {
  const channel = (value: number): number =>
    Math.max(0, Math.min(255, Math.round((Number.isFinite(value) ? value : 0) * 255)));
  const alpha = Math.max(0, Math.min(1, Number.isFinite(rgba[3]) ? rgba[3] : 1));
  return `rgba(${channel(rgba[0])}, ${channel(rgba[1])}, ${channel(rgba[2])}, ${alpha})`;
}

/** Identity of a drawing. Anything absent from this key cannot change the pixels. */
function rasterKey(raster: TextRaster): string {
  return JSON.stringify([
    raster.text,
    raster.font,
    raster.size,
    raster.color,
    raster.background,
    raster.align,
    raster.valign,
    raster.lineSpacing,
    raster.width,
    raster.height,
  ]);
}

function defaultCanvasFactory(width: number, height: number): TextCanvas | null {
  const offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => unknown })
    .OffscreenCanvas;
  if (offscreen !== undefined) return new offscreen(width, height) as TextCanvas;
  const doc = (globalThis as { document?: { createElement(tag: string): unknown } }).document;
  if (doc === undefined) return null;
  const canvas = doc.createElement("canvas") as TextCanvas;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Where each line's baseline goes.
 *
 * The block is laid out as a whole and then placed, rather than each line being placed
 * independently: with `middle` the CENTRE of the block lands at the centre of the frame, so
 * adding a second line grows the text symmetrically instead of pushing the first line up.
 * That is what someone centring a caption expects, and it is only visible with two lines.
 */
function baselineFor(raster: TextRaster, lineIndex: number, lineCount: number): number {
  const lineHeight = raster.size * Math.max(raster.lineSpacing, 0.01);
  const block = lineHeight * lineCount;
  if (raster.valign === "top") return lineIndex * lineHeight;
  if (raster.valign === "bottom") return raster.height - block + (lineIndex + 1) * lineHeight;
  return raster.height / 2 - block / 2 + (lineIndex + 0.5) * lineHeight;
}

function anchorX(raster: TextRaster): number {
  if (raster.align === "left") return 0;
  if (raster.align === "right") return raster.width;
  return raster.width / 2;
}

const CANVAS_BASELINE: Record<TextVerticalAlign, string> = {
  top: "top",
  middle: "middle",
  bottom: "bottom",
};

export function createTextMediaSource(options: TextSourceOptions = {}): TextMediaSource {
  const createCanvas = options.createCanvas ?? defaultCanvasFactory;
  let canvas: TextCanvas | null = null;
  let frame: MediaSourceFrame | undefined;
  let key: string | null = null;
  let frameId = 0;
  let disposed = false;

  const draw = (raster: TextRaster): void => {
    const width = Math.max(1, Math.floor(raster.width));
    const height = Math.max(1, Math.floor(raster.height));
    if (canvas === null) canvas = createCanvas(width, height);
    if (canvas === null) return;
    // Setting either dimension also clears the canvas, which is why the fill below is
    // unconditional rather than "only when the background is opaque".
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const context = canvas.getContext("2d");
    if (context === null) return;

    context.clearRect(0, 0, width, height);
    context.fillStyle = cssColor(raster.background);
    context.fillRect(0, 0, width, height);

    context.font = `${Math.max(1, raster.size)}px ${raster.font}`;
    context.textAlign = raster.align;
    context.textBaseline = CANVAS_BASELINE[raster.valign];
    context.fillStyle = cssColor(raster.color);

    const lines = raster.text.split("\n");
    const x = anchorX(raster);
    lines.forEach((line, index) => {
      context.fillText(line, x, baselineFor(raster, index, lines.length));
    });

    frameId += 1;
    frame = { frameId, image: canvas };
  };

  return {
    source: {
      currentFrame: () => frame,
    },
    update(raster) {
      if (disposed) return;
      const next = rasterKey(raster);
      // §V136: nothing changed, nothing uploads. This is the whole reason a Text node
      // costs nothing per frame while a video costs one upload per decoded frame.
      if (next === key) return;
      key = next;
      draw(raster);
    },
    dispose() {
      disposed = true;
      canvas = null;
      frame = undefined;
    },
  };
}
