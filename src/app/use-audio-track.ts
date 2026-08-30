import { useCallback, useEffect, useRef, useState } from "react";

import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { AudioFeatures } from "@domain/types/frame.ts";
import {
  createFeatureTrackRecorder,
  serializeFeatureTrack,
} from "@domain/audio/feature-track.ts";
import type { FeatureTrackRecorder } from "@domain/audio/feature-track.ts";
import { registerAudioTrackCommands } from "./audio-track-commands.ts";
import { writeTextFile } from "./project-io.ts";
import type { SaveOutcome, WriteProjectOptions } from "./project-io.ts";

/**
 * The session's feature-track recorder (T452, §V352).
 *
 * ## Capture is at the SEAM
 *
 * `read` here wraps the closure the frame driver calls for its audio, so what lands in
 * the track is exactly what the engine READ — not what the analyser computed a moment
 * earlier. The headless harness records at the same position for the same reason, which
 * is what makes `tests/headless/audio-track-replay.test.ts`'s round trip mean anything:
 * both ends of "record then replay" tap the same point.
 *
 * ## Frame 0 is the ARM, not the transport's zero
 *
 * A track is indexed from the moment recording started, because that is what replaying
 * it means — feed it to a render and its first frame is the render's first frame. So the
 * recorder counts its own frames rather than reading the transport's index, and arming
 * twice gives two tracks that both start at 0.
 */

export const AUDIO_TRACK_MIME = "application/json";

/** Its own extension, so a track is never mistaken for a project by a file picker. */
export const AUDIO_TRACK_PICKER_TYPE = {
  description: "Shaderloom audio feature track",
  accept: { [AUDIO_TRACK_MIME]: [".loomtrack.json"] as readonly string[] },
} as const;

export interface AudioTrackSession {
  /** Wrap the session's audio read with this; it captures while armed. */
  readonly read: () => AudioFeatures | null;
  readonly recording: boolean;
  readonly frames: number;
}

export interface UseAudioTrackOptions {
  readonly bus: ShaderloomBus;
  /** The session's live feature read — `useAudioInput().read`. */
  readonly source: () => AudioFeatures | null;
  /** True while a capture is actually live. Arming without one is refused by the command. */
  readonly hasSource: () => boolean;
  readonly fps: number;
  /** Suggested file name stem, normally the project's. */
  readonly name: () => string;
  /** Test seam, threaded to `writeTextFile`. */
  readonly writeOptions?: WriteProjectOptions;
}

export function useAudioTrack(options: UseAudioTrackOptions): AudioTrackSession {
  const { bus, fps } = options;
  const [recording, setRecording] = useState(false);
  const [frames, setFrames] = useState(0);

  const recorderRef = useRef<FeatureTrackRecorder | null>(null);
  const nextIndexRef = useRef(0);
  const recordingRef = useRef(false);

  // Latest-value refs so the read closure is created once and still sees fresh state.
  const sourceRef = useRef(options.source);
  sourceRef.current = options.source;
  const hasSourceRef = useRef(options.hasSource);
  hasSourceRef.current = options.hasSource;
  const nameRef = useRef(options.name);
  nameRef.current = options.name;
  const writeOptionsRef = useRef(options.writeOptions);
  writeOptionsRef.current = options.writeOptions;

  const read = useCallback((): AudioFeatures | null => {
    const features = sourceRef.current();
    const recorder = recorderRef.current;
    if (recorder !== null && recordingRef.current) {
      const index = nextIndexRef.current;
      nextIndexRef.current = index + 1;
      recorder.capture(index, features);
      setFrames(index + 1);
    }
    return features;
  }, []);

  useEffect(() => {
    const holder = registerAudioTrackCommands(bus);
    const handlers = {
      toggle: () => {
        const next = !recordingRef.current;
        if (next) {
          // A fresh arm is a fresh take. Appending to the previous one would splice two
          // performances into a track that claims to be one continuous recording.
          recorderRef.current = createFeatureTrackRecorder(fps);
          nextIndexRef.current = 0;
          setFrames(0);
        }
        recordingRef.current = next;
        setRecording(next);
        return { recording: next, frames: next ? 0 : nextIndexRef.current };
      },
      frames: () => nextIndexRef.current,
      hasSource: () => hasSourceRef.current(),
      save: async (): Promise<{ fileName: string | null; failure: string | null }> => {
        const recorder = recorderRef.current;
        if (recorder === null) return { fileName: null, failure: "no track" };
        const text = serializeFeatureTrack(recorder.track());
        const stem = nameRef.current().replace(/\.loom\.json$/i, "") || "untitled";
        const outcome: SaveOutcome = await writeTextFile(
          {
            fileName: `${stem}.loomtrack.json`,
            text,
            mime: AUDIO_TRACK_MIME,
            pickerTypes: [AUDIO_TRACK_PICKER_TYPE],
          },
          writeOptionsRef.current ?? {},
        );
        if (outcome.kind === "saved") return { fileName: outcome.fileName, failure: null };
        // Cancelled is not a failure: the user changed their mind, the track is still held.
        if (outcome.kind === "cancelled") return { fileName: null, failure: null };
        return { fileName: null, failure: outcome.reason };
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus, fps]);

  return { read, recording, frames };
}
