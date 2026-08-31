import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * Arming, disarming and saving an audio feature track (T452, §V352).
 *
 * ## Why an ARM and not always-on
 *
 * Always-on feature capture records what the room sounded like whether or not anyone
 * asked, and grows for as long as the tab is open. An arm the user pressed is honest
 * about what it is doing and bounded by construction — the recording is exactly the span
 * between two deliberate acts.
 *
 * ## Where the track goes, and where it does NOT
 *
 * NOT into the project file. A performance is not the document: a `.loom.json` carrying
 * a recorded session grows without limit and couples the recording to the thing being
 * recorded (§V18). It is a separate artifact, written through `writeTextFile` — the same
 * picker-then-download ladder a saved project takes and a rendered sequence will take,
 * because a recorded performance and a rendered frame sequence are outputs of the same
 * kind and must not acquire two different behaviours on the browsers that lack a picker.
 *
 * Like `graph.selectAll` and `view.frameAll`, these live beside their surface: whether a
 * recorder is armed is session state the document knows nothing about, so there is
 * nothing for `ctx.apply` to write and no undo entry to make.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Arms or disarms feature capture. Reports the resulting state and how many frames
     * are held, so a caller can tell "armed" from "armed and already recording".
     */
    "audio.toggleTrackRecording": {
      input: Record<string, never>;
      output: { recording: boolean; frames: number };
    };
    /** Writes the recorded track to a file. Reports what was written. */
    "audio.saveTrack": {
      input: Record<string, never>;
      output: { saved: boolean; frames: number; fileName: string | null };
    };
  }
}

export interface AudioTrackHandlers {
  /** Flips the arm. Returns the resulting state. */
  toggle(): { recording: boolean; frames: number };
  /** Frames captured so far, armed or not. */
  frames(): number;
  /** True when the session has a live audio capture to record FROM. */
  hasSource(): boolean;
  /** Writes the track. Returns the file name, or null when the user cancelled. */
  save(): Promise<{ fileName: string | null; failure: string | null }>;
}

export interface AudioTrackHolder {
  current: AudioTrackHandlers | null;
}

export function audioTrackHolderFor(bus: ShaderloomBus): AudioTrackHolder {
  return commandHolder<AudioTrackHandlers>(bus, "audio.toggleTrackRecording");
}

const NO_SESSION = {
  severity: "warning" as const,
  code: "audio.noSession",
  message: "No running session is holding a recorder, so there is nothing to record.",
};

/** Idempotent: the bus has no unregister, and React mounts more than once. */
export function registerAudioTrackCommands(bus: ShaderloomBus): AudioTrackHolder {
  const holder = audioTrackHolderFor(bus);
  if (bus.hasCommand("audio.toggleTrackRecording")) return holder;

  bus.registerCommand({
    name: "audio.toggleTrackRecording",
    description: "Start or stop recording the session's audio features to a track.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      const handlers = holder.current;
      if (handlers === null) {
        return { status: "rejected", revision, diagnostics: [NO_SESSION], output: { recording: false, frames: 0 } };
      }
      if (context.dryRun) {
        return { status: "validated", revision, output: { recording: false, frames: handlers.frames() } };
      }
      // Arming with no capture would record silence frame after frame and look exactly
      // like a working recording until the moment someone replayed it (§V288).
      if (!handlers.hasSource()) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "audio.noSource",
              message: "No audio source is live, so a recording would capture nothing but silence.",
              suggestion:
                "Add an Audio In or Audio File In node and let it start before arming. A graph driven by Audio Pattern needs no recording — it is already reproducible.",
            },
          ],
          output: { recording: false, frames: handlers.frames() },
        };
      }
      return { status: "applied", revision, output: handlers.toggle() };
    },
    rejectionOutput: () => ({ recording: false, frames: 0 }),
  });

  bus.registerCommand({
    name: "audio.saveTrack",
    description: "Write the recorded audio feature track to a file.",
    handler: async (_input, context) => {
      const revision = context.store.getRevision();
      const handlers = holder.current;
      if (handlers === null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [NO_SESSION],
          output: { saved: false, frames: 0, fileName: null },
        };
      }
      const frames = handlers.frames();
      if (frames === 0) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "audio.nothingRecorded",
              message: "Nothing has been recorded yet, so there is no track to write.",
            },
          ],
          output: { saved: false, frames: 0, fileName: null },
        };
      }
      if (context.dryRun) {
        return { status: "validated", revision, output: { saved: false, frames, fileName: null } };
      }

      const result = await handlers.save();
      if (result.failure !== null) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "error" as const,
              code: "audio.trackWriteFailed",
              message: `The feature track could not be written: ${result.failure}`,
            },
          ],
          output: { saved: false, frames, fileName: null },
        };
      }
      // A cancelled picker is not a failure and must not be reported as one — the same
      // rule the project save follows.
      return {
        status: "applied",
        revision,
        output: { saved: result.fileName !== null, frames, fileName: result.fileName },
      };
    },
    rejectionOutput: () => ({ saved: false, frames: 0, fileName: null }),
  });

  return holder;
}
