import type { Gpu } from "vgpu";
import type {
  AdapterIdentity,
  BackendCapabilities,
  CapabilityTier,
} from "../../../domain/types/backend.ts";
import { TEXTURE_FORMATS } from "../../../domain/types/node-definition.ts";
import type { TextureFormat } from "../../../domain/types/node-definition.ts";

/**
 * Capability discovery (§V12, §T13).
 *
 * Nothing optional is assumed. Everything here is read off the device that was actually
 * created; `timestampQuery` in particular is reported, never required — `timer(gpu)` throws
 * VGPU-TIMER-INVALID without the feature, so callers must check this flag first.
 *
 * B172: reading the device is necessary and was not sufficient. A WebGPU device carries an
 * optional feature ONLY IF `requestDevice` named it, so `features.has("timestamp-query")`
 * over a request that never asked is false on every machine in the world — which is what
 * shipped, and what made an honest "unavailable" panel permanently wrong about the cause.
 * The host now negotiates the ask (`negotiatedFeatures`) and hands it back here, so the
 * report says both what was GRANTED and what was ASKED FOR.
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
function supportedFormats(): ReadonlyArray<TextureFormat> {
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

/**
 * B173 (§T381): the adapter identity of the device we are HOLDING.
 *
 * `GPUDevice.adapterInfo` is the granted adapter's own description — not the probe's
 * (a multi-GPU machine can hand vgpu an adapter the probe never saw) and not an echo of
 * the `powerPreference` we asked for. Reading it off the live device is the only way the
 * report can contradict the request, which is the entire point of measuring.
 *
 * Undefined when the device exposes nothing: Dawn and the mock host have no
 * `adapterInfo`, and a browser may mask it. Saying nothing beats naming a guess (§V328).
 */
export function grantedAdapter(gpu: Gpu): AdapterIdentity | undefined {
  const native = (gpu.device as { gpu?: { adapterInfo?: unknown } }).gpu;
  const info = native?.adapterInfo as Partial<AdapterIdentity> | undefined;
  if (info === undefined || info === null) return undefined;
  const identity: AdapterIdentity = {
    vendor: typeof info.vendor === "string" ? info.vendor : "",
    architecture: typeof info.architecture === "string" ? info.architecture : "",
    device: typeof info.device === "string" ? info.device : "",
    description: typeof info.description === "string" ? info.description : "",
  };
  // Every field masked is the same as no identity at all — reporting four empty strings
  // would render as a blank row that looks like a bug rather than like a privacy setting.
  return Object.values(identity).some((value) => value !== "") ? identity : undefined;
}

export function describeCapabilities(
  gpu: Gpu,
  /**
   * B172: what the device request ASKED FOR (`GpuSession.requestedFeatures`). WebGPU
   * grants an optional feature only if it was named, so "absent" has two causes — the
   * adapter did not offer it, or nobody asked — and only the first is the device's fault
   * (§V469). Omitted = unknown, which reads as "not asked" rather than inventing a claim.
   */
  requestedFeatures?: ReadonlyArray<string>,
): BackendCapabilities {
  const features = new Set<string>(gpu.device.features as ReadonlySet<string>);
  const limits = readLimits(gpu.device.limits);
  const adapter = grantedAdapter(gpu);

  return {
    tier: classifyTier(features, limits),
    features: [...features].sort(),
    formats: supportedFormats(),
    timestampQuery: features.has("timestamp-query"),
    timestampQueryRequested: (requestedFeatures ?? []).includes("timestamp-query"),
    ...(adapter === undefined ? {} : { adapter }),
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
