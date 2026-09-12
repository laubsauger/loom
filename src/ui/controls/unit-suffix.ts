import type { NumberParameter } from "@domain/types/parameters.ts";

/**
 * Unit symbols for the numeric control (doc §8.1), split out of `number-field.tsx` by
 * T1315b so that file exports only components and Fast Refresh can swap them.
 */

/** doc §8.1 — "Parameters show units". Symbols, not words: the row is 20 px tall. */
const UNIT_SUFFIX: Readonly<Record<NonNullable<NumberParameter["unit"]>, string>> = {
  px: "px",
  percent: "%",
  degrees: "°",
  radians: "rad",
  seconds: "s",
  hz: "Hz",
};

export function unitSuffix(unit: NumberParameter["unit"]): string | null {
  return unit === undefined ? null : UNIT_SUFFIX[unit];
}
