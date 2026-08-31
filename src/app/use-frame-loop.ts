import { useCallback, useEffect, useRef, useState } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { projectFps, projectRange } from "@domain/types/graph.ts";
import type { FrameRange, ProjectSettings } from "@domain/types/graph.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { AudioFeatures } from "@domain/types/frame.ts";
import { createFrameDriver, createPointerSource } from "@runtime/execution/index.ts";
import type { FrameDriver, PointerSource } from "@runtime/execution/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { createUniformAnimator } from "./animate-parameters.ts";
import { MAX_RETAINED_DIAGNOSTICS, retainDiagnostic } from "./diagnostic-buffer.ts";
import { registerTransportCommands, transportHolderFor } from "./transport-commands.ts";

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

/** T596: distinct CONDITIONS, not reports — `retainDiagnostic` collapses repeats. */
const MAX_DIAGNOSTICS = MAX_RETAINED_DIAGNOSTICS;

// The timeline rate now comes from the document (§V177, T272) via `projectFps`, which
// applies the default in one place. What it must NOT become is two numbers: the clock and
// the scheduler read the same one, or timeline time runs fast on a 120 Hz display.
const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

export interface FrameLoopResult {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** T465: empty the retained list; anything still real re-reports on its own. */
  clearDiagnostics(): void;
  /** True while the loop is running. Reflects the driver, not a request. */
  readonly playing: boolean;
  /**
   * T433 — true while playback is cycling the document's frame range.
   *
   * Session state, like `playing`: it says what THIS playback is doing, and the range it
   * cycles is the document's (§V177). Surfaced so the header's loop control reflects the
   * transport rather than keeping a second copy of the answer.
   */
  readonly looping: boolean;
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
   * The ONE pointer source (T324, §V182, §V236).
   *
   * Supplied by the composition root so the surface that PUBLISHES the cursor and the loop
   * that READS it are the same object. Omitted, the loop makes its own — which is what it
   * used to do always, and why `FrameEvaluationInput.pointer` was a frozen zero: nothing
   * outside this file could ever reach the instance to write to it.
   */
  readonly pointer?: PointerSource | undefined;
  /**
   * T414: the session's ONE audio feature source (§V182's rule with sound). Read per
   * rendered frame; null = silence, and the field stays off FrameInputs entirely.
   */
  readonly audio?: (() => AudioFeatures | null) | undefined;
  /**
   * This revision changed VALUES ONLY (T308, §V5), from `useGraphCompile`.
   *
   * A SUGGESTION, never an instruction — the compile effect below verifies it against the
   * real plans before acting on it, and falls back to a full compile when they disagree.
   */
  readonly valuesOnly?: boolean | undefined;
  /**
   * This revision must land on CLEARED temporal history (§V22, T519, B106).
   *
   * From `useGraphCompile`, and true for exactly one thing today: a project LOAD. The
   * backend's rebuild carries resources over by RESOURCE ID, and a carried ping-pong or
   * ring keeps its CONTENTS (§V62b, T143) — which is what makes an unrelated edit cheap
   * within one document and what leaks one PROJECT'S pixels into the next when both
   * name a node `echo`.
   *
   * An INSTRUCTION rather than a suggestion, unlike `valuesOnly` above: there is no
   * cheap check that could second-guess it, and the failure of ignoring it is a picture
   * from a project the user has closed.
   */
  readonly resetFeedback?: boolean | undefined;
  /** T552: a different document is open — the full rite: zero buffers, land on frame 0. */
  readonly documentBoundary?: boolean | undefined;
}

export function useFrameLoop(options: FrameLoopOptions): FrameLoopResult {
  const { bus, backend, compiled, settings } = options;
  const animate = options.animate ?? null;
  const observe = options.observe ?? null;
  const advanceChannels = options.advanceChannels ?? null;
  const onReset = options.onReset ?? null;
  const valuesOnly = options.valuesOnly ?? false;
  const resetFeedback = options.resetFeedback ?? false;
  const documentBoundary = options.documentBoundary ?? false;
  const suppliedPointer = options.pointer;

  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  const [playing, setPlaying] = useState(false);
  /**
   * T455 — TIMELINE MODE IS THE DEFAULT, so the frame counter is BOUNDED.
   *
   * The owner watched `frame 836` climb past a 600-frame range and asked, correctly, why
   * the counter does not reset. A piece of length N plays 0..N-1 and wraps; a counter that
   * runs away is frames-since-the-app-started, which is a fact about the session and not
   * about the work. Turning the loop off is what asks for the free-running LIVE clock, and
   * that is the rarer of the two once a timeline exists.
   *
   * Session state, not document state: it says what THIS playback is doing. The RANGE it
   * cycles is the document's (T454).
   */
  const [looping, setLooping] = useState(true);
  // Read inside the driver's frame callback, so a ref rather than the state: a lap
  // boundary must be decided against the CURRENT flag, not the one captured when the
  // driver was built.
  const loopingRef = useRef(true);
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
  // Same reason as `valuesOnlyRef`: it accompanies a `compiled`, it does not trigger one.
  const resetFeedbackRef = useRef(resetFeedback);
  resetFeedbackRef.current = resetFeedback;
  const documentBoundaryRef = useRef(documentBoundary);
  documentBoundaryRef.current = documentBoundary;
  /**
   * WORK OWED, not a flag observed (T733, B141).
   *
   * The two refs above are overwritten by EVERY render, and the code that acts on them
   * runs inside a `.then` after `await backend.compile` — so what it read was whatever
   * the newest render happened to say, never what accompanied the plan being installed.
   * The comment on `valuesOnlyRef` claims these "change in lockstep with `compiled`".
   * They do not, and B141 is the two ways that shows:
   *
   *  1. SUPERSESSION. A second compile starts while the load's is in flight, bumping
   *     `generationRef`, so the boundary compile's `.then` returns early — and the
   *     compile that does land belongs to the same document as its predecessor, so its
   *     flag is false and nobody clears anything.
   *  2. THE REF MOVING UNDER THE PROMISE. Even the boundary compile's own `.then` reads
   *     `false` if any render committed while it was in flight, because the ref is not a
   *     snapshot.
   *
   * MEASURED in the running app, loading E2-Reaction-Diffusion over
   * E24-Audio-Reaction-Diffusion — the pair the owner named, eleven shared node ids: the
   * load produced THREE compiles and every one of them read `documentBoundary: false`,
   * including the first. Both Gray-Scott simulations, so E2's chemical field started from
   * E24's contents (`backend.compile` carries resources over BY RESOURCE ID, §V62b/T143)
   * and the picture is not a picture of E2. The first load of a session survives, which
   * is why it presents as intermittent.
   *
   * A latch instead of a flag. It is SET when a compile carrying the work is scheduled
   * and CLEARED only once the work has actually been done, so neither a superseding
   * compile nor a re-render can lose it: whichever plan lands performs the rite, over the
   * program that plan just installed — which is the same "after the install" order the
   * block below has always required. A failed compile leaves it owed, which is the safe
   * direction: a late clear costs a frame, a dropped one costs the picture.
   */
  const boundaryOwedRef = useRef(false);
  const feedbackResetOwedRef = useRef(false);
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
  const audioRef = useRef<(() => AudioFeatures | null) | null>(options.audio ?? null);
  audioRef.current = options.audio ?? null;
  const generationRef = useRef(0);

  // Read live so a resize needs no driver restart — `FrameDriverOptions.resolution` is
  // a function for exactly this reason.
  const resolutionRef = useRef(settings.outputResolution);
  resolutionRef.current = settings.outputResolution;
  const fps = projectFps(settings);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  // T433 — the timeline's in/out points, read LIVE for the same reason the resolution is:
  // dragging the out point while the graph plays must not rebuild the driver, which would
  // reset elapsed time on every pixel of the drag. One source: the document (§V177), read
  // through `projectRange` so the default is applied in one place.
  const rangeRef = useRef<FrameRange>(projectRange(settings));
  rangeRef.current = projectRange(settings);

  /**
   * §V163 — the whole of "the picture moves".
   *
   * Runs BEFORE the plan is encoded (T340), so the values written here are in place for
   * the frame they were resolved for rather than for the one after it. `updateUniforms`
   * carries no frame guard by design (§V5: values in, values only) and no route to
   * resource construction, which is what makes writing from outside the frame legal — and
   * what makes it the cook gate's dirty mark (§V159).
   *
   * It used to run after `render`, which was harmless while `cookPolicy` was always
   * "always" and wrong the moment it was not: `render` asks the gate whether to skip as
   * its first act, so a mark set afterwards belongs to the next frame. `cook-parity.test.ts`
   * holds both orderings side by side.
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
      retainDiagnostic(
        current,
        {
          severity: "warning" as const,
          code: "animation/structuralDrift",
          message: "An animated parameter changed the plan's structure, so it was not applied.",
          suggestion:
            "Only values may animate (§V5). A parameter that changes a resolution, a format or a shader interface needs a recompile, which the frame loop will not do.",
        },
        MAX_DIAGNOSTICS,
      ),
    );
  }, [backend]);

  /**
   * B48/T392 — TRANSPORT IS TIME, NOT GPU, so its commands register UNCONDITIONALLY.
   *
   * They used to register inside the effect below, past its `backend === null` early
   * return. On a machine with no WebGPU that return fires, so `transport.togglePlay` and
   * `transport.stepFrame` were never on the bus: `space` and `.` reported `unresolved`
   * and the top bar's play and step buttons — which name the same two commands — did
   * nothing at all, with nothing on screen saying why.
   *
   * The handlers were always ready for this. Every one of them refuses by name when the
   * holder is empty (§V288), exactly as `view.toggleFullscreen` and
   * `runtime.resetFeedback` already do. Only the REGISTRATION was behind the gate, so a
   * refusal that was written to be visible was replaced by silence.
   */
  useEffect(() => {
    registerTransportCommands(bus);
  }, [bus]);

  useEffect(() => {
    if (backend === null || backend === undefined) {
      driverRef.current = null;
      // No driver means no transport: leave the holder empty so the commands refuse by
      // name rather than driving a loop that is gone.
      transportHolderFor(bus).current = null;
      setPlaying(false);
      return;
    }
    setDiagnostics(NO_DIAGNOSTICS);
    const pointer = suppliedPointer ?? pointerRef.current ?? createPointerSource();
    pointerRef.current = pointer;
    // T271/§V172 — ONE fps: the timeline clock advances at `1/fps` and the scheduler is
    // capped to the same rate, or timeline time runs fast on a 120 Hz display and slow on
    // a struggling one. The clock reads the rate through a getter so a settings edit takes
    // effect without rebuilding the transport (which would reset elapsed time — a rate
    // change is not a seek); the scheduler's cap is set when the loop starts, so the
    // effect below restarts it to keep the two in step.
    const transport = liveClock({ fps: () => fpsRef.current });

    /**
     * The lap boundary (T433, T464).
     *
     * **A LOOP IS NOT A SEEK.** This used to run `seek`, which clears GPU temporal
     * history, resets CPU stages and replays from zero — and the owner caught it: "we're
     * resetting feedbacks and all kinds of things whenever the timeline loops back. thats
     * not how touchdesigner necessarily works". They are right. Playback across an out
     * point is CONTINUOUS; only the time VALUE wraps. A feedback that survives the wrap is
     * what makes a long-form feedback piece possible at all.
     *
     * §V170/§V181 are untouched by this and still govern the SEEK path below. Their
     * reasoning is about REPLAYED frames carrying a trajectory from a history they did not
     * come from — true when the user jumps, false when nothing was skipped. The rule was
     * right and its blast radius was not checked, which is the general hazard worth naming:
     * an invariant stated correctly for one situation, enforced in a neighbouring one.
     *
     * `runtime.resetFeedback` remains the way to start over, which is where a reset
     * belongs — asked for, never implied.
     *
     * It also runs INLINE now. The old version had to defer to a microtask because `seek`
     * stopped and restarted the very loop it was called from; wrapping the clock touches
     * no scheduler, so there is nothing to be re-entrant about.
     */
    const maybeLap = (frameIndex: number): void => {
      if (!loopingRef.current) return;
      // Only during PLAYBACK. A manual step or a typed seek addresses a specific frame
      // deliberately, and taking the user somewhere else instead is the silent kind of
      // wrong. `seek` stops the driver before replaying, so its own frames arrive here
      // with `running === false` and cannot start a lap inside a seek.
      if (driverRef.current?.running !== true) return;
      const { start, end } = rangeRef.current;
      if (frameIndex < end) return;
      transport.wrapTo?.(start);
    };

    const driver = createFrameDriver({
      backend,
      transport,
      pointer,
      // Read through the ref PER TICK: an audio source that appears later (the user
      // adds an audioIn node mid-session) must not need a driver restart.
      audio: () => audioRef.current?.() ?? null,
      resolution: () => {
        const { width, height } = resolutionRef.current;
        return [width, height] as const;
      },
      fps: fpsRef.current,
      // A ref, not state: this runs on every rendered frame (§V16).
      // ORDER IS THE CONTRACT (T340). Channels advance first so `animate` resolves this
      // frame's parameters against this frame's numbers (§V179), and the push lands
      // BEFORE the encode that must carry them — `updateUniforms` is the cook gate's
      // dirty mark (§V159), so a push after `render` marks a frame that has already
      // decided to skip, and the value shows up one frame late (§V157).
      onBeforeFrame: (inputs) => {
        advanceChannelsRef.current?.(inputs);
        pushAnimatedValues(inputs);
      },
      // Observers run last, on a frame that is already decided: a pulse is an event about
      // the frame that just rendered, and the Analyze readback must not precede it.
      onFrame: (inputs) => {
        latestFrameRef.current = inputs;
        observeRef.current?.(inputs.frame);
        maybeLap(inputs.frame.frameIndex);
      },
    });
    driverRef.current = driver;
    driver.start();
    setPlaying(true);

    // §V52/§V55 — the top bar's play/pause and step buttons, and `space`/`.` from the
    // keymap, all run through these two bus commands (`transport-commands.ts`) rather
    // than calling this closure directly, so the button and the hotkey cannot drift.
    const holder = transportHolderFor(bus);
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
      // `onFrame` above already records this into `latestFrameRef`, so there is nothing
      // to write here — the export path needs the value RETURNED, not stored.
      stepOnce: () => driverRef.current?.step() ?? null,
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
        // T510: a seek REPLAYS from zero, so its clear includes the point pairs —
        // "a SEEK zeroes frameIndex and drops the point pairs together", now true on
        // both halves. Silent: the scrub is its own visible event (T553).
        backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
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
      // T467: the RENDER path's verb. The live paths never call this — a seek or a lap
      // leaves the absolute clock growing (T461); only a take starts its clock at zero.
      resetAbsoluteClock: () => transport.resetAbsolute(),
      isLooping: () => loopingRef.current,
      toggleLoop: () => {
        loopingRef.current = !loopingRef.current;
        setLooping(loopingRef.current);
      },
    };

    return () => {
      if (holder.current !== null) holder.current = null;
      driver.stop();
      driverRef.current = null;
    };
  }, [backend, bus, pushAnimatedValues, suppliedPointer]);

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

    // T733/B141 — owed at SCHEDULE time, while the flags still belong to the plan being
    // built. Reading them after the await is what dropped the work.
    if (documentBoundaryRef.current) boundaryOwedRef.current = true;
    if (resetFeedbackRef.current) feedbackResetOwedRef.current = true;

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
        /**
         * AFTER the install, and that order is the whole point (T519, B106, §V22).
         *
         * `resetTemporalHistory` clears the ACTIVE program's feedback pairs and rings.
         * Until this `.then` runs, the active program is the one built from the
         * PREVIOUS document — clearing there would wipe history the user is still
         * looking at and leave the incoming document's carried-over pairs untouched,
         * which is the bug with the sides swapped.
         *
         * Unscoped: a load invalidates every pair, not a named one, so this is the same
         * call `runtime.resetFeedback` makes with no `nodeIds` (§V126).
         */
        if (boundaryOwedRef.current) {
          /**
           * T552/T510/T519 — the full rite for a LOAD, both halves of the audit
           * sentence moving together: zero the point pairs (silent — the load is its
           * own visible event, T553) AND land the transport on frame 0, so the next
           * tick is byte-identical to a cold open and every kernel's seeding signal
           * (`ctx.firstRun`, and the legacy frameIndex == 0 guard) fires over fresh
           * storage. A resolution edit takes the branch below instead: textures reset,
           * playback and simulations keep running.
           *
           * T733: the debt is discharged HERE and nowhere else. Clearing it before the
           * call would reintroduce B141 with an extra step.
           */
          boundaryOwedRef.current = false;
          feedbackResetOwedRef.current = false;
          backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
          transportHolderFor(bus).current?.seek(0);
        } else if (feedbackResetOwedRef.current) {
          feedbackResetOwedRef.current = false;
          backend.resetTemporalHistory(undefined, { silent: true });
        }
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) return;
        setDiagnostics((current) =>
          retainDiagnostic(
            current,
            {
              severity: "error" as const,
              code: "backend/compile-failed",
              message: `The backend rejected the compiled plan: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            MAX_DIAGNOSTICS,
          ),
        );
      });
    // `bus` deliberately excluded: it is only dereferenced inside the `.then`, and
    // re-running this effect on a bus identity change would recompile/install a plan
    // the T308 guard already settled. The compile lifecycle is keyed by the plan alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, compiled]);

  const latestFrame = useCallback(() => latestFrameRef.current, []);

  // T465: the problems tab's Clear empties every ACCUMULATING source; anything still
  // real re-reports on its own and thereby proves it is live.
  const clearDiagnostics = useCallback(() => setDiagnostics([]), []);
  return { diagnostics, clearDiagnostics, playing, looping, latestFrame };
}
