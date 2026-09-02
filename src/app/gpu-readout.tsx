import { useCallback, useSyncExternalStore } from "react";
import type { TelemetrySource } from "@runtime/telemetry/index.ts";
import { formatMs } from "./format-metrics.ts";

/**
 * The header's GPU-ms number, live (B172, §V16, §V86).
 *
 * `TopBar` has taken a `gpuMs` prop since it was written and NOTHING ever passed one, so
 * the readout beside `fps` showed an em dash on every machine forever — the same shape as
 * the bug this landed with (a hub that was constructed and never fed), on the surface a
 * user looks at first. It is a component rather than a prop because the value changes at
 * the hub's <= 10 Hz tick: subscribing here keeps `app.tsx` off that clock, which is the
 * §V16 rule the `timeline` slot already follows.
 *
 * §V86 holds: `frame.gpuMs` is null until a span exists, and null renders as the dash it
 * always was. A device with no `timestamp-query`, or a plan whose spans have not come
 * back yet, reads as absent — never as `0.00 ms`, which would claim the frame was free.
 */
export function GpuMsReadout({ telemetry }: { telemetry: TelemetrySource }) {
  const gpuMs = useSyncExternalStore(
    useCallback((listener: () => void) => telemetry.subscribe(listener), [telemetry]),
    useCallback(() => telemetry.snapshot().frame.gpuMs, [telemetry]),
    useCallback(() => telemetry.snapshot().frame.gpuMs, [telemetry]),
  );
  return <>{formatMs(gpuMs)}</>;
}
