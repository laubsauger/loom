import { TONAL_FIELD_NAMES, type AudioTonalFields } from "./tonal-fields.ts";

/**
 * T1751b — every tonal field its own non-zero number (§V461): `chroma0` is `base`, each
 * field after it one hundredth more, so a dropped or crossed field cannot round-trip. Not
 * a plausible record (a chord root of 0.4 is no root); a fixture for projection and codec
 * tests, which is what makes it safe to use where plausibility would hide a swap.
 */
export function distinctTonalFields(base: number): AudioTonalFields {
  return Object.fromEntries(TONAL_FIELD_NAMES.map((name, index) => [name, base + index / 100])) as unknown as AudioTonalFields;
}
