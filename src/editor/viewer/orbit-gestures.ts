/**
 * T379 — the ONE set of gesture arithmetic every inspection surface shares.
 *
 * The owner's instruction was "this should be something they inherit from a common
 * thing", and the drift risk is precisely the numbers: a tile and a viewer that each
 * keep their own radians-per-pixel grow different wrists within a week. The EVENT
 * WIRING legitimately differs per host (a node tile must negotiate with React Flow's
 * alt/peek/nowheel world; the viewer owns its surface outright), so what is shared is
 * the arithmetic that turns pixels into orbit deltas — one place, three consumers
 * (node tile, viewer pane, and the pop-out viewer which mounts the same ViewerPane).
 *
 * T561's feel is the contract: a full sweep across the surface is about a half turn,
 * and a full sweep pans about one radius. The tile got that with fixed per-pixel
 * constants tuned for its 192px width; `scale` generalises it — pass 1 for the tile
 * (byte-identical behaviour to the constants it always had) and `192 / rect.width`
 * for a larger surface, so the SWEEP stays the unit, not the pixel.
 */

/** T561: radians per CSS px at the 192px reference width. */
export const RADIANS_PER_PX = 0.016;
/** T656: stock radii per CSS px at the reference width. */
export const RADII_PER_PX = 0.005;
/** T656: one 100-unit wheel notch is e^0.15 ≈ 1.16×. */
export const ZOOM_PER_DELTA = 0.0015;
/** A wheel reporting LINES or PAGES rather than pixels, normalized to pixels. */
export const DELTA_MODE_SCALE = [1, 16, 100] as const;
/** The tile width the per-pixel constants were tuned on. */
export const ORBIT_REFERENCE_WIDTH = 192;

/** Pointer movement → orbit delta. `pan` is the shift-drag (T675: shift pans, alt is
 *  the tile's camera key); drag right walks the camera rightward around the object. */
export function orbitDeltaFor(
  dx: number,
  dy: number,
  options: { pan: boolean; scale?: number },
): { azimuth?: number; elevation?: number; panX?: number; panY?: number } {
  const scale = options.scale ?? 1;
  return options.pan
    ? { panX: dx * RADII_PER_PX * scale, panY: -dy * RADII_PER_PX * scale }
    : { azimuth: dx * RADIANS_PER_PX * scale, elevation: -dy * RADIANS_PER_PX * scale };
}

/** Wheel → multiplicative zoom factor; away-from-you moves in, exponential so a notch
 *  is worth the same proportion of the picture at every distance. */
export function zoomFactorFor(deltaY: number, deltaMode: number): number {
  const scale = DELTA_MODE_SCALE[deltaMode] ?? 1;
  return Math.exp(deltaY * scale * ZOOM_PER_DELTA);
}

/**
 * §T1311b(b) — FLY, and the arithmetic lives here for the same reason the orbit's does:
 * the viewer pane and any later surface that grows a fly must have one wrist.
 *
 * The owner's ask was "proper controls like blender… so we can fly around", against a
 * viewer that already orbits, zooms, homes and frames content — and ORBIT IS NOT FLY. An
 * orbit turns the camera about a target it cannot pass; a fly translates the whole rig
 * under its own heading and the target travels with it. That is not a bigger orbit, it is
 * the other half of a 3D viewport, and the two compose: fly to a spot, then drag to look
 * around from there.
 */

/** The six directions, named in the camera's own frame. */
export type FlyAxis = "forward" | "back" | "left" | "right" | "up" | "down";

export const FLY_AXES: readonly FlyAxis[] = ["forward", "back", "left", "right", "up", "down"];

export function isFlyAxis(value: unknown): value is FlyAxis {
  return typeof value === "string" && (FLY_AXES as readonly string[]).includes(value);
}

/**
 * Cruise speed, in STOCK RADII per second — scale-free like the pan constant, so one
 * number flies a unit point cloud and a cathedral at the same apparent pace. ~1.1 crosses
 * the stock framing's own distance in a shade under a second, which is the speed at which
 * a room feels walkable rather than either sluggish or unsteerable.
 */
export const FLY_RADII_PER_SECOND = 1.1;
/** Shift is the throttle, not a second binding — the same modifier the orbit uses to pan. */
export const FLY_BOOST = 4;
/** One DISCRETE invocation (the palette, an agent, a keyboard without auto-repeat). */
export const FLY_STEP_RADII = 0.18;

/** Which way each axis points, in the camera's own frame. `back` is eye − lookAt. */
const FLY_SIGNS: Readonly<Record<FlyAxis, readonly [number, number, number]>> = {
  // The camera looks ALONG −back, so forward is −back. Getting this backwards is the
  // classic fly bug and it is invisible in a call-site audit: the keys all "work".
  forward: [0, 0, -1],
  back: [0, 0, 1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};

/** The camera axes a fly step is resolved against — `orbitFrame(pose)` supplies them. */
export interface FlyFrame {
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly back: readonly [number, number, number];
}

/**
 * Held directions + elapsed time → a world-space step, in stock-radius units.
 *
 * `null` when nothing is held, or when the held axes cancel (W and S together): that is
 * "no movement", and returning a zero triple instead would write a fly offset onto an
 * untouched camera and cost it §V528's float-exact identity for nothing.
 *
 * The direction is NORMALIZED before it is scaled, so holding W and D is not 1.41× faster
 * than holding W — the diagonal is a heading, not a bonus.
 */
export function flyDeltaFor(
  axes: Iterable<FlyAxis>,
  seconds: number,
  frame: FlyFrame,
  options?: { readonly boost?: boolean },
): [number, number, number] | null {
  if (!(seconds > 0)) return null;
  let localX = 0;
  let localY = 0;
  let localZ = 0;
  for (const axis of axes) {
    const sign = FLY_SIGNS[axis];
    localX += sign[0];
    localY += sign[1];
    localZ += sign[2];
  }
  const length = Math.hypot(localX, localY, localZ);
  if (length < 1e-9) return null;
  const speed =
    (seconds * FLY_RADII_PER_SECOND * (options?.boost === true ? FLY_BOOST : 1)) / length;
  const x = localX * speed;
  const y = localY * speed;
  const z = localZ * speed;
  return [
    frame.right[0] * x + frame.up[0] * y + frame.back[0] * z,
    frame.right[1] * x + frame.up[1] * y + frame.back[1] * z,
    frame.right[2] * x + frame.up[2] * y + frame.back[2] * z,
  ];
}

/**
 * One step of a DISCRETE invocation — the palette row, an agent's `viewer.fly`, a key
 * press on a keyboard whose auto-repeat never arrives. Deliberately the same function
 * with a fixed duration rather than a second formula: a nudge and a held key must move
 * the camera the same way or the two surfaces are two features.
 */
export function flyStepFor(axis: FlyAxis, frame: FlyFrame): [number, number, number] | null {
  return flyDeltaFor([axis], FLY_STEP_RADII / FLY_RADII_PER_SECOND, frame);
}
