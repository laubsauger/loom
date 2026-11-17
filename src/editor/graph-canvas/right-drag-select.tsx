import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useReactFlow, useStore, useStoreApi } from "@xyflow/react";

/**
 * T1724b — TOUCHDESIGNER'S BOX SELECTION: THE RIGHT BUTTON, DRAGGED ON EMPTY CANVAS.
 *
 * `docs.derivative.ca/First_Things_to_Know_about_TouchDesigner`: "click and hold down the
 * right mouse button in an empty area, drag … release", while a right CLICK opens the
 * network menu. React Flow box-selects with the left button only, so this is the canvas's
 * own, over the library's store: a right press on the empty canvas that moves more than
 * `DRAG_THRESHOLD` px draws the library's own themed box (`.react-flow__selection`) and on
 * release selects every node it crosses (partially, as Shift+left-drag does); with Shift
 * held it ADDS them, as TouchDesigner's Shift-box does.
 *
 * The right click it must not break is the canvas menu (`context-menu-host.tsx`, Radix,
 * opened by `contextmenu`). The browsers disagree on WHEN that event comes: on release
 * (Windows, Linux) or on press (macOS). So, in the capture phase on the library's root,
 * before the menu host hears of it: a `contextmenu` while a right press is in progress is
 * held back and OWED; one right after a drag is dropped; a press that never moved pays the
 * owed one back on release, at the press's point, and the menu opens as it always did.
 */
const DRAG_THRESHOLD = 4;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function RightDragSelect(): ReactNode {
  const store = useStoreApi();
  const flow = useReactFlow();
  // The library sets its root after the first render; read it as it arrives.
  const root = useStore((state) => state.domNode);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    if (root === null) return;
    const win = root.ownerDocument.defaultView;
    if (win === null) return;

    let press: { readonly x: number; readonly y: number; readonly add: boolean; moved: boolean } | null = null;
    let owed: { readonly target: EventTarget; readonly x: number; readonly y: number } | null = null;
    let dropNext = false;

    const boxOf = (x: number, y: number): Box => {
      const at = root.getBoundingClientRect();
      const from = press as NonNullable<typeof press>;
      return {
        left: Math.min(from.x, x) - at.left,
        top: Math.min(from.y, y) - at.top,
        width: Math.abs(x - from.x),
        height: Math.abs(y - from.y),
      };
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 2) return;
      const target = event.target instanceof Element ? event.target : null;
      // Empty canvas only: on a node, a wire or a tile the right button is that thing's menu.
      if (target === null || target.closest(".react-flow__pane") === null || target.closest(".react-flow__node") !== null) return;
      press = { x: event.clientX, y: event.clientY, add: event.shiftKey, moved: false };
      owed = null;
      dropNext = false;
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (press === null) return;
      if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
      press.moved = true;
      setBox(boxOf(event.clientX, event.clientY));
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (press === null || event.button !== 2) return;
      const ended = press;
      if (!ended.moved) {
        press = null;
        const debt = owed;
        owed = null;
        if (debt !== null) replayMenu(debt.target, debt.x, debt.y);
        return;
      }
      const drawn = boxOf(event.clientX, event.clientY);
      press = null;
      owed = null;
      dropNext = true;
      setBox(null);
      const at = root.getBoundingClientRect();
      const corner = flow.screenToFlowPosition({ x: at.left + drawn.left, y: at.top + drawn.top });
      const far = flow.screenToFlowPosition({ x: at.left + drawn.left + drawn.width, y: at.top + drawn.top + drawn.height });
      const crossed = flow.getIntersectingNodes({ x: corner.x, y: corner.y, width: far.x - corner.x, height: far.y - corner.y }, true).map((node) => node.id);
      const state = store.getState();
      const held = ended.add ? state.nodes.filter((node) => node.selected === true).map((node) => node.id) : [];
      if (!ended.add) state.resetSelectedElements();
      state.addSelectedNodes([...new Set([...held, ...crossed])]);
    };

    const onContextMenu = (event: MouseEvent): void => {
      if (press !== null) {
        // macOS: the menu's event arrives on PRESS. Held back until the press says what it was.
        event.preventDefault();
        event.stopPropagation();
        owed = { target: event.target ?? root, x: event.clientX, y: event.clientY };
        return;
      }
      if (dropNext) {
        // Windows and Linux: the menu's event arrives after the release of a drag.
        dropNext = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const replayMenu = (target: EventTarget, x: number, y: number): void => {
      const MouseEventOf = win.MouseEvent;
      target.dispatchEvent(new MouseEventOf("contextmenu", { bubbles: true, cancelable: true, button: 2, buttons: 0, clientX: x, clientY: y }));
    };

    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("contextmenu", onContextMenu, true);
    win.addEventListener("pointermove", onPointerMove);
    win.addEventListener("pointerup", onPointerUp);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("contextmenu", onContextMenu, true);
      win.removeEventListener("pointermove", onPointerMove);
      win.removeEventListener("pointerup", onPointerUp);
    };
  }, [root, store, flow]);

  if (box === null) return null;
  return (
    <div
      className="react-flow__selection"
      data-testid="right-drag-selection"
      style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, pointerEvents: "none", zIndex: 6 }}
    />
  );
}
