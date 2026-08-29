import { z } from "zod";
import { SELECTABLE_COLOR_FORMATS, TEXTURE_FORMATS } from "./node-definition.ts";
import type { GraphPatchOperation } from "./patch.ts";

/**
 * Runtime validation for the two boundaries where data arrives untrusted (§V10, §V66):
 * the serialized file surface, and the graph patch a caller hands the bus.
 * Live in-memory types stay in the .ts contract; this guards what crosses in.
 */

export const SCHEMA_VERSION = 1;

const vec2 = z.object({ x: z.number(), y: z.number() });

export const portTypeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("texture2d"),
    sample: z.enum(["float", "unfilterable-float", "depth"]),
    channels: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
    space: z.enum(["linear", "encoded", "data"]).optional(),
  }),
  z.object({
    kind: z.literal("buffer"),
    element: z.string(),
    access: z.enum(["read", "write", "read-write"]),
  }),
  z.object({ kind: z.literal("scalar"), scalar: z.enum(["f32", "i32", "u32", "bool"]) }),
  z.object({
    kind: z.literal("vector"),
    scalar: z.enum(["f32", "i32", "u32"]),
    size: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  }),
  z.object({
    kind: z.literal("matrix"),
    columns: z.union([z.literal(3), z.literal(4)]),
    rows: z.union([z.literal(3), z.literal(4)]),
  }),
  z.object({
    kind: z.literal("geometry"),
    topology: z.enum(["triangle-list", "triangle-strip", "line-list", "point-list"]),
  }),
  z.object({ kind: z.literal("scene") }),
  z.object({ kind: z.literal("material"), model: z.enum(["unlit", "pbr", "custom"]) }),
  z.object({ kind: z.literal("camera") }),
  z.object({ kind: z.literal("light") }),
  z.object({ kind: z.literal("transform3d") }),
  z.object({ kind: z.literal("event") }),
  z.object({ kind: z.literal("audioFeatures") }),
]);

export const parameterValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string(),
  z.array(z.number()),
  z.array(z.object({ x: z.number(), y: z.number() })),
  z.null(),
]);

export const nodeResolutionOverrideSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("project") }),
  z.object({ mode: z.literal("input"), input: z.string().min(1).optional() }),
  z.object({
    mode: z.literal("scale"),
    factor: z.number().positive().finite(),
    input: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("fixed"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal("fit"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    input: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("limit"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    input: z.string().min(1).optional(),
  }),
]);

export const nodeFormatOverrideSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("project") }),
  z.object({ mode: z.literal("input"), input: z.string().min(1).optional() }),
  // Depth is deliberately absent: it is not a user-selectable colour output (§V51).
  z.object({ mode: z.literal("fixed"), format: z.enum(SELECTABLE_COLOR_FORMATS) }),
]);

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  definitionVersion: z.number().int().nonnegative(),
  position: vec2,
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  parameters: z.record(parameterValueSchema),
  label: z.string().min(1).max(120).optional(),
  resolution: nodeResolutionOverrideSchema.optional(),
  format: nodeFormatOverrideSchema.optional(),
  state: z.record(z.unknown()).optional(),
  ui: z
    .object({
      collapsed: z.boolean().optional(),
      preview: z.boolean().optional(),
      bypassed: z.boolean().optional(),
      muted: z.boolean().optional(),
      color: z.string().optional(),
    })
    .optional(),
});

const endpoint = z.object({ nodeId: z.string().min(1), portId: z.string().min(1) });

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  source: endpoint,
  target: endpoint,
});

export const graphGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  color: z.string().optional(),
  members: z.array(z.string()),
});

export const graphDocumentSchema = z.object({
  revision: z.number().int().nonnegative(),
  nodes: z.record(graphNodeSchema),
  edges: z.record(graphEdgeSchema),
  groups: z.record(graphGroupSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
});

export const assetReferenceSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(["image", "video", "audio", "gltf", "binary"]),
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  source: z.union([
    z.object({ kind: z.literal("project"), relativePath: z.string() }),
    z.object({ kind: z.literal("fileHandle"), handleId: z.string() }),
    z.object({ kind: z.literal("objectUrl"), sessionId: z.string() }),
    z.object({ kind: z.literal("remote"), url: z.string().url(), integrity: z.string().optional() }),
  ]),
  metadata: z.record(z.unknown()).optional(),
});

export const projectSettingsSchema = z.object({
  outputResolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  workingFormat: z.enum(TEXTURE_FORMATS),
  randomSeed: z.number().int(),
  previewLongEdge: z.number().int().positive(),
  previewFps: z.number().positive(),
  /** T84: optional so pre-colour-policy documents parse; absent means the default. */
  colorPolicy: z
    .object({
      workingSpace: z.literal("linear"),
      displayTransform: z.enum(["srgb", "none"]),
    })
    .optional(),
  limits: z.object({
    maxResolution: z.number().int().positive(),
    maxDispatch: z.number().int().positive(),
    maxBufferBytes: z.number().int().positive(),
    memoryBudgetBytes: z.number().int().positive(),
  }),
});

export const projectDocumentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  projectId: z.string().min(1),
  name: z.string(),
  graph: graphDocumentSchema,
  settings: projectSettingsSchema,
  assets: z.array(assetReferenceSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ParsedProjectDocument = z.infer<typeof projectDocumentSchema>;

/* ------------------------------------------------------------------------------------
 * Graph patch input (§V66, T176)
 *
 * A patch is UNTRUSTED input at a process boundary — from an agent tool, a WebMCP call,
 * an out-of-process MCP server, a replayed file — and compile-time types guard none of
 * those. This schema is the runtime guard, and it lives HERE rather than beside any one
 * caller: `src/agent` guarded only its own boundary, so a malformed patch arriving any
 * other way still reached `applyGraphPatch` and threw a raw TypeError (no diagnostic, no
 * audit entry, an unhandled rejection). One schema, every caller.
 * ---------------------------------------------------------------------------------- */

/**
 * §V66: a non-finite coordinate is not a cosmetic problem. `NaN` serializes to `null`,
 * `null` fails `graphNodeSchema` on load, and the saved document no longer opens — so a
 * position is refused at the boundary rather than written and discovered a week later.
 */
const finiteNumber = z.number().finite();
const patchPoint = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const patchBounds = z
  .object({ x: finiteNumber, y: finiteNumber, width: finiteNumber, height: finiteNumber })
  .strict();

/** A stable id or a patch-local `$temp` ref; `applyGraphPatch` tells them apart (§V35). */
const refString = z.string().min(1);
const patchPortRef = z.object({ nodeId: refString, portId: z.string().min(1) }).strict();
const patchParameters = z.record(parameterValueSchema);

/**
 * Resolution and format overrides are checked for SHAPE here and for meaning by the
 * operation itself (§V50, §V51): the operation knows which node it is talking about and
 * which formats the project can select, so it is the layer that can say "depth is not a
 * colour output" and name the node. This boundary's job is to guarantee the field is an
 * override-shaped object or an explicit null before anyone reads `.mode` off it —
 * structural validation, which is what §V66 asks for; re-deriving the semantics here
 * would be the same rule written twice, and the copy that drifts is never the one that
 * runs.
 */
const overridePayload = z.union([z.object({ mode: z.string().min(1) }).passthrough(), z.null()]);

/**
 * Every object is `.strict()`: an unknown key is a caller mistake worth reporting, and
 * silently dropping it is how a typo in `positon` becomes a node at the origin.
 */
export const graphPatchOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("addNode"),
      ref: refString,
      type: z.string().min(1),
      position: patchPoint,
      parameters: patchParameters.optional(),
    })
    .strict(),
  z.object({ op: z.literal("removeNodes"), nodeIds: z.array(z.string().min(1)) }).strict(),
  z
    .object({
      op: z.literal("connect"),
      ref: z.string().regex(/^\$/, "A patch-local ref must start with `$`.").optional(),
      source: patchPortRef,
      target: patchPortRef,
    })
    .strict(),
  z.object({ op: z.literal("disconnect"), edgeIds: z.array(z.string().min(1)) }).strict(),
  z.object({ op: z.literal("setParameters"), nodeId: refString, parameters: patchParameters }).strict(),
  z.object({ op: z.literal("setShaderSource"), nodeId: refString, source: z.string() }).strict(),
  z.object({ op: z.literal("moveNodes"), positions: z.record(patchPoint) }).strict(),
  z.object({ op: z.literal("setNodeUi"), nodeId: refString, ui: z.record(z.unknown()) }).strict(),
  z.object({ op: z.literal("setNodeLabel"), nodeId: refString, label: z.string().nullable() }).strict(),
  z
    .object({
      op: z.literal("setNodeResolution"),
      nodeId: refString,
      resolution: overridePayload,
    })
    .strict(),
  z
    .object({
      op: z.literal("setNodeFormat"),
      nodeId: refString,
      format: overridePayload,
    })
    .strict(),
  z
    .object({
      op: z.literal("addGroup"),
      ref: refString,
      label: z.string(),
      bounds: patchBounds,
      color: z.string().optional(),
      members: z.array(refString).optional(),
    })
    .strict(),
  z.object({ op: z.literal("removeGroups"), groupIds: z.array(z.string().min(1)) }).strict(),
  z
    .object({
      op: z.literal("setGroup"),
      groupId: z.string().min(1),
      label: z.string().optional(),
      bounds: patchBounds.optional(),
      color: z.string().nullable().optional(),
      members: z.array(refString).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setViewport"),
      viewport: z
        .object({ x: finiteNumber, y: finiteNumber, zoom: finiteNumber.positive() })
        .strict()
        .nullable(),
    })
    .strict(),
]);

/**
 * `label` is bounded because it lands in the undo history and the audit log, both of
 * which a 60Hz caller can fill; `operations` is bounded for the same reason a patch is
 * atomic — one transaction that cannot be paused is one the UI has to survive.
 */
export const graphPatchSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    operations: z.array(graphPatchOperationSchema).max(10_000),
    label: z.string().max(200).optional(),
  })
  .strict();

export type ParsedGraphPatchOperation = z.infer<typeof graphPatchOperationSchema>;

/**
 * Compile-time coverage guard. Adding a member to `GraphPatchOperation` without teaching
 * the schema about it makes this line fail to compile — the same mechanism as the
 * `const never: never = operation` at the end of `applyGraphPatch`'s switch. Without it
 * a new operation would be structurally REJECTED at the boundary at runtime, which is
 * loud but only once someone tries the new op in a browser.
 */
export const GRAPH_PATCH_OPERATIONS_COVERED: Exclude<
  GraphPatchOperation["op"],
  ParsedGraphPatchOperation["op"]
> extends never
  ? true
  : never = true;
