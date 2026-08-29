/**
 * Middle CLICK without stealing middle DRAG (T145).
 *
 * TouchDesigner opens node info with the middle mouse button, so we do too. The problem
 * is that middle-drag is also the near-universal pan gesture in node editors, and §I's
 * mouse table still marks pan/zoom as unconfirmed (`?`) — so this must not be the thing
 * that decides the question by consuming the button.
 *
 * ## What this does, and what it deliberately does not do
 *
 * It OBSERVES. On `pointerdown` with button 1 it records where the press landed; on
 * `pointerup` it reports a click only if the pointer never travelled further than
 * `moveThresholdPx` and the press was shorter than `holdThresholdMs`. A pan gesture fails
 * both tests by construction — panning that moves less than four pixels and lasts under
 * half a second has not panned.
 *
 * It calls neither `preventDefault()` nor `stopPropagation()` on the pointer events. That
 * is the load-bearing decision: React Flow's pan (d3-zoom) listens on the same element,
 * and swallowing the press to "own" the button would break panning for everyone the
 * moment someone confirms middle-drag as the pan gesture. The two coexist because a drag
 * and a click are distinguishable AFTER the fact, and only the click needs claiming.
 *
 * ASSUMED, and worth confirming against a real TD install: that middle-DRAG pans and
 * middle-CLICK opens node info, i.e. that TD itself distinguishes them the same way. If
 * pan turns out to be bound elsewhere entirely, this still works — it just stops being a
 * shared button.
 *
 * The one thing suppressed is the browser's own middle-click behaviour on the `auxclick`
 * event (Linux paste-primary-selection, opening a link in a new tab), and only for
 * presses this watcher classified as a click on the canvas. Autoscroll on Windows starts
 * from `mousedown`, which is deliberately left alone for the reason above.
 */

/** Chrome/Firefox/Safari all report the middle button as 1. */
const MIDDLE_BUTTON = 1;

export interface MiddleClickOptions {
  /** Movement beyond this many pixels makes it a drag, not a click. */
  readonly moveThresholdPx?: number;
  /** A press held longer than this is a drag the user simply paused mid-way. */
  readonly holdThresholdMs?: number;
  /** Injected so a test can drive the clock without real timers. */
  readonly now?: () => number;
}

export interface MiddleClickEvent {
  readonly target: EventTarget | null;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Four pixels is the usual slop for "the user did not mean to move" — small enough that a
 * deliberate pan never registers as a click, large enough that a trackpad middle-click
 * with a shaky finger still does.
 */
const DEFAULT_MOVE_PX = 4;
const DEFAULT_HOLD_MS = 500;

/**
 * Attaches the watcher to an element. Returns a detach function.
 *
 * Listeners go on the element itself, not the document, so a middle click elsewhere in
 * the app is none of our business.
 */
export function watchMiddleClick(
  element: HTMLElement,
  onMiddleClick: (event: MiddleClickEvent) => void,
  options: MiddleClickOptions = {},
): () => void {
  const movePx = options.moveThresholdPx ?? DEFAULT_MOVE_PX;
  const holdMs = options.holdThresholdMs ?? DEFAULT_HOLD_MS;
  const now = options.now ?? (() => Date.now());

  let pressed: { x: number; y: number; at: number; pointerId: number } | null = null;
  /** Set when the press qualified as a click, so `auxclick` knows to suppress the default. */
  let claimed = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== MIDDLE_BUTTON) return;
    claimed = false;
    pressed = { x: event.clientX, y: event.clientY, at: now(), pointerId: event.pointerId };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pressed === null || event.pointerId !== pressed.pointerId) return;
    const dx = event.clientX - pressed.x;
    const dy = event.clientY - pressed.y;
    // Once it has moved far enough it is a drag for good — coming back to the origin
    // does not turn a completed pan back into a click.
    if (Math.hypot(dx, dy) > movePx) pressed = null;
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== MIDDLE_BUTTON) return;
    const press = pressed;
    pressed = null;
    if (press === null || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > movePx) return;
    if (now() - press.at > holdMs) return;

    claimed = true;
    onMiddleClick({
      target: event.target,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  const onPointerCancel = (): void => {
    pressed = null;
  };

  const onAuxClick = (event: MouseEvent): void => {
    if (event.button !== MIDDLE_BUTTON || !claimed) return;
    claimed = false;
    // Only the browser's own middle-click behaviour is suppressed, and only for a press
    // this watcher already classified as a click.
    event.preventDefault();
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancel);
  element.addEventListener("auxclick", onAuxClick);

  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerCancel);
    element.removeEventListener("auxclick", onAuxClick);
  };
}
