import { describe, expect, it, vi } from "vitest";

import type { NodeId } from "@domain/types/ids.ts";
import { createPreviewOrbitStore, prefixedOrbitStore } from "./preview-orbit-store.ts";

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

describe("frame content (T379)", () => {
  it("enters adjustable and frames in one operation; going home clears both", () => {
    const store = createPreviewOrbitStore();
    const node = "n1" as never;
    const frame = { lookAt: [4, 0, -2] as const, radius: 3 };
    // One call: no separate arming step for a gesture the user already made.
    store.frameContent?.(node, frame);
    expect(store.mode(node)).toBe("adjustable");
    expect(store.get(node)?.frame).toEqual(frame);
    // Leaving IS the reset, frame included — same statement as every other orbit state.
    store.setMode(node, "home");
    expect(store.get(node)).toBeUndefined();
  });

  it("deltas after a frame accumulate over it — orbiting the content, not the origin", () => {
    const store = createPreviewOrbitStore();
    const node = "n1" as never;
    store.frameContent?.(node, { lookAt: [4, 0, -2], radius: 3 });
    store.apply(node, { azimuth: 0.5 });
    expect(store.get(node)?.azimuth).toBe(0.5);
    expect(store.get(node)?.frame?.lookAt).toEqual([4, 0, -2]);
  });
});

describe("T1051 follow-up — one shared store, per-pane prefixes, no leaks either way", () => {
  it("an orbit set INSIDE a component never moves the root node with the same name — and vice versa", () => {
    const shared = createPreviewOrbitStore();
    const root = prefixedOrbitStore(shared, "");
    const inside = prefixedOrbitStore(shared, "wall");

    // E51's real collision: a root node `grid` and TimeGrid's interior `grid`.
    inside.setMode("grid" as NodeId, "adjustable");
    inside.apply("grid" as NodeId, { azimuth: 0.5 });
    expect(root.get("grid" as NodeId)).toBeUndefined();
    expect(root.mode("grid" as NodeId)).toBe("home");

    root.setMode("grid" as NodeId, "adjustable");
    root.apply("grid" as NodeId, { azimuth: -0.25 });
    expect(inside.get("grid" as NodeId)?.azimuth).toBe(0.5);
    expect(root.get("grid" as NodeId)?.azimuth).toBe(-0.25);

    // The shared store holds both, under the FLAT ids — which is what makes a
    // re-entered dive find its orbit where it was left.
    expect(shared.get("wall/grid" as NodeId)?.azimuth).toBe(0.5);
    expect(shared.get("grid" as NodeId)?.azimuth).toBe(-0.25);
  });

  it("the root prefix is the identity — zero indirection where none is needed", () => {
    const shared = createPreviewOrbitStore();
    expect(prefixedOrbitStore(shared, "")).toBe(shared);
  });

  it("subscriptions route through the prefix: an interior listener wakes on the interior write only", () => {
    const shared = createPreviewOrbitStore();
    const inside = prefixedOrbitStore(shared, "wall");
    let woke = 0;
    inside.subscribe("grid" as NodeId, () => {
      woke += 1;
    });
    prefixedOrbitStore(shared, "").setMode("grid" as NodeId, "adjustable");
    expect(woke).toBe(0);
    inside.setMode("grid" as NodeId, "adjustable");
    expect(woke).toBe(1);
  });
});
