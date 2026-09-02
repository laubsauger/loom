import { useEffect, useRef } from "react";
import { cx } from "../cx.ts";
import { fromDisplay, toHex, type ColorSpace, type Rgba } from "./color.ts";
import type { EditPhase, ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * The colour picker (T896). ONE control, mounted at every site where a colour is
 * edited — the inspector's colour rows, T880's reflected `vec4f` knobs (both are
 * `ColorField`) and the ramp stop editor (`StopsField`).
 *
 * The owner asked for "an actual color picker in addition to the RGBA fields". It is
 * an ADDITION: the numeric channels stay, because they are the only way to type an
 * exact value, they are the only place an HDR channel above 1 can be entered, and —
 * §V113 — they are the only per-channel seat, since `color.r` carries its own mode.
 *
 * ## Display space, not linear (§V618)
 *
 * A picker's whole job is to show the colour the user will see. An `<input
 * type="color">` speaks sRGB hex, which IS display space, so the conversion is the one
 * `color.ts` already performs for the swatch and the hex field: `toHex` out,
 * `fromDisplay` in, keyed off the parameter's declared space. A linear-space picker
 * would read about 1.5 stops dark — the reason E46 was called "pastel" — and matching
 * T880's convention (the parameter declares its space; `color.ts` is the only module
 * that converts) is why there is no second convention here.
 *
 * ## §V113: the picker writes ALL FOUR CHANNELS, so it is unavailable when any one of
 * them is not static
 *
 * A colour's channels each carry their own mode. A picker emits one RGB triple — it
 * cannot write `.r` while leaving `.g`'s expression alone, and writing anyway would
 * silently clobber that expression the moment the user reached for the swatch. So the
 * picker goes unavailable, and says why: the reason is on the wrapper's `title` (a
 * disabled input does not surface its own tooltip) and in the accessible name, which
 * is how the kit carries every explanation (§V90 — help on demand, not ambient).
 *
 * Alpha is untouched: the native picker has no alpha channel, so the current one is
 * preserved rather than being reset to opaque behind the user's back. The A field
 * beside it is where alpha is edited.
 */

/**
 * Stated once, so the tooltip, the accessible name and the test all read the same words.
 * Terse on purpose (§V92): chrome states the fact, it does not explain it in a sentence.
 */
export const PICKER_LOCKED_REASON = "not Constant — the picker writes all 4 channels";

export interface ColorPickerProps {
  label: string;
  /** The stored value, in `space`. */
  value: Rgba;
  /** The space the stored value lives in; the picker always presents display. */
  space: ColorSpace;
  disabled?: boolean;
  /** Per-channel availability (§V113): `true` means that channel is not static. */
  componentDisabled?: readonly boolean[];
  onChange: ValueListener<Rgba>;
}

export function ColorPicker({
  label,
  value,
  space,
  disabled = false,
  componentDisabled,
  onChange,
}: ColorPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const locked = componentDisabled?.some((channel) => channel) === true;
  const unavailable = disabled || locked;

  const hex = toHex(value, space);

  /**
   * The write, in one place so the §V113 refusal cannot be reached around: even if a
   * disabled input were made to fire, a locked colour emits nothing.
   */
  const emit = (nextHex: string, phase: EditPhase): void => {
    if (unavailable) return;
    const channel = (offset: number): number =>
      Number.parseInt(nextHex.slice(offset, offset + 2), 16) / 255;
    if (!/^#[0-9a-fA-F]{6}$/.test(nextHex)) return;
    onChange(fromDisplay([channel(1), channel(3), channel(5), value[3]], space), phase);
  };

  /**
   * Native listeners, deliberately, and this is the reason: React collapses `input` and
   * `change` into ONE synthetic `onChange` and SWALLOWS the trailing `change` when the
   * value has not moved since the last `input`. The OS colour panel streams `input`
   * while the user drags and fires `change` when they settle — so through React the
   * commit that ends the gesture would never arrive, and §V15's one-undo-entry-per-
   * gesture would degrade to either no commit at all or one per wheel pixel.
   */
  const latest = useRef(emit);
  latest.current = emit;
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    const live = (): void => latest.current(element.value, "live");
    const commit = (): void => latest.current(element.value, "commit");
    element.addEventListener("input", live);
    element.addEventListener("change", commit);
    return () => {
      element.removeEventListener("input", live);
      element.removeEventListener("change", commit);
    };
  }, []);

  return (
    <span
      className={styles.pickerWrap}
      title={unavailable ? PICKER_LOCKED_REASON : "Pick a colour"}
    >
      <input
        ref={input}
        type="color"
        className={cx(styles.picker, "nodrag")}
        value={hex}
        disabled={unavailable}
        aria-label={unavailable ? `${label} picker — ${PICKER_LOCKED_REASON}` : `${label} picker`}
        // The listeners above are the real ones; React needs a handler to accept `value`.
        onChange={() => undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </span>
  );
}
