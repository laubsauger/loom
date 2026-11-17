// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useStoreApi } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { scrollPanStore } from "./scroll-pan-command.ts";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import { installFlowStubs } from "./testing.tsx";

/**
 * §I.ui — THE GRAPH NAVIGATES AS TOUCHDESIGNER'S NETWORK EDITOR DOES (owner, 2026-11-03:
 * middle-drag to pan was the hardest thing in the editor, and on a trackpad it is not there
 * at all). `docs.derivative.ca/Network_Editor`: "Drag using the LMB in any empty area in the
 * network to pan"; a box selection is the right button, "or hold shift while dragging with
 * LMB". Held here through the library itself, on the gestures a person makes: a left drag
 * on the empty canvas MOVES THE VIEW and selects nothing; the same drag with Shift held
 * selects what it crosses and leaves the view where it was; the middle button still pans.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});

afterEach(() => {
  cleanup();
  scrollPanStore().set(false);
});

const invocation = contextFor(alice);

type FlowStore = ReturnType<typeof useStoreApi>;

function StoreProbe({ onStore }: { readonly onStore: (store: FlowStore) => void }) {
  onStore(useStoreApi());
  return null;
}

/** d3-zoom reads `event.view`, which jsdom refuses as an init member; attached after. */
function mouse(target: Element | Document, type: string, init: MouseEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView;
  if (win === null) throw new Error("no window");
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

/** The library's box selection listens for pointer events on its pane; a mouse drag is both. */
function pointer(target: Element | Document, type: string, init: PointerEventInit): void {
  const doc = target instanceof Document ? target : target.ownerDocument;
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  if (win === null) throw new Error("no window");
  const Ctor = win.PointerEvent ?? win.MouseEvent;
  const event = new Ctor(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, ...init });
  Object.defineProperty(event, "view", { value: win });
  target.dispatchEvent(event);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function mountCanvas() {
  const { bus } = createHarness("nav");
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  await act(async () => {
    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [
        { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 240, y: 40 } },
      ], "seed"),
      invocation,
    );
  });
  let store: FlowStore | null = null;
  const underlay = <StoreProbe onStore={(found) => { store = found; }} />;
  const view = render(<GraphCanvas bus={bus} invocation={invocation} runtime={runtime} underlay={underlay} />);
  await waitFor(() => expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2));
  await settle();
  await settle();
  const pane = view.container.querySelector(".react-flow__pane");
  if (pane === null || store === null) throw new Error("the canvas did not mount");
  const flow = store as FlowStore;
  const selected = (): number => flow.getState().nodes.filter((node) => node.selected === true).length;
  return { pane, flow, selected };
}

/**
 * A drag on the empty canvas with `button`, from `from` to `to` in twenty steps. The canvas is
 * 1024 × 768 here (`installDomStubs`); a drag that ends near its edge would also auto-pan.
 */
async function dragOnPane(
  pane: Element,
  button: 0 | 1,
  buttons: number,
  from = { clientX: 900, clientY: 650 },
  to = { clientX: 200, clientY: 150 },
): Promise<void> {
  await act(async () => {
    pointer(pane, "pointerdown", { button, buttons, ...from });
    mouse(pane, "mousedown", { button, buttons, ...from });
    for (let step = 1; step <= 20; step += 1) {
      const at = {
        clientX: from.clientX + ((to.clientX - from.clientX) * step) / 20,
        clientY: from.clientY + ((to.clientY - from.clientY) * step) / 20,
      };
      pointer(pane, "pointermove", { button, buttons, ...at });
      mouse(pane.ownerDocument, "mousemove", { button, buttons, ...at });
    }
    pointer(pane, "pointerup", { button, buttons: 0, ...to });
    mouse(pane.ownerDocument, "mouseup", { button, buttons: 0, ...to });
  });
  await settle();
}

describe("§I.ui — the graph navigates as TouchDesigner's network editor does", () => {
  it("a LEFT drag on the empty canvas pans the view and selects nothing", async () => {
    const { pane, flow, selected } = await mountCanvas();
    const before = flow.getState().transform;
    await dragOnPane(pane, 0, 1);
    const after = flow.getState().transform;
    expect([after[0], after[1]], "the view did not move").not.toEqual([before[0], before[1]]);
    expect(after[2], "a pan changed the zoom").toBe(before[2]);
    expect(selected(), "a pan selected nodes").toBe(0);
  });

  it("the same drag with Shift held selects what it crosses and leaves the view where it was", async () => {
    const { pane, flow, selected } = await mountCanvas();
    // Both nodes mid-canvas, inside the drag's box: (300, 250) and (540, 290) at zoom 1.
    await act(async () => {
      flow.setState({ transform: [300, 250, 1] });
    });
    const before = flow.getState().transform;
    await act(async () => {
      pane.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true }));
    });
    await dragOnPane(pane, 0, 1);
    await act(async () => {
      pane.ownerDocument.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true }));
    });
    expect(flow.getState().transform, "a box selection moved the view").toEqual(before);
    expect(selected(), "the box did not select both nodes it crossed").toBe(2);
  });

  it("a click on the empty canvas deselects, as TouchDesigner's does", async () => {
    const { pane, flow, selected } = await mountCanvas();
    await act(async () => {
      flow.getState().addSelectedNodes(flow.getState().nodes.map((node) => node.id));
    });
    await settle();
    expect(selected(), "the precondition: both nodes are selected").toBe(2);
    const at = { clientX: 900, clientY: 650 };
    await act(async () => {
      pointer(pane, "pointerdown", { button: 0, buttons: 1, ...at });
      mouse(pane, "mousedown", { button: 0, buttons: 1, ...at });
      pointer(pane, "pointerup", { button: 0, buttons: 0, ...at });
      mouse(pane.ownerDocument, "mouseup", { button: 0, buttons: 0, ...at });
      mouse(pane, "click", { button: 0, ...at });
    });
    await settle();
    expect(selected()).toBe(0);
  });

  it("the middle button still pans", async () => {
    const { pane, flow } = await mountCanvas();
    const before = flow.getState().transform;
    await dragOnPane(pane, 1, 4);
    const after = flow.getState().transform;
    expect([after[0], after[1]]).not.toEqual([before[0], before[1]]);
  });
});

/** One wheel event over the pane; `ctrlKey` is what a trackpad pinch arrives as. */
async function wheel(pane: Element, init: WheelEventInit): Promise<void> {
  const win = pane.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (win === null) throw new Error("no window");
  await act(async () => {
    for (let step = 0; step < 4; step += 1) {
      const event = new win.WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 500, clientY: 400, ...init });
      Object.defineProperty(event, "view", { value: win });
      pane.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await settle();
}

describe("§I.ui, T1724b — what a two-finger scroll does is the person's choice", () => {
  it("by default the wheel zooms, as TouchDesigner's does", async () => {
    const { pane, flow } = await mountCanvas();
    const before = flow.getState().transform;
    await wheel(pane, { deltaY: -60 });
    expect(flow.getState().transform[2], "the wheel did not zoom").not.toBe(before[2]);
  });

  it("with Scroll pans on, a scroll moves the view and keeps the zoom; a pinch still zooms", async () => {
    const { pane, flow } = await mountCanvas();
    await act(async () => {
      scrollPanStore().set(true);
    });
    await settle();
    const before = flow.getState().transform;
    await wheel(pane, { deltaX: 30, deltaY: 40 });
    const panned = flow.getState().transform;
    expect(panned[2], "a scroll zoomed").toBe(before[2]);
    expect([panned[0], panned[1]], "a scroll did not move the view").not.toEqual([before[0], before[1]]);
    await wheel(pane, { deltaY: -20, ctrlKey: true });
    expect(flow.getState().transform[2], "a pinch did not zoom").not.toBe(panned[2]);
  });
});

describe("§I.ui, T1724b — TouchDesigner's right-drag box selection, beside the right-click menu", () => {
  /** `contextmenu` events that reach the document unprevented: what the canvas menu host hears. */
  function menuEvents(doc: Document): { readonly count: () => number; readonly off: () => void } {
    let count = 0;
    const listener = (event: Event): void => {
      if (!event.defaultPrevented) count += 1;
    };
    doc.addEventListener("contextmenu", listener);
    return { count: () => count, off: () => doc.removeEventListener("contextmenu", listener) };
  }

  /** A right press on the pane, `steps` moves toward `to`, a release; the menu event where `order` puts it. */
  async function rightGesture(pane: Element, order: "on-press" | "on-release", to: { clientX: number; clientY: number }, steps: number): Promise<void> {
    const from = { clientX: 900, clientY: 650 };
    await act(async () => {
      pointer(pane, "pointerdown", { button: 2, buttons: 2, ...from });
      if (order === "on-press") mouse(pane, "contextmenu", { button: 2, buttons: 2, ...from });
      for (let step = 1; step <= steps; step += 1) {
        pointer(pane, "pointermove", {
          button: 2,
          buttons: 2,
          clientX: from.clientX + ((to.clientX - from.clientX) * step) / steps,
          clientY: from.clientY + ((to.clientY - from.clientY) * step) / steps,
        });
      }
      pointer(pane, "pointerup", { button: 2, buttons: 0, ...to });
      if (order === "on-release") mouse(pane, "contextmenu", { button: 2, buttons: 0, ...to });
    });
    await settle();
  }

  for (const order of ["on-press", "on-release"] as const) {
    it(`a right DRAG selects what it crosses, leaves the view, and opens no menu (menu event ${order})`, async () => {
      const { pane, flow, selected } = await mountCanvas();
      await act(async () => {
        flow.setState({ transform: [300, 250, 1] });
      });
      const before = flow.getState().transform;
      const menus = menuEvents(pane.ownerDocument);
      await rightGesture(pane, order, { clientX: 200, clientY: 150 }, 20);
      menus.off();
      expect(selected(), "the box did not select both nodes it crossed").toBe(2);
      expect(flow.getState().transform).toEqual(before);
      expect(menus.count(), "a drag opened the canvas menu").toBe(0);
    });

    it(`a right CLICK still opens the canvas menu, once, and selects nothing (menu event ${order})`, async () => {
      const { pane, selected } = await mountCanvas();
      const menus = menuEvents(pane.ownerDocument);
      await rightGesture(pane, order, { clientX: 900, clientY: 650 }, 0);
      menus.off();
      expect(menus.count(), "the menu did not open exactly once").toBe(1);
      expect(selected()).toBe(0);
    });
  }
});
