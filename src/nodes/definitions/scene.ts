import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { instanceShapeIndex, parseInstanceShape } from "./render-instances.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import type { CameraPayload, GeometryPayload, LightPayload, MaterialPayload, ProjectorPayload, ScenePairRef, ScenePayload } from "../../domain/types/scene.ts";
import { resolveGroupPredicate } from "./points.ts";
import { DEFAULT_MATERIAL } from "../../domain/types/scene.ts";
import { cameraPayloadMatrix, directionalShadowMatrix, lookAt, projectorMatrix } from "../../domain/geometry/camera.ts";
import { gridCellCounts, gridPointCount, parseTopology } from "../../points/topology.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { DANGLING_CAMERA_SUGGESTION, danglingCameraRefusal } from "./camera-reference.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import { countedDrawSupport, resolveColorMap, resolveScalarMap } from "./points.ts";
import { attributeBinding } from "./point-storage.ts";
import {
  GLASS_BLIT_WGSL,
  SSAA_RESOLVE_WGSL,
  GLASS_DOWN_WGSL,
  GLASS_PYRAMID_LEVELS,
  GLASS_VBLUR_WGSL,
  SHADOW_CLEAR_WGSL,
  backdropWgsl,
  glassInstancesWgsl,
  glassSurfaceWgsl,
  sceneInstancesWgsl,
  sceneSurfaceWgsl,
  shadowInstancesWgsl,
  shadowSurfaceWgsl,
} from "../shaders/scene-render.wgsl.ts";
import { aoBlurWgsl, aoResolveWgsl, aoSampleCount } from "../shaders/scene-ao.wgsl.ts";

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

/** T377 — the camera as a THING: shareable, drivable, referenced by name. */
export const cameraNode: NodeDefinition = {
  type: "camera",
  version: 1,
  title: "Camera",
  category: "render",
  description:
    "A camera other nodes reference by NAME: Render, Render Surface and Render Instances all name it in their camera parameter, so one camera frames them together. Every parameter is drivable — an orbiting camera is a uniform write, never a rebuild. Its preview shows WHAT THE RENDERER SEES: with exactly one renderer naming this camera, the preview is that renderer's own picture; with none, a stock reference scene showing framing alone; with several, the stock scene again, because there is no single answer and picking one would be a viewpoint nobody chose.",
  tags: ["3d", "scene", "camera", "view"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "camera" } }],
  parameters: {
    eye: { type: "vector", size: 3, label: "Eye", default: [0, 0.5, 3] },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0] },
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
        "Bank around the view axis. Aim stays Look At's job — eye, Look At and Roll together are the full orientation (T706), so drive this to tilt the horizon without moving the shot. The preview gizmo (T692) leaves Roll alone on purpose: banking is a framing decision you set and hold, not a navigation gesture, so it stays a number here rather than a drag.",
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
    const { parameters } = readCompileInputs(context);
    const payload: CameraPayload = {
      kind: "camera",
      eye: vec3(parameters, "eye", [0, 0.5, 3]),
      lookAt: vec3(parameters, "lookAt", [0, 0, 0]),
      fovDeg: readNumber(parameters, "fov", 55),
      near: readNumber(parameters, "near", 0.1),
      far: readNumber(parameters, "far", 100),
      ortho: parameters["ortho"] === true,
      orthoHeight: readNumber(parameters, "orthoHeight", 2),
      roll: readNumber(parameters, "roll", 0),
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  },
};

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
      description: "Bank around the throw axis — a projector mounted sideways is a rolled projector.",
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

/** T377 — a light: directional or point, colour and intensity, all drivable. */
export const lightNode: NodeDefinition = {
  type: "light",
  version: 1,
  title: "Light",
  category: "render",
  description:
    "A light other nodes reference by NAME — a Render lists any number in its lights parameter (list order is light order). Directional lights travel along Direction; point lights sit at Position with distance falloff. Colour, intensity and placement are all drivable.",
  tags: ["3d", "scene", "light", "shading"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "light" } }],
  parameters: {
    kind: {
      type: "enum",
      label: "Type",
      default: "directional",
      options: [
        { value: "directional", label: "Directional" },
        { value: "point", label: "Point" },
      ],
    },
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    intensity: { type: "number", label: "Intensity", default: 1, min: 0, range: "floor" },
    direction: {
      type: "vector",
      size: 3,
      label: "Direction",
      default: [-0.4, -0.8, -0.45],
      inactiveWhen: (values) => (values["kind"] === "point" ? "A point light shines everywhere." : null),
    },
    position: {
      type: "vector",
      size: 3,
      label: "Position",
      default: [1, 2, 1.5],
      inactiveWhen: (values) => (values["kind"] === "directional" ? "A directional light is infinitely far." : null),
    },
    shadows: {
      type: "boolean",
      label: "Cast Shadows",
      default: false,
      compileTime: true,
      description:
        "T481: this light casts — ADDS ONE FULL SCENE PASS per render that lists it. Directional only in this build; the pass is named per light in the performance panel so its cost is visible.",
    },
    shadowExtent: {
      type: "number",
      label: "Shadow Extent",
      default: 8,
      min: 0.1,
      range: "floor",
      description:
        "World-units half-extent of the shadow volume around the origin. Explicit on purpose: nothing knows your scene's bounds, and a guessed box would crop shadows plausibly-wrong (V426).",
      inactiveWhen: (values) => (values["shadows"] === true ? null : "Only a casting light frames a shadow volume."),
    },
  },
  compile(context): CompiledNodeDescription {
    const { parameters } = readCompileInputs(context);
    const color = readColor(parameters, "color", [1, 1, 1, 1]);
    const payload: LightPayload = {
      kind: "light",
      light: {
        type: parameters["kind"] === "point" ? "point" : "directional",
        color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1],
        intensity: readNumber(parameters, "intensity", 1),
        direction: vec3(parameters, "direction", [-0.4, -0.8, -0.45]),
        position: vec3(parameters, "position", [1, 2, 1.5]),
        shadows: parameters["shadows"] === true,
        shadowExtent: readNumber(parameters, "shadowExtent", 8),
      },
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  },
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
  description:
    "Binds a point set and a material into one nameable renderable object — a Render lists geometries by name. Tint multiplies the material's base colour per object (1,1,1,1 = inherit, visibly).",
  tags: ["3d", "scene", "geometry", "material", "surface"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Surface mode needs analytic grid topology on the edge.",
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
  parameters: {
    material: {
      type: "string",
      label: "Material",
      default: "",
      description: "Name of a material node. Empty = the default lambert material.",
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
        "Additive adds this geometry's colour onto what is already drawn — light on light — and stops writing depth so overlapping light sums instead of occluding.",
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
      ],
      inactiveWhen: (values) => (values["mode"] === "instances" ? null : "Only instances wear a primitive."),
    },
    scale: {
      type: "number",
      label: "Scale",
      default: 0.05,
      min: 0,
      range: "floor",
      inactiveWhen: (values) =>
        values["mode"] === "instances" || values["mode"] === "points" || values["mode"] === "beam"
          ? null
          : "Scale sizes instances and point billboards; a surface spans its grid.",
      description:
        "Instances: the primitive's size. Points: the billboard's. Beam: its HALF-WIDTH — a beam takes its length from the data, so this is the only dimension left to set. In Map mode an f32 attribute (or one channel of a float vector) MULTIPLIES this per point, so the number here stays the object's size and the attribute is a factor — size by depth for a circle of confusion, by age, by confidence.",
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
    group: {
      type: "string",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T642/T333: draw only matching points — a WGSL predicate over p.<attribute>, e.g. p.hit > 0.5. Instances, Points and Beam modes; referenced attributes bind on demand from the edge. Empty = all.",
    },
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
    const MAPPABLE = new Set(["tint", "scale", "orient"]);
    const unhonoured = Object.keys(parameterMaps).filter((key) => !MAPPABLE.has(key)).sort();
    if (unhonoured.length > 0) {
      return {
        passes: [],
        diagnostics: unhonoured.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} is in map mode, but geometry maps only "tint", "scale" and "orient".`,
          nodeId,
          suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
        })),
      };
    }
    // T478: tint in MAP mode — a vec4f attribute drives the multiplier per point.
    const resolvedTint = resolveColorMap(nodeId, parameterMaps["tint"], pointset, "points", "tint");
    if ("refusal" in resolvedTint) return resolvedTint.refusal;
    const tintMap = resolvedTint.map;

    const base: MaterialPayload = materialBinding ?? DEFAULT_MATERIAL;
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
            suggestion: "Switch the mode to instances, points or beam, or set Scale back to Constant.",
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
    const shapeParameter = parameters["shape"];
    const payload: GeometryPayload = {
      kind: "geometry",
      pairs: pointset.pairs,
      capacity: pointset.capacity,
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
      ...(endpointPair === undefined ? {} : { endpoint: endpointPair }),
      ...(tintMap === undefined ? {} : { colorAttribute: { ...tintMap, type: "vec4f" } }),
      ...(scaleMap === undefined || !perPoint ? {} : { scaleAttribute: scaleMap }),
      /* T723: instances only — the refusal above has already turned away every other
         mode, so reaching here with a map means the frame is genuinely free to turn. */
      ...(orientMap === undefined || mode !== "instances"
        ? {}
        : { orientAttribute: orientMap }),
      ...(resolvedGroup === undefined ? {} : { group: resolvedGroup }),
      ...(pointset.count === undefined ? {} : { count: { buffer: pointset.count.buffer } }),
      material,
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  },
};

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
  ],
  depthOutputs: ["out", "depth"],
  /* T939: MSAA is structural (a different render signature), so it is declared like
     depth — and the backend's patched vgpu keeps samples across the multi-pass chain. */
  msaaWhen: { out: (parameters) => parameters["antialias"] === "msaa" },
  outputWhen: { depth: (parameters) => parameters["depthOutput"] === true },
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
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters, resolution } = readCompileInputs(context);
    const outTarget = outputs["out"];
    if (outTarget === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
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
    for (const binding of sceneOf("lights")) {
      if (binding.scene?.kind !== "light") {
        return refuse(
          "node.scene.reference",
          `lights names "${binding.source?.nodeId ?? "?"}", which publishes no light.`,
          "Lights must name light nodes.",
        );
      }
      lights.push(binding.scene.light);
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
    const castingPoint = casting.find(({ light }) => light.type === "point");
    if (castingPoint !== undefined) {
      return refuse(
        "node.scene.shadow",
        `light ${castingPoint.index + 1} is a POINT light with Cast Shadows on — directional lights cast in this build (a point caster needs six faces).`,
        "Switch the light to Directional, or turn its Cast Shadows off.",
      );
    }
    const shadowMatrices = casting.map(({ light }) =>
      directionalShadowMatrix(light.direction, Math.max(0.1, light.shadowExtent), aspect),
    );
    const shadowTargetOf = (slot: number): string => `scratch:${nodeId}:shadow${casting[slot]?.index ?? slot}`;
    const castingIndices = casting.map(({ index }) => index);

    /* T482: the environment, wired or absent — presence is structural (a shader
       variant, like maps); intensity is a value. */
    const environmentInput = (context as { inputs?: Record<string, ReadonlyArray<{ resourceId?: string }>> })
      .inputs?.["environment"]?.[0];
    const environmentResource =
      typeof environmentInput?.resourceId === "string" ? environmentInput.resourceId : undefined;
    const environmentIntensity = readNumber(parameters, "environmentIntensity", 1);

    const ambient = readColor(parameters, "ambientColor", [1, 1, 1, 1]);
    const ambientIntensity = readNumber(parameters, "ambientIntensity", 0.12);

    const diagnostics: NonNullable<CompiledNodeDescription["diagnostics"]> = [];
    const background = readColor(parameters, "background", [0, 0, 0, 1]);
    const passes: Array<DrawPassDescriptor | DispatchPassDescriptor> = [];
    /** T478: one indirect-args scratch buffer per COUNTED geometry. */
    const scratch: Array<
      | NonNullable<ReturnType<typeof countedDrawSupport>>["scratch"]
      | { key: string; scale: number; format: "r32float"; depth?: true }
      // T725: the glass pyramid levels — the node's own working format, no depth.
      | { key: string; scale: number }
      // T939: the SSAA surface — 2x, with depth (it IS the scene target while on).
      | { key: string; scale: number; depth: true }
    > = [];
    if (ssaa) scratch.push({ key: "ss", scale: 2, depth: true });
    /** T481: counted draw support emitted once (in the shadow phase when one exists),
     *  shared by the shadow and the lit draw of the same geometry. */
    const countedByIndex = new Map<number, NonNullable<ReturnType<typeof countedDrawSupport>>>();

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
      readonly matrix: Float32Array | undefined;
      readonly linearDepth: boolean;
      /** T704: store fragment-z (z ÷ w) — a projector's frustum is perspective. */
      readonly perspective?: boolean;
      readonly extraUniforms: Readonly<Record<string, ReadonlyArray<number>>>;
    }): void => {
      // The far plate: depth 1.0 everywhere first, the backdrop pattern (T444) —
      // a cleared map must read "nothing here" and the clear colour is not ours.
      passes.push({
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
      geometries.forEach(({ payload }, geometryIndex) => {
        const position = payload.pairs["position"];
        if (position === undefined) return; // the lit loop refuses this by name
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
        if (payload.mode === "points" || payload.mode === "beam") return;
        /* T725: GLASS casts no shadow — light passes through it, so the opaque stamp a
           caster leaves would be a lie (a caustic is a different feature, stated on the
           material). Same argument family as the billboard and the beam above; reaches
           the AO sweep too, deliberately — glass does not enclose its neighbourhood. */
        if (payload.material.model === "glass") return;
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
         * cannot stop it.
         */
        if (payload.material.model === "unlit") return;
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
            shader: shadowInstancesWgsl({
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
            }),
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
            },
            uniformBinding: "params",
            clear: false,
          });
          return;
        }
        const topology = typeof payload.topology === "string" ? parseTopology(payload.topology) : null;
        if (topology === null || topology.kind !== "grid") return; // lit loop refuses
        if (gridPointCount(topology) > payload.capacity) return;
        const { cellsU, cellsV } = gridCellCounts(topology);
        passes.push({
          kind: "draw",
          id: `${nodeId}:${options.prefix}:${geometryIndex}`,
          nodeId,
          shader: shadowSurfaceWgsl(depthOptions),
          target: options.target,
          topology: "triangle-list",
          instances: 1,
          vertexCount: cellsU * cellsV * 6,
          buffers: [attributeBinding("positions", position)],
          uniforms: {
            lightViewProjection: Array.from(options.matrix ?? []),
            grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
            ...options.extraUniforms,
          },
          uniformBinding: "params",
          clear: false,
        });
      });
    };

    /* T481: the shadow phase — every map is rendered BEFORE the lit draws that read it.
       Zero casting lights emits nothing here and nothing below changes: §V309 holds as
       byte-identical passes and shaders. */
    const emitShadowPasses = (): void => {
      casting.forEach(({ index: lightIndex }, slot) => {
        scratch.push({ key: `shadow${lightIndex}`, scale: 2, format: "r32float", depth: true });
        emitDepthSweep({
          prefix: `shadow:${lightIndex}`,
          target: shadowTargetOf(slot),
          matrix: shadowMatrices[slot],
          linearDepth: false,
          extraUniforms: {},
        });
      });
    };
    emitShadowPasses();

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
          [`projector${index}Meta`, [nominal, 0, 0, 0]],
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
        target: aoDepthTarget,
        matrix: viewProjectionMatrix,
        linearDepth: true,
        extraUniforms: { depthRow, depthRange: [far, 0, 0, 0] },
      });

      passes.push({
        kind: "draw",
        id: `${nodeId}:ao:resolve`,
        nodeId,
        shader: aoResolveWgsl(aoSampleCount(String(parameters["aoQuality"] ?? "medium"))),
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
        shader: aoBlurWgsl(AO_BLUR_RADIUS),
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
      shader: backdropWgsl(drawEnvironment ? { environment: true } : {}),
      target,
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

    geometries.forEach(({ payload, source }, index) => {
      /* T725: transmissive geometry draws in its own phase AFTER the opaques — it
         samples what they drew. Skipped here, emitted below the pyramid. */
      if (payload.material.model === "glass") return;
      if (payload.mode === "instances" || payload.mode === "points" || payload.mode === "beam") {
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
        const model = material.model === "unlit" ? "unlit" : material.model === "phong" || material.model === "pbr" ? "phong" : "lambert";
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
          shader: sceneInstancesWgsl({
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
            ...(castingIndices.length === 0 ? {} : { shadows: castingIndices }),
            ...(environmentResource === undefined ? {} : { environment: true }),
            ...(aoActive ? { ambientOcclusion: true } : {}),
            ...(projActive ? { projectors: projectorOptions } : {}),
            ...(payload.group === undefined ? {} : { group: payload.group }),
            ...(billboard ? { billboard: true } : {}),
            ...(beam ? { beam: true } : {}),
            /* T723: the turn, and the generator rotates the NORMALS with it. */
            ...(payload.orientAttribute === undefined ? {} : { pointOrient: true }),
          }),
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
                [`light${lightIndex}Meta`, [light.type === "point" ? 1 : 0, light.intensity, 0, 0]],
                [`light${lightIndex}Color`, [...light.color, 0]],
                [`light${lightIndex}Vector`, [...(light.type === "point" ? light.position : light.direction), 0]],
              ]),
            ),
            ...Object.fromEntries(
              shadowMatrices.map((matrix, slot) => [`shadow${slot}Matrix`, Array.from(matrix)]),
            ),
            ...(environmentResource === undefined || model !== "phong"
              ? {}
              : { environment: [environmentIntensity, 0, 0, 0] }),
            ...(projActive ? projectorUniforms : {}),
          },
          ...(casting.length === 0 && environmentResource === undefined && !aoActive && !projActive
            ? {}
            : {
                textures: [
                  ...casting.map((_, slot) => ({
                    binding: `shadowMap${slot}`,
                    resourceId: shadowTargetOf(slot),
                    sampled: "unfiltered" as const,
                  })),
                  ...(environmentResource === undefined || model !== "phong"
                    ? []
                    : [{ binding: "environmentMap", resourceId: environmentResource, sampled: "unfiltered" as const }]),
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
      const topology = typeof payload.topology === "string" ? parseTopology(payload.topology) : null;
      if (topology === null || topology.kind !== "grid") {
        diagnostics.push({
          severity: "error",
          code: "node.scene.topology",
          message: `Node "${nodeId}": geometry "${source}" carries no analytic grid topology; a surface cannot be built.`,
          nodeId,
        });
        return;
      }
      if (gridPointCount(topology) > payload.capacity) {
        diagnostics.push({
          severity: "error",
          code: "node.scene.topology",
          message: `Node "${nodeId}": geometry "${source}" claims ${gridPointCount(topology)} grid points but carries ${payload.capacity}.`,
          nodeId,
        });
        return;
      }
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
      if (material.model !== "unlit" && lights.length === 0) {
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
      const { cellsU, cellsV } = gridCellCounts(topology);
      const model = material.model === "unlit" ? "unlit" : material.model === "phong" || material.model === "pbr" ? "phong" : "lambert";
      /* T624: see the instances branch — unlit binds no occlusion map. */
      const aoActive = aoEnabled && model !== "unlit";
      /* T704: see the instances branch — unlit takes no projectors. */
      const projActive = projectorOptions.length > 0 && model !== "unlit";
      /*
       * T428: PBR through the Blinn-Phong path, honestly — metallic tints the
       * highlight toward the base colour (a metal's reflection is its own colour),
       * roughness dulls it via the generator's gloss. Stated in the node description;
       * environment reflections arrive with the environment input.
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
      passes.push({
        kind: "draw",
        id: `${nodeId}:scene:${index}`,
        nodeId,
        shader: sceneSurfaceWgsl({
          model,
          lightCount: lights.length,
          maps,
          ...(payload.colorAttribute === undefined ? {} : { pointColor: true }),
          ...(castingIndices.length === 0 ? {} : { shadows: castingIndices }),
          ...(environmentResource === undefined ? {} : { environment: true }),
          ...(aoActive ? { ambientOcclusion: true } : {}),
          ...(projActive ? { projectors: projectorOptions } : {}),
        }),
        target,
        topology: "triangle-list",
        instances: 1,
        vertexCount: cellsU * cellsV * 6,
        buffers: [
          attributeBinding("positions", position),
          ...(payload.colorAttribute === undefined
            ? []
            : [attributeBinding("pointColors", payload.colorAttribute)]),
        ],
        ...(material.maps.albedo === undefined &&
        material.maps.roughness === undefined &&
        casting.length === 0 &&
        !aoActive &&
        !projActive &&
        (environmentResource === undefined || model !== "phong")
          ? {}
          : {
              textures: [
                ...(material.maps.albedo === undefined
                  ? []
                  : [{ binding: "albedoMap", resourceId: material.maps.albedo, sampled: "unfiltered" as const }]),
                ...(material.maps.roughness === undefined
                  ? []
                  : [{ binding: "roughnessMap", resourceId: material.maps.roughness, sampled: "unfiltered" as const }]),
                ...casting.map((_, slot) => ({
                  binding: `shadowMap${slot}`,
                  resourceId: shadowTargetOf(slot),
                  sampled: "unfiltered" as const,
                })),
                ...(environmentResource === undefined || model !== "phong"
                  ? []
                  : [{ binding: "environmentMap", resourceId: environmentResource, sampled: "unfiltered" as const }]),
                ...(aoActive
                  ? [{ binding: "occlusionMap", resourceId: aoTargetId, sampled: "unfiltered" as const }]
                  : []),
                ...(projActive ? projectorTextures : []),
              ],
            }),
        uniforms: {
          viewProjection: Array.from(viewProjectionMatrix),
          eye: [camera.eye[0], camera.eye[1], camera.eye[2], 0],
          ambientColor: [ambient[0] ?? 1, ambient[1] ?? 1, ambient[2] ?? 1, ambientIntensity],
          baseColor: [...material.baseColor],
          specular: [...specularColor, shininess],
          material: [material.metallic, material.roughness, 0, 0],
          grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
          ...Object.fromEntries(
            lights.flatMap((light, lightIndex) => [
              [`light${lightIndex}Meta`, [light.type === "point" ? 1 : 0, light.intensity, 0, 0]],
              [`light${lightIndex}Color`, [...light.color, 0]],
              [`light${lightIndex}Vector`, [...(light.type === "point" ? light.position : light.direction), 0]],
            ]),
          ),
          ...Object.fromEntries(
            shadowMatrices.map((matrix, slot) => [`shadow${slot}Matrix`, Array.from(matrix)]),
          ),
          ...(environmentResource === undefined || model !== "phong"
            ? {}
            : { environment: [environmentIntensity, 0, 0, 0] }),
          ...(projActive ? projectorUniforms : {}),
        },
        uniformBinding: "params",
        clear: false,
      });
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
            shader: glassInstancesWgsl(glassShaderOptions),
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
        if (topology === null || topology.kind !== "grid") {
          diagnostics.push({
            severity: "error",
            code: "node.scene.topology",
            message: `Node "${nodeId}": geometry "${source}" carries no analytic grid topology; a surface cannot be built.`,
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
        const { cellsU, cellsV } = gridCellCounts(topology);
        passes.push({
          kind: "draw",
          id: `${nodeId}:glass:${index}`,
          nodeId,
          shader: glassSurfaceWgsl(glassShaderOptions),
          target,
          topology: "triangle-list",
          instances: 1,
          vertexCount: cellsU * cellsV * 6,
          buffers: [attributeBinding("positions", position)],
          textures: glassTextures,
          uniforms: {
            ...glassUniforms,
            grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
          },
          uniformBinding: "params",
          clear: false,
        });
      }
    }

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

    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { passes: [], diagnostics };
    }
    return {
      passes,
      ...(scratch.length === 0 ? {} : { scratch }),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    };
  },
};

/**
 * T428 — the MATERIAL family. Each material is a THING geometries reference by name;
 * its MAP slots are ordinary texture INPUT wires (V372: pixels are data), which is the
 * T444 load-bearing wire — a render's output texture feeds a material's albedo by a
 * plain edge, and the virtual screen exists.
 *
 * Normal maps are DEFERRED WITH NO INERT PORT (V368): surfaces get analytic normals,
 * instances need tangent frames, and a port that binds nothing teaches nothing.
 */
function materialCompile(model: MaterialPayload["model"]) {
  return (context: Parameters<NodeDefinition["compile"]>[0]): CompiledNodeDescription => {
    const { parameters, inputs } = readCompileInputs(context);
    const base = readColor(parameters, "color", [0.8, 0.8, 0.8, 1]);
    const specular = readColor(parameters, "specular", [1, 1, 1, 1]);
    const albedoMap = inputs["albedo"]?.resource;
    const roughnessMap = inputs["roughness"]?.resource;
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
    };
    return { passes: [], scene: { out: payload } } as CompiledNodeDescription;
  };
}

const MATERIAL_OUT = { id: "out", label: "Out", type: { kind: "material", model: "custom" } as const };
const ALBEDO_IN = {
  id: "albedo",
  label: "Albedo Map",
  optional: true,
  type: RGBA_TEXTURE,
  description: "Multiplies the base colour, sampled by the surface's grid uv. A render output plugs in here (E25).",
};
const ROUGHNESS_IN = {
  id: "roughness",
  label: "Roughness Map",
  optional: true,
  type: RGBA_TEXTURE,
  description: "Red channel multiplies roughness, sampled by the surface's grid uv.",
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
  },
  compile: materialCompile("phong"),
};

export const materialPbrNode: NodeDefinition = {
  type: "materialPbr",
  version: 1,
  title: "Material · PBR",
  category: "render",
  description:
    "Metallic-roughness material with albedo and roughness map inputs. This build shades it through the Blinn-Phong path (roughness drives the highlight; metallic tints it toward the base colour) — an honest approximation, stated rather than hidden; environment reflections land with the environment input.",
  tags: ["3d", "material", "pbr", "metallic", "roughness", "scene"],
  inputs: [ALBEDO_IN, ROUGHNESS_IN],
  outputs: [MATERIAL_OUT],
  parameters: {
    color: { type: "color", label: "Base Color", default: [0.8, 0.8, 0.8, 1], space: "display" },
    metallic: { type: "number", label: "Metallic", default: 0, min: 0, max: 1, range: "bounded" },
    roughness: { type: "number", label: "Roughness", default: 0.5, min: 0, max: 1, range: "bounded" },
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
    "Screen-space transmission: the surface refracts what the render already drew behind it, through a blur pyramid so roughness reads as frost. IOR bends, Dispersion splits colours, Absorption tints by removal (Beer-Lambert over Thickness), and a Fresnel-weighted environment reflection takes over at grazing angles. Draws after the opaques; casts no shadow (light passes through). The node preview shows a phong stand-in — there is no scene behind a preview ball to refract.",
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
