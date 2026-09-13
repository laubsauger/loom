import type { NodeId } from "@domain/types/ids.ts";
import { describeAudioLatency, type AudioLatencyEstimate } from "@/app/audio-latency.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

/**
 * T1321b — THE SUGGESTED SYNC OFFSET, AT THE FIELD IT IS FOR.
 *
 * §T1319b measured the floor and built the apply gesture, and put both on the audio node's
 * STATUS LINE — while the knob lives in the Analysis group further down the panel. The
 * number and the field it is for were in different parts of the same panel, so the owner
 * asked for the only thing that shape leaves to ask for: *"we just prefill it with this
 * adjusted value"*. The value did not need to move into the field; the SUGGESTION needed
 * to move to the field. It renders directly beneath the Sync Offset row, and the status
 * line no longer carries it — one surface, not two saying the same thing.
 *
 * ⛑ SUGGEST, NEVER AUTO-WRITE. `syncOffset` is stored in the document and applied
 * identically to an offline render, which is what makes a take reproduce what was heard.
 * A machine-derived prefill would mean that opening a document on another box quietly
 * retimes a shipped take, with no event the user could attribute it to. So this writes
 * nothing until the button is pressed, and the field keeps whatever the document holds.
 *
 * ⛑ §V985 — THE MEASUREMENT IS A FLOOR. `describeAudioLatency` is the only wording, and it
 * always says "at least" and always names the part `outputLatency` cannot see (the render
 * and display path). Do not paraphrase it here into something more confident.
 *
 * ⛑ §V986 — AN UNMEASURED 0 IS NOT A MEASURED 0. A browser that reports nothing gets the
 * sentence and NO button: not a disabled control (that says "not now"), not a "0 ms"
 * fallback (that is indistinguishable from a real measurement of a zero-latency machine).
 * And nothing renders at all while no capture is live, so the parameter's default 0 stays
 * a rest state (§V914) rather than borrowing the authority of a measurement.
 *
 * A microphone is offered nothing, and needs no branch here to be: `audioIn` has no
 * `syncOffset` parameter at all, because live analysis cannot look ahead.
 */

/** Whole milliseconds — the resolution anyone can hear, and the one the sentence prints. */
const msText = (seconds: number): string => `${(seconds * 1000).toFixed(0)} ms`;

/** What the button writes, rounded as it writes it, so "applied" compares like with like. */
const suggestedFrom = (latency: AudioLatencyEstimate): number =>
  Number(latency.suggestedSeconds.toFixed(3));

export interface SyncOffsetSuggestionProps {
  nodeId: NodeId;
  /** The Sync Offset the document holds, seconds — what "applied" is measured against. */
  syncOffset: number;
  /** The measured floor, or null where this browser reports no latency at all. */
  latency: AudioLatencyEstimate | null;
  editor: ParameterEditor;
}

export function SyncOffsetSuggestion({
  nodeId,
  syncOffset,
  latency,
  editor,
}: SyncOffsetSuggestionProps) {
  const suggested = latency === null ? null : suggestedFrom(latency);
  /** Half a millisecond: below what anyone can hear, and below the resolution printed. */
  const applied = suggested !== null && Math.abs(syncOffset - suggested) < 0.0005;
  return (
    <div
      className={styles.parameterNote}
      data-audio-latency={latency === null ? "unmeasurable" : "measured"}
    >
      <span className={styles.statusHint}>{describeAudioLatency(latency)}</span>{" "}
      {suggested === null ? null : applied ? (
        /*
          T1319b(b)'s lesson, kept: THE FEEDBACK IS THE STATE, not a flash. This still
          reads "applied" an hour after the click, which a toast cannot do. What the move
          to the field made unnecessary is the value readout that used to sit beside it —
          the field one line up IS the value now, so saying it twice would be the panel
          repeating itself.
        */
        <span className={styles.statusHint} data-sync-offset="applied">
          — applied
        </span>
      ) : (
        <button
          type="button"
          className={styles.statusAction}
          data-sync-offset="pending"
          onClick={() => {
            // The same editor every row above writes through: one value, one write path,
            // one undo entry (§V15). `commit`, because this is a single act, not a drag.
            editor.setParameter(nodeId, "syncOffset", suggested, "commit");
          }}
        >
          Use {msText(suggested)}
        </button>
      )}
    </div>
  );
}
