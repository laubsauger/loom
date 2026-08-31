import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { type CameraPose, createCameraGizmoStore } from "./camera-gizmo-store.ts";

/**
 * T692 — the gizmo writes the DOCUMENT, with the exact undo shape the inspector's
 * drags have: live values in one transaction, one commit per gesture. The store wears
 * the inspection interface, so what these gates pin is the part that differs — the
 * math from gesture deltas to eye/lookAt, and the phase discipline.
 */

const NODE = "cam1" as NodeId;

interface Write {
  readonly nodeId: NodeId;
  readonly entries: Readonly<Record<string, ParameterValue>>;
  readonly phase: "live" | "commit";
}

function harness(pose: CameraPose | null = { eye: [0, 0, 3], lookAt: [0, 0, 0] }) {
  const writes: Write[] = [];
  let current = pose;
  const store = createCameraGizmoStore({
    editor: { setStored: (nodeId, entries, phase) => writes.push({ nodeId, entries, phase }) },
    readPose: () => current,
  });
  return { store, writes, setPose: (next: CameraPose | null) => (current = next) };
}

const vec = (write: Write, key: string): readonly number[] => write.entries[key] as readonly number[];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("camera gizmo store (T692)", () => {
  it("does nothing while home — arming is the gate, exactly like inspection", () => {
    const { store, writes } = harness();
    store.apply(NODE, { azimuth: 1 });
    store.zoom(NODE, 0.5);
    expect(writes).toEqual([]);
  });

  it("orbits eye around lookAt by exact spherical math, live then one commit", () => {
    const { store, writes } = harness();
    store.setMode(NODE, "adjustable");
    // Quarter turn of azimuth: eye [0,0,3] swings to [3,0,0], lookAt untouched.
    store.apply(NODE, { azimuth: Math.PI / 2 });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.phase).toBe("live");
    expect(vec(writes[0]!, "eye")[0]).toBeCloseTo(3, 5);
    expect(vec(writes[0]!, "eye")[2]).toBeCloseTo(0, 5);
    expect(vec(writes[0]!, "lookAt")).toEqual([0, 0, 0]);

    store.release?.(NODE);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.phase).toBe("commit");
    // The commit carries the SAME pose — it closes the transaction, not a new value.
    expect(vec(writes[1]!, "eye")).toEqual(vec(writes[0]!, "eye"));
  });

  it("clamps elevation off the poles, so a written pose can never degenerate (T706)", () => {
    const { store, writes } = harness();
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { elevation: Math.PI }); // way past straight up
    const eye = vec(writes[0]!, "eye");
    const r = Math.hypot(eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0);
    // sin(clamped) < 1: some horizontal component always survives.
    expect(Math.abs((eye[1] ?? 0) / r)).toBeLessThan(1);
    expect(Math.hypot(eye[0] ?? 0, eye[2] ?? 0)).toBeGreaterThan(0.01);
  });

  it("trucks eye and lookAt together, screen-aligned and distance-scaled", () => {
    const { store, writes } = harness();
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { panX: 0.1, panY: 0 });
    const eye = vec(writes[0]!, "eye");
    const lookAt = vec(writes[0]!, "lookAt");
    // Looking down -z from [0,0,3]: forward = [0,0,-1], right = forward × up =
    // [1,0,0] — the camera's right IS world +x here, so a rightward drag slides both
    // points +x by exactly panX · distance = 0.3, and the object appears to go left.
    expect(eye[0]).toBeCloseTo(lookAt[0] ?? 0, 5); // same displacement on both
    expect(eye[0]).toBeCloseTo(0.3, 5);
    expect(lookAt[0]).toBeCloseTo(0.3, 5);
    expect(eye[2]).toBeCloseTo(3, 5);
    expect(lookAt[2]).toBeCloseTo(0, 5);
  });

  it("dollies with the wheel and commits itself after the idle window", () => {
    const { store, writes } = harness();
    store.setMode(NODE, "adjustable");
    store.zoom(NODE, 0.5);
    expect(vec(writes[0]!, "eye")[2]).toBeCloseTo(1.5, 5);
    expect(writes[0]?.phase).toBe("live");
    vi.advanceTimersByTime(500);
    expect(writes[1]?.phase).toBe("commit");
  });

  it("release re-reads the document next gesture (§V657) — an undo is not clobbered", () => {
    const { store, writes, setPose } = harness();
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: Math.PI / 2 });
    store.release?.(NODE);
    // The user hits undo: the document is back at the original pose.
    setPose({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    store.apply(NODE, { azimuth: 0 });
    // The new gesture starts from the DOCUMENT's pose, not the stale local one.
    expect(vec(writes[2]!, "eye")[2]).toBeCloseTo(3, 5);
  });

  it("publishes no view override — the tile draws the document, nothing else", () => {
    const { store } = harness();
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 1 });
    expect(store.get(NODE)).toBeUndefined();
  });

  it("a driven camera arms nothing: no pose, no writes, no silent clobber", () => {
    const { store, writes } = harness(null);
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 1 });
    store.release?.(NODE);
    expect(writes).toEqual([]);
  });
});
