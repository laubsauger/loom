import type { LoomBus } from "@domain/commands/bus.ts";
import type { CommandContext, CommandOutcome } from "@domain/commands/bus.ts";
import { applyGraphPatch, patchRejectionOutput } from "@domain/commands/apply-patch.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchResult } from "@domain/types/patch.ts";
import type { MidiSource } from "@domain/midi/midi-mapping.ts";
import { presetCatalogueHolderFor } from "@domain/presets/bank-view.ts";
import { bindParameterPlan, boundControls, controlFromParameterPlan, unbindOperations, type ControlPlan } from "./parameter-controls.ts";
import { learnControlMidiPlan, unlearnControlMidiPlan } from "./midi-controls.ts";
import { z } from "zod";
import { idInput } from "@domain/commands/input-schema.ts";

/**
 * T1514b — the parameter-first mapping gestures as BUS COMMANDS (§V78).
 *
 * The Inspector's right-click rows name these; so can the palette, a keybinding or an
 * agent, and all of them reach the same one-patch implementation (`parameter-controls.ts`).
 * Each is a single `graph.applyPatch`-shaped write, so each is ONE undo step however many
 * nodes and wires it makes. A gesture that cannot complete refuses BY NAME (§V288) rather
 * than writing half of itself.
 *
 * Registered by the composition root (`app-runtime.ts`), beside the component and project
 * commands, because the plans live with the controls editor rather than in the domain.
 */

export interface ControlParameterRef {
  readonly nodeId: NodeId;
  readonly parameterKey: string;
}

export interface ControlFromParameterInput extends ControlParameterRef {
  /** The Panel to join; absent = the only Panel, or a new one when there is none. */
  readonly panelId?: NodeId | undefined;
}

export interface BindControlInput extends ControlParameterRef {
  readonly controlId: NodeId;
  /** The published channel; absent for an XY pad driving a 2-vector whole. */
  readonly channel?: string | undefined;
}

export interface LearnControlMidiInput extends ControlParameterRef {
  readonly source: MidiSource;
  readonly portId: string;
}

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Make the fitting control for a parameter, bind it and put it on a Panel — one patch. */
    "control.fromParameter": { input: ControlFromParameterInput; output: GraphPatchResult & { readonly keepSelection?: true } };
    /** Bind a parameter to an existing control's channel. */
    "control.bindParameter": { input: BindControlInput; output: GraphPatchResult };
    /** Let go of the control a parameter reads; it keeps the value it retained. */
    "control.unbindParameter": { input: ControlParameterRef; output: GraphPatchResult };
    /** Learn hardware onto a panel control without changing its downstream targets. */
    "control.learnMidi": { input: LearnControlMidiInput; output: GraphPatchResult & { readonly keepSelection?: true } };
    /** Restore the control's retained manual value. */
    "control.unlearnMidi": { input: ControlParameterRef; output: GraphPatchResult };
  }
}

export const CONTROL_FROM_PARAMETER_COMMAND = "control.fromParameter";
export const BIND_CONTROL_COMMAND = "control.bindParameter";
export const UNBIND_CONTROL_COMMAND = "control.unbindParameter";

// T1556b (added by the lead when the bus began parsing input): the learned hardware control.
const midiSourceInput = z.object({
  kind: z.enum(["cc", "pitchBend", "note"]),
  channel: z.number().int().min(1).max(16),
  number: z.number().int().min(0).max(127).optional(),
}).strict();

const rejected = (context: CommandContext, code: string, message: string, nodeId?: NodeId): CommandOutcome<GraphPatchResult> => {
  const diagnostics = [{ severity: "error" as const, code, message, ...(nodeId === undefined ? {} : { nodeId }) }];
  return {
    status: "rejected",
    output: { status: "rejected", revision: context.store.getRevision(), appliedOperations: 0, diagnostics, createdIds: {} },
    diagnostics,
  };
};

function run(context: CommandContext, plan: ControlPlan, nodeId: NodeId): CommandOutcome<GraphPatchResult> {
  if (!plan.ok) return rejected(context, plan.code, plan.reason, nodeId);
  return applyGraphPatch({ baseRevision: context.store.getRevision(), label: plan.label, operations: plan.operations }, context);
}

export function registerControlCommands(bus: LoomBus): void {
  // The bus has no unregister and a remount calls this again; the first registration stands.
  if (bus.hasCommand(CONTROL_FROM_PARAMETER_COMMAND)) return;

  bus.registerCommand({
    name: CONTROL_FROM_PARAMETER_COMMAND,
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, parameterKey: idInput, panelId: idInput.optional() }).strict(),
    description: "Create the fitting control (slider, toggle, XY pad) for a parameter, bind it and add it to a Panel (T1514b).",
    handler: (input, context) => {
      // T1547b: the catalogue the canvas sizes nodes with, so the control lands clear of a
      // look's "+ panel" too.
      const catalogue = presetCatalogueHolderFor(bus).current?.components;
      const plan = controlFromParameterPlan(context.graph, context.registry, input.nodeId, input.parameterKey, input.panelId, catalogue);
      const outcome = run(context, plan, input.nodeId);
      // The control and Panel it makes are a side-effect of binding the parameter the person
      // is mapping in the Inspector; taking the selection would move the Inspector off it
      // (`selectCreatedNodes` reads this flag).
      return { ...outcome, output: { ...outcome.output, keepSelection: true } };
    },
    rejectionOutput: patchRejectionOutput,
  });

  bus.registerCommand({
    name: BIND_CONTROL_COMMAND,
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, parameterKey: idInput, controlId: idInput, channel: z.string().min(1).optional() }).strict(),
    description: "Drive a parameter from an existing control's channel (T1514b).",
    handler: (input, context) =>
      run(context, bindParameterPlan(context.graph, context.registry, input.nodeId, input.parameterKey, input.controlId, input.channel), input.nodeId),
    rejectionOutput: patchRejectionOutput,
  });

  bus.registerCommand({
    name: UNBIND_CONTROL_COMMAND,
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, parameterKey: idInput }).strict(),
    description: "Let go of the control a parameter reads; it goes back to the value it held (T1514b).",
    handler: (input, context) => {
      const keys = boundControls(context.graph, context.registry, input.nodeId, input.parameterKey).map((bound) => bound.key);
      if (keys.length === 0) return rejected(context, "control.notBound", `"${input.parameterKey}" is not driven by a control.`, input.nodeId);
      const operations = unbindOperations(context.graph, context.registry, input.nodeId, keys);
      return applyGraphPatch({ baseRevision: context.store.getRevision(), label: `Unlink ${input.parameterKey}`, operations }, context);
    },
    rejectionOutput: patchRejectionOutput,
  });

  bus.registerCommand({
    name: "control.learnMidi",
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, parameterKey: idInput, source: midiSourceInput, portId: z.string().min(1) }).strict(),
    description: "Learn a MIDI controller onto a panel control or XY axis in one undo step.",
    handler: (input, context) => {
      const outcome = run(context, learnControlMidiPlan(context.graph, context.registry,
        input.nodeId, input.parameterKey, input.source, input.portId), input.nodeId);
      return { ...outcome, output: { ...outcome.output, keepSelection: true } };
    },
    rejectionOutput: patchRejectionOutput,
  });
  bus.registerCommand({
    name: "control.unlearnMidi",
    inSession: "definition",
    inputSchema: z.object({ nodeId: idInput, parameterKey: idInput }).strict(),
    description: "Unlink a panel control from MIDI and restore its retained manual value.",
    handler: (input, context) => run(context, unlearnControlMidiPlan(context.graph, context.registry,
      input.nodeId, input.parameterKey), input.nodeId),
    rejectionOutput: patchRejectionOutput,
  });
}
