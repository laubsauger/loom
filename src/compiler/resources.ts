import type { NodeId, PortId } from "../domain/types/ids.ts";

/**
 * Logical resource identity (T29, §V8).
 *
 * One persistent resource per materialized output, named from the graph rather than from
 * allocation order: the id has to survive a recompile unchanged, or every edit would look
 * like a new resource and force a rebuild of everything downstream (§V5).
 *
 * Nothing is allocated inside the frame loop — the plan names every resource up front and
 * the backend creates them at compile time.
 */

export function targetResourceId(nodeId: NodeId, portId: PortId): string {
  return `target:${nodeId}:${portId}`;
}

/** A temporal output is a stable read/write pair, allocated once and swapped (§V22). */
export function pingPongResourceId(nodeId: NodeId, portId: PortId): string {
  return `pingpong:${nodeId}:${portId}`;
}

/**
 * A node-private intermediate target (T147): what a separable blur renders its first
 * pass into. Declared by the node's `compile()` result, materialized by the compiler,
 * never visible on a port — downstream nodes cannot reference it. Keyed by node id so
 * it survives recompiles under the same identity (§V8, T143 carry-over applies).
 */
export function scratchResourceId(nodeId: NodeId, key: string): string {
  return `scratch:${nodeId}:${key}`;
}

export function swapPassId(resourceId: string): string {
  return `swap:${resourceId}`;
}

/** One shared sampler for the whole plan; a per-node sampler would be identical objects. */
export const SHARED_SAMPLER_ID = "sampler:linear";

/**
 * Reserved port id for the render target of a declared sink that has no output ports.
 *
 * An Output node presents an image without publishing it as a port, so there is no port to
 * name its target after — but resource identity stays port-scoped in shape, so the target
 * is keyed under this reserved id rather than under the bare node id.
 */
export const SINK_TARGET_PORT = "$target";
