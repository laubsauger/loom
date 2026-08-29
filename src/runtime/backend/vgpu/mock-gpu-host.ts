import { createMockAdapter, getMockGPUDeviceInstrumentation, init } from "vgpu/mock";
import type { DeviceLossInfo, GpuHost, GpuSession } from "./gpu-host.ts";

/** `@vgpu/core` is a transitive dependency, so the type is derived rather than imported. */
export type MockInstrumentation = ReturnType<typeof getMockGPUDeviceInstrumentation>;

/**
 * Deterministic command-level host backed by `vgpu/mock`, for Node tests.
 *
 * The mock `GPUDevice` has no `lost` promise, so device loss cannot happen on its own.
 * `loseDevice()` fires the same signal a real `GPUDevice.lost` would, which exercises the
 * whole §V23 path (halt, diagnose, rebuild, reset temporal) against real backend code.
 */

export interface MockGpuHostOptions {
  /** Features the mock adapter advertises. Requesting one outside this set fails init. */
  readonly features?: ReadonlyArray<GPUFeatureName>;
}

export interface MockGpuHost extends GpuHost {
  /** Simulates device loss on the live session. */
  loseDevice(info?: Partial<DeviceLossInfo>): void;
  /** Command-level counters of the live session's device. */
  readonly instrumentation: MockInstrumentation | undefined;
  /** The live mock device — lets tests fabricate context textures for canvas stubs (T87). */
  readonly device: GPUDevice | undefined;
  readonly sessionsCreated: number;
}

export function mockGpuHost(options: MockGpuHostOptions = {}): MockGpuHost {
  const features = options.features ?? [];
  let sessionsCreated = 0;
  let live: { device: GPUDevice; lose: (info: DeviceLossInfo) => void } | undefined;

  return {
    label: "mock",
    get sessionsCreated() {
      return sessionsCreated;
    },
    get instrumentation() {
      return live === undefined ? undefined : getMockGPUDeviceInstrumentation(live.device);
    },
    get device() {
      return live?.device;
    },
    loseDevice(info) {
      live?.lose({
        reason: info?.reason ?? "destroyed",
        message: info?.message ?? "mock device loss",
      });
    },
    async create(backendOptions): Promise<GpuSession> {
      const gpu = await init({
        adapter: createMockAdapter({ features: [...features] }),
        ...(backendOptions.requiredFeatures === undefined
          ? {}
          : { requiredFeatures: [...backendOptions.requiredFeatures] as GPUFeatureName[] }),
      });
      sessionsCreated += 1;

      let lose: (info: DeviceLossInfo) => void = () => {};
      const deviceLost = new Promise<DeviceLossInfo>((resolve) => {
        lose = resolve;
      });
      live = { device: gpu.gpu, lose };

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
