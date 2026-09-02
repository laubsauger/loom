import { describe, expect, it } from "vitest";
import { channelExpression, upgradeDrivenSlot } from "../parameters/slots.ts";
import { loadProject } from "./load.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { ParameterSlot } from "../types/parameters.ts";

/**
 * §T897 — `driven` is parsed forever, emitted never. A document in the wild holding driven
 * slots upgrades AT LOAD to the expression form (`op('name').chan.low`), value-identically:
 * the channel address maps one-to-one onto the chan read, and both resolve through the same
 * channels resolver. The retained static payload survives untouched (§V108).
 */

describe("channelExpression — the ONE driven→expression mapping (§T897)", () => {
  it("maps a bare address to .chan.value and a suffixed one to its channel", () => {
    expect(channelExpression("lfo1")).toBe("op('lfo1').chan.value");
    expect(channelExpression("beat1:low")).toBe("op('beat1').chan.low");
  });
});

describe("upgradeDrivenSlot (§T897)", () => {
  it("an ACTIVE driven slot becomes an expression slot carrying the channel read", () => {
    const slot: ParameterSlot = {
      mode: "driven",
      bindings: {
        static: { kind: "static", value: 0.25 },
        driven: { kind: "driven", channel: "gd1:high" },
      },
    };
    const upgraded = upgradeDrivenSlot(slot);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.slot.mode).toBe("expression");
    expect(upgraded.slot.bindings.expression).toEqual({ kind: "expression", source: "op('gd1').chan.high" });
    // §V108: the retained static payload survives, byte-identical.
    expect(upgraded.slot.bindings.static).toEqual({ kind: "static", value: 0.25 });
    // Emitted never: the driven payload is gone once translated.
    expect(upgraded.slot.bindings.driven).toBeUndefined();
  });

  it("an INACTIVE driven payload translates only into an EMPTY expression slot (§V108)", () => {
    const authored: ParameterSlot = {
      mode: "static",
      bindings: {
        static: { kind: "static", value: 1 },
        driven: { kind: "driven", channel: "lfo1" },
        expression: { kind: "expression", source: "time * 2" },
      },
    };
    // The user authored an expression; translating the shadowed driven over it would
    // destroy their work. The stray driven payload stays, harmless — the schema parses it.
    expect(upgradeDrivenSlot(authored).changed).toBe(false);

    const empty: ParameterSlot = {
      mode: "static",
      bindings: {
        static: { kind: "static", value: 1 },
        driven: { kind: "driven", channel: "lfo1" },
      },
    };
    const upgraded = upgradeDrivenSlot(empty);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.slot.mode).toBe("static"); // the active mode is untouched
    expect(upgraded.slot.bindings.expression).toEqual({ kind: "expression", source: "op('lfo1').chan.value" });
  });

  it("a slot with no driven payload passes through untouched", () => {
    const slot: ParameterSlot = { mode: "static", bindings: { static: { kind: "static", value: 3 } } };
    expect(upgradeDrivenSlot(slot)).toEqual({ slot, changed: false });
  });
});

describe("loadProject upgrades a wild driven document (§T897)", () => {
  it("a driven slot in a loaded file comes out as the expression form, marked changed", () => {
    const file = JSON.stringify({
      schemaVersion: 1,
      projectId: "wild",
      name: "wild",
      settings: {
        outputResolution: { width: 640, height: 360 },
        workingFormat: "rgba16float",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 30,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268435456, memoryBudgetBytes: 1073741824 },
      },
      assets: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      graph: {
        revision: 1,
        nodes: {
          lv: {
            id: "lv",
            type: "level",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {
              brightness: {
                mode: "driven",
                bindings: {
                  static: { kind: "static", value: 0.5 },
                  driven: { kind: "driven", channel: "lfo1:value" },
                },
              },
            },
          },
        },
        edges: {},
        groups: {},
      },
    });
    const loaded = loadProject(file, { nodes: createNodeRegistry(allNodeDefinitions).view() });
    if (!loaded.ok) throw new Error(loaded.reason);
    const slot = loaded.document.graph.nodes["lv"]?.parameters["brightness"] as ParameterSlot;
    expect(slot.mode).toBe("expression");
    expect(slot.bindings.expression).toEqual({ kind: "expression", source: "op('lfo1').chan.value" });
    expect(slot.bindings.static).toEqual({ kind: "static", value: 0.5 });
    expect(slot.bindings.driven).toBeUndefined();
    // The load reports the difference so the app marks the project dirty and a SAVE
    // writes the upgraded form — which is what "emit never" means in practice.
    expect(loaded.changed).toBe(true);
  });
});
