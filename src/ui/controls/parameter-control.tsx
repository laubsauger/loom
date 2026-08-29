import { useId } from "react";
import type { ReactNode } from "react";
import type { ParameterDefinition, ParameterValue } from "@domain/types/parameters.ts";
import { BooleanField } from "./boolean-field.tsx";
import { ColorField } from "./color-field.tsx";
import { toRgba } from "./color.ts";
import { ControlRow, type ControlVariant } from "./control-row.tsx";
import { CurveField, AssetField, type CurvePoint } from "./curve-field.tsx";
import { describeRange } from "./drag-math.ts";
import { EnumField } from "./enum-field.tsx";
import { NumberField } from "./number-field.tsx";
import { valueForDefinition } from "./parameter-value.ts";
import { TextField } from "./text-field.tsx";
import { VectorField, specForVector } from "./vector-field.tsx";
import type { EditPhase, ValueListener } from "./types.ts";

/**
 * Manifest-driven control dispatch (T37, T38).
 *
 * The node definition is the single source of what a parameter looks like: nothing in
 * the editor hand-writes a control for a specific node, so a node package that lands
 * later — or one an agent authors — gets a complete, correct inspector for free.
 *
 * Every branch of the `ParameterDefinition` union is handled; the exhaustiveness guard
 * at the bottom turns "someone added a parameter type" into a compile error rather
 * than a silently missing control.
 */

export interface ParameterControlProps {
  parameterKey: string;
  definition: ParameterDefinition;
  /** Stored value. A value that does not fit the manifest falls back to the default. */
  value: ParameterValue | undefined;
  variant?: ControlVariant;
  disabled?: boolean;
  /** The value shown came from a driver rather than the document (doc §8.2 seam). */
  driven?: boolean;
  onChange: ValueListener<ParameterValue>;
}

export function ParameterControl({
  parameterKey,
  definition,
  value,
  variant = "inspector",
  disabled = false,
  driven = false,
  onChange,
}: ParameterControlProps) {
  const generatedId = useId();
  const controlId = `${generatedId}-${parameterKey}`;
  const descriptionId = definition.description === undefined ? undefined : `${controlId}-desc`;
  const resolved = valueForDefinition(definition, value);
  const label = definition.label;

  const emit = (next: ParameterValue, phase: EditPhase): void => onChange(next, phase);

  const shared = {
    label,
    disabled,
    ...(descriptionId === undefined ? {} : { describedBy: descriptionId }),
  };

  const row = (children: ReactNode, options?: { hint?: string | null; stacked?: boolean }) => (
    <ControlRow
      label={label}
      variant={variant}
      compileTime={definition.compileTime === true}
      driven={driven}
      description={definition.description}
      hint={options?.hint ?? null}
      stacked={options?.stacked ?? false}
      controlId={controlId}
      descriptionId={descriptionId}
    >
      {children}
    </ControlRow>
  );

  switch (definition.type) {
    case "number":
      return row(
        <NumberField
          {...shared}
          id={controlId}
          value={typeof resolved === "number" ? resolved : definition.default}
          defaultValue={definition.default}
          spec={definition}
          {...(definition.unit === undefined ? {} : { unit: definition.unit })}
          onChange={(next, phase) => emit(next, phase)}
        />,
        { hint: describeRange(definition) },
      );

    case "boolean":
      return row(
        <BooleanField
          {...shared}
          id={controlId}
          value={resolved === true}
          onChange={(next, phase) => emit(next, phase)}
        />,
      );

    case "enum":
      return row(
        <EnumField
          {...shared}
          id={controlId}
          value={typeof resolved === "string" ? resolved : definition.default}
          options={definition.options}
          onChange={(next, phase) => emit(next, phase)}
        />,
      );

    case "color":
      return row(
        <ColorField
          {...shared}
          value={toRgba(resolved)}
          definition={definition}
          onChange={(next, phase) => emit(next, phase)}
        />,
        { hint: definition.space },
      );

    case "vector":
      return row(
        <VectorField
          {...shared}
          value={Array.isArray(resolved) ? (resolved as readonly number[]) : definition.default}
          definition={definition}
          onChange={(next, phase) => emit(next, phase)}
        />,
        { hint: describeRange(specForVector(definition)), stacked: definition.size > 2 },
      );

    case "string":
      return row(
        <TextField
          {...shared}
          id={controlId}
          value={typeof resolved === "string" ? resolved : definition.default}
          multiline={definition.multiline === true}
          onChange={(next, phase) => emit(next, phase)}
        />,
        { stacked: definition.multiline === true },
      );

    case "asset":
      return row(
        <AssetField
          label={label}
          value={typeof resolved === "string" ? resolved : null}
          kind={definition.kind}
        />,
        { hint: definition.kind },
      );

    case "curve":
      return row(
        <CurveField
          label={label}
          value={Array.isArray(resolved) ? (resolved as readonly CurvePoint[]) : []}
        />,
      );

    default: {
      const never: never = definition;
      void never;
      return null;
    }
  }
}
