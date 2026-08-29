import type { TargetResourceDescriptor } from "../backend/plan.ts";

/**
 * The preview tile atlas (T34, design note §2).
 *
 * "Atlas" in the spec's sense — a bounded, shared, reused set of preview tiles behind ONE
 * presentation surface — implemented as a pool of individually-addressable targets rather than
 * as sub-rects of one big texture. The design note argues that choice at length; the two
 * operative reasons are that `EffectPassDescriptor` has no viewport or scissor (so sub-rect
 * rendering would mean growing a closed plan union owned by another track, §V58), and that
 * tiles vary in aspect ratio per source and in size per zoom step, which turns a texture atlas
 * into a dynamic rectangle packer that repacks on every zoom step — the exact reallocation
 * churn §V8 exists to prevent.
 *
 * Tiles are always `rgba8unorm`: the debug effects end with an explicit display encode
 * (§V56), so a tile holds display-ready pixels regardless of whether the source was
 * `rgba16float`, `r32float` or 8-bit. That is what makes one pool enough.
 */

/** Every tile is display-encoded 8-bit — see the module note. */
export const TILE_FORMAT = "rgba8unorm" as const;

export interface TileRequest {
  /** Stable identity of what wants a tile — `previewKey(ref)`. */
  readonly key: string;
  readonly size: readonly [number, number];
}

export interface TileAllocation {
  readonly key: string;
  /** Plan resource id. Stable for as long as the key holds this slot. */
  readonly resourceId: string;
  readonly size: readonly [number, number];
}

export interface TileAtlas {
  /** How many previews can be live at once. Exceeding it is a §V28 `budget` suspension. */
  readonly capacity: number;
  /**
   * Reconcile the pool with exactly this set of tiles. Anything not named is released.
   * Returns allocations keyed by `TileRequest.key`, in the order requested.
   */
  sync(requests: ReadonlyArray<TileRequest>): ReadonlyArray<TileAllocation>;
  /** Current allocations as plan resources, sorted by id so the signature is deterministic. */
  descriptors(): ReadonlyArray<TargetResourceDescriptor>;
  /** Allocation for a key, or undefined. */
  get(key: string): TileAllocation | undefined;
  reset(): void;
}

export interface TileAtlasOptions {
  capacity: number;
  /** Prefix for generated resource ids. Distinct from compiler-emitted ids by construction. */
  idPrefix?: string;
}

interface Slot {
  readonly resourceId: string;
  key: string | null;
  size: readonly [number, number];
}

function sameSize(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Slots are allocated once and re-keyed, never recreated.
 *
 * That is the whole point: a slot's `resourceId` is stable, so as long as a preview keeps its
 * slot at the same size, the plan's resource signature for that tile does not change and the
 * backend keeps the existing texture (§V8, §V62). Panning, zooming within a ladder step, and
 * refreshing all leave the resource set byte-identical.
 */
export function createTileAtlas(options: TileAtlasOptions): TileAtlas {
  const capacity = Math.max(0, Math.floor(options.capacity));
  const prefix = options.idPrefix ?? "preview/tile";

  const slots: Slot[] = Array.from({ length: capacity }, (_unused, index) => ({
    resourceId: `${prefix}/${index}`,
    key: null,
    size: [1, 1] as readonly [number, number],
  }));
  const byKey = new Map<string, number>();

  function allocationFor(slot: Slot, key: string): TileAllocation {
    return { key, resourceId: slot.resourceId, size: slot.size };
  }

  return {
    capacity,

    sync(requests: ReadonlyArray<TileRequest>): ReadonlyArray<TileAllocation> {
      const wanted = requests.slice(0, capacity);
      const wantedKeys = new Set(wanted.map((request) => request.key));

      // Release first, so a preview that just became active can take a slot freed this frame
      // rather than being budget-suspended behind a stale one.
      for (const [key, index] of [...byKey.entries()]) {
        if (wantedKeys.has(key)) continue;
        const slot = slots[index];
        if (slot !== undefined) slot.key = null;
        byKey.delete(key);
      }

      const out: TileAllocation[] = [];
      for (const request of wanted) {
        const existingIndex = byKey.get(request.key);
        if (existingIndex !== undefined) {
          const slot = slots[existingIndex];
          if (slot !== undefined) {
            if (!sameSize(slot.size, request.size)) slot.size = request.size;
            out.push(allocationFor(slot, request.key));
            continue;
          }
        }
        const freeIndex = slots.findIndex((slot) => slot.key === null);
        const slot = freeIndex < 0 ? undefined : slots[freeIndex];
        if (slot === undefined) continue;
        slot.key = request.key;
        slot.size = request.size;
        byKey.set(request.key, freeIndex);
        out.push(allocationFor(slot, request.key));
      }
      return out;
    },

    descriptors(): ReadonlyArray<TargetResourceDescriptor> {
      return slots
        .filter((slot) => slot.key !== null)
        .map((slot) => ({
          kind: "target" as const,
          id: slot.resourceId,
          size: slot.size,
          format: TILE_FORMAT,
          label: `preview ${slot.key ?? ""}`,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    get(key: string): TileAllocation | undefined {
      const index = byKey.get(key);
      if (index === undefined) return undefined;
      const slot = slots[index];
      if (slot === undefined) return undefined;
      return allocationFor(slot, key);
    },

    reset(): void {
      byKey.clear();
      for (const slot of slots) {
        slot.key = null;
        slot.size = [1, 1];
      }
    },
  };
}
