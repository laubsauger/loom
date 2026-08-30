import { useEffect, useRef } from "react";

import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";

/**
 * `runtime.resetFeedback`, REGISTERED (T292's enumeration found it missing — the
 * fourth instance of built-but-unwired, this time a command both the keymap and the
 * `reset_feedback` tool already reference).
 *
 * It waited, correctly, for per-resource reset granularity (T215): a whole-backend
 * clear was the wrong blast radius for "pulse THIS feedback loop" (§V126). Now:
 * `{nodeId?}` clears that node's pair — resolved through the CURRENT plan's feedback
 * table — or every pair when unscoped. The backend refuses unknown ids loudly; this
 * handler resolves honestly and reports how many pairs it addressed.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "runtime.resetFeedback": {
      input: { nodeIds?: readonly string[] };
      output: { cleared: number };
    };
  }
}

export function useRuntimeCommands(inputs: {
  bus: ShaderloomBus;
  backend: ShaderloomBackend | undefined;
  compiled: CompiledGraph | null;
}): void {
  const backendRef = useRef(inputs.backend);
  backendRef.current = inputs.backend;
  const compiledRef = useRef(inputs.compiled);
  compiledRef.current = inputs.compiled;
  const registered = useRef(new Set<ShaderloomBus>());

  useEffect(() => {
    const { bus } = inputs;
    if (registered.current.has(bus)) return;
    registered.current.add(bus);
    bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Clear temporal (feedback) history — one node's pair, or all of them.",
      handler: (input) => {
        const backend = backendRef.current;
        const feedback = compiledRef.current?.feedback ?? [];
        if (backend === undefined) {
          return {
            status: "rejected",
            output: { cleared: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "runtime.noBackend",
                message: "No GPU backend is attached; there is no feedback history to clear.",
              },
            ],
          };
        }
        const scoped = input.nodeIds !== undefined;
        const wanted = new Set(input.nodeIds ?? []);
        const pairs = scoped ? feedback.filter((pair) => wanted.has(pair.nodeId)) : [...feedback];
        if (scoped && pairs.length === 0) {
          return {
            status: "rejected",
            output: { cleared: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "runtime.noFeedback",
                message: `None of ${[...wanted].sort().join(", ")} holds a feedback pair in the current plan.`,
              },
            ],
          };
        }
        backend.resetTemporalHistory(scoped ? pairs.map((pair) => pair.resourceId) : undefined);
        return { status: "applied", output: { cleared: pairs.length }, diagnostics: [] };
      },
    });
  }, [inputs.bus]);
}
