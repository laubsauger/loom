import { useCallback, useEffect, useRef, useState } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import { documentTempo, type ProjectTempo } from "@domain/tempo/project-tempo.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { EvaluationFrame, FrameEvaluationInput } from "@domain/types/frame.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { projectFps, projectRange } from "@domain/types/graph.ts";
import { timelineRate } from "@domain/presets/timeline-cues.ts";
import type { FrameRange, ProjectSettings } from "@domain/types/graph.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { AudioFeatures } from "@domain/types/frame.ts";
import { createFrameDriver, createPointerSource } from "@runtime/execution/index.ts";
import type { FrameDriver, PointerSource } from "@runtime/execution/index.ts";
import { planStructureSignature } from "@runtime/backend/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { TelemetryHub } from "@runtime/telemetry/index.ts";
import { createUniformAnimator } from "./animate-parameters.ts";
import type { StructureFrame, TimelineStructureLink, ValuesHandoff, WarmLoop } from "./use-graph-compile.ts";
import { compileLatest } from "./compile-latest.ts";
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

/**
 * §B188 — what makes two installed plans DIFFERENT TO A CONSUMER of `installedPlan`.
 *
 * `plan.signature` covers `resources` and `passes`, and everything else a `ResolvedOutput`
 * carries is derived from them: a row exists because its node is kept (passes), and its
 * size, format and `resourceId` are the resource's (resources). The one field that is
 * NOT is `synthesis` — the preview program owns the target and the draw passes, so the
 * main plan carries neither and the signature cannot see them.
 *
 * So this is the signature plus exactly that gap, and it is deliberately built the same
 * value-blind way (`planStructureSignature` over the synthesis's own passes): a scene
 * payload's uniforms move with its parameters (§V5, T462) and must not re-render the App.
 */
export function installedPlanKey(plan: CompiledGraph): string {
  const synthesized = plan.outputs.flatMap((output) =>
    output.synthesis === undefined
      ? /*
         * T1655b: and a row that BORROWS another row's resource, or says something about its
         * camera. A camera with exactly one Render previews as that Render's own picture by
         * aliasing its row (T546): no pass, no resource, no synthesis, so nothing above moves
         * when the camera's tile comes on screen, the row was never announced, and the tile
         * read "no signal" for as long as nothing structural happened. Reproduced through
         * the app in `preview-camera.spec.ts` (a camera far from everything, gone to after the
         * install); the owner's camera read "no signal" when framed alone on the walk, which is
         * this shape, though that one was not re-run against the old key. The camera answer
         * rides along for the same reason: re-wiring a Render to another camera moves a
         * uniform and the name its tile shows, and no structure.
         */
        output.previewCamera === undefined
        ? []
        : [`${output.nodeId}:${output.portId}:${output.resourceId}:${JSON.stringify(output.previewCamera)}`]
      : [
          `${output.nodeId}:${output.portId}:${output.synthesis.kind ?? ""}:${planStructureSignature(
            [],
            output.synthesis.passes,
          )}`,
        ],
  );
  // Escapes, never the raw bytes (`greppable-sources`), and two the key parts cannot
  // hold: `planStructureSignature` joins with U+0000/U+0001, so these two stay free.
  const SECTION = "\u0002";
  const ENTRY = "\u0003";
  return synthesized.length === 0
    ? plan.signature
    : `${plan.signature}${SECTION}${synthesized.join(ENTRY)}`;
}

export interface FrameLoopResult {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** T465: empty the retained list; anything still real re-reports on its own. */
  clearDiagnostics(): void;
  /** True while the loop is running. Reflects the driver, not a request. */
  readonly playing: boolean;
  /**
   * THE PLAN THE BACKEND HAS — the one whose `backend.compile` has RESOLVED (T1163, B179).
   *
   * Not "the plan that was handed over": `backend.compile` is awaited, so between handing
   * a plan over and its install landing the backend still holds the previous program (or,
   * on a first boot, none at all). §T1121 gave `app.tsx` a latch by this name but wrote it
   * from `compile.compiled` — the plan the app WANTED — which is right about the half it
   * was built for (a plan carrying an error is never handed over) and wrong about the
   * interval where the handover has happened and the install has not. Every consumer that
   * means "what the GPU currently holds" reads it through here, so there is one answer
   * rather than a second copy that can be a frame ahead of the device.
   *
   * Null until the first install lands, which is the honest state on a cold boot: the
   * backend holds nothing, so there is nothing to bind against.
   */
  readonly installedPlan: CompiledGraph | null;
  /** T1655b: the rows of the installed plan's newest values-only variation (see `liveOutputsRef`). */
  readonly liveOutputs: () => CompiledGraph["outputs"] | null;
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
  /** Composition-root clock; generated sound supplies the shared audio clock in milliseconds. */
  readonly now?: (() => number) | undefined;
  readonly authoritativeClock?: (() => boolean) | undefined;
  readonly bus: LoomBus;
  /**
   * T1785b: the project tempo (`AppRuntime.tempo`). Its reading is stamped on every frame
   * this loop produces, it hears each frame's audio tempo claim, and a take restarts it on
   * the take's clock. Absent (a test's loop): frames count the document's BPM along the
   * absolute clock, as an offline render does.
   */
  readonly tempo?: ProjectTempo | undefined;
  readonly backend: LoomBackend | null | undefined;
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
   * rendered frame, with the frame (T1229: a pre-analysed file is indexed by its playhead);
   * null = silence, and the field stays off FrameInputs entirely.
   */
  readonly audio?: ((frame: FrameEvaluationInput) => AudioFeatures | null) | undefined;
  /**
   * This revision changed VALUES ONLY (T308, §V5), from `useGraphCompile`.
   *
   * A SUGGESTION, never an instruction — the compile effect below verifies it against the
   * real plans before acting on it, and falls back to a full compile when they disagree.
   */
  readonly valuesOnly?: boolean | undefined;
  /**
   * T1652b — where a VALUES-ONLY revision's plan arrives WITHOUT A RENDER, from
   * `useGraphCompile` (`GraphCompileResult.values`).
   *
   * `compiled` above only moves when the composition root renders, and it no longer
   * renders for a revision that moved values only. This is the other door: the compile's
   * values lane hands such a revision's plan and its `animate` here, and they are taken
   * exactly as the `valuesOnly` branch of the compile effect takes them — a uniform write
   * `push` has verified against the installed plan. Refused (and the revision then takes
   * the structural road, through `compiled`) when no plan is installed yet, when a
   * structural install is on its way, or when `push` says the two plans differ in more
   * than values.
   */
  readonly values?: ValuesHandoff | undefined;
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
  /**
   * §T1507b — the plan `compiled` would be with every bypassed Layer on, from
   * `useGraphCompile`. Asked for once `compiled` is installed, in a task of its own, and
   * handed to `backend.warmPasses`: switching a layer on then builds nothing. §T1544b: it is
   * handed the range being looped (null when not looping), so a timeline's wrap back to the
   * in point is built ahead like any crossing.
   */
  readonly warmPlan?: ((loop?: WarmLoop | null) => CompiledGraph | null) | null | undefined;
  /**
   * §T1537b — the timeline's structure, from `useGraphCompile`: which segment `compiled` is
   * and which segment a frame needs. Null or absent: every frame takes the installed plan.
   *
   * With it, playback switches structure ON the frame that reaches a structural cue:
   *  - each rendered frame asks for the NEXT frame's segment, so a crossing's plan is
   *    compiled and installed in the gap before the frame that needs it (and its passes
   *    were warmed after the previous install, §T1507b);
   *  - the scheduled loop HOLDS a frame whose segment is not installed yet (`ready`): the
   *    picture stays on the last frame until it is, and that frame is then rendered in its
   *    own structure — late, never wrong;
   *  - an export awaits the segment before stepping each frame (`prepareFrame`), so it is
   *    exact and deterministic whatever the machine.
   */
  readonly timeline?: TimelineStructureLink | null | undefined;
  /**
   * §T1544b — the performance pane's hub: each tick the scheduled loop HOLDS for a structure
   * still installing (`noteHeldTick`), and the backend's build stats after each install —
   * `effectsWarmed` among them (§T1507b) — so the pane says what a crossing cost.
   */
  readonly telemetry?: Pick<TelemetryHub, "noteHeldTick" | "setBuild"> | undefined;
}

/**
 * T1497b: an id for one run of the absolute clock. Opaque — compared for equality and
 * nothing else — and unique ACROSS sessions, which is the property a frame count cannot
 * give: a record saved in one session must not match the clock of the next.
 */
function mintClockEpoch(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
   * T1163 — written from inside the install and from nowhere else.
   *
   * ANNOUNCED ONLY WHEN THE KEY MOVES, and that guard is not an optimisation.
   * `compiled` is a prop: a caller that rebuilds it every render — `value-graph-loop`'s
   * harness does, deliberately, to prove the compile effect is keyed on the plan — would
   * otherwise get install → setState → render → new plan object → install, forever. The
   * key is a VALUE, never the plan's identity, which is what makes that impossible; the
   * ref makes it at most one `setState` per distinct plan rather than a state-equality
   * bail-out, which React is allowed to render through.
   *
   * ⚑ §B188 — THE KEY IS NOT THE PLAN SIGNATURE, AND THE SENTENCE THAT SAID IT WAS IS THE
   * BUG. T1163 used `compiled.signature` and argued that a skipped announcement is
   * invisible to every consumer — "same passes, same resources, same outputs". The first
   * two hold by construction; **the third is false**. `planStructureSignature` is
   * `(resources, passes)` — it is the key the vgpu backend rebuilds its GPU PROGRAM on
   * (`vgpu-backend.ts`), so it must stay exactly that — while a SYNTHESIZED preview
   * (`ResolvedOutput.synthesis`, T373/T462/T563) mints neither: the preview program owns
   * its target and its passes. So the plan in which a watched pointset has a splat and
   * the plan in which it does not are the SAME SIGNATURE, byte for byte (measured on
   * E47-Hologram), and they differ in exactly the field the preview tiles read.
   *
   * The consequence was the owner's report: every pointset tile in the document read
   * "no signal" for ever, over the marker row's own facts (`1280 × 720 · rgba16float`, a
   * TEXTURE description on a node that produces points), while every texture tile beside
   * it drew — because a texture output is materialized whether or not anyone previews it,
   * and a pointset's picture exists only as a synthesis attached by the recompile the
   * sink triggers. That compile ran, reached the backend, and was never announced, so
   * `compiledOutputs` stayed one compile behind for ever. Bypassing any node moved
   * `passes`, moved the signature, and let the whole accumulated backlog through at once
   * — which is why it looked like "it works again if I toggle something".
   *
   * So the key is the signature PLUS the synthesis set, and the addition is value-blind
   * for the same reason the signature is (`passStructureKey` excludes uniform VALUES):
   * an orbiting light's preview must not re-render the App every frame.
   */
  const [installedPlan, setInstalledPlan] = useState<CompiledGraph | null>(null);
  const installedSignatureRef = useRef<string | null>(null);
  /**
   * T1655b: the rows of the newest plan the backend holds VALUES for: the installed plan,
   * or its latest values-only variation. A values-only edit is deliberately not announced
   * through `installedPlan` (§V16), and a synthesized preview's uniform values live on its
   * row, so without this a camera, light or material tile kept drawing the values of the
   * last STRUCTURAL edit (`live-synthesis.ts` has the measurement). Read by the preview
   * tick, never rendered from.
   */
  const liveOutputsRef = useRef<CompiledGraph["outputs"] | null>(null);
  const liveOutputs = useCallback(() => liveOutputsRef.current, []);
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
  /** §T1507b: read when a structural compile is scheduled, beside the plan it belongs to. */
  const warmPlanRef = useRef(options.warmPlan ?? null);
  warmPlanRef.current = options.warmPlan ?? null;
  /** §T1537b: the newest structure link, read per frame. */
  const timelineRef = useRef<TimelineStructureLink | null>(options.timeline ?? null);
  timelineRef.current = options.timeline ?? null;
  /** §T1544b: the hub, read where a tick is held and where a plan lands. */
  const telemetryRef = useRef(options.telemetry);
  telemetryRef.current = options.telemetry;
  /**
   * §T1537b: the segment of the plan the BACKEND holds (moved where `planRef` moves), and the
   * newest segment whose plan could not be installed (§V9: its frames render on the plan
   * that is there, rather than wait for ever). `null`: nothing installed yet.
   */
  const installedSegmentRef = useRef<string | null>(null);
  const failedSegmentRef = useRef<string | null>(null);
  /** §T1537b: woken by every install or refusal, so `prepareFrame` can look again. */
  const installWaitersRef = useRef<Array<() => void>>([]);
  const wakeInstallWaiters = (): void => {
    const waiting = installWaitersRef.current;
    installWaitersRef.current = [];
    for (const wake of waiting) wake();
  };
  /** Is the segment `frame` needs the one installed (or one that cannot be)? */
  const structureReady = (frame: StructureFrame): boolean => {
    const link = timelineRef.current;
    if (link === null) return true;
    const key = link.keyAt(frame);
    return key === installedSegmentRef.current || key === failedSegmentRef.current;
  };
  const observeRef = useRef<((frame: FrameEvaluationInput) => void) | null>(observe);
  observeRef.current = observe;
  const advanceChannelsRef = useRef<((inputs: FrameInputs) => void) | null>(advanceChannels);
  advanceChannelsRef.current = advanceChannels;
  const nowRef = useRef(options.now);
  nowRef.current = options.now;
  const authoritativeClockRef = useRef(options.authoritativeClock);
  authoritativeClockRef.current = options.authoritativeClock;
  const onResetRef = useRef<(() => void) | null>(onReset);
  onResetRef.current = onReset;
  // Read, not depended on: it changes in lockstep with `compiled`, and putting it in the
  // effect's dependency list would re-run the compile effect for a value that only ever
  // accompanies one.
  const valuesOnlyRef = useRef(valuesOnly);
  valuesOnlyRef.current = valuesOnly;
  /**
   * THESE TWO ONLY EVER TURN ON HERE. They are turned OFF where the work is taken (B185).
   *
   * `valuesOnlyRef` above may be overwritten every render because it is a SUGGESTION that
   * `push` re-checks against the two real plans — the worst a stale one can do is cost a
   * comparison. These two are not suggestions. Each names work that must happen EXACTLY
   * ONCE for a revision, and a render that overwrites one with `false` before the effect
   * below has read it does not delay the work, it CANCELS it — silently, with the picture
   * left standing. §B141 is that sentence about the `.then`; §T733 answered it with a
   * latch INSIDE the effect and left the read that feeds the latch exposed.
   *
   * ⚑ §B185 IS WHAT CAME THROUGH THE GAP, AND IT IS THE OWNER'S "EVERYTHING SAYS NO
   * SIGNAL". Loading E60-Snarl over E58-Alembic: `useGraphCompile` announced
   * `documentBoundary: true`, two further renders committed `false` before this effect ran
   * (they are ordinary in-document classifications and they are not wrong), and the effect
   * read the last one. So `installedSignatureRef` was never cleared — and the five §T1171
   * documents are ONE instrument at five parameter coordinates, same three node ids over
   * byte-identical WGSL, so their plan signatures match BYTE FOR BYTE. The incoming plan
   * was skipped as "already installed" while `app.tsx` had already cleared its latch at the
   * boundary, and `installedPlan` stayed null for good: viewer "no outputs", every tile
   * "no signal", zero compile diagnostics to explain any of it. The signature short-circuit
   * was right about everything it can see; nothing told it a document had ended.
   *
   * `useEffect` is not guaranteed to flush before the next render, so "the ref changes in
   * lockstep with `compiled`" was never a property this hook could rely on. Accumulating
   * instead of assigning removes the reliance rather than tightening it: whatever order the
   * renders and the flush interleave, a boundary that was ever announced is still owed when
   * the effect looks. `document-swap.spec.ts` is the gate, and it goes red on the assignment.
   */
  const resetFeedbackRef = useRef(false);
  if (resetFeedback) resetFeedbackRef.current = true;
  /**
   * T1497b — THE ABSOLUTE CLOCK'S EPOCH, minted here and nowhere else in the app.
   *
   * A preset morph is stamped with `absTimeSeconds`, and that count is only meaningful
   * within one run of the clock (the design doc §5.4). The rule is the doc's: a new id
   * EVERY TIME THE ABSOLUTE CLOCK STARTS FROM ZERO — which is two places in this file:
   *
   *  - a TRANSPORT is built (the driver effect below). That is the session's start, and
   *    it is also every document open: an open adopts a new runtime, the bus changes, and
   *    the effect builds a fresh clock at zero. A file saved mid-fade and reopened would
   *    otherwise replay its fade when the new clock reached the old stamp;
   *  - a RENDER zeroes the clock (`resetAbsoluteClock` below) — so a take renders the
   *    document as saved, and a record stamped at live second 3 does not replay three
   *    seconds into every export.
   *
   * And once more where the clock does NOT restart but a stamp still stops meaning what
   * it said: a DOCUMENT BOUNDARY that keeps the transport. The count runs on through it
   * (T461), and the incoming file's records belong to another performance.
   *
   * The clock reads it through a getter, per frame, like `fps` and `seed`. Null until the
   * first transport exists, which is also until the first frame does.
   */
  const epochRef = useRef<string | null>(null);
  const documentBoundaryRef = useRef(false);
  if (documentBoundary) {
    // Once per boundary, not once per render that still carries the flag.
    if (!documentBoundaryRef.current) epochRef.current = mintClockEpoch();
    documentBoundaryRef.current = true;
  }
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
  /**
   * B234 — THE `animate` THAT BELONGS TO `planRef`, which is not the newest one.
   *
   * `animate` and `compiled` arrive together, built from one request (`useGraphCompile`),
   * and a frame's values are only meaningful against the plan of the same request. But
   * `animateRef` moves at RENDER and `planRef` moves when `backend.compile` RESOLVES, so
   * across a structural edit there is an interval — as long as the compile takes — where
   * the newest `animate` is the next document's and the plan the backend holds is the
   * previous one's. A frame in that interval diffed the two, found them structurally
   * different (they are: the DOCUMENT changed), refused the push and reported
   * `animation/structuralDrift` — a claim about an animated parameter that no parameter
   * had earned — while everything the installed plan animates froze until the install.
   * Found on E82: `1 open` bypasses two layers with a fade starting.
   *
   * So the function the frame calls is held beside the plan it was built for, and moves
   * with it: at the install, at a values-only handover, and at any render that brings a
   * new `animate` for the plan already installed (an editor-only revision reuses the plan
   * and still re-keys the closure). Until the next plan lands, the installed one keeps
   * animating on its own document's values.
   */
  const installedAnimateRef = useRef<AnimateFrame | null>(null);
  const compiledRef = useRef<CompiledGraph | null>(compiled);
  compiledRef.current = compiled;
  if (compiled !== null && compiled === planRef.current) installedAnimateRef.current = animate;
  const animatorRef = useRef(createUniformAnimator());
  const driftRef = useRef(false);
  const pointerRef = useRef<PointerSource | null>(null);
  const audioRef = useRef<((frame: FrameEvaluationInput) => AudioFeatures | null) | null>(options.audio ?? null);
  audioRef.current = options.audio ?? null;
  // T1785b: refs, read per frame, so neither a new tempo object nor a settings edit rebuilds the transport.
  const tempoRef = useRef<ProjectTempo | null>(options.tempo ?? null);
  tempoRef.current = options.tempo ?? null;
  const tempoSettingsRef = useRef(settings);
  tempoSettingsRef.current = settings;
  const generationRef = useRef(0);

  // Read live so a resize needs no driver restart — `FrameDriverOptions.resolution` is
  // a function for exactly this reason.
  const resolutionRef = useRef(settings.outputResolution);
  resolutionRef.current = settings.outputResolution;
  const fps = projectFps(settings);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  // T1100 (§V45): the project seed, read live like fps — a seed edit re-seeds the next
  // frame, and opening a document carries its seed in with it, with no reset in either
  // case (a settings edit is not a seek). Before this ref existed the transport was
  // built with NO seed at all, so every live picture rendered at seed 0 while offline
  // renders and every headless test honoured the document — T1096's first catch.
  const seedRef = useRef(settings.randomSeed);
  seedRef.current = settings.randomSeed;

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
    // B234: the installed plan's own `animate`, never the newest render's.
    const animateFrame = installedAnimateRef.current;
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

  /**
   * T1497b — THE FRAME CLOCK, published to the bus (`CommandContext.frameClock`).
   *
   * A recall with a morph stamps its record with the absolute clock's reading, and §V44
   * says the command may not read a clock: it reads the last frame THIS loop produced.
   * Both fields come off that one frame — never today's epoch beside an older frame's
   * count, which after a render would place a fade's start minutes into a clock that has
   * just been zeroed. No frame yet (no backend, or nothing rendered) is "no clock", and
   * a morph then commits as a cut and says so.
   */
  useEffect(() => {
    bus.attachFrameClock(() => {
      const frame = latestFrameRef.current?.frame;
      if (frame?.absEpoch === undefined || frame.absTimeSeconds === undefined) return undefined;
      // T1508b: the timeline reading of the same frame — where a timed cue list is.
      return { epoch: frame.absEpoch, absTimeSeconds: frame.absTimeSeconds, timeSeconds: frame.timeSeconds, timelineRate: timelineRate(frame) };
    });
    // §T1557b: and the frame itself, for `readScope` — a command's parameter read resolves
    // at the frame on screen, off the same record the clock above is read from.
    bus.attachFrame(() => latestFrameRef.current?.frame);
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
    // T740/§V662 — and the SCHEDULER is what makes a frame real-time, not this hook. The
    // clock catches up on wall time only while the loop is running: `seek` stops the
    // driver before replaying 0..N, the step button and `renderFrameRange` step a paused
    // driver, and every one of those must advance exactly one frame per call or a slow
    // machine renders a different file (T431, §V44). `driverRef` is read PER FRAME for the
    // same reason fps is — the answer changes while the transport does not.
    // T1497b: a new clock counts from zero, so it counts in a new epoch. See `epochRef`.
    epochRef.current = mintClockEpoch();
    const documentBeat = documentTempo(() => tempoSettingsRef.current);
    const clock = liveClock({
      // T1785b: the beat clock's reading, on every frame (§V1038).
      tempo: (reading) => (tempoRef.current?.read ?? documentBeat)(reading),
      now: () => nowRef.current?.() ?? performance.now(),
      authoritativeClock: () => authoritativeClockRef.current?.() === true,
      fps: () => fpsRef.current,
      // T1100: the document's seed, per frame (§V45's live half). See `seedRef` above.
      seed: () => seedRef.current,
      presenting: () => driverRef.current?.running === true,
      // T1497b: which run of the absolute clock a frame counts in. See `epochRef`.
      epoch: () => epochRef.current ?? undefined,
    });
    /**
     * §T1544b — a frame PULLED ahead of the step that renders it, so a paused step (a seek's
     * replay, the step button) can see which structure the frame needs before it is rendered
     * and install that plan first (`stepInStructure`). The driver's next step consumes it; a
     * reset drops it. Nothing is pulled while no timeline switches structure.
     * §T1547b: a frame the scheduled loop HOLDS is kept here too (`ready`), because stopping
     * the driver drops its own copy — and the transport has already moved past it, so the
     * next paused step would show the frame after it.
     */
    let pulled: EvaluationFrame | null = null;
    const transport: typeof clock = {
      ...clock,
      next: () => {
        const frame = pulled ?? clock.next();
        pulled = null;
        return frame;
      },
      reset: (nextSeed) => {
        pulled = null;
        clock.reset(nextSeed);
      },
    };

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
    const maybeLap = (frameIndex: number): boolean => {
      if (!loopingRef.current) return false;
      // Only during PLAYBACK. A manual step or a typed seek addresses a specific frame
      // deliberately, and taking the user somewhere else instead is the silent kind of
      // wrong. `seek` stops the driver before replaying, so its own frames arrive here
      // with `running === false` and cannot start a lap inside a seek.
      if (driverRef.current?.running !== true) return false;
      const { start, end } = rangeRef.current;
      if (frameIndex < end || transport.wrapTo === undefined) return false;
      transport.wrapTo(start);
      return true;
    };

    /**
     * §T1537b — ask for the segment of the frame that comes NEXT, the moment this one has
     * rendered: a crossing's plan then compiles and installs in the gap before the frame
     * that reaches the cue, which renders in its new structure without waiting. One step
     * on — or the range's start after a lap. Asking for the segment already asked for is
     * free, so between crossings this costs a cached lookup.
     */
    const askAhead = (frame: FrameEvaluationInput, lapped: boolean): void => {
      const link = timelineRef.current;
      if (link === null) return;
      const fps = frame.fps ?? fpsRef.current;
      const next = lapped ? rangeRef.current.start / fps : frame.timeSeconds + 1 / fps;
      link.request({ timeSeconds: next, fps, ...(frame.subframes === undefined ? {} : { subframes: frame.subframes }) });
    };

    const driver = createFrameDriver({
      backend,
      transport,
      pointer,
      // Read through the ref PER TICK: an audio source that appears later (the user
      // adds an audioIn node mid-session) must not need a driver restart.
      audio: (frame) => {
        const audio = audioRef.current?.(frame) ?? null;
        // T1785b: the tempo claim the `audio` source follows, heard once per frame.
        tempoRef.current?.observeAudio(audio);
        return audio;
      },
      resolution: () => {
        const { width, height } = resolutionRef.current;
        return [width, height] as const;
      },
      // T933: the REF, not its value. The driver outlives an fps edit (rebuilding it
      // would reset the transport), so the restart effect below is what carries a rate
      // change to the scheduler — and it carried the rate the driver was BUILT with for
      // as long as this read was `fpsRef.current`.
      fps: () => fpsRef.current,
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
        askAhead(inputs.frame, maybeLap(inputs.frame.frameIndex));
      },
      // §T1537b: playback holds a frame whose structure is still installing — and asks for it.
      ready: (frame) => {
        if (structureReady(frame)) {
          // The held frame renders now: the transport must not offer it again.
          if (pulled === frame) pulled = null;
          return true;
        }
        // §T1547b: a pause drops the driver's held frame; the next step takes it from here.
        pulled = frame;
        timelineRef.current?.request(frame);
        telemetryRef.current?.noteHeldTick();
        return false;
      },
    });
    driverRef.current = driver;
    driver.start();
    setPlaying(true);

    /**
     * §T1544b — PAUSED STEPS, EACH IN ITS OWN STRUCTURE.
     *
     * A seek replays 0..n and the step button steps one; both drive `driver.step()` with the
     * scheduler stopped, and the driver's `ready` hold is for the scheduled loop only. So
     * each frame is pulled before it is stepped (`pulled`), and a frame whose timeline
     * segment is not the installed plan's waits for that plan — asked for, compiled,
     * installed — exactly as `prepareFrame` makes a take wait. Every replayed frame then
     * renders in its own segment, so temporal state carried across a crossing is the
     * play-through's, byte for byte.
     *
     * Synchronous for as long as every frame's segment is installed — always, with no
     * structural timeline — so a plain seek or step is what it always was. The first frame
     * that needs another plan turns the rest of the run asynchronous: the command has
     * returned by then, and the picture lands once the replay does (each crossing costs one
     * install — measured in `timeline-structure-live.gpu.test.ts`). A newer seek abandons a
     * run in flight (it resets the transport and replays from zero itself); a step queues
     * behind one; play pressed during one starts when it ends.
     */
    /** The asynchronous run in flight (null: none), where the queue lands, and play owed after it. */
    let tail: Promise<void> | null = null;
    let landsOn = -1;
    let resumeAfter = false;
    /** Bumped by a seek and by teardown: a run of an older generation stops at its next wait. */
    let generation = 0;
    const needsPlan = (): FrameEvaluationInput | null => {
      if (timelineRef.current === null) return null;
      pulled ??= clock.next();
      return structureReady(pulled) ? null : pulled;
    };
    const stepInStructure = (count: number, finish: (last: FrameInputs | null) => void): { readonly pending: boolean; readonly last: FrameInputs | null } => {
      const mine = generation;
      let last: FrameInputs | null = null;
      let index = 0;
      if (tail === null) {
        for (; index < count; index += 1) {
          if (needsPlan() !== null) break;
          last = driver.step() ?? last;
        }
        if (index === count) {
          finish(last);
          return { pending: false, last };
        }
      }
      const run: Promise<void> = (tail ?? Promise.resolve()).then(async () => {
        if (mine !== generation) return;
        for (; index < count; index += 1) {
          for (let frame = needsPlan(); frame !== null; frame = needsPlan()) {
            const waited = new Promise<void>((resolve) => installWaitersRef.current.push(resolve));
            timelineRef.current?.request(frame);
            await waited;
            if (mine !== generation || driverRef.current !== driver) return;
          }
          last = driver.step() ?? last;
        }
        finish(last);
      });
      tail = run;
      void run.then(() => {
        if (tail !== run) return;
        tail = null;
        if (mine === generation && resumeAfter && !driver.running) driver.start();
        resumeAfter = false;
        setPlaying(driver.running);
      });
      return { pending: true, last };
    };

    // §V52/§V55 — the top bar's play/pause and step buttons, and `space`/`.` from the
    // keymap, all run through these two bus commands (`transport-commands.ts`) rather
    // than calling this closure directly, so the button and the hotkey cannot drift.
    const holder = transportHolderFor(bus);
    holder.current = {
      // §T1544b: while a paused run is still installing, "playing" is the play owed after it.
      isPlaying: () => (tail !== null ? resumeAfter : (driverRef.current?.running ?? false)),
      togglePlay: () => {
        const live = driverRef.current;
        if (live === null) return;
        if (tail !== null) {
          // §T1544b: the scheduler may not run beside a replay; play starts when it ends.
          resumeAfter = !resumeAfter;
          setPlaying(resumeAfter);
          return;
        }
        if (live.running) live.stop();
        else live.start();
        setPlaying(live.running);
      },
      stepFrame: (frames) => {
        const live = driverRef.current;
        if (live === null) return -1;
        // §T1544b: each frame in its own structure. Where the steps land is known up front:
        // a paused step is one frame, and a queued step lands after the run before it.
        const target = (tail !== null ? landsOn : (latestFrameRef.current?.frame.frameIndex ?? -1)) + frames;
        const stepped = stepInStructure(frames, () => undefined);
        if (!stepped.pending) return stepped.last?.frame.frameIndex ?? -1;
        landsOn = target;
        return target;
      },
      // `onFrame` above already records this into `latestFrameRef`, so there is nothing
      // to write here — the export path needs the value RETURNED, not stored.
      stepOnce: () => driverRef.current?.step() ?? null,
      /**
       * VN71 — §V170 AS AMENDED: a seek JUMPS. It renders the target frame and leaves temporal
       * state as it is, as TouchDesigner does (the owner's ruling, 2026-10-07). It used to
       * clear history and replay 0..N so a feedback graph showed its true state at N; that
       * made every seek O(N) and capped the range at what a seek would replay. Feedback
       * depends on the previous frame, so a sought feedback graph carries on from what it
       * holds — and N frames of feedback are what playing N frames gives, the user's call.
       * Starting over is `runtime.resetFeedback`, or `resetState` below for a caller that
       * owes a fresh start (a document load, a take).
       */
      seek: (frameIndex) => {
        const live = driverRef.current;
        if (live === null) return -1;
        // §T1544b: a run still installing is abandoned — this lands somewhere else — and play
        // it owed is owed by this one.
        const wasRunning = live.running || (tail !== null && resumeAfter);
        generation += 1;
        tail = null;
        resumeAfter = false;
        if (live.running) live.stop();
        transport.reset();
        // The clock lands its next frame ON the target (`wrapTo` records it, T740).
        if (frameIndex > 0) transport.wrapTo?.(frameIndex);
        // §T1544b: the one frame in its own segment's plan, installed first when it is not.
        const landed = stepInStructure(1, (last) => {
          latestFrameRef.current = last;
        });
        if (landed.pending) {
          landsOn = frameIndex;
          resumeAfter = wasRunning;
          setPlaying(wasRunning);
          return frameIndex;
        }
        if (wasRunning) live.start();
        setPlaying(live.running);
        return landed.last?.frame.frameIndex ?? -1;
      },
      /**
       * VN71 — every kind of temporal state, cleared: GPU feedback pairs, rings and point
       * buffers (T510: silent, the caller's event is its own, T553), and the CPU's value-graph
       * stages (§V181). Point kernels reseed from `ctx.firstRun`, which this arms, so the next
       * frame rendered — whatever its index — starts a fresh history.
       */
      resetState: () => {
        backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
        onResetRef.current?.();
      },
      /*
       * §T1537b — the export's half: resolves once the plan for timeline frame `frameIndex`
       * (counted from a seek to 0, as a take steps) is the one installed, so the take steps
       * every frame in its own structure. Immediate when there is no structural timeline.
       */
      prepareFrame: async (frameIndex) => {
        const fps = fpsRef.current;
        const frame: StructureFrame = { timeSeconds: frameIndex / fps, fps, subframes: 1 };
        while (!structureReady(frame)) {
          const waited = new Promise<void>((resolve) => installWaitersRef.current.push(resolve));
          timelineRef.current?.request(frame);
          await waited;
        }
      },
      // T467: the RENDER path's verb. The live paths never call this — a seek or a lap
      // leaves the absolute clock growing (T461); only a take starts its clock at zero.
      // T1497b: zeroing the count starts a new EPOCH, in the same breath — every morph
      // record already in the document is finished for the take, and stays finished after.
      resetAbsoluteClock: (at) => {
        transport.resetAbsolute(at);
        epochRef.current = mintClockEpoch();
        // T1785b: and the beat is counted from the take's clock, so a take's beats are its own.
        tempoRef.current?.restartAt((at ?? 0) / fpsRef.current);
      },
      isLooping: () => loopingRef.current,
      toggleLoop: () => {
        loopingRef.current = !loopingRef.current;
        setLooping(loopingRef.current);
      },
    };

    return () => {
      if (holder.current !== null) holder.current = null;
      // §T1544b: a paused run still installing stops at its next wait.
      generation += 1;
      tail = null;
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

  /**
   * T1652b — THE VALUES LANE'S DOOR (`FrameLoopOptions.values`).
   *
   * Taken the way the `valuesOnly` branch of the compile effect below takes a plan: `push`
   * verifies it is a values-only variation of the plan the backend holds and writes the
   * blocks that moved; then the plan and its `animate` are the installed ones, so the next
   * push diffs against these values and the next frame resolves against this revision.
   * Not announced (`installedPlan` keeps its object), for T1163's reason: nothing a
   * consumer of the installed plan reads has moved.
   *
   * REFUSED while a structural install is on its way: that install lands with the values
   * its plan was compiled with, and would overwrite on the device what this wrote. The
   * refusal sends the revision down the structural road, where it queues behind that
   * install and lands after it.
   */
  const pendingInstallRef = useRef(false);
  const laneHeldRef = useRef<{ readonly backend: unknown; readonly plan: CompiledGraph } | null>(null);
  const valuesHandoff = options.values;
  useEffect(() => {
    if (valuesHandoff === undefined || backend === null || backend === undefined) return;
    return valuesHandoff.attach((plan) => {
      const built = planRef.current;
      if (built === null || driverRef.current === null || pendingInstallRef.current) return false;
      if (animatorRef.current.pushRebased(backend, built, plan.compiled) === null) return false;
      planRef.current = plan.compiled;
      liveOutputsRef.current = plan.compiled.outputs;
      installedAnimateRef.current = plan.animate;
      laneHeldRef.current = { backend, plan: plan.compiled };
      return true;
    });
  }, [backend, valuesHandoff]);

  useEffect(() => {
    const driver = driverRef.current;
    if (backend === null || backend === undefined || driver === null) return;
    if (compiled === null || !compiled.ok) {
      // §T1537b: a segment that does not compile is not waited for — its frames render on
      // the plan that is installed (§V9), and its problems are in the problems pane.
      if (compiled !== null) {
        failedSegmentRef.current = timelineRef.current?.compiledKey ?? "";
        wakeInstallWaiters();
      }
      return;
    }

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
    /** §T1537b: the segment this plan was compiled for, read beside it. */
    const segment = timelineRef.current?.compiledKey ?? "";
    const built = planRef.current;
    /*
     * T1652b: this very plan is ALREADY what the backend holds. It arrived by the values
     * lane (above) for a revision the root did not render for, and a render for something
     * else has now caught up with it. Installing it again would be a structural build of
     * the program that is running.
     */
    if (laneHeldRef.current?.plan === compiled && laneHeldRef.current.backend === backend && built === compiled) {
      installedAnimateRef.current = animate;
      return;
    }
    /*
     * T1652b: not while a structural install is on its way, for the reason the lane's door
     * is shut then. `built` is still the plan BEFORE that install; when the two have the
     * same structure (a rename, then a value) the push would be accepted, and the install
     * would then land on top of it with the values ITS plan was compiled with — the value
     * on the device one revision behind the document until something else moved. Falling
     * through queues this plan behind the one in flight (§B235) and supersedes it.
     */
    if (valuesOnlyRef.current && built !== null && !pendingInstallRef.current) {
      const written = animatorRef.current.push(backend, built, compiled);
      if (written !== null) {
        // Later pushes diff against the newest values, so a slider dragged through ten
        // positions writes each block once, not ten times against a stale base.
        planRef.current = compiled;
        liveOutputsRef.current = compiled.outputs;
        installedAnimateRef.current = animate;
        installedSegmentRef.current = segment;
        wakeInstallWaiters();
        /*
         * T1163: deliberately NOT announced. This branch runs only for a plan `push` has
         * verified to be a values-only variation of the installed one (§V5), so it carries
         * the same signature and the same rows — there is nothing here a consumer of
         * `installedPlan` could read differently, and announcing it would re-render the
         * whole App on every parameter edit for no observable change (§V16).
         *
         * §B188 checked rather than assumed, because "the same rows" is the claim that
         * was false one branch down: `useGraphCompile` only classifies a change as
         * values-only while `previous.sinks === scheduledPreviews`, so the SYNTHESIS SET
         * cannot move under this branch — only the uniform values inside it, which
         * `installedPlanKey` is blind to on purpose.
         */
        return;
      }
    }

    // T733/B141 — owed at SCHEDULE time, while the flags still belong to the plan being
    // built. Reading them after the await is what dropped the work.
    if (documentBoundaryRef.current) {
      // B185: taken, so it stops being owed HERE — the debt now lives in
      // `boundaryOwedRef`, which survives a superseding compile. Leaving it set would
      // make the NEXT edit in this document reset feedback and seek to zero as well.
      documentBoundaryRef.current = false;
      boundaryOwedRef.current = true;
      // T1163: and the announced signature belongs to the document being closed. Two
      // documents can compile to the same plan (two empty ones do), and without this the
      // incoming one would be skipped as "unchanged" while `app.tsx` has already cleared
      // the latch at the boundary — leaving it null for good.
      installedSignatureRef.current = null;
    }
    if (resetFeedbackRef.current) {
      resetFeedbackRef.current = false;
      feedbackResetOwedRef.current = true;
    }

    const generation = (generationRef.current += 1);
    const warmPlan = warmPlanRef.current;
    // T1652b: until this lands (or a newer one does), the values lane's door is shut.
    pendingInstallRef.current = true;
    // §B235: queued behind the compile already in flight, never beside it — two compiles
    // carrying from one retained program destroy each other's objects. A request a newer
    // one overtook while it waited is never sent (`null`).
    void compileLatest(backend, compiled)
      .then((plan) => {
        // A newer compile landed while this one was in flight — that result, not this
        // one, is authoritative for the driver.
        if (generation !== generationRef.current || plan === null) return;
        pendingInstallRef.current = false;
        // The structural plan the per-frame push diffs against. Reset together, so a
        // recompile never leaves the animator comparing against a plan that is gone.
        planRef.current = compiled;
        // §T1537b: and the segment it is — what the next frame's `ready` compares against.
        installedSegmentRef.current = segment;
        if (failedSegmentRef.current === segment) failedSegmentRef.current = null;
        // B234: and its `animate` with it. The newest one if a render has re-keyed it for
        // this same plan while the compile was in flight; otherwise the one it came with.
        installedAnimateRef.current = compiledRef.current === compiled ? animateRef.current : animate;
        // T1163 — HERE, inside the `.then`, is the moment the backend actually holds it.
        // The generation guard above has already dropped a superseded install, so this
        // can only ever announce the newest plan that landed.
        // §B188: keyed on what a CONSUMER can read, which the plan signature alone is not.
        liveOutputsRef.current = compiled.outputs;
        const key = installedPlanKey(compiled);
        if (installedSignatureRef.current !== key) {
          installedSignatureRef.current = key;
          setInstalledPlan(compiled);
        }
        animatorRef.current.reset();
        driftRef.current = false;
        driverRef.current?.setPlan(plan);
        // §T1544b: what this install built and adopted, for the performance pane.
        telemetryRef.current?.setBuild(backend.status.lastBuild ?? null);
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
          // VN71: a seek no longer clears anything, so the load clears both halves itself.
          const handlers = transportHolderFor(bus).current;
          if (handlers === null) backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
          else {
            handlers.resetState();
            handlers.seek(0);
          }
        } else if (feedbackResetOwedRef.current) {
          feedbackResetOwedRef.current = false;
          backend.resetTemporalHistory(undefined, { silent: true });
        }
        /*
         * §T1507b — what a bypassed Layer would bring back, built AHEAD, so switching it on
         * builds nothing. In a task of its own: neither the warm plan's compile nor the
         * backend's builds land in the frame that follows this install, and a newer install
         * before it runs supersedes it. Advisory — a warm plan that cannot be had is no
         * warm-up, and the switch's own compile reports whatever is wrong with it.
         */
        wakeInstallWaiters();
        if (warmPlan !== null && backend.warmPasses !== undefined) {
          const warmPasses = backend.warmPasses.bind(backend);
          setTimeout(() => {
            if (generation !== generationRef.current) return;
            let ahead: CompiledGraph | null;
            try {
              // §T1544b: the range being looped, so a wrap back to its start is built ahead too.
              ahead = warmPlan(loopingRef.current ? rangeRef.current : null);
            } catch {
              ahead = null;
            }
            void warmPasses(ahead).catch(() => undefined);
          }, 0);
        }
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) return;
        pendingInstallRef.current = false;
        // §T1537b: the backend refused this segment's plan; its frames take the installed one.
        failedSegmentRef.current = segment;
        wakeInstallWaiters();
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
  return { diagnostics, clearDiagnostics, playing, looping, latestFrame, installedPlan, liveOutputs };
}
