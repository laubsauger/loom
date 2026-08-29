import type { GraphPatchOperation, TempId } from "@domain/types/patch.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { Revision } from "@domain/types/ids.ts";

import {
  addNodeInput,
  applyGraphPatchInput,
  connectPortsInput,
  disconnectPortsInput,
  historyInput,
  removeNodesInput,
  resetFeedbackInput,
  setOutputInput,
  setParametersInput,
  setShaderSourceInput,
} from "../schemas.ts";
import type {
  AddNodeInput,
  ApplyGraphPatchInput,
  ConnectPortsInput,
  DisconnectPortsInput,
  HistoryInput,
  RemoveNodesInput,
  ResetFeedbackInput,
  SetOutputInput,
  SetParametersInput,
  SetShaderSourceInput,
} from "../schemas.ts";
import { dispatchOperations, dispatchPatchCommand, result, type PatchToolData } from "../tool-support.ts";
import type { AgentTool, ToolStatus } from "../types.ts";

/**
 * Mutation tools (T55, T56 — §V29, §V30, §V32, §V33, §V34, §V35).
 *
 * Every one of them dispatches a bus command. Nothing here writes to the store, the
 * React Flow arrays or a GPU resource (§V29), and nothing here decides what an operation
 * means — `graph.applyPatch` owns atomicity, conflict detection, temp-id resolution, undo
 * grouping and the audit entry, so the adapter has exactly one thing to do: turn a tool
 * call into an operation list (§V39).
 *
 * ## The single-edit tools are patches
 *
 * `add_node`, `connect_ports`, `set_parameters` … are one-operation patches rather than
 * their own commands. That is deliberate: a second mutation route would be a second place
 * to forget dryRun, the undo group or the audit entry, and `src/domain/commands` already
 * makes the same argument for the editor commands.
 *
 * ## baseRevision
 *
 * `apply_graph_patch` REQUIRES one — a patch is work built against a snapshot, and
 * filling one in on the caller's behalf is the silent rebase §V33 forbids. The
 * single-edit tools accept an optional one and default to the current revision, because
 * "add a node" was not built against a snapshot; a human clicking the same button carries
 * no base revision either. Pass one when the edit depends on what you read.
 *
 * ## Two tools with nothing behind them
 *
 * `set_output` and `reset_feedback` are declared and report themselves UNAVAILABLE. There
 * is no `graph.setOutput` command (the document has no port-scoped output designation to
 * write, §V59) and no `runtime.resetFeedback` command (there is no frame loop to reset,
 * and `src/domain/commands/editor-commands.ts` says the same about the keybinding). A tool
 * that appears to work and silently does nothing is worse than one that says it is not
 * there.
 */

const tempRef = (name: string): TempId => `$${name}`;

export const applyGraphPatch: AgentTool<ApplyGraphPatchInput, PatchToolData> = {
  name: "apply_graph_patch",
  title: "Apply graph patch",
  description:
    "Apply an ordered batch of graph operations atomically: all of them apply or none do. Refer to nodes created in the same patch by a $temp ref and read the stable ids back from createdIds. A baseRevision older than the document is reported as a conflict and never rebased.",
  kind: "mutate",
  inputSchema: applyGraphPatchInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  // The zod-inferred operation union and `GraphPatchOperation` are the same shape; they
  // differ only where TypeScript cannot see a runtime guarantee — a `$temp` ref is a
  // template-literal type that the schema enforces with a regex. The review gate wants
  // the domain type, so the conversion happens once, here.
  preview: (input) => input.operations as unknown as readonly GraphPatchOperation[],
  run: (input, runtime) =>
    dispatchPatchCommand("apply_graph_patch", "graph.applyPatch", {
      baseRevision: input.baseRevision,
      operations: input.operations,
      ...(input.label === undefined ? {} : { label: input.label }),
    }, runtime),
};

export const addNode: AgentTool<AddNodeInput, PatchToolData> = {
  name: "add_node",
  title: "Add node",
  description:
    "Add one node of a registered type. The stable id comes back in createdIds under the ref $node.",
  kind: "mutate",
  inputSchema: addNodeInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [operationsForAdd(input)],
  run: (input, runtime) =>
    dispatchOperations("add_node", runtime, [operationsForAdd(input)], {
      label: "Add node",
      baseRevision: input.baseRevision,
    }),
};

function operationsForAdd(input: {
  type: string;
  position?: { x: number; y: number } | undefined;
  parameters?: Record<string, ParameterValue> | undefined;
}): GraphPatchOperation {
  return {
    op: "addNode",
    ref: tempRef("node"),
    type: input.type,
    position: input.position ?? { x: 0, y: 0 },
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
  };
}

export const removeNodes: AgentTool<RemoveNodesInput, PatchToolData> = {
  name: "remove_nodes",
  title: "Remove nodes",
  description: "Delete nodes and every edge incident to them. Undoable as one group.",
  kind: "mutate",
  inputSchema: removeNodesInput,
  requires: { commands: ["graph.removeNodes"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [{ op: "removeNodes", nodeIds: [...input.nodeIds] }],
  run: (input, runtime) =>
    dispatchPatchCommand("remove_nodes", "graph.removeNodes", { nodeIds: input.nodeIds }, runtime),
};

export const connectPorts: AgentTool<ConnectPortsInput, PatchToolData> = {
  name: "connect_ports",
  title: "Connect ports",
  description:
    "Connect an output port to an input port. Port types must match exactly; a conversion is a node, never an implicit cast.",
  kind: "mutate",
  inputSchema: connectPortsInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [{ op: "connect", source: input.source, target: input.target }],
  run: (input, runtime) =>
    dispatchOperations(
      "connect_ports",
      runtime,
      [{ op: "connect", ref: tempRef("edge"), source: input.source, target: input.target }],
      { label: "Connect", baseRevision: input.baseRevision },
    ),
};

export const disconnectPorts: AgentTool<DisconnectPortsInput, PatchToolData> = {
  name: "disconnect_ports",
  title: "Disconnect ports",
  description: "Remove edges by id. Read the ids from get_graph.",
  kind: "mutate",
  inputSchema: disconnectPortsInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [{ op: "disconnect", edgeIds: [...input.edgeIds] }],
  run: (input, runtime) =>
    dispatchOperations("disconnect_ports", runtime, [{ op: "disconnect", edgeIds: input.edgeIds }], {
      label: "Disconnect",
      baseRevision: input.baseRevision,
    }),
};

export const setParameters: AgentTool<SetParametersInput, PatchToolData> = {
  name: "set_parameters",
  title: "Set parameters",
  description: "Set one or more parameters on a node. Values are validated against the node's schema.",
  kind: "mutate",
  inputSchema: setParametersInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [{ op: "setParameters", nodeId: input.nodeId, parameters: input.parameters }],
  run: (input, runtime) =>
    dispatchOperations(
      "set_parameters",
      runtime,
      [{ op: "setParameters", nodeId: input.nodeId, parameters: input.parameters }],
      { label: "Set parameters", baseRevision: input.baseRevision },
    ),
};

export const setShaderSource: AgentTool<SetShaderSourceInput, PatchToolData> = {
  name: "set_shader_source",
  title: "Set shader source",
  description: "Replace the WGSL source of a shader-authorable node.",
  kind: "mutate",
  inputSchema: setShaderSourceInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [{ op: "setShaderSource", nodeId: input.nodeId, source: input.source }],
  run: (input, runtime) =>
    dispatchOperations(
      "set_shader_source",
      runtime,
      [{ op: "setShaderSource", nodeId: input.nodeId, source: input.source }],
      { label: "Set shader source", baseRevision: input.baseRevision },
    ),
};

/**
 * §V59: an output is `{nodeId, portId}`, defaulting to port "out". The tool is shaped
 * that way even though it cannot run, so that whoever adds `graph.setOutput` inherits the
 * port-scoped contract instead of re-deriving `outputId === nodeId`.
 */
export const setOutput: AgentTool<SetOutputInput, never> = {
  name: "set_output",
  title: "Set output",
  description:
    "Designate a port-scoped output as the project's active output. Requires a graph.setOutput command, which is not registered.",
  kind: "mutate",
  inputSchema: setOutputInput,
  requires: { commands: ["graph.setOutput"] },
  capabilities: [],
  mutates: true,
  run: () => result<never>("set_output", "unavailable", null),
};

export const resetFeedback: AgentTool<ResetFeedbackInput, never> = {
  name: "reset_feedback",
  title: "Reset feedback",
  description:
    "Clear the history held by temporal nodes. Requires a runtime.resetFeedback command, which is not registered.",
  kind: "mutate",
  inputSchema: resetFeedbackInput,
  requires: { commands: ["runtime.resetFeedback"] },
  capabilities: [],
  mutates: true,
  run: () => result<never>("reset_feedback", "unavailable", null),
};

export interface HistoryToolData {
  readonly undoGroupId: string | null;
  readonly label: string | null;
  readonly revision: Revision;
}

function historyTool(
  name: "undo" | "redo",
  command: "graph.undo" | "graph.redo",
  title: string,
  description: string,
): AgentTool<HistoryInput, HistoryToolData> {
  return {
    name,
    title,
    description,
    kind: "mutate",
    inputSchema: historyInput,
    requires: { commands: [command] },
    capabilities: [],
    mutates: true,
    async run(_input, runtime) {
      const dispatched = await runtime.execute<Partial<HistoryToolData> | undefined>(command, {});
      const data: HistoryToolData = {
        undoGroupId: dispatched.output?.undoGroupId ?? null,
        label: dispatched.output?.label ?? null,
        revision: dispatched.revision,
      };
      const status: ToolStatus =
        dispatched.status === "applied" ? (runtime.dryRun ? "validated" : "ok") : dispatched.status;
      return result(name, status, data, {
        diagnostics: dispatched.diagnostics,
        revision: dispatched.revision,
        ...(dispatched.undoGroupId === undefined ? {} : { undoGroupId: dispatched.undoGroupId }),
      });
    },
  };
}

/**
 * §V41: undo is ACTOR-LOCAL. This undoes the agent's own most recent group and can never
 * erase a human's work — which is also why an agent that wants its whole session reverted
 * calls this repeatedly rather than asking for a global rollback.
 */
export const undo = historyTool(
  "undo",
  "graph.undo",
  "Undo",
  "Undo this actor's most recent edit group. Never touches another actor's work.",
);

export const redo = historyTool(
  "redo",
  "graph.redo",
  "Redo",
  "Redo this actor's most recently undone group.",
);

export const mutationTools: readonly AgentTool[] = [
  applyGraphPatch,
  addNode,
  removeNodes,
  connectPorts,
  disconnectPorts,
  setParameters,
  setShaderSource,
  setOutput,
  resetFeedback,
  undo,
  redo,
] as readonly AgentTool[];
