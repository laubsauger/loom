import type { CompiledNodeDescription, NodeCompileContext, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { MaterialPayload, MaterialSourceSpan } from "../../domain/types/scene.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { codeParametersLast } from "../../domain/parameters/code.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";
import { declaredNames, resolveSharedModules, SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";
import { instanceFieldAccessor, isSurfaceBoundName, MATERIAL_TEXTURE_LIMIT, SURFACE_RESERVED_NAMES } from "../shaders/scene-render.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { isPackedType } from "./instance-records.ts";
import {
  REFLECTED_PARAMETER_KEYS_NOTE,
  extractParamsStruct,
  reflectInstanceStruct,
  reflectParamsStruct,
  reflectedParamCollisions,
  reflectedParamSchema,
  reflectedUniforms,
  remember,
} from "./params-reflection.ts";
import { readCompileInputs, readValueInputs } from "./compile-context.ts";
import { readColor, readNumber } from "./parameter-readers.ts";
import type { Params } from "./parameter-readers.ts";
import { endOf, placed, placedAroundCut } from "../../runtime/backend/wgsl-source-map.ts";

/**
 * T1355b — MATERIAL · WGSL: a material whose SURFACE is code. TouchDesigner's GLSL MAT.
 *
 * The stock materials fix what a surface is (a colour, a roughness) and the Render fixes
 * how it is lit. This one hands the first half to the author: a `fn surface(s: SurfaceIn,
 * p: Params) -> SurfaceOut` that runs once per pixel of every surface wearing it, BEFORE
 * lighting, and returns the albedo, roughness, metallic, normal and emissive the chosen
 * lighting model then shades. Molten metal that flows, grime keyed to height and heat, a
 * scan band that glitches one material — all per pixel, all lit the same way as everything
 * else, none of it a post effect pretending to know where a surface is.
 *
 * THE CONTRACT the author writes against (the generator emits these; see
 * `sceneSurfaceWgsl`'s `custom` option):
 *   SurfaceIn  world, normal, uv, tint (vertex colour), attr (a mesh's surface row —
 *              roughness, metallic, heat, part), emissive (a mesh's own), eye, albedo,
 *              roughness, metallic (the base values, before this function), absTime;
 *              local, localNormal (T1588b: the vertex and its normal in the shape's OWN
 *              frame, before the Geometry's Transform and before an instance's own —
 *              detail painted by them moves with the object and sticks to each
 *              instance), instanceId (the instance's slot; 0 on a surface),
 *              instance (T1581b: the source's own `struct Instance`, when it declares
 *              one — see PER-INSTANCE VALUES below).
 *   SurfaceOut albedo, roughness, metallic, normal, emissive.
 *   surfaceDefaults(s) → the SurfaceOut the stock material would have produced.
 *   `frameU` (SharedFrame) is readable for the other clocks.
 *
 * Knobs: the source's own `struct Params` is reflected into drivable controls exactly as
 * Custom WGSL and the point kernels reflect theirs (one reflector, §V349) — a uniform write,
 * never a rebuild (§V5). `// @use hash` / `grid` pull the shared modules in.
 *
 * PER-INSTANCE VALUES (T1581b, docs/mesh-instancing-design-2026-10-05.md D9): a source may
 * declare `struct Instance { heat: f32, // @default 0 … }` beside `struct Params`, and read
 * `s.instance.heat`. A mesh-instancing Geometry binds each field BY NAME to an attribute of
 * its points (same name and type; its Instance Attributes text renames or takes a channel),
 * so a kernel that writes `heat` per point lights each instance differently with no second
 * node agreeing on a slot number. On a surface, and for a field nothing binds, the value is
 * the field's `@default`. Fields are f32, vec2f, vec3f, vec4f, u32 or vec4u: the types a
 * point attribute has.
 *
 * TEXTURES (T1658b, docs/material-texture-inputs-2026-10-06.md): a source names what it
 * reads, a line each, `// @texture lens`. The first name is the input Texture 1, the second
 * Texture 2, up to four. The generator declares `var lens: texture_2d<f32>;` above the code,
 * and `surface()` reads it by a coordinate of its own with the shared module `map`
 * (`// @use map`: `mapNearest`, `mapLinear`) or with `textureLoad`. A name with nothing wired
 * is refused by name; a wire the source does not name is said by name. A webcam, a movie or
 * a Render is a texture like any other: what it holds this frame is what is read this frame.
 *
 * SURFACE draws and MESH INSTANCES (T1581b: a Geometry in Instances mode with Shape: Mesh,
 * where `local` is the vertex in the mesh's own frame and `instanceId` the instance's slot).
 * Primitive instances, points and beams draw through a different generator and refuse a WGSL
 * material by name at the Render.
 */

export const MATERIAL_WGSL_DEFAULT_SOURCE = `// Runs once per pixel of every surface wearing this material, BEFORE lighting.
// s: what the surface is — world, normal, uv, tint, attr (a mesh's roughness, metallic,
//    heat, part), emissive, eye, albedo, roughness, metallic, absTime (seconds; keeps
//    counting across a timeline loop — frameU.time is the clock that laps).
//    local and localNormal are the surface in its OWN frame, before the Geometry's
//    Transform and an instance's: paint by them and the detail moves with the object.
//    instanceId is the instance's slot on mesh instances, 0 on a surface.
// Return what it should be; the lighting model shades the result.
// surfaceDefaults(s) is what the stock material would have returned.
struct Params {
  heatGlow: f32, // @default 0  Emissive strength on hot surfaces (a mesh's heat, attr.z).
  heatColor: vec3f, // @default 1  Colour of that glow — white keeps the file's own emissive hue.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.emissive = o.emissive + p.heatColor * s.attr.z * p.heatGlow;
  return o;
}`;

const MATERIAL_WGSL_PARAM_CODE = "node.materialWgsl.params";
const MATERIAL_WGSL_SOURCE_CODE = "node.materialWgsl.source";
/** T1658b: a `// @texture` line that can never be a texture (its name, a fifth one). */
const MATERIAL_WGSL_TEXTURE_CODE = "node.materialWgsl.texture";
/** T1658b: a texture the source names with nothing wired into its input: waiting for a wire. */
const MATERIAL_WGSL_UNWIRED_CODE = "node.materialWgsl.textureUnwired";
/** T1658b: a wire into an input the source names no texture for: nothing reads it. */
const MATERIAL_WGSL_UNREAD_CODE = "node.materialWgsl.textureUnread";

/** The directive a source names a texture by, in the file's own `// @` comment idiom (`// @use`'s). */
const TEXTURE_DIRECTIVE = /^[ \t]*\/\/[ \t]*@texture\b[ \t]*([^\n]*)$/gm;
const WGSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The input a texture of that place is wired into, and how a person is told which one it is. */
export const materialTextureInput = (index: number): string => `texture${index + 1}`;
const inputLabel = (index: number): string => `Texture ${index + 1}`;
/** Every sentence names a texture both ways: an input cannot wear the source's name. */
const named = (name: string, index: number): string => `texture "${name}" (${inputLabel(index)})`;

/**
 * T1658b — THE TEXTURES A SOURCE NAMES, in the order it names them: what each
 * `// @texture <name>` line says, a name a line. Memoised by the source (§T259 compiles
 * every frame).
 */
export function reflectTextureNames(source: string): readonly string[] {
  const hit = textureNamesBySource.get(source);
  if (hit !== undefined) return hit;
  return remember(textureNamesBySource, source, [...source.matchAll(TEXTURE_DIRECTIVE)].map((match) => (match[1] ?? "").trim()));
}
const textureNamesBySource = new Map<string, readonly string[]>();

/** The keys this node owns; reflection may not take them (T1059's rule). */
function ownParameters(): ParameterSchema {
  return materialWgslNode.parameters;
}

const schemasBySource = new Map<string, ParameterSchema>();

function reflectedSchema(source: string): ParameterSchema {
  const hit = schemasBySource.get(source);
  if (hit !== undefined) return hit;
  const own = ownParameters();
  return remember(
    schemasBySource,
    source,
    codeParametersLast({ ...own, ...reflectedParamSchema(reflectParamsStruct(source), new Set(Object.keys(own))) }),
  );
}

/**
 * T1535b — WHERE THE AUTHOR'S `source` SITS IN WHAT THIS NODE HANDS THE SCENE.
 *
 * `code` is the `// @use` prelude, then the source with its `struct Params` cut out;
 * `paramsDeclaration` is that struct alone. Each map is counted from its own text's first
 * character — only the Scene's generator knows where it puts the two — and every span names
 * this node, because the pass that compiles them belongs to the Scene node.
 *
 * Memoised by the source (§T259 compiles every frame), the inputs kept beside it so another
 * node or prelude over the same text is never handed a stale map.
 */
function materialSourceMap(
  nodeId: string,
  source: string,
  prelude: string,
  declaration: string,
  start: number,
): NonNullable<NonNullable<MaterialPayload["custom"]>["sourceMap"]> {
  const hit = sourceMapsBySource.get(source);
  if (hit !== undefined && hit.nodeId === nodeId && hit.prelude === prelude) return hit.map;
  const own = (span: Omit<MaterialSourceSpan, "nodeId">): MaterialSourceSpan => ({ ...span, nodeId });
  const map = {
    code: placedAroundCut(SHADER_SOURCE_PARAMETER, source, start, start + declaration.length, endOf(prelude)).map(own),
    params:
      declaration === ""
        ? []
        : [own(placed(SHADER_SOURCE_PARAMETER, declaration, { line: 1, column: 1 }, endOf(source.slice(0, start))))],
  };
  return remember(sourceMapsBySource, source, { nodeId, prelude, map }).map;
}

const sourceMapsBySource = new Map<
  string,
  {
    readonly nodeId: string;
    readonly prelude: string;
    readonly map: NonNullable<NonNullable<MaterialPayload["custom"]>["sourceMap"]>;
  }
>();

export const materialWgslNode: NodeDefinition = {
  type: "materialWgsl",
  version: 1,
  title: "Material · WGSL",
  category: "render",
  description:
    "A material whose surface is code: fn surface(s: SurfaceIn, p: Params) -> SurfaceOut runs per pixel before lighting and returns albedo, roughness, metallic, normal and emissive, which the chosen Model then lights. Color, Metallic and Roughness are the base values it receives. Its struct Params becomes drivable controls. s.local and s.localNormal are the surface in its own frame, before the Geometry's Transform and before an instance's, so detail painted by them moves with the object and sticks to each instance; s.instanceId is the instance's slot. A `struct Instance` in the source is read as s.instance.<field>: on mesh instances each field takes the points' attribute of the same name (a kernel's glow, id or phase, per instance), elsewhere its // @default. Surface geometry (grid or mesh) and mesh instances. Texture inputs: see Source. For a lot in 0..n-1 from a hash, `// @use lot` and hashLot(h, n): never divide a hash's high half (h >> 16u) by a constant, which Apple GPUs get wrong.",
  tags: ["3d", "material", "wgsl", "shader", "custom", "glsl mat", "scene"],
  inputs: Array.from({ length: MATERIAL_TEXTURE_LIMIT }, (_, index) => ({
    id: materialTextureInput(index),
    label: inputLabel(index),
    optional: true,
    type: RGBA_TEXTURE,
    description: `The texture the source's ${["first", "second", "third", "fourth"][index]} \`// @texture <name>\` line names, read in the code under that name: a picture, a Webcam, a Movie File In, a Render. With \`// @use map\`, mapLinear(<name>, s.uv, vec2u(MAP_HOLD)) weighs four texels and mapNearest takes one; MAP_REPEAT and MAP_MIRROR tile an axis; textureLoad(<name>, …) reads a texel. No mip levels: feed a texture near the size it is drawn. A named texture must be wired, and a wire no line names is not read.`,
  })),
  outputs: [{ id: "out", label: "Out", type: { kind: "material", model: "custom" } }],
  parameters: codeParametersLast({
    model: {
      type: "enum",
      label: "Model",
      default: "pbr",
      options: [
        { value: "pbr", label: "PBR" },
        { value: "phong", label: "Phong" },
        { value: "lambert", label: "Lambert" },
        { value: "unlit", label: "Unlit" },
      ],
      compileTime: true,
      description: "How the surface this code returns is lit.",
    },
    color: { type: "color", label: "Base Color", default: [1, 1, 1, 1], space: "display" },
    metallic: { type: "number", label: "Metallic", default: 0, min: 0, max: 1, range: "bounded" },
    roughness: { type: "number", label: "Roughness", default: 0.5, min: 0, max: 1, range: "bounded" },
    [SHADER_SOURCE_PARAMETER]: {
      type: "code",
      language: "wgsl",
      label: "Source",
      default: MATERIAL_WGSL_DEFAULT_SOURCE,
      compileTime: true,
      description:
        "fn surface(s: SurfaceIn, p: Params) -> SurfaceOut, run per pixel before lighting. Its struct Params fields (with // @default and a describing comment) become this node's controls, read as p.<name>. `// @use hash` or `grid` pulls in shared helpers; `// @use extend` gives extendRepeat and extendMirror, the folds a stock material's Map Extend tiles a map by, for a pattern keyed to s.uv. A line `// @texture lens` names a texture the code reads (Texture 1; a second line is Texture 2, up to four): see the Texture inputs. A `struct Instance { glow: f32, // @default 0 }` is what the material reads PER INSTANCE, as s.instance.glow: on a mesh-instancing Geometry each field is the points' attribute of that name and type (the Geometry's Instance Attributes renames one or takes a channel), and on any other draw its @default.",
    },
  }),
  parametersFor(stored) {
    // §B266: the document's text, whatever mode the slot is in (see `customWgsl`).
    const raw = storedStaticValue(stored[SHADER_SOURCE_PARAMETER] as never);
    return reflectedSchema(typeof raw === "string" ? raw : MATERIAL_WGSL_DEFAULT_SOURCE);
  },
  parameterKeysNote: REFLECTED_PARAMETER_KEYS_NOTE,
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters, inputs } = readCompileInputs(context as Parameters<typeof readCompileInputs>[0]);
    const raw = parameters[SHADER_SOURCE_PARAMETER];
    const source = typeof raw === "string" ? raw : MATERIAL_WGSL_DEFAULT_SOURCE;
    const fields = reflectParamsStruct(source);
    const collisions = reflectedParamCollisions(nodeId, fields, new Set(Object.keys(ownParameters())), MATERIAL_WGSL_PARAM_CODE);
    if (collisions.length > 0) return { passes: [], diagnostics: collisions };

    const shared = resolveSharedModules(source);
    if (shared.missing.length > 0) {
      return {
        passes: [],
        diagnostics: shared.missing.map((name) => ({
          severity: "error" as const,
          code: MATERIAL_WGSL_SOURCE_CODE,
          message: `Node "${nodeId}": \`// @use ${name}\` names a shared WGSL module that does not exist.`,
          nodeId,
          suggestion: `Shared modules: ${Object.keys(SHARED_WGSL_MODULES).join(", ")}.`,
        })),
      };
    }
    const { declaration, rest, start } = extractParamsStruct(source);
    const code = `${shared.prelude}${rest}`;
    const own = declaredNames(code);
    if (!own.includes("surface")) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: MATERIAL_WGSL_SOURCE_CODE,
            message: `Node "${nodeId}": the source declares no \`fn surface(s: SurfaceIn, p: Params) -> SurfaceOut\`.`,
            nodeId,
          },
        ],
      };
    }
    /* The generator owns the names around the author's code; one declared twice is a WGSL
       error at best and a silently shadowed helper at worst, so it is named here instead. */
    /* T1581b: the per-instance fields, and the one accessor the generator declares for each. */
    const instanceFields = reflectInstanceStruct(source);
    const unreadable = instanceFields.filter((field) => !isPackedType(field.wgsl));
    if (unreadable.length > 0) {
      return {
        passes: [],
        diagnostics: unreadable.map((field) => ({
          severity: "error" as const,
          code: MATERIAL_WGSL_SOURCE_CODE,
          message: `Node "${nodeId}": \`struct Instance\` field "${field.name}" is ${field.wgsl}; an instance field is read from a point attribute, so it is f32, vec2f, vec3f, vec4f, u32 or vec4u.`,
          nodeId,
        })),
      };
    }
    const accessors = new Set(instanceFields.map((field) => instanceFieldAccessor(field.name)));
    const clashes = own.filter((name) => SURFACE_RESERVED_NAMES.has(name) || accessors.has(name));
    if (clashes.length > 0) {
      return {
        passes: [],
        diagnostics: clashes.map((name) => ({
          severity: "error" as const,
          code: MATERIAL_WGSL_SOURCE_CODE,
          message: `Node "${nodeId}": "${name}" is declared by the surface generator this code is placed in; rename yours.`,
          nodeId,
        })),
      };
    }

    /* T1658b: the textures the source names. A line that can never be a texture is refused
       with what to write instead; the generator declares each name at module scope, so it
       may be nothing the generator, a shared module or the author's own code declares. */
    const textureNames = reflectTextureNames(source);
    const textureFault = (message: string, suggestion: string) => ({ severity: "error" as const, code: MATERIAL_WGSL_TEXTURE_CODE, message: `Node "${nodeId}": ${message}`, nodeId, suggestion });
    const textureFaults = textureNames.flatMap((name, index) => {
      if (!WGSL_IDENTIFIER.test(name)) {
        return [textureFault(`\`// @texture ${name}\` does not name a texture: a name is letters, digits and underscores, one a line.`, "Write `// @texture lens`, and one line for each texture.")];
      }
      if (textureNames.indexOf(name) !== index) {
        return [textureFault(`the source names texture "${name}" twice.`, "Name each texture once; read it as often as the code needs.")];
      }
      if (own.includes(name) || name === "surface" || SURFACE_RESERVED_NAMES.has(name) || isSurfaceBoundName(name) || accessors.has(name)) {
        return [textureFault(`texture "${name}" has the name of something this shader already declares.`, `Give the texture another name, such as "${name}Map".`)];
      }
      return [];
    });
    if (textureNames.length > MATERIAL_TEXTURE_LIMIT) {
      textureFaults.push(
        textureFault(
          `the source names ${textureNames.length} textures (${textureNames.join(", ")}) and a Material · WGSL reads up to ${MATERIAL_TEXTURE_LIMIT}.`,
          `Remove ${textureNames.length - MATERIAL_TEXTURE_LIMIT === 1 ? "one" : String(textureNames.length - MATERIAL_TEXTURE_LIMIT)}, or pack two pictures into one texture upstream (a Composite side by side, read by halves of the coordinate).`,
        ),
      );
    }
    if (textureFaults.length > 0) return { passes: [], diagnostics: textureFaults };
    /* A named texture with nothing wired would read an unbound texture: a pipeline error with
       no node attached, or a silent black. Refused by name, with the input to wire. */
    const wired = textureNames.map((_, index) => inputs[materialTextureInput(index)]?.resource);
    const unwired = textureNames.flatMap((name, index) =>
      wired[index] === undefined
        ? [
            {
              severity: "error" as const,
              code: MATERIAL_WGSL_UNWIRED_CODE,
              message: `Node "${nodeId}": the source names ${named(name, index)} and nothing is wired into ${inputLabel(index)}.`,
              nodeId,
              suggestion: `Wire a texture into ${inputLabel(index)}, or remove the \`// @texture ${name}\` line.`,
            },
          ]
        : [],
    );
    if (unwired.length > 0) return { passes: [], diagnostics: unwired };
    /* The other way round: a wire into an input no line names. The picture is right, and the
       wire does nothing, which is said (§T1641b: nothing reads it). */
    const unread = Array.from({ length: MATERIAL_TEXTURE_LIMIT }, (_, index) => index)
      .filter((index) => index >= textureNames.length && inputs[materialTextureInput(index)]?.resource !== undefined)
      .map((index) => ({
        severity: "warning" as const,
        code: MATERIAL_WGSL_UNREAD_CODE,
        message: `Node "${nodeId}": ${inputLabel(index)} is wired and the source names ${textureNames.length === 0 ? "no texture" : `${textureNames.length} texture${textureNames.length === 1 ? "" : "s"} (${textureNames.join(", ")})`}: it is not read.`,
        nodeId,
        suggestion: `Add a \`// @texture <name>\` line to the source (the ${["first", "second", "third", "fourth"][index]} one is ${inputLabel(index)}), or remove the wire.`,
      }));

    /* T1719b: everything above is structure; what a frame can move is the colour, the model's
       numbers and the reflected uniforms. One function assembles the payload from resolved
       values, for this compile and for its value function, so the two cannot disagree. */
    const instance =
      instanceFields.length === 0
        ? undefined
        : instanceFields.map((field) => ({
            name: field.name,
            wgsl: field.wgsl,
            ...(field.declaredDefault === undefined ? {} : { default: typeof field.declaredDefault === "number" ? [field.declaredDefault] : field.declaredDefault }),
          }));
    const textures = textureNames.length === 0 ? undefined : textureNames.map((name, index) => ({ name, resourceId: wired[index] as string }));
    const sourceMap = materialSourceMap(nodeId, source, shared.prelude, declaration, start);
    const payloadAt = (values: Params): MaterialPayload => {
      const model = values["model"];
      const base = readColor(values, "color", [1, 1, 1, 1]);
      return {
        kind: "material",
        model: model === "phong" || model === "lambert" || model === "unlit" ? model : "pbr",
        baseColor: [base[0] ?? 1, base[1] ?? 1, base[2] ?? 1, base[3] ?? 1],
        specularColor: [1, 1, 1],
        shininess: 32,
        metallic: readNumber(values, "metallic", 0),
        roughness: readNumber(values, "roughness", 0.5),
        maps: {},
        custom: {
          code,
          paramsDeclaration: declaration,
          fields: fields.map((field) => ({ name: field.name, wgsl: field.wgsl })),
          uniforms: reflectedUniforms(fields, values),
          ...(instance === undefined ? {} : { instance }),
          ...(textures === undefined ? {} : { textures }),
          sourceMap,
        },
      };
    };
    return {
      passes: [],
      scene: { out: payloadAt(parameters) },
      values: (next: NodeCompileContext) => ({ passes: [], scene: { out: payloadAt(readValueInputs(next).parameters) } }),
      ...(unread.length === 0 ? {} : { diagnostics: unread }),
    } as CompiledNodeDescription;
  },
};
