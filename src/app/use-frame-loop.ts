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

/**
 * Everything the frame loop is given (T319, §V221).
 *
 * An OBJECT, not positions, and the reason is recorded rather than stylistic. This grew to
 * seven positional parameters — three optional, two callbacks and a boolean among them —
 * and a parallel change inserted `valuesOnly` ahead of `observe`. `tsc` caught that one
 * only because a boolean and a function are different types; a SECOND callback in the same
 * position would have compiled and silently swapped the riders.
 *
 * "Silently" is the load-bearing word (§V222). Every rider here fails quiet: an animated
 * push that stops pushing looks like a static graph, a pulse that never fires looks like a
 * pulse nobody triggered, and a value chain that stops evaluating looks like a chain with
 * nothing connected. None of them throws, none of them reports, and each is a rider the
 * seam tests (`analyze-loop.test.tsx`) have to drive a real frame to observe at all.
 *
 * Named fields make the swap impossible instead of unlikely.
 */
export interface FrameLoopOptions {
  readonly bus: ShaderloomBus;
  readonly backend: ShaderloomBackend | null | undefined;
  readonly compiled: CompiledGraph | null;
  readonly settings: ProjectSettings;
  /** Re-resolves the graph at a frame. Null when nothing animates (T259, §V163). */
  readonly animate?: AnimateFrame | null | undefined;
  /**
   * Called with every rendered frame, after the plan has been encoded (T214, §V125).
   *
   * The expression-fired pulse watcher rides here, and so does the Analyze readback
   * (T305). It is a separate seam from `animate` on purpose: `animate` answers "what are
   * this frame's uniform values", and a pulse produces no value — it produces an EVENT,
   * once, on a rising edge. Folding the two together would have made a pulse look like a
   * parameter that happens to fire, which is precisely the confusion §V124 exists to
   * prevent.
   */
  readonly observe?: ((frame: FrameEvaluationInput) => void) | null | undefined;
  /**
   * Advances per-frame CHANNEL SOURCES before this frame's parameters are resolved (B27).
   *
   * The value graph rides here and not on `observe`, and the difference is one line of
   * ordering with a visible consequence: `observe` runs after `animate` has already asked
   * the resolver for this frame's numbers, so a channel advanced there would be a frame
   * behind — every Mouse-driven parameter trailing the cursor by 16ms for no reason.
   * §V179 puts the value graph before the plan, and this is that position.
   *
   * §V155 is why it is unconditional: a stateful stage that is skipped does not go stale
   * and self-correct, its trajectory diverges. So this runs on every rendered frame, even
   * when `animate` is null and nothing will read the result.
   */
  readonly advanceChannels?: ((inputs: FrameInputs) => void) | null | undefined;
  /**
   * Clears per-frame state that is NOT a function of frame index (§V181, §V170).
   *
   * Called by `seek` beside `backend.resetTemporalHistory()`, for the same reason: a
   * replay that starts from a state belonging to a different history is a scrub that looks
   * like it works and is a lie.
   */
  readonly onReset?: (() => void) | null | undefined;
  /**
   * This revision changed VALUES ONLY (T308, §V5), from `useGraphCompile`.
   *
   * A SUGGESTION, never an instruction — the compile effect below verifies it against the
   * real plans before acting on it, and falls back to a full compile when they disagree.
   */
  readonly valuesOnly?: boolean | undefined;
}

export function useFrameLoop(options: FrameLoopOptions): FrameLoopResult {
  const { bus, backend, compiled, settings } = options;
  const animate = options.animate ?? null;
  const observe = options.observe ?? null;
  const advanceChannels = options.advanceChannels ?? null;
  const onReset = options.onReset ?? null;
  const valuesOnly = options.valuesOnly ?? false;

  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  const [playing, setPlaying] = useState(false);
  const driverRef = useRef<FrameDriver | null>(null);
  const latestFrameRef = useRef<FrameInputs | null>(null);
  // T259 — the per-frame values-only push. Read through refs because it runs inside the
  // driver's frame callback, which must never be re-created to pick up a new closure.
  const animateRef = useRef<AnimateFrame | null>(animate);
  animateRef.current = animate;
  const observeRef = useRef<((frame: FrameEvaluationInput) => void) | null>(observe);
  observeRef.current = observe;
  const advanceChannelsRef = useRef<((inputs: FrameInputs) => void) | null>(advanceChannels);
  advanceChannelsRef.current = advanceChannels;
  const onResetRef = useRef<(() => void) | null>(onReset);
  onResetRef.current = onReset;
  // Read, not depended on: it changes in lockstep with `compiled`, and putting it in the
  // effect's dependency list would re-run the compile effect for a value that only ever
  // accompanies one.
  const valuesOnlyRef = useRef(valuesOnly);
  valuesOnlyRef.current = valuesOnly;
  /**
   * The plan the BACKEND has actually built, which is what the uniform pushes below write
   * into — so it starts null and is set only when a compile has completed. It used to be
   * seeded with the first `compiled`, which was harmless while every edit recompiled and
   * is not now: a value edit arriving while the first compile is still in flight would
   * otherwise push uniforms at passes the backend had not created yet.
   */
  const planRef = useRef<CompiledGraph | null>(null);
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
        // ORDER IS THE CONTRACT. Channels advance first so `animate` resolves this frame's
        // parameters against this frame's numbers (§V179); the push applies them to the
        // frame just encoded; observers run last, on a frame that is already decided.
        advanceChannelsRef.current?.(inputs);
        pushAnimatedValues(inputs);
        observeRef.current?.(inputs.frame);
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
        // §V181: the CPU half of the same rule. GPU temporal history and value-graph state
        // are both "not a function of frame index", so both are cleared before the replay
        // or the replayed frames carry a trajectory from the history just abandoned.
        onResetRef.current?.();
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

    /**
     * §V5, made real (T308, B26).
     *
     * `classifyEdit` had no production caller, so every document revision reached
     * `backend.compile`: five value-only parameter edits measured five compiles and zero
     * `updateUniforms`. The uniform-only path was not merely unenforced — for a static
     * edit it did not exist, because rebuilding the plan was the only way a new value
     * ever reached the GPU.
     *
     * The classification is CHECKED, not trusted. `push` asserts `isUniformOnlyChange`
     * against the two real plans and returns null if they are not values-only variations
     * of each other, in which case this falls straight through to a full compile. That is
     * what keeps a wrong answer in `classify-revision.ts` a wasted comparison rather than
     * a new class of bug: the worst it can do is recompile something it need not have.
     *
     * `animatorRef.reset()` is deliberately NOT called here, and its absence is a FIX
     * rather than an omission: the reset belongs to replacing the structural plan, and
     * running it per edit — which is what happened when every edit recompiled — made the
     * next animated frame re-push every uniform block in the graph because the animator
     * had just forgotten what was already on the GPU. Restoring it here would restore
     * that.
     */
    const built = planRef.current;
    if (valuesOnlyRef.current && built !== null) {
      const written = animatorRef.current.push(backend, built, compiled);
      if (written !== null) {
        // Later pushes diff against the newest values, so a slider dragged through ten
        // positions writes each block once, not ten times against a stale base.
        planRef.current = compiled;
        return;
      }
    }

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
