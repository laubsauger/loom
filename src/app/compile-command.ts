import type { CompiledGraph } from "@compiler/index.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `project.compile` on the bus (T174, T220, §V39, §V29).
 *
 * ## Why here and nowhere else
 *
 * `src/domain/commands/validate-command.ts` states the case at length and it still holds:
 * compiling needs `ProjectSettings`, a live `BackendCapabilities` report, and the
 * retained-plan/recompile scheduling that only the composition root owns (§V9, §V31). A
 * `project.compile` in the domain layer would have to fabricate the first two, and a
 * `project.compile` inside the agent adapter would be a SECOND compile path — the exact
 * duplication §V39 forbids. So the command lives with the code that already compiles:
 * `useGraphCompile` registers it and hands it the same `compileSafely` result the
 * problems tab and every node badge are rendered from. One compile, one answer.
 *
 * ## Holder, not closure
 *
 * Same shape as `registerTransportCommands`: the bus has no unregister and React mounts
 * more than once, so registration happens once per bus and the mounted owner swaps what
 * the holder points at. With nothing mounted the command REPORTS that (rejected, with a
 * diagnostic) rather than pretending to compile.
 *
 * This is what closes the last clause of the T62 agent exit criterion: `compile_project`
 * was declared, named the command it needed, and reported itself `unavailable` because
 * nothing registered one.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Compile the open document with the project's settings and the live device report. */
    "project.compile": { input: Record<string, never>; output: CompileReport };
  }
}

export interface CompiledOutputSummary {
  readonly nodeId: string;
  readonly portId: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export interface CompileReport {
  /** False when any diagnostic is an error. Warnings do not make a plan invalid. */
  readonly ok: boolean;
  /** True when a plan was produced at all — false means no device report, so no compile. */
  readonly compiled: boolean;
  readonly passCount: number;
  readonly nodeCount: number;
  readonly prunedCount: number;
  /** Coarse texture-memory estimate for the plan (§V24). Null when nothing compiled. */
  readonly estimatedResourceBytes: number | null;
  readonly outputs: readonly CompiledOutputSummary[];
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/** What the mounted compiler answers with. Null plan = it could not run, and says why. */
export interface CompileResultView {
  readonly compiled: CompiledGraph | null;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export interface CompileHandlers {
  /**
   * The plan for the CURRENT document revision, through the same code path the UI uses.
   *
   * Deliberately not "the last plan the UI rendered": a command handler runs synchronously
   * inside `bus.execute`, so an agent that patches and then compiles would otherwise be
   * handed the plan from before its own patch. The owner is free to return a cached
   * result when the revision has not moved — that is a cache, not a second compiler.
   */
  compileNow(): CompileResultView;
}

export interface CompileHolder {
  current: CompileHandlers | null;
}

export function compileHolderFor(bus: ShaderloomBus): CompileHolder {
  return commandHolder<CompileHandlers>(bus, "project.compile");
}

const NO_COMPILER: RuntimeDiagnostic = {
  severity: "error",
  code: "compile.noCompiler",
  message: "Nothing is mounted to compile this project.",
  suggestion: "The composition root registers a compiler when the editor is running.",
};

const EMPTY_REPORT: CompileReport = {
  ok: false,
  compiled: false,
  passCount: 0,
  nodeCount: 0,
  prunedCount: 0,
  estimatedResourceBytes: null,
  outputs: [],
  diagnostics: [],
};

export function reportFor(view: CompileResultView): CompileReport {
  const plan = view.compiled;
  const diagnostics = [...view.diagnostics];
  if (plan === null) {
    return { ...EMPTY_REPORT, diagnostics };
  }
  return {
    ok: !diagnostics.some((entry) => entry.severity === "error"),
    compiled: true,
    passCount: plan.passes.length,
    nodeCount: plan.order.length,
    prunedCount: plan.pruned.length,
    estimatedResourceBytes: plan.estimatedResourceBytes,
    outputs: plan.outputs.map((output) => ({
      nodeId: output.nodeId,
      portId: output.portId,
      width: output.size[0],
      height: output.size[1],
      format: output.format,
    })),
    diagnostics,
  };
}

export function registerCompileCommand(bus: ShaderloomBus): CompileHolder {
  const holder = compileHolderFor(bus);

  if (!bus.hasCommand("project.compile")) {
    bus.registerCommand({
      name: "project.compile",
      description: "Compile the graph to an execution plan and report its diagnostics.",
      handler: (_input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return {
            status: "rejected",
            revision,
            diagnostics: [NO_COMPILER],
            output: EMPTY_REPORT,
          };
        }
        const report = reportFor(holder.current.compileNow());
        // "applied" means THE COMPILE RAN, not that the graph is free of errors — the
        // same distinction `project.validate` makes. `ok` answers the second question.
        // A plan that could not be produced at all (no device report, §V12) is a
        // rejection, because nothing was compiled.
        return {
          status: report.compiled ? "applied" : "rejected",
          revision,
          diagnostics: [...report.diagnostics],
          output: report,
        };
      },
      rejectionOutput: () => EMPTY_REPORT,
    });
  }

  return holder;
}
