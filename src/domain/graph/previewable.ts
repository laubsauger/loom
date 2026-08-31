import type { PortKind } from "../types/ports.ts";

/**
 * WHICH OUTPUT PORTS PREVIEW — one answer, for every site that asks (T532).
 *
 * ## Why this file exists
 *
 * A preview only appears if FOUR independent places agree that a port kind previews:
 *
 *  1. `node-view.tsx` renders the slot — no div, no measured bounds;
 *  2. `use-node-previews.ts` offers the node as a preview CANDIDATE — no bounds, no
 *     request, no preview sink;
 *  3. `compile.ts` synthesizes the picture when a sink watches it — no sink, no target;
 *  4. `node-box.ts` predicts the taller node the slot makes — the layout model, which
 *     every shipped example's overlap gate is measured against.
 *
 * Each was its own list of kinds, written at a different time. B65 is what (1) missing
 * `pointset` looks like: T373 built the whole splat path and it fed a slot that was never
 * created — "the pipeline was complete and its last millimetre was missing". T532 is the
 * same shape one kind further along: `scene` (a geometry) had no picture in (3), and when
 * that was written it would still have shown nothing, because (1), (2) and (4) had never
 * heard of it either.
 *
 * So the list is HERE, once. A new previewable port kind is added in one place and every
 * site follows, and `previewable-kinds.test.ts` asserts that no site keeps a private copy
 * — which is the only way this stops being rediscovered every eighteen months (§V437,
 * §V316, §V319).
 *
 * ## What belongs here
 *
 * A kind belongs if the system can DRAW something for it: a texture is its own picture, a
 * pointset splats, and each scene payload has a stock scene (T462, T532). A kind whose
 * only honest preview is "nothing" — a scalar, an event, a transform — stays out, because
 * an empty slot on every value-ish node is worse than no slot.
 *
 * Value nodes are the deliberate exception and are NOT here: their body is a channel PLOT
 * (T344), which is DOM rather than a GPU tile, and it is gated on `publishesValueChannels`
 * — a declared capability, not a port kind (T438, §V316).
 */
export const PREVIEWABLE_PORT_KINDS: ReadonlySet<PortKind> = new Set<PortKind>([
  /** The common case: the node's own output IS the picture. */
  "texture2d",
  /** T373/B65: a splat of the node's own points, at the compiler's stock framing. */
  "pointset",
  /** T462: a stock reference scene through this camera's own matrix. */
  "camera",
  /** T462: the stock ball lit by ONLY this light, zero ambient. */
  "light",
  /** T462: the shaded ball under the fixed key and fill. */
  "material",
  /**
   * T532: the geometry itself — its points worn as its own mode, with its instancing and
   * its composed material overrides, which are visible nowhere upstream.
   */
  "scene",
]);

export function isPreviewablePortKind(kind: PortKind): boolean {
  return PREVIEWABLE_PORT_KINDS.has(kind);
}

/** The first output port that previews, or undefined. The shape every caller wants. */
export function previewablePort<T extends { readonly type: { readonly kind: PortKind } }>(
  outputs: ReadonlyArray<T>,
): T | undefined {
  return outputs.find((port) => isPreviewablePortKind(port.type.kind));
}
