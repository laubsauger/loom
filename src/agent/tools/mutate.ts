import type { GraphPatchOperation, TempId } from "@domain/types/patch.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { Revision } from "@domain/types/ids.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { placeFree, placeRelative } from "@domain/graph/layout.ts";

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
  layoutGraphInput,
attachAssetInput,
} from "../schemas.ts";
import type {
  AttachAssetInput,
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
  LayoutGraphInput,
} from "../schemas.ts";
import { dispatchOperations, dispatchPatchCommand, failed, result, type PatchToolData } from "../tool-support.ts";
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
 * ## One tool with nothing behind it
 *
 * `set_output` is declared and reports itself UNAVAILABLE on every surface: there is no
 * `graph.setOutput` command, because the document has no port-scoped output designation
 * to write (§V59). A tool that appears to work and silently does nothing is worse than
 * one that says it is not there. (`reset_feedback` used to sit beside it; T292 registered
 * `runtime.resetFeedback` in the app and T597 registered the same body headless.)
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
    "Add one node of a registered type. The stable id comes back in createdIds under the ref $node. Pass placement {relativeTo, direction} to sit next to an existing node; with neither position nor placement, the node cascades to a free spot instead of stacking at the origin.",
  kind: "mutate",
  inputSchema: addNodeInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  preview: (input) => [operationsForAdd(input, input.position ?? { x: 0, y: 0 })],
  async run(input, runtime) {
    // T280: placement resolves against the CURRENT document, so an agent building a
    // chain never computes a coordinate — "right of the blur" is the whole statement.
    let at = input.position;
    if (at === undefined) {
      const graph = await runtime.query<GraphDocument>("graph.get", {});
      // T612: with NEITHER position nor placement, cascade instead of stacking — an
      // agent that adds twenty nodes bare used to leave twenty nodes at (0,0).
      at =
        input.placement !== undefined
          ? placeRelative(
              graph,
              runtime.bus.registry,
              input.placement.relativeTo,
              input.placement.direction ?? "right",
            )
          : placeFree(graph, runtime.bus.registry, input.type);
    }
    return dispatchOperations("add_node", runtime, [operationsForAdd(input, at)], {
      label: "Add node",
      baseRevision: input.baseRevision,
    });
  },
};

function operationsForAdd(
  input: {
    type: string;
    // T314: `StoredParameter`, so an agent can create a node with a parameter already in
    // expression|bind|driven mode — the same envelope the document stores (§V107).
    parameters?: Record<string, StoredParameter> | undefined;
  },
  position: { x: number; y: number },
): GraphPatchOperation {
  return {
    op: "addNode",
    ref: tempRef("node"),
    type: input.type,
    position,
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
  };
}

/**
 * `layout_graph` (T279, B84, §V78, §V191): the deterministic tidy — the SAME bus command
 * the canvas menu's "Layout" row and the `L`/`l` keys run. One `moveNodes` operation, one
 * undo group.
 *
 * It dispatches `graph.layout`/`graph.layoutAll` rather than calling `layoutGraph`, and
 * that is the whole point of B84. This tool used to call the layout function directly
 * while no command existed at all, so the algorithm shipped to agents and not to users —
 * and the day the button arrived there would have been two call sites to keep in step.
 * §V191 says one implementation reached by BOTH; "both" is only structural if the agent
 * goes through the same door a keypress does.
 *
 * An empty graph, an empty selection and an already-tidy graph come back as the command's
 * own named refusals (§V288) instead of a fabricated `applied` with zero operations, which
 * is what this tool used to answer for the empty case.
 */
export const layoutGraphTool: AgentTool<LayoutGraphInput, PatchToolData> = {
  name: "layout_graph",
  title: "Layout graph",
  description:
    "Auto-arrange nodes in reading order: data flows left to right, ranks by depth from the sources, deterministic. Restrict with nodeIds; one undo step.",
  kind: "mutate",
  inputSchema: layoutGraphInput,
  requires: { commands: ["graph.layoutAll"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    return input.nodeIds === undefined
      ? dispatchPatchCommand("layout_graph", "graph.layoutAll", {}, runtime)
      : dispatchPatchCommand("layout_graph", "graph.layout", { nodeIds: input.nodeIds }, runtime);
  },
};

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

/**
 * T542 — the asset hole. An agent could add `audioFileIn`, wire it, drive every
 * parameter through the full mode envelope — and never hand it a FILE, which made
 * "audio can't be connected from my side" literal. This tool closes it: bytes in,
 * a session object URL out, bound exactly the way the file picker binds one (the
 * name rides the URL fragment, so the inspector shows which file was attached, and
 * the patch is audited under the agent's own actor — §V338 twice over).
 *
 * NO EXPORT GRANT REQUIRED, on purpose (§V38's asymmetry, stated so nobody assumes
 * otherwise): --grant-export gates pixels LEAVING the process; putting a file INTO
 * the page is a write the bus's ordinary grant model already governs.
 */
export const attachAsset: AgentTool<AttachAssetInput, PatchToolData> = {
  name: "attach_asset",
  title: "Attach asset",
  description:
    "Bind a media file (as base64 bytes) to a node's asset parameter — the agent-side twin of the file picker. Session-scoped, like a picked file. Needs no export grant: this writes INTO the page.",
  kind: "mutate",
  inputSchema: attachAssetInput,
  requires: { commands: ["graph.applyPatch"] },
  capabilities: [],
  mutates: true,
  run: (input, runtime) => {
    const graph = runtime.bus.store.getGraph();
    const node = graph.nodes[input.nodeId];
    if (node === undefined) {
      return Promise.resolve(
        failed<PatchToolData>("attach_asset", "node.unknown", `No node with id "${input.nodeId}".`),
      );
    }
    const definition = runtime.bus.registry.get(node.type);
    const assetParameters = Object.entries(definition?.parameters ?? {}).filter(
      (entry) => entry[1].type === "asset",
    );
    const chosen =
      input.parameter !== undefined
        ? assetParameters.find(([key]) => key === input.parameter)
        : assetParameters.length === 1
          ? assetParameters[0]
          : undefined;
    if (chosen === undefined) {
      const names = assetParameters.map(([key]) => key);
      return Promise.resolve(
        failed<PatchToolData>(
          "attach_asset",
          "asset.parameterUnresolved",
          names.length === 0
            ? `Node "${input.nodeId}" (${node.type}) has no asset parameter.`
            : `Node "${input.nodeId}" has ${names.length} asset parameters (${names.join(", ")}); name one with "parameter".`,
        ),
      );
    }
    let url: string;
    try {
      const bytes = Uint8Array.from(atob(input.dataBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: input.mimeType });
      // The same shape the picker writes: object URL + the human name in the fragment,
      // which is what the inspector row displays (§V338 — the page SHOWS what arrived).
      url = `${URL.createObjectURL(blob)}#${encodeURIComponent(input.name)}`;
    } catch {
      return Promise.resolve(
        failed<PatchToolData>("attach_asset", "asset.badData", "dataBase64 is not valid base64."),
      );
    }
    return dispatchOperations(
      "attach_asset",
      runtime,
      [{ op: "setParameters", nodeId: input.nodeId, parameters: { [chosen[0]]: url } }],
      { label: `Attach ${input.name}`, baseRevision: input.baseRevision },
    );
  },
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

export interface ResetFeedbackData {
  readonly cleared: number;
}

/** TD's reset-with-a-pulse (§V126), live since T215 gave the backend per-pair resets. */
export const resetFeedback: AgentTool<ResetFeedbackInput, ResetFeedbackData> = {
  name: "reset_feedback",
  title: "Reset feedback",
  description:
    "Clear the history held by temporal (feedback) nodes: the named nodes' pairs, or every pair when unscoped.",
  kind: "mutate",
  inputSchema: resetFeedbackInput,
  requires: { commands: ["runtime.resetFeedback"] },
  capabilities: [],
  mutates: true,
  async run(input, runtime) {
    const dispatched = await runtime.execute<ResetFeedbackData>(
      "runtime.resetFeedback",
      input.nodeIds === undefined ? {} : { nodeIds: input.nodeIds },
    );
    return result<ResetFeedbackData>(
      "reset_feedback",
      dispatched.status === "applied" ? "ok" : "error",
      dispatched.output ?? null,
      { diagnostics: [...dispatched.diagnostics], revision: dispatched.revision },
    );
  },
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
  layoutGraphTool,
  removeNodes,
  connectPorts,
  disconnectPorts,
  attachAsset,
  setParameters,
  setShaderSource,
  setOutput,
  resetFeedback,
  undo,
  redo,
] as readonly AgentTool[];
