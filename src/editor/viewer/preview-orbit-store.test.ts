import { describe, expect, it, vi } from "vitest";

import type { NodeId } from "@domain/types/ids.ts";
import { createPreviewOrbitStore } from "./preview-orbit-store.ts";

/**
 * T656 — the inspection store, on its own.
 *
 * The slot's tests drive this through a component, and a component test cannot tell the
 * store's gate from the component's: both refuse a home-mode gesture, so breaking either
 * one leaves the other holding the property and the suite stays green (§V461's shape,
 * one layer up). That is worth knowing about but not worth relying on — the claim in the
 * store's own comment is that home mode is inert BY CONSTRUCTION rather than because a
 * caller remembered to check a prop, and that claim is only true if it is asserted here,
 * against the store with no component in front of it.
 */

const NODE = "n1" as NodeId;

describe("the preview inspection store (T656)", () => {
  it("is inert in HOME mode — every writer, not just the one the UI happens to gate", () => {
    const store = createPreviewOrbitStore();
    expect(store.mode(NODE)).toBe("home");

    store.apply(NODE, { azimuth: 1, elevation: 1, panX: 1, panY: 1 });
    store.zoom(NODE, 0.5);

    expect(store.get(NODE)).toBeUndefined();
  });

  it("accumulates in ADJUSTABLE, clamping pan and distance on the way in", () => {
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");

    store.apply(NODE, { azimuth: 0.25, elevation: -0.5 });
    store.apply(NODE, { azimuth: 0.25, panX: 0.4 });
    store.zoom(NODE, 0.5);
    store.zoom(NODE, 0.5);

    expect(store.get(NODE)).toEqual({
      azimuth: 0.5,
      elevation: -0.5,
      distance: 0.25,
      panX: 0.4,
      panY: 0,
    });

    // Clamped ON WRITE, not only on read: an accumulator that ran away would need as
    // many scrolls back before the picture moved at all.
    for (let index = 0; index < 20; index += 1) store.zoom(NODE, 0.5);
    expect(store.get(NODE)?.distance).toBe(0.2);
    store.apply(NODE, { panX: 99, panY: -99 });
    expect(store.get(NODE)?.panX).toBe(2);
    expect(store.get(NODE)?.panY).toBe(-2);
  });

  it("returning HOME drops the orbit in the same operation, so they cannot drift", () => {
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 1 });

    store.setMode(NODE, "home");

    expect(store.mode(NODE)).toBe("home");
    expect(store.get(NODE)).toBeUndefined();
  });

  it("notifies only the node whose mode changed, and only on a real change", () => {
    const store = createPreviewOrbitStore();
    const listener = vi.fn();
    const other = vi.fn();
    const unsubscribe = store.subscribe(NODE, listener);
    store.subscribe("n2" as NodeId, other);

    store.setMode(NODE, "adjustable");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();

    store.setMode(NODE, "adjustable");
    expect(listener).toHaveBeenCalledTimes(1);

    // A gesture is not a mode change: nothing re-renders while the camera moves, because
    // the preview tick samples the orbit per frame and the picture IS the feedback.
    store.apply(NODE, { azimuth: 1 });
    store.zoom(NODE, 2);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setMode(NODE, "home");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is PER NODE: adjusting one preview leaves its neighbour home", () => {
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 1 });

    expect(store.mode("n2" as NodeId)).toBe("home");
    store.apply("n2" as NodeId, { azimuth: 1 });
    expect(store.get("n2" as NodeId)).toBeUndefined();
  });
});
