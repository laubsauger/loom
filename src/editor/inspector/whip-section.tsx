import { useSyncExternalStore } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { TextField } from "@ui/controls/text-field.tsx";
import styles from "./inspector.module.css";

/**
 * §T1809b — the stream's SESSION surface, on the WHIP Out node (T960: on the node, not in a
 * device pane). Two things live here because neither may be a parameter:
 *
 *  - The STATE: off, why it is not sending, connecting, live, retrying, and once a second
 *    what the encoder actually sent (size, frames per second, kbit/s). Measured by the
 *    pump, never echoed from the parameters.
 *  - The TOKEN: a bearer token for a server that asks for one. A parameter is saved with
 *    the project, so the token is held by the pump in memory and goes with the session.
 *    The field is write-only: the section shows whether one is set, never what it is.
 *
 * Server, Stream path, the size, rate, bitrate, Audio and Publish stay ordinary parameter
 * rows below, so the section claims no keys (T994).
 */

export interface WhipSectionView {
  readonly state: "off" | "refused" | "waiting" | "connecting" | "live" | "frozen" | "retrying" | "paused";
  /** One sentence: where it is sending, or why it is not. */
  readonly message: string;
  /** What was sent over the last second, or null when nothing is measured. */
  readonly measured: string | null;
  readonly hasToken: boolean;
  /** The token is set and the server is plain http beyond this machine. */
  readonly tokenInClear: boolean;
}

export interface WhipSectionSurface {
  view(nodeId: string): WhipSectionView;
  /** Holds the token for this session; an empty string forgets it. */
  setToken(nodeId: string, token: string): void;
  subscribe(listener: () => void): () => void;
}

/** T994's claim: this section presents controls for NO parameter keys. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors.
export function whipSectionParameters(): readonly string[] {
  return [];
}

export interface WhipSectionProps {
  readonly nodeId: NodeId;
  readonly whip: WhipSectionSurface;
}

export function WhipSection({ nodeId, whip }: WhipSectionProps) {
  const text = useSyncExternalStore(whip.subscribe, () => JSON.stringify(whip.view(nodeId)), () => "");
  const view = text === "" ? whip.view(nodeId) : (JSON.parse(text) as WhipSectionView);
  return (
    <section className={styles.section} aria-label="Stream">
      <div className={styles.sectionHeader}>
        <span>Stream</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <div className={styles.statusLine} role="status" data-whip-state={view.state}>
        {view.message}
      </div>
      {view.measured === null ? null : (
        <span className={styles.statusHint} data-whip-measured>
          {view.measured}
        </span>
      )}

      <ControlRow label="Token">
        {view.hasToken ? (
          <Button variant="outline" onClick={() => whip.setToken(nodeId, "")}>
            Forget token
          </Button>
        ) : (
          // Committed on Enter or blur, as every text row; the section then shows the button.
          <TextField label="Token" value="" secret onChange={(value) => whip.setToken(nodeId, value)} />
        )}
      </ControlRow>
      <span className={styles.statusHint}>
        {view.hasToken
          ? "A token is held for this session. It is not saved with the project."
          : "Only for a server that asks for a login. Held for this session, never saved with the project."}
      </span>
      {view.tokenInClear ? (
        <span className={styles.statusHint} role="alert">
          This server is plain http on the network, so the token travels unencrypted.
        </span>
      ) : null}
    </section>
  );
}
