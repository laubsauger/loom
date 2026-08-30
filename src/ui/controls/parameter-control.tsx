import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { ResolvedComponent } from "@domain/parameters/resolve.ts";
import { componentKey } from "@domain/parameters/slots.ts";
import { numericRangeOf } from "@domain/parameters/expression-range.ts";
import { isContainerParameter } from "@domain/types/parameters.ts";
import type {
  ColorStop,
  ParameterDefinition,
  ParameterSlot,
  ParameterValue,
  StoredParameter,
} from "@domain/types/parameters.ts";
import { BooleanField } from "./boolean-field.tsx";
import { ColorField } from "./color-field.tsx";
import { toRgba } from "./color.ts";
import { ControlRow, type ControlVariant } from "./control-row.tsx";
import { CurveField, AssetField, type CurvePoint } from "./curve-field.tsx";
import { describeRange } from "./drag-math.ts";
import { EnumField } from "./enum-field.tsx";
import { NumberField } from "./number-field.tsx";
import { PulseField } from "./pulse-field.tsx";
import { StopsField } from "./stops-field.tsx";
import { ParameterModePanel } from "./parameter-mode.tsx";
import { valueForDefinition } from "./parameter-value.ts";
import { slotOf, withMode, withStaticValue } from "./parameter-slot.ts";
import { TextField } from "./text-field.tsx";
import { VectorField, specForVector } from "./vector-field.tsx";
import type { EditPhase, ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * Manifest-driven control dispatch (T37, T38) with the mode model on top (T204, T207).
 *
 * The node definition is the single source of what a parameter looks like: nothing in
 * the editor hand-writes a control for a specific node, so a node package that lands
 * later — or one an agent authors — gets a complete, correct inspector for free.
 *
 * Every branch of the `ParameterDefinition` union is handled; the exhaustiveness guard
 * at the bottom turns "someone added a parameter type" into a compile error rather
 * than a silently missing control.
 *
 * ## Modes (§V107, §V108)
 *
 * Click the parameter NAME and the mode panel opens: four buttons, one per mode, with
 * a corner mark on any inactive mode that still holds a value. ctrl/cmd+E goes straight
 * to the expression. Every TYPE gets it, not just numbers.
 *
 * ## Components (§V113, §V114)
 *
 * A compound (colour, vector) expands into one mode panel per CHANNEL — `color.g` and
 * `t.x` are first-class parameters with their own modes, which is what makes a single
 * channel drivable while its siblings stay constant. And a compound value edit is ONE
 * patch: picking a colour is one undo entry, never four (§V114).
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
  /**
   * Fires this parameter's pulse (§V123). A pulse writes NOTHING to the document, so it
   * cannot travel down `onChange` like every other control's value — omitting this
   * renders the button disabled rather than letting it silently do nothing.
   */
  onPulse?: ((parameterKey: string) => void) | undefined;
  /**
   * §V146 — why this parameter cannot affect the output in the node's current state,
   * from the manifest's own `inactiveWhen` predicate. The row dims and the reason joins
   * the label's hover; the control stays EDITABLE, because setting a value before
   * switching the mode that makes it apply is a normal way to work.
   */
  inactive?: string | null;
  /** The stored mode envelope at the bare key, when the document holds one. */
  slot?: ParameterSlot | undefined;
  /** Per-channel resolutions for a compound parameter (§V113). */
  components?: readonly ResolvedComponent[] | undefined;
  /** Why the active mode is not producing a value, as the resolver reported it. */
  diagnostic?: RuntimeDiagnostic | null;
  /**
   * Writes stored parameters — mode envelopes, or every channel of a compound. ONE
   * call is ONE patch and therefore ONE undo entry (§V114, §V15). Omitting it hides the
   * mode UI entirely, which is what a node-embedded control wants.
   */
  onStoredChange?: ((entries: Record<string, StoredParameter>, phase: EditPhase) => void) | undefined;
  onChange: ValueListener<ParameterValue>;
}

/** ctrl/cmd+E — TD's "edit the expression". */
function isExpressionShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "e" || event.key === "E");
}

export function ParameterControl({
  parameterKey,
  definition,
  value,
  variant = "inspector",
  disabled = false,
  driven = false,
  inactive = null,
  onPulse,
  slot: storedSlot,
  components,
  diagnostic = null,
  onStoredChange,
  onChange,
}: ParameterControlProps) {
  const generatedId = useId();
  const controlId = `${generatedId}-${parameterKey}`;
  const descriptionId = definition.description === undefined ? undefined : `${controlId}-desc`;
  const resolved = valueForDefinition(definition, value);
  const label = definition.label;

  const [expanded, setExpanded] = useState(false);
  /** Set only when ctrl/cmd+E opened the panel, so the payload field takes focus. */
  const [focusExpression, setFocusExpression] = useState(false);

  /**
   * The mode UI needs somewhere to write. Node-embedded rows pass no writer and stay
   * exactly as dense as they were.
   *
   * §V195: a CONTAINER parameter (`curve`, `stops`) is static AS A WHOLE, so it gets no
   * mode panel. An expression returns a number and there is no meaning to a list-valued
   * one; the moded things are its leaves (`stops[2].position`), which wait on the key
   * grammar carrying an index. Offering four buttons that can only ever produce a
   * diagnostic would be the interface telling a lie about what the model supports.
   */
  const modesAvailable =
    onStoredChange !== undefined && variant === "inspector" && !isContainerParameter(definition);
  const slot = slotOf(storedSlot, resolved);

  const emit = (next: ParameterValue, phase: EditPhase): void => onChange(next, phase);

  /**
   * A channel whose own mode is not `static` is decided by its expression, bind or
   * channel — so its field says so by being unavailable, rather than accepting a drag
   * whose value the resolver would then override.
   */
  const componentDisabled =
    components === undefined ? undefined : components.map((component) => component.mode !== "static");

  const writeSlot = (key: string, next: ParameterSlot): void => {
    onStoredChange?.({ [key]: next }, "commit");
  };

  /**
   * §V114: a compound value edit is ONE patch. When no channel carries a slot the bare
   * compound key is that patch, exactly as before. Once a channel DOES carry one, the
   * bare key no longer decides that channel (the resolver lets the component override
   * it), so the write has to address every channel — still one patch, still one undo
   * entry, never four.
   */
  const componentsWithSlots = (components ?? []).filter((component) => component.slot !== undefined);
  const emitCompound = (next: readonly number[], phase: EditPhase): void => {
    if (onStoredChange === undefined || componentsWithSlots.length === 0 || components === undefined) {
      emit(next, phase);
      return;
    }
    const entries: Record<string, StoredParameter> = {};
    components.forEach((component, index) => {
      const channel = next[index] ?? component.value;
      entries[componentKey(parameterKey, component.name)] = withStaticValue(
        slotOf(component.slot, component.value),
        channel,
      );
    });
    onStoredChange(entries, phase);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!modesAvailable || !isExpressionShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setExpanded(true);
    setFocusExpression(true);
    // `withMode` seeds a literal of the current value for `expression`, so this never
    // comes back null — but a mode that has no authorable empty form would, and silently
    // writing nothing is exactly the inert-button failure this guard exists to prevent.
    const next = withMode(slot, "expression", resolved);
    if (next !== null) writeSlot(parameterKey, next);
  };

  const modePanel: ReactNode = !modesAvailable ? null : (
    <>
      <ParameterModePanel
        label={label}
        slot={slot}
        value={resolved}
        disabled={disabled}
        autoFocus={focusExpression}
        diagnostic={diagnostic}
        // T368: the manifest's own bounds, so an expression that will clamp says so while
        // it is being written. The panel cannot know them; only the definition does.
        range={numericRangeOf(definition)}
        onChange={(next) => writeSlot(parameterKey, next)}
      />
      {components === undefined ? null : (
        <div className={styles.componentList}>
          {components.map((component) => (
            <div className={styles.componentRow} key={component.name}>
              <span className={styles.componentName}>{`${parameterKey}.${component.name}`}</span>
              <ParameterModePanel
                label={`${label}.${component.name}`}
                slot={slotOf(component.slot, component.value)}
                value={component.value}
                disabled={disabled}
                diagnostic={component.diagnostic}
                // A channel of a compound is bounded by the compound's own declaration.
                range={numericRangeOf(definition)}
                onChange={(next) => writeSlot(componentKey(parameterKey, component.name), next)}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );

  const shared = {
    label,
    // A parameter whose active mode is not `static` is not editable by dragging its
    // value: the expression, the bind or the channel decides it. Saying so by disabling
    // the field beats a control that silently discards what the user does with it.
    disabled: disabled || slot.mode !== "static",
    ...(descriptionId === undefined ? {} : { describedBy: descriptionId }),
  };

  const row = (children: ReactNode, options?: { hint?: string | null; stacked?: boolean }) => (
    <div className={styles.rowHost} onKeyDown={onKeyDown}>
      <ControlRow
        label={label}
        variant={variant}
        compileTime={definition.compileTime === true}
        inactive={inactive}
        driven={driven}
        description={definition.description}
        hint={options?.hint ?? null}
        stacked={options?.stacked ?? false}
        controlId={controlId}
        descriptionId={descriptionId}
        expanded={expanded}
        expansion={modePanel}
        {...(modesAvailable
          ? {
              onToggleModes: () => {
                setFocusExpression(false);
                setExpanded((open) => !open);
              },
            }
          : {})}
      >
        {children}
      </ControlRow>
    </div>
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
          {...(componentDisabled === undefined ? {} : { componentDisabled })}
          onChange={(next, phase) => emitCompound(next, phase)}
        />,
        { hint: definition.space },
      );

    case "vector":
      return row(
        <VectorField
          {...shared}
          value={Array.isArray(resolved) ? (resolved as readonly number[]) : definition.default}
          definition={definition}
          {...(componentDisabled === undefined ? {} : { componentDisabled })}
          onChange={(next, phase) => emitCompound(next, phase)}
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
          // T434: the picked object URL is the stored value — one commit, one undo step,
          // like every other control (§V114). Session-scoped; the field says so.
          onPick={(url) => emit(url, "commit")}
        />,
        { hint: definition.kind },
      );

    case "pulse":
      return row(
        <PulseField
          {...shared}
          id={controlId}
          disabled={shared.disabled || onPulse === undefined}
          onFire={() => onPulse?.(parameterKey)}
        />,
      );

    case "stops":
      return row(
        <StopsField
          {...shared}
          value={Array.isArray(resolved) ? (resolved as readonly ColorStop[]) : definition.default}
          definition={definition}
          onChange={(next, phase) => emit(next, phase)}
        />,
        // §V196: the space is a FACT about the stored numbers, shown the same way a
        // colour's is — the hint slot, not a sentence.
        { hint: definition.space, stacked: true },
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
