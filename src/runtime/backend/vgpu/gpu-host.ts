import { init } from "vgpu";
import type { Gpu } from "vgpu";
import type { BackendInitOptions } from "../../../domain/types/backend.ts";

/**
 * The device-acquisition seam.
 *
 * `vgpu` has three entry points — `vgpu` (browser), `vgpu/node` (Dawn) and `vgpu/mock` —
 * and the backend must not care which one produced its device. A host also owns the
 * device-loss signal, which no vgpu type exposes directly: `Device` observes
 * `GPUDevice.lost` privately and only surfaces loss as a throw on next use, which is far
 * too late for §V23 ("halt submission"). Watching the native `lost` promise here gives the
 * backend an edge to react to.
 */

export interface DeviceLossInfo {
  readonly reason: string;
  readonly message: string;
}

export interface GpuSession {
  readonly gpu: Gpu;
  /** Resolves once when the device is lost. Never rejects, never resolves on dispose. */
  readonly deviceLost: Promise<DeviceLossInfo>;
  /**
   * B172: what the device request actually ASKED FOR — required features plus every
   * optional one this host negotiated. Absence of a feature on the device has two
   * causes and only one of them is the device's, so the capability report carries the
   * ask alongside the grant and the diagnostic can name the real one (§V469).
   */
  readonly requestedFeatures?: ReadonlyArray<string>;
  dispose(): void;
}

export interface GpuHost {
  readonly label: string;
  create(options: BackendInitOptions): Promise<GpuSession>;
}

/** A promise that never settles — used when a device exposes no `lost` signal. */
export function neverLost(): Promise<DeviceLossInfo> {
  return new Promise<DeviceLossInfo>(() => {});
}

/**
 * T338 (§V256): a baseline default is NOT a ceiling. WebGPU grants only the spec
 * defaults unless the device request ASKS — and we only ever passed requiredFeatures,
 * so every kernel in the product was capped at 8 storage buffers per stage on
 * hardware offering many times that (B33 was hit at exactly this floor, twice).
 *
 * These are the limits we ask for beyond the defaults. The ask is always clamped to
 * what the adapter actually offers — over-requesting FAILS device creation outright —
 * and `describeCapabilities` reads the NEGOTIATED device limits, so the capability
 * report and the compiler's validation widen automatically and can never promise
 * headroom the device refused.
 */
export const DESIRED_LIMITS: Readonly<Record<string, number>> = {
  maxStorageBuffersPerShaderStage: 64,
};

/**
 * B172 (§V12, §V469): features we ASK FOR when the adapter offers them, and do without
 * when it does not.
 *
 * WebGPU grants an optional feature ONLY IF `requestDevice` named it, so a capability
 * check for one nobody requested can never be true. `timestamp-query` appeared in a
 * `requiredFeatures` array in exactly one TEST file and in no production path, which is
 * why per-pass GPU spans read "unavailable" on every machine ever to run the app — the
 * panel was honest, the check was structurally false, and the copy blamed the device for
 * our omission.
 *
 * Optional and never required: a device without it must still get a working app (§V12),
 * so the ask is filtered against the adapter's offer rather than made unconditional —
 * over-requesting FAILS device creation outright.
 */
export const OPTIONAL_FEATURES: ReadonlyArray<string> = ["timestamp-query"];

/**
 * The features to request: everything the caller required, plus every optional feature
 * the adapter actually advertises. `adapterFeatures` undefined = the offer could not be
 * read, and an unreadable offer is not a licence to guess — nothing optional is added.
 */
export function negotiatedFeatures(
  required: ReadonlyArray<string> | undefined,
  adapterFeatures: Iterable<string> | undefined,
): ReadonlyArray<string> {
  const asked = [...(required ?? [])];
  if (adapterFeatures === undefined) return asked;
  const offered = new Set<string>(adapterFeatures);
  for (const feature of OPTIONAL_FEATURES) {
    if (offered.has(feature) && !asked.includes(feature)) asked.push(feature);
  }
  return asked;
}

/** `min(adapter, desired)` per key; undefined when the adapter offers nothing legible. */
export function clampedLimits(
  adapterLimits: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (adapterLimits === undefined) return undefined;
  const out: Record<string, number> = {};
  for (const [key, desired] of Object.entries(DESIRED_LIMITS)) {
    const offered = adapterLimits[key];
    if (typeof offered === "number" && Number.isFinite(offered)) {
      out[key] = Math.min(desired, offered);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function browserGpuHost(): GpuHost {
  return {
    label: "browser",
    async create(options) {
      // T338: read the adapter's offer FIRST (a bare requestAdapter is cheap and
      // side-effect free), clamp the ask to it, and fall back to the plain request if
      // the raised one fails — a multi-GPU machine can hand vgpu a different adapter
      // than the probe saw, and losing the headroom beats losing the device.
      const probeAdapter = await globalThis.navigator?.gpu
        ?.requestAdapter(
          options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference },
        )
        .catch(() => null);
      // B172: the same probe answers the FEATURE question. The adapter's list is the only
      // place the offer exists before a device is created, and a feature nobody asks for
      // is never granted — so this is the line that decides whether GPU timing can exist
      // at all on this machine.
      const negotiated = negotiatedFeatures(
        options.requiredFeatures,
        probeAdapter?.features as Iterable<string> | undefined,
      );
      const required = options.requiredFeatures ?? [];
      const featured = (features: ReadonlyArray<string>) => ({
        label: "loom",
        ...(options.powerPreference === undefined
          ? {}
          : { powerPreference: options.powerPreference }),
        ...(features.length === 0
          ? {}
          : { requiredFeatures: [...features] as GPUFeatureName[] }),
      });
      const requiredLimits = clampedLimits(
        probeAdapter?.limits as unknown as Record<string, unknown> | undefined,
      );
      const withLimits = (base: ReturnType<typeof featured>) =>
        requiredLimits === undefined
          ? init(base)
          : init({ ...base, requiredLimits }).catch(() => init(base));

      // §V12, the same shape T338 uses for limits: the OPTIONAL half of the ask is never
      // allowed to cost the device. The probe and vgpu each request their own adapter, so
      // a multi-GPU machine can hand vgpu one the probe never saw — and over-requesting a
      // feature FAILS device creation outright. Ask, and drop back to the required-only
      // request if that ask is refused.
      let gpu: Awaited<ReturnType<typeof init>>;
      let requestedFeatures: ReadonlyArray<string>;
      try {
        gpu = await withLimits(featured(negotiated));
        requestedFeatures = negotiated;
      } catch {
        gpu = await withLimits(featured(required));
        requestedFeatures = required;
      }

      const native = gpu.gpu as GPUDevice & { lost?: Promise<GPUDeviceLostInfo> };
      const deviceLost: Promise<DeviceLossInfo> =
        native.lost === undefined
          ? neverLost()
          : native.lost.then((info) => ({
              reason: String(info.reason),
              message: info.message,
            }));

      return {
        gpu,
        deviceLost,
        requestedFeatures,
        dispose() {
          gpu.dispose();
        },
      };
    },
  };
}
