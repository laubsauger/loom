import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { viewportPortId } from "../compiler/resources.ts";
import { viewCameraUniforms } from "../domain/geometry/view-camera.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "../runtime/previews/orbit.ts";
import { axisSnapDelta } from "../editor/viewer/axis-gizmo.ts";
import type { GizmoAxis } from "../editor/viewer/axis-gizmo.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * §T1311b(c) — **THE CORNER GIZMO'S CLICK, RENDERED ON DAWN.**
 *
 * `viewer-axis-gizmo.test.tsx` proves the chain a click travels inside the pane, ending on
 * the uniform the shader reads. This file proves the half a DOM test cannot: that those
 * numbers, pushed onto the pass the compiler actually emitted for E68, render the hall from
 * the axis that was clicked — and that clicking another one renders a different hall.
 *
 * ⚑ Deliberately NOT a re-run of §T1311b(b)'s file with a different orbit. The value here is
 * that the DELTA comes from `axisSnapDelta` — the widget's own arithmetic, in `orbitPose`'s
 * atan2(x, z) convention — over the compiler's own published basis. A sign error between the
 * two would put the camera behind the subject, and it would be invisible to every test that
 * built its expected azimuth with the same inverse.
 *
 * And the last test is the row's ruling under this row's own gesture: the authored port is
 * byte-identical while the gizmo is driving the camera, because the only pass id in scope is
 * the viewport's.
 */

function e68() {
  const file = listExamples().find((entry) => entry.fileName === "E68-Sanctum.loom.json");
  if (file === undefined) throw new Error("E68-Sanctum.loom.json is not shipped");
  return requireExample(file);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const TEMPLE = "temple";
const WATCHED = [{ nodeId: TEMPLE, portId: "out" }];

interface Shot {
  readonly bytes: Uint8Array;
  readonly eye: readonly number[];
  readonly lookAt: readonly number[];
}

/**
 * One still frame of E68, from wherever a gizmo click would stand the camera.
 *
 * `snap: null` is the author's own framing (what an untouched viewport shows). `frames: 1`
 * with no animation, so a pixel difference between two shots is a camera difference.
 */
async function shoot(options: {
  readonly snap?: { readonly axis: GizmoAxis; readonly positive: boolean } | null;
  readonly portId?: string;
}): Promise<Shot> {
  const { document, result } = e68();
  const graph = structuredClone(document.graph) as GraphDocument;
  let eye: readonly number[] = [];
  let lookAt: readonly number[] = [];
  const rendered = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { width: 320, height: 180 } },
    frames: 1,
    capture: [0],
    outputNodeId: TEMPLE,
    outputPortId: options.portId ?? viewportPortId("out"),
    sinks: WATCHED,
    ...(result.components ? { components: result.components } : {}),
    beforeFrames: (control) => {
      const snap = options.snap;
      if (snap === undefined || snap === null) return;
      const row = control.plan.outputs.find(
        (output) => output.nodeId === TEMPLE && output.viewCamera !== undefined,
      );
      const camera = row?.viewCamera;
      if (camera === undefined) throw new Error("E68 published no viewport row to point");
      const basis = {
        eye: camera.eye,
        lookAt: camera.lookAt,
        fovY: camera.fovY,
        aspect: camera.aspect,
      };
      /*
       * Exactly what the ball's `onClick` does: read the store's orbit (nobody has
       * touched it, so the identity), ask the widget for the delta, accumulate it. The
       * pane's `orbits.apply` is the only step skipped, and it is addition.
       */
      const delta = axisSnapDelta(basis, DEFAULT_PREVIEW_ORBIT, snap);
      const pose = orbitPose(basis, {
        ...DEFAULT_PREVIEW_ORBIT,
        azimuth: DEFAULT_PREVIEW_ORBIT.azimuth + delta.azimuth,
        elevation: DEFAULT_PREVIEW_ORBIT.elevation + delta.elevation,
      });
      eye = pose.eye;
      lookAt = pose.lookAt;
      control.updateUniforms(camera.passId, viewCameraUniforms(pose, camera.fovY));
    },
  });
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = rendered.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: frame.bytes, eye, lookAt };
}

/** Share of bytes that differ. The claim is "a different picture", counted. */
function difference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) throw new Error("nothing to compare");
  let differing = 0;
  for (let at = 0; at < length; at += 1) if (a[at] !== b[at]) differing += 1;
  return differing / length;
}

/** The unit vector from the target toward the eye — where the click stood the camera. */
function heading(shot: Shot): readonly number[] {
  const d = [
    shot.eye[0]! - shot.lookAt[0]!,
    shot.eye[1]! - shot.lookAt[1]!,
    shot.eye[2]! - shot.lookAt[2]!,
  ];
  const length = Math.hypot(d[0]!, d[1]!, d[2]!);
  return d.map((v) => v / length);
}

describe("E68 Sanctum — the corner gizmo points the viewport", () => {
  it("⚑ renders the hall from the axis that was CLICKED, and from the opposite one", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const home = await shoot({ snap: null });
    const east = await shoot({ snap: { axis: "x", positive: true } });
    const west = await shoot({ snap: { axis: "x", positive: false } });

    /*
     * The geometry first, so the pixel claims are about cameras whose positions are known.
     * Exact, because this is arithmetic and not a measurement (§V147) — and it is the claim
     * that catches the convention error, since the compiler's basis for E68 is not
     * axis-aligned and a wrong inverse lands somewhere merely plausible.
     */
    heading(east).forEach((component, index) => {
      expect(component).toBeCloseTo([1, 0, 0][index]!, 6);
    });
    heading(west).forEach((component, index) => {
      expect(component).toBeCloseTo([-1, 0, 0][index]!, 6);
    });
    // A snap sets the DIRECTION and keeps the pivot: both stand at the author's own radius
    // around the author's own target, which is what makes it an inspection and not a jump.
    expect(east.lookAt).toEqual(west.lookAt);
    const radius = (shot: Shot): number =>
      Math.hypot(
        shot.eye[0]! - shot.lookAt[0]!,
        shot.eye[1]! - shot.lookAt[1]!,
        shot.eye[2]! - shot.lookAt[2]!,
      );
    expect(radius(east)).toBeCloseTo(radius(west), 6);

    /*
     * And the pixels. If the click never reached the shader the viewport would render the
     * author's framing three times and every difference below would be zero; if it reached
     * it but the two snaps collapsed to one pose, the middle claim would be.
     */
    expect(difference(home.bytes, east.bytes)).toBeGreaterThan(0.2);
    expect(difference(east.bytes, west.bytes)).toBeGreaterThan(0.2);
    expect(difference(home.bytes, west.bytes)).toBeGreaterThan(0.2);
  }, 300_000);

  it("⚑ leaves the piece BYTE-IDENTICAL while the gizmo drives — view-only, still", async () => {
    if (dawnError !== undefined) throw new Error(dawnError);
    const still = await shoot({ portId: "out", snap: null });
    const whilePointed = await shoot({ portId: "out", snap: { axis: "x", positive: true } });
    expect(whilePointed.bytes.length).toBe(still.bytes.length);
    let differing = 0;
    let firstAt = -1;
    for (let at = 0; at < still.bytes.length; at += 1) {
      if (whilePointed.bytes[at] === still.bytes[at]) continue;
      differing += 1;
      if (firstAt < 0) firstAt = at;
    }
    expect({ differing, firstAt }).toEqual({ differing: 0, firstAt: -1 });
  }, 300_000);
});
