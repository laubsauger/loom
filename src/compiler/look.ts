import type { GraphDocument, GraphEdge, GraphNode } from "../domain/types/graph.ts";
import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { CameraPayload } from "../domain/types/scene.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { clampOrbitDistance, isDefaultOrbit, orbitPose, type PreviewOrbit } from "../runtime/previews/orbit.ts";
import type { ActiveSink, CompiledInputBinding } from "./types.ts";

/**
 * §T1732b — LOOK AROUND A RENDER WITHOUT MOVING ITS CAMERA.
 *
 * The owner, 2026-11-06: "I definitely need to be able to move geometry viewers, camera
 * viewers equally", without losing the expressions that drive the camera. A geometry tile
 * has had an inspection orbit since T561; a Render's picture had none, because it is drawn
 * through a camera node's pose and an override of that pose would falsify the one thing the
 * tile shows (§T614).
 *
 * ## Why a second compile and not an override
 *
 * The camera design's cheap route (`docs/camera-fly-design-2026-10-06.md` §3) was to clone
 * the Render's draw passes and write the clone's camera uniforms. A Render derives far more
 * than `viewProjection` from its camera: the eye, the view direction, the AO depth row and
 * its projection, the half-height, a shadow fit. An override would be a second copy of every
 * one of those derivations, and the copy would drift.
 *
 * So the Render is compiled TWICE. The second is a clone of the node, under its own id, with
 * the same inputs wired, and the camera payload on its camera input SUBSTITUTED: the live
 * camera's payload with its eye and look-at moved by the look's orbit. Every derivation is
 * then the Render's own, by construction, and its scratch (shadow maps, AO) is its own.
 *
 * ## What it costs, and when
 *
 * A clone exists only while a `look` sink names the renderer (the editor sends one while a
 * look is moved off its camera), and only when the renderer is itself kept. Then the Render
 * draws twice. Nothing reads the clone's target but the tile and the viewer, so the node's
 * own output is byte-identical with a look on or off, and an export, a thumbnail or a
 * headless render never carries one (they send no `look` sink).
 *
 * ## Where the orbit is read
 *
 * At a FRAME only (`compileFrame`, and a full compile that resolves a frame). A structural
 * compile draws the clone at its camera's own pose, so it stays a pure function of its
 * request; the frame path, which already re-resolves what moves, moves the look.
 */

/** A look clone: whose clone it is, the input its camera arrives on, and where its orbit is read. */
export interface LookClone {
  readonly renderer: NodeId;
  readonly cameraPort: PortId;
  readonly orbit: () => PreviewOrbit | undefined;
}

const NO_CLONES: ReadonlyMap<NodeId, LookClone> = new Map();
const NO_ORBIT = (): PreviewOrbit | undefined => undefined;

/**
 * The clone's node id. A suffix, so a renderer inside an instance keeps its instance path
 * (`rig/render_shot~look`) and its `parent.` binds resolve where the renderer's do. `~` is
 * not a character a node name may hold (`kind_role`), so no authored node can collide.
 */
export const lookCloneId = (renderer: NodeId): NodeId => `${renderer}~look`;

/**
 * The graph with a clone of each renderer a `look` sink names: the renderer's node under
 * `lookCloneId`, NAMELESS (so `op('render_shot')` still finds one node), with every edge
 * into the renderer copied onto it. Called after the source-reference edges are synthesized,
 * so a camera, a light or a scene named by a parameter arrives on the clone the same way.
 *
 * A renderer with no camera on its camera input is not cloned: its picture is drawn through
 * its own Eye and Look At, which its tile's gizmo moves (T692).
 */
export function withLookClones<G extends GraphDocument>(
  graph: G,
  sinks: ReadonlyArray<ActiveSink> | undefined,
  registry: NodeRegistryView,
): { readonly graph: G; readonly clones: ReadonlyMap<NodeId, LookClone> } {
  const looks = (sinks ?? []).filter((sink) => sink.kind === "look");
  if (looks.length === 0) return { graph, clones: NO_CLONES };
  const nodes: Record<NodeId, GraphNode> = { ...graph.nodes };
  const edges: Record<string, GraphEdge> = { ...graph.edges };
  const clones = new Map<NodeId, LookClone>();
  const into = new Map<NodeId, GraphEdge[]>();
  for (const edge of Object.values(graph.edges)) {
    const list = into.get(edge.target.nodeId);
    if (list === undefined) into.set(edge.target.nodeId, [edge]);
    else list.push(edge);
  }
  for (const sink of looks) {
    const node = graph.nodes[sink.nodeId];
    const id = lookCloneId(sink.nodeId);
    if (node === undefined || clones.has(id)) continue;
    const port = registry.get(node.type)?.inputs.find((input) => input.type.kind === "camera");
    const incoming = into.get(node.id) ?? [];
    if (port === undefined || !incoming.some((edge) => edge.target.portId === port.id)) continue;
    const { label: _label, ...rest } = node;
    nodes[id] = { ...rest, id };
    for (const edge of incoming) {
      const edgeId = `${edge.id}~look`;
      edges[edgeId] = { ...edge, id: edgeId, target: { ...edge.target, nodeId: id } };
    }
    clones.set(id, { renderer: node.id, cameraPort: port.id, orbit: sink.orbit ?? NO_ORBIT });
  }
  if (clones.size === 0) return { graph, clones: NO_CLONES };
  return { graph: { ...graph, nodes, edges }, clones };
}

/**
 * A camera, moved by a look: its eye and look-at orbited exactly as an inspection orbit moves
 * a stock rig (`orbitPose`, deltas over the pose, so an identity orbit is the camera itself,
 * float for float). Optics, roll and motion are the camera's. An orthographic camera has no
 * distance to dolly, so the wheel scales its frustum instead.
 */
export function lookCameraPayload(camera: CameraPayload, orbit: PreviewOrbit | undefined): CameraPayload {
  if (orbit === undefined || isDefaultOrbit(orbit)) return camera;
  const pose = orbitPose({ eye: camera.eye, lookAt: camera.lookAt }, orbit);
  return {
    ...camera,
    eye: pose.eye,
    lookAt: pose.lookAt,
    ...(camera.ortho ? { orthoHeight: camera.orthoHeight * clampOrbitDistance(orbit.distance) } : {}),
  };
}

/** A clone's inputs with its camera substituted. Any other input is the renderer's own binding. */
export function lookCameraInputs<I extends Readonly<Record<PortId, ReadonlyArray<CompiledInputBinding>>>>(
  inputs: I,
  clone: LookClone,
  orbit: PreviewOrbit | undefined,
): I {
  const bindings = inputs[clone.cameraPort];
  if (bindings === undefined || orbit === undefined || isDefaultOrbit(orbit)) return inputs;
  return {
    ...inputs,
    [clone.cameraPort]: bindings.map((binding) =>
      binding.scene?.kind === "camera" ? { ...binding, scene: lookCameraPayload(binding.scene, orbit) } : binding,
    ),
  };
}
