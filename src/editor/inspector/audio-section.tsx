import { useEffect, useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { describeAudioLatency, type AudioLatencyEstimate } from "@/app/audio-latency.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

/**
 * T434(b)/T432: the audio capture's STATUS and the microphone DEVICE picker.
 *
 * One surface for the three faces of one fact — a denied permission, a failed file URL
 * and a device that vanished mid-session are all "why is every audio channel zero", and
 * the answer belongs where the user is already looking (§V288). Without this, the first
 * dismissed mic prompt makes every audio-driven parameter read zero with no explanation
 * anywhere.
 *
 * THE LABEL TRAP, handled deliberately: `enumerateDevices()` returns EMPTY label strings
 * until microphone permission has been granted. A picker full of blanks reads as broken
 * hardware; the truth is a permissions state, so that is what the hint says.
 */

export interface AudioCaptureStatus {
  readonly kind: "idle" | "live" | "error";
  readonly message?: string;
  /** T1319b: the measured FLOOR on the audio-to-picture offset, or null where unmeasurable. */
  readonly latency?: AudioLatencyEstimate | null;
}

export interface AudioSectionProps {
  nodeId: NodeId;
  /** Which picker to show: only the microphone node selects a device. */
  nodeType: "audioIn" | "audioFileIn";
  /** Stored device id ("" = system default). */
  device: string;
  /**
   * T1319b(b) — the Sync Offset in effect, seconds. The suggestion is useless without it:
   * a button that writes a value while the value is invisible gives the user no way to tell
   * whether it landed, which is exactly what the owner reported.
   */
  syncOffset?: number;
  status: AudioCaptureStatus;
  editor: ParameterEditor;
}

interface DeviceOption {
  readonly deviceId: string;
  readonly label: string;
}

function useAudioDevices(enabled: boolean): { devices: readonly DeviceOption[]; unlabelled: boolean } {
  const [devices, setDevices] = useState<readonly DeviceOption[]>([]);
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || navigator.mediaDevices === undefined) return;
    let disposed = false;
    const refresh = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((found) => {
          if (disposed) return;
          setDevices(
            found
              .filter((entry) => entry.kind === "audioinput")
              .map((entry) => ({ deviceId: entry.deviceId, label: entry.label })),
          );
        })
        .catch(() => {
          /* No device list is the same UI state as an empty one. */
        });
    };
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [enabled]);
  const unlabelled = devices.length > 0 && devices.every((entry) => entry.label === "");
  return { devices, unlabelled };
}

const STATUS_TEXT: Readonly<Record<AudioCaptureStatus["kind"], string>> = {
  idle: "No capture live",
  live: "Capturing",
  error: "Capture failed",
};

/**
 * T994 — THE CLAIM: which parameter keys this section PRESENTS THE CONTROL FOR, as a
 * function of the same input the render branches on, so the two cannot drift. The
 * inspector filters these keys out of the generic parameter groups WHILE this section
 * renders — two controls writing one document field is how a typed device id and the
 * picker silently disagree. A hide-list in the inspector would leave the next
 * section's duplicate behind; the section itself is the only party that knows what it
 * presents.
 */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors; a separate module would let the two drift.
export function audioSectionParameters(nodeType: "audioIn" | "audioFileIn"): readonly string[] {
  // The device picker renders for the microphone only (the gate below mirrors this);
  // audioFileIn gets status alone, so it claims nothing.
  return nodeType === "audioIn" ? ["device"] : [];
}

/** Seconds as the status line says them: whole milliseconds, which is the resolution anyone can hear. */
const msText = (seconds: number): string => `${(seconds * 1000).toFixed(0)} ms`;

export function AudioSection({ nodeId, nodeType, device, syncOffset = 0, status, editor }: AudioSectionProps) {
  const { devices, unlabelled } = useAudioDevices(nodeType === "audioIn");
  /*
   * T1319b — the measurement the Sync Offset description has been asking for since §T1312b.
   *
   * FILE ONLY: a microphone cannot be compensated this way at all, because live analysis
   * cannot look ahead — the sound has not happened yet — which is the same reason the
   * parameter itself is inactive under Free Run. Offering the suggestion on a mic would be
   * offering a number for a control that cannot use it.
   *
   * This does NOT claim `syncOffset` in `audioSectionParameters`: the knob keeps its home in
   * the Analysis group, where it is read and typed. A button that writes once is not a second
   * editor of the value, and moving the control out of its group is a bigger change than the
   * measurement needs (§T1320b holds the question of where the value should ultimately live).
   */
  const latency = nodeType === "audioFileIn" && status.kind === "live" ? (status.latency ?? null) : undefined;
  /** What the button would write, rounded as it writes it — so "applied" compares like with like. */
  const suggested = latency === null || latency === undefined ? 0 : Number(latency.suggestedSeconds.toFixed(3));
  /** Half a millisecond: below what anyone can hear, and below the resolution the line prints. */
  const applied = Math.abs(syncOffset - suggested) < 0.0005;

  return (
    <section className={styles.section} aria-label="Audio capture">
      <div className={styles.sectionHeader}>
        <span>Audio capture</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>
      <div className={styles.statusLine} role="status" data-audio-status={status.kind}>
        {STATUS_TEXT[status.kind]}
        {status.message === undefined ? "" : ` — ${status.message}`}
      </div>
      {latency === undefined ? null : (
        <div className={styles.statusLine} data-audio-latency={latency === null ? "unmeasurable" : "measured"}>
          {describeAudioLatency(latency)}
          {latency === null ? null : (
            <>
              {" "}
              {/*
                T1319b(b) — THE FEEDBACK IS THE STATE, not a flash.
                The owner: "not getting any feedback when I use the sync offset button… we
                don't really feel like is this applied now?" A toast would have answered that
                for two seconds and left the same question on the third. So the value in
                effect is shown beside the suggestion, the button NAMES the number it will
                write, and once they agree the button is replaced by the applied mark — the
                surface reads its own state at any moment, including long after the click.
              */}
              <span className={styles.statusHint} data-sync-offset={applied ? "applied" : "pending"}>
                Sync Offset {msText(syncOffset)}
                {applied ? " — applied" : ""}
              </span>
              {applied ? null : (
                <>
                  {" "}
                  <button
                    type="button"
                    className={styles.statusAction}
                    onClick={() => {
                      // The same editor the device picker writes through: one value, one
                      // write path, one undo entry (§V15). `commit`, because this is a single
                      // act and not a drag.
                      editor.setParameter(nodeId, "syncOffset", suggested, "commit");
                    }}
                  >
                    Use {msText(suggested)}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {nodeType === "audioIn" ? (
        <>
          {/* The kit's picker, not a bare `<select>`: a raw one renders as the OS's grey
              chrome in the middle of a themed panel (§V17/§V19). */}
          <ControlRow label="Device">
            <EnumField
              label="Microphone device"
              value={device}
              options={[
                { value: "", label: "System default" },
                ...devices.map((entry, index) => ({
                  value: entry.deviceId,
                  label: entry.label === "" ? `Microphone ${String(index + 1)}` : entry.label,
                })),
              ]}
              onChange={(next) => editor.setParameter(nodeId, "device", next, "commit")}
            />
          </ControlRow>
          {unlabelled ? (
            <span className={styles.statusHint}>Grant microphone access to see device names.</span>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
