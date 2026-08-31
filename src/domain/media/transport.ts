import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterSchema, ParameterValue } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { resolveParameters } from "../parameters/index.ts";

/**
 * MEDIA TRANSPORT (T493, §V436, §V45, §V5) — one idea, two doors.
 *
 * Movie File In and Audio File In had no transport at all: a `file` parameter, and for
 * audio a `monitor` toggle. You could not play, pause, cue, scrub, trim, loop or set a
 * speed. This module is the whole vocabulary, written ONCE, so that the two nodes cannot
 * drift into two different answers about what "cue" means — the same reason
 * `compileMedia` is shared between the movie node and the webcam, and the reason T434
 * shaped the audio file node as the movie node's analog in the first place.
 *
 * ## WHICH CLOCK (§V436, §V453) — TWO, and the DEFAULT is FREE RUN (T586)
 *
 * `mediaPlayhead` is a PURE FUNCTION of (parameters, elapsed seconds, duration). There is
 * no accumulator, no `<video>.currentTime` read, no wall clock. Which clock the caller
 * feeds it is the design decision (§V436), and this node offers both:
 *
 *  - LOCKED TO TIMELINE — the caller passes the TIMELINE clock, so the playhead is
 *    `f(frame)`. A SCRUB finds the same media frame every time, because the same timeline
 *    frame yields the same position by construction; an OFFLINE RENDER reproduces
 *    byte-for-byte (§V45, §V47), because nothing about the position depends on how, or
 *    how fast, you arrived at the frame; and a LOOP wraps the position along with the
 *    timeline, which is what "timeline-anchored" MEANS — frame one of the piece lands on
 *    the in point every lap, the same reasoning `audioPattern` states for itself.
 *  - FREE RUN — the caller accumulates elapsed time of its own and passes that instead,
 *    so `play`/`cuePulse` become expressible, and the position stops being a function of
 *    the frame. A scrub no longer finds it and an offline render no longer reproduces it.
 *
 * T586 — WHY FREE RUN IS THE DEFAULT, REVERSING T493's RULING. This is the OWNER'S CALL,
 * not a discovery, and T493's argument was not wrong: position as a pure function of the
 * frame is what buys scrubbing and reproducible renders, and TouchDesigner's own default
 * is Locked to Timeline. What settles it is that TD's centre of gravity is a timeline and
 * ours is a VJ set. Under the lock a freshly loaded track does NOTHING until the timeline
 * runs, and `play`/`cuePulse` render DIMMED (§V146) — so someone drops in a file, presses
 * Play, and finds the control disabled. That is the first thing a new user meets, and it
 * reads as a broken node rather than as a design decision.
 *
 * THE COST IS REAL AND IS NOT ALLOWED TO BE SILENT. A free-run playhead is not `f(frame)`,
 * so a project holding one renders a take that does not reproduce what was heard. Neither
 * silently diverging nor silently forcing the lock is acceptable — forcing it would make
 * the take differ from the take the user approved, which is worse than a warning. So
 * `freeRunMediaNodes` below names the offending nodes, and the render command turns that
 * into a warning that says which node and that the lock is the fix (§V338, §V403: an
 * absence or a caveat we report must name what would make it go away).
 *
 * The absolute clock (§V449, T489) is deliberately NOT what either mode reads. A media
 * file has a beginning, and free run starts it at the in point rather than wherever the
 * session happens to have got to.
 *
 * ## WHY `play` IS INACTIVE WHEN LOCKED TO THE TIMELINE (§V146)
 *
 * This is the one place the two ideas collide, and TouchDesigner resolves it the same way:
 * `Play` and `Cue Pulse` apply in Sequential mode and not in Locked to Timeline. A `play`
 * toggle that worked under the timeline lock would have to INTEGRATE — position becomes
 * the running sum of play × speed over every frame you happened to render — and that is
 * precisely the hidden accumulator that kills scrubbing and offline render. So under the
 * lock the TIMELINE's own play/pause IS the media's play/pause, and `inactiveWhen` says
 * so in a sentence rather than leaving a live control that quietly does nothing (§V123).
 *
 * `cue` is NOT inactive, because holding at a point is a pure function: `cue` on means
 * "the position is the cue point", in either mode. It is the momentary JUMP that needs
 * state, and that is `cuePulse`.
 *
 * T586 does NOT touch this logic, which was right: it is the reason the owner hit the
 * confusion, not the confusion itself. Under the new default both controls are simply
 * ACTIVE most of the time, which is the entire point of the flip — the dimming now marks
 * the mode you deliberately opted into rather than the one you were dropped in.
 */

export type MediaPlayMode = "timeline" | "freeRun";

/**
 * What happens outside the trim window.
 *
 * This is TD's Extend Left / Extend Right (Trim page) and its `repeat` / `Audio Loop`
 * folded into ONE control, because they are one idea and shipping two would let a node
 * hold two contradictory answers ("loop off, extend right = cycle"). `loop` is the
 * default and is what a `repeat` toggle would have meant; `hold` freezes the last frame
 * (silence-with-DC for audio, so it is really "stop"); `mirror` ping-pongs; `black`
 * shows nothing and is silent, which is the honest "there is no media here" state rather
 * than a frozen frame that reads as a stall.
 *
 * Symmetric in both directions on purpose: `speed` may be negative, and a separate
 * before/after pair would then need the user to reason about which end "before" is.
 */
export type MediaExtend = "loop" | "hold" | "mirror" | "black";

/** The transport, as read off a node's resolved parameters. */
export interface MediaTransportValues {
  readonly playMode: MediaPlayMode;
  /** Free-run only; under the timeline lock the timeline's own transport is the play. */
  readonly play: boolean;
  /** Rate multiplier. Negative runs backwards. */
  readonly speed: number;
  /** Hold at `cuePoint` while true. Pure in both modes. */
  readonly cue: boolean;
  /** Seconds into the MEDIA, not into the trim window. */
  readonly cuePoint: number;
  /** In point, seconds. */
  readonly trimStart: number;
  /** Out point, seconds. `<= 0` means "the end of the file". */
  readonly trimEnd: number;
  readonly extend: MediaExtend;
}

/** Where the media is, and what that means for what you see or hear. */
export interface MediaPlayhead {
  /** Seconds into the media. Always inside `[start, end]` unless the window is unknown. */
  readonly position: number;
  /** In point in seconds, after trim and duration clamping. */
  readonly start: number;
  /** Out point in seconds. Equals `start` when the duration is not known yet. */
  readonly end: number;
  /**
   * False when `extend: "black"` has taken us outside the window: show nothing, play
   * nothing. Distinct from `done` — a mirrored transport is never black and never done.
   */
  readonly visible: boolean;
  /** TD's `.done`: the window has been played out and nothing will bring it back. */
  readonly done: boolean;
  /** Held at the cue point. The element must be paused there rather than playing on. */
  readonly cued: boolean;
  /** How many whole windows have been traversed. 0 on the first pass. */
  readonly laps: number;
}

/** Positive modulo. `-1 % 10` is `-1` in JS and a negative speed needs `9`. */
function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The whole transport, as arithmetic.
 *
 * `elapsedSeconds` is the CLOCK the caller decided this node reads — `frame.timeSeconds`
 * under the timeline lock (§V436: that is the decision, and it is why a scrub works), or
 * the caller's own accumulated media time in free-run. Everything downstream of that
 * choice is identical, which is what makes the two modes one implementation rather than
 * two transports that drift.
 *
 * `duration` is the file's length in seconds, or `0` while it is not known (nothing
 * loaded, headless, a node whose file was never picked). An unknown duration does not
 * fail: the window is open-ended, the position still advances, and `done` stays false —
 * a transport that reported "done" because it had not loaded yet would be the silent
 * wrong answer (§V369).
 */
export function mediaPlayhead(
  transport: MediaTransportValues,
  elapsedSeconds: number,
  duration: number,
): MediaPlayhead {
  const length = Math.max(0, finite(duration, 0));
  const trimStart = Math.max(0, finite(transport.trimStart, 0));
  const start = length > 0 ? clamp(trimStart, 0, length) : trimStart;
  const trimEnd = finite(transport.trimEnd, 0);
  const rawEnd = trimEnd > 0 ? trimEnd : length;
  const end = length > 0 ? clamp(Math.max(rawEnd, start), start, length) : Math.max(rawEnd, start);
  const window = end - start;

  // CUE FIRST, and unconditionally: a held cue overrides the clock in either mode, which
  // is what makes it the one transport verb that stays pure under the timeline lock.
  if (transport.cue) {
    const cuePoint = Math.max(0, finite(transport.cuePoint, 0));
    return {
      position: window > 0 ? clamp(cuePoint, start, end) : cuePoint,
      start,
      end,
      visible: true,
      done: false,
      cued: true,
      laps: 0,
    };
  }

  const offset = finite(elapsedSeconds, 0) * finite(transport.speed, 1);

  // An unknown window cannot wrap, hold or mirror — there is nothing to wrap AGAINST.
  // Advance from the in point and claim nothing else; the element will do whatever its
  // own duration implies until the metadata arrives, and reporting `done` here would be
  // the plausible-wrong answer for a file that has simply not loaded yet (§V369).
  if (length <= 0) {
    return { position: start + offset, start, end, visible: true, done: false, cued: false, laps: 0 };
  }

  // A window the user COLLAPSED (trimStart === trimEnd) is a decision, not a gap in the
  // metadata: hold the one frame they asked for rather than sliding past it.
  if (window <= 0) {
    return { position: start, start, end, visible: true, done: false, cued: false, laps: 0 };
  }

  const laps = Math.floor(offset / window);
  switch (transport.extend) {
    case "loop":
      return {
        position: start + wrap(offset, window),
        start,
        end,
        visible: true,
        done: false,
        cued: false,
        laps,
      };
    case "mirror": {
      // Ping-pong: one period is TWO windows, and the second half runs backwards.
      const phase = wrap(offset, window * 2);
      return {
        position: start + (phase > window ? window * 2 - phase : phase),
        start,
        end,
        visible: true,
        done: false,
        cued: false,
        laps,
      };
    }
    case "black": {
      const inside = offset >= 0 && offset <= window;
      return {
        position: start + clamp(offset, 0, window),
        start,
        end,
        visible: inside,
        done: offset > window,
        cued: false,
        laps,
      };
    }
    case "hold":
    default:
      return {
        position: start + clamp(offset, 0, window),
        start,
        end,
        visible: true,
        done: offset > window,
        cued: false,
        laps,
      };
  }
}

const PLAY_MODE_OPTIONS = [
  { value: "timeline", label: "Locked to Timeline" },
  { value: "freeRun", label: "Free Run" },
] as const;

const EXTEND_OPTIONS = [
  { value: "loop", label: "Loop" },
  { value: "hold", label: "Hold Last" },
  { value: "mirror", label: "Mirror" },
  { value: "black", label: "Black" },
] as const;

/** §V146: the one sentence a user gets when `play` cannot do anything, and why. */
function timelineLockedPlay(values: Readonly<Record<string, ParameterValue>>): string | null {
  return values["playMode"] === "freeRun"
    ? null
    : "Locked to Timeline, so the timeline's own play/pause is this node's play/pause. A media node that paused independently would make its position depend on how you reached the frame, which is exactly what stops a scrub and an offline render from reproducing (§V45). Switch Play Mode to Free Run to drive it by hand.";
}

function timelineLockedJump(values: Readonly<Record<string, ParameterValue>>): string | null {
  return values["playMode"] === "freeRun"
    ? null
    : "A jump is a change of state, and under the timeline lock the position is the frame's. Turn Cue on to HOLD at the cue point instead — that stays a pure function of the frame.";
}

/**
 * THE VOCABULARY, declared once (T493).
 *
 * Ordinary parameters, so every one of them takes the five modes like everything else
 * (§V107): a `speed` on an expression, a `cue` bound to a sibling, a `trimStart` driven
 * by an audio channel. None is `compileTime`, so animating one costs no recompile (§V5) —
 * they are read by the APP's media hooks, never by `compile`, exactly as `audioIn.device`
 * and the Text node's string are.
 *
 * `group` is what keeps this dense rather than a wall of eleven fields: the inspector
 * already sections by group, so Transport / Trim / File collapse into three bands and the
 * node earns its pixels without a bespoke control strip (which would also have to be
 * built twice, once per node).
 */
export const MEDIA_TRANSPORT_PARAMETERS: ParameterSchema = {
  playMode: {
    type: "enum",
    label: "Play Mode",
    group: "Transport",
    // T586, THE OWNER'S CALL: free run, so a file you just dropped in plays when you press
    // Play. The lock is opt-in and loses nothing by being opt-in — `mediaPlayhead` is the
    // same pure function under it.
    default: "freeRun",
    options: [...PLAY_MODE_OPTIONS],
    description:
      "Free Run (the default) gives the node its own playhead that Play and Cue Pulse drive, so a file plays as soon as you press Play. Locked to Timeline instead derives the position from the frame, so scrubbing, looping and offline render all reproduce — free run gives up all three, and a render warns you by name when it is on.",
  },
  play: {
    type: "boolean",
    label: "Play",
    group: "Transport",
    default: true,
    inactiveWhen: timelineLockedPlay,
    description: "Free Run only: advance the playhead, or hold it where it is.",
  },
  speed: {
    type: "number",
    label: "Speed",
    group: "Transport",
    default: 1,
    min: -4,
    max: 4,
    range: "soft",
    step: 0.01,
    description: "Rate multiplier. Negative runs backwards; 0 freezes.",
  },
  cue: {
    type: "boolean",
    label: "Cue",
    group: "Transport",
    default: false,
    description: "Hold at the cue point while on. Works in both play modes.",
  },
  cuePoint: {
    type: "number",
    label: "Cue Point",
    group: "Transport",
    default: 0,
    min: 0,
    range: "floor",
    step: 0.01,
    unit: "seconds",
    description: "Seconds into the FILE, not into the trim window.",
  },
  cuePulse: {
    type: "pulse",
    label: "Cue Pulse",
    group: "Transport",
    fires: "media.cue",
    input: { nodeIds: ["$node"] },
    inactiveWhen: timelineLockedJump,
    description: "Free Run only: jump to the cue point once and carry on from there.",
  },
  trimStart: {
    type: "number",
    label: "Trim Start",
    group: "Trim",
    default: 0,
    min: 0,
    range: "floor",
    step: 0.01,
    unit: "seconds",
    description: "In point.",
  },
  trimEnd: {
    type: "number",
    label: "Trim End",
    group: "Trim",
    default: 0,
    min: 0,
    range: "floor",
    step: 0.01,
    unit: "seconds",
    description: "Out point. 0 means the end of the file.",
  },
  extend: {
    type: "enum",
    label: "At End",
    group: "Trim",
    default: "loop",
    options: [...EXTEND_OPTIONS],
    description:
      "What happens outside the trim window, in both directions: Loop cycles, Hold Last freezes, Mirror ping-pongs, Black shows and plays nothing.",
  },
  reload: {
    type: "pulse",
    label: "Reload",
    group: "File",
    fires: "media.reload",
    input: { nodeIds: ["$node"] },
    description: "Re-open the file from source and start the window again.",
  },
};

/** Every key the transport owns — the one list the readers and the gate both derive from. */
export const MEDIA_TRANSPORT_KEYS: readonly string[] = Object.keys(MEDIA_TRANSPORT_PARAMETERS);

/**
 * §V453/§V316, as a DERIVATION rather than a hand list: a node has a media transport when
 * it declares the transport's parameters. So media node N+1 is classified — or fails the
 * clock gate — by construction, without anyone remembering to add it anywhere.
 */
export function hasMediaTransport(definition: NodeDefinition): boolean {
  const parameters = definition.parameters;
  if (parameters === undefined) return false;
  return MEDIA_TRANSPORT_KEYS.every((key) => parameters[key] !== undefined);
}

/** One node whose playhead will not reproduce, and enough to name it to the user. */
export interface FreeRunMediaNode {
  readonly nodeId: NodeId;
  /** The node's label if it has one, else its id — whatever the user sees in the graph. */
  readonly label: string;
  /** "Movie File In" / "Audio File In" — the definition's title, not the type key. */
  readonly title: string;
}

/**
 * T586's HONEST EDGE, as a pure function of the document (§V338, §V403).
 *
 * The flip makes free run the default, and a free-run playhead is not `f(frame)` — so a
 * take rendered from a project holding one does not reproduce what was heard. The rule
 * this satisfies is §V338's: not silently diverging, AND not silently forcing the lock,
 * because forcing it would hand back a different take from the one the user approved.
 * What is left is to SAY SO, per node, by name, with the fix named too — which is why this
 * returns the LABEL rather than a count. "One media node is free-running" is the useless
 * half of the warning.
 *
 * DERIVED, not a hand list (§V316, and the same derivation `hasMediaTransport` already
 * powers): media node N+1 is covered the moment it declares the transport, with nothing to
 * remember to update here. Read through `resolveParameters` (§V61) so a `playMode` on an
 * expression or a bind answers the same way a typed one does — this is the one parameter
 * read path, not a second opinion about what the document says.
 */
export function freeRunMediaNodes(
  graph: GraphDocument,
  registry: NodeRegistryView,
): readonly FreeRunMediaNode[] {
  const found: FreeRunMediaNode[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    if (definition === undefined || !hasMediaTransport(definition)) continue;
    const resolved = resolveParameters(node, definition, {});
    const transport = mediaTransportFrom((key) => resolved.get(key)?.value);
    if (transport.playMode !== "freeRun") continue;
    found.push({
      nodeId: nodeId as NodeId,
      label: node.label !== undefined && node.label !== "" ? node.label : nodeId,
      title: definition.title,
    });
  }
  return found;
}

/*
 * T645 — the WARNING that used to live here now lives in `../render/reproducibility.ts`.
 *
 * `freeRunRenderWarning` said one true thing about one class of node, and T644 is what the
 * narrowness cost: `webcam` declares no transport, so `hasMediaTransport` was false, so
 * this file never saw it, so a take over a live camera warned about nothing. The sentence
 * it built is unchanged and is now ONE CLAUSE of a warning that also covers live devices
 * and async readbacks, under one code, from one call site (§V109).
 *
 * `freeRunMediaNodes` stays here because the DERIVATION belongs here: it is a fact about
 * the media transport's own `playMode`, read through `resolveParameters`, and the
 * reproducibility module consumes it rather than re-deriving it.
 */

const PLAY_MODES = new Set<string>(["timeline", "freeRun"]);
const EXTENDS = new Set<string>(["loop", "hold", "mirror", "black"]);

/**
 * Read the transport off whatever a caller has resolved.
 *
 * Tolerant in the same way `urlOf` is: the app resolves through `resolveParameters`
 * (§V61) and gets real types, a headless test hands in a bare record, and an older
 * document may be missing keys entirely. A missing or wrong-typed key falls back to the
 * SCHEMA's default rather than to zero.
 *
 * T586 — THIS FALLBACK MOVES WITH THE SCHEMA, and must: a document stores `playMode` only
 * when the user set it, so "missing" and "default" are the same state and two answers
 * about it would be a node that plays differently depending on which reader looked. A
 * document saved between T493 and T586 without touching Play Mode therefore opens in free
 * run — which is also how media behaved BEFORE T493, when the element simply played on its
 * own clock. A document that explicitly chose the lock keeps it.
 */
export function mediaTransportFrom(
  read: (key: string) => ParameterValue | undefined,
): MediaTransportValues {
  const number = (key: string, fallback: number): number => {
    const value = read(key);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const value = read(key);
    return typeof value === "boolean" ? value : fallback;
  };
  const playMode = read("playMode");
  const extend = read("extend");
  return {
    playMode:
      typeof playMode === "string" && PLAY_MODES.has(playMode)
        ? (playMode as MediaPlayMode)
        : "freeRun",
    play: boolean("play", true),
    speed: number("speed", 1),
    cue: boolean("cue", false),
    cuePoint: number("cuePoint", 0),
    trimStart: number("trimStart", 0),
    trimEnd: number("trimEnd", 0),
    extend:
      typeof extend === "string" && EXTENDS.has(extend) ? (extend as MediaExtend) : "loop",
  };
}

/**
 * The free-run accumulator, kept HERE so both doors run the same one (T493).
 *
 * It exists only because free-run exists: `play`, `speed` and a cue PULSE are integrated
 * over real frames, which is the state that makes the mode non-reproducible. Holding it in
 * one factory means the movie hook and the audio hook cannot disagree about what "paused"
 * did to the elapsed time — the drift this task was told to design out.
 */
export interface MediaClock {
  /** Advance by one frame's delta and return the elapsed media time to feed the playhead. */
  advance(transport: MediaTransportValues, deltaSeconds: number, timelineSeconds: number): number;
  /** A cue pulse: put the playhead at `head.start + offset` and carry on from there. */
  cueTo(transport: MediaTransportValues, head: MediaPlayhead, position: number): void;
  reset(): void;
}

export function createMediaClock(): MediaClock {
  let elapsed = 0;
  return {
    advance(transport, deltaSeconds, timelineSeconds) {
      // Under the lock there is no accumulator at all — the timeline IS the elapsed time,
      // and keeping the free-run one in step means switching modes does not jump.
      if (transport.playMode !== "freeRun") {
        elapsed = timelineSeconds;
        return timelineSeconds;
      }
      if (transport.play) {
        elapsed += Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
      }
      return elapsed;
    },
    cueTo(transport, head, position) {
      // Stored as ELAPSED, so the very next `advance` continues from the cue point rather
      // than snapping back — and inverted through the SAME arithmetic `mediaPlayhead`
      // applies (`offset = elapsed * speed`, `position = start + offset`), so a cue lands
      // on the frame the playhead function itself would report. Speed 0 has no elapsed
      // time that maps to a position, so the jump is held by `cue` rather than silently
      // doing nothing (§V123).
      const speed = finite(transport.speed, 1);
      if (speed === 0) return;
      elapsed = (position - head.start) / speed;
    },
    reset() {
      elapsed = 0;
    },
  };
}
