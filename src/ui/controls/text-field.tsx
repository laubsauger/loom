import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "../cx.ts";
import type { ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * String parameter (T37).
 *
 * Text is committed on blur and on Enter, never per keystroke: a string parameter is
 * usually `compileTime` (a WGSL body, a channel name), and streaming every character
 * into the document would trigger a recompile per keypress — exactly what §V5 and the
 * recompile classifier exist to avoid. The multiline variant commits on blur only, so
 * Enter can insert a newline.
 */
export interface TextFieldProps {
  label: string;
  value: string;
  multiline?: boolean;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
  onChange: ValueListener<string>;
}

export function TextField({
  label,
  value,
  multiline = false,
  disabled = false,
  id,
  describedBy,
  onChange,
}: TextFieldProps) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);

  // An edit from elsewhere (undo, an agent patch) wins over an untouched draft.
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const commit = useCallback((): void => {
    dirty.current = false;
    if (draft !== value) onChange(draft, "commit");
  }, [draft, onChange, value]);

  const identity = {
    "aria-label": label,
    ...(id === undefined ? {} : { id }),
    ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
  };

  if (multiline) {
    return (
      <textarea
        className={cx(styles.text, styles.textarea, "nodrag")}
        value={draft}
        disabled={disabled}
        {...identity}
        onPointerDown={(event) => event.stopPropagation()}
        // §V53: a text area is a text context; editing keys stop here.
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
        }}
        onBlur={commit}
      />
    );
  }

  return (
    <input
      type="text"
      className={cx(styles.text, "nodrag")}
      value={draft}
      disabled={disabled}
      {...identity}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          dirty.current = false;
          setDraft(value);
        }
      }}
      onChange={(event) => {
        dirty.current = true;
        setDraft(event.target.value);
      }}
      onBlur={commit}
    />
  );
}
