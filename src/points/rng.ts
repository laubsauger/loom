/**
 * CPU mirror of the generated kernels' RNG (T120, §V74).
 *
 * Bit-for-bit the same PCG as `codegen.ts`'s WGSL: same constants, same u32 wrap-around
 * (Math.imul + >>> 0), same fold order `pcg(pcg(pcg(seed ^ pointId) ^ frame) ^ salt)`.
 * This is what lets a test — or the attribute spreadsheet's oracle — predict EXACTLY
 * what a shader will draw for a given point on a given frame, which is §V74's promise
 * made checkable. The Dawn execution test pins the two implementations against each
 * other; if either drifts, that test names the constant that moved.
 *
 * Keyed by `pointId`, never by slot (§V73): compaction moves slots, and a slot-keyed
 * draw would silently follow the wrong point across a kill.
 */

export function pointPcgReference(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const shifted = (state >>> (((state >>> 28) + 4) >>> 0)) >>> 0;
  const word = Math.imul(shifted ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

export function pointHashReference(
  seed: number,
  pointId: number,
  frameIndex: number,
  salt: number,
): number {
  const a = pointPcgReference((seed ^ pointId) >>> 0);
  const b = pointPcgReference((a ^ frameIndex) >>> 0);
  return pointPcgReference((b ^ salt) >>> 0);
}

/** Uniform in [0, 1), matching the WGSL `f32(hash) * (1.0 / 4294967296.0)`. */
export function pointRandReference(
  seed: number,
  pointId: number,
  frameIndex: number,
  salt: number,
): number {
  // Math.fround mirrors the shader's f32 rounding of the hash before the multiply.
  return Math.fround(pointHashReference(seed, pointId, frameIndex, salt)) * (1 / 4294967296);
}
