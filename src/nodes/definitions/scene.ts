import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import type { CameraPayload, GeometryPayload, LightPayload, MaterialPayload, ScenePayload } from "../../domain/types/scene.ts";
import { DEFAULT_MATERIAL } from "../../domain/types/scene.ts";
import { lookAt, multiply, orthographic, perspective } from "../../domain/geometry/camera.ts";
import { gridCellCounts, gridPointCount, parseTopology } from "../../points/topology.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readColor, readNumber, readVector } from "./parameter-readers.ts";
import { sceneSurfaceWgsl } from "../shaders/scene-render.wgsl.ts";

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
  category: "value",
  description:
    "A camera other nodes reference by NAME: a Render names it in its camera parameter; renderInstances/renderSurface can be pointed at it later. Every parameter is drivable — an orbiting camera is a uniform write, never a rebuild.",
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
  category: "value",
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
  category: "value",
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
    tint: {
      type: "color",
      label: "Tint",
      default: [1, 1, 1, 1],
      space: "display",
      description: "Per-object multiplier on the material's base colour. White = inherit.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
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
    const base: MaterialPayload = materialBinding ?? DEFAULT_MATERIAL;
    const tint = readColor(parameters, "tint", [1, 1, 1, 1]);
    const material: MaterialPayload = {
      ...base,
      baseColor: [
        (base.baseColor[0] ?? 1) * (tint[0] ?? 1),
        (base.baseColor[1] ?? 1) * (tint[1] ?? 1),
        (base.baseColor[2] ?? 1) * (tint[2] ?? 1),
        (base.baseColor[3] ?? 1) * (tint[3] ?? 1),
      ],
    };
    const mode = parameters["mode"] === "instances" ? "instances" : parameters["mode"] === "points" ? "points" : "surface";
    const payload: GeometryPayload = {
      kind: "geometry",
      pairs: pointset.pairs,
      capacity: pointset.capacity,
      ...(pointset.topology === undefined ? {} : { topology: pointset.topology }),
      mode,
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
  category: "generator",
  description:
    "Renders named geometries through a named camera under named lights, into a depth-tested texture. scenes and lights take space-separated name lists — list order is draw and light order. Any number of lights; count changes recompile, movement animates.",
  tags: ["3d", "scene", "render", "camera", "light"],
  inputs: [
    { id: "scenes", label: "Scenes", optional: true, variadic: true, type: { kind: "scene" } },
    { id: "camera", label: "Camera", optional: true, type: { kind: "camera" } },
    { id: "lights", label: "Lights", optional: true, variadic: true, type: { kind: "light" } },
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
    const cameraBinding = sceneOf("camera")[0];
    if (cameraBinding === undefined) {
      return refuse("node.scene.camera", `no camera is named — set the camera parameter to a camera node's name.`);
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
    const view = lookAt(
      [camera.eye[0], camera.eye[1], camera.eye[2]],
      [camera.lookAt[0], camera.lookAt[1], camera.lookAt[2]],
      [0, 1, 0],
    );
    const projection = camera.ortho
      ? orthographic(camera.orthoHeight, aspect, camera.near, camera.far)
      : perspective((camera.fovDeg * Math.PI) / 180, aspect, camera.near, camera.far);
    const viewProjectionMatrix = multiply(projection, view);

    const ambient = readColor(parameters, "ambientColor", [1, 1, 1, 1]);
    const ambientIntensity = readNumber(parameters, "ambientIntensity", 0.12);

    const diagnostics: NonNullable<CompiledNodeDescription["diagnostics"]> = [];
    const passes: DrawPassDescriptor[] = [];
    geometries.forEach(({ payload, source }, index) => {
      if (payload.mode !== "surface") {
        diagnostics.push({
          severity: "error",
          code: "node.scene.mode",
          message: `Node "${nodeId}": geometry "${source}" uses mode "${payload.mode}", which lands with T428 — surface is the mode this build renders.`,
          nodeId,
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
      passes.push({
        kind: "draw",
        id: `${nodeId}:scene:${index}`,
        nodeId,
        shader: sceneSurfaceWgsl({ model, lightCount: lights.length }),
        target,
        topology: "triangle-list",
        instances: 1,
        vertexCount: cellsU * cellsV * 6,
        buffers: [{ binding: "positions", resourceId: position.pair, half: position.half }],
        uniforms: {
          viewProjection: Array.from(viewProjectionMatrix),
          eye: [camera.eye[0], camera.eye[1], camera.eye[2], 0],
          ambientColor: [ambient[0] ?? 1, ambient[1] ?? 1, ambient[2] ?? 1, ambientIntensity],
          baseColor: [...material.baseColor],
          specular: [...material.specularColor, material.shininess],
          material: [material.metallic, material.roughness, 0, 0],
          grid: [topology.cols, topology.rows, topology.wrapU ? 1 : 0, topology.wrapV ? 1 : 0],
          ...Object.fromEntries(
            lights.flatMap((light, lightIndex) => [
              [`light${lightIndex}Meta`, [light.type === "point" ? 1 : 0, light.intensity, 0, 0]],
              [`light${lightIndex}Color`, [...light.color, 0]],
              [`light${lightIndex}Vector`, [...(light.type === "point" ? light.position : light.direction), 0]],
            ]),
          ),
        },
        uniformBinding: "params",
        clear: index === 0,
      });
    });

    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { passes: [], diagnostics };
    }
    return { passes, ...(diagnostics.length === 0 ? {} : { diagnostics }) };
  },
};

export const sceneNodeDefinitions: readonly NodeDefinition[] = [cameraNode, lightNode, geometryNode, renderNode];
