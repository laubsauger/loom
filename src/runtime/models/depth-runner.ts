/**
 * Depth Anything V2, run through onnxruntime-web (T385, T715).
 *
 * The two conversions live here as PURE functions, separately testable, because they are
 * where depth estimation silently goes wrong: a channel order swapped, a normalisation
 * skipped, an axis transposed. Each produces a picture that looks like a depth map and
 * is not one — §V147's family, and no gate over pixels alone would catch it.
 */

/** What the exported graph expects: ImageNet statistics, in RGB order. */
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/**
 * Our `vec4f` scratch buffer -> the model's `pixel_values`, NCHW float32.
 *
 * Two shape facts that are easy to get backwards and impossible to see afterwards:
 * the GPU hands us INTERLEAVED RGBA per texel, and the model wants PLANAR channels;
 * and the normalisation is per channel, not a single global scale.
 */
export function packModelInput(texels: Float32Array, side: number): Float32Array {
  const pixels = side * side;
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i += 1) {
    const base = i * 4;
    for (let c = 0; c < 3; c += 1) {
      const value = texels[base + c] ?? 0;
      out[c * pixels + i] = (value - MEAN[c]!) / STD[c]!;
    }
  }
  return out;
}

/**
 * The model's relative depth -> an RGBA texture at the node's resolution.
 *
 * ## Why it is normalised, and why that is a real decision
 *
 * Depth Anything emits RELATIVE inverse depth on an arbitrary scale that differs per
 * image — there is no absolute unit to preserve. So the map is stretched to 0..1 across
 * the frame's own range, which is what makes it usable by Displace at all. The cost is
 * that brightness is not comparable BETWEEN frames: a shot that gets deeper renormalises.
 * That is inherent to the model, not to this code, and it is stated in the node's
 * description rather than hidden.
 *
 * A degenerate frame — every value identical — normalises to the IDENTITY 0.5 rather than
 * to 0. Zero would read as "everything is at the far plane" and would make Displace shove
 * the whole image; 0.5 is the no-displacement value, so a flat input stays flat.
 */
/**
 * T974 — the letterbox's occupied fraction of the model square, per axis: a wide source
 * fills x and a 1/aspect band of y; a tall one the transpose. The WGSL preprocess
 * computes the identical expression; the two are pinned together by the aspect gate.
 */
export function occOf(width: number, height: number): readonly [number, number] {
  const aspect = width / Math.max(height, 1);
  return aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];
}

export function depthToRgba(
  depth: Float32Array,
  side: number,
  width: number,
  height: number,
): Uint8Array {
  /* T959 (owner): PRECISION. The model emits float32; rounding it to a byte quantised
     the whole scene to 256 depth levels — ~14 mm terracing across a metric unprojection
     (T958). The result texture is r32float now, and this returns the float texels as a
     BYTE VIEW over their own buffer (the upload contract carries raw bytes in the
     declared format), so nothing between the model and the GPU rounds anything. */
  const floats = new Float32Array(width * height);
  {
    /* T974: the preprocess LETTERBOXED the source into the model square (see
       DEPTH_PREPROCESS_WGSL — occOf is its float64 twin); this reads back ONLY the
       occupied band, so the result registers with the picture and the bars' replicated
       depth never leaks in. The normalisation range is measured over the band too — a
       bar artefact must not stretch the scene's own contrast. */
    const [occX, occY] = occOf(width, height);
    const modelAt = (x: number, y: number): number => {
      const u = ((x + 0.5) / width - 0.5) * occX + 0.5;
      const v = ((y + 0.5) / height - 0.5) * occY + 0.5;
      const sx = Math.min(side - 1, Math.max(0, Math.floor(u * side)));
      const sy = Math.min(side - 1, Math.max(0, Math.floor(v * side)));
      return depth[sy * side + sx] ?? Number.NaN;
    };
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = modelAt(x, y);
        if (!Number.isFinite(value)) continue;
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    const span = high - low;
    const flat = !Number.isFinite(span) || span <= 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const raw = modelAt(x, y);
        /* A NaN texel clamps to the near plane rather than poisoning the float texture —
           the byte path got this accidentally (Uint8Array coerces NaN to 0). */
        const value = Number.isFinite(raw) ? raw : low;
        floats[y * width + x] = flat ? 0.5 : (value - low) / span;
      }
    }
  }
  return new Uint8Array(floats.buffer);
}

/** The pre-T959 8-bit encoder, kept only for its test to pin the CONTRAST against. */
export function depthToRgbaBytes(
  depth: Float32Array,
  side: number,
  width: number,
  height: number,
): Uint8Array {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of depth) {
    if (!Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = high - low;
  const flat = !Number.isFinite(span) || span <= 0;

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    // Nearest sampling: the map is smooth and the GPU samples it bilinearly on the way
    // out, so interpolating twice would only cost time.
    const sy = Math.min(side - 1, Math.floor((y * side) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(side - 1, Math.floor((x * side) / width));
      const value = depth[sy * side + sx] ?? low;
      const unit = flat ? 0.5 : (value - low) / span;
      const byte = Math.max(0, Math.min(255, Math.round(unit * 255)));
      const at = (y * width + x) * 4;
      out[at] = byte;
      out[at + 1] = byte;
      out[at + 2] = byte;
      out[at + 3] = 255;
    }
  }
  return out;
}

/** Flat mid-grey at a given size — the identity a Depth node publishes with no result. */
export function neutralDepth(width: number, height: number): Uint8Array {
  /* T959: r32float texels — 0.5 exactly, the no-displacement identity. */
  const floats = new Float32Array(width * height).fill(0.5);
  return new Uint8Array(floats.buffer);
}

