import { useEffect, useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";

/**
 * T810: the webcam node's camera DEVICE picker — the owner's "webcam node needs a way to
 * pick the camera no?". Mirrors the microphone picker (T434, `audio-section.tsx`) so the
 * two read as one convention rather than two: same fallback contract (the media hook
 * retries bare and names it when an exact device has vanished), same label handling.
 *
 * §V721: enumerating is a READ. `enumerateDevices()` never prompts, and this section
 * calls nothing that does — opening a camera stays the media hook's business, reachable
 * only through the document actually containing a live webcam node.
 *
 * THE LABEL TRAP, handled deliberately (the pinned lesson from `audio-section.test.tsx`):
 * `enumerateDevices()` returns EMPTY label strings until camera permission has been
 * granted. A picker full of blanks reads as broken hardware; the truth is a permissions
 * state, so that is what the hint says.
 */

interface DeviceOption {
  readonly deviceId: string;
  readonly label: string;
}

function useVideoDevices(): { devices: readonly DeviceOption[]; unlabelled: boolean } {
  const [devices, setDevices] = useState<readonly DeviceOption[]>([]);
  useEffect(() => {
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) return;
    let disposed = false;
    const refresh = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((found) => {
          if (disposed) return;
          setDevices(
            found
              .filter((entry) => entry.kind === "videoinput")
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
  }, []);
  const unlabelled = devices.length > 0 && devices.every((entry) => entry.label === "");
  return { devices, unlabelled };
}

export interface WebcamSectionProps {
  nodeId: NodeId;
  /** Stored device id ("" = system default). */
  device: string;
  editor: ParameterEditor;
}

export function WebcamSection({ nodeId, device, editor }: WebcamSectionProps) {
  const { devices, unlabelled } = useVideoDevices();

  return (
    <section className={styles.section} aria-label="Camera">
      <div className={styles.sectionHeader}>
        <span>Camera</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>
      <label>
        Device
        <select
          value={device}
          aria-label="Camera device"
          onChange={(event) => editor.setParameter(nodeId, "device", event.currentTarget.value, "commit")}
        >
          <option value="">System default</option>
          {devices.map((entry, index) => (
            <option key={entry.deviceId || index} value={entry.deviceId}>
              {entry.label === "" ? `Camera ${index + 1}` : entry.label}
            </option>
          ))}
        </select>
        {unlabelled ? (
          <span className={styles.emptyPage}>Grant camera access to see device names.</span>
        ) : null}
      </label>
    </section>
  );
}
