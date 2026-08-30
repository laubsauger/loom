import type { CommandName, InvocationContext } from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { NodeId } from "../types/ids.ts";
import type { PulseParameter } from "../types/parameters.ts";
import { pulseCommandInput } from "../parameters/pulse.ts";
import type { ShaderloomBus } from "./bus.ts";

/**
 * `parameter.pulse` — firing a momentary trigger (T214, §V123, §V124, §V125).
 *
 * ## Why the pulse is a command and not a parameter write
 *
 * Every other parameter edit is a patch: it changes the document, bumps the revision and
 * lands on the undo stack. A pulse changes RUNTIME state — a feedback buffer, a
 * simulation, a counter — and none of that is in the document. So there is nothing to
 * patch, nothing for undo to restore, and nothing to save. What is left is the audit
 * entry (§V31), which this writes explicitly through `context.audit`.
 *
 * ## Why it fans out through the bus
 *
 * The pulse's manifest names a COMMAND (`fires`), and this executes it. That indirection
 * is what keeps `src/nodes/definitions/**` headless (§V11) while still letting a node in
 * the catalogue reach the GPU: the node says "reset my feedback pair", the command that
 * knows how to do that is registered by whoever owns the backend, and an agent, a keybind
 * and a right-click all reach the same one (§V29, §V78).
 *
 * A pulse whose command nobody has registered fires nothing and SAYS SO. That is the
 * whole point of routing it here rather than having the button call something directly:
 * the failure is a diagnostic on a rejected command, not a click that appears to work.
 */

export interface PulseInput {
  nodeId: NodeId;
  parameterKey: string;
}

export interface PulseOutput {
  /** The command the pulse fired, or null when nothing was fired. */
  fired: string | null;
}

declare module "../types/commands.ts" {
  interface CommandMap {
    "parameter.pulse": { input: PulseInput; output: PulseOutput };
  }
}

const refuse = (
  code: string,
  message: string,
  nodeId?: NodeId,
  suggestion?: string,
): RuntimeDiagnostic => ({
  severity: "error",
  code,
  message,
  ...(nodeId === undefined ? {} : { nodeId }),
  ...(suggestion === undefined ? {} : { suggestion }),
});

export function registerParameterCommands(bus: ShaderloomBus): void {
  bus.registerCommand({
    name: "parameter.pulse",
    description:
      "Fire a momentary pulse parameter. Audited, never undoable, never serialized (§V124).",
    handler: async (input, context) => {
      const nothing: PulseOutput = { fired: null };
      const node = context.graph.nodes[input.nodeId];
      if (node === undefined) {
        return {
          status: "rejected",
          output: nothing,
          diagnostics: [refuse("parameter.pulse.node", `No node "${input.nodeId}".`)],
        };
      }
      const definition = context.registry.get(node.type)?.parameters[input.parameterKey];
      if (definition === undefined || definition.type !== "pulse") {
        return {
          status: "rejected",
          output: nothing,
          diagnostics: [
            refuse(
              "parameter.pulse.type",
              `"${input.parameterKey}" is not a pulse parameter on "${node.type}".`,
              node.id,
            ),
          ],
        };
      }

      const pulse: PulseParameter = definition;
      if (!bus.hasCommand(pulse.fires)) {
        // Loud on purpose: a trigger that quietly does nothing is the failure mode this
        // whole indirection exists to make impossible.
        return {
          status: "rejected",
          output: nothing,
          diagnostics: [
            refuse(
              "parameter.pulse.unregistered",
              `Pulse "${input.parameterKey}" fires "${pulse.fires}", which no track has registered.`,
              node.id,
              "The pulse is declared; whoever owns that command has to register it.",
            ),
          ],
        };
      }

      // §V36: a dry run reports what WOULD fire without firing it. A pulse has no
      // rollback, so this is the only honest thing a validation pass can do.
      if (context.dryRun) return { status: "validated", output: { fired: pulse.fires } };

      const result = await bus.execute(
        pulse.fires as CommandName,
        pulseCommandInput(pulse, node.id) as never,
        // The pulse's own invocation, so the actor that pulled the trigger is the actor
        // recorded against the effect (§V30).
        context.invocation satisfies InvocationContext,
      );

      if (result.status !== "applied") {
        return { status: "rejected", output: nothing, diagnostics: result.diagnostics };
      }

      // §V31/§V124: audited here, where the *pulse* happened. The command it fired may
      // well have written nothing to the document — that is what makes a pulse a pulse.
      context.audit();
      return { status: "applied", output: { fired: pulse.fires }, diagnostics: result.diagnostics };
    },
    rejectionOutput: () => ({ fired: null }),
  });
}
