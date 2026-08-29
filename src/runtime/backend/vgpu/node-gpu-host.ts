import { init } from "vgpu/node";
import type { DeviceLossInfo, GpuHost, GpuSession } from "./gpu-host.ts";

/**
 * `GpuHost` backed by Dawn: a real GPU device with no window, no canvas and no
 * compositor (T160). This is the host that makes §V45 (seeded determinism) and §V47
 * (offscreen rendering) EXECUTABLE claims — the parity suite (T69) runs the same
 * backend against this host and against the browser and compares bytes.
 *
 * Interface-identical to `browserGpuHost()` and `mockGpuHost()`, which is the point:
 * `createVgpuBackend({ host })` is the only line that differs between the browser
 * path, the test path and the headless path. Promoted here from the parity track's
 * `src/tests/headless/dawn-host.ts`, which existed only because this file did not —
 * the §V3 boundary now covers the node entry point like every other vgpu import.
 */

export interface DawnProbe {
  readonly available: boolean;
  /** Adapter description, e.g. "Metal driver on macOS …". Present only when available. */
  readonly adapter?: string;
  /** The exact failure, verbatim, when Dawn cannot start here. */
  readonly error?: string;
}

let probed: Promise<DawnProbe> | undefined;

/**
 * Answers "can this machine run Dawn?" exactly once per process.
 *
 * Deliberately NOT swallowed into a silent skip at the call site: tests read this and
 * are expected to FAIL LOUDLY if Dawn is missing where it is required, or to report
 * `probe.error` verbatim where it is optional. A parity test that quietly passes on a
 * machine with no GPU is worse than no parity test.
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

/** `GpuHost` backed by Dawn, for headless render and parity testing (§V47, T67, T69). */
export function nodeGpuHost(): GpuHost {
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

      // Dawn's GPUDevice does expose `lost`; mirror browserGpuHost's handling rather
      // than assuming it, so a Dawn build without it degrades instead of throwing.
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
