import { createVgpuBackend, meetsBaseline } from "@runtime/backend/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";

/**
 * Device acquisition and the capability report (§V12, T13 consumer side).
 *
 * §V2 keeps GPU commands out of React components; this module is not a component and
 * encodes nothing — it asks `src/runtime/backend` for a device and reports back what the
 * device actually said. Every optional feature the rest of the app uses is read from
 * this report and never assumed (§V12).
 *
 * The three outcomes are all normal, and the UI must render all three: a device that
 * clears the baseline, a device below Tier B, and no WebGPU at all. None of them is an
 * exception — an unsupported browser is a supported state of this app, not a crash.
 */

export type GpuStatus =
  | { readonly kind: "probing" }
  | {
      readonly kind: "ready";
      readonly capabilities: BackendCapabilities;
      /** False when the device is below the Tier B product baseline (§C). */
      readonly baseline: boolean;
      /**
       * The live backend the probe acquired.
       *
       * The probe used to report the capabilities and drop the backend on the floor,
       * which meant the app held a device it could never address: no `recover()` after a
       * halt (§V23, T98), no `onDiagnostic`, no timing surface. Optional because a test
       * builds this object by hand and a stub device has no backend to name.
       */
      readonly backend?: ShaderloomBackend | undefined;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export const PROBING: GpuStatus = { kind: "probing" };

export interface GpuProbeOptions {
  /** Injectable so a test can drive every branch without a GPU. */
  createBackend?: () => ShaderloomBackend;
  /** Does this environment expose WebGPU at all? */
  hasWebGpu?: () => boolean;
  /** Give up after this long and report unavailable. */
  timeoutMs?: number;
}

/**
 * Long enough for a cold driver, short enough that nobody stares at a spinner.
 *
 * `requestAdapter()` is specified to resolve with null when there is no adapter, but a
 * browser whose GPU process is unavailable can leave the promise pending forever — one
 * was observed doing exactly that. Without a deadline the app has a fourth, undocumented
 * state: permanently "asking".
 */
export const PROBE_TIMEOUT_MS = 8_000;

function browserHasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu != null;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function probeGpu(options: GpuProbeOptions = {}): Promise<GpuStatus> {
  const hasWebGpu = options.hasWebGpu ?? browserHasWebGpu;
  if (!hasWebGpu()) {
    return {
      kind: "unavailable",
      reason:
        "This browser does not expose WebGPU. Shaderloom needs Chrome or Edge 128+ on desktop with hardware acceleration enabled.",
    };
  }

  const backend = (options.createBackend ?? createVgpuBackend)();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  // No canvas: the plan renders to offscreen targets, so the headless path and the
  // browser path are the same code (§V47, §V64).
  const started = backend.initialize({}).then(
    (capabilities): GpuStatus => ({
      kind: "ready",
      capabilities,
      baseline: meetsBaseline(capabilities),
      backend,
    }),
    (error: unknown): GpuStatus => {
      backend.dispose();
      return { kind: "unavailable", reason: `WebGPU device request failed: ${describe(error)}` };
    },
  );

  const expired = Symbol("probe-timeout");
  const deadline = new Promise<typeof expired>((resolve) => {
    setTimeout(() => resolve(expired), timeoutMs);
  });

  const outcome = await Promise.race([started, deadline]);
  if (outcome !== expired) return outcome;

  // Do not hold a device nobody is going to use if the request lands after we gave up.
  void started.then((late) => {
    if (late.kind === "ready") backend.dispose();
  });
  return {
    kind: "unavailable",
    reason: `The WebGPU device request did not complete within ${Math.round(timeoutMs / 1000)}s. The browser exposes WebGPU but no adapter answered — hardware acceleration may be off, or the GPU process may be unavailable.`,
  };
}

let shared: Promise<GpuStatus> | null = null;

/**
 * One probe per page load.
 *
 * Deliberately not tied to a component's lifetime: the device belongs to the runtime,
 * not to the React tree (§V64), and React's development double-mount would otherwise
 * request and drop a device on every remount.
 */
export function sharedGpuProbe(): Promise<GpuStatus> {
  shared ??= probeGpu();
  return shared;
}
