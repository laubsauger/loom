import { useEffect, useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
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
}

export interface AudioSectionProps {
  nodeId: NodeId;
  /** Which picker to show: only the microphone node selects a device. */
  nodeType: "audioIn" | "audioFileIn";
  /** Stored device id ("" = system default). */
  device: string;
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

export function AudioSection({ nodeId, nodeType, device, status, editor }: AudioSectionProps) {
  const { devices, unlabelled } = useAudioDevices(nodeType === "audioIn");

  return (
    <section className={styles.section} aria-label="Audio capture">
      <div className={styles.sectionHeader}>
        <span>Audio capture</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>
      <div role="status" data-audio-status={status.kind}>
        {STATUS_TEXT[status.kind]}
        {status.message === undefined ? "" : ` — ${status.message}`}
      </div>
      {nodeType === "audioIn" ? (
        <label>
          Device
          <select
            value={device}
            aria-label="Microphone device"
            onChange={(event) => editor.setParameter(nodeId, "device", event.currentTarget.value, "commit")}
          >
            <option value="">System default</option>
            {devices.map((entry, index) => (
              <option key={entry.deviceId || index} value={entry.deviceId}>
                {entry.label === "" ? `Microphone ${index + 1}` : entry.label}
              </option>
            ))}
          </select>
          {unlabelled ? (
            <span className={styles.emptyPage}>Grant microphone access to see device names.</span>
          ) : null}
        </label>
      ) : null}
    </section>
  );
}
