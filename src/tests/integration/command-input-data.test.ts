import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { createAppRuntime } from "@/app/app-runtime.ts";
import { registerAudioTrackCommands } from "@/app/audio-track-commands.ts";
import { registerCompileCommand } from "@/app/compile-command.ts";
import { registerComponentNavigationCommands, registerCreateComponentCommand } from "@/app/component-navigation.ts";
import { registerFullscreenCommand } from "@/app/fullscreen-commands.ts";
import { registerLayoutCommands } from "@/app/layout-commands.ts";
import { registerPerformCommands } from "@/app/perform-commands.ts";
import { registerProjectCommands } from "@/app/project-commands.ts";
import { registerRenderRangeCommand } from "@/app/render-range.ts";
import { registerResetFeedbackCommand } from "@/app/runtime-commands.ts";
import { registerSelectionCommands } from "@/app/selection-commands.ts";
import { registerTransportCommands } from "@/app/transport-commands.ts";
import { registerViewCommands } from "@/app/view-commands.ts";
import { registerViewerCommands } from "@/app/viewer-commands.ts";
import { registerControlCommands } from "@editor/controls/control-commands.ts";
import { registerEdgeFlowCommand } from "@editor/edges/edge-flow-command.ts";
import { registerReferenceLinesCommand } from "@editor/edges/reference-lines-command.ts";
import { registerWireStyleCommand } from "@editor/edges/wire-style-command.ts";
import { registerMinimapCommand } from "@editor/graph-canvas/minimap-command.ts";
import { registerScrollPanCommand } from "@editor/graph-canvas/scroll-pan-command.ts";
import { registerHelpCommand } from "@editor/help/command.ts";
import { registerNodeInfoCommand } from "@editor/inspect/command.ts";
import { registerPipelineCommand } from "@editor/inspect/pipeline-command.ts";
import { registerProjectSettingsCommand } from "@editor/inspect/settings-command.ts";
import { registerNodeSearchCommand } from "@editor/library/node-search-command.ts";
import { registerRenameSessionCommand } from "@editor/nodes/rename-session.ts";
import { registerTimingOverlayCommand } from "@editor/nodes/timing-overlay-command.ts";
import { registerPaletteCommands } from "@editor/palette/palette-commands.ts";
import { registerSelectNodesCommand } from "@editor/selection/select-created.ts";
import { registerPreviewViewCommands } from "@editor/viewer/preview-view-command.ts";
import { isAnyInput } from "@domain/commands/input-schema.ts";
import { pulseCommandInput } from "@domain/parameters/pulse.ts";
import type { MenuEntry } from "@domain/types/menus.ts";
import { isMenuSeparator } from "@domain/types/menus.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { resolveBindingInput } from "@editor/keymap/when.ts";
import { hasMenuInputBuilder } from "@editor/menus/input.ts";
import { menuSchemaFor } from "@editor/menus/schemas.ts";

/**
 * §T1556b — THE INPUT THE APP'S OWN DATA SENDS IS INPUT ITS COMMAND TAKES.
 *
 * The bus parses every command's input now, and a schema is strict: an unknown key is
 * refused. So a keymap binding, a menu row or a pulse template whose input does not fit its
 * command is no longer a handler quietly ignoring a field — it is a key that does nothing
 * but log a refusal (B87's shape: everything registered, guarded, labelled and invoked, and
 * the dispatch lands nothing). These three tables are DATA, typed loosely
 * (`Record<string, unknown>`), so the compiler cannot hold them to the command's input; this
 * does, against the schema the bus will parse them with.
 *
 * What is checked is what the data says on its own: a binding's static input with its
 * `inputFrom` filled the way the engine fills it, a menu row's static input where no builder
 * replaces it, a pulse's template with its node substituted. A command no product entry point
 * registers headlessly (the hook-registered ones) is skipped and counted, so the gate cannot
 * pass by reading nothing.
 */

const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "gate", label: "Gate" } });
const { bus } = runtime;
// The registrars the app calls from its components rather than from the runtime: each needs
// only a bus, and each is idempotent, so the gate sees the commands the keymap and menus name.
for (const register of [
  registerRenderRangeCommand,
  registerComponentNavigationCommands,
  registerCreateComponentCommand,
  registerCompileCommand,
  registerLayoutCommands,
  registerSelectionCommands,
  registerViewerCommands,
  registerViewCommands,
  registerAudioTrackCommands,
  registerFullscreenCommand,
  registerPerformCommands,
  registerProjectCommands,
  registerTransportCommands,
  registerMinimapCommand,
  registerScrollPanCommand,
  registerWireStyleCommand,
  registerProjectSettingsCommand,
  registerPipelineCommand,
  registerNodeInfoCommand,
  registerTimingOverlayCommand,
  registerRenameSessionCommand,
  registerNodeSearchCommand,
  registerControlCommands,
  registerPreviewViewCommands,
  registerSelectNodesCommand,
  registerReferenceLinesCommand,
  registerEdgeFlowCommand,
  registerPaletteCommands,
  registerHelpCommand,
] as ReadonlyArray<(target: typeof bus) => unknown>) {
  register(bus);
}
registerResetFeedbackCommand(bus, { backend: () => undefined, compiled: () => null, resetState: () => { throw new Error("No backend in this schema-only fixture."); } });

/** The issues the command's schema finds in `input`, as sentences; null when nothing registers it. */
function problems(command: string, input: unknown): string[] | null {
  const schema = bus.inputSchemaOf(command);
  if (schema === undefined) return null;
  if (isAnyInput(schema)) return [];
  const parsed = (schema as ZodType).safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

interface Checked {
  readonly checked: number;
  readonly skipped: number;
  readonly failures: string[];
}

function check(rows: ReadonlyArray<{ readonly what: string; readonly command: string; readonly input: unknown }>): Checked {
  const failures: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const row of rows) {
    const found = problems(row.command, row.input);
    if (found === null) {
      skipped += 1;
      continue;
    }
    checked += 1;
    for (const problem of found) failures.push(`${row.what} → ${row.command}: ${problem}`);
  }
  return { checked, skipped, failures };
}

describe("§T1556b — the app's data sends each command input that command's schema takes", () => {
  it("every default keymap binding, with its inputFrom filled as the engine fills it", () => {
    const environment = { context: "global" as const, selection: ["n1"], hoveredNodeId: "n1" };
    const rows = DEFAULT_BINDINGS.flatMap((binding) => {
      const resolved = resolveBindingInput(binding, environment);
      return resolved.ok ? [{ what: `binding ${binding.id} (${binding.keys})`, command: binding.command, input: resolved.input }] : [];
    });
    const result = check(rows);
    expect(result.failures).toEqual([]);
    // 35 bindings name a command when this was written; all but a few register here.
    expect(result.checked).toBeGreaterThan(25);
  });

  it("every menu row whose static input is its whole input (no builder replaces it)", () => {
    const rows: Array<{ what: string; command: string; input: unknown }> = [];
    const walk = (surface: string, entries: readonly MenuEntry[]): void => {
      for (const entry of entries) {
        if (isMenuSeparator(entry)) continue;
        if (entry.command !== undefined && !hasMenuInputBuilder(entry.command)) {
          rows.push({ what: `${surface} menu "${entry.label}"`, command: entry.command, input: { ...((entry.input as object | undefined) ?? {}) } });
        }
        if (entry.submenu !== undefined) walk(surface, entry.submenu);
      }
    };
    for (const surface of ["canvas", "node", "port", "edge", "parameter"] as const) {
      walk(surface, menuSchemaFor(surface, bus.registry).entries);
    }
    const result = check(rows);
    expect(result.failures).toEqual([]);
    expect(result.checked).toBeGreaterThan(3);
  });

  it("every pulse parameter's template, with its node substituted", () => {
    const rows = bus.registry.list().flatMap((definition) =>
      Object.entries(definition.parameters).flatMap(([key, parameter]) =>
        parameter.type === "pulse"
          ? [{ what: `${definition.type}.${key}`, command: parameter.fires, input: pulseCommandInput(parameter, "n1") }]
          : [],
      ),
    );
    const result = check(rows);
    expect(result.failures).toEqual([]);
    // preset.recall, the cue list's GO/BACK and the feedback nodes' resets (media.cue and the
    // inference reset register from hooks and are skipped).
    expect(result.checked).toBeGreaterThan(5);
  });
});
