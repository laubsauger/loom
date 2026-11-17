// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import { GraphCanvas } from "@editor/graph-canvas/graph-canvas.tsx";
import { createNodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { fixtureContext, installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { NodePreviewSlot } from "./node-preview-slot.tsx";
import { createPreviewOrbitStore } from "./preview-orbit-store.ts";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";

/**
 * T561/T656 — preview inspection is a MODE, at the slot.
 *
 * The owner's framing is the contract twice over. T561: "3d stuff needs 3d inspection
 * without screwing with its data". T656/T613: "touchdesigner solves this by toggling the
 * mode of the preview from its default/home to adjustable so that its clear what needs to
 * happen and we can turn that off again."
 *
 * That second sentence is what these tests are built around, and it is why the negative
 * half of every property is asserted beside the positive one (§V461): a test proving the
 * wheel zooms in adjustable mode passes trivially, and says nothing about the thing the
 * owner actually asked for, which is that the mode TURNS OFF. So for each gesture:
 *
 *  - in ADJUSTABLE mode it moves the inspection camera;
 *  - in HOME mode the IDENTICAL event moves nothing, and the wheel still reaches the
 *    canvas ancestor exactly as it does today (that is what "the tile behaves exactly as
 *    it does today" has to mean for an event the graph zoom consumes);
 *  - leaving adjustable RETURNS HOME — the mode is also the reset (T561's double-click
 *    reset is subsumed by it, not duplicated beside it);
 *  - and none of it mints a document revision, asserted against a REAL bus in the tree.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  // jsdom has no pointer capture; the handler calls it, so give elements a no-op.
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
});
afterEach(cleanup);

const NODE = "n1" as NodeId;

// One stable snapshot: useSyncExternalStore loops on a getter that mints objects.
const IDLE_SNAPSHOT = { preview: null } as never;
const idleRuntime: NodeRuntimeSource = {
  subscribe: () => () => {},
  get: () => IDLE_SNAPSHOT,
};

/**
 * The slot inside a stand-in for the canvas: `canvasWheel` is a NATIVE listener on an
 * ancestor, which is what React Flow's d3-zoom actually is. A React synthetic handler
 * would be the wrong fixture — it cannot observe the propagation stop that matters.
 */
function mount(orbitable: boolean) {
  const orbits = createPreviewOrbitStore();
  const canvasWheel = vi.fn();
  const view = render(
    <ReactFlowProvider>
      <div data-testid="canvas">
        <NodePreviewSlot
          nodeId={NODE}
          runtime={idleRuntime}
          bounds={createPreviewSlotBounds()}
          orbits={orbits}
          orbitable={orbitable}
        />
      </div>
    </ReactFlowProvider>,
  );
  const canvas = view.getByTestId("canvas");
  canvas.addEventListener("wheel", canvasWheel);
  const slot = canvas.firstElementChild as HTMLElement;
  return { orbits, slot, canvasWheel };
}

/**
 * Drag from (100,100) to (150,80): 50px right, 20px up.
 *
 * `alt` is T675's ENTRY modifier — it reaches the camera with no prior click on anything —
 * and `shift` selects PAN, which T675 moved off alt so that alt could mean one thing.
 */
function drag(slot: HTMLElement, options: { alt?: boolean; shift?: boolean } = {}): void {
  fireEvent.pointerDown(slot, {
    pointerId: 1,
    button: 0,
    clientX: 100,
    clientY: 100,
    altKey: options.alt ?? false,
    shiftKey: options.shift ?? false,
  });
  fireEvent.pointerMove(slot, { pointerId: 1, clientX: 150, clientY: 80 });
  fireEvent.pointerUp(slot, { pointerId: 1 });
}

type FlowStore = ReturnType<typeof useStoreApi>;

function FlowProbe({ onStore }: { onStore: (store: FlowStore) => void }) {
  onStore(useStoreApi());
  return null;
}

/** A real primary mouse gesture, including the native events React Flow's drag sees. */
function primaryShiftDrag(slot: HTMLElement): void {
  const from = { clientX: 200, clientY: 180 };
  const to = { clientX: 550, clientY: 480 };
  const init = { button: 0, shiftKey: true, pointerId: 1, isPrimary: true };
  const mouse = (target: Element | Document, type: string, at: MouseEventInit): void => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at });
    // d3-zoom reads event.view; jsdom does not accept it in the event initializer.
    Object.defineProperty(event, "view", { value: window });
    target.dispatchEvent(event);
  };
  // A canceled primary pointerdown suppresses compatibility mouse events in browsers.
  const compatibilityMouse = fireEvent.pointerDown(slot, { ...init, buttons: 1, ...from });
  if (compatibilityMouse) mouse(slot, "mousedown", { ...init, buttons: 1, ...from });
  fireEvent.pointerMove(slot, { ...init, buttons: 1, ...to });
  if (compatibilityMouse) mouse(document, "mousemove", { ...init, buttons: 1, ...to });
  fireEvent.pointerUp(slot, { ...init, buttons: 0, ...to });
  if (compatibilityMouse) mouse(document, "mouseup", { ...init, buttons: 0, ...to });
}

describe("the preview inspection mode (T656)", () => {
  it("in the real graph SHIFT-drag pans an adjustable preview; HOME still box-selects", async () => {
    const { bus } = createHarness("orbit");
    const invocation = contextFor(alice);
    await bus.execute("graph.applyPatch", patch(bus.store.getRevision(), [
      { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
    ]), invocation);
    const nodeId = Object.values(bus.store.getGraph().nodes)[0]!.id;
    const runtime = createNodeRuntimeStore({ intervalMs: 0 });
    const orbits = createPreviewOrbitStore();
    const bounds = createPreviewSlotBounds();
    let captured: FlowStore | null = null;
    const view = render(
      <GraphCanvas
        bus={bus}
        invocation={invocation}
        runtime={runtime}
        underlay={<FlowProbe onStore={(store) => { captured = store; }} />}
        renderPreview={(id) => (
          <NodePreviewSlot nodeId={id} runtime={runtime} bounds={bounds} orbits={orbits} orbitable />
        )}
      />,
    );
    await waitFor(() => expect(view.container.querySelector("[data-inspect]")).not.toBeNull());
    if (captured === null) throw new Error("the graph store did not mount");
    const flow = captured as FlowStore;
    await waitFor(() => expect(flow.getState().nodeLookup.get(nodeId)?.measured.width).toBeGreaterThan(0));
    const slot = view.container.querySelector<HTMLElement>("[data-inspect]");
    if (slot === null) throw new Error("the preview slot did not mount");
    await act(async () => {
      flow.setState({ transform: [300, 250, 1] });
      orbits.setMode(nodeId, "adjustable");
      fireEvent.keyDown(document, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    });
    const transform = flow.getState().transform;
    const revision = bus.store.getRevision();
    const graph = bus.store.getGraph();

    await act(async () => primaryShiftDrag(slot));

    expect(orbits.get(nodeId)).toMatchObject({ azimuth: 0, elevation: 0, panX: 1.75, panY: -1.5 });
    expect(flow.getState().transform).toEqual(transform);
    expect(flow.getState().userSelectionRect).toBeNull();
    expect(flow.getState().nodes.some((node) => node.selected)).toBe(false);
    expect(bus.store.getRevision()).toBe(revision);
    expect(bus.store.getGraph()).toEqual(graph);

    await act(async () => orbits.setMode(nodeId, "home"));
    await act(async () => primaryShiftDrag(slot));

    expect(orbits.get(nodeId)).toBeUndefined();
    expect(flow.getState().nodes.find((node) => node.id === nodeId)?.selected).toBe(true);
    expect(flow.getState().transform).toEqual(transform);
    expect(bus.store.getRevision()).toBe(revision);
    await act(async () => {
      fireEvent.keyUp(document, { key: "Shift", code: "ShiftLeft" });
    });
  });

  it("HOME is the default, and the slot draws no control of its own (T675)", () => {
    const { orbits, slot } = mount(true);
    expect(orbits.mode(NODE)).toBe("home");
    // The toggle is NOT here any more and must not come back: anything rendered inside
    // this box is painted over by the composited tile. T892 put the control back on the
    // picture through a PANE-level layer that never enters this stacking context
    // (`preview-inspect-overlay.test.tsx` holds the containment invariant); this is the
    // local half, so a well-meaning re-add into the slot fails twice.
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();
    expect(slot.getAttribute("data-inspect")).toBe("home");
  });

  it("in HOME the same gestures move nothing, and the wheel still reaches the canvas", () => {
    const { orbits, slot, canvasWheel } = mount(true);

    drag(slot);
    drag(slot, { shift: true });
    fireEvent.wheel(slot, { deltaY: -100 });

    // Nothing touched the camera: the request omits `orbit` entirely, as it does today.
    // NOTE the alt drag is deliberately absent from this list — after T675 alt is the way
    // IN, and its own test below asserts that it works from exactly this state.
    expect(orbits.get(NODE)).toBeUndefined();
    // And the canvas got its wheel event, which is the whole reason T561 shipped no zoom.
    expect(canvasWheel).toHaveBeenCalledTimes(1);
    expect(slot.className).not.toMatch(/nowheel/);
  });

  it("ADJUSTABLE gives the preview the wheel", () => {
    const { orbits, slot, canvasWheel } = mount(true);
    act(() => orbits.setMode(NODE, "adjustable"));

    expect(orbits.mode(NODE)).toBe("adjustable");
    expect(slot.getAttribute("data-inspect")).toBe("adjustable");
    expect(slot.className).toMatch(/nowheel/);

    fireEvent.wheel(slot, { deltaY: -100 });
    // Scroll away from you moves IN: T561's own `distance` multiplier, shrunk.
    expect(orbits.get(NODE)?.distance).toBeCloseTo(Math.exp(-0.15), 10);
    // The canvas never saw it — nothing to fight over, which is what the mode buys.
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it("in ADJUSTABLE a drag orbits and a SHIFT-drag pans — the camera follows the drag", () => {
    const { orbits, slot } = mount(true);
    act(() => orbits.setMode(NODE, "adjustable"));

    drag(slot);
    expect(orbits.get(NODE)?.azimuth).toBeCloseTo(50 * 0.016, 10);
    expect(orbits.get(NODE)?.elevation).toBeCloseTo(20 * 0.016, 10); // up = negative dy = raise
    expect(orbits.get(NODE)?.panX).toBe(0);
    expect(orbits.get(NODE)?.panY).toBe(0);

    drag(slot, { shift: true });
    // The SAME motion with shift held moves the look-at instead of turning around it, and
    // the orbit angles are untouched — the two gestures are not the same knob. Shift, not
    // alt: T675 needed alt for the entry path, and one key cannot mean two things.
    expect(orbits.get(NODE)?.panX).toBeCloseTo(50 * 0.005, 10);
    expect(orbits.get(NODE)?.panY).toBeCloseTo(20 * 0.005, 10);
    expect(orbits.get(NODE)?.azimuth).toBeCloseTo(50 * 0.016, 10);

    // After release the gesture is over: a stray move writes nothing.
    const settled = orbits.get(NODE);
    fireEvent.pointerMove(slot, { pointerId: 1, clientX: 500, clientY: 500 });
    expect(orbits.get(NODE)).toEqual(settled);
  });

  it("the wheel clamps, so scrolling out twenty times then back in still moves", () => {
    const { orbits, slot } = mount(true);
    act(() => orbits.setMode(NODE, "adjustable"));

    for (let index = 0; index < 60; index += 1) fireEvent.wheel(slot, { deltaY: 100 });
    expect(orbits.get(NODE)?.distance).toBe(5);
    // The dead-zone bug this prevents: an unclamped accumulator would sit at e^9 here and
    // need fifty-odd scrolls back before the picture changed at all.
    fireEvent.wheel(slot, { deltaY: -100 });
    expect(orbits.get(NODE)?.distance).toBeCloseTo(5 * Math.exp(-0.15), 10);
  });

  it("leaving ADJUSTABLE returns HOME — the mode is also the reset", () => {
    const { orbits, slot, canvasWheel } = mount(true);
    act(() => orbits.setMode(NODE, "adjustable"));
    drag(slot);
    fireEvent.wheel(slot, { deltaY: 100 });
    expect(orbits.get(NODE)).toBeDefined();

    act(() => orbits.setMode(NODE, "home"));

    expect(orbits.mode(NODE)).toBe("home");
    // Not "reset separately" — the orbit went with the mode, in one operation, so the two
    // cannot drift into disagreeing. An undefined orbit is the baked framing (§V528).
    expect(orbits.get(NODE)).toBeUndefined();
    expect(slot.getAttribute("data-inspect")).toBe("home");

    // And the tile is back to today's behaviour, wheel included.
    fireEvent.wheel(slot, { deltaY: -100 });
    expect(orbits.get(NODE)).toBeUndefined();
    expect(canvasWheel).toHaveBeenCalledTimes(1);
  });

  /**
   * T675 — THE MODIFIER PATH, and this is the test the whole task turns on.
   *
   * The owner: "cant use orbit or any camera controls here in this geometry node… imo
   * this should be something they inherit from a common thing". Geometry was orbitable
   * the whole time and had been since T561 — what they could not do was FIND THE WAY IN.
   *
   * §V461 is why these assertions are shaped the way they are. T656's gate passed while
   * the control was unusable, because a test can click a button by test-id that a human
   * cannot see, and T675 then found the button was painted UNDER the composited tile. So
   * the property asserted here is deliberately not "a control exists": it is that THE
   * CAMERA IS REACHABLE WITH NO PRIOR CLICK ON ANY CONTROL AT ALL. Nothing in this suite
   * touches a toggle before the modifier runs, and there is no toggle in this tree to
   * touch — the slot renders none (T675 moved it to the node header, out from under the
   * surface). A regression that made the modifier a no-op would leave `orbits.get(NODE)`
   * undefined here whatever the chrome looked like.
   */
  it("ALT-drag reaches the camera from HOME, with no toggle pressed first", () => {
    const { orbits, slot } = mount(true);
    expect(orbits.mode(NODE)).toBe("home");
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();

    drag(slot, { alt: true });

    // It ENTERED the mode and ORBITED in the same gesture. Both halves matter: an entry
    // that only armed the tile would make the owner's first alt-drag do nothing visible,
    // which is the failure mode they already reported once.
    expect(orbits.mode(NODE)).toBe("adjustable");
    expect(orbits.get(NODE)?.azimuth).toBeCloseTo(50 * 0.016, 10);
    expect(orbits.get(NODE)?.elevation).toBeCloseTo(20 * 0.016, 10);
    expect(orbits.get(NODE)?.panX).toBe(0);

    // And it LATCHES: alt is released with the pointer, and the tile stays live so the
    // next plain drag keeps orbiting. Leaving is explicit (the toggle, or `h`).
    drag(slot);
    expect(orbits.get(NODE)?.azimuth).toBeCloseTo(100 * 0.016, 10);
  });

  it("ALT held over a HOME tile PEEKS, and releasing it puts the tile back", () => {
    /*
     * The discovery half: the key alone makes the camera live, so the state announces
     * itself before any gesture. It must not latch — sweeping the canvas with alt down
     * would otherwise leave every tile it passed holding the wheel, which is a worse
     * version of the bug being fixed here.
     */
    const { orbits, slot, canvasWheel } = mount(true);
    fireEvent.pointerEnter(slot);

    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(orbits.mode(NODE)).toBe("adjustable");
    expect(slot.className).toMatch(/nowheel/);

    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    expect(orbits.mode(NODE)).toBe("home");
    // The negative half §V461 asks for: the wheel is the canvas's again, through the same
    // native ancestor listener d3-zoom really is.
    fireEvent.wheel(slot, { deltaY: -100 });
    expect(orbits.get(NODE)).toBeUndefined();
    expect(canvasWheel).toHaveBeenCalledTimes(1);
  });

  it("a peek that was USED is committed — releasing alt does not undo the adjustment", () => {
    const { orbits, slot } = mount(true);
    fireEvent.pointerEnter(slot);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });

    drag(slot); // the user did something with it
    fireEvent.keyUp(window, { key: "Alt", altKey: false });

    expect(orbits.mode(NODE)).toBe("adjustable");
    expect(orbits.get(NODE)?.azimuth).toBeCloseTo(50 * 0.016, 10);
  });

  it("a peek ends when the pointer leaves — alt released off-window never arrives", () => {
    const { orbits, slot } = mount(true);
    fireEvent.pointerEnter(slot);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(orbits.mode(NODE)).toBe("adjustable");

    fireEvent.pointerLeave(slot);
    expect(orbits.mode(NODE)).toBe("home");
  });

  it("`h` over an ADJUSTABLE tile returns it home; `H` is the canvas's and stays so", () => {
    // TD's muscle memory (T664). `h` is free by an earlier deliberate decision, not by
    // luck: `defaults.ts` binds shifted `H` to `view.home` and records why lowercase was
    // left out — so the negative half here is that the canvas binding is untouched.
    const { orbits, slot } = mount(true);
    act(() => orbits.setMode(NODE, "adjustable"));
    fireEvent.wheel(slot, { deltaY: 100 });
    expect(orbits.get(NODE)).toBeDefined();

    // Not hovering yet: the key does nothing, so `h` is not swallowed canvas-wide.
    fireEvent.keyDown(window, { key: "h" });
    expect(orbits.mode(NODE)).toBe("adjustable");

    fireEvent.pointerEnter(slot);
    fireEvent.keyDown(window, { key: "H" }); // the canvas's own binding, untouched
    expect(orbits.mode(NODE)).toBe("adjustable");

    fireEvent.keyDown(window, { key: "h" });
    expect(orbits.mode(NODE)).toBe("home");
    expect(orbits.get(NODE)).toBeUndefined();

    // And once home, the listener is gone: `h` is the canvas's again.
    const swallowed = vi.fn();
    window.addEventListener("keydown", swallowed);
    fireEvent.keyDown(window, { key: "h" });
    expect(swallowed).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", swallowed);
  });

  it("a NON-orbitable slot is never offered the mode at all", () => {
    // §T614 lives here: a texture output and a CAMERA payload both arrive with
    // `orbitable={false}`, and an affordance offering to override a camera's own matrix
    // would falsify the one thing that tile exists to show (§T639(a)'s shape).
    const { orbits, slot, canvasWheel } = mount(false);
    expect(slot.getAttribute("data-inspect")).toBeNull();

    drag(slot);
    // The ENTRY modifier too: a slot that is not orbitable cannot be talked into it.
    drag(slot, { alt: true });
    fireEvent.wheel(slot, { deltaY: -100 });

    expect(orbits.get(NODE)).toBeUndefined();
    expect(orbits.mode(NODE)).toBe("home");
    expect(canvasWheel).toHaveBeenCalledTimes(1);
  });

  it("an orbitable slot leaves ordinary presses to the node in HOME", () => {
    const { slot } = mount(true);
    expect(slot.getAttribute("data-inspect")).toBe("home");
    expect(slot.classList.contains("nodrag")).toBe(false);
    expect(slot.classList.contains("nopan")).toBe(false);
    const nodePress = vi.fn();
    slot.parentElement?.addEventListener("mousedown", nodePress);
    fireEvent.mouseDown(slot, { button: 0 });
    expect(nodePress).toHaveBeenCalledOnce();
  });

  it("camera presses stay out of React Flow, including Alt entry directly from HOME", () => {
    const { slot, orbits } = mount(true);
    const nodePress = vi.fn();
    slot.parentElement?.addEventListener("mousedown", nodePress);
    // React Flow's native mousedown listener must never see the camera's press,
    // including one whose pointerdown has not yet committed the mode's classes.
    fireEvent.mouseDown(slot, { button: 0, altKey: true });
    expect(nodePress).not.toHaveBeenCalled();
    act(() => orbits.setMode(NODE, "adjustable"));
    expect(slot.classList.contains("nodrag")).toBe(true);
    expect(slot.classList.contains("nopan")).toBe(true);
    fireEvent.mouseDown(slot, { button: 0 });
    expect(nodePress).not.toHaveBeenCalled();
    act(() => orbits.setMode(NODE, "home"));
    expect(slot.classList.contains("nodrag")).toBe(false);
    fireEvent.mouseDown(slot, { button: 0 });
    expect(nodePress).toHaveBeenCalledOnce();
  });

  it("a NON-orbitable slot leaves the press to the node", () => {
    const { slot } = mount(false);
    expect(slot.classList.contains("nodrag")).toBe(false);
    expect(slot.classList.contains("nopan")).toBe(false);
  });
});

describe("§V527 — inspection is VIEW state: no gesture mints a revision", () => {
  /**
   * The structural half of this is `no-document-store.test.ts`, which fails the build if
   * anything in this directory so much as IMPORTS the command bus or the graph store —
   * "never document state" is unreachable here, not a rule someone must remember.
   *
   * This is the behavioural half, and it is the direct analogue of the lens's own
   * assertion (`preview-view.test.ts`): a REAL bus and a REAL store sit in the tree above
   * the slot, so a future toggle that decided to dispatch a command would have somewhere
   * to dispatch it — and this test would go red rather than quietly passing.
   */
  it("orbit, pan, zoom and the toggle itself leave the revision and the graph alone", () => {
    const store = createGraphStore({ ids: createSequentialIdFactory("n") });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const { value } = fixtureContext({ store: bus.store, registry: bus.registry });
    const orbits = createPreviewOrbitStore();

    const view = render(
      <CanvasFixture value={value}>
        <NodePreviewSlot
          nodeId={NODE}
          runtime={idleRuntime}
          bounds={createPreviewSlotBounds()}
          orbits={orbits}
          orbitable
        />
      </CanvasFixture>,
    );
    const slot = view.container.querySelector("[data-inspect]") as HTMLElement;
    const before = bus.store.getRevision();
    const graphBefore = bus.store.getGraph();

    drag(slot, { alt: true }); // the modifier enters the mode AND orbits
    drag(slot); // orbit
    drag(slot, { shift: true }); // pan
    fireEvent.wheel(slot, { deltaY: -100 }); // zoom
    act(() => orbits.setMode(NODE, "home")); // and back home

    expect(orbits.mode(NODE)).toBe("home");
    expect(bus.store.getRevision()).toBe(before);
    expect(bus.store.getGraph()).toEqual(graphBefore);
  });
});
