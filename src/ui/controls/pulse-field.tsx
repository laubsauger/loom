import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cx } from "../cx.ts";
import styles from "./controls.module.css";

/**
 * Pulse parameter (T214, §V123, §V125). TouchDesigner's momentary trigger.
 *
 * It is deliberately NOT a `ValueListener` control. Every other field in this kit reports
 * a value and the editor writes it to the document; a pulse writes nothing — it fires a
 * bus command, and the document never learns that it happened (§V124). Giving it the
 * same `onChange` signature as the others would have made "a pulse is just a boolean"
 * true at the type level, and the first person to store one would have found out from a
 * project that reset itself on every open.
 *
 * Shaped like `BooleanField` on purpose: a dot and a short caption, same size, same
 * keyboard behaviour. The two live next to each other on Feedback (a hold toggle and a
 * momentary fire, as TD pairs them) and reading as one family is what makes the
 * difference between them legible.
 *
 * The flash is the whole feedback. A pulse that fires and looks identical afterwards
 * gives the user no way to know the click landed, and the thing it cleared is often
 * offscreen — so the dot lights for a moment. It is state, not decoration, and it honours
 * `prefers-reduced-motion` through the token that drives its transition (§V19).
 */

export interface PulseFieldProps {
  label: string;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
  /** Fire. Called once per activation; there is no value and no phase. */
  onFire: () => void;
}

/** How long the dot stays lit after a fire. Long enough to see, short enough to repeat. */
const FLASH_MS = 180;

export function PulseField({ label, disabled = false, id, describedBy, onFire }: PulseFieldProps) {
  const [firing, setFiring] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The timeout outlives a fast unmount otherwise, and setting state on an unmounted
  // component is the kind of warning that trains people to ignore warnings.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // §V20: the press belongs to the control, not to the node or the canvas under it.
  const stop = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  return (
    <button
      type="button"
      className={cx(styles.pulse, firing && styles.pulseFiring, "nodrag")}
      // "Fire X", not "X": the row's NAME is already a button (it discloses the mode
      // panel), so a pulse announcing the bare label would give a screen reader two
      // controls with one name and no way to tell which one triggers anything.
      aria-label={`Fire ${label}`}
      disabled={disabled}
      data-firing={firing ? true : undefined}
      {...(id === undefined ? {} : { id })}
      {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
      onPointerDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        if (timer.current !== null) clearTimeout(timer.current);
        setFiring(true);
        timer.current = setTimeout(() => setFiring(false), FLASH_MS);
        onFire();
      }}
    >
      <span className={styles.pulseDot} aria-hidden />
      <span aria-hidden>fire</span>
    </button>
  );
}
