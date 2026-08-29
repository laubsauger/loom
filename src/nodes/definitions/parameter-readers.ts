import type { ParameterValue } from "../../domain/types/parameters.ts";

/**
 * Typed reads of a node's parameter bag, plus the option lists the catalogue shares.
 *
 * The compiler has already validated every value against the node's own `ParameterSchema`
 * and filled in defaults before `compile()` is called, so a wrong-typed value cannot
 * normally arrive here. These readers still narrow rather than cast: `ParameterValue` is a
 * union, the fallback is the manifest default, and a definition that reads a key it never
 * declared gets its own default back instead of `undefined` reaching a uniform buffer as
 * `NaN`. That is the difference between a mis-typed parameter being a no-op and being a
 * black frame nobody can explain.
 *
 * Enums reach WGSL as an INDEX, and every option list is exported here so the shader's
 * `switch` and the manifest's option order have exactly one source of truth. Reordering an
 * option list without touching the matching shader would silently remap behaviour, so the
 * lists live next to the readers that translate them.
 */

export type Params = Readonly<Record<string, ParameterValue>>;

export function readNumber(params: Params, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Booleans reach WGSL as 0/1 floats: a uniform buffer cannot hold a WGSL `bool`. */
export function readFlag(params: Params, key: string, fallback: boolean): number {
  const value = params[key];
  return (typeof value === "boolean" ? value : fallback) ? 1 : 0;
}

export function readVector(
  params: Params,
  key: string,
  fallback: readonly number[],
): readonly number[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length !== fallback.length) return fallback;
  const numbers = value.filter(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
  );
  return numbers.length === fallback.length ? numbers : fallback;
}

/** RGBA. Same shape as a vector read; named separately because the intent differs. */
export function readColor(
  params: Params,
  key: string,
  fallback: readonly [number, number, number, number],
): readonly number[] {
  return readVector(params, key, fallback);
}

/** Enum option -> its index in `options`, which is what the shader switches on. */
export function readEnumIndex(
  params: Params,
  key: string,
  options: ReadonlyArray<{ value: string }>,
  fallback: string,
): number {
  const value = params[key];
  const index = options.findIndex((option) => option.value === value);
  if (index >= 0) return index;
  const fallbackIndex = options.findIndex((option) => option.value === fallback);
  return fallbackIndex >= 0 ? fallbackIndex : 0;
}

export const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Which channel of a texture drives a scalar decision. Order is load-bearing: it is the
 * index `channelValue()` in `common.wgsl.ts` switches on.
 */
export const CHANNEL_OPTIONS = [
  { value: "luminance", label: "Luminance" },
  { value: "red", label: "Red" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" },
  { value: "alpha", label: "Alpha" },
] as const;

/** Wrap behaviour outside [0,1]. Order matches `sampleExtend()` in `common.wgsl.ts`. */
export const EXTEND_OPTIONS = [
  { value: "hold", label: "Hold Edge" },
  { value: "repeat", label: "Repeat" },
  { value: "mirror", label: "Mirror" },
  { value: "zero", label: "Transparent" },
] as const;

/** TD's Transform Order menu. Order matches `invTransform2()` in `common.wgsl.ts`. */
export const TRANSFORM_ORDER_OPTIONS = [
  { value: "srt", label: "Scale Rotate Translate" },
  { value: "str", label: "Scale Translate Rotate" },
  { value: "rst", label: "Rotate Scale Translate" },
  { value: "rts", label: "Rotate Translate Scale" },
  { value: "tsr", label: "Translate Scale Rotate" },
  { value: "trs", label: "Translate Rotate Scale" },
] as const;
