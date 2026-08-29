import type { BindingInputSource, KeyBinding, KeymapEnvironment } from "./types.ts";

/**
 * `when` guards and selection-resolved command input (T77).
 *
 * Guards are named, not expressions: a binding stays serializable data, and the set of
 * things a hotkey can depend on stays enumerable and testable. An unknown guard name is
 * a keymap authoring error — it evaluates to `false` (the binding never fires) and is
 * reported by `resolveKeymap` rather than silently ignored.
 */

export type GuardName = "always" | "hasSelection" | "hasSingleSelection" | "nodeHovered";

const GUARDS: Record<GuardName, (environment: KeymapEnvironment) => boolean> = {
  always: () => true,
  hasSelection: (environment) => environment.selection.length > 0,
  hasSingleSelection: (environment) => environment.selection.length === 1,
  nodeHovered: (environment) => environment.hoveredNodeId !== null,
};

export const GUARD_NAMES: readonly GuardName[] = Object.keys(GUARDS) as GuardName[];

export function isGuardName(name: string): name is GuardName {
  return Object.prototype.hasOwnProperty.call(GUARDS, name);
}

/** `"hasSelection"` or the negated `"!hasSelection"`. Unknown guard → `false`. */
export function evaluateGuard(when: string | undefined, environment: KeymapEnvironment): boolean {
  if (when === undefined) return true;
  const trimmed = when.trim();
  const negated = trimmed.startsWith("!");
  const name = negated ? trimmed.slice(1).trim() : trimmed;
  if (!isGuardName(name)) return false;
  const value = GUARDS[name](environment);
  return negated ? !value : value;
}

/** `when` names a guard this module knows about. Used by keymap validation. */
export function isKnownGuard(when: string | undefined): boolean {
  if (when === undefined) return true;
  const trimmed = when.trim();
  return isGuardName(trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed);
}

export type InputResolution =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; reason: string };

function resolveSource(
  source: BindingInputSource,
  environment: KeymapEnvironment,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (source.from) {
    case "selection": {
      if (environment.selection.length === 0) return { ok: false, reason: "no selection" };
      return { ok: true, value: [...environment.selection] };
    }
    case "hoveredNode": {
      if (environment.hoveredNodeId === null) return { ok: false, reason: "no hovered node" };
      return { ok: true, value: environment.hoveredNodeId };
    }
    case "selectionOrHovered": {
      if (environment.selection.length > 0) return { ok: true, value: [...environment.selection] };
      if (environment.hoveredNodeId !== null) return { ok: true, value: [environment.hoveredNodeId] };
      return { ok: false, reason: "no selection or hovered node" };
    }
    default: {
      return { ok: false, reason: "unknown input source" };
    }
  }
}

/**
 * Builds the command input for a binding: static `input` merged with whatever the
 * binding resolves from the current selection/hover. A source that resolves to nothing
 * blocks the dispatch instead of sending a half-formed command to the bus.
 */
export function resolveBindingInput(
  binding: Pick<KeyBinding, "input" | "inputFrom">,
  environment: KeymapEnvironment,
): InputResolution {
  const base: Record<string, unknown> = { ...(binding.input ?? {}) };
  if (binding.inputFrom === undefined) return { ok: true, input: base };
  const resolved = resolveSource(binding.inputFrom, environment);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  base[binding.inputFrom.as] = resolved.value;
  return { ok: true, input: base };
}
