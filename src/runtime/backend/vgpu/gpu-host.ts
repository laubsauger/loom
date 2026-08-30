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
      const base = {
        label: "shaderloom",
        ...(options.powerPreference === undefined
          ? {}
          : { powerPreference: options.powerPreference }),
        ...(options.requiredFeatures === undefined
          ? {}
          : { requiredFeatures: [...options.requiredFeatures] as GPUFeatureName[] }),
      };
      // T338: read the adapter's offer FIRST (a bare requestAdapter is cheap and
      // side-effect free), clamp the ask to it, and fall back to the plain request if
      // the raised one fails — a multi-GPU machine can hand vgpu a different adapter
      // than the probe saw, and losing the headroom beats losing the device.
      const probeAdapter = await globalThis.navigator?.gpu
        ?.requestAdapter(
          options.powerPreference === undefined ? {} : { powerPreference: options.powerPreference },
        )
        .catch(() => null);
      const requiredLimits = clampedLimits(
        probeAdapter?.limits as unknown as Record<string, unknown> | undefined,
      );
      const gpu = await (requiredLimits === undefined
        ? init(base)
        : init({ ...base, requiredLimits }).catch(() => init(base)));

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
        dispose() {
          gpu.dispose();
        },
      };
    },
  };
}
