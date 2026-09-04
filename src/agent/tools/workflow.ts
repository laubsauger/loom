import { emptyInput, saveProjectInput, type EmptyInput, type SaveProjectInput } from "../schemas.ts";
import { result } from "../tool-support.ts";
import type { AgentTool, ToolStatus } from "../types.ts";

/**
 * Workflow tools (T57, §I.tools).
 *
 * `play` and `pause` are REAL in the app since T292: `src/app/transport-commands.ts`
 * registers `transport.play` and `transport.pause` as idempotent verbs beside the keymap's
 * `transport.togglePlay`, because an agent told "play" while playing must not pause. They
 * stay unavailable on the HEADLESS server, which has no frame loop at all and waives them
 * by name in the T597 parity gates (§V541) — so `list_tools` still reads as the truth about
 * whichever surface answered, rather than as a working feature that quietly does nothing.
 *
 * T1146: this paragraph claimed for months that neither command existed anywhere. It was
 * true when written and stale by the time an agent read it.
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

function transportTool(name: "play" | "pause", command: "transport.play" | "transport.pause", title: string, description: string): AgentTool<Record<string, never>, { playing: boolean }> {
  return {
    name,
    title,
    description,
    kind: "workflow",
    inputSchema: emptyInput,
    requires: { commands: [command] },
    capabilities: [],
    mutates: false,
    async run(_input, runtime) {
      const dispatched = await runtime.execute<{ playing: boolean }>(command, {});
      return result<{ playing: boolean }>(name, dispatched.status === "applied" ? "ok" : "rejected", dispatched.output ?? null, {
        diagnostics: dispatched.diagnostics,
        revision: dispatched.revision,
      });
    },
  };
}

/** Idempotent verbs, not a toggle: an agent told "play" while playing must not pause. */
export const play = transportTool("play", "transport.play", "Play", "Start the frame loop. Idempotent.");
export const pause = transportTool("pause", "transport.pause", "Pause", "Stop the frame loop. Idempotent.");

export interface SaveProjectData {
  readonly saved: boolean;
  /** Whatever the user named the file. Untrusted text, returned as data (§V37). */
  readonly fileName: string | null;
}

export const saveProject: AgentTool<SaveProjectInput, SaveProjectData> = {
  name: "save_project",
  title: "Save project",
  description:
    // T1146: this used to end "...which only the user can grant" — the very sentence T1097
    // deleted from the REFUSAL, left standing here, and false in the same way: `localFile`
    // has no issuer anywhere in the codebase, so no user can grant it either. The published
    // description carries `grantRefusal`, which states the surface's real answer; this
    // sentence only has to name the gate, not invent a key for it.
    "Write the open project to a .loom.json file. Writing a file needs the localFile capability.",
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
