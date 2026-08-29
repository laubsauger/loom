/** Opaque, globally unique identities. Never derive an identity from an array index (§V40). */
export type NodeId = string;
export type EdgeId = string;
export type PortId = string;
export type GroupId = string;
export type AssetId = string;
export type ComponentId = string;

/** Monotonic document revision. Bumped once per applied command (§V33, §V40). */
export type Revision = number;
