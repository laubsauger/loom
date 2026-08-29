import { emptyInput, saveProjectInput, type EmptyInput, type SaveProjectInput } from "../schemas.ts";
import { result } from "../tool-support.ts";
import type { AgentTool, ToolStatus } from "../types.ts";

/**
 * Workflow tools (T57, §I.tools).
 *
 * Four of the five have NO command behind them today, and they say so rather than
 * pretending. Each names the command it needs, so `list_tools` reads as a to-do list for
 * the tracks that own those surfaces instead of as a working feature that quietly does
 * nothing:
 *
 *  - `validate_project` → `project.validate`. Validation exists inside the compiler, but
 *    reaching into `src/compiler` from here would be the app-logic duplication §V39
 *    forbids: the composition root already owns compile wiring, and a validate command
 *    is how it should be shared.
 *  - `compile_project`  → `project.compile`, for the same reason.
 *  - `play` / `pause`   → `transport.play` / `transport.pause`. The keymap has named
 *    these since T77 and reports them unresolved; there is no frame-loop owner yet.
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

export const validateProject = unavailableTool(
  "validate_project",
  "project.validate",
  "Validate project",
  "Validate the graph without compiling it. Requires a project.validate command, which is not registered.",
);

export const compileProject = unavailableTool(
  "compile_project",
  "project.compile",
  "Compile project",
  "Compile the graph to an execution plan and report its diagnostics. Requires a project.compile command, which is not registered.",
);

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
