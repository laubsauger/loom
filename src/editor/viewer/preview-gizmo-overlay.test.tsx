// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import type { Node } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";
import { NodePreviewSlot } from "./node-preview-slot.tsx";
import { PreviewGizmoOverlays } from "./preview-gizmo-overlay.tsx";
import type { PreviewGizmoTile } from "./preview-gizmo-overlay.tsx";
import { createPreviewOrbitStore } from "./preview-orbit-store.ts";
import { createPreviewSlotBounds } from "./preview-slot-bounds.ts";
import { GIZMO_LOCKED_REASON, createVec3GizmoStore } from "./vec3-gizmo-store.ts";
import type { GizmoHandle, Vec3GizmoEditor } from "./vec3-gizmo-store.ts";

/**
 * T935 — THE HANDLE IS ON THE PICTURE, IT FOLLOWS THE CAMERA, AND DRAGGING IT EDITS.
 *
 * ## What this fixture has to be able to distinguish
 *
 * §V461's lesson, which this subsystem has paid for twice: "a handle exists" is worth
 * nothing. It was true for the entire period §T892's toggle was invisible under a
 * composited tile. So every assertion here is either an EXACT NUMBER computed through the
 * same arithmetic the tile is placed with, or a structural relationship a DOM can answer.
 *
 * The letterbox is deliberately made to bite: the source is square and the slot is not, so
 * a handle placed on the SLOT rect instead of the PICTURE rect lands 74px to the left of
 * where the picture actually is. §V118 is what makes those two rectangles different, and a
 * fixture with a square slot would let the mistake pass.
 *
 * ## Why the orbit is asserted through an animation frame
 *
 * `PreviewOrbitStore.apply` notifies nobody — by design, because the preview tick samples
 * it per frame and §T714's stutter is what happens when that becomes React state. So a
 * handle that tracked only React Flow's store would stay put while the camera turned
 * underneath it. Driving real frames is the only way to fail that.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  });
});
afterEach(cleanup);

const NODE = "light1" as NodeId;

/** Neither identity nor each other, so a swapped term cannot pass (§T892's fixture rule). */
const NODE_POSITION = { x: 100, y: 50 };
const SLOT_BOX = { x: 4, y: 26, width: 170, height: 96 };
const VIEWPORT = { x: 40, y: 10, zoom: 2 };
/** SQUARE, against a 170×96 slot: §V118 pillarboxes, and the bars are 37px wide. */
const SOURCE: readonly [number, number] = [96, 96];

/*
 * The picture's screen rect, by the arithmetic `use-node-previews.ts` composites with:
 *
 *   fitted (node-local) = { x: 4 + (170 − 96) / 2, y: 26, 96 × 96 } = { 41, 26 }
 *   graph space         = { 100 + 41, 50 + 26 }                     = { 141, 76 }
 *   screen              = { 141·2 + 40, 76·2 + 10, 96·2, 96·2 }     = { 322, 162, 192, 192 }
 */
const RECT = { x: 322, y: 162, width: 192, height: 192 };

/** The stock ball rig (`compiler/preview-orbit.ts`), which every light tile is drawn with. */
const BASIS: OrbitCameraBasis = {
  eye: [0, 0, 2.6],
  lookAt: [0, 0, 0],
  fovY: Math.PI / 4,
  near: 0.1,
  far: 10,
  aspect: 1,
};

const IDLE_SNAPSHOT = { preview: null } as never;
const idleRuntime: NodeRuntimeSource = { subscribe: () => () => {}, get: () => IDLE_SNAPSHOT };

type FlowApi = ReturnType<typeof useStoreApi>;

/**
 * Straight at React Flow's store, for `preview-inspect-overlay.test.tsx`'s reason: the
 * public `setNodes`/`setViewport` are no-ops without a mounted `<ReactFlow>`, and the
 * store's own `setNodes` is what adopts a node into `nodeLookup` with the position this
 * layer places from. The handle is passed back out so a test can pan the canvas.
 */
function FlowState({ nodes, onApi }: { nodes: Node[]; onApi: (api: FlowApi) => void }) {
  const api = useStoreApi();
  useEffect(() => {
    api.getState().setNodes(nodes);
    api.setState({ transform: [VIEWPORT.x, VIEWPORT.y, VIEWPORT.zoom] });
    onApi(api);
  }, [api, nodes, onApi]);
  return null;
}

const handle = (key: string, label: string, value: readonly [number, number, number], refusal: string | null = null): GizmoHandle => ({
  key,
  label,
  value,
  refusal,
});

/** Real animation frames — the poll this layer uses for the orbit is not fakeable. */
async function frames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
}

function mount(handles: readonly GizmoHandle[], options: { withSlot?: boolean } = {}) {
  const orbits = createPreviewOrbitStore();
  const bounds = createPreviewSlotBounds();
  const calls: Array<{ entries: Readonly<Record<string, ParameterValue>>; phase: string }> = [];
  const editor: Vec3GizmoEditor = {
    setStored(nodeId, entries, phase) {
      expect(nodeId).toBe(NODE);
      calls.push({ entries, phase });
    },
  };
  const store = createVec3GizmoStore({ editor });
  const tile = (nodeId: NodeId): PreviewGizmoTile | null =>
    nodeId === NODE
      ? { basis: BASIS, orbit: orbits.get(nodeId), source: SOURCE, handles }
      : null;
  const nodes: Node[] = [{ id: NODE, position: NODE_POSITION, data: {}, width: 178, height: 120 }];
  let api: FlowApi | null = null;
  const onApi = (next: FlowApi): void => {
    api = next;
  };

  render(
    <ReactFlowProvider>
      <FlowState nodes={nodes} onApi={onApi} />
      {options.withSlot === true ? (
        <div data-testid="slot-host">
          <NodePreviewSlot
            nodeId={NODE}
            runtime={idleRuntime}
            bounds={bounds}
            orbits={orbits}
            orbitable
          />
        </div>
      ) : null}
      <PreviewGizmoOverlays bounds={bounds} tile={tile} store={store} active />
    </ReactFlowProvider>,
  );
  // Stated, not measured: jsdom lays nothing out, so the placement assertions below are
  // arithmetic on known numbers rather than on whatever a stub reports.
  act(() => bounds.publish(NODE, SLOT_BOX));
  const pan = (x: number, y: number, zoom: number): void => {
    act(() => {
      api?.setState({ transform: [x, y, zoom] });
    });
  };
  return { orbits, bounds, calls, pan };
}

const at = (key: string) => screen.getByTestId(`preview-gizmo-${NODE}-${key}`);

describe("T935 — a handle renders where its parameter is, on the PICTURE", () => {
  it("puts the look-at point in the middle of the LETTERBOXED picture, not the slot", () => {
    /*
     * (0, 0, 0) is what the tile's camera looks at, so it is dead centre of the picture:
     * 322 + 96 = 418, 162 + 96 = 258.
     *
     * This test alone CANNOT catch a handle placed from the slot rect, and that is worth
     * saying rather than discovering: a letterbox is symmetric, so the slot and the
     * picture share a centre and only their EXTENT differs. Red-verified — swapping the
     * fitted box for the raw slot leaves this green and fails the off-centre case below
     * and the drag arithmetic, which are the two that read the rect's width.
     */
    mount([handle("target", "Target", [0, 0, 0])]);
    const element = at("target");
    expect(element.style.left).toBe("418px");
    expect(element.style.top).toBe("258px");
    // Chrome ON a node, like every other piece: it scales with the canvas zoom.
    expect(element.style.getPropertyValue("--chrome-zoom")).toBe("2");
  });

  it("places an off-centre value by the perspective relation, not by a stored pixel", () => {
    // Derived here from `tan(fovY / 2)` and the picture's own width — an independent
    // statement of the same geometry, so a change of convention fails rather than hides.
    const world: readonly [number, number, number] = [0.5, 0.25, 0];
    mount([handle("position", "Position", world)]);
    const halfAtUnit = Math.tan((BASIS.fovY ?? 0) / 2);
    const ndcX = world[0] / (2.6 * halfAtUnit);
    const ndcY = world[1] / (2.6 * halfAtUnit);
    const element = at("position");
    expect(Number.parseFloat(element.style.left)).toBeCloseTo(
      RECT.x + (ndcX * 0.5 + 0.5) * RECT.width,
      2,
    );
    expect(Number.parseFloat(element.style.top)).toBeCloseTo(
      RECT.y + (0.5 - ndcY * 0.5) * RECT.height,
      2,
    );
  });

  it("draws NOTHING for a value the camera cannot see", () => {
    // A point light's default position is genuinely off the stock frame. A handle clamped
    // to the edge would claim a place the parameter does not have; the tile orbits and
    // dollies, so the value is one wheel turn from being reachable.
    mount([handle("position", "Position", [1, 2, 1.5])]);
    expect(screen.queryByTestId(`preview-gizmo-${NODE}-position`)).toBeNull();
    // The whole layer is gone, not merely empty: an always-mounted full-pane div is a
    // pane-wide invisible element, which is the shape of the bug this chrome keeps having.
    expect(screen.queryByTestId("preview-gizmo-overlays")).toBeNull();
  });

  it("FOLLOWS the canvas: a pan and a zoom move it with the picture", () => {
    /*
     * §V112 — React Flow's OWN transform, never a remembered one. At pan (5, 7) zoom 3
     * the picture's rect is { 141·3 + 5, 76·3 + 7, 288, 288 } = { 428, 235, 288, 288 },
     * so its centre — where the look-at point projects — is (572, 379).
     */
    const { pan } = mount([handle("target", "Target", [0, 0, 0])]);
    expect(at("target").style.left).toBe("418px");
    pan(5, 7, 3);
    const element = at("target");
    expect(element.style.left).toBe("572px");
    expect(element.style.top).toBe("379px");
    expect(element.style.getPropertyValue("--chrome-zoom")).toBe("3");
  });
});

describe("T935 — the handle tracks the camera, including the orbit nothing notifies about", () => {
  it("moves when the INSPECTION ORBIT turns, on an animation frame", async () => {
    /*
     * The gate that a React-store-only subscription cannot pass. `apply` writes the orbit
     * and notifies nobody; the tile redraws because the preview tick samples it per frame.
     * The handle has to sample it on the same cadence or it detaches from the picture the
     * moment the user drags the tile.
     *
     * The world value is OFF the orbit axis, so azimuth genuinely moves its pixel — a
     * point on the axis would leave this assertion measuring nothing.
     */
    const { orbits } = mount([handle("position", "Position", [0.5, 0.2, 0])]);
    const before = at("position").style.left;

    act(() => {
      orbits.setMode(NODE, "adjustable");
      orbits.apply(NODE, { azimuth: 0.7 });
    });
    await frames();

    expect(at("position").style.left).not.toBe(before);
  });

  it("comes back to the baked position when the tile goes home", async () => {
    // Leaving adjustable IS the reset (`setMode` drops the orbit), so the handle returning
    // to its stock pixel is the same statement as the tile returning to its stock framing.
    const { orbits } = mount([handle("position", "Position", [0.5, 0.2, 0])]);
    const home = at("position").style.left;
    act(() => {
      orbits.setMode(NODE, "adjustable");
      orbits.apply(NODE, { azimuth: 0.7 });
    });
    await frames();
    expect(at("position").style.left).not.toBe(home);

    act(() => orbits.setMode(NODE, "home"));
    await frames();
    expect(at("position").style.left).toBe(home);
  });
});

describe("T935 — dragging a handle edits the document", () => {
  it("writes LIVE values through the gesture and COMMITS once at the end (§V15)", () => {
    /*
     * The pointer path end to end. The press is at the handle's own centre so the grab
     * offset is zero and the numbers are the pointer's; the release closes the gesture.
     * `installDomStubs` reports the layer's rect at the origin, so client coordinates and
     * pane coordinates coincide here — the conversion itself is exercised, it just has
     * nothing to add.
     */
    const { calls } = mount([handle("target", "Target", [0, 0, 0])]);
    const element = at("target");
    fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: 418, clientY: 258 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 466, clientY: 210 });
    fireEvent.pointerUp(element, { pointerId: 1 });

    expect(calls.map((call) => call.phase)).toEqual(["live", "commit"]);
    const written = calls[0]?.entries["target"] as readonly number[] | undefined;
    expect(written).toBeDefined();
    /*
     * A quarter of the picture's half-width to the right and the same up. At the look-at
     * plane the half-width in world units is 2.6 · tan(fovY / 2), so:
     *
     *   Δndc = 48 / 96 = 0.5  →  Δworld = 0.5 · 2.6 · tan(π/8)
     */
    const halfExtent = 2.6 * Math.tan((BASIS.fovY ?? 0) / 2);
    expect(written?.[0]).toBeCloseTo(0.5 * halfExtent, 4);
    expect(written?.[1]).toBeCloseTo(0.5 * halfExtent, 4);
    // §T935(c): the depth is the value's own and the drag did not invent one.
    expect(written?.[2]).toBeCloseTo(0, 6);
  });

  it("does not TELEPORT the value when the press is off the handle's centre", () => {
    // Pressing the edge of a 12px dot and having the value jump under the cursor is the
    // clumsiness this row exists to remove.
    const { calls } = mount([handle("target", "Target", [0, 0, 0])]);
    const element = at("target");
    fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: 423, clientY: 254 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 423, clientY: 254 });
    const written = calls[0]?.entries["target"] as readonly number[] | undefined;
    expect(written?.[0]).toBeCloseTo(0, 6);
    expect(written?.[1]).toBeCloseTo(0, 6);
  });
});

describe("T935(b) — a driven handle is SHOWN, refuses the drag, and says why", () => {
  it("renders, states the reason on its name and its tooltip, and writes nothing", () => {
    /*
     * §T896's ruling one surface further out: hiding the control would make a driven
     * parameter look ungizmoable rather than currently-driven. The reason is ONE string,
     * so the tooltip, the accessible name and this assertion cannot drift — and the
     * element is deliberately not `disabled`, because a disabled control shows no tooltip
     * and the whole point is that the user can find out what owns the value.
     */
    const { calls } = mount([handle("position", "Position", [0, 0, 0], GIZMO_LOCKED_REASON)]);
    const element = at("position");
    expect(element.getAttribute("title")).toBe(GIZMO_LOCKED_REASON);
    expect(element.getAttribute("aria-label")).toContain(GIZMO_LOCKED_REASON);
    expect(element.hasAttribute("disabled")).toBe(false);
    expect(element.dataset["locked"]).toBe("true");

    fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: 418, clientY: 258 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 470, clientY: 200 });
    fireEvent.pointerUp(element, { pointerId: 1 });
    expect(calls).toEqual([]);
  });
});

describe("T935(d) — two handles on one node, independent", () => {
  it("draws both and writes only the one that was dragged", () => {
    const { calls } = mount([
      handle("position", "Position", [0, 0, 0]),
      handle("target", "Target", [0.4, 0, 0]),
    ]);
    const position = at("position");
    const target = at("target");
    expect(position.style.left).not.toBe(target.style.left);

    fireEvent.pointerDown(target, { pointerId: 2, button: 0, clientX: 460, clientY: 258 });
    fireEvent.pointerMove(target, { pointerId: 2, clientX: 480, clientY: 240 });
    fireEvent.pointerUp(target, { pointerId: 2 });

    expect(calls.every((call) => Object.keys(call.entries).join() === "target")).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual(["live", "commit"]);
  });

  it("keeps the two gestures separate: one commits without ending the other", () => {
    // The editor keys its undo transaction by node plus sorted key set, so two keys are
    // two groups. A store that kept one session per node would collapse them into one.
    const { calls } = mount([
      handle("position", "Position", [0, 0, 0]),
      handle("target", "Target", [0.4, 0, 0]),
    ]);
    fireEvent.pointerDown(at("position"), { pointerId: 1, button: 0, clientX: 418, clientY: 258 });
    fireEvent.pointerDown(at("target"), { pointerId: 2, button: 0, clientX: 460, clientY: 258 });
    fireEvent.pointerMove(at("position"), { pointerId: 1, clientX: 430, clientY: 250 });
    fireEvent.pointerUp(at("position"), { pointerId: 1 });
    fireEvent.pointerMove(at("target"), { pointerId: 2, clientX: 470, clientY: 250 });
    fireEvent.pointerUp(at("target"), { pointerId: 2 });

    expect(calls.map((call) => `${Object.keys(call.entries).join()}:${call.phase}`)).toEqual([
      "position:live",
      "position:commit",
      "target:live",
      "target:commit",
    ]);
  });
});

describe("T935 — the press belongs to the handle, never to the tile under it", () => {
  it("is NOT inside the preview slot: not composited over, and not an orbit target", () => {
    /*
     * §T892's structural argument, reused because it is the reason this layer exists. The
     * tile is composited at the slot's published rect, so a control inside the slot is
     * painted over; and the slot's own `onPointerDown` starts a camera gesture, so a
     * control inside it would arm an orbit on the way to being dragged. Being outside that
     * subtree answers both, with no `stopPropagation` for anyone to delete.
     */
    const { orbits } = mount([handle("target", "Target", [0, 0, 0])], { withSlot: true });
    const element = at("target");
    const slot = screen.getByTestId("slot-host").firstElementChild;
    expect(slot).not.toBeNull();
    expect(slot?.contains(element)).toBe(false);

    act(() => orbits.setMode(NODE, "adjustable"));
    fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: 418, clientY: 258 });
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 466, clientY: 210 });
    // The camera is checked while the mode that would have recorded a drag is still on:
    // `get` is undefined for a node whose inspection camera has never moved.
    expect(orbits.get(NODE)).toBeUndefined();
    fireEvent.pointerUp(element, { pointerId: 1 });
  });
});
