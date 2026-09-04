import { useCallback, useState, useSyncExternalStore } from "react";
import type { ProjectSettings } from "@domain/types/graph.ts";
import {
  DEFAULT_PROJECT_FPS,
  SEEK_FRAME_LIMIT,
  projectFps,
  projectRange,
} from "@domain/types/graph.ts";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import { nodeTypeLabelStore } from "@editor/nodes/node-type-labels.ts";
import { starterPreferenceStore } from "./starter-preference.ts";
import { BooleanField } from "@ui/controls/boolean-field.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { NumberField } from "@ui/controls/number-field.tsx";
import type { EditPhase, NumericSpec } from "@ui/controls/types.ts";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import styles from "./project-settings.module.css";

/**
 * Project settings (T266, T390, §V177, §V178, §V171).
 *
 * The owner asked for target fps and resolution controls a long time ago. The fields are
 * not all of a kind:
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
 *  - NODE TYPE LABEL is not project state at all; see its row below.
 *
 * Every edit to the four project fields leaves through `project.setSettings` (§V29):
 * this component holds no settings state of its own beyond a value a field is mid-drag.
 *
 * ## T390 — why this page is now built out of `ui/controls`
 *
 * It used to own a private `NumberField`, a bare `<select>` and its own input CSS, and it
 * looked like a different application: every field a different width for no reason (a
 * spinner for `width`, none for `height`, a full-bleed box for a one-digit seed), labels
 * and fields on no shared grid, `px`/`fps` floating at arbitrary distances, and width and
 * height — visibly a pair — presented as two unrelated rows. That is the drift T356
 * deleted a duplicate keybinding surface to prevent: a second set of controls over the
 * same kind of data.
 *
 * So the rows are `ControlRow` (one label column, one field column, aligned by the same
 * grid every inspector row uses), the numbers are the shared draggable `NumberField` with
 * its unit ATTACHED, the format is `EnumField`, and the pairs are laid out side by side
 * exactly the way the inspector's own Common section lays out width and height. Nothing
 * here is restyled to resemble the kit; it IS the kit.
 *
 * ## Why a number still commits only when the gesture ends
 *
 * The shared `NumberField` reports intermediate values as `"live"` and the settled one as
 * `"commit"` (§V15). A resolution change recreates every render target and resets feedback
 * history (§V50, §V22), so writing one per frame of a drag would rebuild the plan at every
 * width between 1280 and 1600. `commitOnly` below holds the live value locally so the
 * field moves under the cursor, and lets exactly one value reach the document — the same
 * arrangement the inspector's Common section uses for the per-node size, so the two levels
 * of the resolution ladder behave identically.
 *
 * ## The resolution LADDER (§V171)
 *
 * This is the TOP of it: project → component → node. The lower levels each default to
 * their parent and say where the value came from, which is a per-node affordance living
 * in the inspector's Common tab rather than here — a level that looked authored when it
 * was inherited is how someone edits the wrong one.
 */

const FORMAT_OPTIONS: ReadonlyArray<{ value: TextureFormat; label: string }> = [
  { value: "rgba16float", label: "16-bit float RGBA" },
  { value: "rgba8unorm", label: "8-bit RGBA" },
  { value: "rgba8unorm-srgb", label: "8-bit RGBA, sRGB" },
];

/** Whole pixels: a resolution edit recreates render targets, so there are no half ones. */
const dimensionSpec = (max: number): NumericSpec => ({
  min: 1,
  max,
  step: 1,
  precision: 0,
});
/** A rate is a whole number of frames per second, 1..240. */
const FPS_SPEC: NumericSpec = { min: 1, max: 240, step: 1, precision: 0 };
/**
 * A timeline endpoint, in frames (T454).
 *
 * The bounds are not decoration. `min` keeps the out point after the in point, so the
 * field cannot produce the inverted range the schema would then refuse with an error the
 * user did not ask for; `max` is `SEEK_FRAME_LIMIT`, because a range whose out point a
 * seek will not replay is a range that cannot loop and cannot render (§V170).
 */
const rangeSpec = (max: number, min = 0): NumericSpec => ({ min, max, step: 1, precision: 0 });
/**
 * The seed has no meaningful maximum to drag towards, so it gets the same integer spec
 * with a reach the ladder can actually cross rather than `MAX_SAFE_INTEGER`, which makes
 * every drag either nothing or everything.
 */
const SEED_SPEC: NumericSpec = {
  min: 0,
  max: 1_000_000,
  step: 1,
  precision: 0,
};

export interface ProjectSettingsProps {
  readonly settings: ProjectSettings;
  /** One field at a time — a partial patch, never the whole object (T272). */
  readonly onChange: (patch: Partial<ProjectSettings>, label: string) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ProjectSettingsDialog({
  settings,
  onChange,
  open,
  onOpenChange,
}: ProjectSettingsProps) {
  const { width, height } = settings.outputResolution;
  const typeLabels = nodeTypeLabelStore();
  const showTypeLabels = useSyncExternalStore(
    typeLabels.subscribe,
    typeLabels.get,
  );
  const starter = starterPreferenceStore();
  const startOnStarter = useSyncExternalStore(starter.subscribe, starter.get);

  /**
   * The value a field is mid-drag, keyed by field. Null for a field means "show the
   * document's value" — which is every field, every time a gesture ends.
   */
  const [live, setLive] = useState<Readonly<Record<string, number>>>({});
  const shown = useCallback(
    (key: string, stored: number) => live[key] ?? stored,
    [live],
  );

  /**
   * Turns the kit's live/commit stream into "move the field now, write the document
   * once". Not a commit policy invented here: it is what §V15 asks a consumer that
   * cannot afford a write per frame to do, and what the inspector's size fields do.
   */
  const commitOnly = useCallback(
    (key: string, apply: (value: number) => void) =>
      (value: number, phase: EditPhase): void => {
        if (phase !== "commit") {
          setLive((previous) => ({ ...previous, [key]: value }));
          return;
        }
        setLive((previous) => {
          const { [key]: _dropped, ...rest } = previous;
          return rest;
        });
        apply(value);
      },
    [],
  );

  const maxResolution = settings.limits.maxResolution;
  // T454/T433 — one range, read through the one accessor that applies the default.
  const range = projectRange(settings);

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="project-settings"
        onEscapeKeyDown={(event) => {
          /**
           * §V302 — Escape may not do two things at once.
           *
           * A half-typed number is what Escape is for FIRST; the dialog is what it is for
           * second. One press that both reverts the field and closes the dialog loses the
           * revert entirely, because the user never sees the field again. Radix listens on
           * the document in the CAPTURE phase, so neither `stopPropagation` nor stopping
           * the native event from inside the field can reach it — declining the dismissal
           * here is the only place that works.
           *
           * The condition is read off the DOM rather than tracked in a ref, because the
           * shared `NumberField` owns its own text-entry state and publishes it as
           * `data-editing`; a mirror of that in this component would be a second source of
           * truth for a fact the control already states. `[role="listbox"]` is the drag
           * magnitude ladder, whose own Escape dismisses it.
           */
          const target = event.target as Element | null;
          if (
            target?.closest?.('[data-editing="true"], [role="listbox"]') != null
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle>Project settings</DialogTitle>

        <section className={styles.group} aria-label="Output">
          <h3 className={styles.groupTitle}>output</h3>
          {/*
            Width and height are ONE fact about the project, so they are one row with two
            fields, not two rows the eye has to pair up itself. `px` rides on each field
            rather than floating beside the row.
          */}
          <ControlRow label="resolution">
            <div className={styles.pair}>
              <NumberField
                label="width"
                value={shown("width", width)}
                spec={dimensionSpec(maxResolution)}
                unit="px"
                onChange={commitOnly("width", (next) =>
                  onChange(
                    { outputResolution: { width: next, height } },
                    "Set output width",
                  ),
                )}
              />
              <NumberField
                label="height"
                value={shown("height", height)}
                spec={dimensionSpec(maxResolution)}
                unit="px"
                onChange={commitOnly("height", (next) =>
                  onChange(
                    { outputResolution: { width, height: next } },
                    "Set output height",
                  ),
                )}
              />
            </div>
          </ControlRow>
          <ControlRow label="working format">
            <EnumField
              label="working format"
              value={settings.workingFormat}
              options={[...FORMAT_OPTIONS]}
              onChange={(next) =>
                onChange(
                  { workingFormat: next as TextureFormat },
                  "Set working format",
                )
              }
            />
          </ControlRow>
        </section>

        <section className={styles.group} aria-label="Timing">
          <h3 className={styles.groupTitle}>timing</h3>
          {/*
            NOT collapsed into one two-field row the way the resolution is, deliberately.
            Width and height are two components of ONE value and read positionally (w × h)
            in every tool there is. The two rates are two different settings that merely
            share a unit — the timeline's denominator (§V176) and how often a node tile
            refreshes — and a side-by-side pair with no visible labels would ask the user to
            remember which box was which. They are two rows on the SAME grid instead, which
            is what the complaint about alignment was actually about.
          */}
          <ControlRow label="target fps">
            <div className={styles.scalar}>
              <NumberField
                label="target fps"
                value={shown("fps", projectFps(settings))}
                spec={FPS_SPEC}
                onChange={commitOnly("fps", (next) =>
                  onChange({ fps: next }, "Set frame rate"),
                )}
              />
            </div>
          </ControlRow>
          <ControlRow label="preview fps">
            <div className={styles.scalar}>
              <NumberField
                label="preview fps"
                value={shown("previewFps", settings.previewFps)}
                spec={FPS_SPEC}
                onChange={commitOnly("previewFps", (next) =>
                  onChange({ previewFps: next }, "Set preview rate"),
                )}
              />
            </div>
          </ControlRow>
          {/*
            T454 — the timeline's LENGTH is project state, not chrome.

            The owner's reasoning, and it is the right one: duration is CONTENT. The piece
            is twelve seconds long and that travels with the document — the opposite of
            pane layout and keymap overrides, which are per-person and live in
            `localStorage` (§V18, §V54). So it sits here beside fps and resolution, and a
            project opened on another machine has the same length.

            One row with two fields, laid out like the resolution above, for the same
            reason: in and out are two components of ONE value (T433 — the out point is the
            render length AND the loop end AND the scrub extent), and two separate rows
            would invite reading them as two settings that can drift apart. The header
            scrubber drags the same value; there is no second number anywhere.
          */}
          <ControlRow label="timeline range">
            <div className={styles.pair}>
              <NumberField
                label="range in"
                value={shown("rangeStart", range.start)}
                spec={rangeSpec(range.end - 1)}
                onChange={commitOnly("rangeStart", (next) =>
                  onChange(
                    { frameRange: { start: next, end: range.end } },
                    "Set the timeline in point",
                  ),
                )}
              />
              <NumberField
                label="range out"
                value={shown("rangeEnd", range.end)}
                spec={rangeSpec(SEEK_FRAME_LIMIT, range.start + 1)}
                onChange={commitOnly("rangeEnd", (next) =>
                  onChange(
                    { frameRange: { start: range.start, end: next } },
                    "Set the timeline out point",
                  ),
                )}
              />
            </div>
          </ControlRow>
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
        */}
        <section className={styles.group} aria-label="Graph">
          <h3 className={styles.groupTitle}>graph</h3>
          <ControlRow label="node type label">
            <BooleanField
              label="Show each node's type beside its name"
              value={showTypeLabels}
              onChange={(next) => typeLabels.set(next)}
            />
          </ControlRow>
        </section>

        {/*
          The STARTUP switch, and the same argument as the row above for why it is here
          and not in `ProjectSettings`.

          It decides what happens before any document exists — an empty canvas, or the
          small shipped network `use-starter-project.ts` opens when there is nothing to
          restore — so there is no `.loom.json` it could honestly ride in. Per person,
          `localStorage`, no revision bump, and this dialog because it is the only
          settings surface the app has (T356).

          Worth stating plainly next to the switch: turning it OFF cannot cost anyone
          their work, and neither can leaving it on. The starter only ever loads onto a
          boot with no autosave to restore, so the setting chooses between a starter and
          an empty canvas — never between a starter and your project.
        */}
        <section className={styles.group} aria-label="Startup">
          <h3 className={styles.groupTitle}>startup</h3>
          <ControlRow label="starter network">
            <BooleanField
              label="Open a small example when there is nothing to restore"
              value={startOnStarter}
              onChange={(next) => starter.set(next)}
            />
          </ControlRow>
        </section>

        <section className={styles.group} aria-label="Determinism">
          <h3 className={styles.groupTitle}>determinism</h3>
          <ControlRow label="seed">
            <div className={styles.scalar}>
              <NumberField
                label="seed"
                value={shown("randomSeed", settings.randomSeed)}
                spec={SEED_SPEC}
                onChange={commitOnly("randomSeed", (next) =>
                  onChange({ randomSeed: next }, "Set random seed"),
                )}
              />
            </div>
          </ControlRow>
        </section>
      </DialogContent>
    </DialogRoot>
  );
}

export { DEFAULT_PROJECT_FPS };
