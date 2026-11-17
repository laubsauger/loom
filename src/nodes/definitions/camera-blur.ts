import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { CameraPayload, CameraPose } from "../../domain/types/scene.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { cameraBasis } from "../../domain/geometry/camera.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { DANGLING_CAMERA_SUGGESTION, danglingCameraRefusal } from "./camera-reference.ts";
import { readNumber } from "./parameter-readers.ts";
import { CAMERA_BLUR_WGSL } from "../shaders/camera-blur.wgsl.ts";

type V3 = readonly [number, number, number];

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mirror = (now: number, away: number): number => 2 * now - away;
const mirror3 = (now: V3, away: V3): [number, number, number] => [mirror(now[0], away[0]), mirror(now[1], away[1]), mirror(now[2], away[2])];

/**
 * How far a pose is from another, in radians of view: the forward axes' angle, the bank and
 * the field, plus the eye's travel measured against the distance to the aim. Only compared
 * with itself, to pick the side of the path that does not jump.
 */
function change(a: CameraPose, b: CameraPose): number {
  const fa = cameraBasis(a.eye, a.lookAt, a.roll).forward;
  const fb = cameraBasis(b.eye, b.lookAt, b.roll).forward;
  const turn = Math.acos(Math.min(1, Math.max(-1, dot(fa, fb))));
  const reach = Math.max(Math.hypot(...sub(b.lookAt, b.eye)), 1e-9);
  return turn + (Math.abs(a.roll - b.roll) + Math.abs(a.fovDeg - b.fovDeg)) * (Math.PI / 180) + Math.hypot(...sub(a.eye, b.eye)) / reach;
}

/**
 * Camera Blur — the motion blur a moving camera's shutter leaves, from the camera path's own
 * derivative (T1421b).
 *
 * Names a Camera (as the renderers do) and reads its path a millisecond either side of the
 * frame (`CameraPayload.motion`, published by the Camera from the compiler's time probe). It
 * differentiates on the side that changes LESS, so a cut that falls inside that millisecond is
 * stepped over instead of smeared across the frame; the other side is mirrored through now.
 * The per-pixel arithmetic is `CAMERA_BLUR_WGSL`: a pan or a whip blurs at any speed, and the
 * Depth input (a Render's depth output) adds the parallax of the camera's travel. Without depth
 * every pixel is a point at infinity, which is exactly right for a turning camera.
 *
 * The shutter is a share of one transport step: a film frame, or one sub-frame when an offline
 * render accumulates them (so the sub-frames and this node do not blur twice). A camera driven
 * by a channel rather than the clock has no derivative here and does not blur.
 */
export const cameraBlurNode: NodeDefinition = {
  type: "cameraBlur",
  version: 1,
  title: "Camera Blur",
  category: "filter",
  description:
    "The motion blur of a moving camera: names a Camera and smears the picture along the camera's own motion during the shutter, from how its path is moving at this instant. Fast pans and whips blur cleanly; wire a Render's depth for the parallax of a travelling camera.",
  tags: ["motion blur", "blur", "camera", "shutter", "whip", "pan", "3d"],
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE },
    {
      id: "depth",
      label: "Depth",
      type: DATA_TEXTURE,
      optional: true,
      description: "Optional. A Render's depth output (R = view distance ÷ far): points keep their distance, so a travelling camera's parallax blurs near things more. Unwired, every pixel is at infinity.",
    },
    // Reference-fed plumbing (§V373): the `camera` PARAMETER names the node and the compiler
    // synthesizes this edge, exactly as for the renderers.
    { id: "camera", label: "Camera", optional: true, type: { kind: "camera" }, readsMotion: true },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  sourceReferences: [{ parameter: "camera", input: "camera" }],
  parameters: {
    camera: {
      type: "string",
      label: "Camera",
      default: "",
      description: "Name of the Camera whose motion blurs the picture — the one that rendered it.",
    },
    shutter: {
      type: "number",
      label: "Shutter",
      default: 0.5,
      min: 0,
      max: 4,
      range: "floor",
      description: "How long the shutter is open, as a share of a frame: 0.5 is a 180° shutter, 1 a 360° one; past 1 is a smear longer than the frame.",
    },
    maxBlur: {
      type: "number",
      label: "Max Blur",
      default: 0.5,
      min: 0,
      max: 4,
      range: "floor",
      description: "The longest smear, as a fraction of the frame height.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const camera = inputs["camera"]?.scene as CameraPayload | undefined;
    // A named camera is a promise (camera-reference.ts): a name that did not resolve refuses.
    const dangling = danglingCameraRefusal(parameters, camera?.kind === "camera");
    if (dangling !== null) {
      return {
        passes: [],
        diagnostics: [{ severity: "error", code: "node.camera.reference", message: `Node "${nodeId}": ${dangling}`, nodeId, suggestion: DANGLING_CAMERA_SUGGESTION }],
      };
    }
    const depth = inputs["depth"];
    const aspect = resolution[0] / resolution[1];
    const motion = camera?.kind === "camera" && camera.ortho !== true ? camera.motion : undefined;
    let uniforms: Record<string, number | readonly number[]> = {
      right: [1, 0, 0, 1],
      up: [0, 1, 0, aspect],
      forward: [0, 0, -1, 1],
      prevRight: [1, 0, 0, 1],
      prevUp: [0, 1, 0, 0],
      prevForward: [0, 0, -1, 0],
      prevEye: [0, 0, 0, 0],
      scale: 0,
      maxBlur: readNumber(parameters, "maxBlur", 0.5),
      useDepth: 0,
      enabled: 0,
    };
    if (camera !== undefined && motion !== undefined) {
      const now: CameraPose = { eye: camera.eye, lookAt: camera.lookAt, fovDeg: camera.fovDeg, roll: camera.roll ?? 0 };
      // The side of the path that does not jump; the other side mirrored through now.
      const previous: CameraPose =
        change(motion.before, now) <= change(motion.after, now)
          ? motion.before
          : {
              eye: mirror3(now.eye, motion.after.eye),
              lookAt: mirror3(now.lookAt, motion.after.lookAt),
              fovDeg: mirror(now.fovDeg, motion.after.fovDeg),
              roll: mirror(now.roll, motion.after.roll),
            };
      const b = cameraBasis(now.eye, now.lookAt, now.roll);
      const p = cameraBasis(previous.eye, previous.lookAt, previous.roll);
      const tan = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360);
      uniforms = {
        right: [...b.right, tan(now.fovDeg)],
        up: [...b.up, aspect],
        forward: [...b.forward, camera.far],
        prevRight: [...p.right, tan(previous.fovDeg)],
        prevUp: [...p.up, 0],
        prevForward: [...p.forward, 0],
        // Relative to the current eye, in f64 here, so the shader never subtracts two nearly
        // equal positions in f32.
        prevEye: [...sub(previous.eye, now.eye), 0],
        scale: (readNumber(parameters, "shutter", 0.5) * motion.frameSeconds) / motion.dt,
        maxBlur: readNumber(parameters, "maxBlur", 0.5),
        useDepth: depth === undefined ? 0 : 1,
        enabled: 1,
      };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:camera-blur`,
      shader: CAMERA_BLUR_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        // Unwired depth binds the picture itself; `useDepth` 0 never reads it.
        { binding: "depthTexture", resourceId: (depth ?? source).resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      sharedBinding: "frameU",
      uniforms,
      nodeId,
      label: "Camera Blur",
    };
    return { passes: [pass] };
  },
};
