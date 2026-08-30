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
      "rectangle",
      "transform",
      "flip",
      "mirror",
      "crop",
      "tile",
      "level",
      "hsv",
      "threshold",
      "limit",
      "lookup",
      "blur",
      "edge",
      "convolve",
      "displace",
      "remap",
      "composite",
      "cross",
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
      "null",
      "lfo",
      "constant",
      "timer",
      "analyze",
      "movieFileIn",
      "webcam",
      "mouse",
      "valueMath",
      "valueLimit",
      "slope",
      "trigger",
      "lag",
      "valueFilter",
    ]);
  });

  it("groups every node into a library category", () => {
    expect(new Set(coreNodeDefinitions.map((definition) => definition.category))).toEqual(
      new Set([
        // "input" is its own category rather than a kind of generator: a generator makes
        // pixels from parameters and is reproducible from the document alone, where an
        // input brings the OUTSIDE in — a camera, a file, later a capture or a network
        // stream — and carries permissions, availability and a source that may simply not
        // be there. Grouping them together would put "webcam" next to "circle" in the
        // library and imply they fail in the same ways.
        "input",
        "generator",
        "filter",
        "color",
        "composite",
        "temporal",
        "points",
        "utility",
        "value",
      ]),
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
