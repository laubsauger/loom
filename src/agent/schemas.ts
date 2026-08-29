import { z } from "zod";

import {
  nodeFormatOverrideSchema,
  nodeResolutionOverrideSchema,
  parameterValueSchema,
} from "@domain/types/schemas.ts";

/**
 * Tool input schemas — the "schema" half of "transport plus schema" (§V39, §V66).
 *
 * Everything an agent sends is untrusted input at a process boundary, so it is validated
 * structurally BEFORE it reaches the bus: a malformed patch comes back as a diagnostic,
 * never as a raw throw or an unhandled rejection (§V66). `src/domain` has no zod schema
 * for `GraphPatchOperation` today, so the operation schema below is this boundary's own;
 * it mirrors `@domain/types/patch.ts` exactly and must be updated with it. Lifting it
 * into `src/domain/types/schemas.ts` would let the bus validate for every caller.
 *
 * Every object is `.strict()`. An unknown key is a caller mistake worth reporting — and
 * it is also how a fabricated `capabilities` field gets refused instead of ignored
 * (§V38).
 */

const finite = z.number().finite();

/** §V66: a non-finite position serializes to `null` and makes the document unloadable. */
const position = z.object({ x: finite, y: finite }).strict();

const nodeRef = z.string().min(1);
const portId = z.string().min(1);

const portRef = z.object({ nodeId: nodeRef, portId }).strict();

const parameters = z.record(parameterValueSchema);

export const graphPatchOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("addNode"),
      /** Patch-local `$temp` id, resolved and returned in `createdIds` (§V35). */
      ref: z.string().regex(/^\$/, "A patch-local ref must start with `$`."),
      type: z.string().min(1),
      position,
      parameters: parameters.optional(),
    })
    .strict(),
  z.object({ op: z.literal("removeNodes"), nodeIds: z.array(z.string().min(1)) }).strict(),
  z
    .object({
      op: z.literal("connect"),
      ref: z.string().regex(/^\$/).optional(),
      source: portRef,
      target: portRef,
    })
    .strict(),
  z.object({ op: z.literal("disconnect"), edgeIds: z.array(z.string().min(1)) }).strict(),
  z.object({ op: z.literal("setParameters"), nodeId: nodeRef, parameters }).strict(),
  z.object({ op: z.literal("setShaderSource"), nodeId: nodeRef, source: z.string() }).strict(),
  z.object({ op: z.literal("moveNodes"), positions: z.record(position) }).strict(),
  z.object({ op: z.literal("setNodeUi"), nodeId: nodeRef, ui: z.record(z.unknown()) }).strict(),
  z.object({ op: z.literal("setNodeLabel"), nodeId: nodeRef, label: z.string().nullable() }).strict(),
  z
    .object({
      op: z.literal("setNodeResolution"),
      nodeId: nodeRef,
      resolution: nodeResolutionOverrideSchema.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("setNodeFormat"),
      nodeId: nodeRef,
      format: nodeFormatOverrideSchema.nullable(),
    })
    .strict(),
]);

/**
 * `baseRevision` is REQUIRED here, unlike on the single-edit convenience tools.
 *
 * A patch is work built against a snapshot the agent read; filling in "whatever the
 * revision is now" on its behalf is precisely the silent rebase §V33 forbids. The
 * convenience tools (`add_node`, `connect_ports`, …) describe a single edit that was not
 * built against a snapshot at all, so there they may default — a human clicking "add
 * node" does not carry a base revision either.
 */
export const applyGraphPatchInput = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    operations: z.array(graphPatchOperationSchema).min(1),
    label: z.string().max(200).optional(),
    /** §V36: validate and report, mutate nothing. */
    dryRun: z.boolean().optional(),
  })
  .strict();

const baseRevision = z.number().int().nonnegative().optional();
const dryRun = z.boolean().optional();

export const emptyInput = z.object({}).strict();

export const getGraphInput = z
  .object({
    /** Compact by default (doc §30.4): parameters only when asked for. */
    includeParameters: z.boolean().optional(),
    nodeIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const getNodeInput = z
  .object({ nodeId: z.string().min(1), includeParameters: z.boolean().optional() })
  .strict();

export const listNodeDefinitionsInput = z.object({ category: z.string().optional() }).strict();

export const getNodeDefinitionInput = z.object({ type: z.string().min(1) }).strict();

export const getDiagnosticsInput = z
  .object({ severity: z.enum(["info", "warning", "error"]).optional(), limit: z.number().int().positive().max(500).optional() })
  .strict();

export const renderPreviewInput = z
  .object({
    nodeId: z.string().min(1),
    /** §V59: output identity is port-scoped. A single-output node defaults to "out". */
    portId: z.string().min(1).optional(),
    maxSize: z.number().int().min(16).max(2048).optional(),
  })
  .strict();

export const addNodeInput = z
  .object({
    type: z.string().min(1),
    position: position.optional(),
    parameters: parameters.optional(),
    baseRevision,
    dryRun,
  })
  .strict();

export const removeNodesInput = z
  .object({ nodeIds: z.array(z.string().min(1)).min(1), dryRun })
  .strict();

export const connectPortsInput = z
  .object({ source: portRef, target: portRef, baseRevision, dryRun })
  .strict();

export const disconnectPortsInput = z
  .object({ edgeIds: z.array(z.string().min(1)).min(1), baseRevision, dryRun })
  .strict();

export const setParametersInput = z
  .object({ nodeId: z.string().min(1), parameters, baseRevision, dryRun })
  .strict();

export const setShaderSourceInput = z
  .object({ nodeId: z.string().min(1), source: z.string(), baseRevision, dryRun })
  .strict();

export const setOutputInput = z
  .object({ nodeId: z.string().min(1), portId: z.string().min(1).optional(), enabled: z.boolean().optional() })
  .strict();

export const resetFeedbackInput = z
  .object({ nodeIds: z.array(z.string().min(1)).optional() })
  .strict();

export const historyInput = z.object({ dryRun }).strict();

export const saveProjectInput = z.object({ saveAs: z.boolean().optional() }).strict();

/**
 * Tool input types are INFERRED from the schemas above, never hand-written beside them.
 * Two declarations of the same shape drift, and the one that drifts silently is always
 * the type — the schema is what actually runs.
 */
export type ApplyGraphPatchInput = z.infer<typeof applyGraphPatchInput>;
export const readPointsInput = z
  .object({
    nodeId: z.string().min(1),
    /** Attribute to read; defaults to "position". */
    attribute: z.string().min(1).optional(),
    start: z.number().int().min(0).optional(),
    /** A window, not a dump (§V16): the export path also caps at 256. */
    count: z.number().int().min(1).max(256).optional(),
  })
  .strict();

export type RenderPreviewInput = z.infer<typeof renderPreviewInput>;
export type ReadPointsInput = z.infer<typeof readPointsInput>;
export type EmptyInput = z.infer<typeof emptyInput>;
export type GetGraphInput = z.infer<typeof getGraphInput>;
export type GetNodeInput = z.infer<typeof getNodeInput>;
export type ListNodeDefinitionsInput = z.infer<typeof listNodeDefinitionsInput>;
export type GetNodeDefinitionInput = z.infer<typeof getNodeDefinitionInput>;
export type GetDiagnosticsInput = z.infer<typeof getDiagnosticsInput>;
export type AddNodeInput = z.infer<typeof addNodeInput>;
export type RemoveNodesInput = z.infer<typeof removeNodesInput>;
export type ConnectPortsInput = z.infer<typeof connectPortsInput>;
export type DisconnectPortsInput = z.infer<typeof disconnectPortsInput>;
export type SetParametersInput = z.infer<typeof setParametersInput>;
export type SetShaderSourceInput = z.infer<typeof setShaderSourceInput>;
export type SetOutputInput = z.infer<typeof setOutputInput>;
export type ResetFeedbackInput = z.infer<typeof resetFeedbackInput>;
export type HistoryInput = z.infer<typeof historyInput>;
export type SaveProjectInput = z.infer<typeof saveProjectInput>;
