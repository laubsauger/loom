import type { CompiledNodeDescription, NodeCompileContext, NodeDefinition, NodeValueFunction, PassFrameValues, ScratchRequest } from "../../domain/types/node-definition.ts";
import type { ParameterSchema, StoredParameter } from "../../domain/types/parameters.ts";
import { isParameterSlot, storedStaticValue } from "../../domain/parameters/slots.ts";
import { instanceShapeIndex, parseInstanceShape } from "./render-instances.ts";
import type { BufferBindingDescriptor, BufferWritePassDescriptor, DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { relocated, type WgslSourceMap } from "../../runtime/backend/wgsl-source-map.ts";
import type { CameraMotion, CameraPose } from "../../domain/types/scene.ts";
import type { CameraPayload, GeometryPayload, LightPayload, MapExtend, MaterialPayload, ProjectorPayload, ScenePairRef, ScenePayload } from "../../domain/types/scene.ts";
import { resolveGroupPredicate } from "./points.ts";
import { DEFAULT_MATERIAL } from "../../domain/types/scene.ts";
import { cameraBasis, cameraFrame, cameraPayloadMatrix, directionalShadowMatrix, inCameraFrame, lookAt, pointShadowFaceMatrices, pointShadowFaceReaches, projectorDepthRange, projectorMatrix } from "../../domain/geometry/camera.ts";
import { identityMatrix, normalMatrix, objectMatrix } from "../../domain/geometry/transform.ts";
import { gridPointCount, gridSheets, gridVertexCount, parseTopology } from "../../points/topology.ts";
import { missingCompileResource, readCompileInputs, readValueInputs } from "./compile-context.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { DANGLING_CAMERA_SUGGESTION, danglingCameraRefusal } from "./camera-reference.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import type { Params } from "./parameter-readers.ts";
import type { TimeProbe } from "../../compiler/time-probe.ts";
import { countedDrawSupport, resolveColorMap, resolveScalarMap } from "./points.ts";
import { attributeBinding } from "./point-storage.ts";
import { instanceRecordStorage, isPackedType, packedGroups } from "./instance-records.ts";
import { instanceResolveWgsl, RESOLVE_ARGS_BINDING, RESOLVE_LIVE_BINDING, RESOLVE_RECORDS_BINDING, RESOLVE_SHADOW_ARGS_BINDING, RESOLVE_SOURCE_PREFIX, resolveWorkgroups, type InstanceResolveOptions } from "../shaders/instance-resolve.wgsl.ts";
import { bindInstanceAttributes } from "./instance-attributes.ts";
import { applyMaterialOverrides } from "./material-overrides.ts";
import { compileLightPoints, lightMapRefusal, lightSpotDraw, lightSpotUnbuilt, lightTablePlan, type LightTablePlan, type NamedLight, type PointLightSource } from "./light-points.ts";
import {
  GLASS_BLIT_WGSL,
  SSAA_RESOLVE_WGSL,
  GLASS_DOWN_WGSL,
  GLASS_PYRAMID_LEVELS,
  GLASS_VBLUR_WGSL,
  SHADOW_CLEAR_WGSL,
  backdropWgsl,
  glassInstancesWgsl,
  glassMeshWgsl,
  glassSurfaceWgsl,
  sceneInstancesWgsl,
  sceneSurfaceModule,
  INSTANCED_BINDING_PREFIX,
  type SceneInstancedOption,
  type SceneShadingOptions,
  type SceneSurfaceModule,
  shadowInstancesWgsl,
  shadowSurfaceWgsl,
  shadowMeshWgsl,
  cubeShadowVariant,
  GBUFFER_CLEAR_WGSL,
  CUSTOM_SURFACE_FRAME_BINDING,
  materialParamUniformKey,
  lightMetaUniform,
  ENV_PREFILTER_BASE_WGSL,
  ENV_PREFILTER_PACK_WGSL,
  ENV_PREFILTER_SIDES,
  ENV_PREFILTER_SPREADS,
  envPrefilterLevelWgsl,
} from "../shaders/scene-render.wgsl.ts";
import { aoBlurWgsl, aoResolveWgsl, aoSampleCount } from "../shaders/scene-ao.wgsl.ts";

/**
 * VNB11 — what a projector's lit read needs to compare DEPTHS rather than fragment-z: the
 * frustum's near and far (the matrix's own, `projectorDepthRange`), and the image's angular
 * width as 2·tan(half) — widened for keystone, whose wide side reaches past the native image
 * by up to 1 / (1 − tan k) — so the bias can be the depth map's texel footprint.
 */
function projectorOcclusionMeta(proj: {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  readonly throwRatio: number;
  readonly keystoneH: number;
  readonly keystoneV: number;
}): [number, number, number] {
  const { near, far } = projectorDepthRange(proj);
  const tanOf = (degrees: number): number => Math.abs(Math.tan((degrees * Math.PI) / 180));
  const narrowest = Math.max(0.25, 1 - tanOf(proj.keystoneH) - tanOf(proj.keystoneV));
  return [near, far, 1 / Math.max(proj.throwRatio, 0.05) / narrowest];
}

/**
 * T624 — the two AO constants that are NOT knobs. The bias is the slope threshold that
 * keeps a smooth surface from occluding itself (below it, a tap is on this point's own
 * tangent plane); the blur radius is what turns the resolve's per-pixel spiral rotation
 * back into a smooth field. Neither is a look decision, so neither is a parameter (V90).
 */
const AO_BIAS = 0.025;
const AO_BLUR_RADIUS = 3;

/**
 * The 3D pipeline (T376/T377/T447): camera, light and geometry are THINGS, and a
 * Render consumes them — by NAME (the owner's ruling: many-object scenes are the
 * normal case, and twenty wires converging on one node is the shape that does not
 * survive real use). The compiler resolves every name into a synthesized edge before
 * validation, so internally this is ordinary port plumbing (V373); the payloads ride
 * the same structural channel pointsets do, as pure CPU VALUES — an orbiting camera or
 * a moving light is a uniform write per frame, never a rebuild (§V5).
 *
 * The line that answers every future port-or-reference question (V372): GPU DATA
 * (pointsets, textures — including material MAP textures) flows on WIRES; SCENE
 * ASSEMBLY (which geometry, which camera, which lights, which material) flows by NAME.
 */

const vec3 = (params: Readonly<Record<string, unknown>>, key: string, fallback: readonly [number, number, number]) => {
  const read = readVector(params as never, key, [...fallback]);
  return [read[0] ?? fallback[0], read[1] ?? fallback[1], read[2] ?? fallback[2]] as const;
};

/**
 * T1421b: how far either side of the frame the Camera differentiates its own path, seconds.
 * Small, so a whip is linearised at its instantaneous direction; one millisecond keeps the
 * difference well above f32 noise in every consumer, and the two-sided payload lets a
 * consumer step away from a cut that falls inside it.
 */
export const CAMERA_MOTION_SECONDS = 1 / 1000;

const samePose = (a: CameraPose, b: CameraPose): boolean =>
  a.fovDeg === b.fovDeg && a.roll === b.roll && a.eye.every((v, i) => v === b.eye[i]) && a.lookAt.every((v, i) => v === b.lookAt[i]);

/**
 * §T1656b: Eye and Look At are offsets in the frame Origin and Heading make. THE ONE
 * COMPOSITION: the payload carries these world positions (so no consumer of a camera knows
 * the frame exists) and §T1674b's channels are these same numbers, read by an expression.
 * §T1671b: the Frame is read HERE, so an Aimed frame reaches the payload and the channels by
 * the one function, and a reader of the channels changes nothing when a camera opts in.
 */
function composedCameraPose(values: Readonly<Record<string, unknown>>): CameraPose {
  const frame = cameraFrame(
    vec3(values, "origin", [0, 0, 0]),
    vec3(values, "heading", [0, 0, 0]),
    values["frame"] === "aimed" ? "aimed" : "level",
  );
  return {
    eye: inCameraFrame(frame, vec3(values, "eye", [0, 0.5, 3])),
    lookAt: inCameraFrame(frame, vec3(values, "lookAt", [0, 0, 0])),
    fovDeg: readNumber(values as never, "fov", 55),
    roll: readNumber(values as never, "roll", 0),
  };
}

const AXES = ["X", "Y", "Z"] as const;

/** §T1674b: is this camera's Origin or Heading anything but the default, as STORED? */
function cameraHasFrame(stored: Readonly<Record<string, StoredParameter>>): boolean {
  const moved = (value: StoredParameter | undefined): boolean => {
    if (value === undefined) return false;
    // A slot in any mode but static is driven: an expression is a frame, whatever it is worth now.
    if (isParameterSlot(value) && value.mode !== "static") return true;
    const held = storedStaticValue(value);
    if (typeof held === "number") return held !== 0;
    return Array.isArray(held) && held.some((component) => component !== 0);
  };
  return ["origin", "heading"].some((key) => moved(stored[key]) || ["x", "y", "z"].some((axis) => moved(stored[`${key}.${axis}`])));
}

/**
 * §T1674b — THE CAMERA'S POSE IN THE WORLD, AS CHANNELS: what a pass that turns a pixel back
 * into a ray reads (lit air, a focus by distance, a reflection). The payload's own numbers,
 * from the payload's own function, and the basis the Render's view is built on
 * (`cameraBasis`: the guarded up, Roll included).
 */
const cameraChannels: NonNullable<NodeDefinition["parameterChannels"]> = {
  names: {
    eyeX: "Where the camera is, in the world: x",
    eyeY: "Where the camera is, in the world: y",
    eyeZ: "Where the camera is, in the world: z",
    aimX: "The point it looks at, in the world: x",
    aimY: "The point it looks at, in the world: y",
    aimZ: "The point it looks at, in the world: z",
    forwardX: "The way it looks, a unit vector: x",
    forwardY: "The way it looks, a unit vector: y",
    forwardZ: "The way it looks, a unit vector: z",
    rightX: "The picture's right, Roll included: x",
    rightY: "The picture's right, Roll included: y",
    rightZ: "The picture's right, Roll included: z",
    upX: "The picture's up, Roll included: x",
    upY: "The picture's up, Roll included: y",
    upZ: "The picture's up, Roll included: z",
    distance: "From the camera to the point it looks at",
    fov: "The field of view, in degrees",
  },
  reads: ["eye", "lookAt", "origin", "heading", "frame", "fov", "roll"],
  evaluate(values) {
    const pose = composedCameraPose(values);
    const basis = cameraBasis(pose.eye, pose.lookAt, pose.roll);
    const channels: Record<string, number> = {
      distance: Math.hypot(pose.lookAt[0] - pose.eye[0], pose.lookAt[1] - pose.eye[1], pose.lookAt[2] - pose.eye[2]),
      fov: pose.fovDeg,
    };
    AXES.forEach((axis, index) => {
      channels[`eye${axis}`] = pose.eye[index] as number;
      channels[`aim${axis}`] = pose.lookAt[index] as number;
      channels[`forward${axis}`] = basis.forward[index] as number;
      channels[`right${axis}`] = basis.right[index] as number;
      channels[`up${axis}`] = basis.up[index] as number;
    });
    return channels;
  },
  insteadOf(parameter, component, stored) {
    if (parameter !== "eye" && parameter !== "lookAt") return null;
    if (!cameraHasFrame(stored)) return null;
    const axis = component === "y" ? "Y" : component === "z" ? "Z" : "X";
    return {
      channel: `${parameter === "eye" ? "eye" : "aim"}${axis}`,
      gives: "the offset in the frame its Origin and Heading make",
      wants: parameter === "eye" ? "where the camera is in the world" : "the point it looks at in the world",
    };
  },
};

/** T377 — the camera as a THING: shareable, drivable, referenced by name. */
export const cameraNode: NodeDefinition = {
  type: "camera",
  version: 1,
  title: "Camera",
  category: "render",
  description:
    "A camera other nodes reference by NAME: Render, Render Surface and Render Instances all name it in their camera parameter, so one camera frames them together. Every parameter is drivable — an orbiting camera is a uniform write, never a rebuild. To follow something that moves, drive Origin and Heading with it and leave Eye and Look At as the offset: the view can then be flown by hand and still follows. An expression on another node reads where the camera IS in the world as op('camera_name').chan.eyeX (eye, aim, forward, right, up as X Y Z, and distance and fov): with Origin or Heading set, par.eye and par.lookAt are the offset. Its preview shows WHAT THE RENDERER SEES: with exactly one renderer naming this camera, the preview is that renderer's own picture; with none, a stock reference scene showing framing alone; with several, the stock scene again, because there is no single answer and picking one would be a viewpoint nobody chose.",
  tags: ["3d", "scene", "camera", "view"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "camera" } }],
  parameterChannels: cameraChannels,
  parameters: {
    eye: { type: "vector", size: 3, label: "Eye", default: [0, 0.5, 3] },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0] },
    origin: {
      type: "vector",
      size: 3,
      label: "Origin",
      default: [0, 0, 0],
      description:
        "Where Eye and Look At are measured from. Drive it with the position of what the camera follows, and Eye and Look At become offsets from that subject: a view flown by hand in the viewer or on this tile is then an offset that travels with it. At 0, 0, 0 Eye and Look At are world positions.",
    },
    heading: {
      type: "vector",
      size: 3,
      label: "Heading",
      default: [0, 0, 0],
      description:
        "The direction the frame faces, as a vector: the frame's forward is its −z, the way the default camera looks, so an offset behind the subject stays behind it. With Frame on Level only the horizontal part is read: Eye and Look At turn about the vertical, and the camera rises with the subject and never tilts with it. With Frame on Aimed it is read whole. At 0, 0, 0 nothing turns and only Origin's position is inherited.",
    },
    frame: {
      type: "enum",
      label: "Frame",
      default: "level",
      options: [
        { value: "level", label: "Level" },
        { value: "aimed", label: "Aimed" },
      ],
      description:
        "How Heading is read. Level: only its horizontal part, so the frame turns about the vertical and never tilts (a chase camera keeps its own horizon). Aimed: whole, so the frame's forward is Heading itself and Look At 0, 0, −d is d along it (a directed shot: drive Origin with where the camera is and Heading with where it looks, and Eye and Look At stay plain numbers that a flight can write). A Heading within about 2.6° of straight up or down takes world +z as its up, as the camera's own view does. Flying it keeps its world meaning in either frame: a drag orbits Look At about the world's vertical, a turntable, and E and Q rise and fall along the picture's up. Bank the picture with Roll.",
    },
    fov: { type: "number", label: "FOV", default: 55, min: 1, max: 179, range: "bounded", unit: "degrees" },
    near: { type: "number", label: "Near", default: 0.1, min: 0.001, range: "floor" },
    far: { type: "number", label: "Far", default: 100, min: 0.01, range: "floor" },
    roll: {
      type: "number",
      label: "Roll",
      default: 0,
      min: -180,
      max: 180,
      range: "cyclic",
      unit: "degrees",
      description:
        "Bank around the view axis, right-handed as in Blender and three.js: positive turns the camera counter-clockwise as seen from behind it, so the picture turns clockwise. Aim stays Look At's job — eye, Look At and Roll together are the full orientation (T706), so drive this to tilt the horizon without moving the shot. The preview gizmo (T692) leaves Roll alone on purpose: banking is a framing decision you set and hold, not a navigation gesture, so it stays a number here rather than a drag.",
    },
    ortho: { type: "boolean", label: "Orthographic", default: false },
    orthoHeight: {
      type: "number",
      label: "Ortho Height",
      default: 2,
      min: 0.001,
      range: "floor",
      inactiveWhen: (values) => (values["ortho"] === false ? "Perspective cameras size by FOV." : null),
    },
  },
  compile(context): CompiledNodeDescription {
    const { parameters, timeProbe } = readCompileInputs(context);
    // T1719b: the payload is all a camera publishes, so its value function is the payload's.
    return {
      passes: [],
      scene: { out: cameraPayloadAt(parameters, timeProbe) },
      values: (next) => {
        const read = readValueInputs(next);
        return { passes: [], scene: { out: cameraPayloadAt(read.parameters, read.timeProbe) } };
      },
    } as CompiledNodeDescription;
  },
};

/** The camera's payload from its resolved parameters, and its motion where it is probed (T1421b, T1721b). */
function cameraPayloadAt(parameters: Params, timeProbe: TimeProbe | undefined): CameraPayload {
  // §T1656b: the payload carries WORLD positions (`composedCameraPose`), so no consumer of
  // a camera (a Render, the tile, Camera Blur's motion) knows the frame exists.
  const pose = composedCameraPose;
  // T1421b: the path's derivative, both sides, for a motion blur (Camera Blur) — published
  // only when the camera MOVES there, so a still camera's payload is the same with or
  // without a frame (the values-only frame path never re-runs a camera that animates nothing).
  const now = pose(parameters);
  const before = timeProbe?.parametersAt(-CAMERA_MOTION_SECONDS);
  const after = timeProbe?.parametersAt(CAMERA_MOTION_SECONDS);
  const motion: CameraMotion | undefined =
    timeProbe === undefined || before === undefined || after === undefined || (samePose(pose(before), now) && samePose(pose(after), now))
      ? undefined
      : { dt: CAMERA_MOTION_SECONDS, frameSeconds: timeProbe.frameSeconds, before: pose(before), after: pose(after) };
  const payload: CameraPayload = {
    kind: "camera",
    eye: now.eye,
    lookAt: now.lookAt,
    fovDeg: readNumber(parameters, "fov", 55),
    near: readNumber(parameters, "near", 0.1),
    far: readNumber(parameters, "far", 100),
    ortho: parameters["ortho"] === true,
    orthoHeight: readNumber(parameters, "orthoHeight", 2),
    roll: readNumber(parameters, "roll", 0),
    ...(motion === undefined ? {} : { motion }),
  };
  return payload;
}

/**
 * T704 — a projector: a camera pose that THROWS a texture into the scene.
 *
 * Referenced by a Render exactly as lights are (its `projectors` list), because to the
 * renderer this IS a light wearing a cookie: its contribution is ADDITIVE radiance —
 * never the albedo-multiply path, which would black the building everywhere outside
 * the beam (§V644). The pose is deliberately T706's trio (eye / lookAt / roll), so the
 * document has ONE orientation representation and T692's tile gizmo extends here. The
 * optics are the numbers a venue lens sheet prints — throw ratio, native aspect, lens
 * shift, keystone — not cone angles; that vocabulary is what makes this previz rather
 * than a demo. Occlusion is on by default because it is the honesty of the tool: a
 * surface the projector cannot see receives nothing, so a parapet shadows the face
 * below it — which is precisely the question people are on site to answer.
 */
export const projectorNode: NodeDefinition = {
  type: "projector",
  version: 1,
  title: "Projector",
  category: "render",
  description:
    "Throws its Cookie input into the scene the way a projector on site would: aim with Eye/Look At/Roll, set the lens by Throw Ratio, Aspect, Lens Shift and Keystone, and reference it from a Render's projectors list (any number — overlap zones simply add). Brightness is nominal at the Look At distance, falling off inverse-square beyond it; surfaces the projector cannot see receive nothing, so architecture shadows itself honestly.",
  tags: ["3d", "scene", "projector", "previz", "light"],
  inputs: [
    {
      id: "cookie",
      label: "Cookie",
      type: RGBA_TEXTURE,
      optional: true,
      description: "The projected content. Unwired, the projector throws plain white — a focus light.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: { kind: "projector" } }],
  parameters: {
    eye: { type: "vector", size: 3, label: "Eye", default: [2, 2, 3] },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0] },
    roll: {
      type: "number",
      label: "Roll",
      default: 0,
      min: -180,
      max: 180,
      range: "cyclic",
      unit: "degrees",
      description:
        "Bank around the throw axis — a projector mounted sideways is a rolled projector. Positive turns the projector counter-clockwise as seen from behind it, as the Camera's Roll does.",
    },
    throwRatio: {
      type: "number",
      label: "Throw Ratio",
      default: 1.5,
      min: 0.3,
      max: 12,
      step: 0.01,
      range: "floor",
      description: "Throw distance ÷ image width — the number printed on the lens. Smaller is wider.",
    },
    aspect: {
      type: "number",
      label: "Aspect",
      default: 1.7778,
      min: 0.4,
      max: 4,
      step: 0.0001,
      range: "floor",
      description: "The projector's NATIVE image aspect (16:9 ≈ 1.778), not the project's.",
    },
    shiftX: {
      type: "number",
      label: "Lens Shift X",
      default: 0,
      min: -1,
      max: 1,
      range: "soft",
      description: "Slides the image sideways by fractions of its width WITHOUT re-aiming — the off-axis shift a real install turns.",
    },
    shiftY: {
      type: "number",
      label: "Lens Shift Y",
      default: 0,
      min: -1,
      max: 1,
      range: "soft",
      description: "Slides the image up/down by fractions of its height, off-axis.",
    },
    keystoneH: {
      type: "number",
      label: "Keystone H",
      default: 0,
      min: -30,
      max: 30,
      range: "soft",
      unit: "degrees",
      description: "Horizontal trapezoid correction — one side of the image scales against the other.",
    },
    keystoneV: {
      type: "number",
      label: "Keystone V",
      default: 0,
      min: -30,
      max: 30,
      range: "soft",
      unit: "degrees",
      description: "Vertical trapezoid correction.",
    },
    brightness: {
      type: "number",
      label: "Brightness",
      default: 1,
      min: 0,
      range: "floor",
      description: "Nominal at the Look At distance; inverse-square beyond it when Falloff is on.",
    },
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    falloff: {
      type: "boolean",
      label: "Distance Falloff",
      default: true,
      description: "Physical inverse-square about the throw distance. Off = the beam carries flat, a stylisation.",
    },
    occlusion: {
      type: "boolean",
      label: "Occlusion",
      default: true,
      compileTime: true,
      description: "Surfaces the projector cannot see receive nothing — a parapet shadows the wall below. Off is a decal that lies about the site; sometimes that is wanted.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { parameters } = readCompileInputs(context);
    const cookieInput = (context as { inputs?: Record<string, ReadonlyArray<{ resourceId?: string }>> })
      .inputs?.["cookie"]?.[0];
    const cookieResource =
      typeof cookieInput?.resourceId === "string" ? cookieInput.resourceId : undefined;
    const color = readColor(parameters, "color", [1, 1, 1, 1]);
    const payload: ProjectorPayload = {
      kind: "projector",
      eye: vec3(parameters, "eye", [2, 2, 3]),
      lookAt: vec3(parameters, "lookAt", [0, 0, 0]),
      roll: readNumber(parameters, "roll", 0),
      throwRatio: readNumber(parameters, "throwRatio", 1.5),
      aspect: readNumber(parameters, "aspect", 1.7778),
      shiftX: readNumber(parameters, "shiftX", 0),
      shiftY: readNumber(parameters, "shiftY", 0),
      keystoneH: readNumber(parameters, "keystoneH", 0),
      keystoneV: readNumber(parameters, "keystoneV", 0),
      brightness: readNumber(parameters, "brightness", 1),
      color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1],
      falloff: parameters["falloff"] !== false,
      occlusion: parameters["occlusion"] !== false,
      ...(cookieResource === undefined ? {} : { cookieResource }),
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  },
};

/**
 * T1589b: why the shadow rows of a Light in Points mode are not read. Inactive and ignored,
 * never a refusal: flipping Mode on a casting Light must not stop the render.
 */
const pointsCastNothing = (values: Readonly<Record<string, unknown>>): string | null =>
  values["mode"] === "points" ? "A shadow map belongs to one light: a Light in Single mode casts, the lights of a pointset do not." : null;

/**
 * T1623b slice 3: a spot is a kind of ROW of a Render's light table, and a CASTING Light in
 * Single mode is not a row yet (slices 4 and 5): it shines as a point light, its two cone
 * rows say so, and the Light says so by name (`lightSpotUnbuilt`).
 */
const CASTING_SPOT = "A casting Light has no cone yet: with Cast Shadows on this light shines as a Point light, in every direction.";
/** A point light and a spot stand at a place: they have a Position, a Falloff and a Range. */
const lightIsPlaced = (values: Readonly<Record<string, unknown>>): boolean => values["kind"] === "point" || values["kind"] === "spot";
const spotInactive = (values: Readonly<Record<string, unknown>>): string | null =>
  values["kind"] !== "spot" ? "Only a Spot has a cone." : values["mode"] !== "points" && values["shadows"] === true ? CASTING_SPOT : null;

/**
 * The Light's DECLARED parameters, hoisted (T1589b) so `parametersFor` can derive the schema
 * one placed node carries without reading the node back off itself (§T903's funnel), as
 * `GEOMETRY_PARAMETERS` is.
 */
const LIGHT_PARAMETERS: ParameterSchema = {
  kind: {
    type: "enum",
    label: "Type",
    default: "directional",
    options: [
      { value: "directional", label: "Directional" },
      { value: "point", label: "Point" },
      { value: "spot", label: "Spot" },
    ],
    description:
      "Directional travels along Direction from infinitely far. Point sits at Position and shines every way. Spot (T1589b) sits there and shines along Direction inside its Cone. A VALUE: changing it rebuilds nothing. A Spot that casts shadows has no cone yet: it shines as a Point light and the Light says so, until casting Lights become rows of the Render's light table (T1623b).",
  },
  /*
   * T1589b — ONE LIGHT, OR ONE AT EVERY POINT (docs/lights-from-pointset-design-2026-10-06.md).
   * Structural: a Light in Points mode owns a pass and a buffer, and a Render culls its
   * lights on the GPU instead of unrolling a block for it.
   */
  mode: {
    type: "enum",
    label: "Mode",
    default: "single",
    compileTime: true,
    options: [
      { value: "single", label: "Single" },
      { value: "points", label: "Points" },
    ],
    description:
      "Single is one light, at Position. Points repeats this light at every point of the Points input: N lights from ONE node, each standing at its point's position. In Map mode Color takes a vec4f attribute and Intensity, Range and Cone an f32 (or one channel of a float vector), each MULTIPLYING the value here per point, so the number stays live for the whole set; Position, Direction and Orient in Map mode take an attribute IN PLACE of the value (a vec3f place, a vec3f way to travel, a vec4f quaternion). A light whose intensity, mapped range or mapped cone is zero is off, and so is a dead point of a counted pointset. A Render culls these lights by their Range on the GPU, so give them one. With Type: Directional the set is that many suns, each travelling along its direction; a directional light reaches every pixel, so none of them is culled. A Render's light table holds at most 1,024 rows, every slot of the set counted (see Points).",
  },
  color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
  intensity: { type: "number", label: "Intensity", default: 1, min: 0, range: "floor" },
  direction: {
    type: "vector",
    size: 3,
    label: "Direction",
    default: [-0.4, -0.8, -0.45],
    description:
      "The way the light travels: a Directional light's direction, a Spot's axis. Any length. In Points mode in Map mode a vec3f attribute, in world space, is each light's direction in place of this one.",
    inactiveWhen: (values) => (values["kind"] === "point" ? "A point light shines everywhere." : null),
  },
  /*
   * T1589b slice 2 — WHICH WAY EACH LIGHT OF A SET SHINES. `aim = R(orient) · direction`, the
   * Geometry's Orient (T723): a unit quaternion, right-handed and active. As a value it turns
   * Direction for the whole set; in Map mode each point brings its own, which is what lets a
   * lamp along a path shine along the path's own frame.
   */
  orient: {
    type: "vector",
    size: 4,
    label: "Orient",
    default: [0, 0, 0, 1],
    description:
      "Mode: Points. A unit quaternion (x, y, z, w) that TURNS Direction, right-handed and active as a Geometry's Orient: (0, 0, sin45, cos45) is a quarter turn about +Z and carries +X to +Y. As a value it turns the direction of every light of the set; in Map mode a vec4f attribute turns it per point. With Direction (0, −1, 0) and the orient of Curve Frames, each lamp along a path shines along its own frame's down.",
    inactiveWhen: (values) =>
      values["mode"] !== "points"
        ? "One light has one Direction: Orient turns it per point, in Mode: Points."
        : values["kind"] === "point"
          ? "A point light shines everywhere."
          : null,
  },
  cone: {
    type: "number",
    label: "Cone",
    default: 60,
    min: 1,
    max: 360,
    range: "bounded",
    description:
      "T1589b: a Spot's cone, in degrees: the FULL angle at which its light reaches zero. 359 or more is every direction, so a set can mix spots and bare lamps by one attribute. In Map mode an f32 (or one channel of a float vector) multiplies it per point. A Render culls a spot by its Range, not by its cone: a narrow spot is still walked by every pixel in its range (T1625b).",
    inactiveWhen: (values) => spotInactive(values),
  },
  coneSoftness: {
    type: "number",
    label: "Cone Softness",
    default: 0.4,
    min: 0,
    max: 1,
    range: "bounded",
    description:
      "T1589b: the share of the cone's half-angle over which a Spot fades. The light is whole inside (1 − softness) × Cone ÷ 2 and falls smoothly to zero at Cone ÷ 2. 0 is a hard edge; 1 fades from the axis out.",
    inactiveWhen: (values) => spotInactive(values),
  },
  position: {
    type: "vector",
    size: 3,
    label: "Position",
    default: [1, 2, 1.5],
    inactiveWhen: (values) =>
      values["mode"] === "points"
        ? "Each light stands at its point's position. In Map mode a vec3f attribute is its place instead."
        : values["kind"] === "directional"
          ? "A directional light is infinitely far."
          : null,
  },
  falloff: {
    type: "enum",
    label: "Falloff",
    default: "soft",
    options: [
      { value: "soft", label: "Soft 1/(1+d²)" },
      { value: "inverseSquare", label: "Inverse Square 1/d²" },
    ],
    description:
      "T1437b: how a point light dims with distance d. Soft, 1/(1+d²), is nearly flat inside a metre, so a lamp close to a subject lights its near and far side almost alike. Inverse Square, 1/d², is the physical law: a lamp at 30 cm lights a surface at 60 cm a quarter as much, which is what makes a close key read as close. Distance is held at 1 cm or more. Far from the light the two agree; inside a metre Inverse Square is brighter and much steeper.",
    inactiveWhen: (values) => (lightIsPlaced(values) ? null : "A directional light does not fall off."),
  },
  range: {
    type: "number",
    label: "Range",
    default: 0,
    min: 0,
    range: "floor",
    description:
      "T1437b: how far a point light reaches, in world units. The falloff is multiplied by (1 − (d/range)⁴)², so it reaches exactly zero at the range and is barely touched inside half of it. 0 is unlimited. The Range is what a Render culls a light by (T1589b, T1623b): a light with one is shaded only by the pixels it reaches, and a light with none by every lit pixel. In Points mode it defaults to 10, so that a set of lamps does not cost every pixel every lamp.",
    inactiveWhen: (values) => (lightIsPlaced(values) ? null : "A directional light is infinitely far."),
  },
  shadows: {
    type: "boolean",
    label: "Cast Shadows",
    default: false,
    compileTime: true,
    description:
      "T481: this light casts — ADDS ONE FULL SCENE PASS per render that lists it (a directional light), or SIX (a point light: one per cube face, T1362b). The passes are named per light in the performance panel so their cost is visible. Shadow Casters and Shadow Exclude choose which geometries those passes draw (T1598b). Changing it rebuilds the Render: to put a shadow out and bring it back while playing, use Shadow On.",
    inactiveWhen: pointsCastNothing,
  },
  shadowOn: {
    type: "boolean",
    label: "Shadow On",
    default: true,
    description:
      "T1688b: the switch of a casting light's shadow, and A VALUE: a cue, a preset or an expression turns it, and nothing is rebuilt. Off, this frame none of this light's shadow passes draws a caster (their cost is the casters' triangles, a point light's six times) and the light shades everything in its reach as if nothing stood in its way; the frame it comes back on, the shadow is drawn from where the casters are now. The lookup the lit pass makes stays (Shadow Softness prices it): to be rid of that too, turn Cast Shadows off, which rebuilds. Driven by an expression, any value but 0 is on.",
    inactiveWhen: (values) => pointsCastNothing(values) ?? (values["shadows"] === true ? null : "Only a casting light has a shadow to switch."),
  },
  shadowExtent: {
    type: "number",
    label: "Shadow Extent",
    default: 8,
    min: 0.1,
    range: "floor",
    description:
      "Directional: world-units half-extent of the shadow volume around its Shadow Centre (the origin by default). Point (T1362b): the shadow RANGE in world units — casters and receivers beyond it are unshadowed, and depth precision is spread over it, so keep it close to how far the light visibly reaches. Explicit on purpose: nothing knows your scene's bounds, and a guessed box would crop shadows plausibly-wrong (V426).",
    inactiveWhen: (values) => pointsCastNothing(values) ?? (values["shadows"] === true ? null : "Only a casting light frames a shadow volume."),
  },
  shadowCenter: {
    type: "vector",
    size: 3,
    label: "Shadow Centre",
    default: [0, 0, 0],
    description:
      "T1405b: the world point a directional light's shadow volume is framed around — Shadow Extent either side of it. Put it on the set (a set away from the origin otherwise gets no sun shadows at all), or drive it by expression to follow the camera or the subject. Moving it does not rebuild anything.",
    inactiveWhen: (values) =>
      pointsCastNothing(values) ?? (lightIsPlaced(values) ? "A point light's shadow is centred on the light." : values["shadows"] === true ? null : "Only a casting light frames a shadow volume."),
  },
  shadowSoftness: {
    type: "number",
    label: "Shadow Softness",
    default: 2,
    min: 0,
    max: 4,
    step: 1,
    range: "bounded",
    compileTime: true,
    description:
      "T1285: PCF radius in SHADOW MAP TEXELS — (2r+1)² taps per lit fragment this light reaches, averaged, giving a penumbra 2r+1 texels wide instead of a hard staircase. Priced per tap in the MAIN pass, not a second sweep. 0 is the single-tap hard edge; turn it down if the shot cannot afford 25 loads.",
    inactiveWhen: (values) => pointsCastNothing(values) ?? (values["shadows"] === true ? null : "Only a casting light has an edge to soften."),
  },
  shadowBias: {
    type: "number",
    label: "Shadow Bias",
    default: 0,
    min: 0,
    range: "floor",
    compileTime: true,
    description:
      "T1438b: extra distance, in world units, a surface may sit behind the shadow map before it counts as shadowed — added to the built-in bias (one shadow-map texel plus a slope term). Raise it when a lit surface speckles or stripes with its own shadow (acne): a coarse mesh whose smoothed normals say it faces the light more than its facets do, or a large Shadow Extent spreading the map thin. Too much and a thin caster's shadow detaches from its base (peter-panning). 0 is the built-in bias alone. A compile-time knob: changing it rebuilds the shader.",
    inactiveWhen: (values) => pointsCastNothing(values) ?? (values["shadows"] === true ? null : "Only a casting light has a shadow to bias."),
  },
  shadowCasters: {
    type: "string",
    label: "Shadow Casters",
    default: "",
    description:
      "T1598b: space-separated geometry names — the ONLY geometries that cast this light's shadow. Empty: every geometry the Render draws casts. A geometry left out is still lit by this light, still receives its shadows and still casts for other lights. A casting light draws each caster again (a point light six times), so leave out what only ever receives: a floor, a wall, a tunnel.",
    inactiveWhen: (values) => pointsCastNothing(values) ?? (values["shadows"] === true ? null : "Only a casting light has casters."),
  },
  shadowExclude: {
    type: "string",
    label: "Shadow Exclude",
    default: "",
    description:
      "T1598b: space-separated geometry names that do NOT cast this light's shadow — taken out of Shadow Casters, or out of everything when that is empty. The shorter list to write when one big receiver is the only thing to leave out.",
    inactiveWhen: (values) => pointsCastNothing(values) ?? (values["shadows"] === true ? null : "Only a casting light has casters."),
  },
};

/**
 * T1589b: the schema a Light in POINTS mode carries. One row differs, and the funnel
 * (`parametersFor`, §T880) is what hands every reader the right one: Range defaults to 10.
 * The declared 0 is "unlimited", and a light with no range is in every cell of a Render's
 * grid: right for one light, the wrong default for a set.
 *
 * Type is a VALUE in both modes (T1623b): it is a field of each row, so changing it writes a
 * float and compiles nothing, and a pointset of directional lights is legal.
 */
const LIGHT_POINTS_PARAMETERS: ParameterSchema = {
  ...LIGHT_PARAMETERS,
  range: { ...LIGHT_PARAMETERS["range"], default: 10 } as ParameterSchema[string],
};

/** T377 — a light: directional or point, colour and intensity, all drivable. */
export const lightNode: NodeDefinition = {
  type: "light",
  version: 1,
  title: "Light",
  category: "render",
  description:
    "A light other nodes reference by NAME: a Render lists any number in its lights parameter (list order is light order). Directional lights travel along Direction; Point lights sit at Position with distance falloff (soft or inverse-square, and an optional range); Spot lights sit there and shine along Direction inside Cone. Mode: POINTS repeats the light at every point of the Points input, N lights from ONE node, never N nodes: each stands at its point's position, and Color, Intensity, Range, Direction, Orient and Cone take a per-point attribute in Map mode. A Render culls such lights by their Range on the GPU, so a lamp every few metres of a long set costs what the lamps near each pixel cost; give them a Range. A Spot that casts shadows has no cone yet: it shines as a Point light and says so. Colour, intensity and placement are all drivable. Only a light in Single mode casts shadows.",
  tags: ["3d", "scene", "light", "shading", "points", "lamps"],
  inputs: [
    {
      // T1589b: a real WIRE, because points are GPU data (§V372). Read in Points mode only.
      id: "points",
      label: "Points",
      optional: true,
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description:
        "Mode: Points — the pointset this light is repeated over: one light at each point's position. A Point Grid, a Point Kernel, a Resample along a curve. A counted pointset lights only its live points. Not read in Single mode. A Render's light table holds at most 1,024 rows: every point of capacity of its Lights in Points mode, lit or not, and a step of 32 for its Lights in Single mode that do not cast.",
    },
    // T1598b: reference-fed, as a Render's Scenes is — the two list parameters name the
    // geometries; the compiler synthesizes these edges; a wire is refused.
    { id: "shadowCasters", label: "Shadow Casters", optional: true, variadic: true, type: { kind: "scene" } },
    { id: "shadowExclude", label: "Shadow Exclude", optional: true, variadic: true, type: { kind: "scene" } },
  ],
  outputs: [{ id: "out", label: "Out", type: { kind: "light" } }],
  sourceReferences: [
    { parameter: "shadowCasters", input: "shadowCasters", list: true },
    { parameter: "shadowExclude", input: "shadowExclude", list: true },
  ],
  parameters: LIGHT_PARAMETERS,
  /** T1589b: a Light in Points mode has its own Range default. */
  parametersFor(stored) {
    return storedStaticValue(stored["mode"] as never) === "points" ? LIGHT_POINTS_PARAMETERS : LIGHT_PARAMETERS;
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const pointsMode = parameters["mode"] === "points";
    /* T1589b, §V288: a map this Light cannot honour refuses by name. In Single mode that is
       every map: one light has no points to read a per-point value from. */
    const unhonoured = lightMapRefusal(nodeId, parameterMaps, pointsMode);
    if (unhonoured !== undefined) return unhonoured;
    const payload = singleLightPayload(context, parameters);
    /* T1589b: one light at every point of the Points input, resolved once a frame into
       records a Render culls (light-points.ts). */
    if (pointsMode) {
      return compileLightPoints({
        nodeId,
        points: inputs["points"],
        parameters,
        parameterMaps,
        light: payload.light,
        lightAt: (next) => singleLightPayload(next, readValueInputs(next).parameters).light,
      });
    }
    // T1719b: a Light in Single mode publishes its payload alone, so its value function is the payload's.
    const single = {
      passes: [],
      scene: { out: payload },
      values: (next: NodeCompileContext) => ({ passes: [], scene: { out: singleLightPayload(next, readValueInputs(next).parameters) } }),
    } as CompiledNodeDescription;
    /* T1623b slice 3: a Light in Single mode that does not cast is a row of each Render's
       light table, and a spot is a kind of row. A CASTING one is still a block of the lit
       shader, which takes no cone: it shines as a point light and SAYS so. A warning and
       never a refusal: Type is a value, and a value does not decide what compiles. Goes with
       the last block (T1623b slice 5). */
    return parameters["kind"] === "spot" && payload.light.shadows ? { ...single, diagnostics: [lightSpotUnbuilt(nodeId)] } : single;
  },
};

/** A Light's payload in Single mode, from its resolved parameters and the names its caster lists resolved to (T1719b: one source for `compile` and its values). */
function singleLightPayload(context: NodeCompileContext, parameters: Params): LightPayload {
  const color = readColor(parameters, "color", [1, 1, 1, 1]);
  /* T1598b: the two lists as the ids of the nodes the names resolved to. A Render matches
     them against the geometries it draws, so a light shared by two Renders casts in each
     from what that Render has. */
  const named = (portId: string): string[] =>
    ((context as { inputs?: Record<string, ReadonlyArray<{ sourceNodeId?: string }>> }).inputs?.[portId] ?? []).flatMap((binding) =>
      binding.sourceNodeId === undefined ? [] : [binding.sourceNodeId],
    );
  const casters = named("shadowCasters");
  const excluded = named("shadowExclude");
  return {
    kind: "light",
    light: {
      /* A spot stands at a place, as a point light does. */
      type: parameters["kind"] === "point" || parameters["kind"] === "spot" ? "point" : "directional",
      color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1],
      intensity: readNumber(parameters, "intensity", 1),
      direction: vec3(parameters, "direction", [-0.4, -0.8, -0.45]),
      position: vec3(parameters, "position", [1, 2, 1.5]),
      shadows: parameters["shadows"] === true,
      /* T1688b: out only when it says so; a document from before the parameter has it on. */
      ...(parameters["shadowOn"] === false ? { shadowOn: false } : {}),
      shadowExtent: readNumber(parameters, "shadowExtent", 8),
      shadowSoftness: readNumber(parameters, "shadowSoftness", 2),
      shadowBias: Math.max(0, readNumber(parameters, "shadowBias", 0)),
      shadowCenter: vec3(parameters, "shadowCenter", [0, 0, 0]),
      ...(casters.length === 0 ? {} : { shadowCasters: casters }),
      ...(excluded.length === 0 ? {} : { shadowExclude: excluded }),
      falloff: parameters["falloff"] === "inverseSquare" ? "inverseSquare" : "soft",
      range: Math.max(0, readNumber(parameters, "range", 0)),
      /* T1623b: a spot's cone, for the row this Light is in a Render's table. */
      ...(parameters["kind"] === "spot" ? { spot: { cone: readNumber(parameters, "cone", 60), softness: readNumber(parameters, "coneSoftness", 0.4) } } : {}),
    },
  };
}

/**
 * T1598b: a sphere through an object matrix (column-major, the Transform group's: translate
 * × rotate × scale about a pivot). The centre is transformed; the radius grows by the
 * largest axis scale, which for that matrix is its longest column — exact for a rotation
 * times a scale, and it is never anything else here.
 */
function transformedSphere(
  sphere: { readonly center: readonly [number, number, number]; readonly radius: number },
  matrix: ReadonlyArray<number>,
): { center: [number, number, number]; radius: number } {
  const at = (index: number): number => matrix[index] ?? 0;
  const [x, y, z] = sphere.center;
  const column = (first: number): number => Math.hypot(at(first), at(first + 1), at(first + 2));
  return {
    center: [
      at(0) * x + at(4) * y + at(8) * z + at(12),
      at(1) * x + at(5) * y + at(9) * z + at(13),
      at(2) * x + at(6) * y + at(10) * z + at(14),
    ],
    radius: sphere.radius * Math.max(column(0), column(4), column(8)),
  };
}

/** T1581b: Instances mode drawing a MESH (the Shape Mesh input) at every point. */
const meshInstances = (values: Readonly<Record<string, unknown>>): boolean => values["mode"] === "instances" && values["shape"] === "mesh";

/**
 * T1588b, §V146: which geometries the object Transform reaches. A Surface draws by the
 * model matrix and a mesh instance by its record; primitive instances, points and beams
 * draw through generators that have no matrix until slice G of T1588b.
 *
 * There the four rows are INACTIVE AND IGNORED, and never a refusal. A refusal would be
 * decided by a VALUE, and a value never decides the plan's structure (§V453): an object
 * whose Translate is driven would leave the values-only frame path on the first frame it
 * left the identity, and stop drawing. The row says it is ignored; the draw is the
 * identity's.
 */
const transformInactive = (values: Readonly<Record<string, unknown>>): string | null =>
  values["mode"] === undefined || values["mode"] === "surface" || meshInstances(values)
    ? null
    : "Ignored here: the Transform moves a Surface or mesh instances. Primitive instances, points and beams do not take it yet and draw as if it were not set.";

/**
 * The Geometry's DECLARED parameters, hoisted (T1581b) so `parametersFor` can derive the
 * schema one placed node carries without reading the node back off itself (§T903's funnel;
 * `switch.ts` has the same shape).
 */
const GEOMETRY_PARAMETERS: ParameterSchema = {
  material: {
    type: "string",
    label: "Material",
    default: "",
    description: "Name of a material node. Empty = the default lambert material.",
  },
  shadowOnly: {
    type: "boolean",
    label: "Shadow Only",
    default: false,
    compileTime: true,
    description:
      "T1414b: this object casts shadows (and blocks projectors) but the camera never sees it — no colour, depth, normal, albedo or shadow matte, no ambient occlusion. A stand-in that throws the shadow of something not in the shot, or the performer's shadow on a wall he is composited in front of. Surface and Instances bodies of a lit, opaque material only: nothing else casts.",
  },
  materialOverrides: {
    type: "string",
    label: "Material Overrides",
    default: "",
    description:
      "T1415b: this object's own values for the material it wears, the material itself untouched: one `name = value` per line (or `;`), e.g. `roughness = 0.2` or a Material · WGSL field `heatColor = 1 0.5 0.2`. roughness, metallic and any field of the material's struct Params; an unknown name refuses by name.",
  },
  /*
   * T1588b — THE OBJECT TRANSFORM (docs/mesh-instancing-design-2026-10-05.md, D5/D6):
   *
   *     Object = T(translate) · T(pivot) · R(rotate) · S(scale) · T(−pivot)
   *
   * composed on the CPU (`objectMatrix`) and carried in the payload, so every pass of
   * every Render draws by the same matrix. All four are VALUES: a moving object is a
   * uniform write, never a rebuild (§V5).
   */
  translate: {
    type: "vector",
    size: 3,
    label: "Translate",
    group: "Transform",
    default: [0, 0, 0],
    inactiveWhen: transformInactive,
    description:
      "Moves the whole object, in scene units, after its scale and its turn. Drive it to fly a hull through the shot: the vertices are not rewritten, the draw takes a matrix. The four Transform rows move a Surface and mesh instances; primitive instances, points and beams IGNORE them (the rows show as inactive) and draw as if they were not set.",
  },
  rotate: {
    type: "vector",
    size: 3,
    label: "Rotate",
    group: "Transform",
    default: [0, 0, 0],
    inactiveWhen: transformInactive,
    description:
      "Turns the object about its Pivot, in DEGREES, applied X then Y then Z. Each is a right-handed turn about its axis: a positive Z carries +X toward +Y. Its normals turn with it, so it is lit for the way it faces.",
  },
  objectScale: {
    type: "vector",
    size: 3,
    label: "Scale",
    group: "Transform",
    default: [1, 1, 1],
    inactiveWhen: transformInactive,
    description: "Grows or shrinks the object about its Pivot, per axis, before the turn. This is the object's own scale; Size below is the size of one instance, billboard or beam.",
  },
  pivot: {
    type: "vector",
    size: 3,
    label: "Pivot",
    group: "Transform",
    default: [0, 0, 0],
    inactiveWhen: transformInactive,
    description: "The point of the object, in its own coordinates, that Rotate and Scale leave where it is. With no turn and a scale of 1 it changes nothing.",
  },
  mode: {
    type: "enum",
    label: "Mode",
    default: "surface",
    compileTime: true,
    options: [
      { value: "surface", label: "Surface" },
      { value: "instances", label: "Instances" },
      /* T647: camera-facing billboards — cheap reading markers with per-point colour,
         lit through the same camera and depth buffer, honoring the same group
         predicate. They cast no shadow (a screen-aligned card has no light-facing
         geometry). */
      { value: "points", label: "Points" },
      /* T680: one quad per point, spanning `position` → the Endpoint attribute. The
         third member of the billboard family and the one that carries a BEARING:
         beams, streaks, trails — anything whose reading is a SEGMENT rather than a
         dot. Casts no shadow, for §V610's reason. */
      { value: "beam", label: "Beam" },
    ],
  },
  endpoint: {
    type: "string",
    label: "Endpoint",
    default: "",
    compileTime: true,
    inactiveWhen: (values) => (values["mode"] === "beam" ? null : "Only a beam has a far end."),
    description:
      "Beam mode: the name of a vec3f attribute holding the FAR end of each segment. The near end is `position`. A ray's `hitPosition`, a previous frame's position, `position + velocity` — whatever the data already knows.",
  },
  spherical: {
    type: "boolean",
    label: "Spherical",
    default: false,
    compileTime: true,
    description:
      "T940b: points mode — each billboard reads as a tiny lit sphere: round soft splat plus a shaded side, lit from the azimuth the tint attribute's ALPHA carries (radians; a kernel writes the direction light arrives from). Squares become motes.",
    inactiveWhen: (values) => (values["mode"] === "points" ? null : "Only points draw spherical splats."),
  },
  taper: {
    type: "number",
    label: "Taper",
    default: 1,
    min: 0,
    max: 1,
    range: "bounded",
    inactiveWhen: (values) => (values["mode"] === "beam" ? null : "Only a beam has two ends to size differently."),
    description:
      "Beam mode: the share of the width the beam keeps at its ORIGIN. 1 is a parallel-sided ribbon; 0 pinches the near end to a point, which is what a divergent beam does — and what keeps many beams sharing one origin from fusing into a solid wedge there.",
  },
  /**
   * T917 — the SOFT PROFILE (§T845's gap, third sighting: E41 rounds quads with bloom,
   * E45's stay hard, E44's boxes read as a wall). §T845's AA-disc formula on the
   * primitive's own across axis: 0 is today's hard edge, bit-identical; above it the
   * edge falls off over that share of the half-width. The colour carries the coverage
   * (premultiplied), so an additive draw sums light without fringing.
   */
  soft: {
    type: "number",
    label: "Soft",
    default: 0,
    min: 0,
    max: 1,
    range: "bounded",
    inactiveWhen: (values) =>
      values["mode"] === "beam" || values["mode"] === "points"
        ? null
        : "The soft profile falls off across a beam's width or a point's billboard.",
    description:
      "Edge falloff, as a share of the half-width. 0 is a hard edge (unchanged); 1 falls off from the centreline. Pairs with Blend: Additive for beams that read as light.",
  },
  /**
   * T917 — additive light. The plan and backend have carried per-draw blend since T295
   * (\`pass.blend\`); this is the missing knob. Additive draws also stop WRITING depth
   * (they still test it): light does not occlude light, and 61 fan beams at one depth
   * must sum rather than fight the z-buffer.
   */
  blend: {
    type: "enum",
    label: "Blend",
    default: "opaque",
    compileTime: true,
    options: [
      { value: "opaque", label: "Opaque" },
      { value: "additive", label: "Additive" },
    ],
    description:
      "Additive adds this geometry's colour onto what is already drawn — light on light — and stops writing depth so overlapping light sums instead of occluding. In every mode it is light, not a body: it still hides behind what is in front of it, and it leaves the Render's Depth output, its shadows and its ambient occlusion to what it glows over (In Depth Output brings back the first). A Surface drawn additively (T1411b) also comes after every opaque and glass geometry and writes no Normal or Albedo; points, beams and primitive instances draw in Scenes order, so list them after what they glow over.",
  },
  inDepthOutput: {
    type: "boolean",
    label: "In Depth Output",
    default: false,
    compileTime: true,
    description:
      "B256, additive geometry only. Off: the Render's Depth output holds what this light glows over, which is what haze, focus and screen-space occlusion want of dust, sparks and glows. On: its own depth is written there, though it still hides nothing and casts nothing — for a light-only Render whose depth a later pass composites by (a beam placed in front of or behind a raymarched room).",
    inactiveWhen: (values) => (values["blend"] === "additive" ? null : "An opaque geometry is always in the Depth output."),
  },
  shape: {
    type: "enum",
    label: "Shape",
    default: "box",
    compileTime: true,
    options: [
      { value: "quad", label: "Quad" },
      { value: "box", label: "Box" },
      { value: "octahedron", label: "Octahedron" },
      /* T1581b: any mesh — the pointset on the Shape Mesh input, drawn once per point. */
      { value: "mesh", label: "Mesh" },
    ],
    inactiveWhen: (values) => (values["mode"] === "instances" ? null : "Only instances wear a primitive."),
    description:
      "What Instances mode draws at every point. Quad, Box and Octahedron are built in. Mesh draws the pointset wired to Shape Mesh — a Mesh File In with Frame: Object, or anything downstream that keeps its triangles — with the mesh's own normals, uv, colour and surface values, lit, shadowed and written to the Normal and Albedo outputs as a Surface is, and under a Material · WGSL too.",
  },
  /*
   * T1581b — WHERE EACH INSTANCE STANDS (docs/mesh-instancing-design-2026-10-05.md, D5/D7):
   *
   *     Instance = T(place + Instance Translate) · R(orient) · S(Size · size)
   *
   * `place` is the points' own `position` unless this is in Map mode, when it is whichever
   * vec3f attribute the map names. The value ADDS to it either way — the rule every target
   * with both a value and an attribute follows: they compose, and the default is neutral.
   */
  instanceTranslate: {
    type: "vector",
    size: 3,
    label: "Instance Translate",
    default: [0, 0, 0],
    inactiveWhen: (values) => (meshInstances(values) ? null : "Only mesh instances take a mapped place; a primitive stands at its point's position."),
    description:
      "Mesh instances: an offset added to every instance's place, in the object's own frame. In Map mode a vec3f attribute IS each instance's place instead of `position` — a second set of positions a kernel wrote — and this value still adds to it.",
  },
  scale: {
    type: "number",
    /* T1588b: labelled Size since the object's own per-axis Scale arrived (the key is
       unchanged, so every stored document reads as it did). */
    label: "Size",
    default: 0.05,
    min: 0,
    range: "floor",
    inactiveWhen: (values) =>
      values["mode"] === "instances" || values["mode"] === "points" || values["mode"] === "beam"
        ? null
        : "Size sizes instances and point billboards; a surface spans its grid.",
    description:
      "Instances: the primitive's size; a MESH instance's scale, which defaults to 1 — the mesh's own size. Points: the billboard's. Beam: its HALF-WIDTH — a beam takes its length from the data, so this is the only dimension left to set. In Map mode an f32 attribute (or one channel of a float vector) MULTIPLIES this per point, so the number here stays the object's size and the attribute is a factor — size by depth for a circle of confusion, by age, by confidence.",
  },
  /*
   * T723 — ORIENTATION, as a unit QUATERNION, and the map is the whole of it.
   *
   * Why a quaternion and not Euler angles or a forward direction: `ATTRIBUTE_STRIDES`
   * makes `vec3f` and `vec4f` both SIXTEEN BYTES — WGSL aligns a vec3 to 16 — so all
   * three candidates cost one attribute of §V588's four and exactly the same memory.
   * There is no cheap option, which leaves only what each CANNOT do. Euler angles
   * cannot compose (adding angles is not composing rotations), cannot interpolate and
   * gimbal; a forward direction cannot express ROLL and pops through a half turn when
   * it crosses the implied up. A quaternion does all of it, and the asymmetry decides
   * it: a direction is recoverable from a quaternion, roll is not recoverable from a
   * direction. T287 already declared the `quaternion` qualifier on vec4f with exactly
   * this semantic and it has had no consumer until now.
   *
   * The value here is the IDENTITY and the compiler refuses any other — see the
   * refusal below. A per-object turn is a separate feature; when it arrives it
   * composes by quaternion multiply, which is what the qualifier already says.
   */
  orient: {
    type: "vector",
    size: 4,
    label: "Orient",
    default: [0, 0, 0, 1],
    inactiveWhen: (values) =>
      values["mode"] === "instances"
        ? null
        : "Only instances have a frame to turn: a billboard faces the camera, a beam takes its axis from its endpoints, and a surface has no per-point anything.",
    description:
      "Instances only, and MAP MODE only: a vec4f attribute holding a unit quaternion (x, y, z, w) turns each primitive — and its normals with it, so a turned box is lit for the way up it actually has. Write one in a kernel to point a tile down its own velocity or along a flow. Right-handed and active: (0, 0, sin45, cos45) is a +90° turn about +Z and carries +X to +Y.",
  },
  tint: {
    type: "color",
    label: "Tint",
    default: [1, 1, 1, 1],
    space: "display",
    description:
      "Multiplier on the material's base colour: per object as a value, PER POINT in Map mode (a vec4f attribute — T478). White = inherit, either way.",
  },
  /*
   * T1581b (D9) — CUSTOM INSTANCE ATTRIBUTES. The material says what it reads per instance
   * (`struct Instance`); the points say what they carry; the two meet BY NAME. This text is
   * only for the cases a name does not settle — another attribute, or one channel of one.
   * Structural: which attributes a draw reads is its bindings.
   */
  instanceAttributes: {
    type: "string",
    label: "Instance Attributes",
    default: "",
    compileTime: true,
    inactiveWhen: (values) => (meshInstances(values) ? null : "Only mesh instances hand the material per-instance values; on any other geometry its Instance fields read their defaults."),
    description:
      "Mesh instances under a Material · WGSL that declares `struct Instance`: each field already takes the points' attribute of the SAME NAME and type, so most scenes leave this empty. One `field = attribute` per line (or `;`) binds another attribute, and `field = attribute.x` takes one channel of a float vector into an f32 field. A field nothing binds reads its `// @default`. A field the material does not declare, an attribute the points do not carry, a type that does not match, and a field with neither attribute nor default each refuse by name.",
  },
  /*
   * The description's last sentence is a COST, said where the choice is made (F1): a mesh
   * instance geometry with a Group compacts, and its draws are indirect — about 0.05 ms of
   * GPU a pass on the machine it was measured on (docs/geometry-cost-profile-2026-10-05.md).
   * The first consumer's documents carried a Group that rejected nothing on thirteen
   * geometries, fifteen passes each.
   */
  group: {
    type: "string",
    label: "Group",
    default: "",
    compileTime: true,
    description:
      "T642/T333: draw only matching points — a WGSL predicate over p.<attribute>, e.g. p.hit > 0.5. Instances, Points and Beam modes; referenced attributes bind on demand from the edge. Empty = all. On mesh instances it is decided once per instance (not per vertex), and two Geometries over one pointset with complementary predicates draw two shapes. A rejected mesh instance is in no draw and costs nothing: a big mesh may keep one point of many. The Group itself is not free there: the instance count is then read on the GPU, an indirect draw in every pass, so leave it empty on a geometry that draws every point.",
  },
};

/** T1581b: the schema a mesh-instancing Geometry carries — the declared one, its Size defaulting to 1. */
const GEOMETRY_MESH_INSTANCE_PARAMETERS: ParameterSchema = {
  ...GEOMETRY_PARAMETERS,
  scale: { ...GEOMETRY_PARAMETERS["scale"], default: 1 } as ParameterSchema[string],
};

/**
 * T428/T449 — the assignment stage, TD's Geometry COMP: a pointset becomes a NAMEABLE
 * renderable object here, wearing a material (referenced by name) with per-object
 * overrides. The points flow in on a real wire (GPU data); the material arrives by
 * name (scene assembly) — V372's line, drawn through the middle of this node.
 */
export const geometryNode: NodeDefinition = {
  type: "geometry",
  version: 1,
  title: "Geometry",
  category: "render",
  /*
   * T1214 — THE MODES ARE IN THE DESCRIPTION BECAUSE THE DESCRIPTION IS WHERE AN AGENT
   * LOOKS. `list_node_definitions` ships `description` and `parameterKeys`; it does NOT
   * ship a parameter's own description, nor a port's, so everything the four modes
   * explain about themselves further down this file is invisible at the moment a caller
   * is choosing a node. An agent was measured building SEVEN near-identical
   * `geometry` → `render` chains for what is seven instances of one fin: the capability
   * and its worked example (E10) both shipped, and nothing in the catalogue gave it a
   * reason to consider either. One clause per mode, not a paragraph — this text is paid
   * for on every call, for all 107 nodes.
   */
  description:
    "Binds a point set and a material into one renderable object a Render lists by name. Mode decides what the points become: Surface skins them into a mesh over their grid topology; INSTANCES draws one primitive at every point — N copies of one shape from ONE node, never N nodes — a quad, box or octahedron, or with Shape: Mesh ANY MESH wired to Shape Mesh (a Mesh File In with Frame: Object), lit, shadowed and Material · WGSL-shaded as a Surface is; Size, Orient, Tint and Instance Translate take per-point values in Map mode; Points draws a camera-facing billboard per point; Beam draws a quad spanning position to the Endpoint attribute, for streaks and rays. Tint multiplies the material's base colour per object (1,1,1,1 = inherit, visibly). Translate, Rotate, Scale and Pivot move a Surface or mesh instances as ONE OBJECT: a matrix on every draw (colour, G-buffer, shadows), not a kernel; primitives, points and beams ignore them. Blend: Opaque is a body; Additive is light: no depth, no shadow.",
  // T1214: the tags named one of the four modes. A library search for "instances" or
  // "beam" found Render Instances and nothing else — this node does both.
  tags: ["3d", "scene", "geometry", "material", "surface", "instances", "points", "beam"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description:
        "Surface mode needs analytic grid topology on the edge. A vec2f attribute named uv on the points is the texture coordinate its material reads, in place of the grid's columns and rows.",
    },
    {
      // T1581b: the instance SHAPE. AFTER `points`, which stays the first pointset input:
      // every Map on this node resolves against it (§V306).
      id: "mesh",
      label: "Shape Mesh",
      optional: true,
      /* Only `position` is required of the EDGE, as on `points`: a kernel between the file
         and this port declares no more than that, and the compile checks the triangles and
         the normal itself, with a sentence each. */
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description:
        "Instances mode, Shape: Mesh — the mesh drawn at every point of Points: a Mesh File In (set its Frame to Object, so the shape is in its own frame rather than where the file placed it), or anything downstream that keeps its triangles. Read in no other mode.",
    },
    {
      // T1689b: the shape's stand-in for every shadow sweep. After `mesh`, optional.
      id: "shadowMesh",
      label: "Shadow Mesh",
      optional: true,
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description:
        "T1689b: Instances mode, Shape: Mesh — a lighter mesh that CASTS in the shape's place. Every pass that asks what stands between a light and a surface draws it instead of the Shape Mesh (a casting light's shadow passes, a point light's six times; the Light Depth output; a projector's occlusion), at the same instances with the same transforms. What the camera sees is the Shape Mesh, untouched. Author it in the shape's own frame (the same origin, axes and size: the same Frame on its Mesh File In) and keep it INSIDE the shape: where it pokes out, the shape falls into its own shadow by more than the light's Shadow Bias; where it falls short, the shadow's edge is that much smaller and a sliver of the shape's far side stays lit. Not wired: the shape casts itself. Read in no other mode, as Shape Mesh is: a Geometry that draws no Shape Mesh casts what it draws.",
    },
    {
      // T447: reference-fed — the `material` PARAMETER names the node; the compiler
      // synthesizes this edge; connect is refused with the parameter named.
      id: "material",
      label: "Material",
      optional: true,
      type: { kind: "material", model: "custom" },
    },
  ],
  outputs: [{ id: "out", label: "Out", type: { kind: "scene" } }],
  sourceReferences: [{ parameter: "material", input: "material" }],
  parameters: GEOMETRY_PARAMETERS,
  /**
   * T1581b (O3): a MESH instance's Size defaults to 1, the mesh's own size. The declared
   * 0.05 is a primitive's half-extent, and on a mesh it would be a twentieth of the file —
   * a trap. The schema is per instance (§T880), so every reader gets the right default
   * through the one funnel.
   */
  parametersFor(stored) {
    return storedStaticValue(stored["mode"] as never) === "instances" && storedStaticValue(stored["shape"] as never) === "mesh"
      ? GEOMETRY_MESH_INSTANCE_PARAMETERS
      : GEOMETRY_PARAMETERS;
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const points = inputs["points"];
    if (points === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const pointset = points.pointset;
    if (pointset === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.scene.geometry",
            message: `Node "${nodeId}": the points input carries no edge payload.`,
            nodeId,
          },
        ],
      };
    }
    const materialBinding = (inputs["material"] as { scene?: ScenePayload } | undefined)?.scene;
    if (materialBinding !== undefined && materialBinding.kind !== "material") {
      const named = typeof parameters["material"] === "string" ? (parameters["material"] as string) : "";
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.scene.reference",
            message: `Node "${nodeId}": material "${named}" resolves to a ${materialBinding.kind} — a geometry's material must name a material node.`,
            nodeId,
          },
        ],
      };
    }
    // §V288: a map this stage cannot honour refuses BY NAME rather than drawing the
    // retained static. `tint` (T478), `scale` (T721) and `orient` (T723) are the
    // mappable ones — and this list is the reason a new map cannot be half-added: a
    // parameter that grows a map binding without appearing here refuses itself.
    const MAPPABLE = new Set(["tint", "scale", "orient", "instanceTranslate"]);
    const unhonoured = Object.keys(parameterMaps).filter((key) => !MAPPABLE.has(key)).sort();
    if (unhonoured.length > 0) {
      return {
        passes: [],
        diagnostics: unhonoured.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} is in map mode, but geometry maps only "tint", "scale", "orient" and "instanceTranslate".`,
          nodeId,
          suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
        })),
      };
    }
    /* T1581b, §V306: this node has two pointset inputs now, and a Map reads ONE of them —
       the points, where the per-instance values are. A map that names the shape is refused
       with the reason, not resolved against the wrong pointset. */
    const onShape = Object.entries(parameterMaps).filter(([, binding]) => binding.port === "mesh").map(([key]) => key).sort();
    if (onShape.length > 0) {
      return {
        passes: [],
        diagnostics: onShape.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} maps port "mesh", but a Map reads a per-instance value and those are on the Points input; Shape Mesh is the shape every instance draws.`,
          nodeId,
          suggestion: "Map an attribute of the Points input (drop the port), or write the value into the points with a kernel.",
        })),
      };
    }
    // T478: tint in MAP mode — a vec4f attribute drives the multiplier per point.
    const resolvedTint = resolveColorMap(nodeId, parameterMaps["tint"], pointset, "points", "tint");
    if ("refusal" in resolvedTint) return resolvedTint.refusal;
    const tintMap = resolvedTint.map;

    // T1415b: this object's own values for the material it wears (material-overrides.ts).
    const overridden = applyMaterialOverrides(
      nodeId,
      typeof parameters["materialOverrides"] === "string" ? (parameters["materialOverrides"] as string) : "",
      materialBinding ?? DEFAULT_MATERIAL,
    );
    if ("diagnostics" in overridden) return { passes: [], diagnostics: overridden.diagnostics };
    const base: MaterialPayload = overridden.material;
    const tint = readColor(parameters, "tint", [1, 1, 1, 1]);
    const material: MaterialPayload =
      tintMap !== undefined
        ? base // per-point tint multiplies in the shader; the static value is retained, not applied
        : {
            ...base,
            baseColor: [
              (base.baseColor[0] ?? 1) * (tint[0] ?? 1),
              (base.baseColor[1] ?? 1) * (tint[1] ?? 1),
              (base.baseColor[2] ?? 1) * (tint[2] ?? 1),
              (base.baseColor[3] ?? 1) * (tint[3] ?? 1),
            ],
          };
    const mode =
      parameters["mode"] === "instances"
        ? "instances"
        : parameters["mode"] === "points"
          ? "points"
          : parameters["mode"] === "beam"
            ? "beam"
            : "surface";
    /* The three PER-POINT modes, as one word: everything below that is true of an
       instance is true of a billboard and of a beam — a scale, a group predicate, no
       uv, no grid. Only `surface` is the odd one. */
    const perPoint = mode === "instances" || mode === "points" || mode === "beam";
    /* T1581b: Instances mode drawing the Shape Mesh input at every point. */
    const meshShape = mode === "instances" && parameters["shape"] === "mesh";
    /* Instance Translate is the mesh instance's target. MAPPED on anything else it could
       only be dropped, so the map refuses by name (§V288) — the node's rule for a map this
       mode cannot honour, as Size's on a surface. Its constant VALUE there is inactive and
       says so (§V146): a value is never what decides the plan's structure (§V453). */
    const instanceTranslate = vec3(parameters, "instanceTranslate", [0, 0, 0]);
    if (!meshShape && parameterMaps["instanceTranslate"] !== undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.parameter.map",
            message: `Node "${nodeId}": instanceTranslate is in map mode, but it places mesh instances (Mode: Instances, Shape: Mesh); this geometry is ${mode === "instances" ? `${String(parameters["shape"] ?? "box")} instances` : `a ${mode}`} and would ignore it.`,
            nodeId,
            suggestion: "Set Shape to Mesh and wire a mesh to Shape Mesh, or set Instance Translate back to Constant.",
          },
        ],
      };
    }
    /* T1414b: Shadow Only keeps exactly the casting half of a body — so a body that casts
       nothing (a billboard, a beam, light laid on additively, glass, an unlit marker) would
       draw nothing at all. Refused by name rather than silently invisible (§V288). */
    if (parameters["shadowOnly"] === true) {
      const why =
        mode === "points" || mode === "beam"
          ? `a ${mode === "points" ? "points" : "beam"} geometry casts no shadow`
          : parameters["blend"] === "additive"
            ? "an additive geometry is light and casts no shadow"
            : material.model === "glass"
              ? "glass casts no shadow"
              : material.model === "unlit"
                ? "an unlit material exchanges no light, so it casts no shadow"
                : undefined;
      if (why !== undefined) {
        return {
          passes: [],
          diagnostics: [
            {
              severity: "error",
              code: "node.scene.shadowOnly",
              message: `Node "${nodeId}": Shadow Only keeps only an object's shadow, and ${why} — it would draw nothing.`,
              nodeId,
              suggestion: "Use a Surface or Instances geometry with a lit, opaque material, or turn Shadow Only off.",
            },
          ],
        };
      }
    }
    /*
     * T721 — SCALE in map mode: an f32 attribute (or one channel of a float vector)
     * sizes each primitive, through the same resolver `renderPoints.sizePixels` uses
     * (§V109: one answer to "what may drive a size"). It MULTIPLIES the authored Scale
     * rather than replacing it — see the payload field for why — and it refuses on a
     * SURFACE by name, because a surface has no per-point size to give: its Scale is
     * already declared inactive there, and a map that silently did nothing is §V624's
     * dead parameter wearing a wire.
     */
    if (!perPoint && parameterMaps["scale"] !== undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.parameter.map",
            message: `Node "${nodeId}": scale is in map mode, but a surface spans its grid and has no per-point size.`,
            nodeId,
            suggestion: "Switch the mode to instances, points or beam, or set Size back to Constant.",
          },
        ],
      };
    }
    const resolvedScale = resolveScalarMap(nodeId, parameterMaps["scale"], pointset, "points", "scale");
    if ("refusal" in resolvedScale) return resolvedScale.refusal;
    const scaleMap = resolvedScale.map;
    /*
     * T723 — ORIENTATION refuses on THREE modes, not one. T721's size was meaningful on
     * every per-point mode and only a surface had none; a rotation is narrower than
     * that, because two of the three per-point modes have already spent their frame:
     * a billboard faces the camera BY CONSTRUCTION (§V610 — that is why it casts no
     * shadow), and a beam's long axis is its endpoints and its width axis is the
     * camera's. Neither has a free frame left to turn, so binding a buffer for them
     * would be §V624's dead parameter wearing a wire. Instances only, and each refusal
     * says which of those two reasons applies (§V606).
     */
    if (mode !== "instances" && parameterMaps["orient"] !== undefined) {
      const because =
        mode === "surface"
          ? "a surface spans its grid and has no per-point frame to turn"
          : mode === "points"
          ? "a points billboard faces the camera by construction, so a per-point rotation would have nowhere to go"
          : "a beam takes its long axis from its endpoints and its width axis from the camera, so it has no free frame to turn";
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.parameter.map",
            message: `Node "${nodeId}": orient is in map mode, but ${because}.`,
            nodeId,
            suggestion: "Switch the mode to instances, or set Orient back to Constant.",
          },
        ],
      };
    }
    /*
     * And an AUTHORED orientation refuses rather than being dropped. This draw carries
     * no uniform for a per-object rotation, so a non-identity value here could only be
     * ignored — which is §B132's fault exactly: a number that looks authored, renders
     * as nothing, and takes weeks to notice. Refusing by name costs the author one
     * message and cannot be mistaken for working (§V624, Rule 8).
     */
    const orientValue = parameters["orient"];
    if (
      parameterMaps["orient"] === undefined &&
      Array.isArray(orientValue) &&
      orientValue.length === 4 &&
      !(orientValue[0] === 0 && orientValue[1] === 0 && orientValue[2] === 0 && orientValue[3] === 1)
    ) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.parameter.map",
            message: `Node "${nodeId}": Orient carries a rotation but is not in Map mode, and a geometry has no per-object orientation to apply it to.`,
            nodeId,
            suggestion:
              "Drive Orient from a vec4f quaternion attribute in Map mode, or set it back to the identity (0, 0, 0, 1).",
          },
        ],
      };
    }
    /*
     * The map itself resolves through `resolveColorMap` — which is not a colour
     * function, it is the COMPOUND-HEAD function: "one vec4f attribute drives this whole
     * four-component value, and a channel belongs on a component slot, not the head".
     * That is exactly a quaternion's contract, and §V109 is explicit that a second copy
     * of it is a second chance to refuse the same document in different words.
     */
    const resolvedOrient = resolveColorMap(nodeId, parameterMaps["orient"], pointset, "points", "orient");
    if ("refusal" in resolvedOrient) return resolvedOrient.refusal;
    const orientMap = resolvedOrient.map;
    /*
     * T642: the group predicate, resolved by the SAME function renderPoints uses
     * (§V349 by construction). Instances only, and the refusal says WHY (§V606: a
     * refusal must carry its reason, or the next reader inherits a decision nobody
     * made): a surface draw's triangles are connectivity over ALL the grid's points,
     * so removing some would punch holes in the mesh — hole-punching is a different
     * feature, not a smaller version of this one.
     */
    const groupSource = typeof parameters["group"] === "string" ? (parameters["group"] as string).trim() : "";
    if (groupSource !== "" && mode === "surface") {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.scene.group",
            message: `Node "${nodeId}": a group predicate needs a per-point mode — a surface draw's triangles span every grid point, so filtering points would punch holes in the mesh rather than select from a cloud.`,
            nodeId,
            suggestion: "Switch Mode to Instances, Points or Beam, or route the cloud through renderPoints.",
          },
        ],
      };
    }
    const resolvedGroup = groupSource === "" ? undefined : resolveGroupPredicate(nodeId, groupSource, pointset);
    if (resolvedGroup !== undefined && "refusal" in resolvedGroup) return resolvedGroup.refusal;
    if (pointset.count !== undefined && mode !== "instances") {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.scene.geometry",
            message: `Node "${nodeId}": the point set carries a GPU live count, and a ${mode} draw addresses a fixed capacity — dead points would be resurrected. Counted sets render as instances (T478), which draw indirectly off the live count.`,
            nodeId,
          },
        ],
      };
    }
    /*
     * T680 — BEAM mode's far end. Refused BY NAME when the attribute is missing or is
     * not vec3f (§V288): a beam whose endpoint quietly defaulted would draw every
     * segment at zero length, which renders as an empty frame and teaches that the mode
     * does not work. The near end is always `position`, which the input port already
     * requires, so only this one needs asking for.
     */
    const endpointName = typeof parameters["endpoint"] === "string" ? (parameters["endpoint"] as string).trim() : "";
    let endpointPair: ScenePairRef | undefined;
    if (mode === "beam") {
      const carried = endpointName === "" ? undefined : pointset.pairs[endpointName];
      if (endpointName === "" || carried === undefined || carried.type !== "vec3f") {
        const why =
          endpointName === ""
            ? "beam mode needs an Endpoint attribute naming the far end of each segment"
            : carried === undefined
              ? `the incoming point set carries no attribute "${endpointName}"`
              : `the incoming \`${endpointName}\` attribute is ${carried.type ?? "untyped"}, and a beam's far end must be vec3f`;
        return {
          passes: [],
          diagnostics: [
            {
              severity: "error",
              code: "node.scene.endpoint",
              message: `Node "${nodeId}": ${why}.`,
              nodeId,
              suggestion: "Name a vec3f attribute the producer writes — a Ray node's `hitPosition`, or a kernel's own second position.",
            },
          ],
        };
      }
      endpointPair = { ...carried, type: "vec3f" };
    }
    /* T1588b: the object matrix, composed HERE and nowhere downstream. */
    const transform = objectMatrix({
      translate: vec3(parameters, "translate", [0, 0, 0]),
      rotate: vec3(parameters, "rotate", [0, 0, 0]),
      scale: vec3(parameters, "objectScale", [1, 1, 1]),
      pivot: vec3(parameters, "pivot", [0, 0, 0]),
    });
    /* Primitive instances, points and beams draw through generators that take no matrix
       until T1588b's slice G: only a surface draw and the mesh-instance resolve read
       `transform`. The rows are inactive there and say so (§V146). Never a refusal: see
       `transformInactive`. */
    /*
     * T1581b — MESH INSTANCES. The shape arrives on the Shape Mesh input; each instance's
     * transform is RESOLVED ONCE A FRAME, here, by one compute pass this node owns, into a
     * record every draw of every Render reads (instance-resolve.wgsl.ts says why). The
     * mapped attributes, the Group predicate and the object matrix all end in that record,
     * so nothing downstream evaluates any of them again.
     */
    let instanceMesh: GeometryPayload["instanceMesh"];
    let resolve: { pass: DispatchPassDescriptor; scratch: ScratchRequest[] } | undefined;
    /* T1689b: what the node says about its Shadow Mesh while it still draws. */
    const shadowNotes: Array<NonNullable<CompiledNodeDescription["diagnostics"]>[number]> = [];
    if (meshShape) {
      const refuseShape = (message: string, suggestion: string): CompiledNodeDescription => ({
        passes: [],
        diagnostics: [{ severity: "error", code: "node.scene.shape", message: `Node "${nodeId}": ${message}`, nodeId, suggestion }],
      });
      const shape = inputs["mesh"]?.pointset;
      if (shape === undefined) {
        return refuseShape(
          "Shape: Mesh draws the mesh on the Shape Mesh input at every point, and no mesh arrives on it.",
          "Wire a Mesh File In (Frame: Object) to Shape Mesh, or pick Quad, Box or Octahedron.",
        );
      }
      const shapeTopology = typeof shape.topology === "string" ? parseTopology(shape.topology) : null;
      if (shapeTopology === null || shapeTopology.kind !== "mesh") {
        return refuseShape(
          `the Shape Mesh input carries ${shapeTopology === null ? "an unreadable topology" : shapeTopology.kind === "grid" ? "a grid" : "points with no triangles"}, and an instance shape needs a mesh's triangles.`,
          "Wire a Mesh File In, or something downstream of one that keeps its mesh topology.",
        );
      }
      const shapeNormal = shape.pairs["normal"];
      if (shape.pairs["position"]?.type !== "vec3f" || shapeNormal === undefined || shapeNormal.type !== "vec3f") {
        return refuseShape(
          "the Shape Mesh input is a mesh without a vec3f `position` and `normal`; an instance is placed and lit by them.",
          "Keep position and normal through any kernel between the Mesh File In and the Geometry.",
        );
      }
      /*
       * T1689b — THE SHADOW MESH: an optional second mesh the shadow sweeps draw in the
       * shape's place. It needs what a sweep reads of the shape (triangles, a position and
       * the normal the instanced depth generator declares) and nothing else. What it cannot
       * be checked for is that it IS the shape, lighter: only that it stands where the shape
       * stands, when both carry a bound.
       */
      const shadowShape = inputs["shadowMesh"]?.pointset;
      const shadowTopology = shadowShape === undefined ? null : typeof shadowShape.topology === "string" ? parseTopology(shadowShape.topology) : null;
      if (shadowShape !== undefined && (shadowTopology === null || shadowTopology.kind !== "mesh" || shadowShape.pairs["position"]?.type !== "vec3f" || shadowShape.pairs["normal"]?.type !== "vec3f")) {
        return {
          passes: [],
          diagnostics: [
            {
              severity: "error",
              code: "node.scene.shadowMesh",
              message: `Node "${nodeId}": the Shadow Mesh input ${
                shadowTopology === null || shadowTopology.kind !== "mesh" ? "carries no mesh triangles" : "is a mesh without a vec3f `position` and `normal`"
              }, and a shadow pass draws it as the Shape Mesh is drawn.`,
              nodeId,
              suggestion: "Wire a Mesh File In (the same Frame as the Shape Mesh's), or unwire Shadow Mesh: the shape then casts itself.",
            },
          ],
        };
      }
      const shadowFit = shadowShape === undefined ? undefined : shadowMeshFit(nodeId, shape.bounds, shadowShape.bounds);
      /* The compound-head resolver again (see Orient): one vec3f attribute is the whole place. */
      const resolvedPlace = resolveColorMap(nodeId, parameterMaps["instanceTranslate"], pointset, "points", "instanceTranslate", "vec3f");
      if ("refusal" in resolvedPlace) return resolvedPlace.refusal;
      const place = resolvedPlace.map ?? pointset.pairs["position"];
      if (place === undefined) return { passes: [], diagnostics: [missingCompileResource(nodeId, "the points' position attribute")] };
      /* D9: the material's `struct Instance` fields, bound to the points by name. */
      const custom = bindInstanceAttributes(
        nodeId,
        typeof parameters["instanceAttributes"] === "string" ? (parameters["instanceAttributes"] as string) : "",
        material.custom?.instance ?? [],
        pointset.pairs,
      );
      if ("diagnostics" in custom) return { passes: [], diagnostics: custom.diagnostics };
      /*
       * F1: can this geometry leave an instance out? Only then does it compact — list and
       * count what it draws, and draw indirect. A geometry that draws every point keeps a
       * literal count: an indirect draw is not free (instance-resolve.wgsl.ts has the figure),
       * and a Render draws a geometry in up to fifteen passes.
       */
      const compact = resolvedGroup !== undefined || pointset.count !== undefined;
      const records = instanceRecordStorage(nodeId, pointset.capacity, {
        tint: tintMap !== undefined,
        compact,
        fields: custom.bound.map((field) => ({ name: field.name, type: field.type })),
        ...(shadowShape === undefined ? {} : { shadowMesh: true }),
      });
      if (!records.ok) return refuseShape(records.errors.join(" "), "Lower the point capacity.");
      /* T1689b: a geometry that compacts draws by indirect arguments, and they hold a vertex
         count: the shadow mesh's draws need their own, written by the same pass. */
      const shadowArgs = records.shadowArgs;
      const sources = packedGroups();
      const unreadable = [
        ...(scaleMap === undefined || isPackedType(scaleMap.type) ? [] : [`scale (${scaleMap.type})`]),
        ...(resolvedGroup === undefined ? [] : resolvedGroup.binds.filter((bind) => !isPackedType(bind.type)).map((bind) => `p.${bind.attribute} (${bind.type})`)),
      ];
      if (unreadable.length > 0) {
        return refuseShape(`mesh instances cannot read ${unreadable.join(", ")}: not a point attribute type.`, "Use an f32, vec2f, vec3f, vec4f, u32 or vec4u attribute.");
      }
      const reads: InstanceResolveOptions = {
        translate: sources.read(place, "vec3f"),
        ...(orientMap === undefined ? {} : { orient: sources.read(orientMap, "vec4f") }),
        ...(scaleMap === undefined || !isPackedType(scaleMap.type)
          ? {}
          : { scale: { ...sources.read(scaleMap, scaleMap.type), ...(scaleMap.channel === undefined ? {} : { channel: scaleMap.channel }) } }),
        ...(tintMap === undefined ? {} : { tint: sources.read(tintMap, "vec4f") }),
        ...(resolvedGroup === undefined
          ? {}
          : {
              group: {
                expression: resolvedGroup.expression,
                binds: resolvedGroup.binds.flatMap((bind) => (isPackedType(bind.type) ? [{ attribute: bind.attribute, read: sources.read(bind, bind.type) }] : [])),
              },
            }),
        ...(custom.bound.length === 0
          ? {}
          : { fields: custom.bound.map((field) => ({ name: field.name, read: sources.read(field.source, field.sourceType), ...(field.channel === undefined ? {} : { channel: field.channel }) })) }),
        /* F1: a counted pointset's dead slots are rejected here, with the Group's. */
        ...(pointset.count === undefined ? {} : { counted: true }),
        record: records.offsets,
        groups: 0,
      };
      /* The object matrix as the three rows of its 3×4 (column-major in, rows out). */
      const objectRow = (row: number): number[] => [0, 1, 2, 3].map((column) => transform[column * 4 + row] as number);
      resolve = {
        pass: {
          kind: "dispatch",
          id: `${nodeId}:instances:resolve`,
          shader: instanceResolveWgsl({ ...reads, groups: sources.count, ...(shadowArgs === undefined ? {} : { shadowArgs: true }) }),
          entryPoint: "main",
          /* F1: compacting, ONE workgroup — its invocations share the count of what they
             accept, which is what lets one dispatch resolve, compact and count. */
          workgroups: resolveWorkgroups(compact, pointset.capacity),
          buffers: [
            { binding: RESOLVE_RECORDS_BINDING, resourceId: records.resourceId },
            ...(records.args === undefined ? [] : [{ binding: RESOLVE_ARGS_BINDING, resourceId: records.args.resourceId }]),
            ...(pointset.count === undefined ? [] : [{ binding: RESOLVE_LIVE_BINDING, resourceId: pointset.count.buffer }]),
            ...sources.bindings(RESOLVE_SOURCE_PREFIX),
            ...(shadowArgs === undefined ? [] : [{ binding: RESOLVE_SHADOW_ARGS_BINDING, resourceId: shadowArgs.resourceId }]),
          ],
          uniforms: {
            object0: objectRow(0),
            object1: objectRow(1),
            object2: objectRow(2),
            translate: [...instanceTranslate, 0],
            scale: [readNumber(parameters, "scale", 1), 0, 0, 0],
            count: pointset.capacity,
            vertexCount: shapeTopology.triangles * 3,
            ...(shadowArgs === undefined || shadowTopology === null || shadowTopology.kind !== "mesh" ? {} : { shadowVertexCount: shadowTopology.triangles * 3 }),
          },
          uniformBinding: "params",
          nodeId,
        },
        scratch: [records.scratch, ...(records.args === undefined ? [] : [records.args.scratch]), ...(shadowArgs === undefined ? [] : [shadowArgs.scratch])],
      };
      instanceMesh = {
        pairs: shape.pairs,
        triangles: shapeTopology.triangles,
        indexBuffer: shapeTopology.indexBuffer,
        ...(records.args === undefined ? {} : { drawArgs: records.args.resourceId }),
        ...(shadowShape === undefined || shadowTopology === null || shadowTopology.kind !== "mesh"
          ? {}
          : {
              shadow: {
                pairs: shadowShape.pairs,
                triangles: shadowTopology.triangles,
                indexBuffer: shadowTopology.indexBuffer,
                ...(shadowArgs === undefined ? {} : { drawArgs: shadowArgs.resourceId }),
              },
            }),
        records: { buffer: records.resourceId, ...records.offsets },
      };
      if (shadowFit !== undefined) shadowNotes.push(shadowFit);
    }
    const shapeParameter = parameters["shape"];
    const payload: GeometryPayload = {
      kind: "geometry",
      pairs: pointset.pairs,
      capacity: pointset.capacity,
      objectMatrix: transform,
      /* T1598b: a Surface draws its points through `transform` and nothing else, so the
         pointset's own sphere, turned by it, holds the draw. Every other mode places
         something at each point (a shape, a card, a ribbon) and has no bound here. */
      ...(mode === "surface" && pointset.bounds !== undefined ? { bounds: transformedSphere(pointset.bounds, transform) } : {}),
      ...(instanceMesh === undefined ? {} : { instanceMesh }),
      ...(pointset.topology === undefined ? {} : { topology: pointset.topology }),
      mode,
      /*
       * B-fix, found while building T680: this carried the scale for INSTANCES only, so
       * a points-mode billboard fell through to the draw's `?? { scale: 0.05 }` and the
       * Scale parameter — which declares itself ACTIVE for points — did nothing at all.
       * Measured on E34: 0.005 and 0.30 rendered BYTE-IDENTICAL. §V465's fault exactly,
       * and worse, because nothing overrode it; the value was simply dropped on the
       * floor. All three per-point modes carry it now. `shape` rides along unused in the
       * two billboard modes, which is what the shader already assumes.
       */
      ...(perPoint
        ? {
            instance: {
              shape: parseInstanceShape(shapeParameter),
              scale: readNumber(parameters, "scale", 0.05),
              ...(mode === "beam" ? { taper: Math.min(1, Math.max(0, readNumber(parameters, "taper", 1))) } : {}),
              /* T917: the soft profile rides the instance vec4's spare w — zero new plumbing. */
              soft: Math.min(1, Math.max(0, readNumber(parameters, "soft", 0))),
              /* T940b: points-mode spherical splats. */
              ...(mode === "points" && parameters["spherical"] === true ? { spherical: true } : {}),
            },
          }
        : {}),
      ...(parameters["blend"] === "additive" ? { blend: "additive" as const } : {}),
      ...(parameters["inDepthOutput"] === true ? { ownDepth: true as const } : {}),
      ...(parameters["shadowOnly"] === true ? { castOnly: true as const } : {}),
      ...(endpointPair === undefined ? {} : { endpoint: endpointPair }),
      /* T1581b: a mesh instance's tint, size, turn and group are already in its records
         (the resolve pass above), so none of them rides the payload for a draw to read twice. */
      ...(tintMap === undefined || meshShape ? {} : { colorAttribute: { ...tintMap, type: "vec4f" } }),
      ...(scaleMap === undefined || !perPoint || meshShape ? {} : { scaleAttribute: scaleMap }),
      /* T723: instances only — the refusal above has already turned away every other
         mode, so reaching here with a map means the frame is genuinely free to turn. */
      ...(orientMap === undefined || mode !== "instances" || meshShape
        ? {}
        : { orientAttribute: orientMap }),
      ...(resolvedGroup === undefined || meshShape ? {} : { group: resolvedGroup }),
      ...(pointset.count === undefined ? {} : { count: { buffer: pointset.count.buffer } }),
      material,
    };
    const built =
      resolve !== undefined
        ? ({ passes: [resolve.pass], scratch: resolve.scratch, scene: { out: payload } } as CompiledNodeDescription)
        : ({ passes: [], scene: { out: payload } } as CompiledNodeDescription);
    return shadowNotes.length === 0 ? built : { ...built, diagnostics: shadowNotes };
  },
};

/**
 * F1 — how many instances a mesh-instance draw runs, in every pass of every Render: the
 * count its geometry resolved this frame (the live points its Group keeps), read by the GPU
 * from the geometry's own arguments; or, for a geometry that leaves nothing out, every slot.
 */
function meshInstanceCount(payload: GeometryPayload): DrawPassDescriptor["instances"] {
  const drawArgs = payload.instanceMesh?.drawArgs;
  return drawArgs === undefined ? payload.capacity : { indirect: drawArgs };
}

/**
 * T1689b — DOES THE SHADOW MESH STAND WHERE THE SHAPE STANDS? The one thing about a shadow
 * mesh the engine can check: both meshes are drawn by the same instance records, so they
 * must share a frame, and the mistake that breaks it (another Frame on the Mesh File In,
 * another unit) moves or resizes the whole mesh. Where both carry a bounding sphere, a
 * centre more than a quarter of the shape's radius away, or a radius off by more than a
 * quarter, is said. A remark, never a refusal: a stand-in is allowed to be smaller.
 */
function shadowMeshFit(
  nodeId: string,
  shape: { readonly center: readonly [number, number, number]; readonly radius: number } | undefined,
  shadow: { readonly center: readonly [number, number, number]; readonly radius: number } | undefined,
): NonNullable<CompiledNodeDescription["diagnostics"]>[number] | undefined {
  if (shape === undefined || shadow === undefined || !(shape.radius > 0)) return undefined;
  const apart = Math.hypot(shadow.center[0] - shape.center[0], shadow.center[1] - shape.center[1], shadow.center[2] - shape.center[2]);
  const ratio = shadow.radius / shape.radius;
  if (apart <= shape.radius * SHADOW_MESH_FIT && ratio >= 1 - SHADOW_MESH_FIT && ratio <= 1 + SHADOW_MESH_FIT) return undefined;
  const places = (value: number): string => value.toPrecision(3);
  return {
    severity: "warning",
    code: "node.scene.shadowMeshFit",
    message: `Node "${nodeId}": the Shadow Mesh does not stand where the Shape Mesh stands: its bounding sphere has radius ${places(shadow.radius)} and its centre is ${places(apart)} from the shape's, whose radius is ${places(shape.radius)}. Both are drawn at the same instances, so the shadow is cast from there.`,
    nodeId,
    suggestion: "Give the Shadow Mesh's Mesh File In the Frame of the Shape Mesh's (Object, for an instance shape), and author the two in one frame at one size.",
  };
}
const SHADOW_MESH_FIT = 0.25;

/**
 * T1581b — what a MESH-INSTANCE draw binds and reads: the shape's vertex attributes and the
 * instance records, each buffer bound once and whole (`packedGroups`), plus the index list.
 * The depth sweeps need the position and the records alone; the passes that shade take
 * every attribute the shape carries. Both come from this one function, so the sweep and the
 * lit draw cannot place an instance differently.
 */
function meshInstanceStorage(
  mesh: NonNullable<GeometryPayload["instanceMesh"]>,
  shading: boolean,
): { readonly option: SceneInstancedOption; readonly buffers: BufferBindingDescriptor[] } | undefined {
  const position = mesh.pairs["position"];
  const normal = mesh.pairs["normal"];
  if (position === undefined || normal === undefined) return undefined;
  const groups = packedGroups();
  const typed = (name: string, type: "vec2f" | "vec3f" | "vec4f") => {
    const pair = shading ? mesh.pairs[name] : undefined;
    return pair !== undefined && pair.type === type ? { [name]: groups.read(pair, type) } : {};
  };
  const shape = {
    position: groups.read(position, "vec3f"),
    normal: groups.read(normal, "vec3f"),
    ...typed("uv", "vec2f"),
    ...typed("color", "vec4f"),
    ...typed("surface", "vec4f"),
    ...typed("emissive", "vec3f"),
  };
  const { buffer, fields, ...offsets } = mesh.records;
  /* The fields only where something shades: a depth sweep reads the matrix alone. */
  const bound = shading
    ? Object.fromEntries(Object.entries(fields ?? {}).flatMap(([name, field]) => (isPackedType(field.type) ? [[name, { offset: field.offset, type: field.type }] as const] : [])))
    : {};
  const record = { group: groups.whole(buffer), ...offsets, ...(Object.keys(bound).length === 0 ? {} : { fields: bound }) };
  return {
    option: { ...shape, record, groups: groups.count },
    buffers: [...groups.bindings(INSTANCED_BINDING_PREFIX), { binding: "meshIndices", resourceId: mesh.indexBuffer }],
  };
}

/**
 * T1406b — the Render's SAMPLED-TEXTURE LEDGER. The compiler already refuses a pass that
 * binds more sampled textures than the device allows (T328, `compiler/bindings.ts`), but
 * its sentence is generic: "binds 17 sampled textures", remedy "composite in stages" —
 * neither says that each projector costs TWO (cookie + occlusion map), each casting light
 * one, the environment one or two, and what to turn off. The Render knows, so when its
 * worst pass goes over the WebGPU BASELINE (16) it says so itself, by category. A warning,
 * not a refusal: the node compiles without device limits, and a device that reports more
 * than the baseline renders it fine — on one that does not, the compiler's error refuses
 * the pass and this is the sentence that explains it.
 */
const SAMPLED_TEXTURE_BASELINE = 16;
const TEXTURE_CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^projectorCookie/, "projector cookies"],
  [/^projectorDepth/, "projector occlusion maps"],
  [/^shadowMap/, "shadow maps"],
  [/^environment/, "environment maps"],
  [/^occlusionMap$/, "ambient occlusion"],
  [/^(albedoMap|roughnessMap)$/, "material maps"],
  [/^pyr\d/, "glass pyramid levels"],
];
function textureLedger(
  nodeId: string,
  passes: ReadonlyArray<DrawPassDescriptor | DispatchPassDescriptor | BufferWritePassDescriptor>,
  /** T1658b: a Material · WGSL's textures are bound under the author's own names. */
  materialTextureNames: ReadonlySet<string>,
): NonNullable<CompiledNodeDescription["diagnostics"]>[number] | undefined {
  let worst: { id: string; bindings: string[] } | undefined;
  for (const pass of passes) {
    if (pass.kind !== "draw") continue;
    const bindings = ((pass as DrawPassDescriptor).textures ?? []).map((texture) => texture.binding);
    if (bindings.length > (worst?.bindings.length ?? SAMPLED_TEXTURE_BASELINE)) worst = { id: pass.id, bindings };
  }
  if (worst === undefined) return undefined;
  const counts = new Map<string, number>();
  for (const binding of worst.bindings) {
    const category = materialTextureNames.has(binding) ? "Material · WGSL textures" : (TEXTURE_CATEGORIES.find(([pattern]) => pattern.test(binding))?.[1] ?? binding);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([category, count]) => `${count} ${category}`).join(", ");
  return {
    severity: "warning",
    code: "node.scene.textureBudget",
    message: `Node "${nodeId}": pass "${worst.id}" binds ${worst.bindings.length} sampled textures (${breakdown}), over the WebGPU baseline of ${SAMPLED_TEXTURE_BASELINE} (maxSampledTexturesPerShaderStage). A device that reports no more than the baseline refuses the pass.`,
    nodeId,
    suggestion:
      "Each projector costs two (cookie + occlusion): turn Occlusion off on projectors nothing needs to shadow, or merge projectors that sit together into one wider throw. Each casting light costs one shadow map; Env Filter: Prefiltered costs one more than Taps; a Material · WGSL costs one a texture its source names.",
  };
}

/**
 * T1535b — a Material · WGSL's source map (counted from the first character of its `code`
 * and of its `paramsDeclaration`) moved to where the surface generator put those two texts.
 * The spans keep naming the material node; the pass stays the Render's.
 */
function customSurfaceSourceMap(
  map: NonNullable<NonNullable<MaterialPayload["custom"]>["sourceMap"]>,
  placed: SceneSurfaceModule["placed"],
): WgslSourceMap {
  return [
    ...(placed.code === undefined ? [] : relocated(map.code, placed.code)),
    ...(placed.params === undefined ? [] : relocated(map.params, placed.params)),
  ];
}

/**
 * T377 — the Render: consumes {geometries, camera, lights} BY NAME, produces a texture.
 * The §V198 matrix is composed HERE, where the aspect is known.
 */
export const renderNode: NodeDefinition = {
  type: "render",
  version: 1,
  title: "Render",
  category: "render",
  description:
    "Renders named geometries through a named camera under named lights, into a depth-tested texture. scenes and lights take space-separated name lists — list order is draw and light order. Any number of lights; count changes recompile, movement animates.",
  tags: ["3d", "scene", "render", "camera", "light"],
  inputs: [
    { id: "scenes", label: "Scenes", optional: true, variadic: true, type: { kind: "scene" } },
    { id: "camera", label: "Camera", optional: true, type: { kind: "camera" } },
    { id: "lights", label: "Lights", optional: true, variadic: true, type: { kind: "light" } },
    // T704: projectors reference like lights do — any number, list order is slot order.
    { id: "projectors", label: "Projectors", optional: true, variadic: true, type: { kind: "projector" } },
    {
      // T482: a real WIRE, because pixels are data (V372). Sampled as an equirect along
      // the reflection vector by phong and pbr materials, scaled by (1 − roughness) and
      // the specular tint (T428's IBL-lite plan, an approximation stated as one).
      // Lambert and unlit materials ignore it — said here, not discovered (V349). For
      // MIRROR reflections of the scene itself, a second render through a mirrored
      // camera into a material's albedo is already expressible (the T444 pattern).
      id: "environment",
      label: "Environment",
      optional: true,
      type: RGBA_TEXTURE,
      description:
        "Equirect environment. Phong/PBR add its reflection along R, scaled by (1 − roughness) and the specular tint; lambert and unlit ignore it. u = atan2(R.x, −R.z)/2π + 0.5, v = acos(R.y)/π, read with textureLoad.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
    },
    {
      /* T722 — the camera's DEPTH, readable. emitDepthSweep already writes camera-space
         linear distance for the AO prepass; this port is the same sweep aimed at an
         output the graph can consume: depth of field, fog, edge detection on depth
         discontinuities, compositing 3D against 2D. DATA, not colour (§V56): R holds
         distance ÷ far, 0 at the eye rising to 1 at the far plane. Costs one scene
         depth pass and one full-res target, so it is OFF until Depth Output enables
         it — while off, this port allocates nothing (outputWhen). Declared
         space:"data" in T768's family move (the T722 landing deferred it while its
         consumers were still linear): §V13 now refuses this depth map into a colour
         input — a display-decoded depth field is silently bent geometry — while
         displace.disp, remap.map and mask.mask accept it exactly. */
      id: "depth",
      label: "Depth",
      type: DATA_TEXTURE,
      description:
        "Camera-space depth as data: R = linear view distance ÷ far plane (0 eye, 1 far). Enable with Depth Output — off, this port produces nothing. Feed it to a blur-by-depth chain for depth of field, a mix for fog, or an edge for silhouettes.",
    },
    {
      /* T1371b — the G-BUFFER half the screen-space passes need beside depth: the shaded
         world normal (after a WGSL material's bump) and roughness. Data, like depth. */
      id: "normal",
      label: "Normal",
      type: DATA_TEXTURE,
      description:
        "World-space shaded normal as data, encoded n·0.5+0.5 in rgb, and roughness in a (0 = no surface). Surface geometry and mesh instances; enable with Normal Output — off, this port produces nothing. Feed it, with Depth, to reflections, occlusion and edge passes.",
    },
    {
      /* T1380b — the G-buffer's colour half: with depth and normal it is everything a
         DEFERRED pass needs to light the surface again (many unshadowed lamps, GI). */
      id: "albedo",
      label: "Albedo",
      type: DATA_TEXTURE,
      description:
        "The shaded base colour as data — linear rgb after the material — and metallic in a. Surface geometry and mesh instances; enable with Albedo Output — off, this port produces nothing. With Depth and Normal, a deferred pass can light the frame from any number of lamps.",
    },
    {
      /* T1417b — the LIGHT'S OWN VIEW of its occluders, for a march that needs to know. */
      id: "lightDepth",
      label: "Light Depth",
      type: DATA_TEXTURE,
      description:
        "The first CASTING light's shadow map as data, at this Render's resolution: a point light's 3×2 cube atlas (+X, −X, +Y, −Y, +Z, −Z; r = radial distance ÷ Shadow Extent), a directional light's ortho map (r = depth through its volume). Read it with `// @use light-depth` in a Custom WGSL — lightDepthPointVisible / lightDepthDirectionalVisible — for haze and shafts shadowed by what the light sees, not what the camera sees. Enable with Light Depth Output.",
    },
    {
      /* T1414b — the SHADOW MATTE: where the casting lights are blocked, per camera pixel. */
      id: "shadow",
      label: "Shadow",
      type: DATA_TEXTURE,
      description:
        "The shadow matte as data: r, g, b = how shadowed each surface the camera sees is from the first three CASTING lights in the Lights list (1 = fully in shadow, 0 = lit, the lit pass's own shadow test and softness), a = 1 where a surface drew (0 = nothing). Surface geometry and mesh instances; enable with Shadow Output — off, this port produces nothing.",
    },
  ],
  depthOutputs: ["out", "depth", "normal", "albedo", "shadow", "lightDepth"],
  /* B226: depth, normal and albedo are drawn against `out`'s depth attachment. */
  anchorOutput: "out",
  /* T939: MSAA is structural (a different render signature), so it is declared like
     depth — and the backend's patched vgpu keeps samples across the multi-pass chain. */
  msaaWhen: { out: (parameters) => parameters["antialias"] === "msaa" },
  outputWhen: {
    depth: (parameters) => parameters["depthOutput"] === true,
    normal: (parameters) => parameters["normalOutput"] === true,
    albedo: (parameters) => parameters["albedoOutput"] === true,
    shadow: (parameters) => parameters["shadowOutput"] === true,
    lightDepth: (parameters) => parameters["lightDepthOutput"] === true,
  },
  sourceReferences: [
    { parameter: "scenes", input: "scenes", list: true },
    { parameter: "camera", input: "camera" },
    { parameter: "lights", input: "lights", list: true },
    { parameter: "projectors", input: "projectors", list: true },
  ],
  parameters: {
    scenes: { type: "string", label: "Scenes", default: "", description: "Space-separated geometry names, in draw order." },
    camera: { type: "string", label: "Camera", default: "", description: "Name of a camera node." },
    lights: { type: "string", label: "Lights", default: "", description: "Space-separated light names, in order." },
    projectors: { type: "string", label: "Projectors", default: "", description: "Space-separated projector names, in order. Each throws its cookie into the scene as an additive light." },
    ambientColor: { type: "color", label: "Ambient", default: [1, 1, 1, 1], space: "display" },
    ambientIntensity: { type: "number", label: "Ambient Intensity", default: 0.12, min: 0, max: 1, range: "bounded" },
    background: { type: "color", label: "Background", default: [0, 0, 0, 1], space: "display" },
    environmentIntensity: {
      type: "number",
      label: "Env Intensity",
      default: 1,
      min: 0,
      range: "floor",
      description:
        "Scales the wired environment — its reflection, its diffuse fill, and (T659) the background when Show Environment is on. A value: drivable, never a rebuild.",
      inactiveWhen: () => null,
    },
    environmentTaps: {
      type: "number",
      label: "Env Taps",
      default: 8,
      min: 1,
      max: 32,
      step: 1,
      range: "bounded",
      compileTime: true,
      description:
        "T1289: how many taps the reflection's roughness cone takes. Roughness BLURS the environment rather than dimming it, and this is the sample count that blur is made of — priced per covered pixel in the main pass. 8 reads as a blur at full roughness; turn it up if a small bright thing in the environment sparkles as the surface moves, down if the shot cannot afford the loads. A compile-time knob: changing it rebuilds the shader.",
      inactiveWhen: () => null,
    },
    environmentFilter: {
      type: "enum",
      label: "Env Filter",
      default: "taps",
      compileTime: true,
      options: [
        { value: "taps", label: "Taps" },
        { value: "prefiltered", label: "Prefiltered" },
      ],
      description:
        "T1427b: how rough and matte surfaces read the environment. Taps samples the sharp map per pixel (Env Taps across the roughness cone, five for the diffuse fill): cheap, but a small bright source in the map — a lamp in an HDRI — bands a rough surface and streaks a matte one as it moves. Prefiltered blurs the environment once per frame into four roughness levels and a diffuse irradiance map (a box average of the source, four cone blurs and one pack: SIX small passes) and every surface reads a smooth bilinear texel from them. A mirror reads the sharp map either way. Env Taps is unused while Prefiltered is on.",
      inactiveWhen: () => null,
    },
    /*
     * T659 — DRAW the environment behind the scene. Off by default and it must stay
     * that way: an environment is wired on several shipped scenes purely as light, and
     * defaulting this on would change every one of their skies in one commit.
     */
    showEnvironment: {
      type: "boolean",
      label: "Show Environment",
      default: false,
      compileTime: true,
      description:
        "Draws the wired environment as the BACKGROUND, sampled along a camera ray per pixel, behind everything and without touching depth. Off, the background is the Background colour — which is what a wired environment has always looked like, because until now it only ever contributed reflections and fill. Every material model sees it: a background is a picture, not a shading term. An orthographic camera sees one direction, so its sky is flat.",
    },
    /*
     * T624 — AMBIENT OCCLUSION. One switch, and every geometry this render names is
     * occluded by every other: §V437's rule that a property is not delivered site by
     * site. Screen-space, off this render's own camera-side depth, so it costs no
     * per-geometry setup and nothing downstream has to know the scene's shape.
     */
    ambientOcclusion: {
      type: "boolean",
      label: "Ambient Occlusion",
      default: false,
      compileTime: true,
      description:
        "Darkens creases, contacts and cavities by how enclosed each pixel is. ADDS THREE PASSES: a camera-side depth sweep of the whole scene, a resolve and a blur, all at output resolution — priced here rather than discovered, the way a casting light is. It attenuates the AMBIENT and ENVIRONMENT terms only: occlusion is about the light that arrives from everywhere, and a key light arrives from one direction whether or not the neighbourhood is enclosed. An unlit material ignores it.",
    },
    aoRadius: {
      type: "number",
      label: "AO Radius",
      default: 0.35,
      min: 0.001,
      max: 4,
      range: "floor",
      description:
        "How far, IN WORLD UNITS, a surface looks for what occludes it. Scale it to your scene: a radius larger than the object darkens everything uniformly, one much smaller than a crease finds nothing.",
      inactiveWhen: (values) => (values["ambientOcclusion"] === true ? null : "Ambient Occlusion is off."),
    },
    aoIntensity: {
      type: "number",
      label: "AO Intensity",
      default: 1,
      min: 0,
      max: 2,
      range: "bounded",
      description: "How dark full occlusion goes. 0 is off in value while the passes still run — turn the switch off to stop paying for them.",
      inactiveWhen: (values) => (values["ambientOcclusion"] === true ? null : "Ambient Occlusion is off."),
    },
    /* T722 — the switch pricing the depth read: one extra depth-only scene pass and a
       full-res data target, stated here rather than discovered (the T481/T624 idiom). */
    antialias: {
      type: "enum",
      label: "Antialias",
      default: "none",
      compileTime: true,
      options: [
        { value: "none", label: "None" },
        { value: "msaa", label: "MSAA 4x" },
        { value: "ssaa", label: "SSAA 2x" },
      ],
      description:
        "T939: smooths geometry edges BEFORE bloom amplifies them, on the scene pass where the aliasing is made. MSAA 4x: hardware multisampling on this target — 4 coverage samples per pixel, shading cost unchanged (the usual choice). SSAA 2x: the whole scene renders at double resolution and box-resolves — 4 SHADED samples per pixel, heavier but also antialiases shader-thin detail inside surfaces. Both cost roughly 4x this pass's fill.",
    },
    normalOutput: {
      type: "boolean",
      label: "Normal Output",
      default: false,
      compileTime: true,
      description:
        "T1371b: renders the shaded world normal and roughness into the Normal output — one extra pass per SURFACE geometry (and per mesh-instance geometry, T1581b), through the same material code as the lit draw. Primitive instances, points and beams do not write it. Off, the port allocates nothing.",
    },
    albedoOutput: {
      type: "boolean",
      label: "Albedo Output",
      default: false,
      compileTime: true,
      description:
        "T1380b: renders the shaded base colour (rgb) and metallic (a) into the Albedo output — one extra pass per SURFACE geometry (and per mesh-instance geometry, T1581b), through the same material code as the lit draw. Primitive instances, points and beams do not write it. Off, the port allocates nothing.",
    },
    shadowOutput: {
      type: "boolean",
      label: "Shadow Output",
      default: false,
      compileTime: true,
      description:
        "T1414b: renders the shadow matte into the Shadow output — per surface pixel, how shadowed it is from each of the first three casting lights — one extra pass per SURFACE geometry (and per mesh-instance geometry, T1581b), through the same material and the same shadow test as the lit draw. Off, the port allocates nothing.",
    },
    lightDepthOutput: {
      type: "boolean",
      label: "Light Depth Output",
      default: false,
      compileTime: true,
      description:
        "T1417b: renders the first casting light's shadow map into the Light Depth output at this Render's resolution — its sweeps again (one for a directional light, six for a point light), into a map a Custom WGSL can read. Needs a light with Cast Shadows in Lights.",
    },
    depthOutput: {
      type: "boolean",
      label: "Depth Output",
      default: false,
      compileTime: true,
      description:
        "Renders the camera's linear depth into the Depth output port — one extra scene depth pass, priced like a casting light. Off, the port allocates nothing.",
    },
    aoQuality: {
      type: "enum",
      label: "AO Quality",
      default: "medium",
      compileTime: true,
      options: [
        { value: "low", label: "Low (8 taps)" },
        { value: "medium", label: "Medium (16 taps)" },
        { value: "high", label: "High (24 taps)" },
      ],
      description: "Taps per pixel in the resolve. More taps is a smoother field before the blur, at a linear cost.",
      inactiveWhen: (values) => (values["ambientOcclusion"] === true ? null : "Ambient Occlusion is off."),
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context: NodeCompileContext, mode: RenderMode = "full"): CompiledNodeDescription {
    const { nodeId, outputs, parameters, resolution } = readCompileInputs(context);
    const outTarget = outputs["out"];
    if (outTarget === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
    /* T1719b S3: a values-only frame describes the same passes and keeps the base's text, so
       no generator runs and no key is walked for it (`renderValues`). Every generated shader
       below is built through this; nothing below reads a shader it built. */
    const text = <T,>(make: () => T): T => (mode === "full" ? make() : (VALUES_ONLY_TEXT as T));
    /* T939 — SSAA: with antialias on, EVERY scene pass renders into a 2x scratch (the
       glass pyramid reads it too, so transmission sees the supersampled scene), and one
       box resolve at the end writes the real output. `target` below IS the scene
       surface; only the resolve and the depth-output pass touch `outTarget`. */
    const ssaa = parameters["antialias"] === "ssaa";
    const target = ssaa ? `scratch:${nodeId}:ss` : outTarget;
    const refuse = (code: string, message: string, suggestion?: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        { severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, ...(suggestion === undefined ? {} : { suggestion }) },
      ],
    });

    const sceneOf = (portId: string): ReadonlyArray<{ scene?: ScenePayload; source?: { nodeId: string } }> =>
      ((context as { inputs?: Record<string, ReadonlyArray<{ scene?: ScenePayload; sourceNodeId?: string }>> })
        .inputs?.[portId] ?? []).map((binding) => ({
        ...(binding.scene === undefined ? {} : { scene: binding.scene }),
        ...(binding.sourceNodeId === undefined ? {} : { source: { nodeId: binding.sourceNodeId } }),
      }));

    // CAMERA. A render with no camera named is a picture nobody framed — refuse by name.
    // T528: and a name that did NOT resolve gets its own words, rather than being told
    // "no camera is named" when one plainly is. `camera-reference.ts` holds the rule the
    // three renderers share; `render` differs only in having no inline camera to offer.
    const cameraBinding = sceneOf("camera")[0];
    if (cameraBinding === undefined) {
      const dangling = danglingCameraRefusal(parameters, false);
      return dangling === null
        ? refuse("node.scene.camera", `no camera is named — set the camera parameter to a camera node's name.`)
        : refuse("node.camera.reference", dangling, DANGLING_CAMERA_SUGGESTION);
    }
    if (cameraBinding.scene?.kind !== "camera") {
      return refuse(
        "node.scene.reference",
        `camera "${String(parameters["camera"]).trim()}" resolves to "${cameraBinding.source?.nodeId ?? "?"}", which publishes no camera.`,
        "Name a camera node.",
      );
    }
    const camera = cameraBinding.scene;

    // LIGHTS, in LIST order (§V131 carries the token order through the synthetic edges).
    const lights: LightPayload["light"][] = [];
    /** T1598b: the light NODES, beside their payloads — a diagnostic about a light names it. */
    const lightSources: string[] = [];
    /**
     * T1589b: the Lights in POINTS mode. Each is many lights, rows of a table this Render
     * culls on the GPU, and so it is NOT among `lights`, whose every entry is a block
     * unrolled into each lit shader.
     */
    const pointLights: PointLightSource[] = [];
    /** T1589b: a Light's place in the list, which every row of a set carries as its source number (the lists will test it). */
    let lightNumber = -1;
    /** T1623b: that place for each of `lights`, by its index there. */
    const lightNumbers: number[] = [];
    for (const binding of sceneOf("lights")) {
      lightNumber += 1;
      if (binding.scene?.kind !== "light") {
        return refuse(
          "node.scene.reference",
          `lights names "${binding.source?.nodeId ?? "?"}", which publishes no light.`,
          "Lights must name light nodes.",
        );
      }
      if (binding.scene.points !== undefined) {
        pointLights.push({ nodeId: binding.source?.nodeId ?? "?", points: binding.scene.points, number: lightNumber });
        continue;
      }
      lights.push(binding.scene.light);
      lightSources.push(binding.source?.nodeId ?? "?");
      lightNumbers.push(lightNumber);
    }

    // T704: PROJECTORS, in LIST order — referenced exactly as lights are.
    const projectors: ProjectorPayload[] = [];
    for (const binding of sceneOf("projectors")) {
      if (binding.scene?.kind !== "projector") {
        return refuse(
          "node.scene.reference",
          `projectors names "${binding.source?.nodeId ?? "?"}", which publishes no projector.`,
          "Projectors must name projector nodes.",
        );
      }
      projectors.push(binding.scene);
    }

    // GEOMETRIES, in draw order.
    const geometries: Array<{ payload: GeometryPayload; source: string }> = [];
    for (const binding of sceneOf("scenes")) {
      if (binding.scene?.kind !== "geometry") {
        return refuse(
          "node.scene.reference",
          `scenes names "${binding.source?.nodeId ?? "?"}", which publishes no geometry.`,
          "Scenes must name geometry nodes.",
        );
      }
      geometries.push({ payload: binding.scene, source: binding.source?.nodeId ?? nodeId });
    }
    if (geometries.length === 0) {
      // §V369: an empty scene renders perfectly happily, which is exactly why it must
      // not — a render with nothing named is a configuration hole, not a black frame.
      return refuse("node.scene.empty", `no geometry is named — set the scenes parameter to geometry node names.`);
    }

    const aspect = resolution[0] / Math.max(resolution[1], 1);
    const viewProjectionMatrix = cameraPayloadMatrix(camera, aspect);

    /*
     * T481 — SHADOWS, opt-in per light and priced in the open: each casting light adds
     * one full scene pass, named per light so the performance panel attributes its GPU
     * ms. Directional only in this build: a casting point light needs six faces, which
     * is a different feature, so it refuses by name rather than shipping half.
     */
    const casting = lights
      .map((light, index) => ({ light, index }))
      .filter(({ light }) => light.shadows);
    /* T1362b: a casting POINT light renders a cube — six 90° sweeps into one 3×2 atlas —
       and its slot carries a position, a range and six face matrices where a directional
       slot carries one matrix. */
    const shadowMatrices = casting.map(({ light }) =>
      directionalShadowMatrix(light.direction, Math.max(0.1, light.shadowExtent), aspect, light.shadowCenter),
    );
    const pointSlots = casting.flatMap(({ light }, slot) => (light.type === "point" ? [slot] : []));
    const pointFaces = casting.map(({ light }) =>
      light.type === "point" ? pointShadowFaceMatrices(light.position, Math.max(0.1, light.shadowExtent)) : [],
    );
    /** The uniforms every lit draw writes for the shadow slots, directional or point. */
    const shadowUniforms = (): Array<[string, number[]]> =>
      casting.flatMap(({ light }, slot): Array<[string, number[]]> =>
        light.type === "point"
          ? [
              [`shadow${slot}Light`, [light.position[0], light.position[1], light.position[2], Math.max(0.1, light.shadowExtent)]],
              ...(pointFaces[slot] ?? []).map((matrix, face): [string, number[]] => [`shadow${slot}Face${face}`, Array.from(matrix)]),
            ]
          : [[`shadow${slot}Matrix`, Array.from(shadowMatrices[slot] ?? [])]],
      );
    /*
     * T1623b slice 4 — THE SHADOW MAPS ARE LAYERS. Two layered targets a Render, one for its
     * directional casting lights' maps (twice the output) and one for its point lights' 3 x 2
     * cube atlases (one and a half times), a layer a light, where each casting light had a
     * target of its own. A sweep draws into its light's layer (`shadowLayers` is the one
     * answer to which).
     *
     * The layers of one array share ONE depth buffer: the sweeps run one after the other and
     * each opens with a pass that clears. A Render with three casting suns holds four
     * layers' colour and one depth where it held three of each.
     *
     * A LIT DRAW STILL BINDS A TEXTURE A LIGHT: `shadowMap{s}`, a `texture_2d`, which is now a
     * VIEW OF THAT LIGHT'S ONE LAYER. So the lit text is the text it was, character for
     * character, and a casting light is still one of the sixteen sampled textures a stage
     * may bind. That is on purpose and measured: reading the same layer through one
     * `texture_2d_array` binding costs the lit draw 73 to 85 % more at four and eight casting
     * lights of the default softness on Apple's GPUs, and through a view it costs what a
     * texture costs (docs/light-cost-investigation-2026-10-06.md, section 15). How a row
     * reads a map without that cost is slice 5's first question.
     */
    const shadowSlots = shadowLayers(casting.length, pointSlots);
    const SHADOW_KEYS = { maps: "shadowMaps", cubes: "shadowCubes" } as const;
    const shadowTargetOf = (slot: number): string => `scratch:${nodeId}:${pointSlots.includes(slot) ? SHADOW_KEYS.cubes : SHADOW_KEYS.maps}`;
    const shadowLayerOf = (slot: number): number => shadowSlots.layerOf[slot] ?? 0;
    /** What a lit draw binds for its casting lights: for each, the one layer that is its map. */
    const shadowTextures = (): Array<{ binding: string; resourceId: string; sampled: "unfiltered"; layer: number }> =>
      casting.map((_, slot) => ({ binding: `shadowMap${slot}`, resourceId: shadowTargetOf(slot), sampled: "unfiltered" as const, layer: shadowLayerOf(slot) }));
    const castingIndices = casting.map(({ index }) => index);
    /*
     * T1623b slice 3 — WHICH LIGHT IS WHAT, for the two generators.
     *
     * The SURFACE generator unrolls a block for a CASTING Light and for no other: block i is
     * casting slot i. A Light in Single mode that does not cast is a ROW of this Render's
     * light table (`named`), walked by the lit draw with the lights of every pointset.
     *
     * The INSTANCES generator (primitive instances, points, beams) has no table yet (slice 7):
     * it still unrolls a block for EVERY Light in Single mode, casting or not, and reads their
     * uniforms. So a named Light that does not cast is in this Render twice, as a row and as
     * three uniform rows of each such draw, from the same payload.
     */
    const blockLights = casting.map(({ light }) => light);
    const blockShadows = casting.map((_, slot) => slot);
    /* The camera, the casting lights and their shadow slots are the same in every lit draw:
       their uniforms are built once a compile and shared, not rebuilt once a geometry. */
    const viewProjectionUniform = Array.from(viewProjectionMatrix);
    const blockLightUniforms = Object.fromEntries(
      blockLights.flatMap((light, lightIndex) => [
        [`light${lightIndex}Meta`, lightMetaUniform(light)],
        [`light${lightIndex}Color`, [...light.color, 0]],
        [`light${lightIndex}Vector`, [...(light.type === "point" ? light.position : light.direction), 0]],
      ]),
    );
    const shadowSlotUniforms = Object.fromEntries(shadowUniforms());
    const named: NamedLight[] = lights.flatMap((light, index) => (light.shadows ? [] : [{ nodeId: lightSources[index] ?? "?", light, number: lightNumbers[index] ?? index }]));
    /** The spots among them, by name: what a draw with no cone says (`lightSpotDraw`). */
    const namedSpots = named.filter((entry) => entry.light.spot !== undefined).map((entry) => entry.nodeId);
    /* T1285: the PCF radius per casting slot, in the same slot order `shadowMatrices`
       uses. Clamped to the parameter's own range here rather than in the shader, because
       an expression can drive it past the slider and a generated loop is not a place to
       discover that: 4 is 81 taps and the ceiling the knob declares. */
    const shadowSoftness = casting.map(({ light }) =>
      Math.min(4, Math.max(0, Math.round(light.shadowSoftness))),
    );
    /* T1438b: the extra receiver bias per casting slot, world units (the generators convert). */
    const shadowBias = casting.map(({ light }) => Math.max(0, light.shadowBias));

    /* T482: the environment, wired or absent — presence is structural (a shader
       variant, like maps); intensity is a value. */
    const environmentInput = (context as { inputs?: Record<string, ReadonlyArray<{ resourceId?: string }>> })
      .inputs?.["environment"]?.[0];
    const environmentResource =
      typeof environmentInput?.resourceId === "string" ? environmentInput.resourceId : undefined;
    const environmentIntensity = readNumber(parameters, "environmentIntensity", 1);
    /* T1289: the cone's sample count, clamped here AND in the generator — this is a loop
       bound in generated WGSL, so a stray value must not reach it from either direction. */
    const environmentTaps = Math.min(32, Math.max(1, Math.round(readNumber(parameters, "environmentTaps", 8))));
    /* T1427b: the prefiltered environment — structural (its passes and one more binding). */
    const environmentPrefiltered = environmentResource !== undefined && parameters["environmentFilter"] === "prefiltered";
    const envAtlasId = `scratch:${nodeId}:envAtlas`;

    const ambient = readColor(parameters, "ambientColor", [1, 1, 1, 1]);
    const ambientIntensity = readNumber(parameters, "ambientIntensity", 0.12);

    const diagnostics: NonNullable<CompiledNodeDescription["diagnostics"]> = [];
    const background = readColor(parameters, "background", [0, 0, 0, 1]);
    const passes: Array<DrawPassDescriptor | DispatchPassDescriptor | BufferWritePassDescriptor> = [];
    /* T1658b: the names a Material · WGSL's textures are bound under, for the ledger below. */
    const materialTextureNames = new Set<string>();
    /** T478: one indirect-args scratch buffer per COUNTED geometry. */
    const scratch: Array<
      | NonNullable<ReturnType<typeof countedDrawSupport>>["scratch"]
      | { key: string; scale: number; format: "r32float"; depth?: true }
      // T725: the glass pyramid levels — the node's own working format, no depth.
      | { key: string; scale: number }
      // T939: the SSAA surface — 2x, with depth (it IS the scene target while on).
      | { key: string; scale: number; depth: true }
      // T1427b: the prefiltered environment's levels and atlas — HDR, no depth.
      | { key: string; scale: number; format: "rgba16float" }
      // T1589b: the light table — the pointset Lights' records and the grid's cells.
      | LightTablePlan["scratch"][number]
      // T1623b slice 4: the shadow maps, a layer a casting light.
      | { kind: "layers"; key: string; layers: number; scale: number; format: "r32float"; depth: true }
    > = [];
    if (ssaa) scratch.push({ key: "ss", scale: 2, depth: true });
    /** T481: counted draw support emitted once (in the shadow phase when one exists),
     *  shared by the shadow and the lit draw of the same geometry. */
    const countedByIndex = new Map<number, NonNullable<ReturnType<typeof countedDrawSupport>>>();

    /*
     * T647: the billboard basis for points-mode geometries — camera right/up from the
     * SAME eye/lookAt the view-projection was built from, so the cards face the camera
     * exactly. A straight-down camera falls back to +x as up, the lookAt() convention.
     *
     * T659 hoisted this above the backdrop, unchanged: the environment BACKGROUND needs
     * the same basis to build its per-pixel ray, and one derivation serving both is what
     * stops the sky and the billboards disagreeing about which way is right (§V349).
     */
    const bbForward = (() => {
      const delta = [
        camera.lookAt[0] - camera.eye[0],
        camera.lookAt[1] - camera.eye[1],
        camera.lookAt[2] - camera.eye[2],
      ];
      const length = Math.hypot(delta[0] ?? 0, delta[1] ?? 0, delta[2] ?? 0) || 1;
      return [delta[0]! / length, delta[1]! / length, delta[2]! / length] as const;
    })();
    const bbRight = (() => {
      const up = Math.abs(bbForward[1]) > 0.99 ? ([1, 0, 0] as const) : ([0, 1, 0] as const);
      const cross = [
        bbForward[1] * up[2] - bbForward[2] * up[1],
        bbForward[2] * up[0] - bbForward[0] * up[2],
        bbForward[0] * up[1] - bbForward[1] * up[0],
      ];
      const length = Math.hypot(cross[0] ?? 0, cross[1] ?? 0, cross[2] ?? 0) || 1;
      return [cross[0]! / length, cross[1]! / length, cross[2]! / length] as const;
    })();
    const bbUp = [
      bbRight[1] * bbForward[2] - bbRight[2] * bbForward[1],
      bbRight[2] * bbForward[0] - bbRight[0] * bbForward[2],
      bbRight[0] * bbForward[1] - bbRight[1] * bbForward[0],
    ] as const;

    /*
     * T1588b — THE ONE PLACE A PASS GETS ITS MODEL MATRIX: the geometry's own
     * `objectMatrix` (composed by the Geometry node) and, for the passes that light,
     * its normal matrix. Every surface draw below spreads one of these two.
     */
    const modelOf = (payload: GeometryPayload): { model: number[] } => ({
      model: [...(payload.objectMatrix ?? identityMatrix())],
    });
    const modelAndNormalOf = (payload: GeometryPayload): { model: number[]; modelNormal: number[] } => {
      const model = modelOf(payload).model;
      return { model, modelNormal: normalMatrix(model) };
    };

    /*
     * T481/T624 — ONE depth-only sweep of the scene, parameterised. The shadow phase
     * runs it per casting light (light matrix, light-space clip depth); the AO prepass
     * runs it once from the camera (camera matrix, linear view distance over the far
     * plane). Same grid arithmetic, same primitive arithmetic, same counted-draw
     * support, same silent skips where the lit loop refuses by name — extracting it is
     * the whole point, because two copies of a depth sweep drift the moment one gains a
     * geometry mode the other does not.
     */
    const emitDepthSweep = (options: {
      readonly prefix: string;
      readonly target: string;
      /** T1598b: a LIGHT's sweep draws only its casters — one entry per geometry, false = not in this sweep. */
      readonly casters?: ReadonlyArray<boolean>;
      /**
       * T1598b: a caster this sweep CANNOT REACH THIS FRAME (false). Its draws stay in the
       * plan, since where a light and a geometry stand is a value and a value never changes
       * the pass list (§V453), and carry `skip`, so nothing is encoded for them.
       */
      readonly reaches?: (payload: GeometryPayload) => boolean;
      readonly matrix: Float32Array | undefined;
      readonly linearDepth: boolean;
      /** Camera visibility includes transmissive and emissive surfaces, unlike occlusion. */
      readonly visibility?: boolean;
      /** T1414b: a sweep FROM THE CAMERA (the Depth output, the AO prepass) — shadow-only bodies stay out. */
      readonly fromCamera?: boolean;
      /** T704: store fragment-z (z ÷ w) — a projector's frustum is perspective. */
      readonly perspective?: boolean;
      readonly extraUniforms: Readonly<Record<string, ReadonlyArray<number>>>;
      /** T1362b: one face of a point light's cube — draws into its atlas tile, stores radial distance. */
      readonly cube?: { readonly light: readonly number[]; readonly tile: readonly number[] };
      /** T1362b: faces after the first share the atlas the first one cleared. */
      readonly skipClear?: boolean;
      /** T1623b slice 4: the layer of a layered `target` this sweep draws into (a casting light's map). */
      readonly layer?: number;
    }): void => {
      const firstOfSweep = passes.length;
      const depthShader = (shader: ReturnType<typeof shadowSurfaceWgsl>): ReturnType<typeof shadowSurfaceWgsl> =>
        options.cube === undefined ? shader : cubeShadowVariant(shader);
      const cubeUniforms = options.cube === undefined ? {} : { cubeLight: [...options.cube.light], cubeTile: [...options.cube.tile] };
      // The far plate: depth 1.0 everywhere first, the backdrop pattern (T444) —
      // a cleared map must read "nothing here" and the clear colour is not ours.
      if (options.skipClear !== true) passes.push({
        kind: "draw",
        id: `${nodeId}:${options.prefix}:clear`,
        nodeId,
        shader: SHADOW_CLEAR_WGSL,
        target: options.target,
        topology: "triangle-list",
        instances: 1,
        vertexCount: 6,
        clear: true,
      } as DrawPassDescriptor);
      const depthOptions = {
        ...(options.linearDepth ? { linearDepth: true } : {}),
        ...(options.perspective === true ? { perspective: true } : {}),
      };
      const sweepGeometry = ({ payload }: (typeof geometries)[number], geometryIndex: number): void => {
        const position = payload.pairs["position"];
        if (position === undefined) return; // the lit loop refuses this by name
        /* T1411b: an ADDITIVE surface is light laid over the picture, not a body — it
           occludes nothing, so it casts no shadow, encloses no AO, blocks no projector,
           and the exported depth is the depth of what it glows over.
           B256: and so is additive geometry of EVERY kind. The rule stopped at surfaces, so
           an additive billboard, beam or primitive instance still went into the camera's
           sweep (6,000 dust motes read as walls by everything that read the Depth output),
           and a lit additive instance into the lights' and the occlusion prepass's.
           The one way back in is asked for: `ownDepth`, and only into the Depth OUTPUT (the
           one sweep that states visibility rather than occlusion) — a light-only Render
           whose depth a later pass composites by needs to know where the light is. */
        if (additiveLight(payload) && !(options.visibility === true && payload.ownDepth === true)) return;
        if (options.fromCamera === true && payload.castOnly === true) return;
        /* T647: a points-mode billboard casts NO shadow, deliberately — a camera-facing
           card has no light-facing geometry, so a shadow from it would be a lie (and
           without this skip a grid-topology cloud would cast its MESH's shadow, a ghost
           of a surface nobody drew). Stated here, not silently absent (§V403).

           T680 extends the SAME argument, not a new one, to the beam: the ribbon rotates
           about its own length to face the viewer, so the silhouette a light would see is
           not the silhouette anything has. Its LENGTH and BEARING are real — that half
           comes from the data — but its width is a viewing artefact, and a shadow is
           mostly width. §V617's material rule already skips the unlit beams every use so
           far wants; this covers the LIT one, which §V617 does not reach. */
        if (payload.mode === "points" || payload.mode === "beam") {
          if (!options.visibility) return;
          const billboard = payload.mode === "points";
          const instance = payload.instance ?? { shape: "quad" as const, scale: 0.05 };
          let counted = countedByIndex.get(geometryIndex);
          if (counted === undefined) {
            counted = countedDrawSupport(nodeId, payload, {
              vertexCount: 6,
              maxInstances: Math.max(1, payload.capacity),
              argsKey: `drawArgs${geometryIndex}`,
            });
            if (counted !== undefined) {
              countedByIndex.set(geometryIndex, counted);
              passes.push(counted.argsPass);
              scratch.push(counted.scratch);
            }
          }
          passes.push({
            kind: "draw",
            id: `${nodeId}:${options.prefix}:${geometryIndex}`,
            nodeId,
            shader: text(() => sceneInstancesWgsl({
              model: "unlit", lightCount: 0, cameraDepth: true,
              ...(billboard ? { billboard: true } : { beam: true }),
              ...(instance.spherical === true ? { sphericalPoints: true } : {}),
              ...(payload.colorAttribute === undefined ? {} : { pointColor: true }),
              ...(payload.group === undefined ? {} : { group: payload.group }),
              ...(payload.scaleAttribute === undefined ? {} : {
                pointScale: { type: payload.scaleAttribute.type,
                  ...(payload.scaleAttribute.channel === undefined ? {} : { channel: payload.scaleAttribute.channel }) },
              }),
            })),
            target: options.target,
            topology: "triangle-list",
            instances: counted?.instances ?? payload.capacity,
            vertexCount: 6,
            buffers: [
              attributeBinding("positions", position),
              ...(payload.endpoint === undefined ? [] : [attributeBinding("endpoints", payload.endpoint)]),
              ...(payload.colorAttribute === undefined ? [] : [attributeBinding("pointColors", payload.colorAttribute)]),
              ...(payload.scaleAttribute === undefined ? [] : [attributeBinding("pointScales", payload.scaleAttribute)]),
              ...(payload.group === undefined ? [] : payload.group.binds.map(bind => attributeBinding(`group_${bind.attribute}`, bind))),
            ],
            uniforms: {
              viewProjection: Array.from(viewProjectionMatrix),
              eye: [...camera.eye, 0],
              ambientColor: [0, 0, 0, 0], baseColor: [...payload.material.baseColor],
              specular: [0, 0, 0, 1], material: [0, 0, 0, 0],
              instance: [instance.scale, 0, instance.taper ?? 0, instance.soft ?? 0],
              ...(billboard ? { billboardRight: [...bbRight, 0], billboardUp: [...bbUp, 0] } : {}),
              ...options.extraUniforms,
              ...cubeUniforms,
            },
            uniformBinding: "params",
            clear: false,
          });
          return;
        }
        /* T725: GLASS casts no shadow — light passes through it, so the opaque stamp a
           caster leaves would be a lie (a caustic is a different feature, stated on the
           material). Same argument family as the billboard and the beam above; reaches
           the AO sweep too, deliberately — glass does not enclose its neighbourhood.
           Camera visibility is different: glass draws write hardware depth, so its
           exported surface depth must agree or downstream compositors erase it. */
        if (!options.visibility && payload.material.model === "glass") return;
        /*
         * T666 — an UNLIT geometry exchanges no light IN EITHER DIRECTION, so it does
         * not cast either. §V610 named the billboard half of this and stopped there;
         * the general rule is what E34 found by looking: 480 unlit octahedra in
         * INSTANCES mode (which the billboard skip does not reach) casting hard,
         * texel-quantised shadows down every grazing slope, read as black combing that
         * nobody could attribute to anything in the frame. Rendering the terrain alone
         * showed it self-shadows almost nowhere — the whole of that example's shadow
         * was the markers' artefact.
         *
         * The argument is the same one V610 makes and it is a MATERIAL fact, not a
         * per-object switch (§V437): `materialUnlit` declares that this surface does
         * not take part in lighting. A surface that ignores every light while blocking
         * those same lights is incoherent — it is a light source, an overlay, a
         * reading, a marker; it is not matter. The lit shader ALREADY declines ambient
         * occlusion for an unlit model, so half of this symmetry was in place and the
         * other half was missing.
         *
         * It reaches the AO sweep too, deliberately and for the same reason: occlusion
         * is light that fails to arrive, and a thing that does not interact with light
         * cannot stop it. Its visible surface still belongs in camera depth.
         */
        if (!options.visibility && payload.material.model === "unlit") return;
        /* T1581b: MESH instances sweep through the mesh generator — the indexed mesh's own
           depth contract, each instance placed by its record exactly as the lit draw places it. */
        if (payload.instanceMesh !== undefined) {
          /* T1689b: a sweep that asks what stands between a source of light and a surface
             (a light's map, the Light Depth output, a projector's occlusion) draws the
             geometry's SHADOW MESH where it has one: the same records, so the same instances
             at the same places, and its own triangles and arguments. A sweep from the camera
             (the Depth output, the occlusion prepass) states what the camera sees: the shape. */
          const proxy = options.fromCamera === true ? undefined : payload.instanceMesh.shadow;
          const swept = proxy === undefined ? payload.instanceMesh : { ...payload.instanceMesh, pairs: proxy.pairs, triangles: proxy.triangles, indexBuffer: proxy.indexBuffer };
          const storage = meshInstanceStorage(swept, false);
          if (storage === undefined) return; // the lit loop refuses this by name
          const vertexCount = swept.triangles * 3;
          passes.push({
            kind: "draw",
            id: `${nodeId}:${options.prefix}:${geometryIndex}`,
            nodeId,
            shader: text(() => depthShader(shadowMeshWgsl({ ...depthOptions, instanced: storage.option }))),
            target: options.target,
            topology: "triangle-list",
            instances: proxy?.drawArgs === undefined ? meshInstanceCount(payload) : { indirect: proxy.drawArgs },
            vertexCount,
            buffers: storage.buffers,
            uniforms: {
              lightViewProjection: Array.from(options.matrix ?? []),
              ...options.extraUniforms,
              ...cubeUniforms,
            },
            uniformBinding: "params",
            clear: false,
          });
          return;
        }
        if (payload.mode === "instances") {
          let counted = countedByIndex.get(geometryIndex);
          if (counted === undefined && payload.count !== undefined) {
            const support = countedDrawSupport(nodeId, payload, {
              vertexCount: 36,
              maxInstances: Math.max(1, payload.capacity),
              argsKey: `drawArgs${geometryIndex}`,
            });
            if (support !== undefined) {
              counted = support;
              countedByIndex.set(geometryIndex, support);
              passes.push(support.argsPass);
              scratch.push(support.scratch);
            }
          }
          const instance = payload.instance ?? { shape: "box" as const, scale: 0.05 };
          passes.push({
            kind: "draw",
            id: `${nodeId}:${options.prefix}:${geometryIndex}`,
            nodeId,
            shader: text(() => depthShader(shadowInstancesWgsl({
              ...depthOptions,
              ...(payload.group === undefined ? {} : { group: payload.group }),
              /* T721: the depth sweep sizes each primitive exactly as the lit draw does,
                 or the shadow is cast by a shape nothing in the picture has. */
              ...(payload.scaleAttribute === undefined
                ? {}
                : {
                    pointScale: {
                      type: payload.scaleAttribute.type,
                      ...(payload.scaleAttribute.channel === undefined ? {} : { channel: payload.scaleAttribute.channel }),
                    },
                  }),
              /* T723: and the turn, with MORE force than the size — a wrongly-sized
                 shadow is the shadow of the right shape, a wrongly-oriented one is the
                 silhouette of a thing that is not in the picture. */
              ...(payload.orientAttribute === undefined ? {} : { pointOrient: true }),
            }))),
            target: options.target,
            topology: "triangle-list",
            instances: counted?.instances ?? payload.capacity,
            vertexCount: 36,
            buffers: [
              attributeBinding("positions", position),
              // T642: the depth pass gates on the same predicate — no ghost shadows.
              ...(payload.group === undefined
                ? []
                : payload.group.binds.map((bind) => attributeBinding(`group_${bind.attribute}`, bind))),
              ...(payload.scaleAttribute === undefined
                ? []
                : [attributeBinding("pointScales", payload.scaleAttribute)]),
              ...(payload.orientAttribute === undefined
                ? []
                : [attributeBinding("pointOrients", payload.orientAttribute)]),
            ],
            uniforms: {
              lightViewProjection: Array.from(options.matrix ?? []),
              instance: [instance.scale, instanceShapeIndex(instance.shape), 0, 0],
              ...options.extraUniforms,
              ...cubeUniforms,
            },
            uniformBinding: "params",
            clear: false,
          });
          return;
        }
        const topology = typeof payload.topology === "string" ? parseTopology(payload.topology) : null;
        /* T1353b: an indexed mesh sweeps through its index list — the same draw, the
           same depth contract, positions pulled instead of gridded. */
        if (topology !== null && topology.kind === "mesh") {
          passes.push({
            kind: "draw",
            id: `${nodeId}:${options.prefix}:${geometryIndex}`,
            nodeId,
            shader: text(() => depthShader(shadowMeshWgsl(depthOptions))),
            target: options.target,
            topology: "triangle-list",
            instances: 1,
            vertexCount: topology.triangles * 3,
            buffers: [attributeBinding("positions", position), { binding: "meshIndices", resourceId: topology.indexBuffer }],
            uniforms: {
              lightViewProjection: Array.from(options.matrix ?? []),
              ...modelOf(payload),
              ...options.extraUniforms,
              ...cubeUniforms,
            },
            uniformBinding: "params",
            clear: false,
          });
          return;
        }
        if (topology === null || topology.kind !== "grid") return; // lit loop refuses
        if (gridPointCount(topology) > payload.capacity) return;
        passes.push({
          kind: "draw",
          id: `${nodeId}:${options.prefix}:${geometryIndex}`,
          nodeId,
          /* T1587b: a grid of several sheets is still this ONE draw, of every sheet's cells. */
          shader: text(() => depthShader(shadowSurfaceWgsl(gridSheets(topology) > 1 ? { ...depthOptions, sheets: true } : depthOptions))),
          target: options.target,
          topology: "triangle-list",
          instances: 1,
          vertexCount: gridVertexCount(topology),
          buffers: [attributeBinding("positions", position)],
          uniforms: {
            lightViewProjection: Array.from(options.matrix ?? []),
            ...modelOf(payload),
            grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
            ...options.extraUniforms,
              ...cubeUniforms,
          },
          uniformBinding: "params",
          clear: false,
        });
      };
      geometries.forEach((geometry, geometryIndex) => {
        // T1598b: left out of this light's casters — it is in no draw of the sweep, and it
        // still receives, because receiving is the lit pass reading the map.
        if (options.casters?.[geometryIndex] === false) return;
        const first = passes.length;
        sweepGeometry(geometry, geometryIndex);
        if (options.reaches === undefined || options.reaches(geometry.payload)) return;
        // Out of this sweep's reach this frame: every draw it just emitted is provably
        // empty. (A counted geometry's args dispatch is not a draw and is left alone.)
        for (let index = first; index < passes.length; index += 1) {
          const pass = passes[index];
          if (pass !== undefined && pass.kind === "draw") passes[index] = { ...pass, skip: true };
        }
      });
      /* T1623b slice 4: every draw of this sweep goes into its layer. Said once, here, for the
         clear and for each geometry's draw whatever emitted it. */
      if (options.layer === undefined) return;
      for (let index = firstOfSweep; index < passes.length; index += 1) {
        const pass = passes[index];
        if (pass !== undefined && pass.kind === "draw" && pass.target === options.target) passes[index] = { ...pass, layer: options.layer };
      }
    };

    /*
     * T1598b — WHICH GEOMETRIES CAST FOR EACH CASTING LIGHT, by slot: the light's Shadow
     * Casters (empty = all) less its Shadow Exclude, matched against what THIS Render
     * draws. The lists are the author's knowledge that a geometry never casts for that
     * light (a floor, a tunnel wall); nothing measured could find it out.
     */
    const castersBySlot = casting.map(({ light, index }) => {
      const only = light.shadowCasters === undefined ? undefined : new Set(light.shadowCasters);
      const never = new Set(light.shadowExclude ?? []);
      const cast = geometries.map(({ source }) => (only === undefined || only.has(source)) && !never.has(source));
      if (!cast.includes(true)) {
        // The map is still cleared and still sampled by every lit fragment: a cost with no
        // shadow to show for it, which is worth saying once (§V369's sibling).
        diagnostics.push({
          severity: "warning",
          code: "node.scene.shadowCasters",
          message: `Node "${nodeId}": light "${lightSources[index] ?? "?"}" casts no shadow here — its Shadow Casters and Shadow Exclude leave none of this Render's geometries.`,
          nodeId,
          suggestion: "Name a geometry this Render draws in the light's Shadow Casters, shorten its Shadow Exclude, or turn Cast Shadows off.",
        });
      }
      return cast;
    });

    /*
     * T1598b — WHAT ONE FACE OF A POINT LIGHT'S CUBE CAN REACH THIS FRAME: a geometry whose
     * world sphere lies wholly beyond the shadow range, or wholly outside the face's
     * quarter of space. A geometry with no bound (kernel-moved, instanced) is always
     * reached. The same range the face matrices and the lit lookup use.
     */
    const reachOf = (light: LightPayload["light"], face: number) => (payload: GeometryPayload): boolean =>
      payload.bounds === undefined || pointShadowFaceReaches(light.position, Math.max(0.1, light.shadowExtent), face, payload.bounds);
    /*
     * T1688b — A LIGHT WHOSE SHADOW IS OUT THIS FRAME REACHES NOTHING. Shadow On is a value,
     * and this is the mechanism a value already had (T1598b): every draw of the light's
     * sweeps stays in the plan and carries `skip`, and each sweep's far plate still clears.
     * So the map holds "nothing here" and not what it held when the shadow went out; the lit
     * text and its bindings are the ones it has with the shadow on (§V1029: one text at 0 and
     * at 1); and the frame it comes back, the sweeps draw the casters where they are.
     * `face` absent: a directional light's one sweep, which has no reach of its own.
     */
    const NOTHING_IN_REACH = (): boolean => false;
    const sweepReachOf = (light: LightPayload["light"], face?: number): { readonly reaches?: (payload: GeometryPayload) => boolean } =>
      light.shadowOn === false ? { reaches: NOTHING_IN_REACH } : face === undefined ? {} : { reaches: reachOf(light, face) };

    /* T481: the shadow phase — every map is rendered BEFORE the lit draws that read it.
       Zero casting lights emits nothing here and nothing below changes: §V309 holds as
       byte-identical passes and shaders. */
    const emitShadowPasses = (): void => {
      /* T1623b slice 4: the two layered targets, each with the layers its kind's casting
         lights need, in steps (`shadowLayerStep`). */
      if (shadowSlots.directional > 0) scratch.push({ kind: "layers", key: SHADOW_KEYS.maps, layers: shadowLayerStep(shadowSlots.directional), scale: SHADOW_MAP_SCALE, format: "r32float", depth: true });
      if (shadowSlots.point > 0) scratch.push({ kind: "layers", key: SHADOW_KEYS.cubes, layers: shadowLayerStep(shadowSlots.point), scale: SHADOW_CUBE_SCALE, format: "r32float", depth: true });
      casting.forEach(({ index: lightIndex, light }, slot) => {
        if (light.type === "point") {
          /* T1362b: the cube — one atlas (3×2 tiles, each face's frustum squeezed into its
             tile) cleared once, then six sweeps, one per face, each storing radial distance
             ÷ range. 1.5× the output keeps a tile near the output's own texel density. */
          const range = Math.max(0.1, light.shadowExtent);
          (pointFaces[slot] ?? []).forEach((matrix, face) => {
            const tileX = face % 3;
            const tileY = Math.floor(face / 3);
            emitDepthSweep({
              prefix: `shadow:${lightIndex}:face${face}`,
              target: shadowTargetOf(slot),
              layer: shadowLayerOf(slot),
              casters: castersBySlot[slot] ?? [],
              ...sweepReachOf(light, face),
              matrix,
              linearDepth: false,
              extraUniforms: {},
              cube: {
                light: [light.position[0], light.position[1], light.position[2], range],
                tile: [1 / 3, 1 / 2, -1 + (2 * tileX + 1) / 3, 1 - (2 * tileY + 1) / 2],
              },
              ...(face === 0 ? {} : { skipClear: true }),
            });
          });
          return;
        }
        emitDepthSweep({
          prefix: `shadow:${lightIndex}`,
          target: shadowTargetOf(slot),
          layer: shadowLayerOf(slot),
          casters: castersBySlot[slot] ?? [],
          ...sweepReachOf(light),
          matrix: shadowMatrices[slot],
          linearDepth: false,
          extraUniforms: {},
        });
      });
    };
    emitShadowPasses();

    /*
     * T1589b, T1623b — THE LIGHT TABLE: this Render's named Lights that do not cast and the
     * lights of every Light in Points mode, as rows of one buffer; the rows with a range
     * sorted into a grid over this Render's view, on the GPU, every frame (light-points.ts).
     * Its passes stand HERE: ahead of the backdrop, so they do not split the run of draws
     * into the colour target (T1604b).
     *
     * EVERY Render that draws a lit Surface has one, lights or none: a lit Surface's text
     * walks the table whatever it holds, so the first Light added to a Render is a write and
     * compiles nothing. A Render with no such draw has none.
     */
    const walksTable = geometries.some(({ payload }) => litSurfaceDraw(payload));
    const plannedLights = !walksTable
      ? undefined
      : lightTablePlan({
            nodeId,
            named,
            sources: pointLights,
            resolution,
            /* What the lit draws render into: twice the output under SSAA. */
            surface: [resolution[0] * (ssaa ? 2 : 1), resolution[1] * (ssaa ? 2 : 1)],
            camera,
            viewProjection: viewProjectionMatrix,
          });
    if (plannedLights !== undefined && "diagnostics" in plannedLights) return { passes: [], diagnostics: plannedLights.diagnostics };
    const lightTable: LightTablePlan | undefined = plannedLights;
    if (lightTable !== undefined) {
      scratch.push(...lightTable.scratch);
      passes.push(...lightTable.passes);
      diagnostics.push(...lightTable.warnings);
    }

    /* T1417b: the first casting light's map again, into the Light Depth port — the same
       sweeps at the port's own size, so a reader rebuilds the layout from the light alone. */
    const lightDepthTarget = parameters["lightDepthOutput"] === true ? outputs["lightDepth"] : undefined;
    if (lightDepthTarget !== undefined) {
      const first = casting[0];
      if (first === undefined) {
        diagnostics.push({
          severity: "error",
          code: "node.scene.lightDepth",
          message: `Node "${nodeId}": Light Depth Output renders the first casting light's shadow map, and no light in Lights casts shadows.`,
          nodeId,
          suggestion: "Turn Cast Shadows on for a light this Render lists (a zero-intensity copy lights nothing and still casts).",
        });
      } else if (first.light.type === "point") {
        const range = Math.max(0.1, first.light.shadowExtent);
        (pointFaces[0] ?? []).forEach((matrix, face) => {
          emitDepthSweep({
            prefix: `lightDepth:face${face}`,
            target: lightDepthTarget,
            casters: castersBySlot[0] ?? [],
            ...sweepReachOf(first.light, face),
            matrix,
            linearDepth: false,
            extraUniforms: {},
            cube: {
              light: [first.light.position[0], first.light.position[1], first.light.position[2], range],
              tile: [1 / 3, 1 / 2, -1 + (2 * (face % 3) + 1) / 3, 1 - (2 * Math.floor(face / 3) + 1) / 2],
            },
            ...(face === 0 ? {} : { skipClear: true }),
          });
        });
      } else {
        emitDepthSweep({ prefix: "lightDepth", target: lightDepthTarget, casters: castersBySlot[0] ?? [], ...sweepReachOf(first.light), matrix: shadowMatrices[0], linearDepth: false, extraUniforms: {} });
      }
    }

    /*
     * T1427b — the PREFILTER phase: the environment blurred once, before any lit draw reads
     * it (see ENV_PREFILTER_SPREADS). Scratch targets scale with the node's output, so each
     * scale here is chosen to give the target the short side it needs; the size the compiler
     * allocates (round(base × scale) per axis, compile.ts) is recomputed for the passes'
     * own `dims`, since a fragment cannot ask its render target how big it is.
     */
    if (environmentPrefiltered && environmentResource !== undefined) {
      const shortSide = Math.max(1, Math.min(resolution[0], resolution[1]));
      const prefilterTarget = (key: string, side: number): { id: string; dims: number[] } => {
        const scale = side / shortSide;
        scratch.push({ key, scale, format: "rgba16float" });
        return {
          id: `scratch:${nodeId}:${key}`,
          dims: [Math.max(1, Math.round(resolution[0] * scale)), Math.max(1, Math.round(resolution[1] * scale)), 0, 0],
        };
      };
      const fullscreen = (
        id: string,
        shader: ReturnType<typeof envPrefilterLevelWgsl>,
        to: { id: string; dims: number[] },
        textures: Array<{ binding: string; resourceId: string }>,
      ): void => {
        passes.push({
          kind: "draw",
          id: `${nodeId}:envPrefilter:${id}`,
          nodeId,
          shader,
          target: to.id,
          preparation: { kind: "environment", source: environmentResource },
          topology: "triangle-list",
          instances: 1,
          vertexCount: 6,
          textures: textures.map((texture) => ({ ...texture, sampled: "unfiltered" as const })),
          uniforms: { dims: to.dims },
          uniformBinding: "params",
          clear: true,
        } as DrawPassDescriptor);
      };
      const base = prefilterTarget("envBase", ENV_PREFILTER_SIDES.base);
      fullscreen("base", ENV_PREFILTER_BASE_WGSL, base, [{ binding: "sourceTex", resourceId: environmentResource }]);
      let previous = base;
      let previousSpread = 0;
      const levels = ENV_PREFILTER_SPREADS.map((spread, level) => {
        const target = prefilterTarget(`envLevel${level}`, ENV_PREFILTER_SIDES.levels[level] ?? 32);
        const radius = Math.sqrt(spread * spread - previousSpread * previousSpread);
        fullscreen(`level${level}`, text(() => envPrefilterLevelWgsl(radius)), target, [{ binding: "sourceTex", resourceId: previous.id }]);
        previous = target;
        previousSpread = spread;
        return target;
      });
      const atlas = prefilterTarget("envAtlas", ENV_PREFILTER_SIDES.atlas);
      fullscreen(
        "pack",
        ENV_PREFILTER_PACK_WGSL,
        atlas,
        levels.map((level, index) => ({ binding: `level${index}`, resourceId: level.id })),
      );
    }

    /*
     * T704 — the PROJECTOR phase: matrices, uniforms, textures and (for occluding
     * projectors) one perspective depth sweep each, priced exactly as T481 priced a
     * casting light. The sweep is the SAME parameterised depth pass with fragment-z
     * stored (the ortho shadow's undivided clip z is not a depth under a perspective
     * frustum) — the lit read side does the matching w-divide. Everything a projector
     * IS travels as values (§V5: re-aiming animates); what it BINDS — a cookie, a
     * depth map — is structural, like a casting light's map.
     */
    const projectorMatrices = projectors.map((proj) => projectorMatrix(proj, proj));
    const projectorDepthTargetOf = (index: number): string => `scratch:${nodeId}:projectorDepth${index}`;
    projectors.forEach((proj, index) => {
      if (!proj.occlusion) return;
      scratch.push({ key: `projectorDepth${index}`, scale: 2, format: "r32float", depth: true });
      emitDepthSweep({
        prefix: `projector:${index}`,
        target: projectorDepthTargetOf(index),
        matrix: projectorMatrices[index],
        linearDepth: false,
        perspective: true,
        extraUniforms: {},
      });
    });
    const projectorOptions = projectors.map((proj) => ({
      cookie: proj.cookieResource !== undefined,
      occlusion: proj.occlusion,
    }));
    const projectorUniforms = Object.fromEntries(
      projectors.flatMap((proj, index) => {
        const nominal = Math.max(
          Math.hypot(proj.lookAt[0] - proj.eye[0], proj.lookAt[1] - proj.eye[1], proj.lookAt[2] - proj.eye[2]),
          1e-4,
        );
        return [
          [`projector${index}Matrix`, Array.from(projectorMatrices[index] ?? [])],
          [`projector${index}Pos`, [proj.eye[0], proj.eye[1], proj.eye[2], proj.brightness]],
          [`projector${index}Color`, [proj.color[0], proj.color[1], proj.color[2], proj.falloff ? 1 : 0]],
          [`projector${index}Meta`, [nominal, ...projectorOcclusionMeta(proj)]],
        ] as Array<[string, number[]]>;
      }),
    );
    const projectorTextures = projectors.flatMap((proj, index) => [
      ...(proj.cookieResource === undefined
        ? []
        : [{ binding: `projectorCookie${index}`, resourceId: proj.cookieResource, sampled: "unfiltered" as const }]),
      ...(proj.occlusion
        ? [{ binding: `projectorDepth${index}`, resourceId: projectorDepthTargetOf(index), sampled: "unfiltered" as const }]
        : []),
    ]);

    /*
     * T624 — the AMBIENT OCCLUSION phase. Three passes, all of them BEFORE the backdrop
     * and the lit draws that read the result:
     *
     *   1. the depth sweep above, from the camera, into an r32float scratch;
     *   2. `aoResolveWgsl` — reconstruct, estimate occlusion, write it to `aoRaw`;
     *   3. `aoBlurWgsl` — depth-guided smoothing into `aoMap`, which the lit draws bind.
     *
     * §V437's shape: this is ONE switch on the render, and every geometry the render
     * names is occluded by every other with nothing to opt in. The cost is stated on the
     * parameter rather than discovered — an extra scene pass and two full-target passes,
     * priced exactly the way T481 priced a casting light.
     */
    /*
     * T722 — the DEPTH OUTPUT: the same parameterised depth sweep the AO prepass runs
     * (linear view distance over the far plane), aimed at the port's own target. When
     * AO is also on the scene is swept twice — a shared prepass is the stated
     * follow-up, kept apart here because AO's sweep is a scratch at its own scale and
     * this one is a consumable output at the node's resolution (correct beats clever).
     */
    const depthTarget = parameters["depthOutput"] === true ? outputs["depth"] : undefined;
    if (depthTarget !== undefined) {
      const depthView = lookAt(
        [camera.eye[0], camera.eye[1], camera.eye[2]],
        [camera.lookAt[0], camera.lookAt[1], camera.lookAt[2]],
        [0, 1, 0],
      );
      const depthFar = Math.max(camera.far, 1e-3);
      emitDepthSweep({
        prefix: "depthOut",
        visibility: true,
        fromCamera: true,
        target: depthTarget,
        matrix: viewProjectionMatrix,
        linearDepth: true,
        extraUniforms: {
          depthRow: [-(depthView[2] ?? 0), -(depthView[6] ?? 0), -(depthView[10] ?? 0), -(depthView[14] ?? 0)],
          depthRange: [depthFar, 0, 0, 0],
        },
      });
    }

    const aoEnabled = parameters["ambientOcclusion"] === true;
    const aoTargetId = `scratch:${nodeId}:aoMap`;
    if (aoEnabled) {
      const aoDepthTarget = `scratch:${nodeId}:aoDepth`;
      const aoRawTarget = `scratch:${nodeId}:aoRaw`;
      const far = Math.max(camera.far, 1e-3);
      /* Row 2 of the VIEW matrix, negated: `dot(row, vec4f(world, 1))` is the distance
         in front of the camera. Column-major, so the row is elements 2/6/10/14. */
      const view = lookAt(
        [camera.eye[0], camera.eye[1], camera.eye[2]],
        [camera.lookAt[0], camera.lookAt[1], camera.lookAt[2]],
        [0, 1, 0],
      );
      const depthRow = [-(view[2] ?? 0), -(view[6] ?? 0), -(view[10] ?? 0), -(view[14] ?? 0)];
      const radius = Math.max(readNumber(parameters, "aoRadius", 0.35), 1e-4);
      const aoIntensity = Math.max(readNumber(parameters, "aoIntensity", 1), 0);
      /* The half-extents the resolve reconstructs by — the ONLY thing it needs of the
         camera, which is why AO needs no matrix inverse and no camera basis. */
      const tanHalf = Math.tan((camera.fovDeg * Math.PI) / 360);
      const orthoHalfH = Math.max(camera.orthoHeight, 1e-6) / 2;
      const aoProjection = camera.ortho
        ? [orthoHalfH * aspect, orthoHalfH, far, 1]
        : [tanHalf * aspect, tanHalf, far, 0];

      scratch.push({ key: "aoDepth", scale: 1, format: "r32float", depth: true });
      scratch.push({ key: "aoRaw", scale: 1, format: "r32float" });
      scratch.push({ key: "aoMap", scale: 1, format: "r32float" });

      emitDepthSweep({
        prefix: "ao:depth",
        fromCamera: true,
        target: aoDepthTarget,
        matrix: viewProjectionMatrix,
        linearDepth: true,
        extraUniforms: { depthRow, depthRange: [far, 0, 0, 0] },
      });

      passes.push({
        kind: "draw",
        id: `${nodeId}:ao:resolve`,
        nodeId,
        shader: text(() => aoResolveWgsl(aoSampleCount(String(parameters["aoQuality"] ?? "medium")))),
        target: aoRawTarget,
        topology: "triangle-list",
        instances: 1,
        vertexCount: 6,
        textures: [{ binding: "depthMap", resourceId: aoDepthTarget, sampled: "unfiltered" }],
        uniforms: { projection: aoProjection, settings: [radius, aoIntensity, AO_BIAS, 1] },
        uniformBinding: "params",
        clear: true,
      } as DrawPassDescriptor);

      passes.push({
        kind: "draw",
        id: `${nodeId}:ao:blur`,
        nodeId,
        shader: text(() => aoBlurWgsl(AO_BLUR_RADIUS)),
        target: aoTargetId,
        topology: "triangle-list",
        instances: 1,
        vertexCount: 6,
        textures: [
          { binding: "occlusionMap", resourceId: aoRawTarget, sampled: "unfiltered" },
          { binding: "depthMap", resourceId: aoDepthTarget, sampled: "unfiltered" },
        ],
        /* The guide tolerance in the stored (normalised) units: half the AO radius, so a
           tap on the far side of a silhouette is dropped and occlusion never bleeds. */
        uniforms: { settings: [(radius * 0.5) / far, 0, 0, 0] },
        uniformBinding: "params",
        clear: true,
      } as DrawPassDescriptor);
    }
    /*
     * T444: the BACKGROUND pass — one full-target triangle-pair painting the backdrop,
     * so a render used as a material map is a PICTURE with a stage behind it rather
     * than performers floating on unlit black (the invisible-screen failure the E25
     * look pass caught). The colour is a value; geometry draws compose over it.
     *
     * T659: and OPTIONALLY the wired environment itself, along a camera ray per pixel.
     * Until now `sampleEnvironment` was read only by the reflection and the irradiance
     * taps, so an environment lit the scene and was never visible — the owner's "is the
     * sky band taking, or are we using a skybox?" had the answer "taking, never drawn".
     * OFF BY DEFAULT on purpose: every shipped scene that wires an environment would
     * otherwise change its sky at once, and a look change nobody asked for is a
     * regression however good it is.
     *
     * The half-extents are the camera's own: `tan(fovY/2)` up, times the aspect across.
     * An ORTHOGRAPHIC camera hands in ZERO for both, so every pixel reads one direction
     * — which is what parallel rays see of something at infinity, stated rather than
     * discovered. The reflection's `environmentIntensity` scales this too: one map, and
     * a reflection brighter than the sky it reflects is incoherent.
     */
    const showEnvironment = parameters["showEnvironment"] === true;
    const drawEnvironment = showEnvironment && environmentResource !== undefined;
    if (showEnvironment && environmentResource === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "node.scene.environment",
        message: `Node "${nodeId}": Show Environment is on, but no environment is wired — the background stays the Background colour.`,
        nodeId,
        suggestion: "Wire a texture into the Environment input, or turn Show Environment off.",
      });
    }
    const halfHeight = camera.ortho ? 0 : Math.tan((camera.fovDeg * Math.PI) / 360);
    passes.push({
      kind: "draw",
      id: `${nodeId}:backdrop`,
      nodeId,
      shader: text(() => backdropWgsl(drawEnvironment ? { environment: true } : {})),
      target,
      // Background colour must not occlude real geometry near the camera's far plane.
      depthWrite: false,
      topology: "triangle-list",
      instances: 1,
      vertexCount: 6,
      ...(drawEnvironment
        ? { textures: [{ binding: "environmentMap", resourceId: environmentResource, sampled: "unfiltered" as const }] }
        : {}),
      uniforms: {
        color: [background[0] ?? 0, background[1] ?? 0, background[2] ?? 0, background[3] ?? 1],
        ...(drawEnvironment
          ? {
              right: [
                bbRight[0] * halfHeight * aspect,
                bbRight[1] * halfHeight * aspect,
                bbRight[2] * halfHeight * aspect,
                0,
              ],
              up: [bbUp[0] * halfHeight, bbUp[1] * halfHeight, bbUp[2] * halfHeight, 0],
              forward: [bbForward[0], bbForward[1], bbForward[2], environmentIntensity],
            }
          : {}),
      },
      uniformBinding: "backdrop",
      clear: true,
    } as DrawPassDescriptor);

    /* T1371b/T1380b: the G-buffer targets, cleared to "no surface" before any geometry writes them. */
    const gbufferTargets = (
      [
        ["normal", parameters["normalOutput"] === true ? outputs["normal"] : undefined],
        ["albedo", parameters["albedoOutput"] === true ? outputs["albedo"] : undefined],
        ["shadow", parameters["shadowOutput"] === true ? outputs["shadow"] : undefined],
      ] as const
    ).flatMap(([layer, target]) => (target === undefined ? [] : [{ layer, target }]));
    /*
     * T1604b — EACH LAYER'S DRAWS, KEPT TOGETHER and emitted after everything that draws the
     * colour (see where they are pushed, below the additive phase). A layer has its own
     * target and its own depth, and nothing here reads one, so when its draws run moves no
     * pixel; what it changes is how many device render passes the frame is. Emitted beside
     * each geometry's lit draw, as they were, the targets alternated: lit, Normal, lit,
     * Normal — and a run of draws ends where the target changes (`renderPassRuns`), so every
     * one of those draws was a pass of its own. Together, the lit draws are one pass and
     * each layer is one: its clear and then its geometries, in Scenes order as before.
     */
    const layerDraws = new Map<(typeof gbufferTargets)[number]["layer"], DrawPassDescriptor[]>(
      gbufferTargets.map(({ layer, target }) => [
        layer,
        [
          {
            kind: "draw",
            id: layer === "normal" ? `${nodeId}:gbuffer:clear` : `${nodeId}:gbuffer:${layer}:clear`,
            nodeId,
            shader: GBUFFER_CLEAR_WGSL,
            target,
            topology: "triangle-list",
            instances: 1,
            vertexCount: 6,
            clear: true,
          } as DrawPassDescriptor,
        ],
      ]),
    );
    const emitGeometry = ({ payload, source }: { payload: GeometryPayload; source: string }, index: number): void => {
      /* T1414b: a shadow-only body is in the light sweeps above and in nothing the camera draws. */
      if (payload.castOnly === true) return;
      /* T1581b: MESH instances are surface citizens — they take the surface branch below. */
      const instanceMesh = payload.instanceMesh;
      if ((payload.mode === "instances" && instanceMesh === undefined) || payload.mode === "points" || payload.mode === "beam") {
        /* T1355b: a Material · WGSL is placed into the SURFACE generator; these three draw
           through another one, and a material whose code silently did not run would teach
           that the code is broken. Refused by name. */
        if (payload.material.custom !== undefined) {
          diagnostics.push({
            severity: "error",
            code: "node.scene.material",
            message: `Node "${nodeId}": geometry "${source}" is drawn as ${payload.mode === "instances" ? "primitive instances" : payload.mode} but wears a Material · WGSL, which runs on surface geometry and mesh instances only.`,
            nodeId,
            suggestion: "Switch the Geometry to Surface mode, or to Instances with Shape: Mesh, or give it a stock material.",
          });
          return;
        }
        const billboard = payload.mode === "points";
        /* T680: a beam is a quad like a billboard is — six vertices, one instance per
           point — so it rides this whole branch and differs only in the generator flag
           and the one extra buffer. */
        const beam = payload.mode === "beam";
        const position = payload.pairs["position"];
        if (position === undefined) {
          diagnostics.push({
            severity: "error",
            code: "node.scene.geometry",
            message: `Node "${nodeId}": geometry "${source}" carries no position pair.`,
            nodeId,
          });
          return;
        }
        const material = payload.material;
        if (material.maps.albedo !== undefined || material.maps.roughness !== undefined) {
          // §V288/V368: instances have no uv yet — a map that silently did nothing
          // would teach that maps are broken. Refuse by name until instance uvs exist.
          diagnostics.push({
            severity: "error",
            code: "node.scene.maps",
            message: `Node "${nodeId}": geometry "${source}" wears a material with texture maps, but a ${payload.mode} draw has no uv to sample by yet — maps work on surface geometry.`,
            nodeId,
          });
          return;
        }
        if (material.model !== "unlit" && lights.length === 0) {
          diagnostics.push({
            severity: "warning",
            code: "node.scene.unlit",
            message: `Node "${nodeId}": geometry "${source}" wears a lit material but no lights are named — ambient floor only.`,
            nodeId,
          });
        }
        /* T1589b: the lights of a pointset reach Surface geometry and mesh instances, which
           draw through the surface generator. These three draw through another one and take
           them with the row's fourth slice; until then that is SAID, not a silent dark body. */
        if (material.model !== "unlit" && pointLights.length > 0) {
          diagnostics.push({
            severity: "warning",
            code: "node.scene.lightDraw",
            message: `Node "${nodeId}": geometry "${source}" is drawn as ${payload.mode === "instances" ? "primitive instances" : payload.mode}, which the lights of a Light in Points mode (${pointLights.map((light) => `"${light.nodeId}"`).join(", ")}) do not light yet: they light Surface geometry and mesh instances.`,
            nodeId,
            suggestion: "Draw it as a Surface or as mesh instances (Shape: Mesh), or light it with a Light in Single mode.",
          });
        }
        /* T1623b slice 3: this generator still reads every Light in Single mode as a block,
           and a block takes no cone (slice 7). A spot that does not cast has its cone on
           every Surface of this Render and none here, which is SAID. A casting one has none
           anywhere, and its Light says that. */
        if (material.model !== "unlit" && namedSpots.length > 0) diagnostics.push(lightSpotDraw(nodeId, source, payload.mode, namedSpots));
        const model =
        material.model === "unlit"
          ? "unlit"
          /* T1284: `pbr` is its own model now. It used to be mapped to "phong" here with
             its shininess pinned at 96, which is why `materialPbr` shaded as Blinn-Phong
             and the node said so. `phong` is untouched: a Phong material must keep the
             picture it had, or this row changes every scene in the catalogue. */
          : material.model === "pbr"
            ? "pbr"
            : material.model === "phong"
              ? "phong"
              : "lambert";
        /* T624: an unlit material has no ambient term to occlude, so it binds nothing —
           the shader generator makes the same call, and the two must agree. */
        const aoActive = aoEnabled && model !== "unlit";
        /* T704: a projector is a LIGHT — unlit takes none, and binds none. */
        const projActive = projectorOptions.length > 0 && model !== "unlit";
        const specularColor =
          material.model === "pbr"
            ? ([
                1 + (material.baseColor[0] - 1) * material.metallic,
                1 + (material.baseColor[1] - 1) * material.metallic,
                1 + (material.baseColor[2] - 1) * material.metallic,
              ] as const)
            : material.specularColor;
        const shininess = material.model === "pbr" ? 96 : material.shininess;
        const instance = payload.instance ?? { shape: "box" as const, scale: 0.05 };
        /*
         * T478: a COUNTED geometry draws INDIRECTLY off its GPU-resident live count —
         * T322's machinery verbatim, so a spawning/killing producer's dead tail is
         * never resurrected into the scene. The args id is scoped per geometry so two
         * counted objects in one render cannot collide — and when a shadow phase ran
         * first, its args dispatch is REUSED, not duplicated (T481).
         */
        let counted = countedByIndex.get(index);
        if (counted === undefined) {
          counted = countedDrawSupport(nodeId, payload, {
            vertexCount: billboard || beam ? 6 : 36,
            maxInstances: Math.max(1, payload.capacity),
            argsKey: `drawArgs${index}`,
          });
          if (counted !== undefined) {
            countedByIndex.set(index, counted);
            passes.push(counted.argsPass);
            scratch.push(counted.scratch);
          }
        }
        passes.push({
          kind: "draw",
          id: `${nodeId}:scene:${index}`,
          nodeId,
          /* T917: additive LIGHT — sums onto what is drawn and stops writing depth (it
             still tests), so overlapping beams add instead of fighting the z-buffer. */
          ...(payload.blend === "additive" ? { blend: "additive" as const, depthWrite: false } : {}),
          shader: text(() => sceneInstancesWgsl({
            model,
            lightCount: lights.length,
            ...(payload.instance?.spherical === true ? { sphericalPoints: true } : {}),
            ...(payload.colorAttribute === undefined ? {} : { pointColor: true }),
            /* T721: the per-point size factor, structural in the SAME way the tint is —
               a binding either exists or it does not, and the shader is generated for it. */
            ...(payload.scaleAttribute === undefined
              ? {}
              : {
                  pointScale: {
                    type: payload.scaleAttribute.type,
                    ...(payload.scaleAttribute.channel === undefined ? {} : { channel: payload.scaleAttribute.channel }),
                  },
                }),
            ...(castingIndices.length === 0 ? {} : { shadows: castingIndices, shadowSoftness, shadowBias, ...(pointSlots.length === 0 ? {} : { pointShadows: pointSlots }) }),
            ...(environmentResource === undefined ? {} : { environment: true, environmentTaps, ...(environmentPrefiltered ? { environmentPrefiltered: true } : {}) }),
            ...(aoActive ? { ambientOcclusion: true } : {}),
            ...(projActive ? { projectors: projectorOptions } : {}),
            ...(payload.group === undefined ? {} : { group: payload.group }),
            ...(billboard ? { billboard: true } : {}),
            ...(beam ? { beam: true } : {}),
            /* T723: the turn, and the generator rotates the NORMALS with it. */
            ...(payload.orientAttribute === undefined ? {} : { pointOrient: true }),
          })),
          target,
          topology: "triangle-list",
          instances: counted?.instances ?? payload.capacity,
          vertexCount: billboard || beam ? 6 : 36,
          buffers: [
            attributeBinding("positions", position),
            /* T680: the far end, bound exactly as the colour attribute is — the geometry
               node resolved the NAME against the edge, so this is one more pair ref and
               no new concept. */
            ...(payload.endpoint === undefined
              ? []
              : [attributeBinding("endpoints", payload.endpoint)]),
            ...(payload.colorAttribute === undefined
              ? []
              : [attributeBinding("pointColors", payload.colorAttribute)]),
            ...(payload.scaleAttribute === undefined
              ? []
              : [attributeBinding("pointScales", payload.scaleAttribute)]),
            ...(payload.orientAttribute === undefined
              ? []
              : [attributeBinding("pointOrients", payload.orientAttribute)]),
            // T642: one binding per attribute the predicate reads — a REGION of the
            // producer's packed buffer since T1076, so several land on one buffer. The compiler's
            // binding-budget check prices these against the BASELINE 8 per stage
            // (§V588), so an over-wide predicate refuses by name before any device sees it.
            ...(payload.group === undefined
              ? []
              : payload.group.binds.map((bind) => attributeBinding(`group_${bind.attribute}`, bind))),
          ],
          uniforms: {
            viewProjection: Array.from(viewProjectionMatrix),
            eye: [camera.eye[0], camera.eye[1], camera.eye[2], 0],
            ambientColor: [ambient[0] ?? 1, ambient[1] ?? 1, ambient[2] ?? 1, ambientIntensity],
            baseColor: [...material.baseColor],
            specular: [...specularColor, shininess],
            material: [material.metallic, material.roughness, 0, 0],
            instance: [
              instance.scale,
              billboard || beam ? 0 : instanceShapeIndex(instance.shape),
              /* T680: z is the beam's taper. Beam mode always sets it; every other mode
                 leaves this slot at the 0 it has always held, so their uniform bytes are
                 unchanged and no golden reading moves (§V309). */
              instance.taper ?? 0,
              /* T917: w is the soft profile. 0 — the default — is coverage 1 in the
                 fragment, so every shipped picture is bit-identical. */
              instance.soft ?? 0,
            ],
            ...(billboard
              ? {
                  billboardRight: [bbRight[0], bbRight[1], bbRight[2], 0],
                  billboardUp: [bbUp[0], bbUp[1], bbUp[2], 0],
                }
              : {}),
            ...Object.fromEntries(
              lights.flatMap((light, lightIndex) => [
                [`light${lightIndex}Meta`, lightMetaUniform(light)],
                [`light${lightIndex}Color`, [...light.color, 0]],
                [`light${lightIndex}Vector`, [...(light.type === "point" ? light.position : light.direction), 0]],
              ]),
            ),
            ...Object.fromEntries(
              shadowUniforms(),
            ),
            ...(environmentResource === undefined || !envLit(model)
              ? {}
              : { environment: [environmentIntensity, 0, 0, 0] }),
            ...(projActive ? projectorUniforms : {}),
          },
          ...(casting.length === 0 && environmentResource === undefined && !aoActive && !projActive
            ? {}
            : {
                textures: [
                  ...shadowTextures(),
                  ...(environmentResource === undefined || !envLit(model)
                    ? []
                    : [
                        { binding: "environmentMap", resourceId: environmentResource, sampled: "unfiltered" as const },
                        ...(environmentPrefiltered ? [{ binding: "environmentAtlas", resourceId: envAtlasId, sampled: "unfiltered" as const }] : []),
                      ]),
                  ...(aoActive
                    ? [{ binding: "occlusionMap", resourceId: aoTargetId, sampled: "unfiltered" as const }]
                    : []),
                  ...(projActive ? projectorTextures : []),
                ],
              }),
          uniformBinding: "params",
          clear: false,
        });
        return;
      }
      /* T1581b: the SHAPE this draw fetches — the instance mesh's own pointset and triangles,
         or the geometry's points and their topology. Everything below reads the shape. */
      const shapePairs = instanceMesh?.pairs ?? payload.pairs;
      const topology =
        instanceMesh !== undefined
          ? ({ kind: "mesh", triangles: instanceMesh.triangles, indexBuffer: instanceMesh.indexBuffer } as const)
          : typeof payload.topology === "string"
            ? parseTopology(payload.topology)
            : null;
      if (topology === null || (topology.kind !== "grid" && topology.kind !== "mesh")) {
        diagnostics.push({
          severity: "error",
          code: "node.scene.topology",
          message: `Node "${nodeId}": geometry "${source}" carries neither an analytic grid nor a mesh topology; a surface cannot be built.`,
          nodeId,
        });
        return;
      }
      /* T1353b: an indexed mesh (Mesh File In, or anything downstream of one). Its
         normal is an attribute, so a mesh without one is refused by name — a surface
         lit by a zero normal is black in a way that reads as broken lights. */
      const meshTopology = topology.kind === "mesh" ? topology : undefined;
      const meshNormal = meshTopology === undefined ? undefined : shapePairs["normal"];
      if (meshTopology !== undefined && (meshNormal === undefined || meshNormal.type !== "vec3f")) {
        diagnostics.push({
          severity: "error",
          code: "node.scene.topology",
          message: `Node "${nodeId}": geometry "${source}" is a mesh without a vec3f \`normal\` attribute; a mesh surface is lit by its vertex normals.`,
          nodeId,
          suggestion: "Keep the normal attribute through any kernel between the Mesh File In and the Geometry.",
        });
        return;
      }
      if (topology.kind === "grid" && gridPointCount(topology) > payload.capacity) {
        diagnostics.push({
          severity: "error",
          code: "node.scene.topology",
          message: `Node "${nodeId}": geometry "${source}" claims ${gridPointCount(topology)} grid points but carries ${payload.capacity}.`,
          nodeId,
        });
        return;
      }
      const position = shapePairs["position"];
      /* T1581b: a mesh-instance draw binds whole buffers and reads by offset. */
      const instancedStorage = instanceMesh === undefined ? undefined : meshInstanceStorage(instanceMesh, true);
      if (position === undefined || (instanceMesh !== undefined && instancedStorage === undefined)) {
        diagnostics.push({
          severity: "error",
          code: "node.scene.geometry",
          message: `Node "${nodeId}": geometry "${source}" carries no position pair.`,
          nodeId,
        });
        return;
      }
      const material = payload.material;
      if (material.model !== "unlit" && lights.length === 0 && pointLights.length === 0) {
        // §V369's cousin: a lit material under zero lights is the flat-ambient look
        // wearing a finished face. Render it (the floor exists for exactly this), but
        // SAY it.
        diagnostics.push({
          severity: "warning",
          code: "node.scene.unlit",
          message: `Node "${nodeId}": geometry "${source}" wears a lit material but no lights are named — ambient floor only.`,
          nodeId,
        });
      }
      const vertexCount = topology.kind === "mesh" ? topology.triangles * 3 : gridVertexCount(topology);
      /* T1587b: a grid of several sheets (ten tubes swept from ten strips) is still ONE draw
         in every pass that draws it, so it adds no pass to any run (T1604b). The generator
         reads the sheet off the vertex index, in a variant only such a grid emits. */
      const sheetsOption = topology.kind === "grid" && gridSheets(topology) > 1 ? { sheets: true } : {};
      const meshAttribute = (name: string, type: string): ScenePairRef | undefined => {
        const pair = shapePairs[name];
        return pair !== undefined && pair.type === type ? pair : undefined;
      };
      const meshUv = meshTopology === undefined ? undefined : meshAttribute("uv", "vec2f");
      const meshSurfacePair = meshTopology === undefined ? undefined : meshAttribute("surface", "vec4f");
      const meshEmissive = meshTopology === undefined ? undefined : meshAttribute("emissive", "vec3f");
      /* A mesh's attributes ARE its material (the file's, flattened per vertex), so its
         `color` tints by default; an explicit tint map on the Geometry still wins. */
      const tintAttribute = payload.colorAttribute ?? (meshTopology === undefined ? undefined : meshAttribute("color", "vec4f"));
      /* T1581b: an instance's tint is the shape's colour times its record's — either makes
         the fragment multiply by the vertex tint. */
      const tinted = instancedStorage === undefined ? tintAttribute !== undefined : instancedStorage.option.color !== undefined || instancedStorage.option.record.tint !== undefined;
      const instancedOption = instancedStorage === undefined ? {} : { instanced: instancedStorage.option };
      const model =
        material.model === "unlit"
          ? "unlit"
          /* T1284: `pbr` is its own model now. It used to be mapped to "phong" here with
             its shininess pinned at 96, which is why `materialPbr` shaded as Blinn-Phong
             and the node said so. `phong` is untouched: a Phong material must keep the
             picture it had, or this row changes every scene in the catalogue. */
          : material.model === "pbr"
            ? "pbr"
            : material.model === "phong"
              ? "phong"
              : "lambert";
      /* T624: see the instances branch — unlit binds no occlusion map. */
      const aoActive = aoEnabled && model !== "unlit";
      /* T704: see the instances branch — unlit takes no projectors. */
      const projActive = projectorOptions.length > 0 && model !== "unlit";
      /*
       * T428, superseded by T1284 for the MODEL: `pbr` now generates a GGX/Smith lobe
       * of its own. What survives here is the mapping BELOW — metallic tints the
       * highlight toward the base colour (a metal's reflection is its own colour), which
       * is exactly the F0 the GGX Fresnel wants: mix(0.04, specular.rgb, metallic) is the
       * textbook mix(vec3(0.04), albedo, metallic) once this mapping has run. The
       * shininess below is now unread by the pbr generator — roughness drives alpha
       * directly — and is kept only so a material switched back to phong is unchanged.
       */
      const specularColor =
        material.model === "pbr"
          ? ([
              1 + (material.baseColor[0] - 1) * material.metallic,
              1 + (material.baseColor[1] - 1) * material.metallic,
              1 + (material.baseColor[2] - 1) * material.metallic,
            ] as const)
          : material.specularColor;
      const shininess = material.model === "pbr" ? 96 : material.shininess;
      const maps = {
        ...(material.maps.albedo === undefined ? {} : { albedo: true }),
        ...(material.maps.roughness === undefined ? {} : { roughness: true }),
      };
      /* T1618b: Map Extend, where the material says an axis tiles. Absent, the maps are read
         by the text they always were. */
      const mapExtendOption = material.mapExtend === undefined ? {} : { mapExtend: material.mapExtend };
      /* T1618b: a grid whose pointset carries a vec2f `uv` hands it to the material as its
         texture coordinate, in place of the grid's own. Bound and read only where a coordinate
         IS read: a map is wired, or the Material · WGSL's source names the member. A sweep
         whose material patterns by world position keeps the program and the bindings it had. */
      const gridUv =
        topology.kind === "grid" &&
        (material.maps.albedo !== undefined || material.maps.roughness !== undefined || (material.custom !== undefined && SURFACE_UV_REFERENCE.test(material.custom.code)))
          ? meshAttribute("uv", "vec2f")
          : undefined;
      const gridUvOption = gridUv === undefined ? {} : { gridUv: true };
      /* The author's surface, as the generator takes it: one object for every variant below. */
      const customOption =
        material.custom === undefined
          ? {}
          : {
              custom: {
                code: material.custom.code,
                paramsDeclaration: material.custom.paramsDeclaration,
                fields: material.custom.fields,
                ...(material.custom.instance === undefined ? {} : { instance: material.custom.instance }),
                ...(material.custom.textures === undefined ? {} : { textures: material.custom.textures.map((texture) => texture.name) }),
              },
            };
      /* T1658b: the textures a Material · WGSL names, bound under those names in every draw
         of this geometry that runs its `surface()`: the lit draw, the layers, the matte. */
      const materialTextures = (material.custom?.textures ?? []).map((texture) => ({ binding: texture.name, resourceId: texture.resourceId, sampled: "unfiltered" as const }));
      for (const texture of materialTextures) materialTextureNames.add(texture.binding);
      const surfaceMaterialOptions = {
        model: model as "unlit" | "lambert" | "phong" | "pbr",
        maps,
        ...mapExtendOption,
        ...instancedOption,
        ...(tinted ? { pointColor: true } : {}),
        ...sheetsOption,
        ...gridUvOption,
        ...(meshTopology === undefined
          ? {}
          : { mesh: { uv: meshUv !== undefined, surface: meshSurfacePair !== undefined, emissive: meshEmissive !== undefined } }),
        ...customOption,
      };
      /* T1411b: an additive surface sums onto what is drawn and stops writing depth (it
         still tests — a wall in front still hides it). */
      const additive = additiveSurface(payload);
      /* T1535b: a Material · WGSL's code is compiled in THIS node's pass; its source map,
         moved to where the generator put the texts, sends a device error in it back to the
         material node and the author's line. Every surface variant below carries its own. */
      const surface = (options: SceneShadingOptions): Pick<DrawPassDescriptor, "shader" | "sourceMap"> => {
        /* T1589b: the draw that LIGHTS walks the light table. A G-buffer layer lights nothing,
           and an unlit material takes no light of any kind. */
        const walks = lightTable !== undefined && options.gbuffer === undefined && options.model !== "unlit";
        if (mode === "values") return { shader: VALUES_ONLY_TEXT };
        const module = sceneSurfaceModule(walks ? { ...options, lightGrid: true } : options);
        const map = material.custom?.sourceMap;
        return { shader: module.wgsl, ...(map === undefined ? {} : { sourceMap: customSurfaceSourceMap(map, module.placed) }) };
      };
      const litPass: DrawPassDescriptor = {
        kind: "draw",
        id: `${nodeId}:scene:${index}`,
        nodeId,
        ...(additive ? { blend: "additive" as const, depthWrite: false } : {}),
        ...surface({
          model,
          /* T1623b: the casting Lights, each a block; the others are rows of the table. */
          lightCount: blockLights.length,
          ...(additive ? { additive: true } : {}),
          maps,
          ...mapExtendOption,
          ...instancedOption,
          ...(tinted ? { pointColor: true } : {}),
          ...sheetsOption,
          ...gridUvOption,
          ...(blockShadows.length === 0 ? {} : { shadows: blockShadows, shadowSoftness, shadowBias, ...(pointSlots.length === 0 ? {} : { pointShadows: pointSlots }) }),
          ...(environmentResource === undefined ? {} : { environment: true, environmentTaps, ...(environmentPrefiltered ? { environmentPrefiltered: true } : {}) }),
          ...(aoActive ? { ambientOcclusion: true } : {}),
          ...(projActive ? { projectors: projectorOptions } : {}),
          ...(meshTopology === undefined
            ? {}
            : { mesh: { uv: meshUv !== undefined, surface: meshSurfacePair !== undefined, emissive: meshEmissive !== undefined } }),
          ...customOption,
        }),
        ...(material.custom === undefined ? {} : { sharedBinding: CUSTOM_SURFACE_FRAME_BINDING }),
        target,
        topology: "triangle-list",
        instances: instanceMesh === undefined ? 1 : meshInstanceCount(payload),
        vertexCount,
        buffers:
          instancedStorage !== undefined
            ? instancedStorage.buffers
            : [
                attributeBinding("positions", position),
                ...(tintAttribute === undefined
                  ? []
                  : [attributeBinding("pointColors", tintAttribute)]),
                ...(gridUv === undefined ? [] : [attributeBinding("gridUvs", gridUv)]),
                ...(meshTopology === undefined
                  ? []
                  : [
                      { binding: "meshIndices", resourceId: meshTopology.indexBuffer },
                      attributeBinding("meshNormals", meshNormal as ScenePairRef),
                      ...(meshUv === undefined ? [] : [attributeBinding("meshUvs", meshUv)]),
                      ...(meshSurfacePair === undefined ? [] : [attributeBinding("meshSurface", meshSurfacePair)]),
                      ...(meshEmissive === undefined ? [] : [attributeBinding("meshEmissive", meshEmissive)]),
                    ]),
              ],
        ...(material.maps.albedo === undefined &&
        material.maps.roughness === undefined &&
        materialTextures.length === 0 &&
        casting.length === 0 &&
        !aoActive &&
        !projActive &&
        (environmentResource === undefined || !envLit(model))
          ? {}
          : {
              textures: [
                ...(material.maps.albedo === undefined
                  ? []
                  : [{ binding: "albedoMap", resourceId: material.maps.albedo, sampled: "unfiltered" as const }]),
                ...(material.maps.roughness === undefined
                  ? []
                  : [{ binding: "roughnessMap", resourceId: material.maps.roughness, sampled: "unfiltered" as const }]),
                ...materialTextures,
                ...shadowTextures(),
                ...(environmentResource === undefined || !envLit(model)
                  ? []
                  : [
                      { binding: "environmentMap", resourceId: environmentResource, sampled: "unfiltered" as const },
                      ...(environmentPrefiltered ? [{ binding: "environmentAtlas", resourceId: envAtlasId, sampled: "unfiltered" as const }] : []),
                    ]),
                ...(aoActive
                  ? [{ binding: "occlusionMap", resourceId: aoTargetId, sampled: "unfiltered" as const }]
                  : []),
                ...(projActive ? projectorTextures : []),
              ],
            }),
        uniforms: {
          viewProjection: viewProjectionUniform,
          /* T1581b: an instance's record already holds the object matrix. */
          ...(instancedStorage === undefined ? modelAndNormalOf(payload) : {}),
          eye: [camera.eye[0], camera.eye[1], camera.eye[2], 0],
          ambientColor: [ambient[0] ?? 1, ambient[1] ?? 1, ambient[2] ?? 1, ambientIntensity],
          baseColor: [...material.baseColor],
          specular: [...specularColor, shininess],
          material: [material.metallic, material.roughness, 0, 0],
          ...(material.custom === undefined
            ? {}
            : Object.fromEntries(
                material.custom.fields.map((field) => [materialParamUniformKey(field.name), material.custom?.uniforms[field.name] ?? 0]),
              )),
          grid: topology.kind === "grid" ? [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0] : [0, 0, 0, 0],
          ...blockLightUniforms,
          ...shadowSlotUniforms,
          ...(environmentResource === undefined || !envLit(model)
            ? {}
            : { environment: [environmentIntensity, 0, 0, 0] }),
          ...(projActive ? projectorUniforms : {}),
        },
        uniformBinding: "params",
        clear: false,
      };
      /* T1589b: the lit draw binds the light table, with the grid's three rows. The layers
         below spread `litPass` itself, so they bind neither. */
      passes.push(
        lightTable === undefined || model === "unlit"
          ? litPass
          : { ...litPass, buffers: [...(litPass.buffers ?? []), lightTable.buffer], uniforms: { ...litPass.uniforms, ...lightTable.uniforms } },
      );
      /* T1371b/T1380b: the same surface into each G-buffer layer — same material, same
         buffers, only the uniforms that generator declares (no lights, shadows, environment
         or projectors). T1411b: an additive surface is light, not a surface a screen-space
         pass should reflect or relight — it writes no G-buffer layer. */
      if (additive) return;
      for (const { layer, target } of gbufferTargets) {
        if (layer === "shadow") {
          /* T1414b: the matte runs the lit draw's own shadow test — the lights and their
             maps bound, nothing else (no environment, AO or projectors). */
          layerDraws.get(layer)?.push({
            ...litPass,
            id: `${nodeId}:gbuffer:shadow:${index}`,
            ...surface({
              ...surfaceMaterialOptions,
              lightCount: blockLights.length,
              gbuffer: "shadow",
              ...(blockShadows.length === 0 ? {} : { shadows: blockShadows, shadowSoftness, ...(pointSlots.length === 0 ? {} : { pointShadows: pointSlots }) }),
            }),
            target,
            textures: [
              ...(material.maps.albedo === undefined ? [] : [{ binding: "albedoMap", resourceId: material.maps.albedo, sampled: "unfiltered" as const }]),
              ...(material.maps.roughness === undefined ? [] : [{ binding: "roughnessMap", resourceId: material.maps.roughness, sampled: "unfiltered" as const }]),
              ...materialTextures,
              ...shadowTextures(),
            ],
            uniforms: Object.fromEntries(Object.entries(litPass.uniforms ?? {}).filter(([key]) => !/^(environment|projector)/.test(key))),
          });
          continue;
        }
        const lighting = /^(light\d|shadow\d|environment|projector)/;
        layerDraws.get(layer)?.push({
          ...litPass,
          id: layer === "normal" ? `${nodeId}:gbuffer:${index}` : `${nodeId}:gbuffer:${layer}:${index}`,
          ...surface({ ...surfaceMaterialOptions, lightCount: 0, gbuffer: layer }),
          target,
          ...(material.maps.albedo === undefined && material.maps.roughness === undefined && materialTextures.length === 0
            ? { textures: [] }
            : {
                textures: [
                  ...(material.maps.albedo === undefined ? [] : [{ binding: "albedoMap", resourceId: material.maps.albedo, sampled: "unfiltered" as const }]),
                  ...(material.maps.roughness === undefined ? [] : [{ binding: "roughnessMap", resourceId: material.maps.roughness, sampled: "unfiltered" as const }]),
                  ...materialTextures,
                ],
              }),
          uniforms: Object.fromEntries(Object.entries(litPass.uniforms ?? {}).filter(([key]) => !lighting.test(key))),
        });
      }
    };
    geometries.forEach((entry, index) => {
      /* T725: transmissive geometry draws in its own phase AFTER the opaques — it
         samples what they drew. Skipped here, emitted below the pyramid. */
      if (entry.payload.material.model === "glass") return;
      /* T1411b: additive surfaces draw LAST — see below the glass phase. */
      if (additiveSurface(entry.payload)) return;
      emitGeometry(entry, index);
    });

    /*
     * T725 — the TRANSMISSION phase: pyramid, then glass, strictly after the opaques.
     *
     * A transmissive surface SAMPLES what was already rendered behind it, so its draws
     * cannot ride the ordinary geometry loop — they need the finished opaque picture
     * first, blurred into a pyramid so roughness reads a coarser LEVEL rather than
     * blurring per fragment (the difference between frosted glass and a smeared
     * texel). Level 0 is a straight copy — a draw must never sample its own target —
     * and each further level halves the resolution through a separable binomial blur.
     * All of it exists only when a glass geometry is actually named: without one the
     * emitted plan is byte-identical (§V309).
     *
     * Glass depth-WRITES against the opaque depth, so a wall in front of the pane
     * still hides it; two overlapping glass bodies see the pyramid, not each other —
     * the reference's own limitation, stated rather than discovered.
     */
    const transmissive = geometries
      .map((entry, index) => ({ ...entry, index }))
      .filter(({ payload }) => payload.material.model === "glass");
    if (transmissive.length > 0) {
      const pyrTargetOf = (level: number): string => `scratch:${nodeId}:glassPyr${level}`;
      /* T939: under SSAA the scene surface is 2x, and the pyramid mirrors it level for
         level — the blit's textureLoad is 1:1 again and the glass fragment's normalized
         UVs never knew the difference. */
      const pyrScale = ssaa ? 2 : 1;
      scratch.push({ key: "glassPyr0", scale: pyrScale });
      passes.push({
        kind: "draw",
        id: `${nodeId}:glass:pyramid:0`,
        nodeId,
        shader: GLASS_BLIT_WGSL,
        target: pyrTargetOf(0),
        topology: "triangle-list",
        instances: 1,
        vertexCount: 6,
        textures: [{ binding: "sourceTex", resourceId: target, sampled: "unfiltered" }],
        clear: true,
      } as DrawPassDescriptor);
      for (let level = 1; level < GLASS_PYRAMID_LEVELS; level += 1) {
        const scale = pyrScale / 2 ** level;
        scratch.push({ key: `glassPyrH${level}`, scale });
        scratch.push({ key: `glassPyr${level}`, scale });
        passes.push({
          kind: "draw",
          id: `${nodeId}:glass:pyramid:${level}:h`,
          nodeId,
          shader: GLASS_DOWN_WGSL,
          target: `scratch:${nodeId}:glassPyrH${level}`,
          topology: "triangle-list",
          instances: 1,
          vertexCount: 6,
          textures: [{ binding: "sourceTex", resourceId: pyrTargetOf(level - 1), sampled: "unfiltered" }],
          clear: true,
        } as DrawPassDescriptor);
        passes.push({
          kind: "draw",
          id: `${nodeId}:glass:pyramid:${level}:v`,
          nodeId,
          shader: GLASS_VBLUR_WGSL,
          target: pyrTargetOf(level),
          topology: "triangle-list",
          instances: 1,
          vertexCount: 6,
          textures: [{ binding: "sourceTex", resourceId: `scratch:${nodeId}:glassPyrH${level}`, sampled: "unfiltered" }],
          clear: true,
        } as DrawPassDescriptor);
      }

      const glassTextures = [
        ...Array.from({ length: GLASS_PYRAMID_LEVELS }, (_, level) => ({
          binding: `pyr${level}`,
          resourceId: pyrTargetOf(level),
          sampled: "unfiltered" as const,
        })),
        ...(environmentResource === undefined
          ? []
          : [{ binding: "environmentMap", resourceId: environmentResource, sampled: "unfiltered" as const }]),
      ];
      const glassShaderOptions = environmentResource === undefined ? {} : { environment: true };

      for (const { payload, source, index } of transmissive) {
        const glass = payload.material.glass;
        if (glass === undefined) continue; // model "glass" always carries it; belt for the type
        const position = payload.pairs["position"];
        if (position === undefined) {
          diagnostics.push({
            severity: "error",
            code: "node.scene.geometry",
            message: `Node "${nodeId}": geometry "${source}" carries no position pair.`,
            nodeId,
          });
          continue;
        }
        if (payload.mode === "points" || payload.mode === "beam") {
          /* §V288: a billboard or a ribbon has no volume to refract through — glass on
             one would be a flat decal wearing a physical material's name. */
          diagnostics.push({
            severity: "error",
            code: "node.scene.glass",
            message: `Node "${nodeId}": geometry "${source}" wears glass in ${payload.mode} mode — transmission needs a body; surface and instances modes refract.`,
            nodeId,
          });
          continue;
        }
        const glassUniforms = {
          viewProjection: Array.from(viewProjectionMatrix),
          eye: [camera.eye[0], camera.eye[1], camera.eye[2], 0],
          glassA: [glass.ior, payload.material.roughness, glass.thickness, glass.dispersion],
          glassB: [glass.absorption[0], glass.absorption[1], glass.absorption[2], environmentIntensity],
          fallback: [background[0] ?? 0, background[1] ?? 0, background[2] ?? 0, 0],
        };
        if (payload.instanceMesh !== undefined) {
          /* T1581b: glass on mesh instances is its own row; a draw that fell through to the
             primitives' glass would refract a box nobody asked for (§V288). */
          diagnostics.push({
            severity: "error",
            code: "node.scene.glass",
            message: `Node "${nodeId}": geometry "${source}" wears glass as mesh instances, which is not built yet — glass refracts a Surface, or Quad, Box and Octahedron instances.`,
            nodeId,
            suggestion: "Give the mesh instances a lit material, or draw the glass body as a Surface.",
          });
          continue;
        }
        if (payload.mode === "instances") {
          let counted = countedByIndex.get(index);
          if (counted === undefined) {
            counted = countedDrawSupport(nodeId, payload, {
              vertexCount: 36,
              maxInstances: Math.max(1, payload.capacity),
              argsKey: `drawArgs${index}`,
            });
            if (counted !== undefined) {
              countedByIndex.set(index, counted);
              passes.push(counted.argsPass);
              scratch.push(counted.scratch);
            }
          }
          const instance = payload.instance ?? { shape: "box" as const, scale: 0.05 };
          passes.push({
            kind: "draw",
            id: `${nodeId}:glass:${index}`,
            nodeId,
            shader: text(() => glassInstancesWgsl(glassShaderOptions)),
            target,
            topology: "triangle-list",
            instances: counted?.instances ?? payload.capacity,
            vertexCount: 36,
            buffers: [attributeBinding("positions", position)],
            textures: glassTextures,
            uniforms: {
              ...glassUniforms,
              instance: [instance.scale, instanceShapeIndex(instance.shape), 0, 0],
            },
            uniformBinding: "params",
            clear: false,
          });
          continue;
        }
        const topology = typeof payload.topology === "string" ? parseTopology(payload.topology) : null;
        /* T1357b: an indexed mesh refracts through the lit mesh generator's vertex chunk —
           and needs its normal attribute for the same reason the lit mesh does. */
        if (topology !== null && topology.kind === "mesh") {
          const normal = payload.pairs["normal"];
          if (normal === undefined || normal.type !== "vec3f") {
            diagnostics.push({
              severity: "error",
              code: "node.scene.topology",
              message: `Node "${nodeId}": geometry "${source}" is a mesh without a vec3f \`normal\` attribute; glass refracts through the surface normal.`,
              nodeId,
              suggestion: "Keep the normal attribute through any kernel between the Mesh File In and the Geometry.",
            });
            continue;
          }
          passes.push({
            kind: "draw",
            id: `${nodeId}:glass:${index}`,
            nodeId,
            shader: text(() => glassMeshWgsl(glassShaderOptions)),
            target,
            topology: "triangle-list",
            instances: 1,
            vertexCount: topology.triangles * 3,
            buffers: [
              attributeBinding("positions", position),
              { binding: "meshIndices", resourceId: topology.indexBuffer },
              attributeBinding("meshNormals", normal),
            ],
            textures: glassTextures,
            uniforms: { ...glassUniforms, ...modelAndNormalOf(payload) },
            uniformBinding: "params",
            clear: false,
          });
          continue;
        }
        if (topology === null || topology.kind !== "grid") {
          diagnostics.push({
            severity: "error",
            code: "node.scene.topology",
            message: `Node "${nodeId}": geometry "${source}" carries neither an analytic grid nor a mesh topology; a surface cannot be built.`,
            nodeId,
          });
          continue;
        }
        if (gridPointCount(topology) > payload.capacity) {
          diagnostics.push({
            severity: "error",
            code: "node.scene.topology",
            message: `Node "${nodeId}": geometry "${source}" claims ${gridPointCount(topology)} grid points but carries ${payload.capacity}.`,
            nodeId,
          });
          continue;
        }
        passes.push({
          kind: "draw",
          id: `${nodeId}:glass:${index}`,
          nodeId,
          // T1587b: several sheets, as the lit grid draws them.
          shader: text(() => glassSurfaceWgsl(gridSheets(topology) > 1 ? { ...glassShaderOptions, sheets: true } : glassShaderOptions)),
          target,
          topology: "triangle-list",
          instances: 1,
          vertexCount: gridVertexCount(topology),
          buffers: [attributeBinding("positions", position)],
          textures: glassTextures,
          uniforms: {
            ...glassUniforms,
            ...modelAndNormalOf(payload),
            grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
          },
          uniformBinding: "params",
          clear: false,
        });
      }
    }

    /*
     * T1411b — the ADDITIVE phase, last: a surface drawn with Blend: Additive is light laid
     * over the finished picture (a lamp cover's sheen and glints), so it follows every
     * opaque AND the glass — a glass pane and an additive shell on the same mesh then read
     * pane + shell, the shell passing the pane's own depth (less-equal). It writes no depth
     * and no G-buffer, so it hides nothing drawn after it and every screen-space pass sees
     * what it glows over.
     */
    geometries.forEach((entry, index) => {
      if (entry.payload.material.model === "glass" || !additiveSurface(entry.payload)) return;
      emitGeometry(entry, index);
    });

    /* T1604b: the layers, each whole (see `layerDraws`). After the additive phase, so that
       with no glass in the scene the backdrop, the opaque draws and the additive ones are
       ONE run into the colour, with nothing of another target between them. */
    for (const draws of layerDraws.values()) passes.push(...draws);

    if (ssaa) {
      /* T939 — the resolve: the LAST pass, averaging each 2x2 supersampled block into
         the real output. Everything upstream (backdrop, groups, glass pyramid) already
         rendered into the 2x surface through `target`. */
      passes.push({
        kind: "draw",
        id: `${nodeId}:ssaa:resolve`,
        nodeId,
        shader: SSAA_RESOLVE_WGSL,
        target: outTarget,
        topology: "triangle-list",
        instances: 1,
        vertexCount: 6,
        textures: [{ binding: "sourceTex", resourceId: target, sampled: "unfiltered" }],
        clear: true,
      } as DrawPassDescriptor);
    }

    const ledger = mode === "full" ? textureLedger(nodeId, passes, materialTextureNames) : undefined;
    if (ledger !== undefined) diagnostics.push(ledger);

    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { passes: [], diagnostics };
    }
    return {
      passes,
      ...(scratch.length === 0 ? {} : { scratch }),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
      ...(mode === "full" ? { values: renderValues } : {}),
    };
  },
};

/**
 * T1719b S3 — THE RENDER'S VALUES AT ANOTHER FRAME.
 *
 * The Render is one long description of its passes, with every uniform computed where the
 * pass is built. So its value function IS that description, run again in `"values"` mode:
 * the same code computes the same numbers from this frame's context (V1032 by construction),
 * and leaves the shader text unbuilt (`text`, `surface`), which is where its emission cost
 * was. Each pass's id comes back with its values, so passes that came out in another order
 * degrade the frame by name instead of landing on the wrong pass.
 */
type RenderMode = "full" | "values";
const VALUES_ONLY_TEXT = "" as EmittedWgsl;
const renderValues: NodeValueFunction = (context) => {
  const compile = renderNode.compile as (context: NodeCompileContext, mode: RenderMode) => CompiledNodeDescription;
  return { passes: compile(context, "values").passes.map((pass) => passFrameValues(pass as DrawPassDescriptor | DispatchPassDescriptor | BufferWritePassDescriptor)) };
};

function passFrameValues(pass: DrawPassDescriptor | DispatchPassDescriptor | BufferWritePassDescriptor): PassFrameValues {
  if (pass.kind === "write") return { id: pass.id, values: pass.values };
  if (pass.kind === "dispatch") return pass.uniforms === undefined ? { id: pass.id } : { id: pass.id, uniforms: pass.uniforms };
  return {
    id: pass.id,
    ...(pass.uniforms === undefined ? {} : { uniforms: pass.uniforms }),
    skip: pass.skip === true,
    ...(typeof pass.instances === "number" ? { instances: pass.instances } : {}),
    ...(pass.vertexCount === undefined ? {} : { vertexCount: pass.vertexCount }),
  };
}

/**
 * T428 — the MATERIAL family. Each material is a THING geometries reference by name;
 * its MAP slots are ordinary texture INPUT wires (V372: pixels are data), which is the
 * T444 load-bearing wire — a render's output texture feeds a material's albedo by a
 * plain edge, and the virtual screen exists.
 *
 * Normal maps are DEFERRED WITH NO INERT PORT (V368): surfaces get analytic normals,
 * instances need tangent frames, and a port that binds nothing teaches nothing.
 */
/**
 * T1284/T1289 — the models that carry an environment, and why this is a NAMED predicate.
 *
 * These five sites decide whether the env map and its intensity are BOUND; the generator
 * in `scene-render.wgsl.ts` decides whether the shader DECLARES them. The two have to say
 * the same thing, and until T1284 both spelled it `=== "phong"` independently in six
 * places. Giving `pbr` its own model moved the generator's copy and not these, which would
 * have declared a texture nothing bound — the §V288-by-omission this row's predecessor
 * caught on the shader side and missed here. One name per file now, on both sides.
 */
const envLit = (model: string): boolean => model === "phong" || model === "pbr";

/**
 * T1618b — DOES A MATERIAL · WGSL READ THE TEXTURE COORDINATE? Its source is the author's,
 * and a read of the member has to spell it: `s.uv`, or `.uv` on a copy of the struct handed
 * to a helper. So the member's name after a dot is the whole test, the way a kernel's
 * `ctx.dim` is found (`points/codegen.ts`). A match in a comment costs one binding; a read
 * cannot be missed. The stock materials read it exactly where a map is wired.
 */
const SURFACE_UV_REFERENCE = /\.\s*uv\b/;

/**
 * T1411b — a SURFACE (grid or mesh) drawn with Blend: Additive. One predicate for the
 * three places that must agree: the lit loop defers it, the lit pass blends it, and every
 * depth sweep (shadow, AO, projector, the Depth output) leaves it out. The per-point
 * modes keep T917's own additive rules; glass has its own phase.
 */
const additiveSurface = (payload: GeometryPayload): boolean =>
  (payload.mode === "surface" || payload.instanceMesh !== undefined) && additiveLight(payload);

/** T1623b slice 4: a shadow layer's size as a share of the Render's output: a directional map, a point light's cube atlas. */
const SHADOW_MAP_SCALE = 2;
const SHADOW_CUBE_SCALE = 1.5;
/**
 * T1623b slice 4 — HOW MANY LAYERS AN ARRAY IS GIVEN for `count` casting lights of its kind:
 * 1, 2, 4, 8, then eights. The layer count is the array's structure (another count is
 * another texture), so turning Cast Shadows on for one more light rebuilds the array only
 * when a step is passed, and a spare layer costs its bytes and nothing else: no sweep
 * draws into it and no block reads it. With its one depth buffer an array of a step is never
 * more memory than the lights' own targets were (each had a depth buffer of its own): at
 * 1920 x 1080 a directional map is 31.6 MiB and a cube atlas 17.8 MiB, so five casting suns
 * are nine times 31.6 where they were ten times.
 *
 * What bounds a Render's casting lights is what bounded them: the sixteen sampled textures
 * a stage may bind, a texture a casting light (the compiler's binding budget).
 */
export const shadowLayerStep = (count: number): number => (count <= 0 ? 0 : count <= 8 ? 2 ** Math.ceil(Math.log2(count)) : Math.ceil(count / 8) * 8);
/**
 * T1623b slice 4 — WHICH LAYER A SHADOW SLOT IS: its place among the slots of its own kind,
 * in slot order (the directional lights' maps are one layered target, the point lights' cube
 * atlases another). The ONE answer: a light's sweep draws into it and its block's texture is
 * a view of it.
 */
export function shadowLayers(slots: number, pointSlots: Iterable<number> = []): { readonly layerOf: ReadonlyArray<number>; readonly directional: number; readonly point: number } {
  const points = new Set(pointSlots);
  let directional = 0;
  let point = 0;
  const layerOf = Array.from({ length: Math.max(0, slots) }, (_, slot) => (points.has(slot) ? point++ : directional++));
  return { layerOf, directional, point };
}

/**
 * T1623b: a geometry the SURFACE generator draws with a lit model: a Surface or mesh
 * instances, in a material that takes light. Glass has its own phase and generators, which
 * take none. Such a draw walks the Render's light table, so a Render with one has a table.
 */
const litSurfaceDraw = (payload: GeometryPayload): boolean =>
  (payload.mode === "surface" || payload.instanceMesh !== undefined) && payload.material.model !== "glass" && payload.material.model !== "unlit";

/**
 * B256 — geometry of ANY mode drawn with Blend: Additive: light laid over the picture, not
 * a body. One predicate for every depth sweep, so a new mode cannot be a body by omission.
 * Glass keeps its own path (it refracts what is behind it, and its Blend is not read).
 */
function additiveLight(payload: GeometryPayload): boolean {
  return payload.blend === "additive" && payload.material.model !== "glass";
}

function materialCompile(model: MaterialPayload["model"]) {
  return (context: Parameters<NodeDefinition["compile"]>[0]): CompiledNodeDescription => {
    const { parameters, inputs } = readCompileInputs(context);
    const base = readColor(parameters, "color", [0.8, 0.8, 0.8, 1]);
    const specular = readColor(parameters, "specular", [1, 1, 1, 1]);
    const albedoMap = inputs["albedo"]?.resource;
    const roughnessMap = inputs["roughness"]?.resource;
    const extendU = readMapExtend(parameters["mapExtendU"]);
    const extendV = readMapExtend(parameters["mapExtendV"]);
    const payload: MaterialPayload = {
      kind: "material",
      model,
      baseColor: [base[0] ?? 0.8, base[1] ?? 0.8, base[2] ?? 0.8, base[3] ?? 1],
      specularColor: [specular[0] ?? 1, specular[1] ?? 1, specular[2] ?? 1],
      shininess: readNumber(parameters, "shininess", 32),
      metallic: readNumber(parameters, "metallic", 0),
      roughness: readNumber(parameters, "roughness", 0.5),
      maps: {
        ...(albedoMap === undefined ? {} : { albedo: albedoMap }),
        ...(roughnessMap === undefined ? {} : { roughness: roughnessMap }),
      },
      // T1618b: said only when an axis tiles, so a material that holds is the payload it was.
      ...(extendU === "hold" && extendV === "hold" ? {} : { mapExtend: { u: extendU, v: extendV } }),
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  };
}

const readMapExtend = (value: unknown): MapExtend => (value === "repeat" || value === "mirror" ? value : "hold");

/**
 * T1618b — MAP EXTEND: what a map reads where the texture coordinate leaves 0 to 1, an axis
 * at a time (TouchDesigner's Extend U and V on a MAT's maps, Notch's Texture Wrap Mode U and
 * V on a material). Structural: it picks the text of the map read. Hold is the text a map
 * always had, so no material that shipped reads its maps any differently.
 */
const mapExtendParameter = (label: string, axis: string, tiled: string): ParameterSchema[string] => ({
  type: "enum",
  label,
  default: "hold",
  compileTime: true,
  // §V831: APPEND only — a stored value whose row moved resolves to the default.
  options: [
    { value: "hold", label: "Hold" },
    { value: "repeat", label: "Repeat" },
    { value: "mirror", label: "Mirror" },
  ],
  description: `How the maps are read where the texture coordinate ${axis} leaves 0 to 1. Hold: the map's edge carries on. Repeat: the map tiles, ${tiled}. Mirror: it tiles with every other tile turned round, so no tile shows a seam. On an open edge under MSAA a tiled axis shows a hairline of the map's far edge (the pixel's centre is past the surface there): keep Hold on an axis that does not tile.`,
});
const MAP_EXTEND_PARAMETERS: ParameterSchema = {
  mapExtendU: mapExtendParameter("Map Extend U", "across (u: a grid's columns, the way round a Sweep's profile)", "once for each whole number the coordinate passes"),
  mapExtendV: mapExtendParameter("Map Extend V", "along (v: a grid's rows, the way along a Sweep's path)", "which is what a Sweep with UV Along: Metres wants: a tile every Tile Length"),
};

const MATERIAL_OUT = { id: "out", label: "Out", type: { kind: "material", model: "custom" } as const };
const ALBEDO_IN = {
  id: "albedo",
  label: "Albedo Map",
  optional: true,
  type: RGBA_TEXTURE,
  description:
    "Multiplies the base colour, read at the surface's texture coordinate: a vec2f attribute named uv on its points where they carry one (a Sweep writes one, a mesh file brings its own), else a grid's own, 0 to 1 across its columns and along its rows, once round a wrapped axis. A render output plugs in here (E25).",
};
const ROUGHNESS_IN = {
  id: "roughness",
  label: "Roughness Map",
  optional: true,
  type: RGBA_TEXTURE,
  description: "Red channel multiplies roughness, read at the same texture coordinate as the Albedo Map: the points' uv attribute, else the grid's own.",
};

export const materialUnlitNode: NodeDefinition = {
  type: "materialUnlit",
  version: 1,
  title: "Material · Unlit",
  category: "render",
  description: "A constant-colour material — no lights, no shading. Geometries reference it by name; the albedo map input tints per-texel.",
  tags: ["3d", "material", "unlit", "scene"],
  inputs: [ALBEDO_IN],
  outputs: [MATERIAL_OUT],
  parameters: {
    color: { type: "color", label: "Color", default: [0.8, 0.8, 0.8, 1], space: "display" },
    ...MAP_EXTEND_PARAMETERS,
  },
  compile: materialCompile("unlit"),
};

export const materialPhongNode: NodeDefinition = {
  type: "materialPhong",
  version: 1,
  title: "Material · Phong",
  category: "render",
  description:
    "Blinn-Phong: diffuse colour, specular colour and shininess, with albedo and roughness map inputs (roughness dulls the highlight). Geometries reference it by name.",
  tags: ["3d", "material", "phong", "specular", "scene"],
  inputs: [ALBEDO_IN, ROUGHNESS_IN],
  outputs: [MATERIAL_OUT],
  parameters: {
    color: { type: "color", label: "Diffuse", default: [0.8, 0.8, 0.8, 1], space: "display" },
    specular: { type: "color", label: "Specular", default: [1, 1, 1, 1], space: "display" },
    shininess: { type: "number", label: "Shininess", default: 48, min: 2, max: 512, range: "floor" },
    roughness: { type: "number", label: "Roughness", default: 0.35, min: 0, max: 1, range: "bounded" },
    ...MAP_EXTEND_PARAMETERS,
  },
  compile: materialCompile("phong"),
};

export const materialPbrNode: NodeDefinition = {
  type: "materialPbr",
  version: 1,
  title: "Material · PBR",
  category: "render",
  description:
    "Metallic-roughness material with albedo and roughness map inputs. Shaded with a real microfacet BRDF (T1284): GGX distribution, height-correlated Smith visibility, Schlick Fresnel per light, and a diffuse half scaled by (1 - F)(1 - metallic), so a metal has no diffuse lobe and roughness widens the highlight rather than moving an exponent. Environment reflections land with the environment input — and at high roughness they BLUR through a cone whose width follows the GGX lobe's own alpha (T1289), not merely dim. The PREVIEW TILE shades with this same BRDF (T1292 — it used to stand in Blinn-Phong, so the tile and the render disagreed about the same node); its stock rig has an ambient floor and two lights and no environment, so a wired environment's reflections appear in the render and never in the tile.",
  tags: ["3d", "material", "pbr", "metallic", "roughness", "scene"],
  inputs: [ALBEDO_IN, ROUGHNESS_IN],
  outputs: [MATERIAL_OUT],
  parameters: {
    color: { type: "color", label: "Base Color", default: [0.8, 0.8, 0.8, 1], space: "display" },
    metallic: { type: "number", label: "Metallic", default: 0, min: 0, max: 1, range: "bounded" },
    roughness: { type: "number", label: "Roughness", default: 0.5, min: 0, max: 1, range: "bounded" },
    ...MAP_EXTEND_PARAMETERS,
  },
  compile: materialCompile("pbr"),
};

/**
 * T725 — GLASS: screen-space transmission, vgpu's own transmission example brought
 * into the catalogue (the owner supplied the reference; the shaders were read, not
 * imagined). A geometry wearing this draws AFTER the opaques and SAMPLES the picture
 * already rendered behind it through a Gaussian blur pyramid: Snell refraction bends
 * the sample point, roughness picks the pyramid level (frosted glass is a coarser
 * read, not a per-fragment blur), dispersion splits the refraction per wavelength,
 * Beer-Lambert absorbs along the path, and a Schlick Fresnel mixes toward the
 * environment reflection at grazing angles.
 *
 * §V644 satisfied structurally: the transmitted term is SAMPLED light — there is no
 * baseColor parameter at all; the only colour here is absorption, which can only
 * remove. §V617's question answered: glass is a THIRD thing — not lit (its light is
 * the sampled scene + Fresnel environment), not unlit (nothing interacts with light
 * more) — and it casts no shadow: light passes through glass, and the dark stamp an
 * opaque caster leaves would be a lie (a caustic is a different feature).
 */
export const materialGlassNode: NodeDefinition = {
  type: "materialGlass",
  version: 1,
  title: "Material · Glass",
  category: "render",
  description:
    "Screen-space transmission: the surface refracts what the render already drew behind it, through a blur pyramid so roughness reads as frost. IOR bends, Dispersion splits colours, Absorption tints by removal (Beer-Lambert over Thickness), and a Fresnel-weighted environment reflection takes over at grazing angles. Draws after the opaques, on grid, mesh (T1357b) and instance geometry; casts no shadow (light passes through). The node preview shows a phong stand-in — there is no scene behind a preview ball to refract.",
  tags: ["3d", "material", "glass", "transmission", "refraction", "dispersion", "scene"],
  inputs: [],
  outputs: [MATERIAL_OUT],
  parameters: {
    ior: {
      type: "number",
      label: "IOR",
      default: 1.5,
      min: 1,
      max: 2.4,
      step: 0.01,
      range: "bounded",
      description: "Index of refraction — 1 is optically inert, 1.5 is glass, 2.4 is diamond.",
    },
    roughness: {
      type: "number",
      label: "Roughness",
      default: 0.06,
      min: 0,
      max: 1,
      step: 0.01,
      range: "bounded",
      description: "0 is polished, 1 is fully frosted — reads a coarser level of the scene pyramid.",
    },
    thickness: {
      type: "number",
      label: "Thickness",
      default: 0.85,
      min: 0.01,
      max: 10,
      step: 0.01,
      range: "floor",
      description: "World-units path length assumed inside the body — how far the refracted ray travels before it leaves.",
    },
    absorption: {
      type: "color",
      label: "Absorption",
      default: [0.3, 0.1, 0.16, 1],
      space: "display",
      description: "Beer-Lambert absorption per unit path — the glass's colour, by REMOVAL: high red absorption makes cyan glass.",
    },
    dispersion: {
      type: "number",
      label: "Dispersion",
      default: 0,
      min: 0,
      max: 0.3,
      step: 0.005,
      range: "floor",
      description: "Spectral IOR spread across the visible band. 0 is off; ~0.09 is the reference's chromatic fringe.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { parameters } = readCompileInputs(context);
    const absorption = readColor(parameters, "absorption", [0.3, 0.1, 0.16, 1]);
    const payload: MaterialPayload = {
      kind: "material",
      model: "glass",
      // The lit-path fields sit at DEFAULT_MATERIAL-adjacent values so every consumer
      // that reads them before switching on `model` stays well-defined; none of them
      // reach the glass shader.
      baseColor: [0.8, 0.8, 0.8, 1],
      specularColor: [1, 1, 1],
      shininess: 96,
      metallic: 0,
      roughness: readNumber(parameters, "roughness", 0.06),
      maps: {},
      glass: {
        ior: readNumber(parameters, "ior", 1.5),
        thickness: readNumber(parameters, "thickness", 0.85),
        absorption: [absorption[0] ?? 0.3, absorption[1] ?? 0.1, absorption[2] ?? 0.16],
        dispersion: readNumber(parameters, "dispersion", 0),
      },
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  },
};

export const sceneNodeDefinitions: readonly NodeDefinition[] = [
  cameraNode,
  lightNode,
  projectorNode,
  geometryNode,
  renderNode,
  materialUnlitNode,
  materialPhongNode,
  materialPbrNode,
  materialGlassNode,
];
