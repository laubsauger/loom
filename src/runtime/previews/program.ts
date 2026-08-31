import type {
  DrawPassDescriptor,
  EffectPassDescriptor,
  ResourceDescriptor,
  SamplerResourceDescriptor,
} from "../backend/plan.ts";
import { passStructureKey, resourceStructureKey } from "../backend/plan.ts";
import {
  PREVIEW_SAMPLER_BINDING,
  PREVIEW_TEXTURE_BINDING,
  PREVIEW_UNIFORM_BINDING,
  previewShader,
  previewUniforms,
} from "./debug-effects.ts";
import type { TileAtlas } from "./tile-atlas.ts";
import { previewKey } from "./types.ts";
import type { AllocatedPreview, PreviewProgram } from "./types.ts";

/**
 * Turns a schedule into plan data (T34).
 *
 * The output is the STABLE half of the preview system: it changes when the ALLOCATED set, a
 * tile size or a debug mode changes, and at no other time. Panning, zooming and refreshing all
 * leave it byte-identical — allocation follows the request set and the node's own preview area,
 * neither of which the camera touches (§V142) — which is how §V8 ("no render-target allocation
 * inside the frame loop") holds without anyone having to remember it.
 *
 * Everything emitted here is plain data from the existing plan IR — no new pass or resource
 * kinds (§V58), no functions, no DOM references (§V63).
 */

/** One shared sampler for every preview pass; linear so downscaling to a tile looks right. */
export const PREVIEW_SAMPLER: SamplerResourceDescriptor = Object.freeze({
  kind: "sampler",
  id: "preview/sampler",
  filter: "linear",
  addressMode: "clamp-to-edge",
});

export function previewPassId(key: string): string {
  return `preview/pass/${key}`;
}

/**
 * `allocated` is in PRIORITY order: the atlas keeps the head of the list when the pool is
 * smaller than the list, so previews that are drawing this frame must come first.
 */
export function buildPreviewProgram(
  allocated: ReadonlyArray<AllocatedPreview>,
  atlas: TileAtlas,
): PreviewProgram {
  const allocations = atlas.sync(
    allocated.map((entry) => ({ key: previewKey(entry.ref), size: entry.tileSize })),
  );
  const byKey = new Map(allocations.map((allocation) => [allocation.key, allocation]));

  const passes: (EffectPassDescriptor | DrawPassDescriptor)[] = [];
  const synthesized: ResourceDescriptor[] = [];
  for (const entry of allocated) {
    const key = previewKey(entry.ref);
    const tile = byKey.get(key);
    // No tile means the pool ran out. For a preview that is drawing, the scheduler's budget
    // suspension should already have prevented that; for one that is only holding a tile, it
    // is the ordinary case — it lost its slot to a preview that is actually on screen.
    if (tile === undefined) continue;
    /*
     * T563: a SYNTHESIZED preview's source target lives HERE, not in the main plan —
     * sized to the granted tile (square: the stock framings are square), so a zoom
     * boost buys real pixels, and rebuilt outside the frame like every other program
     * resource, so a ladder crossing repaints even with the transport paused. The draw
     * passes render it on the preview cadence; the lens pass below reads it exactly as
     * it reads a main-plan texture.
     */
    const synthesis = entry.request.synthesis;
    if (synthesis !== undefined) {
      const edge = Math.max(1, tile.size[0] ?? 1, tile.size[1] ?? 1);
      synthesized.push({
        kind: "target",
        id: entry.request.source.resourceId,
        size: [edge, edge],
        format: "rgba8unorm",
        ...(synthesis.depth ? { depth: true } : {}),
        label: `${key} synthesized preview`,
      });
      passes.push(...synthesis.passes);
    }
    passes.push({
      kind: "effect",
      id: previewPassId(key),
      // T375 (§V57): the source's DECLARED space, not an assumption. An Output node's
      // target is display-encoded; every other node's is linear; the tile is the same
      // picture either way because the shader is told which it is getting.
      shader: previewShader(entry.request.view.mode, entry.request.source.space),
      target: tile.resourceId,
      clear: true,
      textures: [
        { binding: PREVIEW_TEXTURE_BINDING, resourceId: entry.request.source.resourceId },
      ],
      samplers: [{ binding: PREVIEW_SAMPLER_BINDING, resourceId: PREVIEW_SAMPLER.id }],
      uniforms: previewUniforms(entry.request.view),
      uniformBinding: PREVIEW_UNIFORM_BINDING,
      nodeId: entry.ref.nodeId,
      label: `preview ${key}`,
    });
  }

  passes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const resources: ResourceDescriptor[] =
    passes.length === 0 ? [] : [PREVIEW_SAMPLER, ...atlas.descriptors(), ...synthesized];

  return {
    resources,
    passes,
    // Reuses the backend's own structural-key functions rather than hashing the objects: those
    // exclude uniform VALUES by construction (§V5), so changing exposure or a channel mask
    // cannot make the host think it needs to rebuild resources.
    signature: JSON.stringify({
      resources: resources.map(resourceStructureKey),
      passes: passes.map(passStructureKey),
    }),
  };
}
