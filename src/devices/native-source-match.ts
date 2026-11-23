import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { enteredThrough } from "@domain/components/addressing.ts";
import type { NativeInputSourceInfo } from "./native-input.ts";

/**
 * VN113 — which live native server a stored input means. Owner ruling (2026-10-10): a
 * Syphon In matches its server by NAME — the publishing app plus the server's name — so a
 * pipeline comes back after Resolume (or any publisher) relaunches and mints a new
 * discovery UUID. The UUID is kept only as a hint that settles a tie between servers with
 * the same app and name. This reverses T1347's exact-UUID stance by that ruling.
 *
 * Pure and headless: the hook (`use-native-inputs.ts`) and the inspector section both
 * call THIS, so the status the section shows and the server the hook opens cannot differ.
 */
export interface StoredNativeSource {
  /** The discovery id last bound (Syphon: a UUID that changes per publisher launch). */
  readonly id: string;
  /** The publishing application, e.g. "Arena". Empty in documents written before VN113. */
  readonly app: string;
  /** The server's own name, e.g. "LED FX". Empty in documents written before VN113. */
  readonly name: string;
}

export type NativeSourceMatch =
  /** Nothing stored at all: the user has not picked a source. */
  | { readonly kind: "unselected" }
  /** A live server answers. `candidates` > 1 means the name was ambiguous. `by` says which
   * identity decided: "name" for app + name, "id" for an older document with only a UUID. */
  | { readonly kind: "bound"; readonly source: NativeInputSourceInfo; readonly by: "name" | "id"; readonly candidates: number }
  /** Nothing live answers the stored identity. Hold the last image and keep looking. */
  | { readonly kind: "unresolved"; readonly by: "name" | "id" };

export function resolveNativeSource(stored: StoredNativeSource, discovered: readonly NativeInputSourceInfo[]): NativeSourceMatch {
  if (stored.name !== "" || stored.app !== "") {
    const candidates = discovered.filter(entry => entry.app === stored.app && entry.name === stored.name);
    if (candidates.length === 0) return { kind: "unresolved", by: "name" };
    const source = candidates.find(entry => entry.id === stored.id) ?? candidates[0]!;
    return { kind: "bound", source, by: "name", candidates: candidates.length };
  }
  if (stored.id === "") return { kind: "unselected" };
  const source = discovered.find(entry => entry.id === stored.id);
  return source ? { kind: "bound", source, by: "id", candidates: 1 } : { kind: "unresolved", by: "id" };
}

/** How a server is named to a person: "Arena – LED FX". Falls back to whatever is known. */
export function nativeSourceLabel(source: { readonly app: string; readonly name: string; readonly id?: string }): string {
  if (source.app && source.name) return `${source.app} – ${source.name}`;
  return source.name || source.app || source.id || "";
}

/** The one sentence for an ambiguous name, shared by the node's warning and the inspector. */
export function duplicateSourceWarning(source: { readonly app: string; readonly name: string }, candidates: number): string {
  return `${candidates} live servers are named ${nativeSourceLabel(source)}; bound to the first. Rename the publishers to tell them apart.`;
}

/** The one sentence while a stored source is not live. */
export function waitingForSourceMessage(stored: StoredNativeSource): string {
  return `Waiting for ${nativeSourceLabel(stored)}; retained image is stale until it appears.`;
}

/** Flattened node id → key → the root parameter that value is published from (the
 * flattening's `publishedOrigins`, structurally: this module stays free of the compiler). */
export type NativeSourceOrigins = ReadonlyMap<NodeId, Readonly<Record<string, { readonly nodeId: NodeId; readonly key: string }>>>;

/**
 * VN113 — where a bind is WRITTEN so a save keeps it, for a node addressed by its id in the
 * plan (the flattened id). The hook's write-back and the inspector's pick both build their
 * one patch here, so the two cannot persist a source to different places.
 *
 * - A root node: its own `setParameters`.
 * - A node inside a component instance (`instance/inner`, nested `outer/two/inner`): each key
 *   the component PUBLISHES goes to the root parameter it is published from (the instance's
 *   page, which is what the instance stores and a save keeps). Every other key becomes the
 *   instance's own internal override (`setParameters` with `internalNodeId`, stored in the
 *   instance's `componentOverrides`), so it persists per instance without touching the
 *   definition every other instance shares. The override goes first: the patch refuses an
 *   internal write once the same patch has changed the instance's parameters.
 */
export function nativeSourceBindOperations(planNodeId: NodeId, parameters: Readonly<Record<string, string>>,
  origins: NativeSourceOrigins | undefined): GraphPatchOperation[] {
  const entered = enteredThrough(planNodeId);
  if (entered === undefined) return [{ op: "setParameters", nodeId: planNodeId, parameters: { ...parameters } }];
  const published = origins?.get(planNodeId) ?? {};
  const internal: Record<string, string> = {};
  const owners = new Map<NodeId, Record<string, string>>();
  for (const [key, value] of Object.entries(parameters)) {
    const origin = published[key];
    if (origin === undefined) { internal[key] = value; continue; }
    owners.set(origin.nodeId, { ...owners.get(origin.nodeId), [origin.key]: value });
  }
  return [
    ...(Object.keys(internal).length === 0 ? [] : [{ op: "setParameters" as const, nodeId: entered.instance, internalNodeId: entered.rest, parameters: internal }]),
    ...[...owners].map(([nodeId, values]) => ({ op: "setParameters" as const, nodeId, parameters: values })),
  ];
}
