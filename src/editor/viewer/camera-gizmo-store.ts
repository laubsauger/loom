import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { PreviewInspectMode, PreviewOrbitStore } from "./preview-orbit-store.ts";

/**
 * T692 — the camera GIZMO: the preview tile's gestures, writing the DOCUMENT.
 *
 * ## Why this is legitimate where an inspection orbit is not (the T614 inversion)
 *
 * A camera node's tile draws through the payload's OWN matrix — which is exactly why
 * `PREVIEW_ORBIT_RIGS` pins `camera: null`: an inspection override there would falsify
 * the one thing the tile exists to show (T561/T614, §T639(a)). This store is the
 * inversion of that constraint, not an exception to it: every gesture goes through the
 * parameter editor onto the command bus as an ordinary `setParameters` patch, so what
 * you see move IS the document moving. The tile stays truthful by definition — it keeps
 * drawing through the camera's own matrix, and the drag changes the matrix. T675's
 * refusal (an inspection orbit on Render "either silently changes the pixels the node
 * outputs, or stops showing the node's output") does not apply to a write that is the
 * user's own undoable edit, attributed like any other (§V29/§V30).
 *
 * ## Shape
 *
 * It wears the `PreviewOrbitStore` interface so `NodePreviewSlot` and the header toggle
 * work unchanged — same alt-entry, same radians-per-pixel, same wheel, same `h` to
 * leave. The verbs map onto the T706 representation: drag orbits `eye` around `lookAt`,
 * shift-drag trucks both together, the wheel dollies the distance. `roll` is deliberately
 * not a gesture (its parameter description says why). `get()` always answers undefined:
 * there is no view override to publish, because the deltas live in the document.
 *
 * ## Undo (§V15) and liveness (§V5)
 *
 * All writes go through the SAME `ParameterEditor` idiom the inspector uses: `"live"`
 * values coalesce to animation frames inside one transaction, and the slot's gesture
 * end (`release`) commits — one drag, one undo step, landing back where the drag began.
 * The wheel has no pointerup, so a dolly commits itself after a short idle.
 *
 * ## §V657
 *
 * The pose is read from the document once, when a gesture can begin (mode entry), and
 * accumulated locally through the gesture — never re-read mid-drag, where the editor's
 * frame-coalesced writes would lag the pointer and feed back.
 */

/** The slice of `ParameterEditor` this store needs — structural, so tests stay small. */
export interface CameraGizmoEditor {
  setStored(
    nodeId: NodeId,
    entries: Readonly<Record<string, ParameterValue>>,
    phase: "live" | "commit",
  ): void;
}

export interface CameraPose {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
}

const WHEEL_COMMIT_MS = 400;
const MIN_DISTANCE = 0.05;
const MAX_ELEVATION = Math.PI / 2 - 0.02;

type Vec3 = readonly [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const round6 = (v: number): number => Number(v.toFixed(6));
const asValue = (v: Vec3): [number, number, number] => [round6(v[0]), round6(v[1]), round6(v[2])];

interface GizmoSession {
  eye: Vec3;
  lookAt: Vec3;
  /** True once any delta was written — release without movement commits nothing. */
  dirty: boolean;
  wheelTimer: ReturnType<typeof setTimeout> | undefined;
}

export function createCameraGizmoStore(options: {
  editor: CameraGizmoEditor;
  /** The document's current pose, read at gesture start (§V657). Null = node gone. */
  readPose: (nodeId: NodeId) => CameraPose | null;
}): PreviewOrbitStore {
  const modes = new Map<NodeId, PreviewInspectMode>();
  const sessions = new Map<NodeId, GizmoSession>();
  const listeners = new Map<NodeId, Set<() => void>>();

  const notify = (nodeId: NodeId): void => {
    for (const listener of listeners.get(nodeId) ?? []) listener();
  };

  const session = (nodeId: NodeId): GizmoSession | null => {
    const existing = sessions.get(nodeId);
    if (existing !== undefined) return existing;
    const pose = options.readPose(nodeId);
    if (pose === null) return null;
    const created: GizmoSession = {
      eye: pose.eye,
      lookAt: pose.lookAt,
      dirty: false,
      wheelTimer: undefined,
    };
    sessions.set(nodeId, created);
    return created;
  };

  const write = (nodeId: NodeId, s: GizmoSession, phase: "live" | "commit"): void => {
    options.editor.setStored(nodeId, { eye: asValue(s.eye), lookAt: asValue(s.lookAt) }, phase);
    if (phase === "live") s.dirty = true;
  };

  const commit = (nodeId: NodeId): void => {
    const s = sessions.get(nodeId);
    if (s === undefined) return;
    if (s.wheelTimer !== undefined) clearTimeout(s.wheelTimer);
    s.wheelTimer = undefined;
    if (s.dirty) {
      write(nodeId, s, "commit");
      s.dirty = false;
    }
  };

  return {
    // No view override exists: the tile draws the document, and the document moved.
    get: () => undefined,
    mode: (nodeId) => modes.get(nodeId) ?? "home",
    setMode(nodeId, mode) {
      if ((modes.get(nodeId) ?? "home") === mode) return;
      if (mode === "home") {
        commit(nodeId);
        sessions.delete(nodeId);
        modes.delete(nodeId);
      } else {
        modes.set(nodeId, "adjustable");
      }
      notify(nodeId);
    },
    subscribe(nodeId, listener) {
      const set = listeners.get(nodeId) ?? new Set();
      set.add(listener);
      listeners.set(nodeId, set);
      return () => set.delete(listener);
    },
    apply(nodeId, delta) {
      if ((modes.get(nodeId) ?? "home") !== "adjustable") return;
      const s = session(nodeId);
      if (s === null) return;
      if (delta.panX !== undefined || delta.panY !== undefined) {
        // TRUCK: eye and lookAt slide together, screen-aligned, scaled by distance so
        // the drag covers the same fraction of the picture at any range (the slot's
        // pan units are "radii per px" — here the radius is the orbit distance).
        const offset = sub(s.eye, s.lookAt);
        const r = Math.max(length(offset), MIN_DISTANCE);
        const forward = normalize(scale(offset, -1));
        const up: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
        const right = normalize(cross(forward, up));
        const upV = cross(right, forward);
        const move = add(scale(right, (delta.panX ?? 0) * r), scale(upV, (delta.panY ?? 0) * r));
        s.eye = add(s.eye, move);
        s.lookAt = add(s.lookAt, move);
      } else {
        // ORBIT: spherical about lookAt, elevation clamped off the poles so the view
        // basis cannot degenerate mid-drag (T706's guard covers the written result too).
        const offset = sub(s.eye, s.lookAt);
        const r = Math.max(length(offset), MIN_DISTANCE);
        let azimuth = Math.atan2(offset[0], offset[2]);
        let elevation = Math.asin(Math.max(-1, Math.min(1, offset[1] / r)));
        azimuth += delta.azimuth ?? 0;
        elevation = Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, elevation + (delta.elevation ?? 0)));
        s.eye = add(s.lookAt, [
          r * Math.cos(elevation) * Math.sin(azimuth),
          r * Math.sin(elevation),
          r * Math.cos(elevation) * Math.cos(azimuth),
        ]);
      }
      write(nodeId, s, "live");
    },
    zoom(nodeId, factor) {
      if ((modes.get(nodeId) ?? "home") !== "adjustable") return;
      const s = session(nodeId);
      if (s === null) return;
      const offset = sub(s.eye, s.lookAt);
      const r = Math.max(length(offset) * factor, MIN_DISTANCE);
      s.eye = add(s.lookAt, scale(normalize(offset), r));
      write(nodeId, s, "live");
      // The wheel has no pointerup; the transaction closes itself after a short idle.
      if (s.wheelTimer !== undefined) clearTimeout(s.wheelTimer);
      s.wheelTimer = setTimeout(() => commit(nodeId), WHEEL_COMMIT_MS);
    },
    reset(nodeId) {
      commit(nodeId);
      sessions.delete(nodeId);
    },
    release(nodeId) {
      commit(nodeId);
      // The next drag re-reads the document (§V657): an undo between gestures must not
      // be overwritten by a stale local pose.
      sessions.delete(nodeId);
    },
  };
}
