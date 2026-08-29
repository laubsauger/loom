import { useEffect, useState } from "react";
import type { GpuStatus } from "./gpu-status.ts";
import { PROBING, sharedGpuProbe } from "./gpu-status.ts";

/**
 * Subscribes the tree to the one capability probe.
 *
 * The probe never rejects — an unavailable device is a value, not an exception — so
 * there is no failure path here that can leave the app on a blank screen (§V12).
 */
export function useGpuStatus(probe: () => Promise<GpuStatus> = sharedGpuProbe): GpuStatus {
  const [status, setStatus] = useState<GpuStatus>(PROBING);

  useEffect(() => {
    let live = true;
    void probe().then((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
    };
  }, [probe]);

  return status;
}
