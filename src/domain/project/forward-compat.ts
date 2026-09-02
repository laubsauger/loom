import { z } from "zod";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import {
  assetReferenceSchema,
  graphDocumentSchema,
  graphEdgeSchema,
  graphGroupSchema,
  graphNodeSchema,
  nodeFormatOverrideSchema,
  nodeResolutionOverrideSchema,
  projectDocumentSchema,
  projectSettingsSchema,
  storedParameterSchema,
} from "../types/schemas.ts";

/**
 * The forward-compatibility passthrough lane (T91, §V68, §V69, §V10).
 *
 * `src/domain/types/schemas.ts` describes what THIS build writes. That is the right shape
 * for validating a patch, and the wrong shape for reading a file: it is closed, so one
 * parameter written by a later build in a form this build has never heard of fails the
 * whole-document parse and the user loses a project over a field nobody needed to read.
 *
 * So the file boundary gets its own, wider door. It is DERIVED from the closed schemas
 * rather than retyped, so the two cannot drift apart, and it widens exactly four things:
 *
 *  1. unknown keys survive on every object (`.passthrough()` instead of zod's strip) —
 *     including keys we would otherwise not even see, like a later build's project-level
 *     field;
 *  2. a parameter value is accepted whatever shape it has, so the coming
 *     `{kind:"static", value}` envelope and every reserved bound kind after it (§V69)
 *     load today, unread and unharmed;
 *  3. an unknown resolution or format MODE is preserved verbatim, while a mode this build
 *     does know must still be well-formed — a broken `fixed` override is a bug in a shape
 *     we own, not a message from the future;
 *  4. an unknown node TYPE is not this schema's business at all: it parses like any other
 *     node and the loader turns it into a placeholder that keeps its data (§V10).
 *
 * Widening the door is only half of §V68. The other half is that the writer emits back
 * exactly what came in, which is `serializeProjectDocument`'s deterministic sorted-key
 * output over the very object this schema returned — no re-derivation, no field list.
 */

const KNOWN_RESOLUTION_MODES = new Set(nodeResolutionOverrideSchema.options.map((o) => o.shape.mode.value));
const KNOWN_FORMAT_MODES = new Set(nodeFormatOverrideSchema.options.map((o) => o.shape.mode.value));

/**
 * A mode this build has never heard of, kept as-is.
 *
 * The refinement matters: without it the open branch would also swallow a MALFORMED known
 * mode (a `fixed` override with a negative width), turning a real validation failure into
 * silent forward-compat passthrough.
 */
const unknownMode = (known: ReadonlySet<string>) =>
  z
    .object({ mode: z.string().min(1) })
    .passthrough()
    .refine((value) => !known.has(value.mode), {
      message: "not a valid override for a mode this build knows",
    });

const openResolutionOverride = z.union([nodeResolutionOverrideSchema, unknownMode(KNOWN_RESOLUTION_MODES)]);
const openFormatOverride = z.union([nodeFormatOverrideSchema, unknownMode(KNOWN_FORMAT_MODES)]);

/**
 * Parameter values are read as opaque JSON here on purpose.
 *
 * Whether a value is one this build understands is a question with a useful answer
 * (`classifyUnknownParameters` below reports it, and the UI can mark such a control
 * unresolved) — but it is never a reason to refuse the document (§V69).
 */
export const openParameterValueSchema = z.unknown();

export const openGraphNodeSchema = graphNodeSchema
  .extend({
    parameters: z.record(openParameterValueSchema),
    resolution: openResolutionOverride.optional(),
    format: openFormatOverride.optional(),
    ui: graphNodeSchema.shape.ui.unwrap().passthrough().optional(),
  })
  .passthrough();

export const openGraphDocumentSchema = graphDocumentSchema
  .extend({
    nodes: z.record(openGraphNodeSchema),
    edges: z.record(graphEdgeSchema.passthrough()),
    groups: z.record(graphGroupSchema.passthrough()),
  })
  .passthrough();

export const openProjectSettingsSchema = projectSettingsSchema
  .extend({ limits: projectSettingsSchema.shape.limits.passthrough() })
  .passthrough();

export const openProjectDocumentSchema = projectDocumentSchema
  .extend({
    graph: openGraphDocumentSchema,
    settings: openProjectSettingsSchema,
    assets: z.array(assetReferenceSchema.passthrough()),
  })
  .passthrough();

export interface UnknownParameter {
  nodeId: NodeId;
  key: string;
  /** Present when the value is an object carrying a `kind` — the §V69 envelope shape. */
  kind?: string;
}

/**
 * Parameter values this build cannot interpret, in document order.
 *
 * Reported, not removed. The point of the list is that the resolver (§V61) and the
 * inspector can show "set by a newer version of Loom" instead of rendering a
 * control over a value they would misread.
 */
export function classifyUnknownParameters(graph: GraphDocument): UnknownParameter[] {
  const unknown: UnknownParameter[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    for (const key of Object.keys(node.parameters).sort()) {
      const value: unknown = node.parameters[key];
      // A mode envelope (T202) is a shape this build understands; only a slot whose
      // bindings carry kinds we do not know falls through to the unknown lane.
      if (storedParameterSchema.safeParse(value).success) continue;
      const kind = readKind(value);
      unknown.push({ nodeId, key, ...(kind === undefined ? {} : { kind }) });
    }
  }
  return unknown;
}

export function unknownParameterDiagnostics(
  unknown: readonly UnknownParameter[],
): RuntimeDiagnostic[] {
  const byNode = new Map<NodeId, UnknownParameter[]>();
  for (const entry of unknown) {
    const existing = byNode.get(entry.nodeId);
    if (existing === undefined) byNode.set(entry.nodeId, [entry]);
    else existing.push(entry);
  }
  return [...byNode.entries()].map(([nodeId, entries]) => ({
    severity: "info" as const,
    code: "project.parameter.unknownKind",
    message: `${entries.length === 1 ? "Parameter" : "Parameters"} ${entries
      .map((entry) => (entry.kind === undefined ? `"${entry.key}"` : `"${entry.key}" (${entry.kind})`))
      .join(", ")} ${entries.length === 1 ? "uses a form" : "use forms"} this build does not understand.`,
    nodeId,
    suggestion: "The value is kept exactly as saved and written back unchanged (§V68, §V69).",
  }));
}

function readKind(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = (value as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : undefined;
}
