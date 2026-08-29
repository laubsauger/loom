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

export function browserGpuHost(): GpuHost {
  return {
    label: "browser",
    async create(options) {
      const gpu = await init({
        label: "shaderloom",
        ...(options.powerPreference === undefined
          ? {}
          : { powerPreference: options.powerPreference }),
        ...(options.requiredFeatures === undefined
          ? {}
          : { requiredFeatures: [...options.requiredFeatures] as GPUFeatureName[] }),
      });

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
