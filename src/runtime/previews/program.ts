import type {
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
import type { PreviewProgram, PreviewSchedule } from "./types.ts";

/**
 * Turns a schedule into plan data (T34).
 *
 * The output is the STABLE half of the preview system: it changes when the active set, a tile
 * size or a debug mode changes, and at no other time. Panning, zooming inside a ladder step and
 * refreshing all leave it byte-identical, which is how §V8 ("no render-target allocation inside
 * the frame loop") holds without anyone having to remember it.
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

export function buildPreviewProgram(schedule: PreviewSchedule, atlas: TileAtlas): PreviewProgram {
  const allocations = atlas.sync(
    schedule.active.map((entry) => ({ key: previewKey(entry.ref), size: entry.tileSize })),
  );
  const byKey = new Map(allocations.map((allocation) => [allocation.key, allocation]));

  const passes: EffectPassDescriptor[] = [];
  for (const entry of schedule.active) {
    const key = previewKey(entry.ref);
    const tile = byKey.get(key);
    // No tile means the atlas ran out — the scheduler's budget suspension should already have
    // prevented that, so this is a belt-and-braces skip rather than a silent partial render.
    if (tile === undefined) continue;
    passes.push({
      kind: "effect",
      id: previewPassId(key),
      shader: previewShader(entry.request.view.mode),
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
    passes.length === 0 ? [] : [PREVIEW_SAMPLER, ...atlas.descriptors()];

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
