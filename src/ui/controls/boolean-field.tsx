import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cx } from "../cx.ts";
import type { ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * Boolean parameter (T37). A native `<button role="switch">`: focusable, activated by
 * Enter and Space, and announced with its state, all without extra work (§V19).
 *
 * A toggle is a single edit, so it only ever reports `"commit"` — there is no
 * intermediate state to coalesce.
 */
export interface BooleanFieldProps {
  label: string;
  value: boolean;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
  onChange: ValueListener<boolean>;
}

export function BooleanField({
  label,
  value,
  disabled = false,
  id,
  describedBy,
  onChange,
}: BooleanFieldProps) {
  // §V20: the press belongs to the control, not to the node or the canvas under it.
  const stop = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <button
      type="button"
      role="switch"
      className={cx(styles.switch, "nodrag")}
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      {...(id === undefined ? {} : { id })}
      {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      onPointerDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!value, "commit");
      }}
    >
      <span className={styles.switchDot} aria-hidden />
      <span aria-hidden>{value ? "on" : "off"}</span>
    </button>
  );
}
