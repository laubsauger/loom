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

  it("T1314b — a held channel is never written, and never as a bare compound", () => {
    // E69 Burnish's shape: `eye.x` on an expression, y and z free. The old store wrote the
    // whole `eye` tuple, which landed on the driven channel's INACTIVE static binding —
    // the camera stayed put and §V914's retained value became an arbitrary dragged pose.
    const { store, writes } = harness({
      eye: [0, 1.9, 8.4],
      lookAt: [0, 0.75, 0],
      eyeMask: [false, true, true],
    });
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 0.4 });

    const live = writes[0];
    if (live === undefined) throw new Error("a partly driven camera still flies on its free channels");
    // The bare key is the corruption: it must not appear at all while anything is held.
    expect(Object.keys(live.entries).sort()).toEqual(["eye.y", "eye.z", "lookAt"]);
    expect(live.entries["eye.x"]).toBeUndefined();
    // Azimuth rotates ABOUT y, so y is the one free channel this gesture cannot move —
    // asserting otherwise would be asserting against the maths. `z` is what swings.
    expect(live.entries["eye.y"]).toBe(1.9);
    expect(live.entries["eye.z"]).not.toBe(8.4);

    // Elevation moves y, and the held x still never appears.
    store.apply(NODE, { elevation: 0.3 });
    const tilted = writes[writes.length - 1];
    if (tilted === undefined) throw new Error("expected a second write");
    expect(tilted.entries["eye.y"]).not.toBe(1.9);
    expect(tilted.entries["eye.x"]).toBeUndefined();
  });

  it("T1314b — a fully static camera still writes whole vectors, as it always did", () => {
    const { store, writes } = harness({ eye: [0, 0, 3], lookAt: [0, 0, 0], eyeMask: [true, true, true] });
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 0.4 });
    expect(Object.keys(writes[0]?.entries ?? {}).sort()).toEqual(["eye", "lookAt"]);
  });

  it("T1314b — the session holds what it WROTE, so tile and store cannot drift (§V964)", () => {
    // The store accumulates locally while the tile draws the DOCUMENT. An unrounded
    // accumulator and a `round6` write disagree by a little more every frame of a drag.
    const { store, writes } = harness({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    store.setMode(NODE, "adjustable");
    for (let step = 0; step < 12; step += 1) store.apply(NODE, { azimuth: 0.017 });
    const last = writes[writes.length - 1];
    if (last === undefined) throw new Error("expected writes");
    for (const value of vec(last, "eye")) {
      expect(value, `${String(value)} carries more precision than the document holds`).toBe(
        Number(value.toFixed(6)),
      );
    }
  });

  it("a driven camera arms nothing: no pose, no writes, no silent clobber", () => {
    const { store, writes } = harness(null);
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: 1 });
    store.release?.(NODE);
    expect(writes).toEqual([]);
  });
});
