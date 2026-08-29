import { z } from "zod";
import { SELECTABLE_COLOR_FORMATS, TEXTURE_FORMATS } from "./node-definition.ts";

/**
 * Runtime validation for the serialized surface only (§V10).
 * Live in-memory types stay in the .ts contract; this guards file boundaries.
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
