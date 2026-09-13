import { describe, expect, it } from "vitest";
import type { NodeId } from "@domain/types/ids.ts";
import { createPreviewOrbitStore, prefixedOrbitStore } from "./preview-orbit-store.ts";
import { createCameraGizmoStore } from "./camera-gizmo-store.ts";

/**
 * §T1311b(b) — the flight in the INSPECTION store.
 *
 * Three properties, and the middle one is a bug this store's own shape invites: `apply`
 * rebuilds the orbit record field by field rather than spreading it, so any field its
 * author did not name is silently dropped by the next drag. T379 already paid for that once
 * with `frame`; the flight is the second field in the same position.
 */

const NODE = "temple" as NodeId;

describe("PreviewOrbitStore.fly", () => {
  it("is inert while home — looking is off until the user turns it on", () => {
    const store = createPreviewOrbitStore();
    store.fly!(NODE, [1, 0, 0]);
    expect(store.get(NODE)).toBeUndefined();
    expect(store.mode(NODE)).toBe("home");
  });

  it("accumulates once adjustable, and the accumulation is the flight", () => {
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0, 0, 0.5]);
    store.fly!(NODE, [0, 0, 0.25]);
    store.fly!(NODE, [0.1, 0, 0]);
    // A flight is a hundred frames of small steps; a store that replaced instead of adding
    // would leave the camera one frame's worth from home no matter how long a key was held.
    expect(store.get(NODE)?.fly).toEqual([0.1, 0, 0.75]);
  });

  it("⚑ SURVIVES THE NEXT DRAG — fly somewhere, then look around from there", () => {
    /*
     * The gesture this is against, and it is the one a user makes constantly: fly down the
     * hall, then drag to turn. `apply` names every field it keeps, so a flight it forgot to
     * name would be dropped on the first pointer move and the camera would teleport back to
     * the author's framing mid-drag. Nothing about that reads as a dropped field; it reads
     * as the fly control being broken.
     */
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0, 0, 2]);
    store.apply(NODE, { azimuth: 0.4, elevation: -0.1 });
    expect(store.get(NODE)?.fly).toEqual([0, 0, 2]);
    expect(store.get(NODE)?.azimuth).toBeCloseTo(0.4, 12);
    // The wheel spreads rather than rebuilds, so it is covered by construction — asserted
    // anyway, because "covered by construction" is a property of today's spelling.
    store.zoom(NODE, 0.5);
    expect(store.get(NODE)?.fly).toEqual([0, 0, 2]);
  });

  it("goes home with everything else — the toggle IS the reset (T656)", () => {
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0, 0, 9]);
    store.setMode(NODE, "home");
    expect(store.get(NODE)).toBeUndefined();
    // And re-entering starts from the author's framing rather than from the old flight.
    store.setMode(NODE, "adjustable");
    expect(store.get(NODE)?.fly).toBeUndefined();
  });

  it("drops a non-finite step rather than poisoning the camera with it", () => {
    // §V986: the camera stays where the user can see it. A NaN eye renders a black frame
    // that neither `h` nor a drag can recover, because every later delta is NaN too.
    const store = createPreviewOrbitStore();
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0, 0, 1]);
    store.fly!(NODE, [Number.NaN, 0, 0]);
    expect(store.get(NODE)?.fly).toEqual([0, 0, 1]);
  });

  it("flies the PREFIXED node, so a dive cannot move the root node's camera (§V877)", () => {
    const store = createPreviewOrbitStore();
    const inner = prefixedOrbitStore(store, "wall");
    inner.setMode(NODE, "adjustable");
    inner.fly!(NODE, [0, 0, 3]);
    expect(store.get("wall/temple" as NodeId)?.fly).toEqual([0, 0, 3]);
    expect(store.get(NODE)).toBeUndefined();
  });

  it("⚑ is ABSENT on the store whose writes reach the document (§T1314b)", () => {
    /*
     * `createCameraGizmoStore` wears this same interface and its `apply` writes a DOCUMENT
     * camera node through the command bus. Fly is optional precisely so this store does not
     * inherit one: the destructive camera-fly is a different feature with a different
     * ruling (undoable, audited, confirm-before-replacing a driven channel), and a flight
     * that arrived here by interface inheritance would have made §T1311b's view-only
     * gesture quietly destructive on exactly one surface.
     *
     * Asserted on the OBJECT rather than on a type, because a type says nothing at runtime
     * and this is the property that keeps the two features apart.
     */
    const gizmo = createCameraGizmoStore({
      editor: {
        begin: () => {},
        write: () => {},
        commit: () => {},
      } as unknown as Parameters<typeof createCameraGizmoStore>[0]["editor"],
      readPose: () => null,
    });
    expect(gizmo.fly).toBeUndefined();
  });
});
