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

/**
 * The synthesized splat target a watched pointset output previews into (T373, §V85).
 * Distinct from `target:` ids so it can never collide with a port a definition declares.
 */
export function pointsPreviewResourceId(nodeId: NodeId, portId: PortId): string {
  return `preview:points:${nodeId}:${portId}`;
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

/**
 * The synthesized stock-scene target a watched scene-payload output previews into
 * (T462, §V85) — a camera's reference scene, a light's or material's ball.
 */
export function scenePreviewResourceId(nodeId: NodeId, portId: PortId): string {
  return `preview:scene:${nodeId}:${portId}`;
}

/**
 * §T1311b(a) — the VIEWPORT target of an output whose shader declares a view camera.
 *
 * A second target, written by a second pass, read by NOTHING: that is what makes the
 * inspection camera non-destructive by construction rather than by a guard. The authored
 * target keeps the authored camera, and it is the one that is exported, thumbnailed,
 * claimed and consumed downstream.
 */
export function viewportResourceId(nodeId: NodeId, portId: PortId): string {
  return `viewport:${nodeId}:${portId}`;
}

/**
 * The port id the viewport output row is published under.
 *
 * `#` is the project's separator for something the COMPILER synthesized (`nodeId#pass:port`
 * everywhere in the pass ids), and no definition may declare a port id containing it — so
 * this can never collide with a port somebody wrote. The row is deliberately VISIBLE in the
 * viewer's output list: the viewport is a different picture from the node's output the
 * moment you move it, and naming it is the opposite of a preview that lies about what it
 * shows (§V-preview).
 */
export function viewportPortId(portId: PortId): string {
  return `${portId}#view`;
}
