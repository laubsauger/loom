import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T749 — E43 SPLICE: the custom shader AS THE STAR, not as plumbing.
 *
 * Every shipped customWgsl so far is simulation infrastructure — Gray-Scott chemistry,
 * fluid velocity — buried inside a loop. This one is the thing the node is FOR in a VJ
 * rack: a per-pixel effect no stock node can express, on a picture, driven by the
 * music. Beat-quantised slicing: horizontal bands of the frame jump sideways by a
 * hash of (band, deal), blocks tear vertically on a second coarser hash, and the red
 * and blue channels split along the same displacement — the canonical glitch.
 *
 * ## The two properties the claims pin (splice-claims.gpu.test.ts)
 *
 * IDENTITY AT ZERO (§V147, first time on user WGSL): at `amount = 0` every offset
 * collapses and every read is `textureLoad` at the pixel's own integer coordinate —
 * BYTE-IDENTICAL passthrough, guaranteed by construction (no sampler, no filtering,
 * no rounding slop to forgive). Every stock node proves its no-op; user shader code
 * never has, and this is the pattern for every custom shader written after it.
 *
 * QUANTISED, NOT ANIMATED (§V681): the deal — which band jumps where — re-rolls only
 * when `floor(absTime · DEALS_PER_SECOND)` ticks. Between ticks the displacement map
 * is FROZEN (two frames inside one deal agree exactly on a static source); across a
 * tick it re-deals (they differ). Glitch that merely wobbles per-frame is noise;
 * glitch that holds and SLAMS is rhythm — that difference is the whole look, and only
 * a cross-frame claim can see it.
 *
 * `amount` arrives from the audio pattern's high band through a rest-subtracted lag
 * chain (T701: the dB-domain bands rest well above zero), so silence IS the identity.
 */
export const SPLICE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  amount: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

/* The slicing geometry. BANDS horizontal strips; every strip decides independently
   whether it jumps this deal, so quiet passages tear a strip or two and loud ones
   shred the frame — the density rides amount, not only the distance. */
const BANDS: f32 = 36.0;
const BLOCKS: vec2f = vec2f(9.0, 5.0);
const DEALS_PER_SECOND: f32 = 3.0;
/* RGB split as a fraction of the band's own jump — the fringe belongs to the tear. */
const FRINGE: f32 = 0.35;

fn hash2(a: f32, b: f32) -> f32 {
  return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture, 0));
  /* FREE-RUNNING deal clock (§V436): a timeline lap must not re-deal the glitch. */
  let deal = floor(frameU.absTime * DEALS_PER_SECOND);

  /* The band's jump: rolled per (band, deal), gated so only some bands tear, scaled
     by amount. At amount = 0 the gate closes and the offset is EXACTLY zero. */
  let band = floor(uv.y * BANDS);
  let roll = hash2(band, deal);
  let gate = select(0.0, 1.0, roll > 1.0 - clamp(params.amount, 0.0, 1.0) * 0.85);
  let jump = (hash2(band + 57.0, deal) - 0.5) * 0.34 * params.amount * gate;

  /* The block tear: a coarser grid shifts VERTICALLY on its own roll — rarer, bigger. */
  let block = floor(uv * BLOCKS);
  let brollA = hash2(block.x * 31.0 + block.y, deal + 101.0);
  let bgate = select(0.0, 1.0, brollA > 1.0 - clamp(params.amount, 0.0, 1.0) * 0.35);
  let lift = (hash2(block.x + block.y * 47.0, deal + 202.0) - 0.5) * 0.22 * params.amount * bgate;

  let displaced = vec2f(uv.x + jump, uv.y + lift);

  /* Integer-texel reads, wrapped, one per channel: the red and blue planes travel a
     little further along the SAME tear, which is what a real capture card does when
     the sync slips. textureLoad and not the sampler, so amount = 0 is byte-exact. */
  let px = (fract(displaced) * dims - vec2f(0.5, 0.5));
  let pxR = (fract(displaced + vec2f(jump * FRINGE, 0.0)) * dims - vec2f(0.5, 0.5));
  let pxB = (fract(displaced - vec2f(jump * FRINGE, 0.0)) * dims - vec2f(0.5, 0.5));
  let clampHi = dims - vec2f(1.0, 1.0);
  let g = textureLoad(inputTexture, vec2i(clamp(round(px), vec2f(0.0), clampHi)), 0);
  let r = textureLoad(inputTexture, vec2i(clamp(round(pxR), vec2f(0.0), clampHi)), 0);
  let b = textureLoad(inputTexture, vec2i(clamp(round(pxB), vec2f(0.0), clampHi)), 0);
  return vec4f(r.r, g.g, b.b, g.a);
}`;
