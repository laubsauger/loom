// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { NodePreviewSlot } from "./node-preview-slot.tsx";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";

/**
 * §B174 — THE PUBLISHED SLOT BOX IS NODE-LOCAL, AT EVERY APPLIED TRANSFORM.
 *
 * The slot measures itself with `getBoundingClientRect()`, which reports the transform
 * the DOM is CARRYING, and converts to node-local px. What it divides by has to be that
 * SAME transform. Dividing by React Flow's STORE zoom instead put two sources on either
 * side of one equation, and the two sit on opposite sides of the paint boundary a
 * ResizeObserver callback lands on — so a lost race publishes a box off by
 * (applied / decided), which `use-node-previews` then multiplies by zoom AGAIN. The error
 * is multiplicative, it latches (only a slot RESIZE re-measures; a transform change never
 * does), and at a fitView zoom of 0.24 it draws every tile four times its node: the
 * owner's screenshot, reproduced in real Chrome by `scratchpad/b174/race-repro.mjs`.
 *
 * So the invariant is §V142's, at the measurement rather than at the allocation: the
 * slot's box derives from its NODE, never from zoom. The test drives the same slot at two
 * applied scales and demands ONE answer — which is why it fails on the old code whichever
 * way the race is lost, rather than only for the direction a fixture happened to pick.
 */

beforeAll(() => {
  installDomStubs();
  // Gives every element `offsetWidth` 178 — the node's UNTRANSFORMED layout width, which
  // is the reading the applied scale is derived from.
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NODE = "n1" as NodeId;
/** `installFlowStubs`' layout width for every element; the node's own, here. */
const NODE_LAYOUT_WIDTH = 178;
/** The slot inside the node, in the node's own (graph-space) px — the expected answer. */
const SLOT_LOCAL = { x: 9, y: 31, width: 160, height: 90 };

const IDLE_SNAPSHOT = { preview: null } as never;
const idleRuntime: NodeRuntimeSource = {
  subscribe: () => () => {},
  get: () => IDLE_SNAPSHOT,
};

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Lays the node and its slot out as the browser would with `scale` applied to the
 * viewport and the graph panned to `pan` — the rects are TRANSFORMED, the way
 * `getBoundingClientRect` reports them, while `offsetWidth` stays untransformed.
 */
function installLayout(scale: number, pan: { x: number; y: number }): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    if (this.classList.contains("react-flow__node")) {
      return domRect(pan.x, pan.y, NODE_LAYOUT_WIDTH * scale, 120 * scale);
    }
    return domRect(
      pan.x + SLOT_LOCAL.x * scale,
      pan.y + SLOT_LOCAL.y * scale,
      SLOT_LOCAL.width * scale,
      SLOT_LOCAL.height * scale,
    );
  });
}

function measuredAt(scale: number, pan: { x: number; y: number }) {
  installLayout(scale, pan);
  const bounds = createPreviewSlotBounds();
  render(
    <ReactFlowProvider>
      <div className="react-flow__node">
        <NodePreviewSlot nodeId={NODE} runtime={idleRuntime} bounds={bounds} />
      </div>
    </ReactFlowProvider>,
  );
  return bounds.get(NODE);
}

/** Float noise from a non-power-of-two scale is not the subject; a factor of four is. */
function expectLocal(box: unknown): void {
  const b = box as { x: number; y: number; width: number; height: number };
  expect(b.x).toBeCloseTo(SLOT_LOCAL.x, 6);
  expect(b.y).toBeCloseTo(SLOT_LOCAL.y, 6);
  expect(b.width).toBeCloseTo(SLOT_LOCAL.width, 6);
  expect(b.height).toBeCloseTo(SLOT_LOCAL.height, 6);
}

describe("§B174 preview slot bounds", () => {
  it("publishes the same node-local box whatever transform the DOM is carrying", () => {
    // The transform React Flow's store has DECIDED is 1 here — `ReactFlowProvider` with
    // no mounted canvas holds the default viewport — so these two cases are the same slot
    // measured with the store agreeing (scale 1) and disagreeing (scale 0.25) with the
    // DOM. A box that follows the DOM is the same in both.
    const settled = measuredAt(1, { x: 0, y: 0 });
    cleanup();
    const raced = measuredAt(0.25, { x: 640, y: -220 });

    expectLocal(settled);
    expectLocal(raced);
  });

  it("cancels pan without re-measuring, at a scale the store does not know about", () => {
    // §V111's other half: the rect DELTA between slot and node removes pan entirely, so
    // the same box comes back from a graph scrolled anywhere.
    const near = measuredAt(0.4, { x: 12, y: 8 });
    cleanup();
    const far = measuredAt(0.4, { x: -9000, y: 4300 });

    expectLocal(near);
    expectLocal(far);
  });
});
