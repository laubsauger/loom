import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { MidiBinding, MidiSource } from "@domain/midi/midi-mapping.ts";
import { describeMidiSource, parseMidiMapping, serialiseMidiMapping } from "@domain/midi/midi-mapping.ts";
import type { MidiAccessState, MidiInputPort } from "@domain/midi/midi-status.ts";
import { midiStatusLine } from "@domain/midi/midi-status.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { TextField } from "@ui/controls/text-field.tsx";
import type { EnumOption } from "@ui/controls/enum-field.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";
import styles from "./inspector.module.css";
import rows from "./midi-section.module.css";

/**
 * T942 tier 1 — MIDI-LEARN, and the sentence that says why there is no MIDI.
 *
 * ## Learn is the feature, not a convenience
 *
 * The plan's §3.1 found that TouchDesigner has no auto-learn at all — *"there is no
 * auto-learn currently"*, in its own docs — and that a custom map there is made by editing
 * component tables. A CC-number table is what we are NOT shipping: nobody performing knows
 * that the third fader is CC 19, and finding out means a MIDI monitor and a second window.
 * Arm a row, move the control, it is bound. That is the whole gesture.
 *
 * ## What is document state and what is not
 *
 * The MAPPING is document state, held in the node's `mapping` parameter — so a learn is an
 * ordinary parameter edit and undo, autosave, the diff and the agent surface all work on it
 * without anything being built for them. A project that forgets its mapping on reload is
 * not a project.
 *
 * The ARMING — which row is waiting for a wiggle — is session state, held right here in
 * `useState`. An armed row saved into a file would re-arm on open, which is §V124's
 * argument for why a pulse cannot be a boolean, in different clothes.
 *
 * ## The name is the user's, and that is deliberate (§V129)
 *
 * A learned control defaults to `control1` and is meant to be renamed to `cutoff`, because
 * `midi1:cutoff` is a readable driven-parameter reference and `midi1:cc74` is not. The
 * indirection is TouchDesigner's one good idea here: the NODE names channels, the MAPPING
 * names hardware, so re-learning onto a different controller leaves every driven parameter
 * in the document untouched.
 *
 * ## Absence is rendered, never hidden (§V359, §T948)
 *
 * The section is present whatever the state of Web MIDI, including on a browser that has
 * none — hiding it would make "not supported here" and "nobody built this" the same pixels.
 * The reason and the action come from `midiStatusLine`, where they are under the §V90
 * length cap and under a test; nothing about the state is decided in this file.
 *
 * ## It wears the kit (§V17, §V19)
 *
 * Every control here is the shared one — `Button`, `ControlRow`, `EnumField`, `TextField` —
 * because a section built from bare `<button>`/`<select>` renders as the OS's grey chrome
 * in the middle of a themed panel, which is what it did until this was fixed. The two
 * range fields are the one exception and it is deliberate: see `.number` below.
 */

/** Absolute or toggle — a two-value enum, so the kit's picker rather than a raw select. */
const MODE_OPTIONS: readonly EnumOption[] = [
  { value: "absolute", label: "Absolute" },
  { value: "toggle", label: "Toggle" },
];

export interface MidiSectionSurface {
  readonly state: MidiAccessState;
  readonly ports: readonly MidiInputPort[];
  /** Called from the button's click — a user gesture, which Web MIDI requires. */
  readonly request: () => void;
  /** Binds the next supported message to the armed row. Returns a disarm. */
  readonly arm: (listener: (event: { readonly reading: { readonly source: MidiSource } }) => void) => () => void;
}

export interface MidiSectionProps {
  nodeId: NodeId;
  /** Stored port id ("" = any attached input). */
  device: string;
  /** The stored `mapping` parameter, verbatim. */
  mapping: string;
  midi: MidiSectionSurface;
  editor: ParameterEditor;
}

/** `control1`, `control2`, … — never a duplicate, because a name is an address (§V129). */
function nextChannelName(existing: readonly MidiBinding[]): string {
  const taken = new Set(existing.map((binding) => binding.channel));
  for (let index = 1; ; index += 1) {
    const candidate = `control${String(index)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function MidiSection({ nodeId, device, mapping, midi, editor }: MidiSectionProps) {
  const parsed = parseMidiMapping(mapping);
  const [learning, setLearning] = useState<string | null>(null);
  const disarm = useRef<(() => void) | null>(null);

  /*
   * The bindings the LEARN CALLBACK writes into must be the current ones, not the ones
   * that existed when the row was armed. Arming and moving a knob are seconds apart and
   * the document can change in between — a stale array would silently drop whatever else
   * was edited while the row waited.
   */
  const latest = useRef(parsed.bindings);
  latest.current = parsed.bindings;

  const commit = useCallback(
    (bindings: readonly MidiBinding[]) => {
      editor.setParameter(nodeId, "mapping", serialiseMidiMapping(bindings), "commit");
    },
    [editor, nodeId],
  );

  /* An unmount with a row still armed must not leave the session holding a dead closure. */
  useEffect(
    () => () => {
      disarm.current?.();
      disarm.current = null;
    },
    [],
  );

  const learn = useCallback(
    (channel: string) => {
      disarm.current?.();
      if (learning === channel) {
        // A second press on an armed row cancels it. Without this the only way out of
        // arming is to move a control, which is exactly what you cannot do if the reason
        // you armed the wrong row is that you have the wrong device selected.
        disarm.current = null;
        setLearning(null);
        return;
      }
      setLearning(channel);
      disarm.current = midi.arm(({ reading }) => {
        disarm.current = null;
        setLearning(null);
        commit(
          latest.current.map((binding) =>
            binding.channel === channel ? { ...binding, source: reading.source } : binding,
          ),
        );
      });
    },
    [commit, learning, midi],
  );

  const status = midiStatusLine(midi.state, midi.ports.length);
  const canLearn = midi.state.kind === "granted";

  return (
    <section className={styles.section} aria-label="MIDI">
      <div className={styles.sectionHeader}>
        <span>MIDI</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <div className={rows.status}>
        <div className={styles.statusLine} role="status" data-midi-status={midi.state.kind}>
          {status.headline}
        </div>
        {status.hint === null ? null : <span className={styles.statusHint}>{status.hint}</span>}
        {status.canRequest ? (
          <Button variant="outline" onClick={midi.request}>
            Enable MIDI
          </Button>
        ) : null}
      </div>

      <ControlRow label="Device">
        <EnumField
          label="MIDI input"
          value={device}
          options={[
            { value: "", label: "Any input" },
            ...midi.ports.map((port, index) => ({
              value: port.id,
              label: port.name === "" ? `Input ${String(index + 1)}` : port.name,
            })),
          ]}
          onChange={(next) => editor.setParameter(nodeId, "device", next, "commit")}
        />
      </ControlRow>

      {parsed.error === null ? null : (
        <p className={rows.problem} role="alert">
          {parsed.error}
        </p>
      )}

      <div className={rows.rows}>
        {parsed.bindings.length === 0 ? (
          <span className={styles.emptyPage}>No controls learned yet.</span>
        ) : null}
        {parsed.bindings.map((binding) => (
          <div className={rows.row} key={binding.channel}>
            <div className={rows.rowHead}>
              <TextField
                label={`Channel name for ${binding.channel}`}
                value={binding.channel}
                onChange={(renamed) => {
                  commit(
                    latest.current.map((entry) =>
                      entry.channel === binding.channel ? { ...entry, channel: renamed } : entry,
                    ),
                  );
                }}
              />
              <Button
                variant="outline"
                disabled={!canLearn}
                aria-pressed={learning === binding.channel}
                onClick={() => learn(binding.channel)}
              >
                {learning === binding.channel ? "Move a control" : "Learn"}
              </Button>
              <Button
                onClick={() =>
                  commit(latest.current.filter((entry) => entry.channel !== binding.channel))
                }
              >
                Remove
              </Button>
            </div>
            <div className={rows.rowDetail}>
              <span className={rows.source}>{describeMidiSource(binding.source)}</span>
              <label className={rows.field}>
                <span className={rows.fieldLabel}>Low</span>
                <input
                  className={rows.number}
                  type="number"
                  step="0.001"
                  value={binding.range[0]}
                  aria-label={`Low for ${binding.channel}`}
                  onChange={(event) => {
                    const low = Number(event.currentTarget.value);
                    commit(
                      latest.current.map((entry) =>
                        entry.channel === binding.channel
                          ? { ...entry, range: [Number.isFinite(low) ? low : 0, entry.range[1]] as const }
                          : entry,
                      ),
                    );
                  }}
                />
              </label>
              <label className={rows.field}>
                <span className={rows.fieldLabel}>High</span>
                <input
                  className={rows.number}
                  type="number"
                  step="0.001"
                  value={binding.range[1]}
                  aria-label={`High for ${binding.channel}`}
                  onChange={(event) => {
                    const high = Number(event.currentTarget.value);
                    commit(
                      latest.current.map((entry) =>
                        entry.channel === binding.channel
                          ? { ...entry, range: [entry.range[0], Number.isFinite(high) ? high : 1] as const }
                          : entry,
                      ),
                    );
                  }}
                />
              </label>
              <div className={rows.field}>
                <span className={rows.fieldLabel}>Mode</span>
                <EnumField
                  label={`Mode for ${binding.channel}`}
                  value={binding.mode}
                  options={MODE_OPTIONS}
                  onChange={(next) => {
                    const mode = next === "toggle" ? "toggle" : "absolute";
                    commit(
                      latest.current.map((entry) =>
                        entry.channel === binding.channel ? { ...entry, mode } : entry,
                      ),
                    );
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className={rows.footer}>
        <Button
          variant="outline"
          onClick={() => {
            const channel = nextChannelName(latest.current);
            commit([
              ...latest.current,
              { channel, source: null, range: [0, 1] as const, mode: "absolute" as const },
            ]);
          }}
        >
          Add control
        </Button>
      </div>
    </section>
  );
}
