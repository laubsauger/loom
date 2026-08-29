import type { ComponentProps } from "react";
import { cx } from "../../ui/cx.ts";
import { useBindingKeyDisplay, useCommandKeyDisplay } from "./keymap-provider.tsx";
import styles from "./key-hint.module.css";

/**
 * The shortcut chip for menus, tooltips and pane headers (§V55).
 *
 * A menu never hardcodes "⌘Z": it renders `<KeyHint command="graph.undo" />` and the
 * keymap answers, so a rebind shows up everywhere at once and an unbound command shows
 * nothing at all.
 */

interface KeyHintBaseProps extends Omit<ComponentProps<"kbd">, "children"> {
  /** Rendered when the command has no binding. Defaults to nothing. */
  fallback?: string | null;
}

export type KeyHintProps = KeyHintBaseProps &
  ({ command: string; bindingId?: undefined } | { bindingId: string; command?: undefined });

export function KeyHint({ command, bindingId, fallback = null, className, ...rest }: KeyHintProps) {
  const byCommand = useCommandKeyDisplay(command ?? "");
  const byBinding = useBindingKeyDisplay(bindingId ?? "");
  const display = (bindingId === undefined ? byCommand : byBinding) ?? fallback;
  if (display === null || display === "") return null;
  return (
    <kbd className={cx(styles.hint, className)} {...rest}>
      {display}
    </kbd>
  );
}

export interface KeyChipProps extends Omit<ComponentProps<"kbd">, "children"> {
  /** Already-formatted display string, e.g. from `formatKeys`. */
  display: string | null;
  unbound?: boolean;
}

/** Presentational chip for a display string the caller already has (settings, palette). */
export function KeyChip({ display, unbound = false, className, ...rest }: KeyChipProps) {
  if (display === null || display === "") {
    return unbound ? (
      <span className={cx(styles.unbound, className)}>Unbound</span>
    ) : null;
  }
  return (
    <kbd className={cx(styles.hint, className)} {...rest}>
      {display}
    </kbd>
  );
}
