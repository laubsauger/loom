import type { VectorParameter } from "@domain/types/parameters.ts";
import { NumberField } from "./number-field.tsx";
import type { EditPhase, NumericSpec, ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * Vector parameter (T37): n numeric fields that share one manifest range, and report
 * the whole vector on every change so the document never holds a half-updated value.
 *
 * Axis names, not indices — a vec3 offset reads as x/y/z, and the accessible name of
 * each field is "<label> x", which is what a screen reader needs to tell them apart.
 */

export const AXIS_LABELS = ["x", "y", "z", "w"] as const;

export function specForVector(definition: VectorParameter): NumericSpec {
  return {
    ...(definition.min === undefined ? {} : { min: definition.min }),
    ...(definition.max === undefined ? {} : { max: definition.max }),
    ...(definition.range === undefined ? {} : { range: definition.range }),
    ...(definition.step === undefined ? {} : { step: definition.step }),
  };
}

export interface VectorFieldProps {
  label: string;
  value: readonly number[];
  definition: VectorParameter;
  disabled?: boolean;
  /**
   * §V830 — what decides the WHOLE vector, when its own slot is not static. Every axis
   * inherits it; a per-axis caption below overrides it.
   */
  drivenBy?: string | undefined;
  /**
   * Per-axis drivers (§V113, §V830). Entry `i` names what decides axis `i` — "Expression",
   * "Bind", "Channel", "Map" — or is null when that axis is a plain constant.
   *
   * A driven axis is not draggable: its value is decided elsewhere, and a field that
   * accepts a gesture the resolver then overrides is a field that lies. It is NOT
   * disabled either — see `NumberField.drivenBy`. It keeps updating, keeps focus and
   * says which of the four things is moving it.
   */
  componentDriven?: readonly (string | null)[];
  describedBy?: string;
  onChange: ValueListener<readonly number[]>;
}

export function VectorField({
  label,
  value,
  definition,
  disabled = false,
  drivenBy,
  componentDriven,
  describedBy,
  onChange,
}: VectorFieldProps) {
  const spec = specForVector(definition);
  const size = definition.size;

  /** The axis's own driver, else the compound's, else nothing: this axis is a constant. */
  const driverFor = (index: number): string | undefined =>
    componentDriven?.[index] ?? drivenBy ?? undefined;

  const setAxis = (index: number, next: number, phase: EditPhase): void => {
    const updated = Array.from({ length: size }, (_unused, axis) =>
      axis === index ? next : (value[axis] ?? definition.default[axis] ?? 0),
    );
    onChange(updated, phase);
  };

  return (
    <div className={styles.vector}>
      {Array.from({ length: size }, (_unused, index) => (
        <div className={styles.axis} key={AXIS_LABELS[index] ?? index}>
          <span className={styles.axisLabel} aria-hidden>
            {AXIS_LABELS[index] ?? index}
          </span>
          <NumberField
            label={`${label} ${AXIS_LABELS[index] ?? index}`}
            value={value[index] ?? definition.default[index] ?? 0}
            defaultValue={definition.default[index] ?? 0}
            spec={spec}
            disabled={disabled}
            {...(driverFor(index) === undefined ? {} : { drivenBy: driverFor(index) })}
            {...(describedBy === undefined ? {} : { describedBy })}
            onChange={(next, phase) => setAxis(index, next, phase)}
          />
        </div>
      ))}
    </div>
  );
}
