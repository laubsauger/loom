import { validateFloatMap, type FloatMap } from "./float-map.ts";
import { farIsHigh, preparedMetadata } from "./prepared-map.ts";

export interface DepthImageEnvelope {
  readonly version: 1;
  readonly encoding: "unorm16" | "float32";
  readonly low: number;
  readonly high: number;
  readonly inverse: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** Numerical storage only: palettes and colour transfer never enter this path. */
export function depthImageEnvelope(map: FloatMap, encoding: DepthImageEnvelope["encoding"]): DepthImageEnvelope {
  validateFloatMap(map);
  let low = Infinity, high = -Infinity;
  for (const value of map.values) { low = Math.min(low, value); high = Math.max(high, value); }
  let inverse = false;
  if (Object.hasOwn(map.metadata ?? {}, "preparation")) {
    const preparation = preparedMetadata(map);
    low = preparation.range.low; high = preparation.range.high;
    // Integer exports normalize the actual source range, clipping unused model padding.
    inverse = preparation.version === 2 && farIsHigh(preparation.semantics);
  }
  return { version: 1, encoding, low, high, inverse, ...(map.metadata === undefined ? {} : { metadata: map.metadata }) };
}

export function depthImageEnvelopeText(envelope: DepthImageEnvelope): string {
  const text = JSON.stringify(envelope);
  if (new TextEncoder().encode(text).byteLength > 1_048_576) throw new Error("Depth image metadata exceeds 1 MiB.");
  return text;
}

export function unorm16DepthSamples(map: FloatMap, envelope: DepthImageEnvelope): Uint16Array {
  const result = new Uint16Array(map.values.length);
  for (let index = 0; index < result.length; index++) {
    const raw = envelope.high === envelope.low ? 0.5 : (map.values[index]! - envelope.low) / (envelope.high - envelope.low);
    const normalized = Math.max(0, Math.min(1, raw));
    result[index] = Math.round((envelope.inverse ? 1 - normalized : normalized) * 65535);
  }
  return result;
}

export function depthImageSampleCount(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 64_000_000)
    throw new Error("Depth image dimensions must be positive integers with at most 64 million samples.");
  return width * height;
}

/** Untagged files are explicit raw numerical maps; tagged files retain preparation. */
export function restoreDepthImage(width: number, height: number, samples: Float32Array,
  text: string | undefined, encoding: DepthImageEnvelope["encoding"], format: string): FloatMap {
  if (samples.length !== depthImageSampleCount(width, height)) throw new Error("Depth image samples do not match dimensions.");
  let metadata: Record<string, unknown> | undefined;
  let values = samples;
  if (text !== undefined) {
    if (new TextEncoder().encode(text).byteLength > 1_048_576) throw new Error("Depth image metadata exceeds 1 MiB.");
    const envelope = JSON.parse(text) as DepthImageEnvelope;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) || envelope.version !== 1 || envelope.encoding !== encoding ||
      !Number.isFinite(envelope.low) || !Number.isFinite(envelope.high) || envelope.low > envelope.high || typeof envelope.inverse !== "boolean" ||
      Object.keys(envelope).some(key => !["version", "encoding", "low", "high", "inverse", "metadata"].includes(key))) throw new Error("Invalid depth image metadata.");
    if (encoding === "unorm16") {
      values = new Float32Array(samples.length);
      for (let index = 0; index < samples.length; index++) {
        const value = samples[index]!;
        if (value < 0 || value > 1) throw new Error("Invalid normalized depth image sample.");
        values[index] = envelope.low + (envelope.inverse ? 1 - value : value) * (envelope.high - envelope.low);
      }
    }
    if (envelope.metadata !== undefined) validateFloatMap({ width, height, values, metadata: envelope.metadata });
    metadata = encoding === "float32" ? envelope.metadata
      : { ...envelope.metadata, interchange: { version: 1, format, encoding } };
  }
  const map: FloatMap = { width, height, values, ...(metadata === undefined ? {} : { metadata }) };
  validateFloatMap(map);
  if (Object.hasOwn(metadata ?? {}, "preparation")) preparedMetadata(map);
  return map;
}
