import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { EdgeId, NodeId, PortId } from "../types/ids.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { ParameterValue } from "../types/parameters.ts";
import type {
  GraphPatch,
  GraphPatchOperation,
  GraphPatchResult,
  NodeRef,
  TempId,
} from "../types/patch.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { arePortsCompatible, describePortType } from "../graph/port-compat.ts";
import { defaultParameters, validateParameters } from "../parameters/validate.ts";
import type { CommandContext, CommandOutcome } from "./bus.ts";

/**
 * `graph.applyPatch` — the atomic graph mutation (§I.patch, T55).
 *
 * One patch is one transaction and one undo group (§V32, §V34). Operations are executed
 * in order against an immer draft; the first error throws, immer discards the draft, and
 * the document is left byte-identical to what it was (§V32). A stale `baseRevision` is
 * reported as a conflict and never rebased (§V33). Patch-local `$temp` ids are minted
 * into stable ids and handed back in `createdIds`, which is what lets an agent add three
 * nodes and wire them together in a single request (§V35).
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
}

export function applyGraphPatch(
  patch: GraphPatch,
  context: CommandContext,
): CommandOutcome<GraphPatchResult> {
  const current = context.store.getRevision();

  if (!Number.isInteger(patch.baseRevision) || patch.baseRevision < 0) {
    return rejected(current, [
      {
        severity: "error",
        code: "patch.baseRevision",
        message: `Patch baseRevision must be a non-negative integer, received ${String(patch.baseRevision)}.`,
        suggestion: "Read the current revision with the graph.get query first.",
      },
    ]);
  }

  if (patch.baseRevision !== current) {
    // §V33: never silently rebase. The caller re-reads and decides.
    const diagnostics: RuntimeDiagnostic[] = [
      {
        severity: "error",
        code: "patch.conflict",
        message: `Patch was built against revision ${patch.baseRevision}, the document is at ${current}.`,
        suggestion: "Re-read the graph and rebuild the patch against the current revision.",
      },
    ];
    return {
      status: "conflict",
      revision: current,
      diagnostics,
      output: {
        status: "conflict",
        revision: current,
        appliedOperations: 0,
        diagnostics,
        createdIds: {},
      },
    };
  }

  const run: PatchRun = { diagnostics: [], createdIds: {} };

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
    // §V36: validated, nothing mutated, and the bus writes no "applied" audit entry.
    const diagnostics: RuntimeDiagnostic[] = [
      ...run.diagnostics,
      {
        severity: "info",
        code: "patch.dryRun",
        message: `Dry run: ${patch.operations.length} operation(s) validated, nothing was applied.`,
      },
    ];
    return {
      status: "applied",
      revision: current,
      diagnostics,
      output: {
        status: "applied",
        revision: current,
        appliedOperations: patch.operations.length,
        diagnostics,
        createdIds: run.createdIds,
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
  ids: { node: () => string; edge: () => string },
  run: PatchRun,
): void {
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
        nodeId = ids.node();
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
        edgeId = ids.edge();
        run.createdIds[operation.ref] = edgeId;
      } else {
        edgeId = ids.edge();
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
        node.parameters[key] = value as ParameterValue;
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

    default: {
      const never: never = operation;
      void never;
    }
  }
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
