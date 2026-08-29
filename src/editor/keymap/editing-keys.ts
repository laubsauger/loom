import type { EventStroke } from "./keys.ts";
import type { Platform } from "./types.ts";

/**
 * What the `text` context swallows (§V53).
 *
 * "mod+z in the shader editor must never reach graph undo" is the headline case, but
 * the rule is broader and deliberately structural: while a text field has focus, any
 * keystroke that a text field is expected to consume is the text field's, full stop.
 * The keymap does not dispatch it and does not preventDefault it — the field gets its
 * native behavior.
 *
 * Keys that are NOT text editing (Escape, mod+s, mod+k, function keys) still fall
 * through to the broader contexts, so closing a dialog or saving while typing works.
 * A pane that wants to claim more than this list declares a binding in the `text`
 * context; an explicit `text` binding always wins over the swallow.
 */

const EDITING_NAMED_KEYS = new Set([
  "space",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

/** Clipboard, undo and select-all: the same six everywhere, under `mod`. */
const MOD_EDITING_KEYS = new Set(["z", "y", "x", "c", "v", "a"]);

/**
 * macOS text fields ship emacs-style control bindings at the system level, so on mac a
 * ctrl+letter from this set belongs to the field, not to the keymap.
 */
const MAC_CONTROL_EDITING_KEYS = new Set(["a", "b", "d", "e", "f", "h", "k", "n", "p", "w"]);

function isPrintableKey(key: string): boolean {
  return key.length === 1 || /^numpad[0-9]$/.test(key);
}

export function isEditingStroke(stroke: EventStroke, platform: Platform): boolean {
  const mod = platform === "mac" ? stroke.meta : stroke.ctrl;
  const otherModifier = platform === "mac" ? stroke.ctrl : stroke.meta;

  if (!mod && !otherModifier) {
    // Typing: any printable character, with or without Shift/Alt.
    if (isPrintableKey(stroke.key)) return true;
    if (EDITING_NAMED_KEYS.has(stroke.key)) return true;
    return false;
  }

  if (mod && !otherModifier) {
    if (MOD_EDITING_KEYS.has(stroke.key)) return true;
    // Word/line-wise motion and deletion.
    if (EDITING_NAMED_KEYS.has(stroke.key) && stroke.key !== "space" && stroke.key !== "tab") {
      return true;
    }
    return false;
  }

  if (platform === "mac" && stroke.ctrl && !stroke.meta && !stroke.alt) {
    return MAC_CONTROL_EDITING_KEYS.has(stroke.key);
  }

  return false;
}
