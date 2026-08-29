import { cx } from "../cx.ts";
import type { ValueListener } from "./types.ts";
import styles from "./controls.module.css";

export interface EnumOption {
  value: string;
  label: string;
  /** Rendered but not selectable — used for a format the device cannot provide (§V12). */
  disabled?: boolean;
}

/**
 * Enum parameter, and the workhorse of the Common section's mode pickers (T73).
 *
 * A native `<select>`: it is keyboard-operable, screen-reader-announced and
 * platform-correct on every OS for free (§V19). Radix ships no Select in this project's
 * dependency set, and a hand-rolled listbox would trade all of that for styling that a
 * restyled native select already gets.
 */
export interface EnumFieldProps {
  label: string;
  value: string;
  options: readonly EnumOption[];
  disabled?: boolean;
  id?: string;
  describedBy?: string;
  onChange: ValueListener<string>;
}

export function EnumField({
  label,
  value,
  options,
  disabled = false,
  id,
  describedBy,
  onChange,
}: EnumFieldProps) {
  // The stored value may not be in the option list (older project, narrowed enum).
  // Show it rather than silently snapping the document to another option.
  const known = options.some((option) => option.value === value);

  return (
    <select
      className={cx(styles.select, "nodrag")}
      value={value}
      aria-label={label}
      disabled={disabled}
      {...(id === undefined ? {} : { id })}
      {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => onChange(event.target.value, "commit")}
    >
      {known ? null : (
        <option value={value}>{value === "" ? "(unset)" : `${value} (unknown)`}</option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled === true}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
