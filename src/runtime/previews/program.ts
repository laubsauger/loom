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
import { pointSplatNdcExtent } from "../../nodes/shaders/points-preview.wgsl.ts";
import { createTileAtlas } from "./tile-atlas.ts";
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
     * sized to the granted tile, so a zoom boost buys real pixels, and rebuilt outside
     * the frame like every other program resource, so a ladder crossing repaints even
     * with the transport paused. The draw passes render it on the preview cadence; the
     * lens pass below reads it exactly as it reads a main-plan texture.
     *
     * T663 — the tile's OWN size, not the square it used to be forced into.
     *
     * This was `[max(w, h), max(w, h)]` while the stock framings were square, and it was
     * the last place the squareness actually lived: `tileSizeFor` already derives the
     * tile from the source's aspect, so once the compiler stopped nominating a square
     * source, everything upstream of here was project-shaped and this line alone would
     * have stretched it back. The three sites have to agree — the compiler's nominal
     * size, the granted tile, and this target — or the picture is drawn at one aspect
     * and shown at another.
     */
    const synthesis = entry.request.synthesis;
    if (synthesis !== undefined) {
      const size: [number, number] = [
        Math.max(1, tile.size[0] ?? 1),
        Math.max(1, tile.size[1] ?? 1),
      ];
      synthesized.push({
        kind: "target",
        id: entry.request.source.resourceId,
        size,
        format: "rgba8unorm",
        ...(synthesis.depth ? { depth: true } : {}),
        label: `${key} synthesized preview`,
      });
      /*
       * T952 — A DEVICE-PIXEL SIZE HAS TO BE RESTATED AGAINST THE TILE THAT EXISTS.
       *
       * The splat's disc is a fixed number of device pixels, and the shader takes that as
       * an NDC extent, so the conversion needs the target's texel size — which is decided
       * HERE and nowhere else. The compiler emits the same uniform against its NOMINAL
       * size (§V521: the compiler owns WHAT is drawn, not WHERE it lives, and a pixel is a
       * fact about where), so without this line a boosted tile would draw the nominal
       * fraction and the disc would grow with the tile all over again.
       *
       * Rewriting the uniform WHERE IT IS ALREADY DECLARED, rather than against a list of
       * pass ids the compiler publishes: a list is two places that must agree, and §T675
       * is this file's own record of what that costs. A third splat site is covered by
       * construction, and a pass that does not take `pointSize` is untouched by
       * construction — the same "keyed on the thing itself, never on a list" the pointset
       * synthesis is gated by (§V316, §V319).
       *
       * Values only, so §V5 holds: `passStructureKey` keys uniforms by NAME, so this
       * cannot move the signature. It does not need a push path either (unlike B118's
       * lens values) — it changes only when the tile does, and a tile change has already
       * rewritten the target descriptor above and forced the reinstall that uploads it.
       */
      for (const pass of synthesis.passes) {
        passes.push(
          pass.uniforms?.["pointSize"] === undefined
            ? pass
            : { ...pass, uniforms: { ...pass.uniforms, pointSize: pointSplatNdcExtent(size) } },
        );
      }
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

/**
 * The program that installs NOTHING (B143).
 *
 * A preview program is a list of passes that BIND MAIN-PLAN RESOURCES BY ID, and its ids are
 * node ids — the names a person typed. So the program built for one document is not merely
 * useless against the next one's main plan, it is WRONG about it: every tile whose node id the
 * incoming document does not have binds a resource that no longer exists, and the backend says
 * so, correctly, once per pass (`backend/unknown-resource`). E24 → E2 is 48 tiles meeting 9
 * survivors: thirty-nine true diagnostics about a program nobody wants any more.
 *
 * The window exists because the main plan installs FIRST — `backend.compile` resolves and
 * re-points every preview host (`refreshPreviewExternals`) before the preview tick's next rAF
 * gets to notice the load. Pushing this at the boundary closes the window from the other side:
 * there is no stale program left for the incoming plan to be measured against. The report is
 * not silenced — it is made untrue.
 *
 * Built rather than written out so it cannot drift from `buildPreviewProgram`'s own empty case,
 * which is what `plan()` pushes the moment a document has nothing to preview.
 */
export const EMPTY_PREVIEW_PROGRAM: PreviewProgram = buildPreviewProgram(
  [],
  createTileAtlas({ capacity: 0 }),
);
