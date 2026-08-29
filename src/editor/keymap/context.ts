import type { KeyContext } from "./types.ts";
import { KEY_CONTEXTS } from "./types.ts";

/**
 * Which contexts a key event lands in (§V53).
 *
 * The `text` context is derived from the event target, not from a component remembering
 * to declare it. That is the structural half of the invariant: an `<input>`, a
 * `<textarea>` or a contenteditable having focus puts you in `text` whether or not the
 * pane that owns it ever thought about the keymap. The classic node-editor bug — ⌘Z in
 * the shader editor undoing a graph edit — cannot be reintroduced by forgetting a prop.
 */

export const KEYMAP_CONTEXT_ATTRIBUTE = "data-keymap-context";

/** Input types that are text-like. A checkbox or a range slider is not a text field. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

interface TargetLike {
  tagName?: unknown;
  type?: unknown;
  isContentEditable?: unknown;
  readOnly?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => Element | null;
}

function asTarget(value: unknown): TargetLike | null {
  if (typeof value !== "object" || value === null) return null;
  return value as TargetLike;
}

/** Duck-typed so the engine core stays testable without a DOM. */
export function isTextEntryTarget(value: unknown): boolean {
  const target = asTarget(value);
  if (target === null) return false;

  if (target.isContentEditable === true) return true;

  const tagName = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (tagName === "TEXTAREA") return true;
  if (tagName === "INPUT") {
    if (target.readOnly === true) return false;
    const type = typeof target.type === "string" ? target.type.toLowerCase() : "text";
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  if (typeof target.getAttribute === "function") {
    if (target.getAttribute("role") === "textbox") return true;
    if (target.getAttribute(KEYMAP_CONTEXT_ATTRIBUTE) === "text") return true;
    if (target.getAttribute("contenteditable") === "true") return true;
  }
  return false;
}

function isKeyContext(value: string | null): value is KeyContext {
  return value !== null && (KEY_CONTEXTS as readonly string[]).includes(value);
}

/** Nearest ancestor pane context, from `data-keymap-context`. */
export function paneContextFromTarget(value: unknown): KeyContext | null {
  const target = asTarget(value);
  if (target === null) return null;
  if (typeof target.closest === "function") {
    const element = target.closest(`[${KEYMAP_CONTEXT_ATTRIBUTE}]`);
    const declared = element?.getAttribute(KEYMAP_CONTEXT_ATTRIBUTE) ?? null;
    if (isKeyContext(declared)) return declared;
    return null;
  }
  if (typeof target.getAttribute === "function") {
    const declared = target.getAttribute(KEYMAP_CONTEXT_ATTRIBUTE);
    if (isKeyContext(declared)) return declared;
  }
  return null;
}

/**
 * Active contexts for an event, narrowest first. `global` is always last: it is the
 * fallback every binding table bottoms out in.
 */
export function activeContextsFor(target: unknown, fallback: KeyContext): KeyContext[] {
  const contexts: KeyContext[] = [];
  if (isTextEntryTarget(target)) contexts.push("text");
  const pane = paneContextFromTarget(target) ?? fallback;
  if (pane !== "global" && !contexts.includes(pane)) contexts.push(pane);
  contexts.push("global");
  return contexts;
}
