/**
 * Keymap public surface (T76–T78).
 *
 * What other tracks need from here:
 *  - `<KeyHint command="graph.undo" />` — the shortcut chip for a menu item or tooltip.
 *    Never hardcode "⌘Z" (§V55).
 *  - `useCommandKeyDisplay(command)` / `useBindingKeyDisplay(id)` — the same thing as a
 *    string, when you are not rendering a chip.
 *  - `displayForCommand(resolved, command)` — the non-React form.
 *  - `useRunCommand()` — run a bus command from a button exactly as a hotkey would, so
 *    the toolbar and the keyboard share one path (§V29).
 *  - `<KeymapProvider bus … invocationContext … environment …>` — mount once, around
 *    the app. `environment` carries the selection and hovered node that `when` guards
 *    and selection-resolved inputs read.
 *  - `useKeymapPane("graph", ref)` — spread on a pane's root: every key pressed inside it
 *    resolves in that context (§V53), AND the pane can hold focus, which is what makes
 *    the context reachable at all (§V351, B66/B67). Do not write the attribute by hand.
 *
 * There is no rebinding pane here. T360 put the EDITOR on the help panel's shortcuts tab,
 * which was already a projection of the resolved keymap, so the list a user reads and the
 * list a user changes are the same list. The pane that used to live here (`KeybindingSettings`)
 * was a second surface over the same bindings, was never rendered by the app (B38), and is
 * gone rather than left as the thing the shipped editor could drift from.
 */

export type {
  BindingInputSource,
  KeyBinding,
  KeyContext,
  Keymap,
  KeymapCommandName,
  KeymapEnvironment,
  Platform,
} from "./types.ts";
export { CONTEXT_RANK, EMPTY_ENVIRONMENT, KEY_CONTEXTS } from "./types.ts";

export type { BindingStroke, EventStroke, KeyEventLike } from "./keys.ts";
export {
  detectPlatform,
  eventStrokeToKeys,
  formatEventStrokes,
  formatKeys,
  isValidKeys,
  normalizeKeys,
  parseKeys,
  strokeFromEvent,
} from "./keys.ts";

export { DEFAULT_BINDINGS } from "./defaults.ts";

export type { GuardName } from "./when.ts";
export { GUARD_NAMES, evaluateGuard, resolveBindingInput } from "./when.ts";

export {
  KEYMAP_CONTEXT_ATTRIBUTE,
  activeContextsFor,
  isTextEntryTarget,
  paneContextFromTarget,
} from "./context.ts";
export { isEditingStroke } from "./editing-keys.ts";

export type { KeymapPaneProps } from "./pane.ts";
export { useKeymapPane } from "./pane.ts";

export type {
  KeymapConflict,
  KeymapConflictKind,
  KeymapProblem,
  ResolvedBinding,
  ResolvedKeymap,
} from "./resolve.ts";
export {
  bindingsForCommand,
  contextsOverlap,
  displayForBinding,
  displayForCommand,
  resolveKeymap,
} from "./resolve.ts";

export type { KeymapOverrides, KeymapStorage } from "./storage.ts";
export {
  KEYMAP_STORAGE_KEY,
  clearOverrides,
  defaultKeymapStorage,
  readOverrides,
  writeOverrides,
} from "./storage.ts";

export type { KeymapStore, KeymapStoreOptions, SetOverrideResult } from "./store.ts";
export { createKeymapStore } from "./store.ts";

export type { KeymapDispatch, KeymapEngine, KeymapEngineOptions } from "./engine.ts";
export { DEFAULT_CHORD_TIMEOUT_MS, createKeymapEngine } from "./engine.ts";

export type { KeymapContextValue, KeymapProviderProps } from "./keymap-provider.tsx";
export {
  KeymapProvider,
  KeymapWindowTarget,
  useBindingKeyDisplay,
  useCommandKeyDisplay,
  useKeymap,
  useOptionalKeymap,
  useRunCommand,
} from "./keymap-provider.tsx";

export type { KeyChipProps, KeyHintProps } from "./key-hint.tsx";
export { KeyChip, KeyHint } from "./key-hint.tsx";
