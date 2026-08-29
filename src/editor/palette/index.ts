/**
 * Command palette (T79).
 *
 * Mount `<CommandPalette />` inside the `<KeymapProvider>`. It registers
 * `ui.openCommandPalette` on the bus, which the default `mod+k` binding names — so the
 * hotkey, a menu item and an agent all open it the same way (§V29, §V55).
 */

export type { CommandPaletteProps } from "./command-palette.tsx";
export { CommandPalette } from "./command-palette.tsx";

export type { BuildPaletteEntriesOptions, PaletteEntry } from "./entries.ts";
export { buildPaletteEntries, humanizeCommand } from "./entries.ts";

export type { FuzzyMatch, FuzzyResult } from "./fuzzy.ts";
export { fuzzyFilter, fuzzyScore } from "./fuzzy.ts";

export type { PaletteHandlers, PaletteHolder } from "./palette-commands.ts";
export { paletteHolderFor, registerPaletteCommands } from "./palette-commands.ts";
