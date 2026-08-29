import type { ComponentId, NodeId, PortId } from "./ids.ts";
import type { GraphDocument } from "./graph.ts";
import type { ParameterDefinition, ParameterValue, StoredParameter } from "./parameters.ts";
import type { CapabilityRequirement } from "./node-definition.ts";

/**
 * Components (TouchDesigner COMPs): a subgraph behind a stable external interface.
 *
 * They are the visual equivalent of a function, and the reason a graph stays legible past
 * thirty nodes. An instance references its definition by id and version and stores only
 * its own values — it never copies the internal graph, so fixing a bug in a component
 * fixes every linked instance (§V79). Detaching is the explicit opt-out.
 */

/** An internal port surfaced on the component's own boundary. */
export interface ExposedPort {
  /** Port id as seen from OUTSIDE the component. */
  externalId: PortId;
  label: string;
  /** The internal node and port it maps to. */
  nodeId: NodeId;
  portId: PortId;
}

/**
 * A parameter promoted onto the component's parameter page.
 *
 * One published parameter may drive SEVERAL internal parameters — a "Blur" knob on a
 * bloom component can drive the radius of three internal blurs at once. Editing it writes
 * every target in one atomic patch, so it is one undo step, not three (§V80).
 *
 * The definition is RE-AUTHORED rather than copied from the internal parameter: the point
 * of publishing is to present a better control than the internals expose — a different
 * label, a narrower range, a friendlier unit.
 */
export interface PublishedParameter {
  /** Name on the component's parameter page. */
  key: string;
  definition: ParameterDefinition;
  targets: ReadonlyArray<{ nodeId: NodeId; key: string }>;
}

export interface ComponentMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
}

export interface GraphComponentDefinition {
  componentId: ComponentId;
  version: number;
  name: string;
  description?: string;
  /** The internal network. Lives here once, not once per instance. */
  graph: GraphDocument;
  inputs: ExposedPort[];
  outputs: ExposedPort[];
  parameters: PublishedParameter[];
  capabilities?: CapabilityRequirement[];
  migrations?: ComponentMigration[];
}

/**
 * What a node in the parent graph stores when it IS a component instance.
 *
 * `version` is pinned: a newer definition does not silently change a saved project.
 * Upgrading is an explicit, migrated act (§V84, §V10).
 */
export interface ComponentInstanceState {
  componentId: ComponentId;
  version: number;
  /** Values for the component's PUBLISHED parameters, not for its internals (§V107: modes apply here too). */
  parameters: Record<string, StoredParameter>;
  /**
   * Per-instance overrides of an internal node's parameter, addressed by internal path.
   * An escape hatch for the case publishing did not anticipate; used sparingly.
   */
  overrides?: Record<string, ParameterValue>;
}

/**
 * Where the editor currently is. Empty = the root graph.
 *
 * Also the prefix for diagnostic and timing paths, so an error inside a nested component
 * reads `Main / DreamyFeedback_2 / Blur_1 / shader.wgsl:42` rather than naming a node id
 * the user has never seen (§V82).
 */
export type ComponentPath = ReadonlyArray<NodeId>;

export function formatComponentPath(path: ComponentPath, names: Readonly<Record<NodeId, string>>): string {
  return ["Main", ...path.map((id) => names[id] ?? id)].join(" / ");
}

/** Lexical `parent.<key>` scope: resolved by walking the instance chain, never by an edge. */
export interface ParentScope {
  /** Published parameter values of the component that owns the node being evaluated. */
  parameters: Readonly<Record<string, ParameterValue>>;
  /** Next scope up, for `parent.parent` in deeply nested components. */
  parent?: ParentScope;
}

export interface ComponentRecursionError {
  componentId: ComponentId;
  /** The reference chain that closes the loop, for a diagnostic a user can act on. */
  cycle: ReadonlyArray<ComponentId>;
}
