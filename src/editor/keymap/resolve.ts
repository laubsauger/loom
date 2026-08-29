import type { BindingStroke } from "./keys.ts";
import { formatKeys, normalizeKeys, parseKeys } from "./keys.ts";
import type { KeyBinding, KeyContext, Keymap, Platform } from "./types.ts";
import { CONTEXT_RANK } from "./types.ts";
import { isKnownGuard } from "./when.ts";

/**
 * Layering, conflict detection and lookup (T76, T78).
 *
 * §V54: the user's overrides layer over the defaults; a conflict is DETECTED and
 * SURFACED rather than silently resolved by table order. Two bindings on the same keys
 * in the same context is an error — dispatch has to break the tie by position, which is
 * exactly the "silent shadow" the invariant forbids. A `global` binding shadowed by a
 * pane binding on the same keys is deterministic (narrowest wins, §V53) but still worth
 * showing, so it is reported as a warning.
 */

export interface ResolvedBinding extends KeyBinding {
  /** Effective keys after the override layer. `null` = explicitly unbound. */
  keys: string;
  effectiveKeys: string | null;
  sequence: readonly BindingStroke[];
  /** Platform-correct display string, `null` when unbound (§V55). */
  display: string | null;
  source: "default" | "override";
  /** The default this binding started from, for per-binding reset (§V54). */
  defaultKeys: string;
  isBound: boolean;
}

export type KeymapConflictKind = "duplicate" | "prefix";

export interface KeymapConflict {
  kind: KeymapConflictKind;
  severity: "error" | "warning";
  keys: string;
  display: string;
  /** Every binding taking part — a conflict is never reported one-sided. */
  bindings: readonly ResolvedBinding[];
  message: string;
}

export interface KeymapProblem {
  code: "unknown-binding" | "invalid-keys" | "unknown-guard";
  bindingId: string;
  message: string;
}

export interface ResolvedKeymap {
  platform: Platform;
  /** Every binding, bound or not, in table order. */
  bindings: readonly ResolvedBinding[];
  /** Bindings with keys, ready to match. */
  active: readonly ResolvedBinding[];
  byId: ReadonlyMap<string, ResolvedBinding>;
  byCommand: ReadonlyMap<string, readonly ResolvedBinding[]>;
  conflicts: readonly KeymapConflict[];
  conflictingIds: ReadonlySet<string>;
  problems: readonly KeymapProblem[];
}

/**
 * `global` sits under every pane, so a same-key binding there is reachable from the
 * same keystroke; sibling panes are never active at once and cannot collide.
 */
export function contextsOverlap(a: KeyContext, b: KeyContext): boolean {
  return a === b || a === "global" || b === "global";
}

function isPrefixOf(shorter: readonly BindingStroke[], longer: readonly BindingStroke[]): boolean {
  if (shorter.length >= longer.length) return false;
  for (let index = 0; index < shorter.length; index += 1) {
    const a = shorter[index];
    const b = longer[index];
    if (a === undefined || b === undefined) return false;
    if (
      a.key !== b.key ||
      a.mod !== b.mod ||
      a.ctrl !== b.ctrl ||
      a.alt !== b.alt ||
      a.shift !== b.shift ||
      a.meta !== b.meta
    ) {
      return false;
    }
  }
  return true;
}

function detectConflicts(active: readonly ResolvedBinding[], platform: Platform): KeymapConflict[] {
  const conflicts: KeymapConflict[] = [];

  const groups = new Map<string, ResolvedBinding[]>();
  for (const binding of active) {
    const keys = binding.effectiveKeys;
    if (keys === null) continue;
    const bucket = groups.get(keys);
    if (bucket === undefined) groups.set(keys, [binding]);
    else bucket.push(binding);
  }

  for (const [keys, bucket] of groups) {
    if (bucket.length < 2) continue;
    const participants: ResolvedBinding[] = [];
    let sameContext = false;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a === undefined || b === undefined) continue;
        if (!contextsOverlap(a.context, b.context)) continue;
        if (a.context === b.context) sameContext = true;
        if (!participants.includes(a)) participants.push(a);
        if (!participants.includes(b)) participants.push(b);
      }
    }
    if (participants.length === 0) continue;
    const display = formatKeys(keys, platform) ?? keys;
    conflicts.push({
      kind: "duplicate",
      severity: sameContext ? "error" : "warning",
      keys,
      display,
      bindings: participants,
      message: sameContext
        ? `${display} is bound to ${participants.length} commands in the same context — only one can fire.`
        : `${display} is bound in more than one context; the narrowest context wins.`,
    });
  }

  // A chord whose first stroke is itself a binding can never complete: the shorter
  // binding fires first. Report it rather than letting the chord look broken.
  for (const shorter of active) {
    for (const longer of active) {
      if (shorter === longer) continue;
      if (!isPrefixOf(shorter.sequence, longer.sequence)) continue;
      if (!contextsOverlap(shorter.context, longer.context)) continue;
      const display = shorter.display ?? shorter.effectiveKeys ?? shorter.keys;
      conflicts.push({
        kind: "prefix",
        severity: "error",
        keys: shorter.effectiveKeys ?? shorter.keys,
        display,
        bindings: [shorter, longer],
        message: `${display} fires immediately, so the chord ${
          longer.display ?? longer.keys
        } can never complete.`,
      });
    }
  }

  return conflicts;
}

/** Applies the override layer to the defaults and reports what is wrong with the result. */
export function resolveKeymap(keymap: Keymap, platform: Platform): ResolvedKeymap {
  const problems: KeymapProblem[] = [];
  const bindings: ResolvedBinding[] = [];
  const knownIds = new Set(keymap.defaults.map((binding) => binding.id));

  for (const id of Object.keys(keymap.overrides)) {
    if (!knownIds.has(id)) {
      problems.push({
        code: "unknown-binding",
        bindingId: id,
        message: `Override for "${id}" does not match any binding; it may belong to a feature that is not loaded.`,
      });
    }
  }

  for (const binding of keymap.defaults) {
    if (!isKnownGuard(binding.when)) {
      problems.push({
        code: "unknown-guard",
        bindingId: binding.id,
        message: `Binding "${binding.id}" uses an unknown guard "${binding.when ?? ""}"; it will never fire.`,
      });
    }

    const defaultKeys = normalizeKeys(binding.keys) ?? binding.keys;
    const override = Object.prototype.hasOwnProperty.call(keymap.overrides, binding.id)
      ? keymap.overrides[binding.id]
      : undefined;

    let effectiveKeys: string | null = defaultKeys;
    let source: "default" | "override" = "default";

    if (override === null) {
      effectiveKeys = null;
      source = "override";
    } else if (typeof override === "string") {
      const normalized = normalizeKeys(override);
      if (normalized === null) {
        problems.push({
          code: "invalid-keys",
          bindingId: binding.id,
          message: `Override "${override}" for "${binding.id}" is not a valid key string; the default is used.`,
        });
      } else {
        effectiveKeys = normalized;
        source = normalized === defaultKeys ? "default" : "override";
      }
    }

    const sequence = effectiveKeys === null ? [] : (parseKeys(effectiveKeys) ?? []);
    bindings.push({
      ...binding,
      keys: effectiveKeys ?? defaultKeys,
      effectiveKeys,
      sequence,
      display: effectiveKeys === null ? null : formatKeys(effectiveKeys, platform),
      source,
      defaultKeys,
      isBound: effectiveKeys !== null && sequence.length > 0,
    });
  }

  const active = bindings.filter((binding) => binding.isBound);
  const byId = new Map<string, ResolvedBinding>();
  const byCommand = new Map<string, ResolvedBinding[]>();
  for (const binding of bindings) {
    byId.set(binding.id, binding);
    const bucket = byCommand.get(binding.command);
    if (bucket === undefined) byCommand.set(binding.command, [binding]);
    else bucket.push(binding);
  }

  const conflicts = detectConflicts(active, platform);
  const conflictingIds = new Set<string>();
  for (const conflict of conflicts) {
    for (const binding of conflict.bindings) conflictingIds.add(binding.id);
  }

  return {
    platform,
    bindings,
    active,
    byId,
    byCommand,
    conflicts,
    conflictingIds,
    problems,
  };
}

/* ------------------------------------------------------------ lookup API (§V55) */

/**
 * The display string for a command, for a menu item or tooltip. Menus must ask the
 * keymap rather than hardcoding "⌘Z" — a rebind has to be visible everywhere (§V55).
 */
export function displayForCommand(resolved: ResolvedKeymap, command: string): string | null {
  const bindings = resolved.byCommand.get(command);
  if (bindings === undefined) return null;
  for (const binding of bindings) {
    if (binding.display !== null) return binding.display;
  }
  return null;
}

export function displayForBinding(resolved: ResolvedKeymap, bindingId: string): string | null {
  return resolved.byId.get(bindingId)?.display ?? null;
}

export function bindingsForCommand(
  resolved: ResolvedKeymap,
  command: string,
): readonly ResolvedBinding[] {
  return resolved.byCommand.get(command) ?? [];
}

/** Narrowest context first; ties broken by table order, which is stable. */
export function compareByContextSpecificity(a: ResolvedBinding, b: ResolvedBinding): number {
  return CONTEXT_RANK[b.context] - CONTEXT_RANK[a.context];
}
