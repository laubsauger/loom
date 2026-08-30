import type { ShaderloomBus } from "@domain/commands/bus.ts";

/**
 * Transport as a bus command (§V29, §V52, T184).
 *
 * `space` and `.` already named `transport.togglePlay` and `transport.stepFrame` in the
 * keymap defaults, and both reported unresolved: nothing registered them, correctly,
 * while no frame loop existed to act on. `useFrameLoop` is the only thing that holds a
 * `FrameDriver`, so — exactly like `graph.selectAll` and hover/selection state — the
 * owner of the state registers the command. The top bar's play/pause and step controls
 * call `bus.execute` too (never this holder directly), so the button and the hotkey
 * cannot drift into two different code paths for one action.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Toggle the live frame loop. Reports the resulting play state. */
    "transport.togglePlay": { input: Record<string, never>; output: { playing: boolean } };
    /** Idempotent verbs (T292): an agent told "play" while playing must not pause. */
    "transport.play": { input: Record<string, never>; output: { playing: boolean } };
    "transport.pause": { input: Record<string, never>; output: { playing: boolean } };
    /** Render exactly `frames` (default 1) frames synchronously. Reports the last frame index. */
    "transport.stepFrame": { input: { frames?: number }; output: { frameIndex: number } };
    /**
     * Jump to a frame (T265, §V170).
     *
     * Implemented as a REPLAY: the transport is reset, temporal history is cleared, and
     * the graph is stepped forward to the requested frame. That is the only honest way to
     * seek a graph with feedback, a Cache or a point simulation — their state is not a
     * function of frame index, so jumping the counter and leaving the state alone would
     * show a picture belonging to a different history and look like a working scrub.
     *
     * The cost is linear in the target frame, and bounded: past `SEEK_FRAME_LIMIT` the
     * command reports rather than freezing the tab for a typo.
     */
    "transport.seek": { input: { frameIndex: number }; output: { frameIndex: number } };
  }
}

/**
 * How far a seek will replay before it refuses (§V170).
 *
 * 10 000 frames is ~2.8 minutes of 60 fps material — past anything someone scrubs to by
 * hand, and low enough that a mistyped `1e9` reports instead of hanging the browser.
 */
export const SEEK_FRAME_LIMIT = 10_000;

export interface TransportHandlers {
  isPlaying(): boolean;
  togglePlay(): void;
  stepFrame(frames: number): number;
  /** Replays from frame 0 to `frameIndex`, clearing temporal state first (§V170). */
  seek(frameIndex: number): number;
}

export interface TransportHolder {
  current: TransportHandlers | null;
}

const holders = new WeakMap<object, TransportHolder>();

export function transportHolderFor(bus: ShaderloomBus): TransportHolder {
  const existing = holders.get(bus);
  if (existing !== undefined) return existing;
  const holder: TransportHolder = { current: null };
  holders.set(bus, holder);
  return holder;
}

/**
 * The refusal `space`, `.` and the top bar's buttons all land on when there is nothing to
 * drive (§V288, B48).
 *
 * A warning rather than info, and it names the cause rather than the symptom: "no frame
 * loop" on its own reads as a timing accident, when on a machine with no WebGPU it is the
 * permanent truth for the whole session. Silence was the old behaviour and it is what
 * made B48 look like a broken app instead of an unavailable feature.
 */
const NO_LOOP_DIAGNOSTIC = {
  severity: "warning" as const,
  code: "transport.noLoop",
  message: "No frame loop is attached, so there is nothing to play, step or seek.",
  suggestion:
    "The loop is created with the GPU device — a build with no WebGPU has no transport to run.",
};

export function registerTransportCommands(bus: ShaderloomBus): TransportHolder {
  const holder = transportHolderFor(bus);

  if (!bus.hasCommand("transport.togglePlay")) {
    bus.registerCommand({
      name: "transport.togglePlay",
      description: "Play or pause the live frame loop.",
      handler: (_input, context) => {
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { playing: false },
          };
        }
        if (!context.dryRun) holder.current.togglePlay();
        return {
          status: "applied",
          revision: context.store.getRevision(),
          output: { playing: holder.current.isPlaying() },
        };
      },
      rejectionOutput: () => ({ playing: false }),
    });
  }

  // T292: `play` and `pause` as their own verbs — the agent tools have named them since
  // T77, and "toggle" is the wrong contract for a caller that cannot see the current
  // state (an agent told "play" while playing must NOT pause).
  const registerVerb = (name: "transport.play" | "transport.pause", want: boolean): void => {
    if (bus.hasCommand(name)) return;
    bus.registerCommand<"transport.play">({
      name: name as "transport.play",
      description: want ? "Start the frame loop (idempotent)." : "Stop the frame loop (idempotent).",
      handler: (_input, context) => {
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { playing: false },
          };
        }
        if (!context.dryRun && holder.current.isPlaying() !== want) holder.current.togglePlay();
        return {
          status: "applied",
          revision: context.store.getRevision(),
          output: { playing: holder.current.isPlaying() },
        };
      },
      rejectionOutput: () => ({ playing: false }),
    });
  };
  registerVerb("transport.play", true);
  registerVerb("transport.pause", false);

  if (!bus.hasCommand("transport.stepFrame")) {
    bus.registerCommand({
      name: "transport.stepFrame",
      description: "Render exactly one frame (or the given count) synchronously.",
      handler: (input, context) => {
        if (holder.current === null) {
          return {
            status: "rejected",
            revision: context.store.getRevision(),
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { frameIndex: -1 },
          };
        }
        const frames = Math.max(1, Math.trunc(input.frames ?? 1));
        const frameIndex = context.dryRun ? -1 : holder.current.stepFrame(frames);
        return { status: "applied", revision: context.store.getRevision(), output: { frameIndex } };
      },
      rejectionOutput: () => ({ frameIndex: -1 }),
    });
  }

  if (!bus.hasCommand("transport.seek")) {
    bus.registerCommand({
      name: "transport.seek",
      description: "Jump to a frame by replaying from the start (§V170).",
      handler: (input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return {
            status: "rejected",
            revision,
            diagnostics: [NO_LOOP_DIAGNOSTIC],
            output: { frameIndex: -1 },
          };
        }
        const target = Math.trunc(input.frameIndex);
        if (!Number.isFinite(target) || target < 0) {
          return {
            status: "rejected",
            revision,
            diagnostics: [
              {
                severity: "error" as const,
                code: "transport.seekRange",
                message: `Frame ${input.frameIndex} is not a frame.`,
              },
            ],
            output: { frameIndex: -1 },
          };
        }
        if (target > SEEK_FRAME_LIMIT) {
          return {
            status: "rejected",
            revision,
            diagnostics: [
              {
                severity: "warning" as const,
                code: "transport.seekLimit",
                message: `Seeking to frame ${target} would replay ${target} frames; the limit is ${SEEK_FRAME_LIMIT}.`,
                suggestion:
                  "A graph with feedback has no state at a frame it has not reached, so a seek replays rather than jumping.",
              },
            ],
            output: { frameIndex: -1 },
          };
        }
        const frameIndex = context.dryRun ? -1 : holder.current.seek(target);
        return { status: "applied", revision, output: { frameIndex } };
      },
      rejectionOutput: () => ({ frameIndex: -1 }),
    });
  }

  return holder;
}
