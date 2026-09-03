import { useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import styles from "./inspector.module.css";

/**
 * T950 — the laser SESSION surface, on the node (§T948: the node is the interface,
 * never a hard-coded menu section). Everything here is SESSION state:
 *
 *  - G1: there is no armed parameter to render, because arming must never be document
 *    state. The Arm button below flips a hook's `useState` — it cannot be saved,
 *    cannot arrive in a file, and does not survive a reload, by construction.
 *  - G7's in-section half: the E-stop is here whenever a device is connected; the
 *    ALWAYS-visible half (the floating control while armed, plus its key binding)
 *    lives with the app shell, because a section scrolled away is not "always".
 *  - The status line is the HELPER'S report — phase, the device's own capacity and
 *    max rate from its broadcast, the last unsolicited detail (the dead-man firing
 *    arrives here as a sentence). Measured, never echoed (§V672).
 *
 * The section presents no PARAMETER controls (`host` and `maxPps` stay in the generic
 * groups — this section only reads them), so it claims no keys (T994's rule: claim
 * exactly what you present the control for).
 */

export interface LaserSectionSurface {
  readonly report: {
    readonly phase: string;
    readonly clearRefused: boolean;
    readonly bufferFullness: number;
    readonly device?: { readonly bufferCapacity: number; readonly maxPointRate: number };
  } | null;
  readonly armed: boolean;
  readonly detail: string;
  connect(host: string, maxPps: number): Promise<string | null>;
  arm(): Promise<string | null>;
  disarm(): Promise<void>;
  estop(): Promise<void>;
  clearEstop(): Promise<string | null>;
}

/** T994's claim: this section presents controls for NO parameter keys. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors.
export function laserSectionParameters(): readonly string[] {
  return [];
}

export interface LaserSectionProps {
  readonly nodeId: NodeId;
  /** The node's stored Host / Projector max pps, read for connect — not edited here. */
  readonly host: string;
  readonly maxPps: number;
  readonly laser: LaserSectionSurface;
}

export function LaserSection({ nodeId, host, maxPps, laser }: LaserSectionProps) {
  void nodeId;
  const [refusal, setRefusal] = useState<string | null>(null);
  const phase = laser.report?.phase ?? "disconnected";
  const device = laser.report?.device;

  const act = (work: () => Promise<string | null | void>) => {
    void work().then((said) => setRefusal(typeof said === "string" ? said : null));
  };

  return (
    <section className={styles.section} aria-label="Laser">
      <div className={styles.sectionHeader}>
        <span>Laser</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <div className={styles.statusLine} role="status" data-laser-phase={phase}>
        {phase === "disconnected"
          ? host.trim() === ""
            ? "No device — set Host below, then Connect."
            : `Not connected. Connect dials ${host} and reads the DAC's own broadcast.`
          : `${phase}${device === undefined ? "" : ` — device reports ${String(device.bufferCapacity)} points, max ${String(device.maxPointRate)} pps`}`}
      </div>
      {laser.detail === "" ? null : <span className={styles.statusHint}>{laser.detail}</span>}
      {refusal === null ? null : (
        <span className={styles.statusHint} role="alert">
          {refusal}
        </span>
      )}

      <ControlRow label="Session">
        {phase === "disconnected" ? (
          <Button variant="outline" onClick={() => act(() => laser.connect(host, maxPps))}>
            Connect
          </Button>
        ) : laser.armed ? (
          <Button variant="outline" onClick={() => act(() => laser.disarm())}>
            Disarm
          </Button>
        ) : (
          // The deliberate gesture (G1). The label says what it does to the world.
          <Button variant="outline" onClick={() => act(() => laser.arm())}>
            Arm — output emits light
          </Button>
        )}
      </ControlRow>

      {phase === "disconnected" ? null : (
        <ControlRow label="Emergency">
          {phase === "estopped" ? (
            <Button variant="outline" onClick={() => act(() => laser.clearEstop())}>
              Clear E-stop
            </Button>
          ) : (
            <Button variant="outline" onClick={() => act(() => laser.estop())}>
              E-STOP
            </Button>
          )}
        </ControlRow>
      )}
      {laser.report?.clearRefused === true ? (
        <span className={styles.statusHint} role="alert">
          The device refused to clear its e-stop — its condition persists. Resolve it at the projector.
        </span>
      ) : null}
    </section>
  );
}
