import type { ShaderloomBus } from "../../domain/commands/bus.ts";
import type { ResolvedKeymap } from "../keymap/resolve.ts";
import type { KeyContext } from "../keymap/types.ts";

/**
 * What the palette lists (T79, §V55).
 *
 * The union of two sets: every command registered on the bus, and every command NAMED
 * by a binding. The second set is the interesting one — a binding may point at a
 * command a later track registers (play/pause, save, fit…). Those appear, greyed, as
 * `available: false`, so the keymap stays honest about what it promises instead of
 * hiding half of itself until some other track lands.
 */

export interface PaletteEntry {
  command: string;
  label: string;
  description: string | null;
  /** Effective keys, `null` when the command has no binding or is unbound. */
  keys: string | null;
  display: string | null;
  bindingId: string | null;
  context: KeyContext | null;
  /** False when no track has registered the command on the bus yet. */
  available: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  graph: "Graph",
  node: "Node",
  view: "View",
  ui: "UI",
  project: "Project",
  transport: "Transport",
  runtime: "Runtime",
};

/** "graph.applyPatch" → "Graph: Apply patch". Only used when no binding names it. */
export function humanizeCommand(command: string): string {
  const [head, ...rest] = command.split(".");
  const tail = rest.length === 0 ? (head ?? command) : rest.join(" ");
  const words = tail
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  const phrase = words.charAt(0).toUpperCase() + words.slice(1);
  if (rest.length === 0) return phrase;
  const category = CATEGORY_LABELS[head ?? ""] ?? (head ?? "").charAt(0).toUpperCase() + (head ?? "").slice(1);
  return `${category}: ${phrase}`;
}

export interface BuildPaletteEntriesOptions {
  bus: Pick<ShaderloomBus, "listCommands" | "hasCommand">;
  resolved: ResolvedKeymap;
}

export function buildPaletteEntries({ bus, resolved }: BuildPaletteEntriesOptions): PaletteEntry[] {
  const entries = new Map<string, PaletteEntry>();

  for (const command of bus.listCommands()) {
    entries.set(command, {
      command,
      label: humanizeCommand(command),
      description: null,
      keys: null,
      display: null,
      bindingId: null,
      context: null,
      available: true,
    });
  }

  for (const binding of resolved.bindings) {
    const existing = entries.get(binding.command);
    const available = existing?.available ?? bus.hasCommand(binding.command);
    // First bound binding wins the shortcut column; an unbound one still supplies the
    // human label the palette shows.
    if (existing !== undefined && existing.bindingId !== null && existing.display !== null) continue;
    entries.set(binding.command, {
      command: binding.command,
      label: binding.label,
      description: binding.description ?? null,
      keys: binding.effectiveKeys,
      display: binding.display,
      bindingId: binding.id,
      context: binding.context,
      available,
    });
  }

  return [...entries.values()].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}
