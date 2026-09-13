import { useEffect, useState } from "react";
import { desktopPermissions, type DesktopPermissionStatus } from "@devices/desktop-permissions.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./project-settings.module.css";

const labels = { camera: "Camera", microphone: "Microphone", speaker: "Speaker selection", ndi: "NDI network" };
const captureDescription = "App choices reset on reload; OS choices persist";
const descriptions = {
  camera: captureDescription,
  microphone: captureDescription,
  speaker: "Output device selection only; not ordinary playback",
  ndi: "Discovery and video on your local network",
};

/** Session consent and OS permission are independent; neither changes the project. */
export function DesktopPermissionsPanel() {
  const bridge = desktopPermissions();
  const [statuses, setStatuses] = useState<readonly DesktopPermissionStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let pending = false;
    let repeat = false;
    const refresh = async () => {
      if (pending) { repeat = true; return; }
      pending = true;
      do {
        repeat = false;
        try {
          const next = await bridge.list();
          if (!disposed) { setStatuses(next); setError(null); }
        } catch (failure) {
          if (!disposed) {
            setStatuses(null);
            setError(failure instanceof Error ? failure.message : String(failure));
          }
        }
      } while (repeat && !disposed);
      pending = false;
    };
    const focus = () => { void refresh(); };
    focus();
    const unsubscribe = bridge.subscribe(focus);
    window.addEventListener("focus", focus);
    return () => { disposed = true; unsubscribe(); window.removeEventListener("focus", focus); };
  }, [bridge]);

  if (!bridge) return null;
  return (
    <section className={styles.group} aria-label="Permissions">
      <h3 className={styles.groupTitle}>Permissions</h3>
      {error !== null ? <p role="alert">Permissions: {error}</p> : statuses === null ? (
        <p role="status">Loading permissions…</p>
      ) : statuses.map(status => (
        <ControlRow key={status.id} label={labels[status.id]} description={descriptions[status.id]}>
          <span>App: {status.decision.replaceAll("-", " ")} · OS: {status.system.replaceAll("-", " ")}</span>
        </ControlRow>
      ))}
      {statuses?.some(status => (status.id === "camera" || status.id === "microphone") && status.system !== "managed-by-browser") && (
        <Button onClick={() => {
          void bridge.openSystemSettings().catch(failure => {
            setError(failure instanceof Error ? failure.message : String(failure));
          });
        }}>Open System Settings</Button>
      )}
    </section>
  );
}
