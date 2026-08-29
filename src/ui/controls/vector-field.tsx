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
    ...(definition.step === undefined ? {} : { step: definition.step }),
  };
}

export interface VectorFieldProps {
  label: string;
  value: readonly number[];
  definition: VectorParameter;
  disabled?: boolean;
  describedBy?: string;
  onChange: ValueListener<readonly number[]>;
}

export function VectorField({
  label,
  value,
  definition,
  disabled = false,
  describedBy,
  onChange,
}: VectorFieldProps) {
  const spec = specForVector(definition);
  const size = definition.size;

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
            {...(describedBy === undefined ? {} : { describedBy })}
            onChange={(next, phase) => setAxis(index, next, phase)}
          />
        </div>
      ))}
    </div>
  );
}
