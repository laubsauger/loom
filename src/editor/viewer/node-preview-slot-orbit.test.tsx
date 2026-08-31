// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { NodePreviewSlot } from "./node-preview-slot.tsx";
import { createPreviewOrbitStore } from "./preview-orbit-store.ts";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";

/**
 * T561 — the inspection DRAG, at the slot.
 *
 * The owner's framing is the contract: "3d stuff needs 3d inspection without screwing
 * with its data". Two properties, both asserted with the DISTINGUISHING fixture (§V461):
 *
 *  - an ORBITABLE slot's drag writes the pane's orbit store — azimuth from horizontal
 *    motion, elevation from vertical, double-click resets;
 *  - a NON-orbitable slot with the same store wired ignores the identical gesture, so
 *    texture previews keep their plain pointer behaviour.
 *
 * The store itself holds no bus and can make no revision — "never document state" is
 * structural here, not a discipline (`preview-view.test.ts` pins the same property for
 * the lens through its command; the orbit deliberately has no command to pin).
 */

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

const NODE = "n1" as NodeId;

// One stable snapshot: useSyncExternalStore loops on a getter that mints objects.
const IDLE_SNAPSHOT = { preview: null } as never;
const idleRuntime: NodeRuntimeSource = {
  subscribe: () => () => {},
  get: () => IDLE_SNAPSHOT,
};

function mount(orbitable: boolean) {
  const orbits = createPreviewOrbitStore();
  const view = render(
    <ReactFlowProvider>
      <NodePreviewSlot
        nodeId={NODE}
        runtime={idleRuntime}
        bounds={createPreviewSlotBounds()}
        orbits={orbits}
        orbitable={orbitable}
      />
    </ReactFlowProvider>,
  );
  const slot = view.container.firstElementChild?.firstElementChild as HTMLElement;
  return { orbits, slot };
}

/** jsdom has no setPointerCapture; the handler calls it, so give elements a no-op. */
beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
});

describe("the preview inspection drag (T561)", () => {
  it("a drag orbits: right adds azimuth, up adds elevation — and double-click resets", () => {
    const { orbits, slot } = mount(true);
    fireEvent.pointerDown(slot, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(slot, { pointerId: 1, clientX: 150, clientY: 80 });
    fireEvent.pointerUp(slot, { pointerId: 1 });

    const orbit = orbits.get(NODE);
    expect(orbit).toBeDefined();
    expect(orbit?.azimuth).toBeCloseTo(50 * 0.016, 10);
    expect(orbit?.elevation).toBeCloseTo(20 * 0.016, 10); // up = negative dy = raise
    expect(orbit?.distance).toBe(1);

    // After release the gesture is over: a stray move writes nothing.
    fireEvent.pointerMove(slot, { pointerId: 1, clientX: 500, clientY: 500 });
    expect(orbits.get(NODE)).toEqual(orbit);

    fireEvent.doubleClick(slot);
    expect(orbits.get(NODE)).toBeUndefined();
  });

  it("a non-orbitable slot ignores the identical gesture — texture previews keep their pointer", () => {
    const { orbits, slot } = mount(false);
    fireEvent.pointerDown(slot, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(slot, { pointerId: 1, clientX: 150, clientY: 80 });
    fireEvent.pointerUp(slot, { pointerId: 1 });
    fireEvent.doubleClick(slot);
    expect(orbits.get(NODE)).toBeUndefined();
  });
});
