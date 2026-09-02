import { init } from "vgpu/node";
import { DESIRED_LIMITS, OPTIONAL_FEATURES } from "./gpu-host.ts";
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

/**
 * T338: the node entry exposes no adapter before device creation, so the ask is a
 * descending LADDER instead of a clamp: try the desired limit, halve on rejection
 * (over-requesting fails device creation outright, per spec), and give the baseline
 * defaults the last word. The successful rung is remembered per process — device
 * creation happens at init and device-loss recovery, so re-laddering would only
 * re-pay rejections we have already learned about.
 */
let provenStorageLimit: number | undefined | null = null; // null = not yet probed

/** Dawn's rejection names the offer: "Required limit (64) is greater than the supported limit (10)." */
const SUPPORTED_LIMIT = /supported limit \((\d+)\)/;

async function initWithLimitLadder(base: Parameters<typeof init>[0]): Promise<Awaited<ReturnType<typeof init>>> {
  const desired = DESIRED_LIMITS["maxStorageBuffersPerShaderStage"] ?? 64;
  const rungs = provenStorageLimit === null ? [desired] : provenStorageLimit === undefined ? [] : [provenStorageLimit];
  for (const rung of rungs) {
    try {
      const gpu = await init({ ...base, requiredLimits: { maxStorageBuffersPerShaderStage: rung } });
      provenStorageLimit = rung;
      return gpu;
    } catch (error) {
      // The verdict NAMES the adapter's actual offer — retry with exactly that, once.
      // No blind halving ladder: one rejection teaches the true ceiling.
      const supported = Number(SUPPORTED_LIMIT.exec(String(error))?.[1]);
      if (Number.isFinite(supported) && supported > 0 && supported < rung) {
        try {
          const gpu = await init({
            ...base,
            requiredLimits: { maxStorageBuffersPerShaderStage: supported },
          });
          provenStorageLimit = supported;
          return gpu;
        } catch {
          // The named offer ALSO failed (driver oddity): baseline gets the last word.
        }
      }
    }
  }
  provenStorageLimit = undefined;
  return init(base);
}

/**
 * B172: the node entry exposes no adapter before device creation, so the OPTIONAL
 * features are negotiated the same way the limits are — ASK, and fall back to the bare
 * ask when the adapter refuses. vgpu's rejection is clean and cheap (*Adapter does not
 * support requested feature(s)*), and a required feature that is genuinely missing still
 * fails loudly on the second attempt, which is the error worth reporting.
 *
 * Not skipped for headless: `src/examples/runner.ts`, the cook oracle and the MCP server
 * all run this host, and "headless Dawn has no timestamp-query" was never a fact about
 * Dawn — it was this file never asking.
 */
async function initWithOptionalFeatures(
  base: Parameters<typeof init>[0],
  required: ReadonlyArray<string>,
): Promise<{ gpu: Awaited<ReturnType<typeof init>>; requestedFeatures: ReadonlyArray<string> }> {
  const wanted = [...required, ...OPTIONAL_FEATURES.filter((feature) => !required.includes(feature))];
  try {
    const gpu = await initWithLimitLadder({
      ...base,
      requiredFeatures: [...wanted] as GPUFeatureName[],
    });
    return { gpu, requestedFeatures: wanted };
  } catch {
    const gpu = await initWithLimitLadder({
      ...base,
      ...(required.length === 0 ? {} : { requiredFeatures: [...required] as GPUFeatureName[] }),
    });
    return { gpu, requestedFeatures: required };
  }
}

/** `GpuHost` backed by Dawn, for headless render and parity testing (§V47, T67, T69). */
export function nodeGpuHost(): GpuHost {
  return {
    label: "dawn",
    async create(options): Promise<GpuSession> {
      const { gpu, requestedFeatures } = await initWithOptionalFeatures(
        {
          label: "loom-headless",
          ...(options.powerPreference === undefined
            ? {}
            : { powerPreference: options.powerPreference }),
        },
        options.requiredFeatures ?? [],
      );

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
        requestedFeatures,
        dispose() {
          gpu.dispose();
        },
      };
    },
  };
}
