import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import type { CameraPayload, GeometryPayload, LightPayload, MaterialPayload, ScenePayload } from "../../domain/types/scene.ts";
import { DEFAULT_MATERIAL } from "../../domain/types/scene.ts";
import { cameraPayloadMatrix, directionalShadowMatrix } from "../../domain/geometry/camera.ts";
import { gridCellCounts, gridPointCount, parseTopology } from "../../points/topology.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { DANGLING_CAMERA_SUGGESTION, danglingCameraRefusal } from "./camera-reference.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import { countedDrawSupport, resolveColorMap } from "./points.ts";
import {
  SHADOW_CLEAR_WGSL,
  sceneInstancesWgsl,
  sceneSurfaceWgsl,
  shadowInstancesWgsl,
  shadowSurfaceWgsl,
} from "../shaders/scene-render.wgsl.ts";

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
    "A camera other nodes reference by NAME: Render, Render Surface and Render Instances all name it in their camera parameter, so one camera frames them together. Every parameter is drivable — an orbiting camera is a uniform write, never a rebuild.",
  tags: ["3d", "scene", "camera", "view"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "camera" } }],
  parameters: {
    eye: { type: "vector", size: 3, label: "Eye", default: [0, 0.5, 3] },
    lookAt: { type: "vector", size: 3, label: "Look At", default: [0, 0, 0] },
    fov: { type: "number", label: "FOV", default: 55, min: 1, max: 179, unit: "degrees" },
    near: { type: "number", label: "Near", default: 0.1, min: 0.001 },
    far: { type: "number", label: "Far", default: 100, min: 0.01 },
    ortho: { type: "boolean", label: "Orthographic", default: false },
    orthoHeight: {
      type: "number",
      label: "Ortho Height",
      default: 2,
      min: 0.001,
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
    intensity: { type: "number", label: "Intensity", default: 1, min: 0 },
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
        { value: "points", label: "Points" },
      ],
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
      inactiveWhen: (values) => (values["mode"] === "instances" ? null : "Only instances wear a primitive."),
    },
    tint: {
      type: "color",
      label: "Tint",
      default: [1, 1, 1, 1],
      space: "display",
      description:
        "Multiplier on the material's base colour: per object as a value, PER POINT in Map mode (a vec4f attribute — T478). White = inherit, either way.",
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
    // retained static. `tint` is the one mappable parameter (T478).
    const unhonoured = Object.keys(parameterMaps).filter((key) => key !== "tint").sort();
    if (unhonoured.length > 0) {
      return {
        passes: [],
        diagnostics: unhonoured.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} is in map mode, but geometry maps only "tint".`,
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
    const mode = parameters["mode"] === "instances" ? "instances" : parameters["mode"] === "points" ? "points" : "surface";
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
    const shapeParameter = parameters["shape"];
    const payload: GeometryPayload = {
      kind: "geometry",
      pairs: pointset.pairs,
      capacity: pointset.capacity,
      ...(pointset.topology === undefined ? {} : { topology: pointset.topology }),
      mode,
      ...(mode === "instances"
        ? {
            instance: {
              shape: shapeParameter === "quad" ? "quad" : shapeParameter === "octahedron" ? "octahedron" : "box",
              scale: readNumber(parameters, "scale", 0.05),
            },
          }
        : {}),
      ...(tintMap === undefined ? {} : { colorAttribute: { pair: tintMap.pair, half: tintMap.half, type: "vec4f" } }),
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
  ],
  depthOutputs: ["out"],
  sourceReferences: [
    { parameter: "scenes", input: "scenes", list: true },
    { parameter: "camera", input: "camera" },
    { parameter: "lights", input: "lights", list: true },
  ],
  parameters: {
    scenes: { type: "string", label: "Scenes", default: "", description: "Space-separated geometry names, in draw order." },
    camera: { type: "string", label: "Camera", default: "", description: "Name of a camera node." },
    lights: { type: "string", label: "Lights", default: "", description: "Space-separated light names, in order." },
    ambientColor: { type: "color", label: "Ambient", default: [1, 1, 1, 1], space: "display" },
    ambientIntensity: { type: "number", label: "Ambient Intensity", default: 0.12, min: 0, max: 1 },
    background: { type: "color", label: "Background", default: [0, 0, 0, 1], space: "display" },
    environmentIntensity: {
      type: "number",
      label: "Env Intensity",
      default: 1,
      min: 0,
      description: "Scales the wired environment's reflection. A value: drivable, never a rebuild.",
      inactiveWhen: () => null,
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'output port "out"')] };
    }
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
      | { key: string; scale: number; format: "r32float"; depth: true }
    > = [];
    /** T481: counted draw support emitted once (in the shadow phase when one exists),
     *  shared by the shadow and the lit draw of the same geometry. */
    const countedByIndex = new Map<number, NonNullable<ReturnType<typeof countedDrawSupport>>>();

    /* T481: the shadow phase — every map is rendered BEFORE the lit draws that read it.
       Zero casting lights emits nothing here and nothing below changes: §V309 holds as
       byte-identical passes and shaders. */
    const emitShadowPasses = (): void => {
      casting.forEach(({ index: lightIndex }, slot) => {
        scratch.push({ key: `shadow${lightIndex}`, scale: 2, format: "r32float", depth: true });
        const shadowTarget = shadowTargetOf(slot);
        // The far plate: depth 1.0 everywhere first, the backdrop pattern (T444) —
        // a cleared map must read "nothing here" and the clear colour is not ours.
        passes.push({
          kind: "draw",
          id: `${nodeId}:shadow:${lightIndex}:clear`,
          nodeId,
          shader: SHADOW_CLEAR_WGSL,
          target: shadowTarget,
          topology: "triangle-list",
          instances: 1,
          vertexCount: 6,
          clear: true,
        } as DrawPassDescriptor);
        geometries.forEach(({ payload }, geometryIndex) => {
          const position = payload.pairs["position"];
          if (position === undefined) return; // the lit loop refuses this by name
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
              id: `${nodeId}:shadow:${lightIndex}:${geometryIndex}`,
              nodeId,
              shader: shadowInstancesWgsl(),
              target: shadowTarget,
              topology: "triangle-list",
              instances: counted?.instances ?? payload.capacity,
              vertexCount: 36,
              buffers: [{ binding: "positions", resourceId: position.pair, half: position.half }],
              uniforms: {
                lightViewProjection: Array.from(shadowMatrices[slot] ?? []),
                instance: [instance.scale, instance.shape === "quad" ? 0 : instance.shape === "octahedron" ? 2 : 1, 0, 0],
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
            id: `${nodeId}:shadow:${lightIndex}:${geometryIndex}`,
            nodeId,
            shader: shadowSurfaceWgsl(),
            target: shadowTarget,
            topology: "triangle-list",
            instances: 1,
            vertexCount: cellsU * cellsV * 6,
            buffers: [{ binding: "positions", resourceId: position.pair, half: position.half }],
            uniforms: {
              lightViewProjection: Array.from(shadowMatrices[slot] ?? []),
              grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
            },
            uniformBinding: "params",
            clear: false,
          });
        });
      });
    };
    emitShadowPasses();
    /*
     * T444: the BACKGROUND pass — one full-target triangle-pair painting the backdrop,
     * so a render used as a material map is a PICTURE with a stage behind it rather
     * than performers floating on unlit black (the invisible-screen failure the E25
     * look pass caught). The colour is a value; geometry draws compose over it.
     */
    passes.push({
      kind: "draw",
      id: `${nodeId}:backdrop`,
      nodeId,
      shader: `struct Backdrop { color: vec4f };
@group(0) @binding(0) var<uniform> backdrop: Backdrop;
@vertex
fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  return vec4f(corners[v], 0.999, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f { return backdrop.color; }`,
      target,
      topology: "triangle-list",
      instances: 1,
      vertexCount: 6,
      uniforms: { color: [background[0] ?? 0, background[1] ?? 0, background[2] ?? 0, background[3] ?? 1] },
      uniformBinding: "backdrop",
      clear: true,
    } as DrawPassDescriptor);
    geometries.forEach(({ payload, source }, index) => {
      if (payload.mode === "points") {
        diagnostics.push({
          severity: "error",
          code: "node.scene.mode",
          message: `Node "${nodeId}": geometry "${source}" uses mode "points", which is renderPoints' job for now — surface and instances are the scene modes this build renders.`,
          nodeId,
        });
        return;
      }
      if (payload.mode === "instances") {
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
            message: `Node "${nodeId}": geometry "${source}" wears a material with texture maps, but instances have no uv to sample by yet — maps work on surface geometry.`,
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
        passes.push({
          kind: "draw",
          id: `${nodeId}:scene:${index}`,
          nodeId,
          shader: sceneInstancesWgsl({
            model,
            lightCount: lights.length,
            ...(payload.colorAttribute === undefined ? {} : { pointColor: true }),
            ...(castingIndices.length === 0 ? {} : { shadows: castingIndices }),
            ...(environmentResource === undefined ? {} : { environment: true }),
          }),
          target,
          topology: "triangle-list",
          instances: counted?.instances ?? payload.capacity,
          vertexCount: 36,
          buffers: [
            { binding: "positions", resourceId: position.pair, half: position.half },
            ...(payload.colorAttribute === undefined
              ? []
              : [
                  {
                    binding: "pointColors",
                    resourceId: payload.colorAttribute.pair,
                    half: payload.colorAttribute.half,
                  },
                ]),
          ],
          uniforms: {
            viewProjection: Array.from(viewProjectionMatrix),
            eye: [camera.eye[0], camera.eye[1], camera.eye[2], 0],
            ambientColor: [ambient[0] ?? 1, ambient[1] ?? 1, ambient[2] ?? 1, ambientIntensity],
            baseColor: [...material.baseColor],
            specular: [...specularColor, shininess],
            material: [material.metallic, material.roughness, 0, 0],
            instance: [instance.scale, instance.shape === "quad" ? 0 : instance.shape === "octahedron" ? 2 : 1, 0, 0],
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
          },
          ...(casting.length === 0 && environmentResource === undefined
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
        }),
        target,
        topology: "triangle-list",
        instances: 1,
        vertexCount: cellsU * cellsV * 6,
        buffers: [
          { binding: "positions", resourceId: position.pair, half: position.half },
          ...(payload.colorAttribute === undefined
            ? []
            : [
                {
                  binding: "pointColors",
                  resourceId: payload.colorAttribute.pair,
                  half: payload.colorAttribute.half,
                },
              ]),
        ],
        ...(material.maps.albedo === undefined &&
        material.maps.roughness === undefined &&
        casting.length === 0 &&
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
        },
        uniformBinding: "params",
        clear: false,
      });
    });

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
    shininess: { type: "number", label: "Shininess", default: 48, min: 2, max: 512 },
    roughness: { type: "number", label: "Roughness", default: 0.35, min: 0, max: 1 },
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
    metallic: { type: "number", label: "Metallic", default: 0, min: 0, max: 1 },
    roughness: { type: "number", label: "Roughness", default: 0.5, min: 0, max: 1 },
  },
  compile: materialCompile("pbr"),
};

export const sceneNodeDefinitions: readonly NodeDefinition[] = [
  cameraNode,
  lightNode,
  geometryNode,
  renderNode,
  materialUnlitNode,
  materialPhongNode,
  materialPbrNode,
];
