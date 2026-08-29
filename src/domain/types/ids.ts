/** Opaque, globally unique identities. Never derive an identity from an array index (§V40). */
export type NodeId = string;
export type EdgeId = string;
export type PortId = string;
export type GroupId = string;
export type AssetId = string;
export type ComponentId = string;

/** Monotonic document revision. Bumped once per applied command (§V33, §V40). */
export type Revision = number;

/**
 * Port-scoped identity of a rendered output (§V59).
 *
 * An output is named by a node AND a port, never a bare node id: `Render3D` emits colour,
 * depth, normals and object-id from one node, and even a Phase 1 debug node may want more
 * than one. Letting `outputId === nodeId` bake in anywhere turns multi-output into a
 * migration later.
 *
 * Four structurally identical copies of this had appeared independently — in the preview
 * system, the export interface and the agent surface — which is what a shared type
 * prevents.
 */
export interface OutputRef {
  nodeId: NodeId;
  portId: PortId;
}

/** Well-known port id for a single-output node, so the common case stays ergonomic. */
export const DEFAULT_OUTPUT_PORT = "out";

/** Canonical serialized form, for a map key or a diagnostic. */
export function formatOutputRef(ref: OutputRef): string {
  return `${ref.nodeId}/${ref.portId}`;
}

export function parseOutputRef(text: string): OutputRef | null {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return null;
  return { nodeId: text.slice(0, slash), portId: text.slice(slash + 1) };
}
