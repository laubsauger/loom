import { useEffect, useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { cameraShortfall, type CameraStatus } from "@/app/camera-request.ts";
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
 *
 * ## T1043 — THE GRANT, BESIDE THE REQUEST, AND THIS IS WHY THE SECTION EXISTS NOW
 *
 * The node's Capture parameters ASK the camera for a size, a rate and a facing.
 * `getUserMedia` constraints are a negotiation: a camera with no 1920x1080 mode hands back
 * 1280x720, successfully and silently. A request knob with no readout beside it therefore
 * reads back a number that is not true of the picture, which is §B172's lying readout —
 * so §V827(2) applies and what is shown here is MEASURED off the live track, never echoed
 * off the document.
 *
 * Three rules govern every line below and none of them is cosmetic:
 *
 *  - §V986 — a value the browser did not report reads as ABSENT ("not reported"), never as
 *    a confident 0. `640 x 0` is a measurement of a broken camera; "not reported" is the
 *    truth, and the two must not look alike.
 *  - §V985 — the control and the means of knowing what to put in it ship together. The
 *    camera's own `getCapabilities()` bound is printed here, because a Resolution field
 *    against a product that cannot say what the camera can do is a field that tells the
 *    user to guess.
 *  - §V986 again, second half — the grant is READ PER RENDER through `status()`, never
 *    captured. A track renegotiates, and a frame rate snapshotted at open goes quietly
 *    stale while looking authoritative.
 *
 * It is a SECTION rather than the node-info popup's "ran on" row deliberately: that row is
 * gated on `reproducibility === "async-cached"` and a webcam is `external-live`, so a
 * camera readout there would need that gate reworked for one node. The microphone's status
 * already lives in a section, and these two are the same kind of fact.
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
  /**
   * T1043: what this node's camera was asked for and what it granted, read live. Null
   * where no camera has been opened for the node — in a test, an embed, or simply before
   * the first frame — and the section then says nothing about a grant it does not have.
   */
  status: CameraStatus | null;
  editor: ParameterEditor;
}

/** A requested number, or the word for "you asked for nothing", which is not zero. */
function askedText(value: number, unit: string): string {
  return value > 0 ? `${String(value)}${unit}` : "any";
}

/** Requested size and rate, as one phrase. */
function requestedText(status: CameraStatus): string {
  const { requested } = status;
  const size =
    requested.width > 0 || requested.height > 0
      ? `${askedText(requested.width, "")} x ${askedText(requested.height, "")}`
      : "any size";
  const rate = requested.frameRate > 0 ? `${String(requested.frameRate)} fps` : "any rate";
  const facing = requested.facing === "any" ? null : `${requested.facing} facing`;
  return [size, rate, ...(facing === null ? [] : [facing])].join(", ");
}

/**
 * The grant, as one phrase — or null when there is nothing MEASURED to say.
 *
 * §V986 is the whole of this function: a member the browser did not report is left out of
 * the sentence rather than printed as 0, and a grant with nothing in it at all returns
 * null so the caller renders "not reported" instead of an empty-looking measurement.
 */
function grantedText(status: CameraStatus): string | null {
  const { granted } = status;
  if (granted === null) return null;
  const parts: string[] = [];
  if (granted.width !== undefined && granted.height !== undefined) {
    parts.push(`${String(granted.width)} x ${String(granted.height)}`);
  }
  if (granted.frameRate !== undefined) {
    // Cameras report 29.97 and 30.000030517578125 as readily as 30, and three decimals of
    // a frame rate is noise in a readout a person reads.
    parts.push(`${Number(granted.frameRate.toFixed(2)).toString()} fps`);
  }
  if (granted.facing !== undefined) parts.push(`${granted.facing} facing`);
  return parts.length === 0 ? null : parts.join(", ");
}

/** What the camera says it can do (§V985), or null where the browser reports nothing. */
function limitsText(status: CameraStatus): string | null {
  const { limits } = status;
  if (limits === null) return null;
  const parts: string[] = [];
  if (limits.maxWidth !== undefined && limits.maxHeight !== undefined) {
    parts.push(`${String(limits.maxWidth)} x ${String(limits.maxHeight)}`);
  }
  if (limits.maxFrameRate !== undefined) {
    parts.push(`${Number(limits.maxFrameRate.toFixed(2)).toString()} fps`);
  }
  return parts.length === 0 ? null : `This camera reports up to ${parts.join(", ")}.`;
}

/** T994 — the keys this section presents the control for; see audioSectionParameters. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors; a separate module would let the two drift.
export function webcamSectionParameters(): readonly string[] {
  return ["device"];
}

export function WebcamSection({ nodeId, device, status, editor }: WebcamSectionProps) {
  const { devices, unlabelled } = useVideoDevices();
  const granted = status === null ? null : grantedText(status);
  const shortfall = status === null ? null : cameraShortfall(status.requested, status.granted);
  const limits = status === null ? null : limitsText(status);

  return (
    <section className={styles.section} aria-label="Camera">
      <div className={styles.sectionHeader}>
        <span>Camera</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>
      {status === null ? null : (
        <>
          <div className={styles.statusLine} role="status" data-camera-status={status.kind}>
            {status.kind === "live" ? "Capturing" : (status.message ?? "No camera")}
          </div>
          {/* Requested above, granted below, in that order and never merged: the whole
              point is that a reader can see the two numbers are different. */}
          <div className={styles.readout} aria-label="Camera request">
            <span className={styles.readoutSource}>asked</span>
            <span className={styles.readoutValue}>{requestedText(status)}</span>
          </div>
          <div className={styles.readout} aria-label="Camera grant">
            <span className={styles.readoutSource}>got</span>
            {/* §V986: "not reported" — never a 0 that reads like a measurement. */}
            <span className={granted === null ? styles.readoutSource : styles.readoutValue}>
              {granted ?? "not reported by this browser"}
            </span>
          </div>
          {shortfall === null ? null : (
            <span className={styles.readoutFlag}>{shortfall}</span>
          )}
          {limits === null ? null : <span className={styles.statusHint}>{limits}</span>}
        </>
      )}
      {/* The kit's picker, the mic section's twin: a bare `<select>` renders as the OS's
          grey chrome in the middle of a themed panel (§V17/§V19). */}
      <ControlRow label="Device">
        <EnumField
          label="Camera device"
          value={device}
          options={[
            { value: "", label: "System default" },
            ...devices.map((entry, index) => ({
              value: entry.deviceId,
              label: entry.label === "" ? `Camera ${String(index + 1)}` : entry.label,
            })),
          ]}
          onChange={(next) => editor.setParameter(nodeId, "device", next, "commit")}
        />
      </ControlRow>
      {unlabelled ? (
        <span className={styles.statusHint}>Grant camera access to see device names.</span>
      ) : null}
    </section>
  );
}
