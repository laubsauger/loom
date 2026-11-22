/**
 * The SYSTEM clipboard, as the domain sees it (§T1393b).
 *
 * The owner: *"a universal copy with a selective paste where we can choose to paste name,
 * reference or value"* and *"copy networks from one window to the other in selections"*.
 * The bus clipboards (nodes in `editor-commands.ts`, parameters in `parameter-commands.ts`)
 * live in one tab's memory, so a copy never reached another window or another document.
 * The system clipboard is the one place both can see.
 *
 * Every copy writes TWO things there:
 *  - plain text — what a person pastes into a text field: a parameter's or channel's
 *    reference (`op('lfo1').chan.value`), a value, or for nodes the payload itself;
 *  - a Loom payload under its own type — the whole copy, every form of it, which Loom's
 *    own paste reads back in any window.
 *
 * Injected, never reached for: `navigator.clipboard` does not exist in Node, and a read can
 * be refused (permission, no user gesture). A missing or refused clipboard degrades to the
 * bus clipboard, which is exactly what every paste did before this existed.
 */
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { LoomBus } from "./bus.ts";

/** The clipboard type Loom's payload travels under (Chrome's web custom format prefix). */
export const LOOM_CLIPBOARD_TYPE = "web application/x-loom+json";

export interface SystemClipboard {
  /** Put `text` on the clipboard, with `loom` beside it under LOOM_CLIPBOARD_TYPE. */
  write(text: string, loom?: string): void;
  /** What is on the clipboard now; nulls when unreadable or refused. */
  read?(): Promise<{ readonly text: string | null; readonly loom: string | null }>;
}

/** A channel copied off a value node (§T1393b): its reference, its name, maybe its reading. */
export interface ChannelCopy {
  readonly nodeName: string;
  readonly channel: string;
  /** The reading when it was copied, when the surface had one. */
  readonly value: number | null;
}

export type LoomClipboardPayload =
  | {
      readonly kind: "nodes";
      readonly nodes: readonly unknown[];
      readonly edges: readonly unknown[];
      /**
       * §T1493b: the component definitions the copied instances need, with everything they
       * nest. Absent on a copy with no instances, and on one written before this existed.
       */
      readonly components?: readonly unknown[];
      /** T1821b(b): the ties the copied wires pass. Absent when none do, and on older copies. */
      readonly ties?: readonly unknown[];
    }
  | { readonly kind: "parameter"; readonly parameter: Readonly<Record<string, unknown>> }
  | { readonly kind: "channel"; readonly channel: ChannelCopy };

const MARKER = "loom-clipboard";
const VERSION = 1;

export function encodeLoomClipboard(payload: LoomClipboardPayload): string {
  return JSON.stringify({ [MARKER]: VERSION, ...payload });
}

/**
 * The payload in `text`, or null when it is not one this build can read. Shape-checked
 * at the top level only; each consumer validates the members it lands (a pasted node
 * still goes through the patch layer, a parameter paste through the parameter checks).
 */
export function decodeLoomClipboard(text: string | null): LoomClipboardPayload | null {
  if (text === null || !text.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record[MARKER] !== VERSION) return null;
  switch (record["kind"]) {
    case "nodes":
      return Array.isArray(record["nodes"]) && Array.isArray(record["edges"])
        ? {
            kind: "nodes",
            nodes: record["nodes"],
            edges: record["edges"],
            ...(Array.isArray(record["components"]) ? { components: record["components"] } : {}),
            ...(Array.isArray(record["ties"]) ? { ties: record["ties"] } : {}),
          }
        : null;
    case "parameter":
      return typeof record["parameter"] === "object" && record["parameter"] !== null
        ? { kind: "parameter", parameter: record["parameter"] as Record<string, unknown> }
        : null;
    case "channel": {
      const channel = record["channel"] as Partial<ChannelCopy> | undefined;
      if (typeof channel?.nodeName !== "string" || typeof channel.channel !== "string") return null;
      return {
        kind: "channel",
        channel: {
          nodeName: channel.nodeName,
          channel: channel.channel,
          value: typeof channel.value === "number" && Number.isFinite(channel.value) ? channel.value : null,
        },
      };
    }
    default:
      return null;
  }
}

/** Reads the clipboard's Loom payload, trying the typed slot first and the text second. */
export async function readLoomClipboard(
  clipboard: SystemClipboard | undefined,
): Promise<{ readonly payload: LoomClipboardPayload | null; readonly text: string | null } | null> {
  if (clipboard?.read === undefined) return null;
  try {
    const { text, loom } = await clipboard.read();
    return { payload: decodeLoomClipboard(loom) ?? decodeLoomClipboard(text), text };
  } catch {
    return null;
  }
}

/**
 * §T1493b — THE COMPONENTS A NODE COPY TAKES WITH IT, as the clipboard sees them.
 *
 * A component is document-scoped (§T962), so an instance copied into a document that lacks
 * its definition used to be refused. The copy now carries the definitions, and the paste
 * installs them by the §T1395b identity rule. The clipboard commands do not know what a
 * component is; whoever owns the catalogue attaches this (`registerComponentCommands`),
 * and a bus without one copies and pastes exactly as before.
 */
export interface ClipboardComponents {
  /** The definitions the node `types` instance and everything those nest, deepest first. */
  carry(types: readonly string[]): readonly unknown[];
  /**
   * Plans `carried` into this document for the copied node `types`, writing nothing. A
   * plan that could not be installed whole is a refusal, in words.
   */
  receive(
    types: readonly string[],
    carried: readonly unknown[],
    registry: NodeRegistryView,
  ): ClipboardArrival | { readonly refusal: string };
}

export interface ClipboardArrival {
  /**
   * Copied instance type → the type THIS document knows that component by: the same type
   * when it is reused or installed as it is, a renamed one (`bloom` → `bloom1`) when the
   * id is taken by a different component. Only the types the copy's definitions answer.
   */
  readonly types: ReadonlyMap<string, string>;
  /** Registers what the plan installs, and returns the undo of exactly that. */
  install(): () => void;
}

const clipboardComponents = new WeakMap<LoomBus, ClipboardComponents>();

export function attachClipboardComponents(bus: LoomBus, components: ClipboardComponents): void {
  clipboardComponents.set(bus, components);
}

export function clipboardComponentsFor(bus: LoomBus): ClipboardComponents | undefined {
  return clipboardComponents.get(bus);
}
