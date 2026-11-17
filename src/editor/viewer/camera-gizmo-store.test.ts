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

  it("⚑ the wheel's own idle commit ends the gesture too: an undo after a dolly is not flown over", () => {
    /*
     * The literal sequence, as the viewer's e2e found it: dolly with the wheel, let its step
     * close, undo, hold W. The wheel's idle only COMMITTED and kept its local pose, so the
     * flight started from the dollied eye and its first write put the undone dolly back.
     */
    const { store, writes, setPose } = harness();
    store.setMode(NODE, "adjustable");
    store.zoom(NODE, 0.5);
    vi.advanceTimersByTime(500);
    expect(vec(writes[1]!, "eye")[2]).toBeCloseTo(1.5, 5);
    // Undo: the document is back three from the origin.
    setPose({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    // A tenth of the distance forward. From the document that is 3 − 0.3; from the stale
    // dollied pose it was 1.5 − 0.15.
    store.fly?.(NODE, [0, 0, -0.1]);
    expect(vec(writes[2]!, "eye")[2]).toBeCloseTo(2.7, 5);
    expect(store.pose?.(NODE)?.eye[2]).toBeCloseTo(2.7, 5);
  });

  it("a second turn of the wheel inside the idle window is still the same step", () => {
    // The legitimate case the fix could swallow: one burst of the wheel is one undo step.
    const { store, writes } = harness();
    store.setMode(NODE, "adjustable");
    store.zoom(NODE, 0.5);
    vi.advanceTimersByTime(300);
    store.zoom(NODE, 0.5);
    // It went on from where the first turn left it, with no commit between.
    expect(writes.map((write) => write.phase)).toEqual(["live", "live"]);
    expect(vec(writes[1]!, "eye")[2]).toBeCloseTo(0.75, 5);
    vi.advanceTimersByTime(500);
    expect(writes.map((write) => write.phase)).toEqual(["live", "live", "commit"]);
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

  it("moves existing static component overrides with their compound pose", () => {
    const { store, writes } = harness({
      eye: [0, 0, 3], lookAt: [0, 0, 0],
      eyeMask: [true, true, true], lookAtMask: [true, true, true],
      eyeComponents: [true, false, true], lookAtComponents: [false, true, false],
    });
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { azimuth: Math.PI / 2 });
    store.release?.(NODE);
    for (const write of writes) {
      expect(write.entries).toEqual({ eye: [3, 0, 0], "eye.x": 3, "eye.z": 0, lookAt: [0, 0, 0], "lookAt.y": 0 });
    }
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

/**
 * §T970 — THE CAMERA FLIES, AND THE FLIGHT IS AN EDIT.
 *
 * The owner, twice: "i'm still missing a way to actually change the position of the camera
 * in the camera node via flying around in that preview instead of manually having to deal
 * with it". The viewer's W A S D E Q land here when it is locked to a camera.
 */
describe("camera gizmo store flies (T970)", () => {
  it("translates Eye and Look At together, by the step times the distance between them", () => {
    const { store, writes } = harness({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    store.setMode(NODE, "adjustable");
    // One third of the Eye to Look At distance, straight ahead (the camera looks down -z).
    store.fly!(NODE, [0, 0, -1 / 3]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.phase).toBe("live");
    expect(vec(writes[0]!, "eye")).toEqual([0, 0, 2]);
    expect(vec(writes[0]!, "lookAt")).toEqual([0, 0, -1]);
    // The distance is kept, so the pace is kept: the next equal step moves equally far.
    store.fly!(NODE, [0, 0, -1 / 3]);
    expect(vec(writes[1]!, "eye")).toEqual([0, 0, 1]);
    expect(vec(writes[1]!, "lookAt")).toEqual([0, 0, -2]);
  });

  it("one flight is one undo step: live writes, then a single closing write when the keys come up", () => {
    const { store, writes } = harness();
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0.1, 0, 0]);
    store.fly!(NODE, [0.1, 0, 0]);
    store.fly!(NODE, [0.1, 0, 0]);
    store.release!(NODE);
    expect(writes.map((write) => write.phase)).toEqual(["live", "live", "live", "commit"]);
    // The closing write is where the flight ended, not where a frame happened to be.
    expect(vec(writes[3]!, "eye")).toEqual(vec(writes[2]!, "eye"));
    // A release with nothing flown writes nothing: no empty undo entry.
    store.release!(NODE);
    expect(writes).toHaveLength(4);
  });

  it("⚑ never writes a channel another mode decides, and never the bare key over it (§B219)", () => {
    // The legitimate case a refusal would swallow: five free channels still fly.
    const { store, writes } = harness({
      eye: [0, 0, 3],
      lookAt: [0, 0, 0],
      eyeMask: [false, true, true],
      lookAtMask: [true, true, true],
    });
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [1, 1, 0]);
    const entries = writes[0]!.entries;
    expect(Object.keys(entries).sort()).toEqual(["eye.y", "eye.z", "lookAt"]);
    expect(entries["eye.y"]).toBe(3);
    expect(vec(writes[0]!, "lookAt")).toEqual([3, 3, 0]);
  });

  it("answers where the camera is: the flight in progress, else the document", () => {
    const { store, setPose } = harness({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    expect(store.pose!(NODE)).toEqual({ eye: [0, 0, 3], lookAt: [0, 0, 0] });
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0, 0, -1 / 3]);
    // Mid-flight the document lags by a frame (the editor coalesces); the axes the next
    // step runs along must come from where the pilot IS (§V657).
    setPose({ eye: [9, 9, 9], lookAt: [0, 0, 0] });
    expect(store.pose!(NODE)).toEqual({ eye: [0, 0, 2], lookAt: [0, 0, -1] });
    store.release!(NODE);
    // Between gestures it is the document again, so an undo is not flown over.
    expect(store.pose!(NODE)).toEqual({ eye: [9, 9, 9], lookAt: [0, 0, 0] });
    setPose(null);
    expect(store.pose!(NODE)).toBeNull();
  });
});

/**
 * §T1671b — A POSE STORED IN A FRAME THAT PITCHES: the gestures keep their WORLD meaning.
 *
 * The pose's own +y is tilted there, and the store is told which way the world's up points
 * in the pose's coordinates. Everything above runs with no such axis and is the +y maths,
 * untouched.
 */
describe("camera gizmo store about a given up (T1671b)", () => {
  // The 3-4-5 frame: the world's up in the frame's coordinates.
  const UP = [0, 0.8, -0.6] as const;
  const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const minus = (a: readonly number[], b: readonly number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];

  it("⚑ an orbit is a turntable about THAT axis: the eye keeps its height along it and its distance", () => {
    // A directed shot: the eye at the frame's origin, the aim five down its forward.
    const { store, writes } = harness({ eye: [0, 0, 0], lookAt: [0, 0, -5], up: UP });
    store.setMode(NODE, "adjustable");
    const height = dot(minus([0, 0, 0], [0, 0, -5]), UP);
    store.apply(NODE, { azimuth: 0.7 });
    const eye = vec(writes[0]!, "eye");
    const offset = minus(eye, [0, 0, -5]);
    // Round the world's vertical: the height above the aim is what it was (to the 6 digits written)…
    expect(dot(offset, UP)).toBeCloseTo(height, 5);
    // …the distance is what it was, the aim has not moved, and the eye HAS.
    expect(Math.hypot(...offset)).toBeCloseTo(5, 5);
    expect(vec(writes[0]!, "lookAt")).toEqual([0, 0, -5]);
    expect(Math.abs(eye[0]!)).toBeGreaterThan(1);
    // About the pose's own +y the height along the WORLD's up would have changed: that is the difference.
    const tilted = harness({ eye: [0, 0, 0], lookAt: [0, 0, -5] });
    tilted.store.setMode(NODE, "adjustable");
    tilted.store.apply(NODE, { azimuth: 0.7 });
    expect(Math.abs(dot(minus(vec(tilted.writes[0]!, "eye"), [0, 0, -5]), UP) - height)).toBeGreaterThan(0.1);
  });

  it("the up-down clamp is against the AXIS's poles, so the view never passes through the world's vertical", () => {
    const { store, writes } = harness({ eye: [0, 0, 0], lookAt: [0, 0, -5], up: UP });
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { elevation: 10 });
    const offset = minus(vec(writes[0]!, "eye"), [0, 0, -5]);
    const elevation = Math.asin(dot(offset, UP) / Math.hypot(...offset));
    expect(elevation).toBeCloseTo(Math.PI / 2 - 0.02, 4);
  });

  it("a truck slides Eye and Look At together along the picture's right and its up", () => {
    const { store, writes } = harness({ eye: [0, 0, 0], lookAt: [0, 0, -5], up: UP });
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { panX: 0.2, panY: 0.1 });
    const eye = vec(writes[0]!, "eye");
    const lookAt = vec(writes[0]!, "lookAt");
    expect(minus(lookAt, [0, 0, -5])).toEqual(eye);
    // Looking down the frame's forward, the picture's right and up ARE the frame's x and y:
    // 0.2 and 0.1 of the distance of 5, and nothing along the view.
    expect(eye[0]).toBeCloseTo(1, 5);
    expect(eye[1]).toBeCloseTo(0.5, 5);
    expect(eye[2]).toBeCloseTo(0, 5);
  });

  it("a truck across a view that is level in the WORLD rises along the world's up, not the frame's", () => {
    // Three to the frame's side, looking across at its origin: the view is level in the world,
    // so the picture's up is the world's. About the pose's own +y the rise would be (0, 0.3, 0).
    const { store, writes } = harness({ eye: [3, 0, 0], lookAt: [0, 0, 0], up: UP });
    store.setMode(NODE, "adjustable");
    store.apply(NODE, { panX: 0, panY: 0.1 });
    const eye = vec(writes[0]!, "eye");
    expect(eye[0]).toBeCloseTo(3, 5);
    expect(eye[1]).toBeCloseTo(0.3 * 0.8, 5);
    expect(eye[2]).toBeCloseTo(-0.3 * 0.6, 5);
    expect(vec(writes[0]!, "lookAt")[1]).toBeCloseTo(0.3 * 0.8, 5);
  });

  it("with the axis at +y it is the turntable every other pose has", () => {
    const given = harness({ eye: [0, 1, 3], lookAt: [0, 0, 0], up: [0, 1, 0] });
    const plain = harness({ eye: [0, 1, 3], lookAt: [0, 0, 0] });
    for (const { store } of [given, plain]) {
      store.setMode(NODE, "adjustable");
      store.apply(NODE, { azimuth: 0.4, elevation: 0.2 });
      store.apply(NODE, { panX: 0.1, panY: -0.3 });
    }
    for (const [index, write] of given.writes.entries()) {
      for (const key of ["eye", "lookAt"]) {
        for (let axis = 0; axis < 3; axis += 1) expect(vec(write, key)[axis]).toBeCloseTo(vec(plain.writes[index]!, key)[axis]!, 5);
      }
    }
  });

  it("hands the flight its axis with the pose", () => {
    const { store } = harness({ eye: [0, 0, 0], lookAt: [0, 0, -5], up: UP });
    expect(store.pose!(NODE)).toEqual({ eye: [0, 0, 0], lookAt: [0, 0, -5], up: UP });
    store.setMode(NODE, "adjustable");
    store.fly!(NODE, [0, 0, -0.2]);
    expect(store.pose!(NODE)?.up).toEqual(UP);
  });
});
