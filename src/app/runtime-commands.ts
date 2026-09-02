import { useEffect, useRef } from "react";

import type { LoomBus } from "@domain/commands/bus.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

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

/**
 * T597: the registration as a PURE function, so the headless MCP server registers the
 * SAME command from the same body (§V39) — the hook below wraps it with refs.
 */
export function registerResetFeedbackCommand(
  bus: LoomBus,
  sources: {
    backend: () => LoomBackend | undefined;
    compiled: () => CompiledGraph | null;
  },
): void {
  // T531 (§V467): ask the BUS, not a ref — the guard is scoped to the thing being
  // registered INTO, so a second mount (or the headless server) cannot double-register.
  if (bus.hasCommand("runtime.resetFeedback")) return;
  bus.registerCommand({
      name: "runtime.resetFeedback",
      description: "Clear temporal (feedback) history — one node's pair, or all of them.",
      handler: (input) => {
        const backend = sources.backend();
        const feedback = sources.compiled()?.feedback ?? [];
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
        // T237: a Cache's history lives in a `ring` resource, which is not a feedback
        // PAIR and so is not in that table. Resolved from the plan's resources instead,
        // by the scratch id's own `scratch:<nodeId>:<key>` shape — without this the
        // node's reset pulse would be a button that lies (§V123), which is exactly the
        // reason the other stateful nodes are listed as gaps rather than given one.
        const rings = (sources.compiled()?.resources ?? []).filter(
          (resource): resource is typeof resource & { kind: "ring" } => resource.kind === "ring",
        );
        const ringIds = rings
          .filter((resource) => !scoped || wanted.has(resource.id.split(":")[1] ?? ""))
          .map((resource) => resource.id);
        if (scoped && pairs.length === 0 && ringIds.length === 0) {
          return {
            status: "rejected",
            output: { cleared: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "runtime.noFeedback",
                message: `None of ${[...wanted].sort().join(", ")} holds temporal history in the current plan.`,
              },
            ],
          };
        }
        backend.resetTemporalHistory(
          scoped ? [...pairs.map((pair) => pair.resourceId), ...ringIds] : undefined,
        );
        return {
          status: "applied",
          output: { cleared: pairs.length + (scoped ? ringIds.length : rings.length) },
          diagnostics: [],
        };
      },
    });
}

export function useRuntimeCommands(inputs: {
  bus: LoomBus;
  backend: LoomBackend | undefined;
  compiled: CompiledGraph | null;
}): void {
  const backendRef = useRef(inputs.backend);
  backendRef.current = inputs.backend;
  const compiledRef = useRef(inputs.compiled);
  compiledRef.current = inputs.compiled;

  useEffect(() => {
    registerResetFeedbackCommand(inputs.bus, {
      backend: () => backendRef.current,
      compiled: () => compiledRef.current,
    });
  }, [inputs.bus]);
}
