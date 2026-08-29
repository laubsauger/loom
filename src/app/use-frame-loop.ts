import { useEffect, useRef, useState } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { createFrameDriver, createPointerSource } from "@runtime/execution/index.ts";
import type { FrameDriver, PointerSource } from "@runtime/execution/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { registerTransportCommands } from "./transport-commands.ts";

/**
 * Drives the compiled plan every display frame (T184).
 *
 * `backend.loop()` had no caller anywhere in the app: the compiler, the backend and the
 * renderer each pass their own suite while zero frames are ever submitted. `FrameDriver`
 * (§T16) already separates the scheduler (`backend.loop`, §V49) from the clock
 * (`liveClock`, §V44); this hook is the composition root wiring the two to the domain
 * compile result (§V16 — the plan, not per-frame pixels, is what reaches here) and to
 * the resolution the open project asks for.
 *
 * §V9 — a structural compile failure (`compiled.ok === false`) leaves the driver on
 * whatever plan it already has; this hook never hands the backend a plan it knows is
 * broken, and a stale render is exactly what §V9 asks for over a broken one.
 */

const MAX_DIAGNOSTICS = 50;
const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

export interface FrameLoopResult {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** True while the loop is running. Reflects the driver, not a request. */
  readonly playing: boolean;
}

export function useFrameLoop(
  bus: ShaderloomBus,
  backend: ShaderloomBackend | null | undefined,
  compiled: CompiledGraph | null,
  settings: ProjectSettings,
): FrameLoopResult {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  const [playing, setPlaying] = useState(false);
  const driverRef = useRef<FrameDriver | null>(null);
  const pointerRef = useRef<PointerSource | null>(null);
  const generationRef = useRef(0);

  // Read live so a resize needs no driver restart — `FrameDriverOptions.resolution` is
  // a function for exactly this reason.
  const resolutionRef = useRef(settings.outputResolution);
  resolutionRef.current = settings.outputResolution;

  useEffect(() => {
    if (backend === null || backend === undefined) {
      driverRef.current = null;
      setPlaying(false);
      return;
    }
    setDiagnostics(NO_DIAGNOSTICS);
    const pointer = pointerRef.current ?? createPointerSource();
    pointerRef.current = pointer;
    const driver = createFrameDriver({
      backend,
      transport: liveClock(),
      pointer,
      resolution: () => {
        const { width, height } = resolutionRef.current;
        return [width, height] as const;
      },
    });
    driverRef.current = driver;
    driver.start();
    setPlaying(true);

    // §V52/§V55 — the top bar's play/pause and step buttons, and `space`/`.` from the
    // keymap, all run through these two bus commands (`transport-commands.ts`) rather
    // than calling this closure directly, so the button and the hotkey cannot drift.
    const holder = registerTransportCommands(bus);
    holder.current = {
      isPlaying: () => driverRef.current?.running ?? false,
      togglePlay: () => {
        const live = driverRef.current;
        if (live === null) return;
        if (live.running) live.stop();
        else live.start();
        setPlaying(live.running);
      },
      stepFrame: (frames) => {
        const live = driverRef.current;
        if (live === null) return -1;
        let last = null;
        for (let index = 0; index < frames; index += 1) last = live.step();
        return last?.frame.frameIndex ?? -1;
      },
    };

    return () => {
      if (holder.current !== null) holder.current = null;
      driver.stop();
      driverRef.current = null;
    };
  }, [backend, bus]);

  useEffect(() => {
    const driver = driverRef.current;
    if (backend === null || backend === undefined || driver === null) return;
    if (compiled === null || !compiled.ok) return;

    const generation = (generationRef.current += 1);
    void backend
      .compile(compiled)
      .then((plan) => {
        // A newer compile landed while this one was in flight — that result, not this
        // one, is authoritative for the driver.
        if (generation !== generationRef.current) return;
        driverRef.current?.setPlan(plan);
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) return;
        setDiagnostics((current) =>
          [
            ...current,
            {
              severity: "error" as const,
              code: "backend/compile-failed",
              message: `The backend rejected the compiled plan: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ].slice(-MAX_DIAGNOSTICS),
        );
      });
  }, [backend, compiled]);

  return { diagnostics, playing };
}
