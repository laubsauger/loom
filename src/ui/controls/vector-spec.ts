import type { VectorParameter } from "@domain/types/parameters.ts";
import type { NumericSpec } from "./types.ts";

/**
 * Axis naming and range derivation for the vector control (T37), split out of
 * `vector-field.tsx` by T1315b so that file exports only components and Fast Refresh
 * can swap them.
 *
 * Axis names, not indices — a vec3 offset reads as x/y/z, and the accessible name of
 * each field is "<label> x", which is what a screen reader needs to tell them apart.
 */

export const AXIS_LABELS = ["x", "y", "z", "w"] as const;

export function specForVector(definition: VectorParameter): NumericSpec {
  return {
    ...(definition.min === undefined ? {} : { min: definition.min }),
    ...(definition.max === undefined ? {} : { max: definition.max }),
    ...(definition.range === undefined ? {} : { range: definition.range }),
    ...(definition.step === undefined ? {} : { step: definition.step }),
  };
}
