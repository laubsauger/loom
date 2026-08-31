import { useCallback, useEffect, useMemo, useRef } from "react";

import type { InvocationContext } from "@domain/types/commands.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createPulseWatcher } from "@domain/parameters/pulse.ts";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * Expression-fired pulses, in the running app (T214, §V125).
 *
 * A pulse you can only click is a button, not a trigger. TouchDesigner's whole reset
 * idiom is a pulse driven by an expression — on a beat, on a threshold, on a frame count
 * (`frame % 120 == 0`) — and none of that exists unless something evaluates the
 * expression every frame and notices when it crosses.
 *
 * That evaluation lives in `createPulseWatcher` (domain, pure, testable); this is the
 * composition-root wiring, which is the half that has been missing three times before in
 * this codebase (B12, B23, T264) and each time every unit test was green. It is mounted
 * from `app.tsx` and handed to the frame loop's observer seam.
 *
 * ## Why nothing here is throttled
 *
 * §V16 caps per-frame data reaching the STORE and the UI. This puts nothing in either:
 * the watcher's step is a read of the document plus a resolve, and it dispatches only on
 * an edge. A pulse that fires sixty times a second is a user expression saying "fire
 * every frame", and quietly deciding otherwise would be the tool overruling it.
 */
export interface PulseFiring {
  /** Steps the watcher for one frame and fires whatever just went armed. */
  observe: (frame: FrameEvaluationInput) => void;
}

export function usePulseFiring(runtime: AppRuntime, context: InvocationContext): PulseFiring {
  const bus = runtime.bus;
  const watcher = useMemo(() => createPulseWatcher(bus.registry), [bus]);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const contextRef = useRef(context);
  contextRef.current = context;

  // A remount must not inherit the previous mount's armed levels: an expression that was
  // true when the pane went away would read as a rising edge when it comes back.
  useEffect(() => {
    watcher.reset();
    return () => watcher.reset();
  }, [watcher]);

  const observe = useCallback(
    (frame: FrameEvaluationInput) => {
      // T615: the FLATTENED document. On the raw one a pulse expression inside a
      // component instance was never even looked at, so TouchDesigner's whole reset
      // idiom — `frame % 120 == 0` on a Feedback's reset — stopped working the moment
      // that Feedback was packaged into a component. The fires that come back name FLAT
      // ids; `parameter.pulse` resolves those through the same flattening (§V82).
      const fires = watcher.step(runtimeRef.current.flattened.current().graph, frame);
      for (const fire of fires) {
        void bus
          .execute(
            "parameter.pulse",
            { nodeId: fire.nodeId, parameterKey: fire.key },
            contextRef.current,
          )
          // A rejected pulse already carries its diagnostics on the result and an audit
          // entry (§V31); swallowing the promise here only stops an unhandled rejection.
          .catch(() => undefined);
      }
    },
    [bus, watcher],
  );

  return { observe };
}
