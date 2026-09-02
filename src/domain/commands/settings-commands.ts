import { projectSettingsSchema } from "../types/schemas.ts";
import type { ProjectSettings } from "../types/graph.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { Revision } from "../types/ids.ts";
import { classifySettingsChange } from "../project/settings-change.ts";
import type { LoomBus } from "./bus.ts";

/**
 * `project.setSettings` (T272, §V177, §V178, §V29).
 *
 * Settings are DOCUMENT state: they serialize with the graph, they bump the revision, and
 * they make ONE undo entry. So they mutate through a command like everything else, and
 * this is the only way in — a pane holding a settings object and writing to it would be
 * the second mutation path §V29 exists to prevent.
 *
 * ## Partial, and validated as partial
 *
 * A settings UI edits one field at a time. Requiring a whole `ProjectSettings` would make
 * every control read-modify-write the entire object, and two controls edited in the same
 * tick would clobber each other — the second write carrying the first's stale copy of
 * every other field. So the input is a PATCH, and it is validated with
 * `projectSettingsSchema.partial()`: each supplied field is checked exactly as it would be
 * on load, and absent fields are absent rather than defaulted (§V68).
 *
 * ## What the caller is told
 *
 * The outcome carries the CLASSIFICATION (§V178), not just success. The composition root
 * needs to know whether this edit was structural, and deriving it a second time from
 * before/after would be a second answer to the same question.
 */

export const SET_SETTINGS_COMMAND = "project.setSettings";

declare module "../types/commands.ts" {
  interface CommandMap {
    "project.setSettings": { input: SetSettingsInput; output: SetSettingsOutput };
  }
}

export interface SetSettingsInput {
  /** Fields to change. Absent fields keep their current value. */
  settings: Partial<ProjectSettings>;
  /**
   * The undo entry's label, TD-style: "Set frame rate" rather than "project.setSettings".
   * Defaults to a generic one so a caller that has no better word still reads sensibly.
   */
  label?: string;
}

export interface SetSettingsOutput {
  ok: boolean;
  /** Fields whose value actually differs. Empty when the patch changed nothing. */
  changed: readonly string[];
  /** True when at least one changed field requires a recompile (§V178). */
  structural: boolean;
  diagnostics: RuntimeDiagnostic[];
}

function invalid(message: string, suggestion?: string): RuntimeDiagnostic {
  return {
    severity: "error",
    code: "project.settings.invalid",
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

export function registerSettingsCommands(bus: LoomBus): void {
  if (bus.hasCommand(SET_SETTINGS_COMMAND)) return;

  bus.registerCommand({
    name: SET_SETTINGS_COMMAND,
    description: "Change project settings: resolution, format, frame rate, seed, limits.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const diagnostics: RuntimeDiagnostic[] = [];

      // §V37/§V68: the same schema the file boundary uses, taken one field at a time. An
      // agent patch built against a stale schema is refused here rather than becoming a
      // settings object the compiler cannot read.
      const parsed = projectSettingsSchema.partial().safeParse(input.settings);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path.length === 0 ? "settings" : issue.path.join(".");
          diagnostics.push(invalid(`${path}: ${issue.message}`));
        }
        return rejection(revision, diagnostics);
      }

      const before = context.store.getSettings();
      const patch = parsed.data as Partial<ProjectSettings>;
      const after: ProjectSettings = { ...before, ...patch };
      const change = classifySettingsChange(before, after);

      if (change.changed.length === 0) {
        // Not an error and not a mutation: setting a field to what it already is must not
        // burn a revision, an undo slot, or a recompile.
        return {
          status: "applied",
          revision,
          diagnostics,
          output: { ok: true, changed: [], structural: false, diagnostics },
        };
      }

      const applied = context.applySettings({
        label: input.label ?? "Change project settings",
        patch,
      });

      return {
        status: "applied",
        revision: applied.revision,
        diagnostics,
        ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
        output: {
          ok: true,
          changed: change.changed.map(String),
          structural: change.structural,
          diagnostics,
        },
      };
    },
    rejectionOutput: (_input, diagnostics) => ({
      ok: false,
      changed: [],
      structural: false,
      diagnostics,
    }),
  });
}

function rejection(revision: Revision, diagnostics: RuntimeDiagnostic[]) {
  return {
    status: "rejected" as const,
    revision,
    diagnostics,
    output: { ok: false, changed: [], structural: false, diagnostics },
  };
}
