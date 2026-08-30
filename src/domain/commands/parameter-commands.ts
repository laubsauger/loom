import type { CommandName, InvocationContext } from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult } from "../types/patch.ts";
import type {
  ParameterDefinition,
  ParameterMode,
  ParameterSlot,
  ParameterValue,
  PulseParameter,
  StoredParameter,
} from "../types/parameters.ts";
import { nodeByName, nodeName } from "../graph/names.ts";
import { pulseCommandInput } from "../parameters/pulse.ts";
import { parameterReference, parseParameterReference } from "../parameters/reference.ts";
import { resolveParameter } from "../parameters/resolve.ts";
import {
  componentKey,
  componentNamesFor,
  isParameterSlot,
  slotFromValue,
  withMode,
} from "../parameters/slots.ts";
import { defaultParameterValue, validateParameterValue } from "../parameters/validate.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import type { CommandContext, CommandOutcome, ShaderloomBus } from "./bus.ts";

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


/* ------------------------------------------------------------------------------------
 * The parameter context menu's commands (T246, §V78, §V148, §V149)
 *
 * §V78: menu items name commands, never handlers, so a right-click, a keybind, the
 * palette and an agent all reach the same code. That is why these live on the bus rather
 * than in the inspector, and why the menu schema can stay data.
 * ---------------------------------------------------------------------------------- */

export interface ParameterRef {
  nodeId: NodeId;
  parameterKey: string;
}

export interface ParameterCopyOutput {
  /** The text that was copied, or null when nothing could be. */
  text: string | null;
}

export interface ParameterResetOutput extends GraphPatchResult {
  /**
   * The mode that stopped being in effect, or null when the parameter was already
   * Constant. §V149: reset must SAY what it cleared rather than silently discarding
   * authored work — and the payload itself SURVIVES, on its own mode button.
   */
  clearedMode: ParameterMode | null;
}

export interface ParameterSetModeInput extends ParameterRef {
  mode: ParameterMode;
}

export interface ParameterPasteInput extends ParameterRef {
  /**
   * Text to paste instead of the bus clipboard.
   *
   * This is the other half of §V148. "Copy reference" is only useful because the string
   * can leave the app — the editor mirrors it to the system clipboard so it can be typed
   * or pasted into an expression field — and a string that came back from out there has
   * to be readable by the same command that would have read the internal clipboard.
   * One paste path, whichever door the text came through.
   */
  text?: string;
}

declare module "../types/commands.ts" {
  interface CommandMap {
    /** Copy the parameter's effective value as text. */
    "parameter.copyValue": { input: ParameterRef; output: ParameterCopyOutput };
    /** Copy a REFERENCE to the parameter — `op(\'noise1\').par.period` (§V148). */
    "parameter.copyReference": { input: ParameterRef; output: ParameterCopyOutput };
    /** Paste whatever was copied onto this parameter. */
    "parameter.paste": { input: ParameterPasteInput; output: GraphPatchResult };
    /** Restore the manifest default AND the Constant mode (§V149). */
    "parameter.reset": { input: ParameterRef; output: ParameterResetOutput };
    /** Switch which binding is in effect, keeping every other mode's payload (§V108). */
    "parameter.setMode": { input: ParameterSetModeInput; output: GraphPatchResult };
  }
}

/**
 * What a copy put on the bus-local parameter clipboard.
 *
 * Bus-local, exactly like the node clipboard in `editor-commands.ts`: it needs no
 * permission, it survives a headless run, and it is what makes Paste testable end to end.
 * The editor mirrors `text` to the system clipboard on top of this, so a reference can
 * also be pasted by hand into an expression field — which is what §V148 is really about.
 */
type ParameterClipboard =
  | { kind: "value"; text: string; value: ParameterValue }
  | { kind: "reference"; text: string; nodeName: string; parameterKey: string };

/** How a copied value is written down. Arrays and stops go through JSON; scalars do not. */
function valueText(value: ParameterValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Reads a copied value back. Null when the text is not a value this model can hold. */
function parseValueText(text: string): { ok: true; value: ParameterValue } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false };
  if (trimmed === "true") return { ok: true, value: true };
  if (trimmed === "false") return { ok: true, value: false };
  if (trimmed === "null") return { ok: true, value: null };
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^[-+.\d]/.test(trimmed)) return { ok: true, value: numeric };
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { ok: true, value: parsed as ParameterValue };
    } catch {
      return { ok: false };
    }
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

/**
 * Reads pasted TEXT as the thing it denotes: a reference first, then a value.
 *
 * Order matters and is not arbitrary. `op('a').par.b` is also a perfectly good string,
 * and treating it as one would quietly write the literal text into a string parameter —
 * a paste that looks like it worked and references nothing.
 */
function clipboardFromText(text: string): ParameterClipboard | null {
  const reference = parseParameterReference(text);
  if (reference !== null) {
    return {
      kind: "reference",
      text: text.trim(),
      nodeName: reference.nodeName,
      parameterKey: reference.parameterKey,
    };
  }
  const value = parseValueText(text);
  return value.ok ? { kind: "value", text: text.trim(), value: value.value } : null;
}

interface Located {
  node: GraphNode;
  definition: ParameterDefinition;
}

function locate(context: CommandContext, input: ParameterRef): Located | RuntimeDiagnostic {
  const node = context.graph.nodes[input.nodeId];
  if (node === undefined) return refuse("parameter.node", `No node "${input.nodeId}".`);
  const definition = context.registry.get(node.type)?.parameters[input.parameterKey];
  if (definition === undefined) {
    return refuse(
      "parameter.unknown",
      `"${node.type}" declares no parameter "${input.parameterKey}".`,
      node.id,
    );
  }
  return { node, definition };
}

const isDiagnostic = (value: Located | RuntimeDiagnostic): value is RuntimeDiagnostic =>
  "severity" in value;

const rejectedPatch = (revision: number, diagnostics: RuntimeDiagnostic[]): GraphPatchResult => ({
  status: "rejected",
  revision,
  appliedOperations: 0,
  diagnostics,
  createdIds: {},
});

/** One patch, so a menu action is one undo entry (§V15, §V34). */
function writeParameters(
  context: CommandContext,
  label: string,
  nodeId: NodeId,
  parameters: Record<string, StoredParameter>,
): CommandOutcome<GraphPatchResult> {
  const operations: GraphPatchOperation[] = [
    // `GraphPatchOperation` still types this field as `ParameterValue` while the whole
    // runtime path speaks `StoredParameter` — the same cast `apply-patch.ts` makes.
    { op: "setParameters", nodeId, parameters: parameters as Record<string, ParameterValue> },
  ];
  return applyGraphPatch({ baseRevision: context.store.getRevision(), label, operations }, context);
}

/**
 * Somewhere to mirror a copied string so it can leave the app (§V148).
 *
 * Injected rather than reached for: `navigator.clipboard` does not exist in Node, the
 * domain has to stay runnable there, and a copy that throws in a headless run because
 * the browser was missing would be an odd way to lose a test suite. Absent, the bus
 * clipboard still works and Paste still works — only the trip through a text field does
 * not, and that is a degradation the caller chose.
 */
export interface ParameterCommandOptions {
  writeClipboard?: ((text: string) => void) | undefined;
}

export function registerParameterCommands(
  bus: ShaderloomBus,
  options: ParameterCommandOptions = {},
): void {
  /** Per-bus, like the node clipboard. Never global: two buses are two documents. */
  let clipboard: ParameterClipboard | null = null;

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

  bus.registerCommand({
    name: "parameter.copyValue",
    description: "Copy a parameter's effective value as text (T246).",
    handler: (input, context) => {
      const found = locate(context, input);
      if (isDiagnostic(found)) return { status: "rejected", output: { text: null }, diagnostics: [found] };
      const resolved = resolveParameter(found.node, input.parameterKey, found.definition, {
        schema: context.registry.get(found.node.type)?.parameters ?? {},
      });
      const text = valueText(resolved.value);
      // The EFFECTIVE value, not the stored one: copying from a parameter running an
      // expression should give you the number you can see, which is the only reason
      // anyone copies a value off a driven parameter.
      if (!context.dryRun) {
        clipboard = { kind: "value", text, value: resolved.value };
        options.writeClipboard?.(text);
      }
      return { status: context.dryRun ? "validated" : "applied", output: { text } };
    },
    rejectionOutput: () => ({ text: null }),
  });

  bus.registerCommand({
    name: "parameter.copyReference",
    description: "Copy a reference that pastes into an expression (T246, §V148).",
    handler: (input, context) => {
      const found = locate(context, input);
      if (isDiagnostic(found)) return { status: "rejected", output: { text: null }, diagnostics: [found] };
      const name = nodeName(found.node);
      if (name === undefined) {
        // §V127: `op('…')` resolves because a name is unique in its network. A node with
        // no name has nothing to reference, and inventing one here would produce a string
        // that stops working the moment the user names the node themselves.
        return {
          status: "rejected",
          output: { text: null },
          diagnostics: [
            refuse(
              "parameter.reference.unnamed",
              `Node "${found.node.id}" has no name, so nothing can reference it.`,
              found.node.id,
              "Name the node first — a reference addresses the name, not the id (§V127).",
            ),
          ],
        };
      }
      const text = parameterReference(name, input.parameterKey);
      if (!context.dryRun) {
        clipboard = { kind: "reference", text, nodeName: name, parameterKey: input.parameterKey };
        options.writeClipboard?.(text);
      }
      return { status: context.dryRun ? "validated" : "applied", output: { text } };
    },
    rejectionOutput: () => ({ text: null }),
  });

  bus.registerCommand({
    name: "parameter.paste",
    description: "Paste the copied value or reference onto this parameter (T246).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const found = locate(context, input);
      if (isDiagnostic(found)) return { status: "rejected", output: rejectedPatch(revision, [found]) };
      const source = input.text === undefined ? clipboard : clipboardFromText(input.text);
      if (source === null) {
        return {
          status: "rejected",
          output: rejectedPatch(revision, [
            input.text === undefined
              ? refuse("parameter.clipboard.empty", "No parameter has been copied.", found.node.id)
              : refuse(
                  "parameter.clipboard.unreadable",
                  "The pasted text is neither a value nor a parameter reference.",
                  found.node.id,
                ),
          ]),
        };
      }

      if (source.kind === "value") {
        const invalid = validateParameterValue(
          input.parameterKey,
          found.definition,
          source.value,
          found.node.id,
        );
        if (invalid !== null) {
          // Refused, not coerced: pasting a colour onto a number should say so rather
          // than silently landing the first channel.
          return { status: "rejected", output: rejectedPatch(revision, [invalid]) };
        }
        const stored = found.node.parameters[input.parameterKey];
        const next: StoredParameter = isParameterSlot(stored)
          ? { mode: "static", bindings: { ...stored.bindings, static: { kind: "static", value: source.value } } }
          : source.value;
        return writeParameters(context, "Paste parameter", found.node.id, {
          [input.parameterKey]: next,
        });
      }

      /**
       * §V148's round trip, and the one decision inside it.
       *
       * A reference to a parameter on the PASTE TARGET'S OWN node becomes a `bind`: binds
       * to a sibling resolve today, everywhere — the inspector and the compiler read them
       * through the same resolver (§V61), so the pasted reference produces the source
       * value on screen AND on the GPU.
       *
       * A reference to another node becomes an EXPRESSION carrying `op('…').par.…`. That
       * form parses, is stored, and is rewritten on rename (§V128) — but the evaluator
       * does not read cross-node references yet, so the parameter falls back per §V108
       * and reports why. That failure is LOUD, which is the property §V148 is protecting;
       * what it is not yet is complete. See the note on `parseParameterReference`.
       */
      const sameNode = nodeByName(context.graph, source.nodeName) === found.node.id;
      const stored = found.node.parameters[input.parameterKey];
      const slot = isParameterSlot(stored)
        ? stored
        : slotFromValue(stored ?? defaultParameterValue(found.definition));
      const next: ParameterSlot = sameNode
        ? { mode: "bind", bindings: { ...slot.bindings, bind: { kind: "bind", ref: source.parameterKey } } }
        : {
            mode: "expression",
            bindings: { ...slot.bindings, expression: { kind: "expression", source: source.text } },
          };

      if (sameNode && source.parameterKey === input.parameterKey) {
        return {
          status: "rejected",
          output: rejectedPatch(revision, [
            refuse(
              "parameter.reference.self",
              `"${input.parameterKey}" cannot reference itself.`,
              found.node.id,
            ),
          ]),
        };
      }

      return writeParameters(context, "Paste reference", found.node.id, {
        [input.parameterKey]: next,
      });
    },
    rejectionOutput: (_input, diagnostics, revision) => rejectedPatch(revision, diagnostics),
  });

  bus.registerCommand({
    name: "parameter.reset",
    description: "Restore the manifest default and the Constant mode (T246, §V149).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const found = locate(context, input);
      if (isDiagnostic(found)) {
        return {
          status: "rejected",
          output: { ...rejectedPatch(revision, [found]), clearedMode: null },
        };
      }
      const { node, definition } = found;
      const fallback = defaultParameterValue(definition);
      const stored = node.parameters[input.parameterKey];
      const activeMode: ParameterMode = isParameterSlot(stored) ? stored.mode : "static";

      /**
       * §V149 — reset restores BOTH value and mode, and per-mode retained payloads
       * SURVIVE it. Clearing the mode is not the same as clearing its memory: the whole
       * promise of the corner mark (§V108) is that an expression you switched away from
       * is still there, and a reset that wiped it would make the mark a lie in the one
       * place a user most expects to be able to undo their mind rather than their work.
       */
      const restore = (
        current: StoredParameter | undefined,
        value: ParameterValue,
      ): StoredParameter =>
        isParameterSlot(current)
          ? { mode: "static", bindings: { ...current.bindings, static: { kind: "static", value } } }
          : value;

      const parameters: Record<string, StoredParameter> = {
        [input.parameterKey]: restore(stored, fallback),
      };

      /**
       * §V113/§V114: a compound's CHANNELS carry their own slots, so a reset that only
       * wrote the bare key would leave `color.g` still running its expression and the
       * swatch still not showing the default. Every channel goes in the same patch, so
       * this is one undo entry however many channels moved.
       */
      const names = componentNamesFor(definition);
      if (names !== null && Array.isArray(fallback)) {
        names.forEach((name, index) => {
          const key = componentKey(input.parameterKey, name);
          const channel = node.parameters[key];
          if (channel === undefined) return;
          parameters[key] = restore(channel, (fallback as readonly number[])[index] ?? 0);
        });
      }

      const patched = writeParameters(context, "Reset parameter", node.id, parameters);
      const clearedMode = activeMode === "static" ? null : activeMode;
      const diagnostics = [...(patched.diagnostics ?? patched.output.diagnostics)];
      if (clearedMode !== null && patched.status === "applied") {
        diagnostics.push({
          severity: "info",
          code: "parameter.reset.cleared",
          message: `"${input.parameterKey}" was in ${clearedMode} mode; it is back to Constant.`,
          nodeId: node.id,
          suggestion: `The ${clearedMode} payload is kept on its own mode button (§V108).`,
        });
      }
      return {
        status: patched.status,
        output: { ...patched.output, diagnostics, clearedMode },
        diagnostics,
      };
    },
    rejectionOutput: (_input, diagnostics, revision) => ({
      ...rejectedPatch(revision, diagnostics),
      clearedMode: null,
    }),
  });

  bus.registerCommand({
    name: "parameter.setMode",
    description: "Switch a parameter's active mode, keeping every other payload (§V108).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const found = locate(context, input);
      if (isDiagnostic(found)) return { status: "rejected", output: rejectedPatch(revision, [found]) };
      const schema = context.registry.get(found.node.type)?.parameters ?? {};
      const resolved = resolveParameter(found.node, input.parameterKey, found.definition, { schema });
      const stored = found.node.parameters[input.parameterKey];
      const slot = isParameterSlot(stored) ? stored : slotFromValue(resolved.value);
      const next = withMode(slot, input.mode, resolved.value);
      if (next === null) {
        // `bind` and `driven` have no authorable empty form, so a menu cannot complete
        // the switch on its own — the panel is where you type the ref.
        return {
          status: "rejected",
          output: rejectedPatch(revision, [
            refuse(
              "parameter.mode.payload",
              `${input.mode} needs a payload before it can take effect.`,
              found.node.id,
              "Open the parameter's mode panel (click its name) and author one.",
            ),
          ]),
        };
      }
      return writeParameters(context, `Set ${input.parameterKey} mode`, found.node.id, {
        [input.parameterKey]: next,
      });
    },
    rejectionOutput: (_input, diagnostics, revision) => rejectedPatch(revision, diagnostics),
  });
}

