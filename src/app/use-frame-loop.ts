import { useCallback, useEffect, useRef, useState } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { projectFps } from "@domain/types/graph.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import { createFrameDriver, createPointerSource } from "@runtime/execution/index.ts";
import type { FrameDriver, PointerSource } from "@runtime/execution/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { createUniformAnimator } from "./animate-parameters.ts";
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

// The timeline rate now comes from the document (§V177, T272) via `projectFps`, which
// applies the default in one place. What it must NOT become is two numbers: the clock and
// the scheduler read the same one, or timeline time runs fast on a 120 Hz display.
const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

export interface FrameLoopResult {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** True while the loop is running. Reflects the driver, not a request. */
  readonly playing: boolean;
  /**
   * The inputs of the last frame actually rendered, SAMPLED — never pushed (§V16).
   *
   * A caller that wants `time`, `delta` or `frame` (the expression help panel does) reads
   * this when it renders. Putting the value in state instead would re-render the tree
   * sixty times a second, which is the exact mistake §V16 exists to prevent.
   */
  latestFrame(): FrameInputs | null;
}

/**
 * Re-resolves the graph AT a frame. Null when nothing animates (T259, §V163).
 *
 * `useGraphCompile` owns this: it is the same compile path, with the frame and the
 * channel resolver supplied. Null here is the gate — a static graph costs nothing per
 * frame because there is no call to make, not because a call returns early.
 */
export type AnimateFrame = (frame: FrameEvaluationInput) => CompiledGraph | null;

export function useFrameLoop(
  bus: ShaderloomBus,
  backend: ShaderloomBackend | null | undefined,
  compiled: CompiledGraph | null,
  settings: ProjectSettings,
  animate: AnimateFrame | null = null,
): FrameLoopResult {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  const [playing, setPlaying] = useState(false);
  const driverRef = useRef<FrameDriver | null>(null);
  const latestFrameRef = useRef<FrameInputs | null>(null);
  // T259 — the per-frame values-only push. Read through refs because it runs inside the
  // driver's frame callback, which must never be re-created to pick up a new closure.
  const animateRef = useRef<AnimateFrame | null>(animate);
  animateRef.current = animate;
  const planRef = useRef<CompiledGraph | null>(compiled);
  const animatorRef = useRef(createUniformAnimator());
  const driftRef = useRef(false);
  const pointerRef = useRef<PointerSource | null>(null);
  const generationRef = useRef(0);

  // Read live so a resize needs no driver restart — `FrameDriverOptions.resolution` is
  // a function for exactly this reason.
  const resolutionRef = useRef(settings.outputResolution);
  resolutionRef.current = settings.outputResolution;
  const fps = projectFps(settings);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  /**
   * §V163 — the whole of "the picture moves".
   *
   * Runs inside the driver's frame callback, after `render` encoded this frame and before
   * the loop submits it, so the values written here apply to the frame they were resolved
   * for. `updateUniforms` carries no frame guard by design (§V5: values in, values only),
   * which is what makes writing from inside an open frame legal.
   *
   * Three ways this stays honest. It does nothing at all when `animate` is null — a static
   * document is not paying for a feature it is not using. It refuses to touch the GPU when
   * the per-frame plan is not a values-only variation of the structural one, because
   * recompiling at frame rate is exactly what §V5 forbids. And it reports that refusal
   * once instead of every frame.
   */
  const pushAnimatedValues = useCallback((inputs: FrameInputs) => {
    const animateFrame = animateRef.current;
    const base = planRef.current;
    const live = backend;
    if (animateFrame === null || base === null || live === null || live === undefined) return;
    const next = animateFrame(inputs.frame);
    if (next === null) return;
    const written = animatorRef.current.push(live, base, next);
    if (written !== null || driftRef.current) return;
    driftRef.current = true;
    setDiagnostics((current) =>
      [
        ...current,
        {
          severity: "warning" as const,
          code: "animation/structuralDrift",
          message: "An animated parameter changed the plan's structure, so it was not applied.",
          suggestion:
            "Only values may animate (§V5). A parameter that changes a resolution, a format or a shader interface needs a recompile, which the frame loop will not do.",
        },
      ].slice(-MAX_DIAGNOSTICS),
    );
  }, [backend]);

  useEffect(() => {
    if (backend === null || backend === undefined) {
      driverRef.current = null;
      setPlaying(false);
      return;
    }
    setDiagnostics(NO_DIAGNOSTICS);
    const pointer = pointerRef.current ?? createPointerSource();
    pointerRef.current = pointer;
    // T271/§V172 — ONE fps: the timeline clock advances at `1/fps` and the scheduler is
    // capped to the same rate, or timeline time runs fast on a 120 Hz display and slow on
    // a struggling one. The clock reads the rate through a getter so a settings edit takes
    // effect without rebuilding the transport (which would reset elapsed time — a rate
    // change is not a seek); the scheduler's cap is set when the loop starts, so the
    // effect below restarts it to keep the two in step.
    const transport = liveClock({ fps: () => fpsRef.current });
    const driver = createFrameDriver({
      backend,
      transport,
      pointer,
      resolution: () => {
        const { width, height } = resolutionRef.current;
        return [width, height] as const;
      },
      fps: fpsRef.current,
      // A ref, not state: this runs on every rendered frame (§V16).
      onFrame: (inputs) => {
        latestFrameRef.current = inputs;
        pushAnimatedValues(inputs);
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
      /**
       * §V170 — a seek REPLAYS. A graph with feedback, a Cache or a point simulation has
       * no state at a frame it has not reached, so resetting the counter and leaving the
       * GPU's temporal history alone would show a picture belonging to a different
       * history: a scrub that looks like it works and is a lie. Clearing history and
       * stepping forward from zero costs O(frames) and is the true state at that frame.
       */
      seek: (frameIndex) => {
        const live = driverRef.current;
        if (live === null) return -1;
        const wasRunning = live.running;
        if (wasRunning) live.stop();
        transport.reset();
        backend.resetTemporalHistory();
        let last = null;
        for (let index = 0; index <= frameIndex; index += 1) last = live.step();
        latestFrameRef.current = last;
        if (wasRunning) live.start();
        setPlaying(live.running);
        return last?.frame.frameIndex ?? -1;
      },
    };

    return () => {
      if (holder.current !== null) holder.current = null;
      driver.stop();
      driverRef.current = null;
    };
  }, [backend, bus, pushAnimatedValues]);

  /**
   * Keep the SCHEDULER's cap in step with the clock's rate (§V172).
   *
   * The clock reads fps through a getter, so a settings edit changes the timeline step
   * immediately. The scheduler's cap, though, is fixed when `backend.loop` starts. Left
   * alone the two would disagree — the timeline advancing at 1/30 while frames still
   * arrive 60 times a second makes `time` run at half speed against the wall, which is
   * the "one fps, driving both" rule broken in the least visible way.
   *
   * Restarting the LOOP is enough: the transport is not rebuilt, so elapsed time carries
   * across (a rate change is not a seek), and a paused timeline stays paused.
   */
  useEffect(() => {
    const driver = driverRef.current;
    if (driver === null || !driver.running) return;
    driver.stop();
    driver.start();
  }, [fps]);

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
        // The structural plan the per-frame push diffs against. Reset together, so a
        // recompile never leaves the animator comparing against a plan that is gone.
        planRef.current = compiled;
        animatorRef.current.reset();
        driftRef.current = false;
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

  const latestFrame = useCallback(() => latestFrameRef.current, []);

  return { diagnostics, playing, latestFrame };
}
