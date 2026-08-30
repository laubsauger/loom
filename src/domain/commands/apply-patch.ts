import { SELECTABLE_COLOR_FORMATS } from "../types/node-definition.ts";
import { graphPatchSchema, nodeFormatOverrideSchema, nodeResolutionOverrideSchema } from "../types/schemas.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { EdgeId, GroupId, NodeId, PortId } from "../types/ids.ts";
import { MIN_NODE_SIZE } from "../types/graph.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type {
  GraphPatch,
  GraphPatchOperation,
  GraphPatchResult,
  NodeRef,
  TempId,
} from "../types/patch.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { arePortsCompatible, describePortType } from "../graph/port-compat.ts";
import {
  countNodeNameReferences,
  nameBaseFor,
  resolveRename,
  rewriteNodeNameReferences,
  uniqueNodeName,
} from "../graph/names.ts";
import { defaultParameters, validateParameters } from "../parameters/validate.ts";
import { bindCycleDiagnostics } from "../parameters/bind-cycles.ts";
import type { CommandContext, CommandOutcome } from "./bus.ts";
import { isValueOnlyPatch, overlappingEntities } from "./patch-scope.ts";

/**
 * `graph.applyPatch` — the atomic graph mutation (§I.patch, T55).
 *
 * One patch is one transaction and one undo group (§V32, §V34). Operations are executed
 * in order against an immer draft; the first error throws, immer discards the draft, and
 * the document is left byte-identical to what it was (§V32). Patch-local `$temp` ids are
 * minted into stable ids and handed back in `createdIds`, which is what lets an agent add
 * three nodes and wire them together in a single request (§V35).
 *
 * Three rules that are easy to get subtly wrong live here:
 *
 *  - **Input is untrusted (§V66, §V37).** The patch is parsed with zod BEFORE anything
 *    reads a field off it. Compile-time types say nothing about what an agent, an MCP
 *    server or a replayed file actually sent, and `{op:"addNode"}` with no position used
 *    to throw a raw TypeError out of the handler: no diagnostic, no audit entry, an
 *    unhandled rejection at the caller. A malformed patch is now a rejection like any
 *    other, which means the bus writes its audit entry (§V31).
 *  - **A stale base is a conflict only on real overlap (§V33, T107).** See `patch-scope.ts`.
 *  - **A dry run mints nothing (§V36, T102).** It answers `"validated"`, not `"applied"`,
 *    and hands back no ids — ids minted by a validation pass are ids nobody created.
 *
 * ## Groups and the viewport (T104)
 *
 * Group operations are fully undoable: `UndoGroup` records per-entity before/after for
 * `groups` exactly as it does for nodes and edges, so creating, editing and deleting a
 * group round-trips through undo/redo like any other edit.
 *
 * `setViewport` does NOT. `GraphDocument.viewport` is document state — it is serialized,
 * so a project reopens where it was left — but it has no entity identity, so the store's
 * undo group has nowhere to record it and undoing a viewport-only patch restores no
 * framing. Making that work needs a `viewport` change record in `GraphStore` (owned by
 * the store's track), and it is a deliberate open question whether it SHOULD: in most
 * editors panning is not an undo step. Until then the honest statement is the one above.
 */

/** Parameter key a shader-authorable node exposes its WGSL through. */
export const SHADER_SOURCE_PARAMETER = "source";

const UI_KEYS = new Set(["collapsed", "preview", "bypassed", "muted", "color"]);

class PatchAbort extends Error {
  constructor() {
    super("patch aborted");
    this.name = "PatchAbort";
  }
}

function isTempId(ref: NodeRef): ref is TempId {
  return ref.startsWith("$");
}

interface PatchRun {
  diagnostics: RuntimeDiagnostic[];
  createdIds: Record<string, string>;
  /** A dry run resolves temp refs against provisional ids it never hands back (§V36). */
  dryRun: boolean;
}

export function applyGraphPatch(
  patch: GraphPatch,
  context: CommandContext,
): CommandOutcome<GraphPatchResult> {
  const current = context.store.getRevision();

  // §V66: structural validation first, before any field is read. Everything below this
  // point may assume the shape it declares; nothing above it may assume anything.
  const parsed = graphPatchSchema.safeParse(patch);
  if (!parsed.success) {
    return rejected(current, malformedDiagnostics(parsed.error.issues));
  }

  const staleness = staleBaseOutcome(patch, context, current);
  if (staleness.kind === "conflict") {
    return {
      status: "conflict",
      revision: current,
      diagnostics: staleness.diagnostics,
      output: {
        status: "conflict",
        revision: current,
        appliedOperations: 0,
        diagnostics: staleness.diagnostics,
        createdIds: {},
      },
    };
  }

  const run: PatchRun = { diagnostics: [...staleness.diagnostics], createdIds: {}, dryRun: context.dryRun };

  let applied;
  try {
    applied = context.apply({
      label: patch.label ?? "Apply patch",
      recipe: (draft) => {
        for (const [index, operation] of patch.operations.entries()) {
          executeOperation(operation, index, draft, context.registry, context.ids, run);
        }
      },
    });
  } catch (thrown) {
    if (!(thrown instanceof PatchAbort)) throw thrown;
    // Nothing was written: immer discarded the draft (§V32).
    return rejected(current, run.diagnostics);
  }

  if (context.dryRun) {
    // §V36/T102: validated — NOT "applied", and no ids. The provisional ids the run used
    // to resolve `$temp` refs against its scratch draft die with the draft; handing them
    // back would let a caller cache references to nodes nobody ever created, and the
    // real apply would mint different ones.
    const diagnostics: RuntimeDiagnostic[] = [
      ...run.diagnostics,
      {
        severity: "info",
        code: "patch.dryRun",
        message: `Dry run: ${patch.operations.length} operation(s) validated, nothing was applied and no ids were minted.`,
        suggestion: "Call again without dryRun to apply; read the stable ids from that result.",
      },
    ];
    return {
      status: "validated",
      revision: current,
      diagnostics,
      output: {
        status: "validated",
        revision: current,
        appliedOperations: patch.operations.length,
        diagnostics,
        createdIds: {},
      },
    };
  }

  const output: GraphPatchResult = {
    status: "applied",
    revision: applied.revision,
    appliedOperations: patch.operations.length,
    diagnostics: run.diagnostics,
    createdIds: run.createdIds,
    ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
  };

  return {
    status: "applied",
    revision: applied.revision,
    diagnostics: run.diagnostics,
    output,
    ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }),
  };
}

/**
 * Zod issues as diagnostics (§V66, §V37).
 *
 * The path is reported — `operations.2.position.x` is the only thing that makes a
 * rejected batch fixable — and the issue's own message is used only for the small set of
 * checks this schema authors. Nothing quotes the offending VALUE: patch content is
 * untrusted document text and a diagnostic is read by a model (§V37).
 */
function malformedDiagnostics(issues: readonly { path: (string | number)[]; message: string; code: string }[]): RuntimeDiagnostic[] {
  const capped = issues.slice(0, 10);
  const diagnostics = capped.map<RuntimeDiagnostic>((issue) => ({
    severity: "error",
    code: "patch.malformed",
    message: `Patch is structurally invalid at ${issue.path.join(".") || "(root)"}: ${issue.code}.`,
    suggestion: issue.message,
  }));
  if (issues.length > capped.length) {
    diagnostics.push({
      severity: "error",
      code: "patch.malformed",
      message: `${issues.length - capped.length} further structural problem(s) were not listed.`,
    });
  }
  return diagnostics;
}

type StalenessOutcome =
  | { kind: "conflict"; diagnostics: RuntimeDiagnostic[] }
  | { kind: "proceed"; diagnostics: RuntimeDiagnostic[] };

/**
 * §V33 / T107: decides whether a base revision that is not the current one is a conflict.
 *
 * A patch built against a LATER revision than the document has is always refused — it was
 * built against a document this store has never seen, so there is nothing to compare.
 * A patch built against an earlier one is refused only when it touches an entity that has
 * changed since. Nothing is rebased either way: an applied patch is applied verbatim
 * against the current document, and every precondition is re-checked below.
 */
function staleBaseOutcome(
  patch: GraphPatch,
  context: CommandContext,
  current: number,
): StalenessOutcome {
  if (patch.baseRevision === current) return { kind: "proceed", diagnostics: [] };

  if (patch.baseRevision > current) {
    return {
      kind: "conflict",
      diagnostics: [
        {
          severity: "error",
          code: "patch.conflict",
          message: `Patch was built against revision ${patch.baseRevision}, which is ahead of this document at ${current}.`,
          suggestion: "Read the current revision with the graph.get query and rebuild the patch.",
        },
      ],
    };
  }

  const overlapping = overlappingEntities(
    patch.operations,
    context.graph,
    context.store.getState().owners,
    patch.baseRevision,
  );

  if (overlapping.length > 0) {
    return {
      kind: "conflict",
      diagnostics: [
        {
          severity: "error",
          code: "patch.conflict",
          message: `Patch was built against revision ${patch.baseRevision}, the document is at ${current}, and ${overlapping.length} entity it touches changed in between: ${overlapping.join(", ")}.`,
          suggestion: "Re-read those entities and rebuild the patch; nothing is rebased for you (§V33).",
        },
      ],
    };
  }

  return {
    kind: "proceed",
    diagnostics: [
      {
        severity: "info",
        code: "patch.staleBase",
        message: `Patch was built against revision ${patch.baseRevision} and the document is at ${current}, but no entity it touches changed in between, so it was applied as written (${isValueOnlyPatch(patch.operations) ? "value-only" : "structural"} patch).`,
      },
    ],
  };
}

function rejected(revision: number, diagnostics: RuntimeDiagnostic[]): CommandOutcome<GraphPatchResult> {
  return {
    status: "rejected",
    revision,
    diagnostics,
    output: {
      status: "rejected",
      revision,
      appliedOperations: 0,
      diagnostics,
      createdIds: {},
    },
  };
}

function executeOperation(
  operation: GraphPatchOperation,
  index: number,
  draft: GraphDocument,
  registry: NodeRegistryView,
  ids: { node: () => string; edge: () => string; group: () => string },
  run: PatchRun,
): void {
  /**
   * §V36/T102: a dry run resolves its own temp refs against provisional ids so the rest
   * of the patch can be validated, but it never draws from the real id factory — a
   * validation pass that consumes ids makes the subsequent real apply produce a
   * different id set, which is the phantom-id hazard in the first place.
   */
  const mint = (kind: "node" | "edge" | "group", key: string): string =>
    run.dryRun ? `pending-${kind}-${key}` : ids[kind]();

  const fail = (code: string, message: string, extra?: Partial<RuntimeDiagnostic>): never => {
    run.diagnostics.push({
      severity: "error",
      code,
      message: `Operation ${index} (${operation.op}): ${message}`,
      ...extra,
    });
    throw new PatchAbort();
  };

  const resolveNodeId = (ref: NodeRef): NodeId => {
    if (isTempId(ref)) {
      const resolved = run.createdIds[ref];
      if (resolved === undefined) {
        fail("patch.unresolvedRef", `temp id "${ref}" was never created by an earlier operation.`);
      }
      return resolved as NodeId;
    }
    return ref;
  };

  const requireNode = (ref: NodeRef): GraphNode => {
    const nodeId = resolveNodeId(ref);
    const node = draft.nodes[nodeId];
    if (node === undefined) fail("node.missing", `node "${nodeId}" does not exist.`, { nodeId });
    return node as GraphNode;
  };

  switch (operation.op) {
    case "addNode": {
      const definition = registry.get(operation.type);
      if (definition === undefined) {
        fail("node.unknownType", `unknown node type "${operation.type}".`, {
          suggestion: "Call the list_node_definitions query for the registered types.",
        });
        return;
      }

      let nodeId: NodeId;
      if (isTempId(operation.ref)) {
        if (run.createdIds[operation.ref] !== undefined) {
          fail("patch.duplicateRef", `temp id "${operation.ref}" was already used in this patch.`);
        }
        nodeId = mint("node", operation.ref);
        run.createdIds[operation.ref] = nodeId;
      } else {
        nodeId = operation.ref;
      }

      if (draft.nodes[nodeId] !== undefined) {
        fail("node.duplicate", `node "${nodeId}" already exists.`, { nodeId });
      }

      const provided = operation.parameters ?? {};
      const invalid = validateParameters(definition.parameters, provided, nodeId);
      if (invalid.length > 0) {
        run.diagnostics.push(...invalid);
        throw new PatchAbort();
      }

      draft.nodes[nodeId] = {
        id: nodeId,
        type: definition.type,
        definitionVersion: definition.version,
        position: { x: operation.position.x, y: operation.position.y },
        parameters: { ...defaultParameters(definition.parameters), ...provided },
        // §V129: the label is the NAME — unique per graph, auto-numbered at creation
        // (`noise1`, `noise2`), which is what makes `op('name')` references resolvable.
        label: uniqueNodeName(draft, nameBaseFor(definition.type)),
      };
      return;
    }

    case "removeNodes": {
      const targets = [...new Set(operation.nodeIds)].sort();
      for (const nodeId of targets) {
        if (draft.nodes[nodeId] === undefined) {
          fail("node.missing", `node "${nodeId}" does not exist.`, { nodeId });
        }
      }
      const doomed = new Set(targets);
      // §V40: incident edges go with the node, in sorted id order, so every actor
      // computes exactly the same resulting document.
      for (const edgeId of Object.keys(draft.edges).sort()) {
        const edge = draft.edges[edgeId];
        if (edge === undefined) continue;
        if (doomed.has(edge.source.nodeId) || doomed.has(edge.target.nodeId)) {
          delete draft.edges[edgeId];
        }
      }
      for (const groupId of Object.keys(draft.groups).sort()) {
        const group = draft.groups[groupId];
        if (group === undefined) continue;
        const members = group.members.filter((member) => !doomed.has(member));
        if (members.length !== group.members.length) group.members = members;
      }
      for (const nodeId of targets) delete draft.nodes[nodeId];
      return;
    }

    case "connect": {
      const sourceNode = requireNode(operation.source.nodeId);
      const targetNode = requireNode(operation.target.nodeId);

      const sourcePort = registry.port(sourceNode.type, operation.source.portId, "output");
      if (sourcePort === undefined) {
        fail(
          "port.missing",
          `"${sourceNode.type}" has no output port "${operation.source.portId}".`,
          { nodeId: sourceNode.id, portId: operation.source.portId },
        );
        return;
      }
      const targetPort = registry.port(targetNode.type, operation.target.portId, "input");
      if (targetPort === undefined) {
        fail(
          "port.missing",
          `"${targetNode.type}" has no input port "${operation.target.portId}".`,
          { nodeId: targetNode.id, portId: operation.target.portId },
        );
        return;
      }

      // §V13: exact type match. A near miss is a missing conversion node, not a cast.
      if (!arePortsCompatible(sourcePort.type, targetPort.type)) {
        fail(
          "port.incompatible",
          `cannot connect ${describePortType(sourcePort.type)} to ${describePortType(targetPort.type)}.`,
          {
            nodeId: targetNode.id,
            portId: targetPort.id,
            suggestion: "Insert an explicit conversion node; there is no implicit conversion (§V13).",
          },
        );
      }

      const incoming = incomingEdges(draft, targetNode.id, targetPort.id);
      // §V14: one edge per input unless the port declares itself variadic.
      if (targetPort.variadic !== true && incoming.length > 0) {
        fail(
          "port.occupied",
          `input "${targetPort.id}" on "${targetNode.id}" already has an incoming edge.`,
          {
            nodeId: targetNode.id,
            portId: targetPort.id,
            suggestion: "Disconnect the existing edge first, or use a variadic input.",
          },
        );
      }
      const duplicate = incoming.some(
        (edge) =>
          edge.source.nodeId === sourceNode.id && edge.source.portId === operation.source.portId,
      );
      if (duplicate) {
        fail("edge.duplicate", `that exact connection already exists.`, {
          nodeId: targetNode.id,
          portId: targetPort.id,
        });
      }

      let edgeId: EdgeId;
      if (operation.ref !== undefined) {
        if (run.createdIds[operation.ref] !== undefined) {
          fail("patch.duplicateRef", `temp id "${operation.ref}" was already used in this patch.`);
        }
        edgeId = mint("edge", operation.ref);
        run.createdIds[operation.ref] = edgeId;
      } else {
        edgeId = mint("edge", `op${index}`);
      }

      draft.edges[edgeId] = {
        id: edgeId,
        source: { nodeId: sourceNode.id, portId: operation.source.portId },
        target: { nodeId: targetNode.id, portId: operation.target.portId },
      };
      return;
    }

    case "disconnect": {
      for (const edgeId of [...new Set(operation.edgeIds)].sort()) {
        if (draft.edges[edgeId] === undefined) {
          fail("edge.missing", `edge "${edgeId}" does not exist.`);
        }
        delete draft.edges[edgeId];
      }
      return;
    }

    case "setParameters": {
      const node = requireNode(operation.nodeId);
      const definition = registry.get(node.type);
      if (definition === undefined) {
        fail(
          "node.unknownType",
          `node "${node.id}" has unknown type "${node.type}" and is a placeholder.`,
          {
            nodeId: node.id,
            suggestion: "Install the node package that defines this type before editing it (§V10).",
          },
        );
        return;
      }
      const invalid = validateParameters(definition.parameters, operation.parameters, node.id);
      if (invalid.length > 0) {
        run.diagnostics.push(...invalid);
        throw new PatchAbort();
      }
      for (const [key, value] of Object.entries(operation.parameters)) {
        node.parameters[key] = value as StoredParameter;
      }
      // §V110: a bind cycle is refused at the moment it is written — checked on the
      // MERGED result, because the loop may close through a parameter this patch never
      // touched. The draft is discarded whole, so the document can never hold one.
      const cycles = bindCycleDiagnostics(node, definition.parameters);
      if (cycles.length > 0) {
        run.diagnostics.push(...cycles);
        throw new PatchAbort();
      }
      return;
    }

    case "setShaderSource": {
      const node = requireNode(operation.nodeId);
      const definition = registry.get(node.type);
      const parameter = definition?.parameters[SHADER_SOURCE_PARAMETER];
      if (definition === undefined || parameter === undefined || parameter.type !== "string") {
        fail(
          "node.notShaderAuthorable",
          `node type "${node.type}" has no "${SHADER_SOURCE_PARAMETER}" string parameter.`,
          { nodeId: node.id },
        );
      }
      node.parameters[SHADER_SOURCE_PARAMETER] = operation.source;
      return;
    }

    case "moveNodes": {
      for (const nodeId of Object.keys(operation.positions).sort()) {
        const position = operation.positions[nodeId];
        if (position === undefined) continue;
        const node = draft.nodes[nodeId];
        if (node === undefined) {
          fail("node.missing", `node "${nodeId}" does not exist.`, { nodeId });
          return;
        }
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
          fail("node.position", `position for "${nodeId}" is not finite.`, { nodeId });
        }
        node.position = { x: position.x, y: position.y };
      }
      return;
    }

    case "setNodeSize": {
      const node = requireNode(operation.nodeId);
      // null clears it: absence IS "size yourself from your content", so a cleared node
      // goes back to the default box rather than being stuck at whatever it was dragged
      // to once.
      if (operation.size === null) {
        delete node.size;
        return;
      }
      const { width, height } = operation.size;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        fail("node.size.invalid", `size for "${node.id}" must be positive and finite.`, {
          nodeId: node.id,
        });
      }
      // §V116's floor, clamped rather than rejected: the gesture's intent is "smaller",
      // and refusing the whole patch because the user overshot by a pixel would also
      // throw away the position half of the same drag (§V32).
      node.size = {
        width: Math.max(MIN_NODE_SIZE.width, Math.round(width)),
        height: Math.max(MIN_NODE_SIZE.height, Math.round(height)),
      };
      return;
    }

    case "setNodeUi": {
      const node = requireNode(operation.nodeId);
      const ui: Record<string, unknown> = { ...(node.ui ?? {}) };
      for (const [key, value] of Object.entries(operation.ui)) {
        if (!UI_KEYS.has(key)) {
          fail("node.ui.unknown", `unknown ui key "${key}".`, {
            nodeId: node.id,
            suggestion: `Known keys: ${[...UI_KEYS].sort().join(", ")}.`,
          });
        }
        if (key === "color") {
          if (typeof value !== "string") fail("node.ui.type", `ui.color must be a string.`, { nodeId: node.id });
        } else if (typeof value !== "boolean") {
          fail("node.ui.type", `ui.${key} must be a boolean.`, { nodeId: node.id });
        }
        ui[key] = value;
      }
      node.ui = ui as NonNullable<GraphNode["ui"]>;
      return;
    }

    case "setNodeLabel": {
      const node = requireNode(operation.nodeId);
      // null clears it: absence IS "follow the definition's title", so a cleared node
      // keeps tracking the definition if that is later retitled. Clearing also makes
      // the node unaddressable by name — references it had are reported, not rewritten.
      if (operation.label === null) {
        const cleared = node.label;
        delete node.label;
        if (cleared !== undefined) {
          const stranded = countNodeNameReferences(draft, cleared);
          if (stranded > 0) {
            run.diagnostics.push({
              severity: "warning",
              code: "node.name.stranded",
              message: `Clearing the name "${cleared}" strands ${stranded} expression reference(s) to it.`,
              nodeId: node.id,
              suggestion: "Rename instead of clearing, or update the expressions.",
            });
          }
        }
        return;
      }
      const label = operation.label.trim();
      if (label === "") {
        fail("node.label.empty", "a node label may not be blank.", {
          nodeId: node.id,
          suggestion: "Pass null to clear the label and fall back to the definition title.",
        });
      }
      if (label.length > 120) {
        fail("node.label.tooLong", `label is ${label.length} characters; the limit is 120.`, {
          nodeId: node.id,
        });
      }
      // §V129: a collision auto-suffixes rather than rejects — the word is the user's
      // intent, the number is bookkeeping. §V128: the rename rewrites every stored
      // reference to the old name IN THIS SAME PATCH, so a rename never silently breaks
      // an expression; both adjustments are reported, never silent.
      const previous = node.label;
      const resolved = resolveRename(draft, label, node.id);
      node.label = resolved;
      if (resolved !== label) {
        run.diagnostics.push({
          severity: "info",
          code: "node.name.suffixed",
          message: `"${label}" is taken; the node is named "${resolved}".`,
          nodeId: node.id,
        });
      }
      if (previous !== undefined && previous !== resolved) {
        const rewritten = rewriteNodeNameReferences(draft, previous, resolved);
        if (rewritten > 0) {
          run.diagnostics.push({
            severity: "info",
            code: "node.name.referencesRewritten",
            message: `Renamed "${previous}" to "${resolved}"; ${rewritten} expression reference(s) updated.`,
            nodeId: node.id,
          });
        }
      }
      return;
    }

    case "setNodeResolution": {
      const node = requireNode(operation.nodeId);
      // null clears the override, returning the node to its definition's policy (§V50).
      if (operation.resolution === null) {
        delete node.resolution;
        return;
      }
      const parsed = nodeResolutionOverrideSchema.safeParse(operation.resolution);
      if (!parsed.success) {
        fail("node.resolution.invalid", `invalid resolution override: ${parsed.error.issues[0]?.message ?? "bad shape"}.`, {
          nodeId: node.id,
          suggestion: 'Use {mode:"auto"|"project"|"input"|"scale"|"fixed"}; scale needs a positive factor, fixed needs positive integer width/height.',
        });
      }
      node.resolution = operation.resolution;
      return;
    }

    case "setNodeFormat": {
      const node = requireNode(operation.nodeId);
      if (operation.format === null) {
        delete node.format;
        return;
      }
      const parsed = nodeFormatOverrideSchema.safeParse(operation.format);
      if (!parsed.success) {
        fail("node.format.invalid", `invalid format override: ${parsed.error.issues[0]?.message ?? "bad shape"}.`, {
          nodeId: node.id,
          suggestion: `Selectable colour formats: ${SELECTABLE_COLOR_FORMATS.join(", ")}. Depth is not a colour output (§V51).`,
        });
      }
      node.format = operation.format;
      return;
    }

    case "addGroup": {
      let groupId: GroupId;
      if (isTempId(operation.ref)) {
        if (run.createdIds[operation.ref] !== undefined) {
          fail("patch.duplicateRef", `temp id "${operation.ref}" was already used in this patch.`);
        }
        groupId = mint("group", operation.ref);
        run.createdIds[operation.ref] = groupId;
      } else {
        groupId = operation.ref;
      }
      if (draft.groups[groupId] !== undefined) {
        fail("group.duplicate", `group "${groupId}" already exists.`);
      }
      draft.groups[groupId] = {
        id: groupId,
        label: operation.label,
        bounds: { ...operation.bounds },
        members: resolveMembers(operation.members ?? [], draft, resolveNodeId, fail),
        ...(operation.color === undefined ? {} : { color: operation.color }),
      };
      return;
    }

    case "removeGroups": {
      // Sorted and de-duplicated, like every other multi-target operation: two actors
      // replaying the same patch must produce the same document (§V40).
      for (const groupId of [...new Set(operation.groupIds)].sort()) {
        if (draft.groups[groupId] === undefined) {
          fail("group.missing", `group "${groupId}" does not exist.`);
        }
        delete draft.groups[groupId];
      }
      // Deleting a group deletes the grouping, never the nodes inside it: a group is a
      // label over members, and TD's equivalent behaves the same way.
      return;
    }

    case "setGroup": {
      const group = draft.groups[operation.groupId];
      if (group === undefined) {
        fail("group.missing", `group "${operation.groupId}" does not exist.`);
        return;
      }
      if (operation.label !== undefined) group.label = operation.label;
      if (operation.bounds !== undefined) group.bounds = { ...operation.bounds };
      if (operation.color !== undefined) {
        // null clears the colour back to the canvas default, mirroring setNodeLabel.
        if (operation.color === null) delete group.color;
        else group.color = operation.color;
      }
      if (operation.members !== undefined) {
        group.members = resolveMembers(operation.members, draft, resolveNodeId, fail);
      }
      return;
    }

    case "setViewport": {
      // View framing IS document state (`GraphDocument.viewport`), so a project reopens
      // where it was left. It is not entity state: the store records node, edge and
      // group changes in an undo group, so undoing a viewport-only patch does not
      // restore the previous framing — see the note in the module header.
      if (operation.viewport === null) delete draft.viewport;
      else draft.viewport = { ...operation.viewport };
      return;
    }

    default: {
      const never: never = operation;
      void never;
    }
  }
}

/**
 * Group members, resolved through the same `$temp` machinery as everything else (§V35),
 * de-duplicated and sorted so the stored membership is deterministic (§V40). A member
 * that does not exist is a failed patch, not a silently dropped id: a group quietly
 * missing half its nodes is the kind of thing nobody notices until a layout breaks.
 */
function resolveMembers(
  members: readonly NodeRef[],
  draft: GraphDocument,
  resolveNodeId: (ref: NodeRef) => NodeId,
  fail: (code: string, message: string, extra?: Partial<RuntimeDiagnostic>) => never,
): NodeId[] {
  const resolved = new Set<NodeId>();
  for (const ref of members) {
    const nodeId = resolveNodeId(ref);
    if (draft.nodes[nodeId] === undefined) {
      fail("node.missing", `group member "${nodeId}" does not exist.`, { nodeId });
    }
    resolved.add(nodeId);
  }
  return [...resolved].sort();
}

function incomingEdges(draft: GraphDocument, nodeId: NodeId, portId: PortId): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const edgeId of Object.keys(draft.edges).sort()) {
    const edge = draft.edges[edgeId];
    if (edge === undefined) continue;
    if (edge.target.nodeId === nodeId && edge.target.portId === portId) edges.push(edge);
  }
  return edges;
}
