/**
 * T1043 — WHAT A CAMERA IS ASKED FOR, AND THE GRANT THAT IS NOT THE SAME THING.
 *
 * The owner: *"the webcam node probably can have some more features, some more parameters
 * like resolution and whatnot — I think we can probably pull a few more things from there."*
 *
 * ## A constraint is a NEGOTIATION, not a settings write (§V827's shape, §B172's lesson)
 *
 * `getUserMedia`'s video constraints are a REQUEST. Ask a camera for 1920x1080 with
 * `ideal` and a camera that has no such mode hands back 1280x720 — successfully, silently,
 * with no error anywhere. So a node that grew a Resolution parameter and stopped there
 * would ship a knob that looks like a setting, reads back the number you typed, and is
 * wrong about the picture on screen. That is exactly the timestamp-query readout that lied
 * (§B172): a surface that ECHOES the request will confidently name something that did not
 * happen.
 *
 * ∴ THE REQUEST AND THE GRANT ARE TWO DIFFERENT VALUES AND THIS MODULE KEEPS THEM APART.
 * `CameraRequest` is what the document asks for. `CameraGrant` is what the live track says
 * it is doing. Nothing in here ever fills one from the other.
 *
 * ## §V986 — an unmeasurable value reads as ABSENT, never as a confident default
 *
 * Every member of `CameraGrant` and `CameraLimits` is OPTIONAL, and `cameraGrantOf` drops
 * what the browser did not report rather than substituting 0. A confident `0 fps` is
 * indistinguishable from a real measurement of a stalled camera, and the section that
 * renders it has to be able to say "not reported" — which it cannot do if the absence was
 * already laundered into a number here.
 *
 * §V986's second half applies to the READ, and it is the caller's obligation, stated here
 * because this is where the shape is declared: `MediaStreamTrack.getSettings()` moves —
 * a track renegotiates when the camera is reconfigured, and some platforms settle on a
 * frame rate a second after the open. So the grant is read PER CALL from the live track
 * (`OpenedCamera.grant()` in `use-media-sources.ts`), never captured once at open time.
 *
 * ## §V985 — the control and the means of knowing what to put in it ship together
 *
 * A Resolution field with no way to learn what this camera can do is a field that tells
 * the user to guess. `MediaStreamTrack.getCapabilities()` is the answer the browser
 * already has, so `CameraLimits` carries it and the inspector's Camera section prints it
 * beside the field. Where the browser has no `getCapabilities` (it is optional, and
 * Firefox has historically had none for video) the limits are NULL, and the section says
 * so rather than printing a bound it invented.
 *
 * ## Structural types, no DOM
 *
 * `CameraTrackSettings` / `CameraTrackCapabilities` are the handful of members this module
 * reads, the same convention `MediaElement` follows in `media-sources.ts`: a real
 * `MediaStreamTrack` satisfies them, and a headless test satisfies them with an object
 * literal and no browser.
 */

/** Which camera to prefer where a device has more than one. `any` asks for nothing. */
export type CameraFacing = "any" | "user" | "environment";

/**
 * What the document asks the camera for. Zero means UNASKED, never "zero pixels": a
 * request nobody made must not narrow the negotiation, so `cameraConstraints` omits it.
 */
export interface CameraRequest {
  /** Exact `deviceId`, or "" for the system default (T810). */
  readonly device: string;
  /** Requested capture width in pixels; 0 = unasked. */
  readonly width: number;
  /** Requested capture height in pixels; 0 = unasked. */
  readonly height: number;
  /** Requested frames per second; 0 = unasked. */
  readonly frameRate: number;
  readonly facing: CameraFacing;
  /**
   * `exact` rather than `ideal` for the size and rate — the node's Require fit. A camera
   * with no matching mode then REFUSES TO OPEN (`OverconstrainedError`) instead of
   * substituting, which is the only thing that makes requiring different from preferring.
   */
  readonly exact: boolean;
}

/** A node that stored nothing: the system default camera, no size, no rate, no facing. */
export const NO_CAMERA_REQUEST: CameraRequest = {
  device: "",
  width: 0,
  height: 0,
  frameRate: 0,
  facing: "any",
  exact: false,
};

const CAMERA_FACINGS: ReadonlySet<string> = new Set<CameraFacing>(["any", "user", "environment"]);

/**
 * T1043 — the webcam's Capture parameters, read the way T810 reads `device`: STATICALLY.
 *
 * These are STRUCTURAL. Changing one re-opens the camera — that is what the parameters'
 * own descriptions say, and it is the same door a changed `device` already goes through —
 * so routing them through the value graph would restart the capture on every tick of a
 * driven expression, which is the audio detector knobs' argument verbatim (T1230's
 * `staticValueOf`: "capture config never animates").
 *
 * A non-number, a negative, a NaN and an absent key all mean UNASKED, which is the default
 * and is also exactly what this node negotiated before T1043 existed — so a document that
 * stores none of these keys opens the camera with the same `video: true` it always did.
 */
export function cameraRequestOf(parameters: Readonly<Record<string, unknown>>): CameraRequest {
  const size = (key: string): number => {
    const value = parameters[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  };
  const facing = parameters["facing"];
  return {
    device: typeof parameters["device"] === "string" ? parameters["device"] : "",
    width: size("width"),
    height: size("height"),
    frameRate: size("frameRate"),
    facing:
      typeof facing === "string" && CAMERA_FACINGS.has(facing) ? (facing as CameraFacing) : "any",
    exact: parameters["fit"] === "require",
  };
}

/** The members of `MediaTrackSettings` this module reads. */
export interface CameraTrackSettings {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly facingMode?: string;
  readonly deviceId?: string;
}

/** The members of `MediaTrackCapabilities` this module reads. */
export interface CameraTrackCapabilities {
  readonly width?: { readonly max?: number };
  readonly height?: { readonly max?: number };
  readonly frameRate?: { readonly max?: number };
  readonly facingMode?: readonly string[];
}

/**
 * WHAT THE TRACK IS ACTUALLY DOING. Every member optional (§V986): a browser that does not
 * report a frame rate leaves `frameRate` absent, and the reader says "not reported".
 */
export interface CameraGrant {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly facing?: string;
  readonly deviceId?: string;
}

/** WHAT THIS CAMERA CAN DO, from `getCapabilities()` (§V985). Absent members unreported. */
export interface CameraLimits {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxFrameRate?: number;
  readonly facings?: readonly string[];
}

/**
 * WHAT ONE WEBCAM NODE'S CAMERA IS DOING — the inspector's Camera section reads this.
 *
 * Structured rather than one prose sentence, on `AudioInputStatus.latency`'s precedent and
 * for its reason: a reader that has to parse its own sentence to compare two numbers will
 * eventually parse it wrong, and the comparison IS the feature here.
 *
 * `requested` is always present — it is the document, and the document is always readable.
 * `granted` and `limits` are null where there is nothing measured to say.
 */
export interface CameraStatus {
  readonly kind: "live" | "error";
  /** Why it is not live. Absent while it is. */
  readonly message?: string;
  /** What the document asked for. */
  readonly requested: CameraRequest;
  /** What the live track says it is doing NOW. Null: no track, or the browser said nothing. */
  readonly granted: CameraGrant | null;
  /** What this camera says it can do. Null where the browser reports no capabilities. */
  readonly limits: CameraLimits | null;
}

/** The video constraints `getUserMedia` takes, structurally. */
export interface CameraConstraintRange {
  readonly ideal?: number;
  readonly exact?: number;
}

export interface CameraVideoConstraints {
  readonly deviceId?: { readonly exact: string };
  readonly width?: CameraConstraintRange;
  readonly height?: CameraConstraintRange;
  readonly frameRate?: CameraConstraintRange;
  readonly facingMode?: { readonly ideal: string };
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Whether anything beyond the device was asked for — what the Fit control applies TO. */
export function cameraAsksForFormat(request: CameraRequest): boolean {
  return positive(request.width) || positive(request.height) || positive(request.frameRate);
}

/**
 * The request, as constraints. `true` when nothing at all was asked — which is the literal
 * `video: true` this node passed before T1043, so a document that stores none of the new
 * parameters negotiates byte-for-byte the way it did.
 *
 * FACING IS ALWAYS `ideal`, EVEN UNDER REQUIRE, and that is a decision rather than an
 * oversight: a desktop webcam reports NO facing mode at all, so `facingMode: { exact }`
 * would refuse to open the only camera present on most machines running this. The
 * parameter's own description says so. A device id is the way to require a particular
 * camera, and it is already exact.
 *
 * A chosen device and a facing preference cannot both be honoured — the device decides
 * which camera, and the facing is then a fact about it rather than a choice — so the
 * facing is dropped when a device is named, which is what the parameter's `inactiveWhen`
 * tells the user.
 */
export function cameraConstraints(request: CameraRequest): CameraVideoConstraints | true {
  const bound = (value: number): CameraConstraintRange =>
    request.exact ? { exact: value } : { ideal: value };
  const constraints: CameraVideoConstraints = {
    ...(request.device.trim() === "" ? {} : { deviceId: { exact: request.device } }),
    ...(positive(request.width) ? { width: bound(request.width) } : {}),
    ...(positive(request.height) ? { height: bound(request.height) } : {}),
    ...(positive(request.frameRate) ? { frameRate: bound(request.frameRate) } : {}),
    ...(request.facing !== "any" && request.device.trim() === ""
      ? { facingMode: { ideal: request.facing } }
      : {}),
  };
  return Object.keys(constraints).length === 0 ? true : constraints;
}

/**
 * The grant, from a track's settings. Null when there is nothing to report AT ALL — no
 * track, or a browser whose `getSettings()` answered with nothing this node reads.
 *
 * §V986: a member the browser omitted stays omitted. `width: 0` would be a measurement of
 * a camera producing no pixels, which is a different and much more alarming fact than
 * "this browser did not say".
 */
export function cameraGrantOf(settings: CameraTrackSettings | undefined): CameraGrant | null {
  if (settings === undefined) return null;
  const grant: CameraGrant = {
    ...(positive(settings.width ?? 0) ? { width: settings.width as number } : {}),
    ...(positive(settings.height ?? 0) ? { height: settings.height as number } : {}),
    ...(positive(settings.frameRate ?? 0) ? { frameRate: settings.frameRate as number } : {}),
    ...(typeof settings.facingMode === "string" && settings.facingMode !== ""
      ? { facing: settings.facingMode }
      : {}),
    ...(typeof settings.deviceId === "string" && settings.deviceId !== ""
      ? { deviceId: settings.deviceId }
      : {}),
  };
  return Object.keys(grant).length === 0 ? null : grant;
}

/** What the camera says it can do (§V985). Null where the browser reports nothing. */
export function cameraLimitsOf(
  capabilities: CameraTrackCapabilities | undefined,
): CameraLimits | null {
  if (capabilities === undefined) return null;
  const facings = capabilities.facingMode?.filter((entry) => entry !== "") ?? [];
  const limits: CameraLimits = {
    ...(positive(capabilities.width?.max ?? 0) ? { maxWidth: capabilities.width?.max as number } : {}),
    ...(positive(capabilities.height?.max ?? 0)
      ? { maxHeight: capabilities.height?.max as number }
      : {}),
    ...(positive(capabilities.frameRate?.max ?? 0)
      ? { maxFrameRate: capabilities.frameRate?.max as number }
      : {}),
    ...(facings.length > 0 ? { facings: [...facings] } : {}),
  };
  return Object.keys(limits).length === 0 ? null : limits;
}

function rounded(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * THE SENTENCE THAT STOPS THE KNOB FROM LYING — what was asked for and not delivered, or
 * null when the camera met the request (or when nothing was asked).
 *
 * Only ever compares a member that was BOTH asked for and REPORTED. An unreported grant is
 * not a shortfall, it is an unknown (§V986), and calling it a shortfall would put a red
 * sentence in front of every user on a browser that keeps quiet.
 *
 * The frame-rate comparison has a tolerance because frame rates are not integers: a camera
 * asked for 30 commonly reports 29.97 or 30.000030517578125, and a readout that called
 * that a declined request would cry wolf on the most ordinary case there is. Half a frame
 * per second is well inside "the camera did what you asked" and well outside the 30-vs-15
 * substitution this exists to surface.
 */
export const CAMERA_FRAME_RATE_TOLERANCE = 0.5;

/**
 * The required format, in words, for the diagnostic a Require refusal raises.
 *
 * It names the NUMBERS rather than the browser's constraint token, because "the camera
 * cannot do the required 1920 x 1080 at 60 fps" tells a user what to change and
 * `OverconstrainedError: width` does not. Never empty: it is only ever called on a request
 * that was exact, and an exact request with nothing in it cannot overconstrain anything.
 */
export function requiredFormatText(request: CameraRequest): string {
  const parts: string[] = [];
  if (positive(request.width) && positive(request.height)) {
    parts.push(`${String(request.width)} x ${String(request.height)}`);
  } else if (positive(request.width)) {
    parts.push(`${String(request.width)} px width`);
  } else if (positive(request.height)) {
    parts.push(`${String(request.height)} px height`);
  }
  if (positive(request.frameRate)) parts.push(`${String(request.frameRate)} fps`);
  return parts.length === 0 ? "capture format" : parts.join(" at ");
}

export function cameraShortfall(request: CameraRequest, grant: CameraGrant | null): string | null {
  if (grant === null) return null;
  const parts: string[] = [];
  if (positive(request.width) && grant.width !== undefined && grant.width !== request.width) {
    parts.push(`${String(request.width)} px wide, got ${rounded(grant.width)}`);
  }
  if (positive(request.height) && grant.height !== undefined && grant.height !== request.height) {
    parts.push(`${String(request.height)} px high, got ${rounded(grant.height)}`);
  }
  if (
    positive(request.frameRate) &&
    grant.frameRate !== undefined &&
    Math.abs(grant.frameRate - request.frameRate) > CAMERA_FRAME_RATE_TOLERANCE
  ) {
    parts.push(`${String(request.frameRate)} fps, got ${rounded(grant.frameRate)}`);
  }
  if (
    request.facing !== "any" &&
    request.device.trim() === "" &&
    grant.facing !== undefined &&
    grant.facing !== request.facing
  ) {
    parts.push(`the ${request.facing} camera, got ${grant.facing}`);
  }
  return parts.length === 0 ? null : `Asked for ${parts.join("; ")}.`;
}
