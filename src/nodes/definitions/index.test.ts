import { describe, expect, it } from "vitest";
import { SOURCE_REFERENCE_PARAMETERS } from "../../domain/graph/source-references.ts";

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
      "reorder",
      "premultiply",
      "blur",
      "edge",
      "convolve",
      "displace",
      "remap",
      "slope",
      "composite",
      "cross",
      "over",
      "add",
      "multiply",
      "screen",
      "difference",
      "mask",
      "feedback",
      "cache",
      "pointKernel",
      "textureToAttribute",
      "renderPoints",
      "null",
      "switch",
      "lfo",
      "constant",
      "timer",
      "analyze",
      "movieFileIn",
      "webcam",
      "text",
      "mouse",
      "valueMath",
      "valueLimit",
      "valueSlope",
      "valueTrigger",
      "valueLag",
      "valueFilter",
      "pointGenerator",
      "pointGrid",
      "pointLine",
      "pointCircle",
      "pointSphere",
      "pointTube",
      "pointTorus",
      "renderInstances",
      "renderSurface",
      "pointTopology",
      "pointKernelAdvanced",
      "slitScan",
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

  /**
   * Every definition ships with a positive version and a description the library pane can
   * show. Version 1 was the assertion until Ramp grew a stop list (T270); a bumped
   * version is the §V10 mechanism working, and a node that bumps one must declare a
   * `migrate` — which is the part actually worth checking.
   */
  it("declares a version and a description for every node", () => {
    for (const definition of coreNodeDefinitions) {
      expect(definition.version, definition.type).toBeGreaterThanOrEqual(1);
      if (definition.version > 1) {
        expect(definition.migrate, `${definition.type} bumped its version`).toBeTypeOf("function");
      }
      expect(definition.description?.length ?? 0, definition.type).toBeGreaterThan(0);
      expect(definition.title.length, definition.type).toBeGreaterThan(0);
    }
  });
});

/**
 * §V123/T216 — a node declaring `stateful.reset` SHOULD expose a pulse that triggers it.
 *
 * The field has been declaring the capability with nothing wired to it. This test is the
 * enumeration that keeps the gap visible instead of silent: a new stateful node gets its
 * reset the day it is written, and the ones that still cannot have one are listed HERE,
 * with why, rather than being quietly absent (the shape of B12/B23/§V193).
 */
describe("reset is exposed where it is declared (§V123, T216)", () => {
  /**
   * Nodes whose runtime state nothing can currently clear. Not oversights — each is
   * blocked on machinery that does not exist yet, and a pulse pointing at a command that
   * cannot reach the state would be a button that lies.
   */
  const KNOWN_GAPS: Readonly<Record<string, string>> = {
    // `runtime.resetFeedback` resolves through `CompiledGraph.feedback`, whose entries
    // are TEXTURE pairs (they carry a `TextureFormat`). A point simulation's state lives
    // in `bufferPair` resources, which never appear in that table, so there is nothing
    // for a scoped reset to name.
    pointKernel: "point bufferPairs are not in the compiled feedback table",
    pointKernelAdvanced: "point bufferPairs are not in the compiled feedback table",
    // The value graph's per-node state lives in `createValueGraphSession`, which has no
    // caller outside its own tests — there is no running session to reset.
    // (T318: the §V194 rename landed — `valueTrigger`/`valueLag` match their siblings.)
    valueSlope: "the value-graph session is not mounted in the app",
    valueTrigger: "the value-graph session is not mounted in the app",
    valueLag: "the value-graph session is not mounted in the app",
    valueFilter: "the value-graph session is not mounted in the app",
  };

  it("every stateful node either fires a reset or is a listed gap", () => {
    const missing: string[] = [];
    for (const definition of coreNodeDefinitions) {
      if (definition.stateful?.reset !== true) continue;
      const pulses = Object.values(definition.parameters).filter(
        (parameter) => parameter.type === "pulse",
      );
      if (pulses.length > 0) continue;
      if (definition.type in KNOWN_GAPS) continue;
      missing.push(definition.type);
    }
    expect(missing).toEqual([]);
  });

  it("does not keep gap entries for nodes that have since grown a pulse", () => {
    // A stale exemption is how a list like this stops meaning anything.
    for (const type of Object.keys(KNOWN_GAPS)) {
      const definition = coreNodeDefinitions.find((entry) => entry.type === type);
      if (definition === undefined) continue;
      const hasPulse = Object.values(definition.parameters).some(
        (parameter) => parameter.type === "pulse",
      );
      expect(hasPulse, `${type} has a pulse now — drop its exemption`).toBe(false);
    }
  });
});

describe("source references: the table and the declarations agree (T350)", () => {
  it("every declaration is in the domain table, and the table names only declarations", () => {
    const declared = new Map(
      coreNodeDefinitions
        .filter((definition) => definition.sourceReference !== undefined)
        .map((definition) => [definition.type, definition.sourceReference]),
    );
    // Both directions: a declaration the table misses breaks the walk silently; a
    // table row with no declaration is a reference to nothing.
    expect(Object.keys(SOURCE_REFERENCE_PARAMETERS).sort()).toEqual([...declared.keys()].sort());
    for (const [type, spec] of Object.entries(SOURCE_REFERENCE_PARAMETERS)) {
      expect(declared.get(type), type).toEqual(spec);
    }
  });
});
