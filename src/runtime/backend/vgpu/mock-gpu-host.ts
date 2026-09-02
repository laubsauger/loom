import { createMockAdapter, getMockGPUDeviceInstrumentation, init } from "vgpu/mock";
import { negotiatedFeatures } from "./gpu-host.ts";
import type { DeviceLossInfo, GpuHost, GpuSession } from "./gpu-host.ts";

/** `@vgpu/core` is a transitive dependency, so the type is derived rather than imported. */
export type MockInstrumentation = ReturnType<typeof getMockGPUDeviceInstrumentation>;

/**
 * Deterministic command-level host backed by `vgpu/mock`, for Node tests.
 *
 * The mock `GPUDevice` has no `lost` promise, so device loss cannot happen on its own.
 * `loseDevice()` fires the same signal a real `GPUDevice.lost` would, which exercises the
 * whole §V23 path (halt, diagnose, rebuild, reset temporal) against real backend code.
 *
 * ## Shader validation must fail the way Dawn fails (B9, T217)
 *
 * Dawn does NOT throw on invalid WGSL: `createShaderModule` and `create*Pipeline`
 * succeed synchronously and the validation error arrives later, through the pipeline
 * error scope. The raw mock device validates nothing, so a mock test of §V9 that feeds
 * it broken WGSL passes for the wrong reason — the gate goes greener than the product
 * (which is exactly how B9 shipped). `validateShader` closes that: a source it flags is
 * ACCEPTED synchronously and fails asynchronously through an emulated
 * `pushErrorScope`/`popErrorScope`, the same path vgpu's pipeline store takes on Dawn.
 * The mock is only allowed to be as kind as the device.
 */

export interface MockGpuHostOptions {
  /** Features the mock adapter advertises. Requesting one outside this set fails init. */
  readonly features?: ReadonlyArray<GPUFeatureName>;
  /**
   * Dawn-shaped shader validation: return an error message to flag a source as invalid,
   * null to accept it. Flagged sources fail pipeline creation ASYNCHRONOUSLY via the
   * error scope, never synchronously — see the module note. Absent = validate nothing
   * (the raw mock's behaviour).
   */
  readonly validateShader?: (source: string) => string | null;
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

/**
 * Grafts Dawn's asynchronous validation semantics onto the raw mock device, in place.
 *
 * vgpu's pipeline store feature-detects `pushErrorScope`/`popErrorScope` on the device;
 * once present, its sync compile path pushes a validation scope, creates the pipeline,
 * and resolves the pop later — reporting any error through the gpu's error sink. That
 * is the Dawn flow, so emulating the scope stack here puts the mock on the SAME vgpu
 * code path a real device exercises, rather than a parallel pretend one.
 */
function graftAsyncValidation(
  device: GPUDevice,
  validateShader: (source: string) => string | null,
): void {
  const mutable = device as unknown as Record<string, unknown>;
  const moduleSources = new WeakMap<object, string>();
  /** Innermost scope last. Each holds errors recorded while it was open. */
  const scopes: Array<{ filter: string; errors: Array<{ message: string }> }> = [];

  const originalCreateShaderModule = mutable["createShaderModule"] as (
    descriptor: GPUShaderModuleDescriptor,
  ) => object;
  mutable["createShaderModule"] = (descriptor: GPUShaderModuleDescriptor): object => {
    const module = originalCreateShaderModule.call(device, descriptor);
    moduleSources.set(module, descriptor.code);
    return module;
  };

  const recordIfInvalid = (module: unknown): void => {
    const source = typeof module === "object" && module !== null ? moduleSources.get(module) : undefined;
    if (source === undefined) return;
    const message = validateShader(source);
    if (message === null) return;
    const scope = [...scopes].reverse().find((candidate) => candidate.filter === "validation");
    // No open scope = Dawn's uncaptured-error path; nothing here listens, like a page
    // with no uncapturederror handler. vgpu always opens a scope around pipeline builds.
    scope?.errors.push({ message });
  };

  for (const method of ["createRenderPipeline", "createComputePipeline"] as const) {
    const original = mutable[method] as (descriptor: Record<string, unknown>) => object;
    mutable[method] = (descriptor: Record<string, unknown>): object => {
      const result = original.call(device, descriptor);
      for (const stage of ["vertex", "fragment", "compute"]) {
        recordIfInvalid((descriptor[stage] as { module?: unknown } | undefined)?.module);
      }
      return result;
    };
  }

  mutable["pushErrorScope"] = (filter: string): void => {
    scopes.push({ filter, errors: [] });
  };
  mutable["popErrorScope"] = async (): Promise<{ message: string } | null> => {
    const scope = scopes.pop();
    // Resolve on a later microtask, like a real device: the caller must not be able to
    // observe the verdict synchronously — that asymmetry is the whole point of B9.
    await Promise.resolve();
    return scope?.errors[0] ?? null;
  };
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
      // B172: the mock adapter's feature list stands in for a real adapter's offer, so a
      // test that calls `initialize({})` against a host advertising `timestamp-query`
      // exercises the SAME negotiation the browser and Dawn hosts run. Without this the
      // mock could only ever prove the plumbing, never that production asks.
      const requestedFeatures = negotiatedFeatures(backendOptions.requiredFeatures, features);
      const gpu = await init({
        adapter: createMockAdapter({ features: [...features] }),
        ...(requestedFeatures.length === 0
          ? {}
          : { requiredFeatures: [...requestedFeatures] as GPUFeatureName[] }),
      });
      sessionsCreated += 1;
      if (options.validateShader !== undefined) {
        graftAsyncValidation(gpu.gpu, options.validateShader);
      }

      let lose: (info: DeviceLossInfo) => void = () => {};
      const deviceLost = new Promise<DeviceLossInfo>((resolve) => {
        lose = resolve;
      });
      live = { device: gpu.gpu, lose };

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
