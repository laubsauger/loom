import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions, coreNodeDefinitions, spikeNodeDefinitions } from "./index.ts";

describe("Phase 0 spike catalogue (T15)", () => {
  it("registers all three definitions together in one registry with no collisions", () => {
    const registry = createNodeRegistry(spikeNodeDefinitions);
    expect(registry.list().map((definition) => definition.type)).toEqual([
      "customWgsl",
      "output",
      "solid",
    ]);
  });
});

describe("core catalogue (T70, T40)", () => {
  it("registers alongside the spike nodes with no type collisions", () => {
    const registry = createNodeRegistry(allNodeDefinitions);
    expect(registry.list()).toHaveLength(allNodeDefinitions.length);
    expect(new Set(allNodeDefinitions.map((definition) => definition.type)).size).toBe(
      allNodeDefinitions.length,
    );
  });

  /**
   * The vocabulary itself, pinned. §C makes the TD TOP family the reference for the core
   * set, so a rename is a compatibility decision (every saved `.loom.json` names these
   * strings) and has to be a deliberate edit here rather than a side effect.
   */
  it("uses the TD TOP vocabulary for its type strings", () => {
    expect(coreNodeDefinitions.map((definition) => definition.type)).toEqual([
      "noise",
      "ramp",
      "uv",
      "checker",
      "circle",
      "transform",
      "crop",
      "tile",
      "level",
      "hsv",
      "threshold",
      "lookup",
      "blur",
      "displace",
      "over",
      "add",
      "multiply",
      "screen",
      "difference",
      "mask",
      "feedback",
      "pointKernel",
      "textureToAttribute",
      "renderPoints",
    ]);
  });

  it("groups every node into a library category", () => {
    expect(new Set(coreNodeDefinitions.map((definition) => definition.category))).toEqual(
      new Set(["generator", "filter", "color", "composite", "temporal", "points"]),
    );
  });

  /** Every definition ships at version 1 with a description the library pane can show. */
  it("declares a version and a description for every node", () => {
    for (const definition of coreNodeDefinitions) {
      expect(definition.version, definition.type).toBe(1);
      expect(definition.description?.length ?? 0, definition.type).toBeGreaterThan(0);
      expect(definition.title.length, definition.type).toBeGreaterThan(0);
    }
  });
});
