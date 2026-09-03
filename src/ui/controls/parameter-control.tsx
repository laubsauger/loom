import { useId, useRef, useState } from "react";
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
  VectorParameter,
} from "@domain/types/parameters.ts";
import { BooleanField } from "./boolean-field.tsx";
import { ColorField } from "./color-field.tsx";
import { toRgba } from "./color.ts";
import { ControlRow, type ControlVariant } from "./control-row.tsx";
import { CurveField, AssetField, type CurvePoint } from "./curve-field.tsx";
import { describeRange } from "./drag-math.ts";
import { EnumField } from "./enum-field.tsx";
import {
  describeLabelDrag,
  movableMask,
  valuesFromLabelDrag,
  valuesFromLabelNudge,
  type LabelDragChannel,
  type LabelDragHandlers,
} from "./label-drag.ts";
import { NumberField } from "./number-field.tsx";
import { PulseField } from "./pulse-field.tsx";
import { StopsField } from "./stops-field.tsx";
import { ParameterModePanel } from "./parameter-mode.tsx";
import type { ExpressionReferenceSource } from "./expression-completion.ts";
import { valueForDefinition } from "./parameter-value.ts";
import { MODE_BADGES, MODE_LABELS, slotOf, withMode, withStaticValue } from "./parameter-slot.ts";
import { TextField } from "./text-field.tsx";
import { AXIS_LABELS, VectorField, specForVector } from "./vector-field.tsx";
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
  /**
   * T893 — what is ON SCREEN RIGHT NOW, when that differs from `value`.
   *
   * The owner: "driven values / reference derived values dont seem to update their value
   * in the respective input... this doesnt reflect whats actually currently rendering."
   * `driven` was a STYLING flag and nothing else: the badge said "the shown value comes
   * from a driver" over a number resolved at the deterministic zero frame (§V44), so the
   * inspector stated a falsehood about the picture.
   *
   * SHOW LIVE, STORE RETAINED. This feeds the FIELD only. `value` still decides the mode
   * envelope, the detach seed and every write, because §V108's retained number is what a
   * flip back to Constant restores — displaying the live one into that seat would let a
   * momentary sample overwrite the value the user is keeping. So the two never merge, and
   * the switch below is the only place this is read.
   *
   * It arrives per RENDER, sampled by the caller at <=10 Hz (§V16). Nothing here polls,
   * subscribes or holds a frame: a control that reached for the clock itself would be the
   * per-frame React path §T714 measured at 10.8x.
   */
  liveValue?: ParameterValue | undefined;
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
  /**
   * T492: the REAL code editor, injected by the layer that owns it. The control kit
   * cannot import CodeMirror (it is the leaf layer), and a second lightweight editor
   * here would be the two-implementations shape T356 deleted — so the editor arrives
   * as a render prop from the inspector, and the fallback is the plain multiline
   * field, which is what every test of this kit alone sees.
   */
  codeField?:
    | ((props: {
        id: string;
        label: string;
        value: string;
        language: "wgsl" | "json";
        disabled: boolean;
        onCommit: (next: string) => void;
      }) => ReactNode)
    | undefined;
  /** Per-channel resolutions for a compound parameter (§V113). */
  components?: readonly ResolvedComponent[] | undefined;
  /** Why the active mode is not producing a value, as the resolver reported it. */
  diagnostic?: RuntimeDiagnostic | null;
  /**
   * T990 — what the document can answer about `op('…')`, forwarded to every mode panel
   * this row draws: the compound's own, and one per channel (§V113). A component's
   * expression references the same graph the compound's does.
   */
  references?: ExpressionReferenceSource;
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
  liveValue,
  variant = "inspector",
  disabled = false,
  driven = false,
  inactive = null,
  onPulse,
  slot: storedSlot,
  codeField,
  components,
  diagnostic = null,
  references,
  onStoredChange,
  onChange,
}: ParameterControlProps) {
  const generatedId = useId();
  const controlId = `${generatedId}-${parameterKey}`;
  const descriptionId = definition.description === undefined ? undefined : `${controlId}-desc`;
  const resolved = valueForDefinition(definition, value);
  /**
   * T893 — the DISPLAY value, and the only thing the field branches below read.
   *
   * `resolved` stays the RETAINED one everywhere else in this component: `slot`, the mode
   * panel's seed, `withMode`'s literal, `emitCompound`'s per-channel fallback. That split
   * is the whole point — a live sample must never become the number a detach restores
   * (§V108), and a field must never emit one back into the document (§V16: per-frame state
   * does not enter the store).
   */
  const shown = liveValue === undefined ? resolved : valueForDefinition(definition, liveValue);
  const label = definition.label;

  const [expanded, setExpanded] = useState(false);
  /** Set only when ctrl/cmd+E opened the panel, so the payload field takes focus. */
  const [focusExpression, setFocusExpression] = useState(false);
  /**
   * T1026 — the tuple a label drag started from. Snapshotted at the press, because the
   * gesture is absolute: reading the CURRENT tuple on every move would feed each emitted
   * value back into the next one and the drag would accelerate away from the pointer.
   */
  const labelDragStart = useRef<readonly number[] | null>(null);
  /** The tuple an in-flight keyboard repeat has reached, awaiting its commit on key-up. */
  const labelNudgePending = useRef<readonly number[] | null>(null);

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
   * §V830 (T988) — WHAT decides this parameter, when the stored constant does not.
   *
   * Refusing the drag was always right: a gesture the resolver overwrites on the next
   * frame is a lie. Saying so with `disabled` was not. `disabled` is the browser's word
   * for inert and unimportant, and it dims the number, drops the field out of tab order
   * and tells a screen reader to skip it — for the ONE moving value on the panel, which
   * is the value the panel was opened to read. Grey is also what broken, loading,
   * unsupported and not-licensed look like, so it asked the user to tell five states
   * apart by one colour.
   *
   * The caption is the positive half: the field carries the driver's NAME, not the
   * absence of editability. Per channel where the channel has its own slot (§V113), and
   * for the whole compound otherwise.
   */
  const drivenBy = slot.mode === "static" ? null : MODE_LABELS[slot.mode];
  /** The row-level half of the same mark: `expr`, `bind`, `chan`, `map`. */
  const drivenBadge = slot.mode === "static" ? null : MODE_BADGES[slot.mode];
  const componentDriven =
    components === undefined
      ? undefined
      : components.map((component) =>
          component.mode === "static" ? null : MODE_LABELS[component.mode],
        );

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
  /**
   * `movable` (T1026) names the channels this write is ALLOWED to touch, and exists for the
   * label drag: a channel decided by its own mode must not be written at all, not even
   * back to the value it already shows, because that value is the resolver's live sample
   * and the seat it would land in is the retained constant a flip to Constant restores
   * (§V108). Omitted — every existing caller — means every channel, unchanged behaviour.
   *
   * A mask can only mask something out when a channel is driven, and a driven channel
   * always carries its own slot (a compound-level driver is refused before it gets here),
   * so the bare-key fallback below stays reachable only when the mask is vacuous.
   */
  const emitCompound = (
    next: readonly number[],
    phase: EditPhase,
    movable?: readonly boolean[],
  ): void => {
    const masked = movable !== undefined && movable.some((can) => !can);
    if (
      onStoredChange === undefined ||
      components === undefined ||
      (componentsWithSlots.length === 0 && !masked)
    ) {
      emit(next, phase);
      return;
    }
    const entries: Record<string, StoredParameter> = {};
    components.forEach((component, index) => {
      if (movable !== undefined && movable[index] !== true) return;
      const channel = next[index] ?? component.value;
      entries[componentKey(parameterKey, component.name)] = withStaticValue(
        slotOf(component.slot, component.value),
        channel,
      );
    });
    onStoredChange(entries, phase);
  };

  /**
   * T1026 — the parameter NAME as one drag surface for every channel of a compound.
   *
   * TouchDesigner's affordance, and the owner's ask: "if we have a parameter grid and it
   * has an X and a Y, we need some way where we can move them in sync… we drag and slide
   * over the LABEL instead of over one of the inputs."
   *
   * Everything about the maths — additive rather than proportional, and why — is in
   * `label-drag.ts`. What lives here is the wiring, and the wiring is the invariant: the
   * whole gesture goes through `emitCompound`, so a drag that moves three channels is ONE
   * patch per emitted value and ONE undo entry for the gesture (§V114, §V15), never three
   * patches; and it goes through `movable`, so a channel decided by its own mode is never
   * written (§V113, §V830).
   */
  const buildLabelDrag = (
    vectorDefinition: VectorParameter,
  ): { hint: string; drag: LabelDragHandlers | undefined } => {
    const spec = specForVector(vectorDefinition);
    const channels: readonly LabelDragChannel[] = Array.from(
      { length: vectorDefinition.size },
      (_unused, index) => ({
        name: AXIS_LABELS[index] ?? String(index),
        // The axis's own driver, else the compound's — the same precedence the fields use.
        drivenBy: componentDriven?.[index] ?? drivenBy,
      }),
    );
    const movable = movableMask(channels);
    const hint = describeLabelDrag(channels);
    // §V830: nothing to move is stated in words, not by an inert label. The sentence still
    // goes out; only the handlers do not.
    if (!movable.some((can) => can)) return { hint, drag: undefined };
    const current = (): readonly number[] =>
      Array.isArray(shown) ? (shown as readonly number[]) : vectorDefinition.default;
    return {
      hint,
      drag: {
        onDrag: (deltaX, modifier, phase) => {
          if (phase === "start") {
            labelDragStart.current = current();
            return;
          }
          const next = valuesFromLabelDrag({
            startValues: labelDragStart.current ?? current(),
            channels,
            deltaX,
            spec,
            modifier,
          });
          emitCompound(next, phase === "commit" ? "commit" : "live", movable);
          if (phase === "commit") labelDragStart.current = null;
        },
        onNudge: (direction, modifier, phase) => {
          if (phase === "commit") {
            const pending = labelNudgePending.current;
            labelNudgePending.current = null;
            if (pending !== null) emitCompound(pending, "commit", movable);
            return;
          }
          const next = valuesFromLabelNudge({
            values: labelNudgePending.current ?? current(),
            channels,
            direction,
            spec,
            modifier,
          });
          labelNudgePending.current = next;
          emitCompound(next, "live", movable);
        },
      },
    };
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
        // T990: the node names and their members, so `op('` offers the graph rather than
        // an empty menu. The panel cannot know them; only the layer holding the document
        // does, and for four months nothing passed them (§V272).
        {...(references === undefined ? {} : { references })}
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
                {...(references === undefined ? {} : { references })}
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
    disabled,
    ...(descriptionId === undefined ? {} : { describedBy: descriptionId }),
  };
  /**
   * §V830 is implemented for the value-bearing fields (number, vector, colour, text): the
   * ones whose whole point is "what is it right now". A switch, a select, a pulse and the
   * code editor have no read-only presentation yet, so they keep the old refusal — being
   * unavailable — rather than silently accepting a write the resolver would discard.
   */
  const sharedLocked = { ...shared, disabled: disabled || drivenBy !== null };

  const row = (
    children: ReactNode,
    options?: {
      hint?: string | null;
      stacked?: boolean;
      labelHint?: string | null;
      labelDrag?: LabelDragHandlers | undefined;
    },
  ) => (
    <div className={styles.rowHost} onKeyDown={onKeyDown}>
      <ControlRow
        label={label}
        variant={variant}
        compileTime={definition.compileTime === true}
        inactive={inactive}
        driven={driven}
        drivenBadge={drivenBadge}
        description={definition.description}
        hint={options?.hint ?? null}
        stacked={options?.stacked ?? false}
        labelHint={options?.labelHint ?? null}
        {...(options?.labelDrag === undefined ? {} : { labelDrag: options.labelDrag })}
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
          value={typeof shown === "number" ? shown : definition.default}
          spec={definition}
          {...(drivenBy === null ? {} : { drivenBy })}
          {...(definition.unit === undefined ? {} : { unit: definition.unit })}
          onChange={(next, phase) => emit(next, phase)}
        />,
        { hint: describeRange(definition) },
      );

    case "boolean":
      return row(
        <BooleanField
          {...sharedLocked}
          id={controlId}
          value={shown === true}
          onChange={(next, phase) => emit(next, phase)}
        />,
      );

    case "enum":
      return row(
        <EnumField
          {...sharedLocked}
          id={controlId}
          value={typeof shown === "string" ? shown : definition.default}
          options={definition.options}
          onChange={(next, phase) => emit(next, phase)}
        />,
      );

    case "color":
      return row(
        <ColorField
          {...shared}
          value={toRgba(shown)}
          definition={definition}
          {...(drivenBy === null ? {} : { drivenBy })}
          {...(componentDriven === undefined ? {} : { componentDriven })}
          onChange={(next, phase) => emitCompound(next, phase)}
        />,
        { hint: definition.space },
      );

    case "vector": {
      // T1026: the name is the shared drag surface. Offered only where the label is already
      // the mode disclosure — a real, focusable button — so the gesture cannot be
      // pointer-only (§V19) and cannot be mistaken for a node drag on the canvas (§V20).
      const compound = modesAvailable ? buildLabelDrag(definition) : null;
      return row(
        <VectorField
          {...shared}
          value={Array.isArray(shown) ? (shown as readonly number[]) : definition.default}
          definition={definition}
          {...(drivenBy === null ? {} : { drivenBy })}
          {...(componentDriven === undefined ? {} : { componentDriven })}
          onChange={(next, phase) => emitCompound(next, phase)}
        />,
        {
          hint: describeRange(specForVector(definition)),
          stacked: definition.size > 2,
          ...(compound === null
            ? {}
            : {
                labelHint: compound.hint,
                ...(compound.drag === undefined ? {} : { labelDrag: compound.drag }),
              }),
        },
      );
    }

    case "string":
      return row(
        <TextField
          {...shared}
          id={controlId}
          value={typeof shown === "string" ? shown : definition.default}
          multiline={definition.multiline === true}
          readOnly={drivenBy !== null}
          onChange={(next, phase) => emit(next, phase)}
        />,
        { stacked: definition.multiline === true },
      );

    case "code":
      return row(
        codeField !== undefined ? (
          codeField({
            id: controlId,
            label,
            value: typeof shown === "string" ? shown : definition.default,
            language: definition.language,
            disabled: sharedLocked.disabled === true,
            onCommit: (next) => emit(next, "commit"),
          })
        ) : (
          <TextField
            {...shared}
            id={controlId}
            value={typeof shown === "string" ? shown : definition.default}
            multiline
            readOnly={drivenBy !== null}
            onChange={(next, phase) => emit(next, phase)}
          />
        ),
        { stacked: true, hint: definition.language },
      );

    case "asset":
      return row(
        <AssetField
          label={label}
          value={typeof shown === "string" ? shown : null}
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
          {...sharedLocked}
          id={controlId}
          disabled={sharedLocked.disabled || onPulse === undefined}
          onFire={() => onPulse?.(parameterKey)}
        />,
      );

    case "stops":
      return row(
        <StopsField
          {...sharedLocked}
          value={Array.isArray(shown) ? (shown as readonly ColorStop[]) : definition.default}
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
          value={Array.isArray(shown) ? (shown as readonly CurvePoint[]) : []}
        />,
      );

    default: {
      const never: never = definition;
      void never;
      return null;
    }
  }
}
