// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import type { Node } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { NodePreviewSlot } from "./node-preview-slot.tsx";
import { PreviewInspectOverlays } from "./preview-inspect-overlay.tsx";
import { createPreviewOrbitStore } from "./preview-orbit-store.ts";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
import type { PreviewOrbitStore } from "./preview-orbit-store.ts";

/**
 * T892 — THE CAMERA TOGGLE, ON THE BOTTOM-RIGHT CORNER OF THE TILE IT DRIVES.
 *
 * The owner asked three times: "overlaid on the actual preview canvas bottom right as a
 * overlay button so we can gain more space for the node title". The header half of that
 * is gated in `nodes/preview-inspect-chrome.test.tsx`; this is the half that has to be
 * true for the move to be worth anything.
 *
 * ## What the fixture has to be able to distinguish, and why
 *
 * §V461 has caught this subsystem repeatedly, always the same way: a fixture that cannot
 * see the fault. The two faults available here are not the same shape, so they need two
 * different kinds of assertion.
 *
 *  - PLACEMENT. "A button exists" is worth nothing — it was true for the whole time the
 *    control was invisible under a composited tile. So placement is asserted as EXACT
 *    NUMBERS, through the same function that positions the tile itself (`slotScreenRect`,
 *    fed the node's live position, the slot's node-local offset and the live viewport):
 *    if the button is not on the picture's corner, the arithmetic says so.
 *  - OCCLUSION. A DOM query cannot see paint, and hit testing skips a `pointer-events:
 *    none` element, so neither `elementFromPoint` nor a click can tell a visible button
 *    from a buried one (T675 recorded both dead ends; they are still dead ends). What CAN
 *    be asserted is the containment relationship that decides it: the tile is composited
 *    at the published rect of the node's preview SLOT, so "is this control a descendant of
 *    the slot?" IS the occlusion question in a form a DOM can answer. It must be `false`,
 *    and the same relationship is what stops a press on the button from starting a camera
 *    drag — one structural fact, both properties.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  // jsdom has no pointer capture; the slot's drag handler calls it.
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
});
afterEach(cleanup);

const NODE = "n1" as NodeId;

/** Where the node sits in graph space, and where its slot sits inside the node. */
const NODE_POSITION = { x: 100, y: 50 };
const SLOT_BOX = { x: 4, y: 26, width: 170, height: 96 };
/** A pan and a zoom that are neither identity nor each other, so a swap cannot pass. */
const VIEWPORT = { x: 40, y: 10, zoom: 2 };

// One stable snapshot: useSyncExternalStore loops on a getter that mints objects.
const IDLE_SNAPSHOT = { preview: null } as never;
const idleRuntime: NodeRuntimeSource = {
  subscribe: () => () => {},
  get: () => IDLE_SNAPSHOT,
};

/**
 * Puts the node and the viewport into React Flow's own store, which the layer reads.
 *
 * Straight at the store rather than through `useReactFlow()`: the public `setNodes` and
 * `setViewport` are no-ops without a mounted `<ReactFlow>` (one needs `defaultNodes` or an
 * `onNodesChange` to route through, the other needs the d3 pan-zoom instance). The store's
 * own `setNodes` action is what adopts a node into `nodeLookup` with its absolute
 * position, which is the fact this layer positions from.
 */
function FlowState({ nodes }: { nodes: Node[] }) {
  const api = useStoreApi();
  useEffect(() => {
    api.getState().setNodes(nodes);
    api.setState({ transform: [VIEWPORT.x, VIEWPORT.y, VIEWPORT.zoom] });
  }, [api, nodes]);
  return null;
}

interface MountOptions {
  /** Whether the compiler published an orbit for this node — the whole gate. */
  orbitable?: boolean;
  /** Whether the node has a measured preview slot at all (a value plot publishes none). */
  measured?: boolean;
  /** Render the real tile beside the layer, so a press can be shown not to reach it. */
  withSlot?: boolean;
}

function mount(options: MountOptions = {}) {
  const { orbitable = true, measured = true, withSlot = false } = options;
  const orbits = createPreviewOrbitStore();
  const bounds = createPreviewSlotBounds();
  const inspect = (nodeId: NodeId): PreviewOrbitStore | null =>
    orbitable && nodeId === NODE ? orbits : null;
  const nodes: Node[] = [{ id: NODE, position: NODE_POSITION, data: {}, width: 178, height: 120 }];

  render(
    <ReactFlowProvider>
      <FlowState nodes={nodes} />
      {withSlot ? (
        <div data-testid="slot-host">
          <NodePreviewSlot
            nodeId={NODE}
            runtime={idleRuntime}
            bounds={bounds}
            orbits={orbits}
            orbitable={orbitable}
          />
        </div>
      ) : null}
      <PreviewInspectOverlays bounds={bounds} inspect={inspect} />
    </ReactFlowProvider>,
  );

  // The slot publishes its own box from a ResizeObserver in the real app; here the box is
  // stated, so the placement assertion below is arithmetic on known numbers rather than on
  // whatever jsdom reports for a laid-out element (it reports zeroes).
  if (measured) act(() => bounds.publish(NODE, SLOT_BOX));
  return { orbits, bounds };
}

describe("T892 — the toggle is drawn on the tile, and only where there is a camera", () => {
  it("sits on the BOTTOM-RIGHT corner of the tile, at the tile's own screen rect", () => {
    /*
     * The exact numbers, from the same arithmetic `use-node-previews.ts` composites with:
     * the slot's graph-space box is the node's position plus the slot's offset within it,
     * and the screen rect is that scaled by the zoom and offset by the pan.
     *
     *   right  = (100 + 4 + 170) * 2 + 40 = 588
     *   bottom = (50 + 26 + 96)  * 2 + 10 = 354
     *
     * `left`/`top` carry that corner; the CSS transform pulls the button back inside by
     * its own size and an inset, which is why the corner rather than the button's origin
     * is what this asserts. `--chrome-zoom` is the scale it does that at, so the control
     * stays chrome ON a node instead of a fixed-size sticker over the canvas.
     */
    mount();
    const button = screen.getByTestId(`preview-inspect-${NODE}`);
    expect(button.style.left).toBe("588px");
    expect(button.style.top).toBe("354px");
    expect(button.style.getPropertyValue("--chrome-zoom")).toBe("2");
  });

  it("is offered ONLY where the compiler published an orbit — never on a 2D preview", () => {
    /*
     * T669, kept: a node with nothing to inspect is offered no camera at all, not a
     * disabled ghost advertising a capability it does not have. The gate is the same
     * function the node header used to consult, so a texture or value preview — which
     * reaches neither branch of the graph pane's `previewInspect` — cannot grow one.
     */
    mount({ orbitable: false });
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();
    // And the layer itself is gone, not merely empty: an always-mounted full-pane div is a
    // pane-wide invisible element, which is the shape of the bug this control keeps having.
    expect(screen.queryByTestId("preview-inspect-overlays")).toBeNull();
  });

  it("draws nothing until the node has a MEASURED slot to draw on", () => {
    // A value plot publishes no slot bounds on purpose (there is no tile to place), and a
    // button positioned from a rect nobody published would land at the pane's origin.
    mount({ measured: false });
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();
  });

  it("is ONE box in both states, and carries its name and its mode (T664)", () => {
    const { orbits } = mount();
    const button = screen.getByTestId(`preview-inspect-${NODE}`);
    const home = button.textContent;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Adjust this preview's camera");
    expect(button.getAttribute("title")).toContain("alt on tile");

    act(() => {
      orbits.setMode(NODE, "adjustable");
    });

    // The rendered content does not vary with the mode — T664's finding, which is why the
    // label is one letter — so pressing it cannot reflow or move the control.
    expect(button.textContent).toBe(home);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("title")).toContain("return home");
  });
});

describe("T892 — the press belongs to the button, never to the camera under it", () => {
  it("is NOT inside the preview slot: not composited over, and not a drag target", () => {
    /*
     * One relationship, two properties. The tile is composited at the slot's published
     * rect, so a control inside the slot is painted over (T675's whole finding); and the
     * slot's own `onPointerDown` starts an orbit, so a control inside it would arm a
     * camera drag on the way to being clicked. Being outside that subtree answers both,
     * structurally, with no `stopPropagation` for anyone to delete.
     */
    mount({ withSlot: true });
    const button = screen.getByTestId(`preview-inspect-${NODE}`);
    const slot = screen.getByTestId("slot-host").firstElementChild;
    expect(slot).not.toBeNull();
    expect(slot?.contains(button)).toBe(false);
  });

  it("clicking it toggles the mode and moves the camera by nothing at all", () => {
    /*
     * The gesture a user actually makes on a button is press-move-release-click, and on an
     * ADJUSTABLE tile every one of those events is live camera input. So the sequence is
     * fired in full and the orbit is asserted UNTOUCHED — `get` returns undefined for a
     * node whose camera has never been moved, and any drag reaching the slot writes one.
     *
     * The order matters and is not cosmetic: returning the tile home DELETES the stored
     * orbit (`setMode` — leaving adjustable is the reset), so asserting after the click
     * would pass whether or not the press had dragged the camera. The camera is checked
     * while the mode that would have recorded a drag is still on.
     */
    const { orbits } = mount({ withSlot: true });
    act(() => {
      orbits.setMode(NODE, "adjustable");
    });
    const button = screen.getByTestId(`preview-inspect-${NODE}`);

    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 150, clientY: 80 });
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(orbits.get(NODE)).toBeUndefined();

    fireEvent.click(button);
    expect(orbits.mode(NODE)).toBe("home");
  });
});
