import { useState } from "react";
import type { ColorParameter } from "@domain/types/parameters.ts";
import { cx } from "../cx.ts";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "../primitives/popover.tsx";
import {
  COLOR_CHANNEL_LABELS,
  convertColor,
  cssColorFor,
  parseHex,
  toHex,
  toRgba,
  type ColorSpace,
  type Rgba,
} from "./color.ts";
import { NumberField } from "./number-field.tsx";
import type { EditPhase, NumericSpec, ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * Colour parameter (T37, doc §8.1: "Colour values support linear and display colour
 * representations").
 *
 * The stored value stays in the space the manifest declares (§I, doc §16.2). The
 * control offers a representation toggle: a linear parameter can be edited in display
 * numbers and vice versa, with the conversion applied on the way in and out. That is
 * the difference between "0.5 grey" meaning two different colours and the user being
 * able to say which one they meant.
 *
 * Swatch and hex show the display encoding always — a linear 0.5 rendered raw would
 * look like the wrong colour, which defeats the purpose of a swatch.
 */

const DISPLAY_CHANNEL_SPEC: NumericSpec = { min: 0, max: 1, step: 0.01, precision: 3 };
/** Linear channels are scene-referred: bounded below, open above for HDR values. */
const LINEAR_CHANNEL_SPEC: NumericSpec = { min: 0, step: 0.01, precision: 4 };
const ALPHA_SPEC: NumericSpec = { min: 0, max: 1, step: 0.01, precision: 3 };

export interface ColorFieldProps {
  label: string;
  value: readonly number[];
  definition: ColorParameter;
  disabled?: boolean;
  /**
   * Per-channel availability (§V113): `color.g` running an expression is not draggable,
   * because its own slot decides it and the swatch does not.
   */
  componentDisabled?: readonly boolean[];
  describedBy?: string;
  onChange: ValueListener<readonly number[]>;
}

export function ColorField({
  label,
  value,
  definition,
  disabled = false,
  componentDisabled,
  describedBy,
  onChange,
}: ColorFieldProps) {
  const stored = toRgba(value);
  const space: ColorSpace = definition.space;
  const [representation, setRepresentation] = useState<ColorSpace>(space);
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const shown = convertColor(stored, space, representation);
  const hex = toHex(stored, space);

  const emit = (next: Rgba, phase: EditPhase): void => {
    onChange([next[0], next[1], next[2], next[3]], phase);
  };

  const setChannel = (index: number, channel: number, phase: EditPhase): void => {
    const edited: Rgba = [
      index === 0 ? channel : shown[0],
      index === 1 ? channel : shown[1],
      index === 2 ? channel : shown[2],
      index === 3 ? channel : shown[3],
    ];
    emit(convertColor(edited, representation, space), phase);
  };

  const commitHex = (text: string): void => {
    const parsed = parseHex(text, space, stored[3]);
    setHexDraft(null);
    if (parsed !== null) emit(parsed, "commit");
  };

  const channelSpec = (index: number): NumericSpec => {
    if (index === 3) return ALPHA_SPEC;
    return representation === "linear" ? LINEAR_CHANNEL_SPEC : DISPLAY_CHANNEL_SPEC;
  };

  const defaults = convertColor(toRgba(definition.default), space, representation);

  return (
    <div className={styles.colorRow}>
      <PopoverRoot>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cx(styles.swatch, "nodrag")}
            aria-label={`${label} — edit channels`}
            disabled={disabled}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* The user's colour, not the theme's: the one CSS colour the kit computes. */}
            <span
              className={styles.swatchFill}
              style={{ background: cssColorFor(stored, space) }}
              aria-hidden
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <PopoverHeader>{label}</PopoverHeader>
          <div className={styles.colorPanel}>
            {COLOR_CHANNEL_LABELS.map((channelLabel, index) => (
              <div className={styles.axis} key={channelLabel}>
                <span className={styles.axisLabel} aria-hidden>
                  {channelLabel}
                </span>
                <NumberField
                  label={`${label} ${channelLabel}`}
                  value={shown[index] ?? 0}
                  defaultValue={defaults[index] ?? 0}
                  spec={channelSpec(index)}
                  disabled={disabled || componentDisabled?.[index] === true}
                  onChange={(next, phase) => setChannel(index, next, phase)}
                />
              </div>
            ))}
            <div className={styles.spaceToggle}>
              <span>editing in</span>
              <select
                className={cx(styles.select, "nodrag")}
                value={representation}
                aria-label={`${label} representation`}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) =>
                  setRepresentation(event.target.value === "linear" ? "linear" : "display")
                }
              >
                <option value="display">display (sRGB)</option>
                <option value="linear">linear</option>
              </select>
              <span>stored as {space}</span>
            </div>
          </div>
        </PopoverContent>
      </PopoverRoot>

      <input
        type="text"
        className={cx(styles.hex, "nodrag")}
        value={hexDraft ?? hex}
        disabled={disabled}
        aria-label={`${label} hex`}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commitHex(hexDraft ?? hex);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setHexDraft(null);
          }
        }}
        onChange={(event) => setHexDraft(event.target.value)}
        onBlur={() => {
          if (hexDraft !== null) commitHex(hexDraft);
        }}
      />
    </div>
  );
}
