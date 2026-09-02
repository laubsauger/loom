import type { CommandName, InvocationContext } from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult } from "../types/patch.ts";
import type {
  ParameterBinding,
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
import { resolveParameter, effectiveParameterSchema } from "../parameters/resolve.ts";
import {
  componentKey,
  componentNamesFor,
  isParameterSlot,
  slotFromValue,
  withMode,
} from "../parameters/slots.ts";
import { defaultParameterValue, validateParameterValue } from "../parameters/validate.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import type { CommandContext, CommandOutcome, LoomBus } from "./bus.ts";

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

/**
 * WHICH MEMBER of the copied payload a paste lands (T1004).
 *
 * The owner's rule, and it is TouchDesigner's and Houdini's: **copy captures everything,
 * paste decides**. Deciding at copy time asks the user to predict what they will want two
 * minutes from now, and they cannot — they copy a parameter, walk to another node, and
 * only THERE discover whether they wanted the number, a live reference, or the expression
 * itself. So one copy fills all three members and this input picks one at paste time.
 *
 * Absent means "whatever the copy put on the SYSTEM clipboard" — the legacy behaviour and
 * the only honest default for a paste that arrived as text from outside the app, where a
 * string is all there is.
 */
export type ParameterPasteMode = "value" | "reference" | "binding";

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
  /** Which member of the copied payload to land. Absent = what the copy mirrored out. */
  as?: ParameterPasteMode;
}

declare module "../types/commands.ts" {
  interface CommandMap {
    /**
     * Copy the parameter WHOLE — value snapshot, reference, and its active binding — so
     * paste can choose between them. Mirrors the reference outward when the node has a
     * name, the value text when it does not.
     */
    "parameter.copy": { input: ParameterRef; output: ParameterCopyOutput };
    /** Copy the parameter's effective value as text. */
    "parameter.copyValue": { input: ParameterRef; output: ParameterCopyOutput };
    /** Copy a REFERENCE to the parameter — `op(\'noise1\').par.period` (§V148). */
    "parameter.copyReference": { input: ParameterRef; output: ParameterCopyOutput };
    /** Paste one member of what was copied onto this parameter. */
    "parameter.paste": { input: ParameterPasteInput; output: GraphPatchResult };
    /** Restore the manifest default AND the Constant mode (§V149). */
    "parameter.reset": { input: ParameterRef; output: ParameterResetOutput };
    /** Switch which binding is in effect, keeping every other mode's payload (§V108). */
    "parameter.setMode": { input: ParameterSetModeInput; output: GraphPatchResult };
  }
}

/**
 * What a copy put on the bus-local parameter clipboard (T246, T1004).
 *
 * Bus-local, exactly like the node clipboard in `editor-commands.ts`: it needs no
 * permission, it survives a headless run, and it is what makes Paste testable end to end.
 * The editor mirrors ONE string to the system clipboard on top of this, so a reference can
 * also be pasted by hand into an expression field — which is what §V148 is really about.
 *
 * ## Why every member is captured, always
 *
 * The system clipboard holds one string, so mirroring outward is a choice that HAS to be
 * made at copy time — that is what still separates `copyValue` from `copyReference`. The
 * bus-local payload has no such limit, so it carries all three members whichever copy
 * command filled it, and `parameter.paste`'s `as` picks one. `kind` records only which
 * string went OUT, and is therefore the right default when nobody said `as`.
 *
 * A payload built from pasted TEXT is the degenerate case: text is one string, so
 * `binding` is null and `arity` is unknown. Both are stated rather than guessed — a paste
 * that cannot check a shape must say it did not, not pretend it did.
 */
interface ParameterClipboard {
  /** Which member the copy mirrored to the system clipboard. The default paste. */
  kind: "value" | "reference";
  /** What the parameter was WORTH when it was copied. Always captured. */
  value: ParameterValue;
  /** That value written down — what `copyValue` mirrors out. */
  valueText: string;
  /** `op('blur1').par.radius`, or null when the source node has no name (§V127). */
  reference: string | null;
  /** The source's name and key, so a reference paste can tell same-node from cross-node. */
  nodeName: string | null;
  parameterKey: string;
  /**
   * The source slot's ACTIVE binding, or null when the source is a plain constant — a
   * constant has no binding to paste, and "paste binding" says so by name rather than
   * quietly landing the number (§V288).
   */
  binding: ParameterBinding | null;
  /** How many numbers the source carries (§V113). Null when the source is unknown text. */
  arity: number | null;
  /** The source's declared type, for a refusal that can name both sides. */
  typeName: string | null;
}

/**
 * How many numbers a parameter carries — the only shape question a reference or a binding
 * paste can honestly answer ahead of time.
 *
 * An expression and a bind both resolve to ONE value of the target's shape, so a colour's
 * reference dropped on a number is not a narrowing the resolver can perform: it is a
 * category error that would surface later as a diagnostic on a parameter the user did not
 * think they had broken. Comparing arity catches exactly that case and nothing else — the
 * scalar-to-scalar pastes (number → boolean → enum) stay legal, because an expression
 * genuinely does coerce across them (§V107).
 */
function parameterArity(definition: ParameterDefinition): number {
  switch (definition.type) {
    case "color":
      return 4;
    case "vector":
      return definition.size;
    default:
      return 1;
  }
}

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
  const trimmed = text.trim();
  const reference = parseParameterReference(trimmed);
  if (reference !== null) {
    return {
      kind: "reference",
      // A reference names a value it has not read: the string is all the text carried,
      // so the "value snapshot" is that string and a `paste as value` of it is refused
      // by name below rather than landing `op('a').par.b` as a literal.
      value: trimmed,
      valueText: trimmed,
      reference: trimmed,
      nodeName: reference.nodeName,
      parameterKey: reference.parameterKey,
      binding: null,
      arity: null,
      typeName: null,
    };
  }
  const value = parseValueText(trimmed);
  if (!value.ok) return null;
  return {
    kind: "value",
    value: value.value,
    valueText: trimmed,
    reference: null,
    nodeName: null,
    parameterKey: "",
    binding: null,
    arity: null,
    typeName: null,
  };
}

interface Located {
  node: GraphNode;
  definition: ParameterDefinition;
}

function locate(context: CommandContext, input: ParameterRef): Located | RuntimeDiagnostic {
  const node = context.graph.nodes[input.nodeId];
  if (node === undefined) return refuse("parameter.node", `No node "${input.nodeId}".`);
  // T880: a customWgsl's controls are reflected from its own shader, so validate the WRITE
  // against the node's EFFECTIVE schema — otherwise a reflected param (orbitSpeed, lightColor)
  // is "unknown" and every edit to it is refused, which is what the owner hit.
  const definition = effectiveParameterSchema(context.registry.get(node.type), node.parameters)[input.parameterKey];
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

/**
 * Reads a parameter WHOLE — value, reference, active binding — in one place (T1004).
 *
 * One function behind all three copy commands, so "what does copying a parameter capture"
 * cannot answer differently depending on which row was clicked. The commands differ only
 * in which string they mirror to the system clipboard, because that is the only place a
 * choice is genuinely forced (one string fits).
 */
function capture(
  context: CommandContext,
  key: string,
  found: Located,
  kind: "value" | "reference",
): ParameterClipboard {
  const resolved = resolveParameter(found.node, key, found.definition, {
    schema: effectiveParameterSchema(context.registry.get(found.node.type), found.node.parameters),
  });
  const name = nodeName(found.node);
  const stored = found.node.parameters[key];
  const slot = isParameterSlot(stored) ? stored : null;
  // The ACTIVE binding only. A retained-but-inactive expression is what the SOURCE chose
  // not to be running; pasting it would hand the target a payload the source itself is
  // not using, which is not what "copy this parameter" means to anybody.
  const active = slot !== null && slot.mode !== "static" ? (slot.bindings[slot.mode] ?? null) : null;
  return {
    kind,
    // The EFFECTIVE value, not the stored one: copying from a parameter running an
    // expression should give you the number you can see, which is the only reason
    // anyone copies a value off a driven parameter.
    value: resolved.value,
    valueText: valueText(resolved.value),
    reference: name === undefined ? null : parameterReference(name, key),
    nodeName: name ?? null,
    parameterKey: key,
    binding: active,
    arity: parameterArity(found.definition),
    typeName: found.definition.type,
  };
}

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
  bus: LoomBus,
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
      /**
       * The document first, the FLATTENED document second (T615, §V82).
       *
       * A pulse inside a component instance fires on a node that only exists once the
       * instance is inlined: `c1/reset` is a real node in the plan and no node at all in
       * the document. Falling through to the flattening is what makes such a pulse
       * dispatch at all — and it keeps ONE pulse path, so the expression-fired pulse and
       * the inspector's button still agree about what firing means, and the audit entry
       * (§V31) is still written here where the pulse happened.
       *
       * `$node` is then substituted with the FLAT id, which is the id the plan uses: a
       * Feedback inside a component clears `c1/fb`'s pair, which is the one that exists.
       */
      const node = context.graph.nodes[input.nodeId] ?? bus.flattenedGraph()?.nodes[input.nodeId];
      if (node === undefined) {
        return {
          status: "rejected",
          output: nothing,
          diagnostics: [refuse("parameter.pulse.node", `No node "${input.nodeId}".`)],
        };
      }
      const definition = effectiveParameterSchema(context.registry.get(node.type), node.parameters)[input.parameterKey];
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

  /**
   * Fills the bus clipboard and mirrors ONE string outward (T246, T1004, §V148).
   *
   * `mirror` picks which member leaves the app. That, and nothing else, is what separates
   * the three copy commands: the capture is identical, so a "Copy value" followed by a
   * "Paste reference" still works — which is the whole point of deferring the decision.
   */
  const copyHandler =
    (kind: "value" | "reference", mirror: (payload: ParameterClipboard) => string | null) =>
    (input: ParameterRef, context: CommandContext) => {
      const found = locate(context, input);
      if (isDiagnostic(found)) {
        return { status: "rejected" as const, output: { text: null }, diagnostics: [found] };
      }
      const payload = capture(context, input.parameterKey, found, kind);
      const text = mirror(payload);
      if (text === null) {
        // §V127: `op('…')` resolves because a name is unique in its network. A node with
        // no name has nothing to reference, and inventing one here would produce a string
        // that stops working the moment the user names the node themselves.
        return {
          status: "rejected" as const,
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
      if (!context.dryRun) {
        clipboard = payload;
        options.writeClipboard?.(text);
      }
      return { status: context.dryRun ? ("validated" as const) : ("applied" as const), output: { text } };
    };

  bus.registerCommand({
    name: "parameter.copy",
    description:
      "Copy a parameter WHOLE — value, reference and binding — so paste can choose.",
    // The reference is what a user most often wants out in the world (§V148); a node with
    // no name has none, and the value text is then the honest thing to mirror rather than
    // a refusal — this command captured everything either way.
    handler: copyHandler("reference", (payload) => payload.reference ?? payload.valueText),
    rejectionOutput: () => ({ text: null }),
  });

  bus.registerCommand({
    name: "parameter.copyValue",
    description: "Copy a parameter's effective value as text (T246).",
    handler: copyHandler("value", (payload) => payload.valueText),
    rejectionOutput: () => ({ text: null }),
  });

  bus.registerCommand({
    name: "parameter.copyReference",
    description: "Copy a reference that pastes into an expression (T246, §V148).",
    // Null mirror = refuse. Unlike `parameter.copy`, this command's ENTIRE purpose is the
    // string, so an unnamed node has to be told rather than handed a number instead.
    handler: copyHandler("reference", (payload) => payload.reference),
    rejectionOutput: () => ({ text: null }),
  });

  bus.registerCommand({
    name: "parameter.paste",
    description:
      "Paste the copied value, reference or binding onto this parameter (T246).",
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

      const reject = (diagnostic: RuntimeDiagnostic) =>
        ({ status: "rejected" as const, output: rejectedPatch(revision, [diagnostic]) });

      /**
       * §V288's rule, applied to the shapes a reference cannot bridge.
       *
       * A reference and a binding both resolve to ONE value of the TARGET's shape, so a
       * colour dropped on a number is not something the resolver can narrow — it would
       * surface later as a diagnostic on a parameter the user does not remember touching.
       * Named here, at the gesture, with the fix in the message: §V113's component
       * reference is the thing they actually wanted.
       *
       * Only checked when the source's shape is KNOWN. A payload that arrived as text
       * carries no schema, and a guess dressed as a check is worse than no check.
       */
      const shapeRefusal = (what: string): RuntimeDiagnostic | null => {
        const target = parameterArity(found.definition);
        if (source.arity === null || source.arity === target) return null;
        return refuse(
          "parameter.paste.shape",
          `"${input.parameterKey}" (${found.definition.type}) holds ${target} number${
            target === 1 ? "" : "s"
          } and the copied "${source.parameterKey}"${
            source.typeName === null ? "" : ` (${source.typeName})`
          } holds ${source.arity}; a ${what} cannot reshape it.`,
          found.node.id,
          source.reference !== null && target === 1
            ? `Copy one component instead — ${source.reference}.r (§V113).`
            : "Copy a parameter of the same shape, or paste its value onto each component.",
        );
      };

      /** Absent `as` = whatever the copy mirrored outward, which is the legacy default. */
      const mode: ParameterPasteMode = input.as ?? source.kind;

      if (mode === "value") {
        if (source.kind === "reference" && input.text !== undefined) {
          // The silent-success trap this module's header is about, met from the other
          // side: `op('a').par.b` is also a perfectly good string, and landing it as one
          // is a paste that looks like it worked and references nothing.
          return reject(
            refuse(
              "parameter.paste.textIsReference",
              `The pasted text is a reference (${source.valueText}), not a value.`,
              found.node.id,
              "Paste reference lands it as one; a literal string has to be typed.",
            ),
          );
        }
        const invalid = validateParameterValue(
          input.parameterKey,
          found.definition,
          source.value,
          found.node.id,
        );
        if (invalid !== null) {
          // Refused, not coerced: pasting a colour onto a number should say so rather
          // than silently landing the first channel.
          return reject(invalid);
        }
        const stored = found.node.parameters[input.parameterKey];
        // §V108: the target's retained expression/bind/map SURVIVE a value paste. The
        // corner mark promises they are still there, and a paste that wiped them would
        // make the mark a lie in exactly the place a user experiments most.
        const next: StoredParameter = isParameterSlot(stored)
          ? { mode: "static", bindings: { ...stored.bindings, static: { kind: "static", value: source.value } } }
          : source.value;
        return writeParameters(context, "Paste value", found.node.id, {
          [input.parameterKey]: next,
        });
      }

      const stored = found.node.parameters[input.parameterKey];
      const slot = isParameterSlot(stored)
        ? stored
        : slotFromValue(stored ?? defaultParameterValue(found.definition));

      if (mode === "binding") {
        if (source.binding === null) {
          // Offered and refused BY NAME (§V288): a missing item teaches nothing, and
          // "there is no binding on what you copied" is the whole answer.
          return reject(
            refuse(
              "parameter.paste.noBinding",
              input.text === undefined
                ? `The copied "${source.parameterKey}" is a constant; it carries no binding.`
                : "Pasted text carries no binding — only a value or a reference.",
              found.node.id,
              "Paste value lands the number it was worth; Paste reference points at it live.",
            ),
          );
        }
        const shape = shapeRefusal("binding");
        if (shape !== null) return reject(shape);
        const binding = source.binding;
        // §V108 again: only the mode being pasted is overwritten. Every OTHER retained
        // payload on the target rides through, so pasting an expression over a parameter
        // whose constant you liked does not cost you the constant.
        const next: ParameterSlot = {
          mode: binding.kind,
          bindings: { ...slot.bindings, [binding.kind]: binding },
        };
        return writeParameters(context, "Paste binding", found.node.id, {
          [input.parameterKey]: next,
        });
      }

      if (source.reference === null || source.nodeName === null) {
        return reject(
          refuse(
            "parameter.paste.noReference",
            input.text === undefined
              ? `The copied parameter's node has no name, so nothing can reference it.`
              : "The pasted text is a value, not a parameter reference.",
            found.node.id,
            input.text === undefined
              ? "Name the node and copy again — a reference addresses the name (§V127, §V148)."
              : "Paste value lands it as the value it is.",
          ),
        );
      }

      /**
       * §V148's round trip, and the one decision inside it.
       *
       * A reference to a parameter on the PASTE TARGET'S OWN node becomes a `bind`: binds
       * to a sibling resolve today, everywhere — the inspector and the compiler read them
       * through the same resolver (§V61), so the pasted reference produces the source
       * value on screen AND on the GPU.
       *
       * A reference to another node becomes an EXPRESSION carrying `op('…').par.…`, which
       * parses, is stored, is rewritten on rename (§V128), and reads the source's value
       * back through the node reference reader (T316).
       *
       * Both are "re-dropping the reference into the expression" in the owner's sense —
       * a live pointer, not a copy of a number. Which STORAGE mode carries it is decided
       * by whether a local bind can express it, and there is ONE such decision so the
       * explicit `as: "reference"` and the legacy default can never drift (§V109).
       */
      const sameNode = nodeByName(context.graph, source.nodeName) === found.node.id;
      if (sameNode && source.parameterKey === input.parameterKey) {
        return reject(
          refuse(
            "parameter.reference.self",
            `"${input.parameterKey}" cannot reference itself.`,
            found.node.id,
          ),
        );
      }
      const shape = shapeRefusal("reference");
      if (shape !== null) return reject(shape);

      const next: ParameterSlot = sameNode
        ? { mode: "bind", bindings: { ...slot.bindings, bind: { kind: "bind", ref: source.parameterKey } } }
        : {
            mode: "expression",
            bindings: {
              ...slot.bindings,
              expression: { kind: "expression", source: source.reference },
            },
          };

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
      // §T897: `driven` is retired as an AUTHORABLE mode — a channel read is an expression
      // term now. The schema still parses driven slots (documents in the wild), but nothing
      // may switch a parameter INTO the mode; refusing here keeps an agent or API caller
      // from resurrecting it past the removed button.
      if (input.mode === "driven") {
        return {
          status: "rejected",
          output: rejectedPatch(revision, [
            refuse(
              "parameter.mode.retired",
              `The "driven" mode is retired; read the channel from an expression instead — op('name').chan.value.`,
              input.nodeId,
            ),
          ]),
        };
      }
      const found = locate(context, input);
      if (isDiagnostic(found)) return { status: "rejected", output: rejectedPatch(revision, [found]) };
      // T903/§B166: the mode switch resolves against the node's EFFECTIVE schema, like every
      // other write. `locate` already found the parameter through the funnel; resolving the
      // seed value against the static schema would hand a reflected control an unresolvable
      // key and seed the mode it is switching INTO from nothing.
      const schema = effectiveParameterSchema(context.registry.get(found.node.type), found.node.parameters);
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

