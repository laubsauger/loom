import type { Gpu } from "vgpu";
import type { BackendCapabilities, CapabilityTier } from "../../../domain/types/backend.ts";
import { TEXTURE_FORMATS } from "../../../domain/types/node-definition.ts";
import type { TextureFormat } from "../../../domain/types/node-definition.ts";

/**
 * Capability discovery (§V12, §T13).
 *
 * Nothing optional is assumed. Everything here is read off the device that was actually
 * created; `timestampQuery` in particular is reported, never required — `timer(gpu)` throws
 * VGPU-TIMER-INVALID without the feature, so callers must check this flag first.
 */

/** Limits the compiler and resource caps care about (§V24). */
const REPORTED_LIMITS = [
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "maxBufferSize",
  "maxColorAttachments",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
] as const;

/**
 * RENDERABLE color formats (T96, revised for T150/B5): everything in the canonical list
 * is renderable on every conforming device, r32float included, so all of it is
 * reported. FILTERABILITY is a separate, per-binding question — r32float can always be
 * read with `textureLoad` (a data texture's natural access, §V57), and sampling it
 * through a sampler additionally needs the `float32-filterable` feature, which the
 * compiler checks per texture binding against `features` (compiler/binding-unfilterable)
 * instead of pretending the format does not exist.
 */
function supportedFormats(_features: ReadonlySet<string>): ReadonlyArray<TextureFormat> {
  return TEXTURE_FORMATS;
}

function readLimits(limits: GPUSupportedLimits): Record<string, number> {
  const source = limits as unknown as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const name of REPORTED_LIMITS) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
  }
  return out;
}

/**
 * Tier B is the product baseline: rgba16float render targets, compute, storage buffers (§C).
 * Below that the app must refuse to run; above it the extras are opportunistic.
 */
function classifyTier(features: ReadonlySet<string>, limits: Record<string, number>): CapabilityTier {
  const storageBuffers = limits["maxStorageBuffersPerShaderStage"] ?? 0;
  const computeInvocations = limits["maxComputeInvocationsPerWorkgroup"] ?? 0;
  const texture2d = limits["maxTextureDimension2D"] ?? 0;
  const storageBinding = limits["maxStorageBufferBindingSize"] ?? 0;

  if (storageBuffers < 1 || computeInvocations < 1 || texture2d < 2048) return "C";

  const headroom = texture2d >= 16384 && storageBinding >= 268_435_456;
  return headroom && features.has("float32-filterable") ? "A" : "B";
}

export function describeCapabilities(gpu: Gpu): BackendCapabilities {
  const features = new Set<string>(gpu.device.features as ReadonlySet<string>);
  const limits = readLimits(gpu.device.limits);

  return {
    tier: classifyTier(features, limits),
    features: [...features].sort(),
    formats: supportedFormats(features),
    timestampQuery: features.has("timestamp-query"),
    limits,
  };
}

/**
 * True when the device clears the product baseline (§C, §V12). The tier already encodes
 * the real checks (storage buffers, compute, texture size read off the device); the
 * format list is device-derived too, so this is no longer tautological.
 */
export function meetsBaseline(capabilities: BackendCapabilities): boolean {
  return capabilities.tier !== "C" && capabilities.formats.includes("rgba16float");
}
