import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { PortKind } from "@domain/types/ports.ts";

/**
 * T712 — the type FAMILY a node belongs to, for the very subtle body tint that lets 3D,
 * point, texture and value nodes be told apart at a glance.
 *
 * ## Derived, not listed
 *
 * The family comes from the node's own primary OUTPUT port kind, and the mapping below is
 * `satisfies Record<PortKind, NodeFamily>` — so adding a member to the `PortType` union
 * without saying which family it belongs to is a TYPE ERROR, exactly as `PORT_FAMILY_VAR`
 * makes a new kind without a colour one (§V26, and T675's precedent). A hand-written list
 * of node types would have gone stale the first time a node was added; this cannot.
 *
 * The `projector` kind landed while this row was blocked, and it is in the table below
 * rather than having been forgotten — which is the property working.
 *
 * ## Why kinds are grouped rather than tinted one-for-one
 *
 * Fifteen hues, at one luminance, all within a "very very subtle" distance of the node
 * surface, cannot be told apart — the separations would be under a unit each and the whole
 * thing would be invisible (§T664's failure, which the owner asked for twice not to
 * repeat). The owner named four things — "3d/point/texture/value" — and five families is
 * what that grouping actually comes to once `buffer` is accounted for. Five is few enough
 * that each tint clears the next by a measurable margin AND stays close to the surface.
 *
 * ## What the tint is NOT
 *
 * It is REDUNDANT reinforcement, never the sole carrier: the node prints its type in its
 * own title, so nothing is lost to a reader who cannot see the hue. And it sits UNDER the
 * carriers that already speak colour on a node — the status dot, the component top edge
 * (T639), the selection ring and the error border — because it paints the BODY and those
 * paint the edges and the furniture. It must never be made to compete with them.
 */
export type NodeFamily = "texture" | "points" | "spatial" | "value" | "data";

/**
 * Port kind → family. Every kind, exhaustively.
 *
 * The groupings are the ones the port colours already imply, so the tint reinforces §V26
 * rather than introducing a second, contradictory code: a texture node leans toward the
 * teal its output port is drawn in, a pointset node toward blue, a buffer toward violet.
 */
const FAMILY_OF_KIND = {
  texture2d: "texture",
  // Everything that describes a thing in 3D space: the scene it lives in, what it is made
  // of, what lights it, what looks at it, and where it sits.
  scene: "spatial",
  material: "spatial",
  camera: "spatial",
  light: "spatial",
  projector: "spatial",
  transform3d: "spatial",
  pointset: "points",
  // The number family — a CHOP wire and everything shaped like one. `matrix` is here
  // rather than with the 3D set on purpose: it is a number payload, and §V26 already
  // draws it in the number tier.
  value: "value",
  scalar: "value",
  vector: "value",
  matrix: "value",
  event: "value",
  audioFeatures: "value",
  buffer: "data",
} satisfies Record<PortKind, NodeFamily>;

/**
 * The family for one port kind. Total over `PortKind` by construction — see the
 * `satisfies` above, which is what makes a new kind a compile error until it is listed.
 */
export function familyForKind(kind: PortKind): NodeFamily {
  return FAMILY_OF_KIND[kind];
}

/**
 * The family a node belongs to, or null when it has no payload of its own.
 *
 * Read from the node's FIRST output, which is its primary product. A sink — an Output, a
 * render target — has no outputs at all and gets no tint: it produces no payload, so there
 * is no family it could honestly claim, and it keeps the plain node surface. That is a
 * real distinction rather than a gap, and it is why this returns null instead of guessing
 * a default family.
 */
export function nodeFamilyOf(definition: NodeDefinition | undefined): NodeFamily | null {
  const primary = definition?.outputs[0];
  if (primary === undefined) return null;
  return familyForKind(primary.type.kind);
}

/** Every family, for the gate and for anything that needs to enumerate them. */
export const NODE_FAMILIES: readonly NodeFamily[] = [
  "texture",
  "points",
  "spatial",
  "value",
  "data",
];

/** Family → CSS custom property. Never a literal colour (§V17). */
export const FAMILY_TINT_VAR: Readonly<Record<NodeFamily, string>> = {
  texture: "--family-texture",
  points: "--family-points",
  spatial: "--family-spatial",
  value: "--family-value",
  data: "--family-data",
};
