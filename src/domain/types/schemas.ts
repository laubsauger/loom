import { z } from "zod";
import { SELECTABLE_COLOR_FORMATS, TEXTURE_FORMATS } from "./node-definition.ts";
import type { GraphPatchOperation } from "./patch.ts";
import type { ParameterMode } from "./parameters.ts";

/**
 * Runtime validation for the two boundaries where data arrives untrusted (§V10, §V66):
 * the serialized file surface, and the graph patch a caller hands the bus.
 * Live in-memory types stay in the .ts contract; this guards what crosses in.
 */

export const SCHEMA_VERSION = 3;

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
  z.object({ kind: z.literal("projector") }),
  z.object({ kind: z.literal("transform3d") }),
  z.object({ kind: z.literal("event") }),
  z.object({ kind: z.literal("audioFeatures") }),
  z.object({ kind: z.literal("value") }),
]);

export const parameterValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string(),
  z.array(z.number()),
  z.array(z.object({ x: z.number(), y: z.number() })),
  // T270 — a `stops` list. Structural only: the CAP and the channel count are the
  // manifest's business (`validateParameterValue`), because they belong to the parameter
  // and not to the file format.
  z.array(
    z.object({
      position: z.number(),
      color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  ),
  z.null(),
]);

/** One mode's payload (T202, §V107). Closed: this is what THIS build writes. */
export const parameterBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("static"), value: parameterValueSchema }),
  z.object({ kind: z.literal("expression"), source: z.string() }),
  z.object({ kind: z.literal("bind"), ref: z.string().min(1) }),
  z.object({ kind: z.literal("driven"), channel: z.string().min(1) }),
  // T286/B92: the Map page. This variant was MISSING while the domain type had it, so a
  // document carrying a mapped parameter failed the load boundary — saved fine, never
  // opened again. The kind list below is pinned to the union in both directions so a
  // seventh kind cannot repeat that.
  z.object({
    kind: z.literal("map"),
    attribute: z.string().min(1),
    channel: z.string().min(1).optional(),
    port: z.string().min(1).optional(),
  }),
]);

/**
 * B92 (§V316, B45's shape at the FILE boundary): the mode list is written once and
 * CHECKED against `ParameterMode` in both directions — `satisfies` catches a stray
 * entry, the `MissingMode` line catches an absent one — so a sixth binding kind breaks
 * this file at compile time instead of quietly rejecting saved documents that use it,
 * which is exactly how `map` mode documents stopped opening.
 */
const PARAMETER_MODE_VALUES = ["static", "expression", "bind", "driven", "map"] as const satisfies readonly ParameterMode[];
type MissingMode = Exclude<ParameterMode, (typeof PARAMETER_MODE_VALUES)[number]>;
const _everyModeListed: MissingMode[] = [] as never[];
void _everyModeListed;

export const parameterModeSchema = z.enum(PARAMETER_MODE_VALUES);

/**
 * The mode envelope (T202, §V108). A bare-value parameter never parses as this — a
 * `ParameterValue` is never a plain object — so the union below is unambiguous.
 */
export const parameterSlotSchema = z.object({
  mode: parameterModeSchema,
  bindings: z.record(parameterModeSchema, parameterBindingSchema),
});

/** What a stored parameter may be: a bare (static) value or a mode envelope. */
export const storedParameterSchema = z.union([parameterValueSchema, parameterSlotSchema]);

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
  parameters: z.record(storedParameterSchema),
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
  /**
   * Position on a variadic input port (T225, §V131). Optional so a document written
   * before the field existed still validates (§V68); non-negative integers only, because
   * the value is an index the UI shows and a node reads as "input 1, input 2".
   */
  order: z.number().int().nonnegative().optional(),
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
  // Bounded, not merely positive: 0.001 fps makes a timeline nothing advances on, and
  // 100000 makes `time` meaningless. Optional so pre-fps documents parse (§V68).
  fps: z.number().min(1).max(240).optional(),
  /**
   * T433 — the timeline's in/out points. Optional so pre-timeline documents parse (§V68).
   *
   * `end > start` is refused HERE rather than in each consumer, because this schema runs
   * at both boundaries the value can arrive through: the file loader and
   * `project.setSettings` (which validates with `.partial()`). An inverted range would
   * otherwise be a scrub extent nothing can be dragged along and a render of a negative
   * number of frames.
   */
  frameRange: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((range) => range.end > range.start, {
      message: "the range's out point must be after its in point",
    })
    .optional(),
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
// Patches carry slots too: the compound editor writes all components in ONE patch
// (§V114) and a mode switch is a setParameters like any other edit.
const patchParameters = z.record(storedParameterSchema);

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
      // §V324: an op that creates a named thing may carry the name, so replaying it
      // (undo→redo, paste) mints the same identity instead of reclaiming a freed one.
      label: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ op: z.literal("removeNodes"), nodeIds: z.array(z.string().min(1)) }).strict(),
  z
    .object({
      op: z.literal("connect"),
      ref: z.string().regex(/^\$/, "A patch-local ref must start with `$`.").optional(),
      source: patchPortRef,
      target: patchPortRef,
      // T695: where on a VARIADIC input the new edge lands. Absent = append, which is what
      // it meant before the field existed (§V68). Out-of-range is clamped at apply time
      // rather than rejected here — the schema cannot know how many edges the port holds.
      order: z.number().int().min(0).optional(),
    })
    .strict(),
  z.object({ op: z.literal("disconnect"), edgeIds: z.array(z.string().min(1)) }).strict(),
  z
    .object({
      op: z.literal("reorderEdges"),
      nodeId: refString,
      portId: z.string().min(1),
      // The complete resulting order (§V131). Emptiness is legal at the schema layer and
      // refused at apply time, where the port's actual edge set is known.
      edgeIds: z.array(z.string().min(1)),
    })
    .strict(),
  z.object({ op: z.literal("setParameters"), nodeId: refString, parameters: patchParameters }).strict(),
  z.object({ op: z.literal("setShaderSource"), nodeId: refString, source: z.string() }).strict(),
  z.object({ op: z.literal("moveNodes"), positions: z.record(patchPoint) }).strict(),
  z
    .object({
      op: z.literal("setNodeSize"),
      nodeId: refString,
      // Structural only (§V66): the FLOOR is applied where the document is written, so
      // there is one clamp rather than a schema rule and a handler rule disagreeing.
      size: z
        .object({ width: finiteNumber.positive(), height: finiteNumber.positive() })
        .strict()
        .nullable(),
    })
    .strict(),
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
