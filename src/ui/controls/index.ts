/**
 * Parameter control kit (T37).
 *
 * Owned by the controls track, deliberately not re-exported from `src/ui/index.ts`:
 * these are manifest-driven parameter controls, not chrome primitives. Import them
 * from here (`@ui/controls/index.ts`).
 */

export type { EditPhase, NumericSpec, ValueListener } from "./types.ts";

export {
  DECADE_LADDER,
  DRAG_MODIFIER_FACTOR,
  DRAG_THRESHOLD_PX,
  PIXELS_PER_DECADE,
  PIXELS_PER_STEP,
  clampToRange,
  decadeForModifier,
  decadeIndex,
  declaredStep,
  decimalsFor,
  decimalsForDecade,
  defaultDecade,
  describeRange,
  dragModifierFrom,
  dragStepFor,
  formatDecade,
  formatNumber,
  normalizeAtDecade,
  normalizeValue,
  nudge,
  quantize,
  rangeFraction,
  roundToDecimals,
  shiftDecade,
  valueFromDrag,
} from "./drag-math.ts";
export type { DragInput, DragModifier, ModifierState, NudgeInput } from "./drag-math.ts";

export { evaluateExpression } from "./expression.ts";
export type { ExpressionResult } from "./expression.ts";

export {
  COLOR_CHANNEL_LABELS,
  convertColor,
  cssColorFor,
  fromDisplay,
  linearToSrgb,
  parseHex,
  srgbToLinear,
  toDisplay,
  toHex,
  toRgba,
} from "./color.ts";
export type { ColorSpace, Rgba } from "./color.ts";

export { createFrameCoalescer, rafScheduler } from "./coalesce.ts";
export type { FrameCoalescer, FrameScheduler } from "./coalesce.ts";

export { defaultValueFor, matchesDefinition, valueForDefinition } from "./parameter-value.ts";

export {
  describeLabelDrag,
  movableMask,
  valuesFromLabelDrag,
  valuesFromLabelNudge,
} from "./label-drag.ts";
export type {
  LabelDragChannel,
  LabelDragHandlers,
  LabelDragInput,
  LabelGesturePhase,
  LabelNudgeInput,
} from "./label-drag.ts";

export { ControlRow } from "./control-row.tsx";
export type { ControlRowProps, ControlVariant } from "./control-row.tsx";

export { NumberField, unitSuffix } from "./number-field.tsx";
export type { NumberFieldProps } from "./number-field.tsx";

export { BooleanField } from "./boolean-field.tsx";
export type { BooleanFieldProps } from "./boolean-field.tsx";

export { PulseField } from "./pulse-field.tsx";
export type { PulseFieldProps } from "./pulse-field.tsx";

export { EnumField } from "./enum-field.tsx";
export type { EnumFieldProps, EnumOption } from "./enum-field.tsx";

export { TextField } from "./text-field.tsx";
export type { TextFieldProps } from "./text-field.tsx";

export { VectorField, specForVector, AXIS_LABELS } from "./vector-field.tsx";
export type { VectorFieldProps } from "./vector-field.tsx";

export { ColorPicker, PICKER_LOCKED_REASON } from "./color-picker.tsx";
export type { ColorPickerProps } from "./color-picker.tsx";

export { ColorField } from "./color-field.tsx";
export type { ColorFieldProps } from "./color-field.tsx";

export { StopsField } from "./stops-field.tsx";
export type { StopsFieldProps } from "./stops-field.tsx";

export { AssetField, CurveField, curvePolyline } from "./curve-field.tsx";
export type { AssetFieldProps, CurveFieldProps, CurvePoint } from "./curve-field.tsx";

export { ParameterControl } from "./parameter-control.tsx";
export type { ParameterControlProps } from "./parameter-control.tsx";

export type { ExpressionReferenceSource } from "./expression-completion.ts";

export {
  MODE_GLYPHS,
  MODE_LABELS,
  MODE_ORDER,
  MODE_PAYLOAD_LABELS,
  bindingFromText,
  holdsRetainedValue,
  isParameterSlot,
  payloadText,
  slotOf,
  withBinding,
  withMode,
  withStaticValue,
} from "./parameter-slot.ts";

export { ParameterModePanel } from "./parameter-mode.tsx";
export type { ParameterModePanelProps } from "./parameter-mode.tsx";
