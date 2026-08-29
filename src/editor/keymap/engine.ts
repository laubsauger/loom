import type {
  CommandInput,
  CommandName,
  CommandResult,
  InvocationContext,
} from "../../domain/types/commands.ts";
import type { ShaderloomBus } from "../../domain/commands/bus.ts";
import { activeContextsFor } from "./context.ts";
import { isEditingStroke } from "./editing-keys.ts";
import type { EventStroke, KeyEventLike } from "./keys.ts";
import {
  detectPlatform,
  formatEventStrokes,
  isModifierKeyName,
  sequenceMatchesPrefix,
  strokeFromEvent,
} from "./keys.ts";
import type { ResolvedBinding, ResolvedKeymap } from "./resolve.ts";
import { compareByContextSpecificity } from "./resolve.ts";
import type { KeyContext, KeymapEnvironment, Platform } from "./types.ts";
import { EMPTY_ENVIRONMENT } from "./types.ts";
import { evaluateGuard, resolveBindingInput } from "./when.ts";

/**
 * The keymap engine (T76): resolve a key event to one binding, then hand it to the bus.
 *
 * This file contains the only key-to-command decision in the product. Nothing here
 * knows what any command does — it looks a name up in the binding table and calls
 * `bus.execute` (§V29, §V52). A binding naming a command no track has registered yet is
 * reported `unresolved`; it never throws and it never gets stubbed onto the bus.
 */

export const DEFAULT_CHORD_TIMEOUT_MS = 1200;

export type KeymapDispatch =
  /** No usable key, or nothing matched. */
  | { status: "ignored"; consumed: false }
  /** A bare modifier press: never starts, breaks or cancels anything. */
  | { status: "modifier"; consumed: false }
  /** First stroke(s) of a chord; waiting for the rest. */
  | { status: "pending"; consumed: true; sequence: string }
  /** A text field owns this keystroke (§V53). Not dispatched, not preventDefault-ed. */
  | { status: "swallowed"; consumed: false; context: KeyContext; keys: string }
  /** Keys matched, but the `when` guard or the selection-resolved input said no. */
  | { status: "blocked"; consumed: false; bindingId: string; reason: "when" | "input" }
  /**
   * Keys matched a binding whose command no track has registered yet. Reported, never
   * thrown — and deliberately NOT consumed: nothing ran, so swallowing the key would
   * only take native behavior away for no benefit.
   */
  | { status: "unresolved"; consumed: false; bindingId: string; command: string }
  | {
      status: "dispatched";
      consumed: true;
      bindingId: string;
      command: string;
      input: Record<string, unknown>;
      run: Promise<CommandResult<CommandName> | null>;
    };

export interface KeymapEngineOptions {
  bus: ShaderloomBus;
  getResolved: () => ResolvedKeymap;
  getEnvironment?: () => KeymapEnvironment;
  getInvocationContext: () => InvocationContext;
  platform?: Platform;
  chordTimeoutMs?: number;
  /** Injectable clock so chord timeout is testable without timers. */
  now?: () => number;
  onDispatch?: (dispatch: KeymapDispatch) => void;
  onPendingChange?: (pending: string) => void;
  onError?: (error: unknown, binding: ResolvedBinding) => void;
}

export interface KeymapEngine {
  readonly platform: Platform;
  handleKey(event: KeyEventLike, options?: { context?: KeyContext }): KeymapDispatch;
  /** Display string for the chord being entered, "" when none. */
  pending(): string;
  reset(): void;
}

interface MatchResult {
  exact: ResolvedBinding[];
  prefixes: ResolvedBinding[];
  blocked: { binding: ResolvedBinding; reason: "when" | "input" }[];
}

export function createKeymapEngine(options: KeymapEngineOptions): KeymapEngine {
  const platform = options.platform ?? detectPlatform();
  const chordTimeoutMs = options.chordTimeoutMs ?? DEFAULT_CHORD_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const getEnvironment = options.getEnvironment ?? (() => EMPTY_ENVIRONMENT);

  let pendingStrokes: EventStroke[] = [];
  let pendingAt = 0;

  function setPending(strokes: EventStroke[]): void {
    const before = formatEventStrokes(pendingStrokes, platform);
    pendingStrokes = strokes;
    pendingAt = strokes.length === 0 ? 0 : now();
    const after = formatEventStrokes(pendingStrokes, platform);
    if (before !== after) options.onPendingChange?.(after);
  }

  function match(
    sequence: readonly EventStroke[],
    contexts: readonly KeyContext[],
    environment: KeymapEnvironment,
  ): MatchResult {
    const result: MatchResult = { exact: [], prefixes: [], blocked: [] };
    for (const binding of options.getResolved().active) {
      if (!contexts.includes(binding.context)) continue;
      if (!sequenceMatchesPrefix(binding.sequence, sequence, platform)) continue;

      if (binding.sequence.length > sequence.length) {
        result.prefixes.push(binding);
        continue;
      }
      if (!evaluateGuard(binding.when, environment)) {
        result.blocked.push({ binding, reason: "when" });
        continue;
      }
      if (!resolveBindingInput(binding, environment).ok) {
        result.blocked.push({ binding, reason: "input" });
        continue;
      }
      result.exact.push(binding);
    }
    result.exact.sort(compareByContextSpecificity);
    return result;
  }

  function dispatch(binding: ResolvedBinding, environment: KeymapEnvironment): KeymapDispatch {
    // A binding may name a command a later track registers (play/pause, save, group,
    // fit…). Report it; do not throw, do not invent a stub (§T77).
    if (!options.bus.hasCommand(binding.command)) {
      return {
        status: "unresolved",
        consumed: false,
        bindingId: binding.id,
        command: binding.command,
      };
    }
    const resolvedInput = resolveBindingInput(binding, environment);
    if (!resolvedInput.ok) {
      return { status: "blocked", consumed: false, bindingId: binding.id, reason: "input" };
    }
    const run = Promise.resolve()
      .then(() =>
        options.bus.execute(
          binding.command as CommandName,
          resolvedInput.input as CommandInput<CommandName>,
          options.getInvocationContext(),
        ),
      )
      .catch((error: unknown) => {
        options.onError?.(error, binding);
        return null;
      });

    return {
      status: "dispatched",
      consumed: true,
      bindingId: binding.id,
      command: binding.command,
      input: resolvedInput.input,
      run,
    };
  }

  function report(result: KeymapDispatch): KeymapDispatch {
    options.onDispatch?.(result);
    return result;
  }

  return {
    platform,

    pending: () => formatEventStrokes(pendingStrokes, platform),

    reset: () => {
      setPending([]);
    },

    handleKey(event, handleOptions): KeymapDispatch {
      const stroke = strokeFromEvent(event);
      if (stroke === null) return report({ status: "ignored", consumed: false });
      if (isModifierKeyName(stroke.key)) return report({ status: "modifier", consumed: false });

      const environment = getEnvironment();
      // An explicit context is the fallback pane, not an override: text detection from
      // the event target still applies on top of it (§V53).
      const contexts = activeContextsFor(event.target, handleOptions?.context ?? environment.context);

      // An abandoned chord expires rather than lingering until the next unrelated key.
      if (pendingStrokes.length > 0 && now() - pendingAt > chordTimeoutMs) setPending([]);

      const sequence = [...pendingStrokes, stroke];

      // §V53 — the text context swallows editing keys. Checked before matching so a
      // graph binding can never win by being narrower in some other dimension, and so
      // a chord cannot even start while the user is typing.
      if (contexts.includes("text") && isEditingStroke(stroke, platform)) {
        const claimed = options
          .getResolved()
          .active.some(
            (binding) =>
              binding.context === "text" && sequenceMatchesPrefix(binding.sequence, sequence, platform),
          );
        if (!claimed) {
          setPending([]);
          return report({
            status: "swallowed",
            consumed: false,
            context: "text",
            keys: formatEventStrokes([stroke], platform),
          });
        }
      }

      const attempt = match(sequence, contexts, environment);
      const winner = attempt.exact[0];
      if (winner !== undefined) {
        setPending([]);
        return report(dispatch(winner, environment));
      }
      if (attempt.prefixes.length > 0) {
        setPending(sequence);
        return report({
          status: "pending",
          consumed: true,
          sequence: formatEventStrokes(sequence, platform),
        });
      }

      // The chord failed. Do not swallow the key that broke it — re-try it as the
      // first stroke of a fresh sequence, so an unrelated shortcut still fires.
      if (pendingStrokes.length > 0) {
        setPending([]);
        const retry = match([stroke], contexts, environment);
        const retryWinner = retry.exact[0];
        if (retryWinner !== undefined) return report(dispatch(retryWinner, environment));
        if (retry.prefixes.length > 0) {
          setPending([stroke]);
          return report({
            status: "pending",
            consumed: true,
            sequence: formatEventStrokes([stroke], platform),
          });
        }
        const retryBlocked = retry.blocked[0];
        if (retryBlocked !== undefined) {
          return report({
            status: "blocked",
            consumed: false,
            bindingId: retryBlocked.binding.id,
            reason: retryBlocked.reason,
          });
        }
        return report({ status: "ignored", consumed: false });
      }

      const blocked = attempt.blocked[0];
      if (blocked !== undefined) {
        return report({
          status: "blocked",
          consumed: false,
          bindingId: blocked.binding.id,
          reason: blocked.reason,
        });
      }
      return report({ status: "ignored", consumed: false });
    },
  };
}
