import type { ParameterMode, ParameterSlot, ParameterValue } from "@domain/types/parameters.ts";
import { isParameterSlot, slotFromValue, PARAMETER_MODES } from "@domain/parameters/slots.ts";

/**
 * Slot EDITING — the write half of the mode model (T204, §V107, §V108).
 *
 * `src/domain/parameters/slots.ts` owns reading a stored parameter (what shape is it,
 * what does its static binding hold); nothing here re-implements any of that, and the
 * mode list itself is imported rather than re-declared so a fifth mode cannot appear in
 * the domain and be missing from the buttons.
 *
 * What is left here is the DISPLAY half — the button order, their captions and glyphs.
 * The writing rules moved down to the domain when the parameter context menu gained a
 * mode switch (T246): a menu item is a bus command, commands run where `src/ui` does not
 * exist, and two answers to "what does switching to Expression do" is the drift §V109
 * forbids.
 */

/** Display order of the mode buttons — TD's row, left to right. */
export const MODE_ORDER: readonly ParameterMode[] = PARAMETER_MODES;

/** Button captions. Short because four of them share one control row. */
export const MODE_LABELS: Readonly<Record<ParameterMode, string>> = {
  static: "Constant",
  expression: "Expression",
  bind: "Bind",
  driven: "Driven",
  map: "Map",
};

/** Single-glyph face of each button — the row is four ~18px squares. */
export const MODE_GLYPHS: Readonly<Record<ParameterMode, string>> = {
  static: "C",
  expression: "E",
  bind: "B",
  driven: "D",
  map: "M",
};

/** What the active mode's payload is called in its editor's label. */
export const MODE_PAYLOAD_LABELS: Readonly<Record<ParameterMode, string>> = {
  static: "Value",
  expression: "Expression",
  bind: "Bound to",
  driven: "Channel",
  map: "Attribute",
};

/** The slot a stored parameter already is, or the one a bare value means. */
export function slotOf(
  stored: ParameterSlot | undefined,
  value: ParameterValue,
): ParameterSlot {
  return stored ?? slotFromValue(value);
}

/** True when the stored parameter is a mode envelope rather than a bare value. */
export { isParameterSlot };

/**
 * The slot-writing rules themselves live in the DOMAIN (`src/domain/parameters/slots.ts`)
 * since T246: a mode switch is now reachable from the parameter context menu as well as
 * from these buttons, and a menu item is a bus command running where `src/ui` does not
 * exist. Re-exported here so the control kit keeps one import for the whole slot model.
 */
export {
  bindingFromText,
  holdsRetainedValue,
  numericLiteralFor,
  payloadText,
  seedBinding,
  withBinding,
  withMode,
  withStaticValue,
} from "@domain/parameters/slots.ts";
