import { emptyInput, saveProjectInput, type EmptyInput, type SaveProjectInput } from "../schemas.ts";
import { result } from "../tool-support.ts";
import type { AgentTool, ToolStatus } from "../types.ts";

/**
 * Workflow tools (T57, §I.tools).
 *
 * `play` and `pause` have NO command behind them today, and they say so rather than
 * pretending. Each names the command it needs, so `list_tools` reads as a to-do list for
 * the tracks that own those surfaces instead of as a working feature that quietly does
 * nothing: `transport.play` / `transport.pause` have been named by the keymap since T77
 * and report unresolved (the frame loop registers `transport.togglePlay`, which is one
 * command for two tool verbs — resolving that is the transport owner's call, not a place
 * for this adapter to invent a mapping).
 *
 * `compile_project` is real since T220: `project.compile` is registered by the
 * composition root, which is the only place that has `ProjectSettings`, a live
 * `BackendCapabilities` report and the retained-plan scheduling a compile needs (§V9).
 * Registering it HERE would have been a second compile path, which §V39 forbids — so the
 * tool waited for the command rather than growing an implementation of its own.
 *
 * `save_project` is real: `project.save` is registered by the composition root, and it
 * writes a file, so it is gated behind the `localFile` capability (§V38).
 */

function unavailableTool(
  name: string,
  command: string,
  title: string,
  description: string,
): AgentTool<EmptyInput, never> {
  return {
    name,
    title,
    description,
    kind: "workflow",
    inputSchema: emptyInput,
    requires: { commands: [command] },
    capabilities: [],
    mutates: false,
    run: () => result<never>(name, "unavailable", null),
  };
}

/**
 * Real since the bus registered `project.validate`, which runs the compiler's own
 * validation rather than a second copy of it (§V39) — the adapter projects, nothing more.
 */
export const validateProject: AgentTool<EmptyInput, unknown> = {
  name: "validate_project",
  title: "Validate project",
  description: "Validate the graph without compiling it: unresolved nodes, cycles, and connection diagnostics.",
  kind: "workflow",
  inputSchema: emptyInput,
  requires: { commands: ["project.validate"] },
  capabilities: [],
  mutates: false,
  run: async (_input, runtime) => {
    const dispatched = await runtime.execute<unknown>("project.validate", {});
    const status: ToolStatus = dispatched.status === "applied" ? "ok" : "rejected";
    return result<unknown>("validate_project", status, dispatched.output, {
      diagnostics: dispatched.diagnostics,
      revision: dispatched.revision,
    });
  },
};

/**
 * Real since the composition root registered `project.compile` (T220,
 * `src/app/compile-command.ts`) — the adapter projects one command's result and owns no
 * compiler of its own.
 */
export const compileProject: AgentTool<EmptyInput, unknown> = {
  name: "compile_project",
  title: "Compile project",
  description:
    "Compile the graph to an execution plan and report its passes, resolved outputs and diagnostics.",
  kind: "workflow",
  inputSchema: emptyInput,
  requires: { commands: ["project.compile"] },
  capabilities: [],
  mutates: false,
  run: async (_input, runtime) => {
    const dispatched = await runtime.execute<unknown>("project.compile", {});
    const status: ToolStatus = dispatched.status === "applied" ? "ok" : "rejected";
    return result<unknown>("compile_project", status, dispatched.output, {
      diagnostics: dispatched.diagnostics,
      revision: dispatched.revision,
    });
  },
};

export const play = unavailableTool(
  "play",
  "transport.play",
  "Play",
  "Start the frame loop. Requires a transport.play command, which is not registered.",
);

export const pause = unavailableTool(
  "pause",
  "transport.pause",
  "Pause",
  "Stop the frame loop. Requires a transport.pause command, which is not registered.",
);

export interface SaveProjectData {
  readonly saved: boolean;
  /** Whatever the user named the file. Untrusted text, returned as data (§V37). */
  readonly fileName: string | null;
}

export const saveProject: AgentTool<SaveProjectInput, SaveProjectData> = {
  name: "save_project",
  title: "Save project",
  description:
    "Write the open project to a .loom.json file. Writing a file needs the localFile capability, which only the user can grant.",
  kind: "workflow",
  inputSchema: saveProjectInput,
  requires: { commands: ["project.save"] },
  capabilities: ["localFile"],
  mutates: false,
  async run(input, runtime) {
    const dispatched = await runtime.execute<Partial<SaveProjectData> | undefined>("project.save", {
      ...(input.saveAs === undefined ? {} : { saveAs: input.saveAs }),
    });
    const status: ToolStatus =
      dispatched.status === "applied" ? (runtime.dryRun ? "validated" : "ok") : dispatched.status;
    return result<SaveProjectData>(
      "save_project",
      status,
      { saved: dispatched.output?.saved === true, fileName: dispatched.output?.fileName ?? null },
      { diagnostics: dispatched.diagnostics, revision: dispatched.revision },
    );
  },
};

export const workflowTools: readonly AgentTool[] = [
  validateProject,
  compileProject,
  play,
  pause,
  saveProject,
] as readonly AgentTool[];
