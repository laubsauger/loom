import { describe, expect, it } from "vitest";
import { TILE_FORMAT, createTileAtlas } from "./tile-atlas.ts";

const SIZE = [192, 108] as const;

describe("tile atlas", () => {
  it("holds a slot's resource id stable across frames", () => {
    // This is what makes §V8 hold: an unchanged resource id and size means an unchanged
    // resource signature, so the backend keeps the texture instead of reallocating it.
    const atlas = createTileAtlas({ capacity: 4 });
    const first = atlas.sync([{ key: "a:out", size: SIZE }]);
    const second = atlas.sync([{ key: "a:out", size: SIZE }]);
    expect(first[0]?.resourceId).toBe(second[0]?.resourceId);
    expect(atlas.descriptors()).toEqual(second.map((tile) => expect.objectContaining({
      id: tile.resourceId,
      kind: "target",
      format: TILE_FORMAT,
    })));
  });

  it("never allocates more tiles than its capacity", () => {
    const atlas = createTileAtlas({ capacity: 2 });
    const allocations = atlas.sync(
      ["a", "b", "c", "d"].map((key) => ({ key, size: SIZE })),
    );
    expect(allocations).toHaveLength(2);
    expect(atlas.descriptors()).toHaveLength(2);
  });

  it("releases a tile the frame its preview stops being active", () => {
    const atlas = createTileAtlas({ capacity: 1 });
    atlas.sync([{ key: "a", size: SIZE }]);
    const reassigned = atlas.sync([{ key: "b", size: SIZE }]);
    expect(atlas.get("a")).toBeUndefined();
    expect(reassigned[0]?.key).toBe("b");
    // The freed slot is REUSED rather than a second one being taken; a released tile that kept
    // its texture would make §V28 a scheduling nicety instead of a memory one.
    expect(atlas.descriptors()).toHaveLength(1);
  });

  it("resizes in place when a tile crosses a ladder step", () => {
    const atlas = createTileAtlas({ capacity: 2 });
    const before = atlas.sync([{ key: "a", size: [128, 72] }]);
    const after = atlas.sync([{ key: "a", size: [192, 108] }]);
    expect(after[0]?.resourceId).toBe(before[0]?.resourceId);
    expect(after[0]?.size).toEqual([192, 108]);
    expect(atlas.descriptors()[0]?.size).toEqual([192, 108]);
  });

  it("emits descriptors in a deterministic order", () => {
    const atlas = createTileAtlas({ capacity: 3 });
    atlas.sync([
      { key: "c", size: SIZE },
      { key: "a", size: SIZE },
      { key: "b", size: SIZE },
    ]);
    const ids = atlas.descriptors().map((descriptor) => descriptor.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it("reset drops everything", () => {
    const atlas = createTileAtlas({ capacity: 2 });
    atlas.sync([{ key: "a", size: SIZE }]);
    atlas.reset();
    expect(atlas.get("a")).toBeUndefined();
    expect(atlas.descriptors()).toEqual([]);
  });
});
