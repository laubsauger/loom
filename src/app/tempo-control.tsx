import { useCallback, useEffect, useRef, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { CommandStatus } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { BEATS_PER_BAR, TEMPO_SOURCES, type TempoSourceKind } from "@domain/types/frame.ts";
import type { ProjectTempo } from "@domain/tempo/project-tempo.ts";
import { Button } from "@ui/primitives/button.tsx";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import styles from "./tempo-control.module.css";

/**
 * T1785b — the project tempo in the transport bar: beat lamp, BPM field, Tap, source.
 *
 * Every control runs a `tempo.*` bus command (§V78: the button and the hotkey are one
 * path). The LAMP is the beat itself and moves faster than React may (§V16), so it is
 * written straight onto its element on the display's own tick and re-renders nothing; the
 * BPM a follower holds is sampled at the readout's 10 Hz.
 */
export interface TempoControlProps {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly tempo: ProjectTempo;
  /** The document's tempo and source (`projectBpm`, `projectTempoSource`). */
  readonly bpm: number;
  readonly source: TempoSourceKind;
  readonly onResult?: ((result: { status: CommandStatus; diagnostics: RuntimeDiagnostic[] }) => void) | undefined;
  readonly intervalMs?: number;
}

const SOURCE_LABELS: Record<TempoSourceKind, string> = { manual: "manual", audio: "audio", midiClock: "midi clock" };
/** The share of a beat the lamp stays lit for. */
const LAMP_LIT = 0.25;

const formatBpm = (bpm: number): string => (Math.round(bpm * 10) / 10).toFixed(1);

export function TempoControl({ bus, invocation, tempo, bpm, source, onResult, intervalMs = 100 }: TempoControlProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [followed, setFollowed] = useState<{ bpm: number; locked: boolean } | null>(null);
  const lamp = useRef<HTMLButtonElement | null>(null);

  // The lamp: lit for the first quarter of each beat, brighter on the bar's first.
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    let handle = 0;
    const tick = (): void => {
      const element = lamp.current;
      if (element !== null) {
        const { beats } = tempo.snapshot();
        const beat = Math.floor(beats);
        const lit = beats - beat < LAMP_LIT ? (beat % BEATS_PER_BAR === 0 ? "bar" : "beat") : "off";
        if (element.dataset["lit"] !== lit) element.dataset["lit"] = lit;
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [tempo]);

  // A follower's tempo is the session's, not the document's: sampled, at <= 10 Hz (§V16).
  useEffect(() => {
    if (source === "manual") {
      setFollowed(null);
      return;
    }
    const tick = (): void => {
      const now = tempo.snapshot();
      setFollowed((previous) => (previous !== null && previous.bpm === now.bpm && previous.locked === now.locked ? previous : { bpm: now.bpm, locked: now.locked }));
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, source, tempo]);

  const run = useCallback(
    (name: "tempo.set" | "tempo.tap" | "tempo.resync" | "tempo.setSource", input: object): void => {
      void bus.execute(name, input as never, invocation).then((result) => onResult?.(result));
    },
    [bus, invocation, onResult],
  );

  const commit = useCallback(() => {
    const text = draft;
    setDraft(null);
    if (text === null) return;
    const parsed = Number.parseFloat(text.trim());
    if (!Number.isFinite(parsed)) return;
    run("tempo.set", { bpm: parsed });
  }, [draft, run]);

  const locked = followed?.locked ?? true;
  const shown = draft ?? formatBpm(followed?.bpm ?? bpm);

  return (
    <div className={styles.tempo} role="group" aria-label="Tempo">
      <Tooltip label={locked ? "Beat — click to resync: the downbeat is now" : `No ${SOURCE_LABELS[source]} tempo: holding the last one. Click to resync the downbeat`}>
        <button ref={lamp} type="button" className={styles.lamp} aria-label="Resync downbeat" data-testid="beat-lamp" data-lit="off" data-locked={locked} onClick={() => run("tempo.resync", {})}>
          <span className={styles.dot} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label="Project tempo — expressions read bpm, beat, beatphase, beatpulse, bar, barphase">
        <input
          className={styles.input}
          aria-label="Tempo (BPM)"
          inputMode="decimal"
          value={shown}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
      </Tooltip>
      <span className={styles.label}>bpm</span>
      <Tooltip label="Tap the tempo (T) — the latest tap sets the beat">
        <Button className={styles.tap} aria-label="Tap tempo" onClick={() => run("tempo.tap", {})}>
          tap
        </Button>
      </Tooltip>
      <Tooltip label="What drives the beat: the project tempo, the detected audio tempo, or MIDI clock in">
        <select className={styles.source} aria-label="Tempo source" value={source} onChange={(event) => run("tempo.setSource", { source: event.target.value })}>
          {TEMPO_SOURCES.map((kind) => (
            <option key={kind} value={kind}>
              {SOURCE_LABELS[kind]}
            </option>
          ))}
        </select>
      </Tooltip>
    </div>
  );
}
