import { useEffect, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { PipelinePanel } from "./pipeline-panel.tsx";
import { registerPipelineCommand } from "./pipeline-command.ts";

/**
 * Mounts the pipeline inspector and answers `ui.showPipeline` (T1188, §V307).
 *
 * The same shape as `ProjectSettingsHost` and `HelpHost`: the open flag is not document
 * state, so it lives here and the command reaches it through the holder. One of these,
 * once.
 *
 * ⚑ `installed` MUST be the composition root's `installedPlan` latch — the plan
 * `useFrameLoop` announces from inside the install (§T1163) — and never
 * `compile.compiled`. `compiled` is passed alongside it for one purpose: so the panel can
 * say the two have diverged. Handing `compiled` in as `installed` would make this screen
 * lie in the exact situation somebody opens it (§B179).
 */

export interface PipelineHostProps {
  bus: LoomBus;
  /** The plan the BACKEND HAS. */
  installed: CompiledGraph | null;
  /** The plan the current graph compiles to — divergence detection only. */
  compiled: CompiledGraph | null;
  /** The FLATTENED document, whose ids the plan speaks (§V82). */
  graph: GraphDocument;
  registry: NodeRegistryView;
}

export function PipelineHost({ bus, installed, compiled, graph, registry }: PipelineHostProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const holder = registerPipelineCommand(bus);
    const handlers = {
      open(): void {
        setOpen(true);
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus]);

  return (
    <PipelinePanel
      open={open}
      onOpenChange={setOpen}
      installed={installed}
      compiled={compiled}
      graph={graph}
      registry={registry}
    />
  );
}
