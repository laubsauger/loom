/* eslint-disable no-restricted-imports, no-restricted-syntax --
 * §V3 says every `vgpu` import belongs behind the backend adapter in
 * `src/runtime/backend/vgpu/**`, and it is right. This file breaks that rule
 * ON PURPOSE, and the break is a REPORTED GAP, not a decision:
 *
 *   `src/runtime/backend/vgpu/` ships `browserGpuHost()` (gpu-host.ts) and
 *   `mockGpuHost()` (mock-gpu-host.ts) but has NO host for `vgpu/node` — the
 *   Dawn entry point that the entire offline-render story (§V47, T67, T69)
 *   depends on. Without one there is no §V3-clean way to obtain a real
 *   headless device, and the headless path stays untested.
 *
 * The fix is a `nodeGpuHost()` in `src/runtime/backend/vgpu/node-gpu-host.ts`,
 * a sibling of `mock-gpu-host.ts` and shaped exactly like the body below. This
 * track does not own `src/runtime/**`, so the host lives here until then; the
 * moment it lands upstream, delete this file and import it instead — nothing
 * else in this directory changes, because everything downstream is written
 * against the `GpuHost` interface, not against vgpu.
 */
import { init } from "vgpu/node";
import type { DeviceLossInfo, GpuHost, GpuSession } from "../../runtime/backend/vgpu/gpu-host.ts";

/**
 * A real GPU device with no window, no canvas and no compositor: Dawn, driven
 * from Node. This is what makes §V45 (seeded determinism) and §V47 (offscreen
 * rendering) checkable instead of merely asserted.
 */

export interface DawnProbe {
  readonly available: boolean;
  /** Adapter description, e.g. "Metal driver on macOS ...". Present only when available. */
  readonly adapter?: string;
  /** The exact failure, verbatim, when Dawn cannot start here. */
  readonly error?: string;
}

let probed: Promise<DawnProbe> | undefined;

/**
 * Answers "can this machine run Dawn?" exactly once per process.
 *
 * Deliberately NOT swallowed into a silent skip at the call site: tests read
 * this and are expected to FAIL LOUDLY if Dawn is missing where it is required,
 * or to report `probe.error` verbatim where it is optional. A parity test that
 * quietly passes on a machine with no GPU is worse than no parity test.
 */
export function probeDawn(): Promise<DawnProbe> {
  probed ??= (async (): Promise<DawnProbe> => {
    try {
      const gpu = await init();
      const adapter = gpu.adapter.name;
      gpu.dispose();
      return { available: true, adapter };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  })();
  return probed;
}

/**
 * `GpuHost` backed by Dawn. Interface-identical to `browserGpuHost()` and
 * `mockGpuHost()`, which is the whole point: `createVgpuBackend({ host })` is
 * the ONLY line that differs between the browser path and the headless path.
 */
export function dawnGpuHost(): GpuHost {
  return {
    label: "dawn",
    async create(options): Promise<GpuSession> {
      const gpu = await init({
        label: "shaderloom-headless",
        ...(options.powerPreference === undefined
          ? {}
          : { powerPreference: options.powerPreference }),
        ...(options.requiredFeatures === undefined
          ? {}
          : { requiredFeatures: [...options.requiredFeatures] as GPUFeatureName[] }),
      });

      // Dawn's GPUDevice does expose `lost`; mirror browserGpuHost's handling
      // rather than assuming it, so a Dawn build without it degrades instead of
      // throwing.
      const native = gpu.gpu as GPUDevice & { lost?: Promise<GPUDeviceLostInfo> };
      const deviceLost: Promise<DeviceLossInfo> =
        native.lost === undefined
          ? new Promise<DeviceLossInfo>(() => {})
          : native.lost.then((info) => ({ reason: String(info.reason), message: info.message }));

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
