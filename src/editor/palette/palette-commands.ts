import type { LoomBus } from "../../domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * The palette's own bus commands (§V52, §V29).
 *
 * `mod+k` is a binding like any other: it names `ui.openCommandPalette` and the engine
 * dispatches it through the bus. That command has to exist somewhere, and the palette
 * is the thing that owns it — this is not a stub for another track's work, it is the
 * real implementation of an action this module implements.
 *
 * Registration is idempotent and indirect: the bus has no unregister, and React mounts
 * (StrictMode, remounts, tests) happen more than once, so the command is registered at
 * most once per bus and dispatches through a mutable holder the live palette owns.
 */

declare module "../../domain/types/commands.ts" {
  interface CommandMap {
    "ui.openCommandPalette": { input: Record<string, never>; output: { open: boolean } };
    "ui.closeCommandPalette": { input: Record<string, never>; output: { open: boolean } };
  }
}

export interface PaletteHandlers {
  open(): void;
  close(): void;
}

export interface PaletteHolder {
  current: PaletteHandlers | null;
}

export function paletteHolderFor(bus: LoomBus): PaletteHolder {
  return commandHolder<PaletteHandlers>(bus, "ui.openCommandPalette");
}

/** Registers `ui.openCommandPalette` / `ui.closeCommandPalette` once per bus. */
export function registerPaletteCommands(bus: LoomBus): PaletteHolder {
  const holder = paletteHolderFor(bus);

  if (!bus.hasCommand("ui.openCommandPalette")) {
    bus.registerCommand({
      name: "ui.openCommandPalette",
      description: "Open the command palette.",
      handler: (_input, context) => {
        if (context.dryRun) {
          return { status: "applied", output: { open: false } };
        }
        holder.current?.open();
        return { status: "applied", output: { open: holder.current !== null } };
      },
    });
  }

  if (!bus.hasCommand("ui.closeCommandPalette")) {
    bus.registerCommand({
      name: "ui.closeCommandPalette",
      description: "Close the command palette.",
      handler: (_input, context) => {
        if (context.dryRun) {
          return { status: "applied", output: { open: false } };
        }
        holder.current?.close();
        return { status: "applied", output: { open: false } };
      },
    });
  }

  return holder;
}
