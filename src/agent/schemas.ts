import { z } from "zod";

import {
  graphPatchOperationSchema as domainGraphPatchOperationSchema,
  storedParameterSchema,
} from "@domain/types/schemas.ts";
import { channelExpression } from "@domain/parameters/slots.ts";

/**
 * Tool input schemas — the "schema" half of "transport plus schema" (§V39, §V66).
 *
 * Everything an agent sends is untrusted input at a process boundary, so it is validated
 * structurally BEFORE it reaches the bus: a malformed patch comes back as a diagnostic,
 * never as a raw throw or an unhandled rejection (§V66).
 *
 * The patch-operation SHAPE is no longer this boundary's own. It used to be — with a
 * comment saying it "mirrors `@domain/types/patch.ts` exactly and must be updated with
 * it" — and it did not: six operations from four separate tasks landed in the domain
 * union and never arrived here, so `setNodeSize`, `reorderEdges` and the whole group and
 * viewport family existed in the document and were unreachable for an agent. A mirror
 * maintained by remembering is a mirror that drifts, and nothing failed when it did.
 * `graphPatchOperationSchema` in `src/domain/types/schemas.ts` is now the one shape, and
 * `patch-ops.test.ts` proves it covers the TypeScript union exactly.
 *
 * What stays here is POLICY, which is a different thing from shape and is the reason
 * this file still has an opinion at all — see the refinement below.
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

/**
 * What a parameter may be SET to, through the single-edit tools (T314, §V107, §V215).
 *
 * `StoredParameter`, not `ParameterValue`: a parameter is a mode envelope as well as a
 * value, and it has been since T202. This took a bare value until now, so an agent could
 * write a NUMBER and could not write the EXPRESSION that produces one — through the tool
 * named for setting parameters, while `apply_graph_patch` (which shares the document's
 * own operation schema) accepted both. A mode V107 promises every parameter has was
 * reachable by one agent route and not the other, which is a difference nobody chose.
 *
 * T1207 — AND THE MODES ARE NAMED HERE, because five bare enum values were all an agent
 * ever got. One picked `bind` for a cross-node reference (it is the one name that sounds
 * like "connect to a source" and it means the opposite), and nothing in this surface
 * could have told it otherwise. What each mode REACHES is the whole distinction, so that
 * is what the sentence carries — one clause each, paid on every `tools/list`.
 */
export const PARAMETER_MODES =
  "A parameter is either a bare value or a mode envelope {mode, bindings}. " +
  "What each mode can reach: `static` a literal; " +
  "`expression` any node, in Loom's own grammar (`op('constant1').par.value` for a parameter, " +
  "`op('lfo1').chan.value` for a published channel) plus `time`, `abstime`, maths; " +
  "`bind` a parameter ALREADY IN SCOPE — a sibling on this same node (`radius`, `color.r`) " +
  "or `parent.<key>` inside a component — and NOTHING on another node; " +
  "`map` a per-point attribute on a points input; " +
  "`driven` is RETIRED and refused here — a channel read is an expression, `op('lfo1').chan.value`.";

/**
 * T1208 — `driven` IS REFUSED AT THIS BOUNDARY, and the owner's question is why it needed
 * to be: *"we should have absolutely and totally removed that. How can the agent still do
 * that?"*
 *
 * §T897 retired the mode and put three guards on it — it is off the mode buttons
 * (`AUTHORABLE_PARAMETER_MODES`), `parameter.setMode` refuses switching into it, and a
 * loaded document is upgraded (`upgradeDrivenSlot`, one mapping, parse forever emit never).
 * Every one of those sits on a route that changes ONE mode. A patch writes the WHOLE SLOT
 * in a single operation and asks none of them, so the surface that publishes the mode enum
 * was also the one surface that would still take it.
 *
 * ⚠ WHY HERE AND NOT IN THE DOMAIN VALIDATOR, WHICH WOULD COVER EVERY ENTRANCE. Measured
 * before choosing: `driven` slots are still authored through `graph.applyPatch` by ~10 test
 * files across four tracks, because the RESOLVER still reads the mode (`resolve.ts` case
 * "driven"), as do liveness, parameter-dependencies, names and the reference lines.
 * Refusing the write while nine other files still speak the mode is half a removal, and it
 * breaks its own suite. The total removal the owner asked for is a real piece of work with
 * a versioned-load decision in it; this closes the AGENT hole he actually reported, and the
 * residual is named rather than implied.
 *
 * The refusal carries the replacement, built from the caller's own channel through the same
 * mapping the load-time upgrade uses (T1207: a refusal with no next move is a dead end).
 */
function drivenRefusal(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const slot = value as { mode?: unknown; bindings?: Record<string, unknown> };
  if (slot.mode !== "driven") return null;
  const binding = slot.bindings?.["driven"] as { channel?: unknown } | undefined;
  const channel = typeof binding?.channel === "string" ? binding.channel : null;
  const replacement = channel === null ? "op('name').chan.value" : channelExpression(channel);
  return `The "driven" mode is retired (§T897). Use expression mode with source ${replacement}.`;
}

function refuseDrivenSlots(
  values: Record<string, unknown>,
  context: z.RefinementCtx,
  path: readonly (string | number)[] = [],
): void {
  for (const key of Object.keys(values).sort()) {
    const message = drivenRefusal(values[key]);
    if (message !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message, path: [...path, key] });
    }
  }
}

// `.describe` INSIDE the refinement: `zodToJsonSchema` unwraps a `ZodEffects` to its inner
// schema without carrying the wrapper's description, so a description on the outside would
// publish as nothing at all — the exact silence T1207 is about.
const parameters = z
  .record(storedParameterSchema)
  .describe(PARAMETER_MODES)
  .superRefine((values, context) => {
    refuseDrivenSlots(values, context);
  });

/**
 * The domain's operation shape, plus the one rule that is specific to an AGENT.
 *
 * §V35: a `$temp` ref is minted by `applyGraphPatch` and handed back in `createdIds`. A
 * bare ref means "create this exact id", which the domain permits — a migration or a
 * fixture legitimately restores known ids. An agent must not: choosing its own ids lets
 * it collide with, or impersonate, entities it did not create. The domain schema is the
 * shape; this refinement is the boundary's policy, stated once and testable, rather than
 * a divergence hidden inside a second copy of seventeen operations.
 */
export const graphPatchOperationSchema = domainGraphPatchOperationSchema
  .refine(
    (operation) =>
      (operation.op !== "addNode" && operation.op !== "addGroup") || operation.ref.startsWith("$"),
    { message: "A patch-local ref must start with `$`.", path: ["ref"] },
  )
  // T1208: the same refusal on the OTHER agent route. `apply_graph_patch` carries the
  // document's own operation schema, so a rule stated only on the convenience tools' record
  // above would be a rule with a door beside it — which is how `driven` survived §T897.
  .superRefine((operation, context) => {
    const carrying = operation as { parameters?: Record<string, unknown> };
    if (carrying.parameters === undefined) return;
    refuseDrivenSlots(carrying.parameters, context, ["parameters"]);
  });

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

/**
 * T1211 — the shipped corpus. `tag` is §T1162's DERIVED vocabulary, not a free-text search:
 * the listing publishes every tag with its meaning, so the filter is enumerable rather than
 * guessed. Left open as a string rather than pinned to a `z.enum` here because the tag set is
 * derived from the node registry one module away, and a second copy of it in this file is the
 * "two lists that agree until someone edits one" §T1162 exists to refuse.
 */
export const listExamplesInput = z
  .object({
    tag: z.string().min(1).optional(),
    /** §V93: an example is OPENED, a component is INSTANTIATED. Different verbs. */
    kind: z.enum(["example", "component"]).optional(),
  })
  .strict();

export const getExampleInput = z
  .object({
    /** A `fileName` from `list_examples`, e.g. `E13-Prism.loom.json`. */
    fileName: z.string().min(1),
    includeParameters: z.boolean().optional(),
  })
  .strict();

export const getDiagnosticsInput = z
  .object({ severity: z.enum(["info", "warning", "error"]).optional(), limit: z.number().int().positive().max(500).optional() })
  .strict();

export const describeOutputInput = z
  .object({
    nodeId: z.string().min(1),
    portId: z.string().min(1).optional(),
  })
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
    /**
     * T280: place next to an existing node instead of inventing coordinates — the
     * agent-ergonomic default for building a chain left to right. Ignored when an
     * explicit position is given.
     */
    placement: z
      .object({
        relativeTo: z.string().min(1),
        direction: z.enum(["right", "below", "left", "above"]).optional(),
      })
      .strict()
      .optional(),
    parameters: parameters.optional(),
    baseRevision,
    dryRun,
  })
  .strict();

export const layoutGraphInput = z
  .object({
    /** Restrict the tidy to these nodes; absent = the whole document. */
    nodeIds: z.array(z.string().min(1)).optional(),
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

/**
 * T542: the file itself, as bytes. A PATH would only be readable on the headless stdio
 * twin — the page cannot open one — and a tool that works on one transport is the split
 * V39 exists to prevent. Base64 travels every transport; the tool turns it into a
 * session object URL exactly the way the file picker does.
 */
export const attachAssetInput = z
  .object({
    nodeId: z.string().min(1),
    /** The asset parameter to bind. Omitted: the node's ONE asset parameter, refused by name when ambiguous. */
    parameter: z.string().min(1).optional(),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    dataBase64: z.string().min(1),
    baseRevision,
    dryRun,
  })
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
export type ListExamplesInput = z.infer<typeof listExamplesInput>;
export type GetExampleInput = z.infer<typeof getExampleInput>;
export type GetDiagnosticsInput = z.infer<typeof getDiagnosticsInput>;
export type AddNodeInput = z.infer<typeof addNodeInput>;
export type DescribeOutputInput = z.infer<typeof describeOutputInput>;
export type LayoutGraphInput = z.infer<typeof layoutGraphInput>;
export type RemoveNodesInput = z.infer<typeof removeNodesInput>;
export type ConnectPortsInput = z.infer<typeof connectPortsInput>;
export type DisconnectPortsInput = z.infer<typeof disconnectPortsInput>;
export type SetParametersInput = z.infer<typeof setParametersInput>;
export type SetShaderSourceInput = z.infer<typeof setShaderSourceInput>;
export type AttachAssetInput = z.infer<typeof attachAssetInput>;
export type SetOutputInput = z.infer<typeof setOutputInput>;
export type ResetFeedbackInput = z.infer<typeof resetFeedbackInput>;
export type HistoryInput = z.infer<typeof historyInput>;
export type SaveProjectInput = z.infer<typeof saveProjectInput>;
