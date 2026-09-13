import { useEffect } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { ResolvedOutput } from "@compiler/types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "@runtime/previews/orbit.ts";
import { viewCameraUniforms } from "@domain/geometry/view-camera.ts";
import type { PreviewOrbitStore } from "@editor/viewer/index.ts";

/**
 * §T1311b(a) — THE VIEWER'S INSPECTION CAMERA, delivered to a shader that declared one.
 *
 * The orbit gestures, the zoom, `home` and frame-content have all been wired into the
 * viewer since §T379; what a raymarched `customWgsl` output lacked was anywhere for them to
 * LAND. `PREVIEW_ORBIT_RIGS` is keyed by scene-payload kind, a marcher's output is a
 * texture, and the uniforms that push would have written — `viewProjection` and `eye` —
 * are a set a marcher cannot consume anyway: it has no vertices to transform.
 *
 * So this pushes a DIFFERENT SET, onto a DIFFERENT PASS. `output.viewCamera` names the one
 * pass the compiler emitted for the viewport — a clone of the authored pass into a target
 * nothing reads — and the values are an eye, a target and an angle, which is what a ray
 * per pixel is actually built from. The authored pass is not addressed here and cannot be:
 * the pass id comes off the row, the row is the VIEWPORT row, and there is no other id in
 * scope. Non-destructive by construction rather than by a guard that refuses to write.
 *
 * ## Why a frame poll and not a subscription
 *
 * `PreviewOrbitStore` notifies on MODE changes only — `apply` and `zoom` write silently,
 * deliberately, because the preview system reads the orbit when it builds each frame's
 * request and a notification per pointer move would re-render the React tree at pointer
 * rate (§V16). A main-plan pass has no such per-frame reader, so this hook is one: it polls
 * while the camera is ADJUSTABLE and not at all while it is home, which is the state every
 * viewer is in until somebody drags.
 *
 * The push is deduped on the serialized values, so a held pointer costs one comparison a
 * frame; and leaving adjustable pushes the HOME framing exactly once, which restores the
 * picture the compiler baked rather than leaving the last drag standing.
 */
export function useViewCameraOverride(options: {
  readonly backend: LoomBackend | null;
  /** The output the viewer is presenting. Only a VIEWPORT row carries `viewCamera`. */
  readonly output: ResolvedOutput | null | undefined;
  readonly orbits: PreviewOrbitStore | undefined;
}): void {
  const { backend, output, orbits } = options;
  const camera = output?.viewCamera;
  const nodeId = (output?.nodeId ?? null) as NodeId | null;
  const passId = camera?.passId;
  useEffect(() => {
    if (backend === null || camera === undefined || passId === undefined || orbits === undefined) return;
    if (nodeId === null) return;
    const basis = {
      eye: camera.eye,
      lookAt: camera.lookAt,
      fovY: camera.fovY,
      aspect: camera.aspect,
    };
    let pushed: string | null = null;
    let frame: number | null = null;
    const push = (): void => {
      const orbit = orbits.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT;
      const values = viewCameraUniforms(orbitPose(basis, orbit), camera.fovY);
      const serialized = JSON.stringify(values);
      if (serialized === pushed) return;
      pushed = serialized;
      backend.updateUniforms({ passId, values });
    };
    const poll = (): void => {
      push();
      frame = requestAnimationFrame(poll);
    };
    const stop = (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const sync = (): void => {
      if (orbits.mode(nodeId) === "adjustable") {
      if (frame === null) frame = requestAnimationFrame(poll);
        return;
      }
      stop();
      // Home is not "stop pushing": the pass still holds the last drag's values, so the
      // way back to the baked framing is one identity push. `orbitPose` short-circuits an
      // identity orbit to the stock pose itself, float for float (§V528).
      push();
    };
    sync();
    const unsubscribe = orbits.subscribe(nodeId, sync);
    return () => {
      unsubscribe();
      stop();
    };
  }, [backend, camera, nodeId, orbits, passId]);
}
