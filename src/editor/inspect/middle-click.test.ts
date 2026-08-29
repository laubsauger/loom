// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchMiddleClick } from "./middle-click.ts";
import type { MiddleClickEvent } from "./middle-click.ts";

/**
 * Middle CLICK vs middle DRAG (T145).
 *
 * TouchDesigner opens node info with the middle button, and node editors near-universally
 * pan with middle-DRAG — and §I still marks pan/zoom as unconfirmed. So the one thing this
 * watcher must never do is claim the button. These tests are about the boundary: a press
 * that moved, or was held, belongs to whatever owns panning, and this watcher must let it
 * through untouched.
 */

let host: HTMLElement;
let clicks: MiddleClickEvent[];
let detach: (() => void) | null = null;
let clock = 0;

function press(type: string, init: { button: number; x?: number; y?: number; pointerId?: number }) {
  const event = new MouseEvent(type, {
    button: init.button,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    bubbles: true,
    cancelable: true,
  });
  // jsdom has no PointerEvent constructor; the watcher reads only `pointerId` beyond
  // what MouseEvent already carries.
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  host.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  clock = 0;
  clicks = [];
  host = document.createElement("div");
  document.body.append(host);
  detach = watchMiddleClick(host, (event) => clicks.push(event), { now: () => clock });
});

afterEach(() => {
  detach?.();
  detach = null;
  host.remove();
});

describe("middle click opens node info", () => {
  it("reports a press and release in the same place", () => {
    press("pointerdown", { button: 1, x: 100, y: 50 });
    press("pointerup", { button: 1, x: 100, y: 50 });
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.clientX).toBe(100);
  });

  it("tolerates a couple of pixels of hand shake", () => {
    press("pointerdown", { button: 1, x: 100, y: 50 });
    press("pointermove", { button: 1, x: 102, y: 51 });
    press("pointerup", { button: 1, x: 102, y: 51 });
    expect(clicks).toHaveLength(1);
  });
});

describe("middle DRAG is left alone — it is the pan gesture", () => {
  it("ignores a press that travelled", () => {
    press("pointerdown", { button: 1, x: 100, y: 50 });
    press("pointermove", { button: 1, x: 400, y: 200 });
    press("pointerup", { button: 1, x: 400, y: 200 });
    expect(clicks).toEqual([]);
  });

  it("stays a drag even when the pointer returns to where it started", () => {
    // A pan out and back is still a pan. Treating the round trip as a click would open
    // the popup at the end of every symmetric drag.
    press("pointerdown", { button: 1, x: 100, y: 50 });
    press("pointermove", { button: 1, x: 400, y: 200 });
    press("pointermove", { button: 1, x: 100, y: 50 });
    press("pointerup", { button: 1, x: 100, y: 50 });
    expect(clicks).toEqual([]);
  });

  it("ignores a long hold, which is a paused drag rather than a click", () => {
    press("pointerdown", { button: 1, x: 100, y: 50 });
    clock += 2000;
    press("pointerup", { button: 1, x: 100, y: 50 });
    expect(clicks).toEqual([]);
  });

  it("never calls preventDefault on the pointer events themselves", () => {
    // This is what lets React Flow's d3-zoom pan keep working on the same button.
    const down = press("pointerdown", { button: 1, x: 10, y: 10 });
    const move = press("pointermove", { button: 1, x: 10, y: 10 });
    const up = press("pointerup", { button: 1, x: 10, y: 10 });
    expect(down.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(clicks).toHaveLength(1);
  });

  it("drops a press cancelled by the browser", () => {
    press("pointerdown", { button: 1, x: 10, y: 10 });
    press("pointercancel", { button: 1, x: 10, y: 10 });
    press("pointerup", { button: 1, x: 10, y: 10 });
    expect(clicks).toEqual([]);
  });
});

describe("other buttons", () => {
  it("ignores left and right presses entirely", () => {
    press("pointerdown", { button: 0, x: 10, y: 10 });
    press("pointerup", { button: 0, x: 10, y: 10 });
    press("pointerdown", { button: 2, x: 10, y: 10 });
    press("pointerup", { button: 2, x: 10, y: 10 });
    expect(clicks).toEqual([]);
  });

  it("ignores a release from a different pointer than the one that pressed", () => {
    press("pointerdown", { button: 1, x: 10, y: 10, pointerId: 1 });
    press("pointerup", { button: 1, x: 10, y: 10, pointerId: 2 });
    expect(clicks).toEqual([]);
  });
});

describe("browser default behaviour", () => {
  it("suppresses auxclick only for a press it classified as a click", () => {
    press("pointerdown", { button: 1, x: 10, y: 10 });
    press("pointerup", { button: 1, x: 10, y: 10 });
    const claimed = press("auxclick", { button: 1, x: 10, y: 10 });
    expect(claimed.defaultPrevented).toBe(true);

    // A drag's auxclick belongs to whoever owns panning.
    press("pointerdown", { button: 1, x: 10, y: 10 });
    press("pointermove", { button: 1, x: 300, y: 300 });
    press("pointerup", { button: 1, x: 300, y: 300 });
    const dragged = press("auxclick", { button: 1, x: 300, y: 300 });
    expect(dragged.defaultPrevented).toBe(false);
  });
});

describe("detach", () => {
  it("stops listening", () => {
    detach?.();
    detach = null;
    press("pointerdown", { button: 1, x: 10, y: 10 });
    press("pointerup", { button: 1, x: 10, y: 10 });
    expect(clicks).toEqual([]);
  });
});
