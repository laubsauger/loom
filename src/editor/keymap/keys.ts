import type { Platform } from "./types.ts";

/**
 * Key string grammar, normalization, matching and display (T76).
 *
 * A binding's `keys` is a space-separated sequence of steps ("g d" is a two-step
 * chord); each step is `+`-joined modifiers followed by one key. `mod` is symbolic and
 * resolves to Cmd on macOS and Ctrl everywhere else — it is never stored resolved, so
 * one persisted override means the same thing on both platforms.
 */

/** A parsed binding step. `mod` stays symbolic until it is matched against an event. */
export interface BindingStroke {
  key: string;
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** A concrete stroke read off a keyboard event. */
export interface EventStroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * Structural subset of `KeyboardEvent`. The engine core is headless-testable, so it
 * never requires a real DOM event.
 */
export interface KeyEventLike {
  key?: string | undefined;
  code?: string | undefined;
  ctrlKey?: boolean | undefined;
  altKey?: boolean | undefined;
  shiftKey?: boolean | undefined;
  metaKey?: boolean | undefined;
  target?: unknown;
}

type ModifierName = "mod" | "ctrl" | "alt" | "shift" | "meta";

const MODIFIER_TOKENS: Record<string, ModifierName> = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  return: "enter",
  spacebar: "space",
  " ": "space",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pgdn: "pagedown",
  plus: "+",
};

const MODIFIER_KEY_NAMES = new Set([
  "shift",
  "control",
  "ctrl",
  "alt",
  "altgraph",
  "meta",
  "os",
  "capslock",
  "numlock",
  "scrolllock",
  "fn",
  "fnlock",
  "hyper",
  "super",
  "symbol",
  "symbollock",
  "dead",
]);

const CODE_TABLE: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "space",
  Escape: "escape",
  Enter: "enter",
  NumpadEnter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadDecimal: ".",
};

/** Canonical name for a key token written by a human or read from `event.key`. */
export function normalizeKeyName(raw: string): string {
  const lower = raw.length === 1 ? raw.toLowerCase() : raw.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Physical-key name from `event.code`. Preferred over `event.key` because `event.key`
 * changes under modifiers ("1" becomes "!" with Shift, letters change with Alt on
 * macOS) — matching on the physical key is what makes `mod+shift+z` and `shift+1`
 * behave the way every other editor's keymap does.
 */
export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `numpad${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return CODE_TABLE[code] ?? null;
}

export function isModifierKeyName(name: string): boolean {
  return MODIFIER_KEY_NAMES.has(name);
}

/**
 * Multi-character key names a binding may use. Anything else is an authoring error —
 * without this, "&&&" would parse as a key that no keyboard can ever produce, and a
 * corrupt override would look valid.
 */
const KNOWN_MULTI_CHAR_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "capslock",
]);

function isKnownKeyName(key: string): boolean {
  if (key.length === 1) return true;
  if (KNOWN_MULTI_CHAR_KEYS.has(key)) return true;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  return /^numpad[0-9]$/.test(key);
}

function parseStep(step: string): BindingStroke | null {
  const trimmed = step.trim();
  if (trimmed === "") return null;

  // "+" / "mod++" — a trailing "+" is the key itself, not a separator.
  let key: string | null = null;
  let modifierSource = trimmed;
  if (trimmed === "+") {
    return { key: "+", mod: false, ctrl: false, alt: false, shift: false, meta: false };
  }
  if (trimmed.endsWith("+")) {
    key = "+";
    modifierSource = trimmed.slice(0, -1).replace(/\+$/, "");
  }
  const tokens = modifierSource.split("+");

  const stroke: BindingStroke = {
    key: "",
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  const last = key === null ? tokens.length - 1 : tokens.length;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = (tokens[index] ?? "").trim().toLowerCase();
    if (token === "") return null;
    if (index < last) {
      const modifier = MODIFIER_TOKENS[token];
      if (modifier === undefined) return null;
      stroke[modifier] = true;
      continue;
    }
    // The final token may still be a modifier name only if it is the key itself,
    // which is never valid: "mod+shift" binds nothing.
    if (MODIFIER_TOKENS[token] !== undefined) return null;
    // Case is significant in TouchDesigner's network editor: `H` homes everything,
    // `h` homes the selection. `H` is physically Shift+H, so the canonical internal
    // form is always the lowercase key plus an explicit shift flag — one spelling per
    // physical chord, which is what makes conflict detection honest. The display layer
    // renders a bare shifted letter back as "H" (see formatStroke).
    //
    // Only for a BARE letter: in "mod+K" the capital is conventional notation for the
    // plain key, and reading it as ⌘⇧K would silently rebind half the app.
    const raw = (tokens[index] ?? "").trim();
    if (index === 0 && /^[A-Z]$/.test(raw)) stroke.shift = true;
    key = normalizeKeyName(token);
  }

  if (key === null || key === "" || !isKnownKeyName(key)) return null;
  stroke.key = key;
  return stroke;
}

/** Parses "mod+shift+z" / "g d". Returns `null` when the string is not a valid keys value. */
export function parseKeys(keys: string): BindingStroke[] | null {
  const steps = keys.trim().split(/\s+/).filter((step) => step !== "");
  if (steps.length === 0) return null;
  const strokes: BindingStroke[] = [];
  for (const step of steps) {
    const stroke = parseStep(step);
    if (stroke === null) return null;
    strokes.push(stroke);
  }
  return strokes;
}

const CANONICAL_ORDER: readonly ModifierName[] = ["mod", "ctrl", "alt", "shift", "meta"];

export function strokeToString(stroke: BindingStroke): string {
  const parts = CANONICAL_ORDER.filter((name) => stroke[name]);
  return [...parts, stroke.key].join("+");
}

/** Canonical spelling of a keys string — the form stored and compared for conflicts. */
export function normalizeKeys(keys: string): string | null {
  const strokes = parseKeys(keys);
  if (strokes === null) return null;
  return strokes.map(strokeToString).join(" ");
}

export function isValidKeys(keys: string): boolean {
  return parseKeys(keys) !== null;
}

/** Reads a stroke off an event. `null` when the event carries no usable key. */
export function strokeFromEvent(event: KeyEventLike): EventStroke | null {
  const fromCode = typeof event.code === "string" && event.code !== "" ? keyFromCode(event.code) : null;
  const fromKey = typeof event.key === "string" && event.key !== "" ? normalizeKeyName(event.key) : null;
  const key = fromCode ?? fromKey;
  if (key === null) return null;
  return {
    key,
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
  };
}

/** `mod` → Cmd on macOS, Ctrl elsewhere. Modifier match is exact: no extras allowed. */
export function strokeMatches(
  binding: BindingStroke,
  event: EventStroke,
  platform: Platform,
): boolean {
  if (binding.key !== event.key) return false;
  const wantsCtrl = binding.ctrl || (binding.mod && platform !== "mac");
  const wantsMeta = binding.meta || (binding.mod && platform === "mac");
  return (
    wantsCtrl === event.ctrl &&
    wantsMeta === event.meta &&
    binding.alt === event.alt &&
    binding.shift === event.shift
  );
}

export function sequenceMatchesPrefix(
  binding: readonly BindingStroke[],
  events: readonly EventStroke[],
  platform: Platform,
): boolean {
  if (events.length > binding.length) return false;
  for (let index = 0; index < events.length; index += 1) {
    const expected = binding[index];
    const actual = events[index];
    if (expected === undefined || actual === undefined) return false;
    if (!strokeMatches(expected, actual, platform)) return false;
  }
  return true;
}

/* ---------------------------------------------------------------- display (§V55) */

const MAC_MODIFIER_GLYPH: Record<Exclude<ModifierName, "mod">, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};

const OTHER_MODIFIER_LABEL: Record<Exclude<ModifierName, "mod">, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Win",
};

const MAC_KEY_GLYPH: Record<string, string> = {
  enter: "↩",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  escape: "Esc",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "⇞",
  pagedown: "⇟",
  home: "↖",
  end: "↘",
};

const OTHER_KEY_LABEL: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Del",
  escape: "Esc",
  space: "Space",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
};

function formatKeyName(key: string, platform: Platform): string {
  const table = platform === "mac" ? MAC_KEY_GLYPH : OTHER_KEY_LABEL;
  const mapped = table[key];
  if (mapped !== undefined) return mapped;
  if (key.length === 1) return key.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function formatStroke(stroke: BindingStroke, platform: Platform): string {
  const ctrl = stroke.ctrl || (stroke.mod && platform !== "mac");
  const meta = stroke.meta || (stroke.mod && platform === "mac");
  // A bare letter, shifted or not, is displayed the way a TouchDesigner user reads it:
  // "H" homes everything, "h" homes the selection. Rendering the shifted form as
  // "⇧H"/"Shift+H" would make the two look like different kinds of binding when they
  // are the same kind — one pair, distinguished by case.
  if (!ctrl && !meta && !stroke.alt && /^[a-z]$/.test(stroke.key)) {
    return stroke.shift ? stroke.key.toUpperCase() : stroke.key;
  }
  if (platform === "mac") {
    // Apple's own order: ⌃ ⌥ ⇧ ⌘, then the key, no separators.
    const parts = [
      ctrl ? MAC_MODIFIER_GLYPH.ctrl : "",
      stroke.alt ? MAC_MODIFIER_GLYPH.alt : "",
      stroke.shift ? MAC_MODIFIER_GLYPH.shift : "",
      meta ? MAC_MODIFIER_GLYPH.meta : "",
    ];
    return `${parts.join("")}${formatKeyName(stroke.key, platform)}`;
  }
  const parts: string[] = [];
  if (ctrl) parts.push(OTHER_MODIFIER_LABEL.ctrl);
  if (stroke.alt) parts.push(OTHER_MODIFIER_LABEL.alt);
  if (stroke.shift) parts.push(OTHER_MODIFIER_LABEL.shift);
  if (meta) parts.push(OTHER_MODIFIER_LABEL.meta);
  parts.push(formatKeyName(stroke.key, platform));
  return parts.join("+");
}

/**
 * Platform-correct display string — "⌘⇧Z" on macOS, "Ctrl+Shift+Z" elsewhere.
 * Menus and tooltips must read this rather than hardcode a glyph (§V55).
 */
export function formatKeys(keys: string, platform: Platform): string | null {
  const strokes = parseKeys(keys);
  if (strokes === null) return null;
  return strokes.map((stroke) => formatStroke(stroke, platform)).join(" ");
}

/** Display for a partially-entered chord, so the UI can show "G …" while pending. */
export function formatEventStrokes(strokes: readonly EventStroke[], platform: Platform): string {
  return strokes
    .map((stroke) =>
      formatStroke(
        {
          key: stroke.key,
          mod: false,
          ctrl: stroke.ctrl,
          alt: stroke.alt,
          shift: stroke.shift,
          meta: stroke.meta,
        },
        platform,
      ),
    )
    .join(" ");
}

/** Canonical keys string for a stroke captured from the keyboard (rebinding, §V54). */
export function eventStrokeToKeys(stroke: EventStroke, platform: Platform): string {
  const modPressed = platform === "mac" ? stroke.meta : stroke.ctrl;
  const binding: BindingStroke = {
    key: stroke.key,
    mod: modPressed,
    ctrl: platform === "mac" ? stroke.ctrl : false,
    alt: stroke.alt,
    shift: stroke.shift,
    meta: platform === "mac" ? false : stroke.meta,
  };
  return strokeToString(binding);
}

export function detectPlatform(): Platform {
  const nav: { platform?: string; userAgent?: string } | undefined =
    typeof navigator === "undefined" ? undefined : navigator;
  if (nav === undefined) return "other";
  const source = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(source) ? "mac" : "other";
}
