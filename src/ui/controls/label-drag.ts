import { nudge, valueFromDrag, type DragModifier } from "./drag-math.ts";
import type { NumericSpec } from "./types.ts";

/**
 * Dragging the parameter NAME moves every channel of a compound at once (T1026, §V114).
 *
 * The owner: "if we have a parameter grid and it has an X and a Y, we need some way where
 * we can move them in sync. Same as TouchDesigner addresses it… we drag and slide over the
 * LABEL instead of over one of the inputs."
 *
 * ## What TouchDesigner actually does
 *
 * The affordance is real and documented. `docs.derivative.ca/Parameter_Dialog`: "If the
 * parameter is a double/triple/quadruple parameter (such as Offset in the Displace TOP or
 * Translate in the Geometry COMP), opening the value ladder on the parameter's name/label
 * will adjust all two/three/four at the same time. For individual parameter adjustment
 * middle-mouse click on the numeric field itself." `First_Things_to_Know_about_
 * TouchDesigner` says it again: "if you click on the parameter name and operate the
 * ladder, you modify all values of the parameter." Houdini has the identical split
 * (`sidefx.com/docs/houdini/network/parms.html`: "Press on a parameter name or an
 * individual text box"), which is where TD's version comes from.
 *
 * Two consequences for this module. The name-versus-field distinction is exactly the seam
 * we already have. And the gesture TD opens on the name is THE VALUE LADDER — the same
 * ladder `NumberField` already implements (§V133, T228) — not a plain scrub. This drag
 * behaves as a field that has picked no rung: `dragStepFor` granularity, shift/alt for a
 * decade either side. Putting the rung PICKER on the label as well is the remaining piece
 * of TD parity and is deliberately not attempted here.
 *
 * ## Additive, not proportional — and why
 *
 * A drag on the name applies THE SAME DRAG to every eligible channel: `[2, 3]` dragged by
 * one step becomes `[3, 4]`, preserving the DIFFERENCE. It does not scale them by a ratio
 * (`[3, 4.5]`, preserving the aspect).
 *
 * This one is NOT settled by TD: no Derivative page states whether the multi-component
 * ladder is additive or proportional, and neither does Houdini's. What the TD docs do say
 * is that a ladder rung "increase[s]/decrease[s] the value BY THAT INCREMENT"
 * (`docs.derivative.ca/Value_Ladder`), with the rungs labelled as absolute step sizes
 * (.01 .1 1 10 100) rather than as ratios — which only reads as an additive delta. That is
 * an inference from the documented mechanism, not a quoted claim, and it is recorded as
 * one.
 *
 * The industry has no single answer either. Blender is the only tool that engineered the
 * question rather than asserting it, and its rule (`interface_handlers.cc`,
 * `multibut_states_apply`) is: additive by DEFAULT (`origvalue + delta`), multiplicative
 * only for a property the RNA declares `PROP_PROPORTIONAL` (object scale) or whose unit is
 * length — and never multiplicative when the anchor value is 0, because the ratio is
 * undefined. Unreal and Figma reach proportional a different way again: an explicit,
 * visible LOCK the user toggles (the chain link on Scale, constrain-proportions), never a
 * hidden property of a drag.
 *
 * So: additive, for four reasons in order of weight.
 *
 * 1. It is literally the same gesture as the field's. Every channel goes through
 *    `valueFromDrag` with the same spec and the same travel, so the name and the `x` field
 *    move `x` identically. Proportional cannot say that: dragging the name would move a
 *    field differently from dragging that field, and the label would read as a second,
 *    differently-calibrated control.
 * 2. Multiplication has no fixed point to work from. A channel sitting at 0 can never
 *    leave 0 under a ratio, so `[0, 5]` — an extremely ordinary offset — is half dead
 *    under the gesture, and the user gets no feedback about why. Blender's own
 *    implementation refuses proportional mode in exactly this case.
 * 3. Ratios do not survive clamping. Every channel is clamped into the manifest range
 *    independently (`normalizeValue`), so the moment one channel pins at `max` the aspect
 *    the gesture promised to preserve is silently gone. Additive drift under a clamp is
 *    visible and expected; a broken ratio is neither.
 * 4. Proportional needs a declaration Loom's manifest does not have. Blender picks per
 *    PROPERTY, and it is right to: additive is wrong for `scale` and proportional is wrong
 *    for `offset`, so a gesture that guesses will be wrong half the time. Deciding it here
 *    would mean inventing the flag; deciding it in `ParameterDefinition` is a change to the
 *    frozen contract and belongs to whoever owns it. Until then the honest default is the
 *    one every tool falls back to, and the aspect case keeps its better-known home — an
 *    explicit ratio lock — which this does not foreclose.
 *
 * ## Per-channel modes (§V113, §V830)
 *
 * A channel whose own mode is not static is DECIDED ELSEWHERE, so this must not move it:
 * a gesture the resolver overwrites on the next frame is a lie, and writing the channel's
 * retained static payload behind the driver's back would corrupt what a flip back to
 * Constant restores (§V108). Such a channel keeps its start value here and is masked out
 * of the write entirely (`movableMask`). The label says which channels it will move and
 * which it will not, by name — never `disabled`, never silence (§V830).
 */

/** A channel of a compound, as the label-drag gesture sees it. */
export interface LabelDragChannel {
  /** Axis name — `x`, `y`, `z`, `w`. What the hint calls it. */
  name: string;
  /**
   * What decides this channel when its own mode is not static ("Expression", "Bind",
   * "Map"), or null when the stored constant decides it. Non-null means the drag skips it.
   */
  drivenBy: string | null;
}

/** `start` snapshots the values the gesture works from; `commit` closes the undo group. */
export type LabelGesturePhase = "start" | "live" | "commit";

/**
 * The label's pointer and keyboard gesture, handed to `ControlRow` by whoever knows the
 * values — the row itself owns no maths and no parameter (§V90's separation, mirrored
 * from `NumberField` owning pointers while `drag-math` owns numbers).
 */
export interface LabelDragHandlers {
  /** `deltaX` is travel since the press, absolute — never a per-move increment. */
  onDrag: (deltaX: number, modifier: DragModifier, phase: LabelGesturePhase) => void;
  /** §V19: the same adjustment without a pointer. `commit` on key-up, so a repeat is one entry. */
  onNudge: (direction: 1 | -1, modifier: DragModifier, phase: "live" | "commit") => void;
}

/** Which channels a label gesture may write: the ones no other mode is deciding. */
export function movableMask(channels: readonly LabelDragChannel[]): readonly boolean[] {
  return channels.map((channel) => channel.drivenBy === null);
}

export interface LabelDragInput {
  /** Values the GESTURE started from. Reading the current ones would make the drag drift. */
  startValues: readonly number[];
  channels: readonly LabelDragChannel[];
  deltaX: number;
  spec: NumericSpec;
  modifier: DragModifier;
}

/**
 * Every eligible channel dragged by the same travel, through the same funnel a single
 * field uses. A driven channel comes back exactly as it went in — the caller masks it out
 * of the write, and this keeps the tuple the right length and the right shape meanwhile.
 */
export function valuesFromLabelDrag({
  startValues,
  channels,
  deltaX,
  spec,
  modifier,
}: LabelDragInput): readonly number[] {
  return startValues.map((startValue, index) => {
    if ((channels[index]?.drivenBy ?? null) !== null) return startValue;
    return valueFromDrag({ startValue, deltaX, spec, modifier });
  });
}

export interface LabelNudgeInput {
  values: readonly number[];
  channels: readonly LabelDragChannel[];
  direction: 1 | -1;
  spec: NumericSpec;
  modifier: DragModifier;
}

/** §V19's half: one arrow press steps every eligible channel by the field's own step. */
export function valuesFromLabelNudge({
  values,
  channels,
  direction,
  spec,
  modifier,
}: LabelNudgeInput): readonly number[] {
  return values.map((value, index) => {
    if ((channels[index]?.drivenBy ?? null) !== null) return value;
    return nudge({ value, direction, spec, modifier });
  });
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string}`;
}

/**
 * §V830 — the label states what the gesture does, including what it will REFUSE to do and
 * why. A name that silently moves two of three axes, or that silently does nothing because
 * every axis is driven, is the inert-and-unexplained state this invariant exists to end.
 * It rides the label's existing hover text rather than a second indicator (§V90).
 */
export function describeLabelDrag(channels: readonly LabelDragChannel[]): string {
  const movable = channels.filter((channel) => channel.drivenBy === null).map((channel) => channel.name);
  const blocked = channels.filter((channel) => channel.drivenBy !== null);
  if (movable.length === 0) {
    const reasons = blocked.map((channel) => `${channel.name} (${channel.drivenBy as string})`);
    return `Every channel is decided by its own mode — ${listNames(reasons)} — so dragging the name cannot move them.`;
  }
  const moves = `Drag the name to move ${listNames(movable)} together`;
  if (blocked.length === 0) return `${moves}.`;
  const held = blocked.map((channel) => `${channel.name} (${channel.drivenBy as string})`);
  return `${moves}; ${listNames(held)} stays with its own mode.`;
}
