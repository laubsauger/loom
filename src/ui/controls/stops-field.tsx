import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "../primitives/popover.tsx";
import { cx } from "../cx.ts";
import type { ColorStop, StopsParameter } from "@domain/types/parameters.ts";
import { COLOR_CHANNEL_LABELS, convertColor, cssColorFor, toRgba, type Rgba } from "./color.ts";
import { NumberField } from "./number-field.tsx";
import type { EditPhase, NumericSpec, ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * The stop editor (T270). TouchDesigner's Ramp key list.
 *
 * Two colours was the degenerate case, and the whole point of the type is that the list
 * is arbitrary — so the control is a LIST, with the four gestures a gradient needs: add,
 * remove, reorder and move. Every one of them reports the whole list exactly once, which
 * is what makes it ONE patch and one undo entry per gesture (§V114, §V15).
 *
 * ## Order is authored, not derived
 *
 * The array order IS the gradient's order: the shader walks consecutive pairs. Sorting by
 * position on every edit was the alternative, and it makes the up/down buttons meaningless
 * (a "move" that the next edit undoes) and makes dragging one stop past another silently
 * renumber the list under the user. TD keeps a key LIST for the same reason. A list whose
 * positions run backwards still renders deterministically — the segment collapses to a
 * hard edge — and the compiler says so.
 *
 * ## No text hints (§V90, §V92)
 *
 * The row is a swatch, a position and two ordering controls. What each does is carried by
 * its accessible name and its hover title, exactly as everywhere else in the kit; there is
 * no sentence under the list explaining that stops interpolate.
 */

const POSITION_SPEC: NumericSpec = { min: 0, max: 1, step: 0.01, precision: 3 };
const DISPLAY_CHANNEL_SPEC: NumericSpec = { min: 0, max: 1, step: 0.01, precision: 3 };
const LINEAR_CHANNEL_SPEC: NumericSpec = { min: 0, step: 0.01, precision: 4 };
const ALPHA_SPEC: NumericSpec = { min: 0, max: 1, step: 0.01, precision: 3 };

export interface StopsFieldProps {
  label: string;
  value: readonly ColorStop[];
  definition: StopsParameter;
  disabled?: boolean;
  describedBy?: string;
  onChange: ValueListener<readonly ColorStop[]>;
}

/** A defensive read: the document may disagree with the manifest (§V10). */
function toStops(value: readonly ColorStop[]): ColorStop[] {
  return value.map((stop) => ({
    position: typeof stop?.position === "number" && Number.isFinite(stop.position) ? stop.position : 0,
    color: toRgba(stop?.color),
  }));
}

/**
 * Where a NEW stop goes: halfway to the next one, carrying a blend of the two colours.
 *
 * Appending a black stop at 0 would be a worse default in every case — you add a stop to
 * subdivide a gradient you already like, so the useful new stop is the one that changes
 * nothing until you move it.
 */
function insertAfter(stops: readonly ColorStop[], index: number): ColorStop[] {
  const next = [...stops];
  const before = stops[index];
  const after = stops[index + 1];
  if (before === undefined) return [...next, { position: 0.5, color: [1, 1, 1, 1] }];
  const position = after === undefined ? Math.min(1, before.position + 0.25) : (before.position + after.position) / 2;
  const mix = (channel: number): number => {
    const a = before.color[channel] ?? 0;
    const b = after?.color[channel] ?? a;
    return (a + b) / 2;
  };
  next.splice(index + 1, 0, {
    position,
    color: [mix(0), mix(1), mix(2), mix(3)],
  });
  return next;
}

function move(stops: readonly ColorStop[], from: number, to: number): ColorStop[] {
  if (to < 0 || to >= stops.length) return [...stops];
  const next = [...stops];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...stops];
  next.splice(to, 0, moved);
  return next;
}

export function StopsField({
  label,
  value,
  definition,
  disabled = false,
  describedBy,
  onChange,
}: StopsFieldProps) {
  const stops = toStops(value);
  const space = definition.space;
  const max = definition.maxStops ?? Infinity;

  /** Every gesture is one call: one patch, one undo entry (§V114). */
  const emit = (next: readonly ColorStop[], phase: EditPhase = "commit"): void => onChange(next, phase);

  const withStop = (index: number, stop: ColorStop): ColorStop[] =>
    stops.map((current, at) => (at === index ? stop : current));

  const channelSpec = (channel: number): NumericSpec => {
    if (channel === 3) return ALPHA_SPEC;
    return space === "linear" ? LINEAR_CHANNEL_SPEC : DISPLAY_CHANNEL_SPEC;
  };

  return (
    <div className={styles.stops} role="group" aria-label={label} {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}>
      {/*
        The gradient strip is the readout: it is the one place the list's ORDER and its
        positions become a single legible fact, and it costs no extra row because it
        replaces the "N stops" caption a list would otherwise need.

        T499: the strip draws the ACTUAL gradient, not ticks on a dark ground — you could
        see where the stops were but not what the ramp looked like. CSS's own color-stop
        rule matches the shader's exactly: list order wins, and a position behind its
        predecessor clamps into a hard edge, which is precisely what the compiler says a
        backwards segment renders as. Ticks stay on top, because position and order are
        still the editable facts.
      */}
      <div
        className={styles.stopsBar}
        aria-hidden
        style={{
          // v17-allow-dynamic-color: the gradient IS the user's palette; no token can
          // supply it. A single stop paints flat, which is what a one-stop ramp is.
          background:
            stops.length === 0
              ? undefined
              : `linear-gradient(90deg, ${(stops.length === 1 ? [stops[0] as ColorStop, stops[0] as ColorStop] : stops)
                  .map(
                    (stop) =>
                      `${cssColorFor(stop.color, space)} ${Math.max(0, Math.min(1, stop.position)) * 100}%`,
                  )
                  .join(", ")})`,
        }}
      >
        {stops.map((stop, index) => (
          <span
            key={index}
            className={styles.stopsBarSwatch}
            style={{
              // v17-allow-dynamic-color: a stop renders the user's own colour value,
              // which no token can supply.
              background: cssColorFor(stop.color, space),
              left: `${Math.max(0, Math.min(1, stop.position)) * 100}%`,
            }}
          />
        ))}
      </div>

      <ol className={styles.stopsList}>
        {stops.map((stop, index) => (
          <li className={styles.stopRow} key={index}>
            <PopoverRoot>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cx(styles.swatch, "nodrag")}
                  aria-label={`${label} stop ${index + 1} colour`}
                  disabled={disabled}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <span
                    className={styles.swatchFill}
                    // v17-allow-dynamic-color: the user's colour, not the theme's.
                    style={{ background: cssColorFor(stop.color, space) }}
                    aria-hidden
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start">
                <PopoverHeader>{`${label} stop ${index + 1}`}</PopoverHeader>
                <div className={styles.colorPanel}>
                  {COLOR_CHANNEL_LABELS.map((channelLabel, channel) => (
                    <div className={styles.axis} key={channelLabel}>
                      <span className={styles.axisLabel} aria-hidden>
                        {channelLabel}
                      </span>
                      <NumberField
                        label={`${label} stop ${index + 1} ${channelLabel}`}
                        value={stop.color[channel] ?? 0}
                        defaultValue={channel === 3 ? 1 : 0}
                        spec={channelSpec(channel)}
                        disabled={disabled}
                        onChange={(next, phase) => {
                          const color = convertColor(stop.color as Rgba, space, space);
                          const edited: Rgba = [
                            channel === 0 ? next : color[0],
                            channel === 1 ? next : color[1],
                            channel === 2 ? next : color[2],
                            channel === 3 ? next : color[3],
                          ];
                          emit(withStop(index, { position: stop.position, color: edited }), phase);
                        }}
                      />
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </PopoverRoot>

            <NumberField
              label={`${label} stop ${index + 1} position`}
              value={stop.position}
              defaultValue={stop.position}
              spec={POSITION_SPEC}
              disabled={disabled}
              onChange={(next, phase) => emit(withStop(index, { position: next, color: stop.color }), phase)}
            />

            <div className={styles.stopActions}>
              <button
                type="button"
                className={cx(styles.stopButton, "nodrag")}
                aria-label={`Move ${label} stop ${index + 1} earlier`}
                title="Move earlier"
                disabled={disabled || index === 0}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => emit(move(stops, index, index - 1))}
              >
                <span aria-hidden>↑</span>
              </button>
              <button
                type="button"
                className={cx(styles.stopButton, "nodrag")}
                aria-label={`Move ${label} stop ${index + 1} later`}
                title="Move later"
                disabled={disabled || index === stops.length - 1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => emit(move(stops, index, index + 1))}
              >
                <span aria-hidden>↓</span>
              </button>
              <button
                type="button"
                className={cx(styles.stopButton, "nodrag")}
                aria-label={`Add a stop after ${label} stop ${index + 1}`}
                title="Add a stop after this one"
                disabled={disabled || stops.length >= max}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => emit(insertAfter(stops, index))}
              >
                <span aria-hidden>+</span>
              </button>
              <button
                type="button"
                className={cx(styles.stopButton, "nodrag")}
                aria-label={`Remove ${label} stop ${index + 1}`}
                title="Remove"
                // A gradient with no stops is not a gradient, and a one-stop list is a
                // flat colour — which is legal, so the floor is one, not two.
                disabled={disabled || stops.length <= 1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => emit(stops.filter((_, at) => at !== index))}
              >
                <span aria-hidden>−</span>
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
