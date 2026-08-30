import { useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { DEFAULT_PROJECT_FPS, projectFps } from "@domain/types/graph.ts";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import { nodeTypeLabelStore } from "@editor/nodes/node-type-labels.ts";
import { BooleanField } from "@ui/controls/boolean-field.tsx";
import { DialogContent, DialogRoot, DialogTitle } from "@ui/primitives/dialog.tsx";
import styles from "./project-settings.module.css";

/**
 * Project settings (T266, §V177, §V178, §V171).
 *
 * The owner asked for target fps and resolution controls a long time ago. Four fields,
 * and they are not four of a kind:
 *
 *  - RESOLUTION and WORKING FORMAT size and type every target the plan names. Editing
 *    them recompiles, and that is correct.
 *  - SEED is structural too, for a reason worth stating because it looks wrong: no
 *    pipeline depends on a seed, but the plan captures it at compile time (§V45), so
 *    treating it as a rate would make the edit silently do nothing.
 *  - TARGET FPS is not cosmetic and is not structural. It is the DENOMINATOR of timeline
 *    time (§V176), so changing it changes the animation timebase — a linear expression on
 *    `time` moves at a different speed afterwards — while recompiling nothing. The
 *    timeline readout reads the same number, so the two cannot disagree.
 *
 * Every edit leaves through `project.setSettings` (§V29): this component holds no
 * settings state of its own beyond the text a field is mid-edit, and re-renders from the
 * live store like everything else.
 *
 * ## Why a number field commits on blur or Enter
 *
 * A resolution field that applied on every keystroke would recompile at 1, then 12, then
 * 128 on the way to 1280 — three plan rebuilds to type one number, two of them at sizes
 * the user never asked for. So numeric fields hold their draft and commit when the user
 * is done with them. `fps` could commit live without hurting anything, and does not,
 * because a control that behaves differently from its neighbour for reasons only its
 * author knows is worse than one that is uniformly a beat late.
 *
 * ## The resolution LADDER (§V171)
 *
 * This is the TOP of it: project → component → node. The lower levels each default to
 * their parent and say where the value came from, which is a per-node affordance living
 * in the inspector's Common tab rather than here — a level that looked authored when it
 * was inherited is how someone edits the wrong one.
 */

const FORMATS: ReadonlyArray<{ value: TextureFormat; label: string }> = [
  { value: "rgba16float", label: "16-bit float RGBA" },
  { value: "rgba8unorm", label: "8-bit RGBA" },
  { value: "rgba8unorm-srgb", label: "8-bit RGBA, sRGB" },
];

export interface ProjectSettingsProps {
  readonly settings: ProjectSettings;
  /** One field at a time — a partial patch, never the whole object (T272). */
  readonly onChange: (patch: Partial<ProjectSettings>, label: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** A number input that commits on blur or Enter, and reverts on Escape. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onCommit,
  onDirtyChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onCommit: (next: number) => void;
  /** Tells the dialog a field is mid-edit, so Escape reverts it instead of dismissing. */
  onDirtyChange: (key: string, dirty: boolean) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);

  const setDirty = useCallback(
    (next: string | null) => {
      setDraft(next);
      onDirtyChange(id, next !== null);
    },
    [id, onDirtyChange],
  );

  const commit = useCallback(() => {
    if (draft === null) return;
    setDirty(null);
    const parsed = Number(draft);
    // A field left in a state the schema would refuse simply reverts: the command would
    // reject it anyway, and a rejection the user has to read to understand a field that
    // snapped back is worse than the field just snapping back.
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, parsed));
    if (clamped === value) return;
    onCommit(clamped);
  }, [draft, max, min, onCommit, setDirty, value]);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        {...(step === undefined ? {} : { step })}
        value={shown}
        onChange={(event) => setDirty(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && draft !== null) {
            // Escape reverts the FIELD, and the DIALOG is told not to dismiss — through
            // Radix's own `onEscapeKeyDown`, because it listens on the document in the
            // capture phase where neither `stopPropagation` nor stopping the native event
            // from here can reach it. Without that, one press both reverts the number and
            // closes the dialog, and the user never sees the revert.
            //
            // With no draft to revert, Escape falls through and closes, which is what a
            // dialog is expected to do.
            event.preventDefault();
            setDirty(null);
          }
        }}
      />
      {unit === undefined ? null : <span className={styles.unit}>{unit}</span>}
    </div>
  );
}

export function ProjectSettingsDialog({
  settings,
  onChange,
  open,
  onOpenChange,
}: ProjectSettingsProps) {
  const formatId = useId();
  const typeLabelsId = useId();
  const { width, height } = settings.outputResolution;
  const typeLabels = nodeTypeLabelStore();
  const showTypeLabels = useSyncExternalStore(typeLabels.subscribe, typeLabels.get);

  // Which fields are mid-edit. A ref, not state: it is read inside an event handler and
  // changing it must not re-render the dialog under the user's cursor (§V16's spirit).
  const dirty = useRef(new Set<string>());
  const onDirtyChange = useCallback((key: string, isDirty: boolean) => {
    if (isDirty) dirty.current.add(key);
    else dirty.current.delete(key);
  }, []);

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="project-settings"
        onEscapeKeyDown={(event) => {
          // A half-typed number is what Escape is for first; the dialog is what it is for
          // second. Reverting a field and closing the dialog on one press would lose the
          // revert entirely, because the user never sees the field again.
          if (dirty.current.size > 0) event.preventDefault();
        }}
      >
        <DialogTitle>Project settings</DialogTitle>

        <section className={styles.group} aria-label="Output">
          <h3 className={styles.groupTitle}>output</h3>
          <div className={styles.row}>
            <NumberField
              label="width"
              value={width}
              min={1}
              max={settings.limits.maxResolution}
              unit="px"
              onCommit={(next) =>
                onChange({ outputResolution: { width: next, height } }, "Set output width")
              }
              onDirtyChange={onDirtyChange}
            />
            <NumberField
              label="height"
              value={height}
              min={1}
              max={settings.limits.maxResolution}
              unit="px"
              onCommit={(next) =>
                onChange({ outputResolution: { width, height: next } }, "Set output height")
              }
              onDirtyChange={onDirtyChange}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={formatId}>
              working format
            </label>
            <select
              id={formatId}
              className={styles.select}
              value={settings.workingFormat}
              onChange={(event) =>
                onChange(
                  { workingFormat: event.target.value as TextureFormat },
                  "Set working format",
                )
              }
            >
              {FORMATS.map((format) => (
                <option key={format.value} value={format.value}>
                  {format.label}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className={styles.group} aria-label="Timing">
          <h3 className={styles.groupTitle}>timing</h3>
          <NumberField
            label="target fps"
            value={projectFps(settings)}
            min={1}
            max={240}
            unit="fps"
            onCommit={(next) => onChange({ fps: next }, "Set frame rate")}
            onDirtyChange={onDirtyChange}
          />
          <NumberField
            label="preview fps"
            value={settings.previewFps}
            min={1}
            max={240}
            unit="fps"
            onCommit={(next) => onChange({ previewFps: next }, "Set preview rate")}
            onDirtyChange={onDirtyChange}
          />
        </section>

        {/*
          T416 — the one GRAPH setting, and the reason it is here rather than in
          `ProjectSettings`.

          What it controls is per-person chrome: whether a node's TYPE is drawn beside its
          name, so renaming a node does not cost the identification the auto-name was
          giving. That is the same category as pane layout (§V18) and keymap overrides
          (§V54) — it must not ride inside a `.loom.json`, where one reader's preference
          would arrive as a fact about someone else's document, and it must not bump the
          revision, because a look at the graph on the undo stack means ⌘Z after a glance
          undoes the glance. So it persists to `localStorage` and does NOT go through
          `project.setSettings`; this dialog is simply the only settings surface the app
          has, and inventing a second one to hold a single switch would be the drift T356
          deleted a duplicate surface to prevent.

          §T390 (the inputs above not matching the app's own controls) is a separate open
          bug and is deliberately NOT fixed here — but this row does not COPY the divergent
          styling either: it uses `BooleanField`, the shared primitive, which is where those
          fields are supposed to end up.
        */}
        <section className={styles.group} aria-label="Graph">
          <h3 className={styles.groupTitle}>graph</h3>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={typeLabelsId}>
              node type label
            </label>
            <BooleanField
              id={typeLabelsId}
              label="Show each node's type beside its name"
              value={showTypeLabels}
              onChange={(next) => typeLabels.set(next)}
            />
          </div>
        </section>

        <section className={styles.group} aria-label="Determinism">
          <h3 className={styles.groupTitle}>determinism</h3>
          <NumberField
            label="seed"
            value={settings.randomSeed}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            onCommit={(next) => onChange({ randomSeed: next }, "Set random seed")}
            onDirtyChange={onDirtyChange}
          />
        </section>
      </DialogContent>
    </DialogRoot>
  );
}

export { DEFAULT_PROJECT_FPS };
