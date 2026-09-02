import { describe, expect, it } from "vitest";
import { SOURCE_REFERENCE_PARAMETERS } from "../../domain/graph/source-references.ts";
import { publishesValueChannels } from "../../domain/types/node-definition.ts";

import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions, coreNodeDefinitions, spikeNodeDefinitions } from "./index.ts";

import { codeParametersOf } from "../../domain/parameters/code.ts";

/**
 * T492 (§V437): code-valued parameters are a DECLARED KIND, and this is the census.
 *
 * Pinned by NAME, not by count: parameter #9 of a code kind must fail this list by
 * naming itself, so the author updating the pin is deciding "yes, this is code and the
 * editor serves it" — never hunting for which of nine a bare count meant. Everything
 * downstream — the inspector's control, the code pane's subject strip, per-language
 * highlighting — derives from `codeParametersOf`, so appearing here IS being served;
 * there is no second roster to also join.
 */
describe("the code-parameter census (T492)", () => {
  it("every code-valued parameter, by name and language", () => {
    const census = allNodeDefinitions
      .flatMap((definition) =>
        codeParametersOf(definition.parameters).map(
          (entry) => `${definition.type}.${entry.key}:${entry.definition.language}`,
        ),
      )
      .sort();
    expect(census).toEqual([
      "customWgsl.source:wgsl",
      // T942: the MIDI-learn table. Declared code/json for the same reason the attribute
      // schemas are (§V458) — it is hand-editable structured data, so it gets the JSON
      // editor and the code pane from the manifest rather than from a UI special case.
      "midiIn.mapping:json",
      "pointKernel.attributes:json",
      "pointKernel.group:wgsl",
      "pointKernel.kernel:wgsl",
      "pointKernelAdvanced.attributes:json",
      "pointKernelAdvanced.group:wgsl",
      "pointKernelAdvanced.kernel:wgsl",
      "pointKernelAdvanced.spawn:wgsl",
    ]);
  });

  it("prose stays prose: media text is a multiline STRING, the counter-example (T506)", () => {
    const text = allNodeDefinitions.find((definition) => definition.type === "text");
    const parameter = text?.parameters["text"];
    expect(parameter?.type).toBe("string");
  });
});

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
      // T483: the Ray POP — one ray per point against a height field.
      "pointRay",
      "textureToAttribute",
      "renderPoints",
      "null",
      // T607: the component boundary sockets — the TD In/Out idiom, one per wired
      // port kind (the deliberate scoping; a generic typed In is deferred, §V349).
      "componentIn",
      "componentOut",
      "componentInPoints",
      "componentOutPoints",
      "componentInValue",
      "componentOutValue",
      "switch",
      "lfo",
      "constant",
      "timer",
      "analyze",
      "depth",
      "pose",
      "matte",
      "movieFileIn",
      "webcam",
      "text",
      "mouse",
      "channelIn",
      "valueMath",
      "valueLimit",
      "valueSlope",
      "valueTrigger",
      "valueLag",
      "valueFilter",
      // T508: the value-graph twin of the texture Switch, and the only EXCLUSIVE join in
      // the CHOP set — wiring two sources to one port clobbers (§V457), by design.
      "valueSwitch",
      // T548: the phrase-length timescale — hold a pick for N counts of the input, then
      // step. Named Step rather than Hold because TD's Hold CHOP is gated by a second
      // input and stateful; this is a pure function of a count, so a scrub reproduces.
      "valueStep",
      // T414: sound as channels — the value family's third input source after Mouse
      // and the trio. Deliberately named for what it IS, not a TD analog.
      "audioIn",
      "audioFileIn",
      "audioPattern",
      // T942: the controller as channels. Page-native Web MIDI, learned bindings held in
      // the node's own `mapping` parameter, read through the `channels` seam analyze
      // already publishes into — no new port type and no compiler change.
      "midiIn",
      // T942 tier 3: OSC as channels, and OSC back out. Both need the local helper — a
      // page cannot speak UDP — and neither is a new port type or a compiler change.
      "oscIn",
      "oscOut",
      // T447: the scene family — assembly by NAME, data by wire (V372).
      "camera",
      "light",
      "projector",
      "geometry",
      "render",
      "materialUnlit",
      "materialPhong",
      "materialPbr",
      "materialGlass",
      "pointGenerator",
      "pointGrid",
      "pointLine",
      "pointCircle",
      "pointSphere",
      "pointTube",
      "pointTorus",
      "pointsFromTexture",
      "renderInstances",
      "renderSurface",
      "pointTopology",
      "pointProximity",
      "pointRange",
      // T947: the vector-display path planner — the laser and the scope share it.
      "laserPath",
      // T950: the transport sink — sideEffect "emits", the catalogue's second.
      "laserOut",
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
        // T438: the scene family — camera, light, material, geometry, render. These
        // lived on the "value" shelf, which was never true: they publish PAYLOADS, not
        // channels, and the shelf name was doubling as the plot gate (§V316's exact
        // failure). Rendering is its own aisle now, and the gate keys on declarations.
        "render",
        // T607: boundary sockets file beside component instances.
        "component",
        // T942 tier 3: the "output" shelf ALREADY EXISTS — `output` itself sits on it,
        // from the spike set — and `oscOut` is the first CORE node to join it. That is
        // the honest shelf for it: an output is where the graph LEAVES, and filing a
        // transmitter under "value" would put it next to Value Math and imply it is a
        // piece of arithmetic rather than a thing that reaches a network.
        "output",
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
        .filter((definition) => definition.sourceReferences !== undefined)
        .map((definition) => [definition.type, definition.sourceReferences]),
    );
    // Both directions: a declaration the table misses breaks the walk silently; a
    // table row with no declaration is a reference to nothing.
    expect(Object.keys(SOURCE_REFERENCE_PARAMETERS).sort()).toEqual([...declared.keys()].sort());
    for (const [type, specs] of Object.entries(SOURCE_REFERENCE_PARAMETERS)) {
      expect(declared.get(type), type).toEqual(specs);
    }
  });
});

describe("T438 (§V316) — the channel publishers are DECLARED, not a category", () => {
  it("publishesValueChannels answers from ports/hooks/measuredChannel, exactly", () => {
    // The exact publisher set. This pin is what makes a category move SAFE: recategorize
    // any of these (audio → input, T438) and this list does not move; drop one's
    // declaration and this fails loudly instead of its plot silently vanishing.
    const publishers = coreNodeDefinitions
      .filter((definition) => publishesValueChannels(definition))
      .map((definition) => definition.type)
      .sort();
    expect(publishers).toEqual(
      [
        "analyze", // measuredChannel: the one publisher with no port and no hook
        "audioFileIn",
        "audioIn",
        "audioPattern",
        "channelIn",
        "componentInValue", // T822: the value boundary forwards a channel bag, so it publishes
        "componentOutValue",
        "constant",
        "lfo",
        // T942: a controller's learned controls are a channel bag, so the node plots and
        // previews exactly as Mouse does — no special case anywhere for it being hardware.
        "midiIn",
        "mouse",
        // T942 tier 3: oscIn publishes its learned addresses; oscOut publishes the bag it
        // is SENDING, so a plot on it shows exactly what left the machine.
        "oscIn",
        "oscOut",
        "timer",
        "valueFilter",
        "valueLag",
        "valueLimit",
        "valueMath",
        "valueSlope",
        "valueStep",
        "valueSwitch",
        "valueTrigger",
      ].sort(),
    );
    // And the shape that caused T438: a scene node is NOT a publisher, whatever shelf
    // it sits on — offering a camera a value plot is how "no signal yet" shipped.
    for (const type of ["camera", "light", "geometry", "materialPhong", "render"]) {
      const definition = coreNodeDefinitions.find((entry) => entry.type === type);
      expect(definition, type).toBeDefined();
      expect(publishesValueChannels(definition), type).toBe(false);
    }
  });
});
