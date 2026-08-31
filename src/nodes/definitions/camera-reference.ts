import type { ParameterValue } from "../../domain/types/parameters.ts";

/**
 * The `camera` NAME, and what a renderer does when it does not resolve (T528, §V109).
 *
 * ## The rule, stated once
 *
 * **A named camera is a PROMISE.** If the `camera` parameter names something, THAT camera
 * frames the render. If the name does not resolve, the render REFUSES — it does not fall
 * back to anything. The inline eye/look/FOV are used only when NO name was given at all.
 *
 * ## Why, and what it replaces
 *
 * `render`, `renderSurface` and `renderInstances` were asked the same question and gave
 * two answers. `render` refused outright. The other two emitted
 * `error:compiler/source-reference-missing` from the compiler AND STILL EMITTED THEIR
 * PASS, drawing confidently through their inline camera — so `camera: "nope1"` produced a
 * picture, a plausible one, from a viewpoint nobody asked for, with an error in a panel
 * beside it. That teaches people to ignore errors, and §V147's family is exactly this: the
 * output is plausible and wrong, which is worse than no output.
 *
 * ## The third answer, which is the one taken
 *
 * "Refuse whenever the camera is missing" would blank a Render Surface that never named a
 * camera and was framed inline — which is most of them, and would be a real regression.
 * So the rule splits on whether a NAME WAS GIVEN, not on whether a camera arrived:
 *
 *  - name given, camera arrived  → the named camera frames it (§V146 dims the inline rows);
 *  - name given, nothing arrived → REFUSE, naming the name;
 *  - no name                     → the inline camera, exactly as before.
 *
 * Nothing arriving covers every way a name can fail — no such node, a node with no output,
 * a node that is not a camera, a camera that is MUTED — because in all of them the
 * compiler declines to synthesize the edge. One check, and the refusal says what to look
 * for rather than guessing which of the four it was.
 */

/** The `camera` parameter's name, trimmed. Empty means no name was given. */
export const namedCameraOf = (values: Readonly<Record<string, ParameterValue>>): string => {
  const named = values["camera"];
  return typeof named === "string" ? named.trim() : "";
};

/**
 * §V146 — a NAMED camera replaces the inline rows wholesale (T457), so while one is named
 * the inline eye/look/FOV cannot affect the output at all and must read INACTIVE.
 *
 * B104/T500: the owner reported "any of the camera parameters are not really reflecting in
 * the output". A renderer showing a live-looking Camera Eye it is ignoring is one honest
 * way to see exactly that — the parameter is edited, the picture does not move, and
 * nothing says why. The row dims and gives the reason, and it stays editable, because
 * setting the inline camera before clearing the name is a normal way to work.
 */
export const namedCameraWins = (values: Readonly<Record<string, ParameterValue>>): string | null => {
  const named = namedCameraOf(values);
  return named === "" ? null : `Camera "${named}" frames this render; its parameters replace this one.`;
};

/** The refusal, worded the same in all three renderers (§V109). */
export const danglingCameraMessage = (named: string): string =>
  `camera "${named}" is named here, but no camera by that name reached this node — it does not exist, is not a camera node, or is muted. Refusing rather than framing this with the inline camera, which is not the picture you asked for.`;

/** The suggestion that goes with it. */
export const DANGLING_CAMERA_SUGGESTION =
  "Name an existing camera node, or clear the camera parameter to frame this inline.";

/**
 * The whole decision, so a fourth renderer cannot get it subtly different: the refusal
 * message when a given name did not resolve, and `null` when there is nothing to refuse.
 */
export function danglingCameraRefusal(
  values: Readonly<Record<string, ParameterValue>>,
  resolved: boolean,
): string | null {
  const named = namedCameraOf(values);
  if (named === "" || resolved) return null;
  return danglingCameraMessage(named);
}
