// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { CanvasFixture, fixtureContext, installFlowStubs } from "@editor/graph-canvas/testing.tsx";
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

function toggle(): HTMLElement {
  return screen.getByTestId(`preview-inspect-${NODE}`);
}

/** Drag from (100,100) to (150,80): 50px right, 20px up. `alt` selects the pan gesture. */
function drag(slot: HTMLElement, options: { alt?: boolean } = {}): void {
  fireEvent.pointerDown(slot, {
    pointerId: 1,
    button: 0,
    clientX: 100,
    clientY: 100,
    altKey: options.alt ?? false,
  });
  fireEvent.pointerMove(slot, { pointerId: 1, clientX: 150, clientY: 80 });
  fireEvent.pointerUp(slot, { pointerId: 1 });
}

describe("the preview inspection mode (T656)", () => {
  it("HOME is the default, and the toggle says so", () => {
    const { orbits } = mount(true);
    expect(orbits.mode(NODE)).toBe("home");
    expect(toggle().textContent).toBe("HOME");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("in HOME the same gestures move nothing, and the wheel still reaches the canvas", () => {
    const { orbits, slot, canvasWheel } = mount(true);

    drag(slot);
    drag(slot, { alt: true });
    fireEvent.wheel(slot, { deltaY: -100 });

    // Nothing touched the camera: the request omits `orbit` entirely, as it does today.
    expect(orbits.get(NODE)).toBeUndefined();
    // And the canvas got its wheel event, which is the whole reason T561 shipped no zoom.
    expect(canvasWheel).toHaveBeenCalledTimes(1);
    expect(slot.className).not.toMatch(/nowheel/);
  });

  it("the toggle enters ADJUSTABLE, and then the preview owns the wheel", () => {
    const { orbits, slot, canvasWheel } = mount(true);
    fireEvent.click(toggle());

    expect(orbits.mode(NODE)).toBe("adjustable");
    expect(toggle().textContent).toBe("ADJUST");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(slot.className).toMatch(/nowheel/);

    fireEvent.wheel(slot, { deltaY: -100 });
    // Scroll away from you moves IN: T561's own `distance` multiplier, shrunk.
    expect(orbits.get(NODE)?.distance).toBeCloseTo(Math.exp(-0.15), 10);
    // The canvas never saw it — nothing to fight over, which is what the mode buys.
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it("in ADJUSTABLE a drag orbits and an alt-drag pans — the camera follows the drag", () => {
    const { orbits, slot } = mount(true);
    fireEvent.click(toggle());

    drag(slot);
    expect(orbits.get(NODE)?.azimuth).toBeCloseTo(50 * 0.016, 10);
    expect(orbits.get(NODE)?.elevation).toBeCloseTo(20 * 0.016, 10); // up = negative dy = raise
    expect(orbits.get(NODE)?.panX).toBe(0);
    expect(orbits.get(NODE)?.panY).toBe(0);

    drag(slot, { alt: true });
    // The SAME motion with alt held moves the look-at instead of turning around it, and
    // the orbit angles are untouched — the two gestures are not the same knob.
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
    fireEvent.click(toggle());

    for (let index = 0; index < 60; index += 1) fireEvent.wheel(slot, { deltaY: 100 });
    expect(orbits.get(NODE)?.distance).toBe(5);
    // The dead-zone bug this prevents: an unclamped accumulator would sit at e^9 here and
    // need fifty-odd scrolls back before the picture changed at all.
    fireEvent.wheel(slot, { deltaY: -100 });
    expect(orbits.get(NODE)?.distance).toBeCloseTo(5 * Math.exp(-0.15), 10);
  });

  it("leaving ADJUSTABLE returns HOME — the toggle is also the reset", () => {
    const { orbits, slot, canvasWheel } = mount(true);
    fireEvent.click(toggle());
    drag(slot);
    fireEvent.wheel(slot, { deltaY: 100 });
    expect(orbits.get(NODE)).toBeDefined();

    fireEvent.click(toggle());

    expect(orbits.mode(NODE)).toBe("home");
    // Not "reset separately" — the orbit went with the mode, in one operation, so the two
    // cannot drift into disagreeing. An undefined orbit is the baked framing (§V528).
    expect(orbits.get(NODE)).toBeUndefined();
    expect(toggle().textContent).toBe("HOME");

    // And the tile is back to today's behaviour, wheel included.
    fireEvent.wheel(slot, { deltaY: -100 });
    expect(orbits.get(NODE)).toBeUndefined();
    expect(canvasWheel).toHaveBeenCalledTimes(1);
  });

  it("a NON-orbitable slot is never offered the mode at all", () => {
    // §T614 lives here: a texture output and a CAMERA payload both arrive with
    // `orbitable={false}`, and an affordance offering to override a camera's own matrix
    // would falsify the one thing that tile exists to show (§T639(a)'s shape).
    const { orbits, slot, canvasWheel } = mount(false);
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();

    drag(slot);
    drag(slot, { alt: true });
    fireEvent.wheel(slot, { deltaY: -100 });

    expect(orbits.get(NODE)).toBeUndefined();
    expect(orbits.mode(NODE)).toBe("home");
    expect(canvasWheel).toHaveBeenCalledTimes(1);
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

    fireEvent.click(toggle()); // the mode is not an edit either
    drag(slot); // orbit
    drag(slot, { alt: true }); // pan
    fireEvent.wheel(slot, { deltaY: -100 }); // zoom
    fireEvent.click(toggle()); // and back home

    expect(orbits.mode(NODE)).toBe("home");
    expect(bus.store.getRevision()).toBe(before);
    expect(bus.store.getGraph()).toEqual(graphBefore);
  });
});
