import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "../registry/registry.ts";
import { spikeNodeDefinitions } from "./index.ts";

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
