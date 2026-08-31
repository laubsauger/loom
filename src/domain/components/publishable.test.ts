import { describe, expect, it } from "vitest";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { ParameterDefinition } from "../types/parameters.ts";
import type { PortKind, PortType } from "../types/ports.ts";
import { validateParameterValue } from "../parameters/validate.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { componentNodeDefinition, validateComponentDefinition } from "./definition.ts";
import { defaultPublishedValues } from "./published-parameter.ts";
import { createComponentSystem } from "./registry.ts";
import { buildComponentFromSelection } from "./save-selection.ts";
import { graphOf, node } from "./test-support.ts";

/**
 * WHAT CAN ACTUALLY BE EXPOSED AND PUBLISHED — the census (§V437, §V487).
 *
 * The owner asked for "named parameter publishing in/outs of DIFFERENT TYPES". The
 * question behind that sentence is not "does publishing work", it is "does publishing
 * work for the kind I have in my hand" — and every time this project has answered a
 * PROPERTY with a list of SITES it has shipped the same gap three more times (§V437).
 *
 * So the two maps below are tied to their unions by `satisfies`. A fifteenth port kind or
 * a twelfth parameter type does not COMPILE until it is listed here, and the moment it is
 * listed every assertion in this file runs against it. That is the difference between a
 * gate on the property and a gate on today's instances (§V487's `SCENE_PAYLOAD_KINDS`).
 *
 * SENSITIVITY: drop a case from either map and the file stops compiling; make
 * `exposedPortDefinitions` or `componentNodeDefinition` switch on `kind` and the kinds it
 * forgets fail here by NAME rather than by a count mismatch (§V458's rule).
 */

/** One inhabitant of every `PortType` member. Exhaustive by construction. */
const PORT_TYPE_BY_KIND = {
  texture2d: { kind: "texture2d", sample: "float", channels: 4 },
  buffer: { kind: "buffer", element: "f32", access: "read" },
  scalar: { kind: "scalar", scalar: "f32" },
  vector: { kind: "vector", scalar: "f32", size: 3 },
  matrix: { kind: "matrix", columns: 4, rows: 4 },
  pointset: { kind: "pointset", requires: [{ name: "P", type: "vec3f" }] },
  scene: { kind: "scene" },
  material: { kind: "material", model: "unlit" },
  camera: { kind: "camera" },
  light: { kind: "light" },
  projector: { kind: "projector" },
  transform3d: { kind: "transform3d" },
  event: { kind: "event" },
  audioFeatures: { kind: "audioFeatures" },
  value: { kind: "value" },
} satisfies Record<PortKind, PortType>;

const ALL_PORT_KINDS = Object.keys(PORT_TYPE_BY_KIND) as PortKind[];

/** One inhabitant of every `ParameterDefinition` member. Exhaustive by construction. */
const PARAMETER_BY_TYPE = {
  number: { type: "number", label: "Number", default: 4, min: 0, max: 64, unit: "px" },
  boolean: { type: "boolean", label: "Boolean", default: false },
  enum: {
    type: "enum",
    label: "Enum",
    default: "a",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
  color: { type: "color", label: "Color", default: [0, 0, 0, 1], space: "display" },
  vector: { type: "vector", label: "Vector", size: 3, default: [0, 0, 0] },
  string: { type: "string", label: "String", default: "" },
  code: { type: "code", label: "Code", language: "wgsl", default: "fn main() {}" },
  asset: { type: "asset", label: "Asset", kind: "image" },
  curve: { type: "curve", label: "Curve", default: [{ x: 0, y: 0 }] },
  pulse: { type: "pulse", label: "Pulse", fires: "runtime.resetFeedback" },
  stops: {
    type: "stops",
    label: "Stops",
    space: "display",
    default: [{ position: 0, color: [0, 0, 0, 1] }],
  },
} satisfies Record<ParameterDefinition["type"], ParameterDefinition>;

const ALL_PARAMETER_TYPES = Object.keys(PARAMETER_BY_TYPE) as Array<ParameterDefinition["type"]>;

const noPasses = (): { passes: readonly [] } => ({ passes: [] });

/** `probe.<kind>` — one node per port kind, with an input and an output of that kind. */
function portProbeNode(kind: PortKind): NodeDefinition {
  const type = PORT_TYPE_BY_KIND[kind];
  return {
    type: `probe.${kind}`,
    version: 1,
    title: `Probe ${kind}`,
    category: "filter",
    inputs: [{ id: "in", label: "In", type }],
    outputs: [{ id: "out", label: "Out", type }],
    parameters: {},
    compile: noPasses,
  } as NodeDefinition;
}

/** `probe.param.<type>` — one node per parameter type, carrying exactly that parameter. */
function parameterProbeNode(type: ParameterDefinition["type"]): NodeDefinition {
  return {
    type: `probe.param.${type}`,
    version: 1,
    title: `Probe ${type}`,
    category: "filter",
    inputs: [],
    outputs: [],
    parameters: { value: PARAMETER_BY_TYPE[type] },
    compile: noPasses,
  } as NodeDefinition;
}

function probeSystem() {
  const registry = createNodeRegistry([
    ...ALL_PORT_KINDS.map(portProbeNode),
    ...ALL_PARAMETER_TYPES.map(parameterProbeNode),
  ]);
  return createComponentSystem(registry.view());
}

describe("every port kind can cross a component boundary (T131, §V79, §V437)", () => {
  it.each(ALL_PORT_KINDS)("exposes a %s port with its own type, not a guessed one", (kind) => {
    const system = probeSystem();
    const definition = {
      componentId: `expose-${kind}`,
      version: 1,
      name: `Expose ${kind}`,
      graph: graphOf([node("inner", `probe.${kind}`)]),
      inputs: [{ externalId: "in", label: "In", nodeId: "inner", portId: "in" }],
      outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [],
    };

    // Refused at registration would be the honest failure; a SILENT DROP is the one that
    // costs a day, because the component instantiates and simply has no port (§V8).
    expect(validateComponentDefinition(definition, system.nodes)).toEqual([]);
    system.components.register(definition);

    const manifest = componentNodeDefinition(definition, system.nodes);
    expect(manifest.inputs.map((port) => port.type.kind)).toEqual([kind]);
    expect(manifest.outputs.map((port) => port.type.kind)).toEqual([kind]);
    // The whole type, not just the kind: a `vector` that lost its `size` would connect to
    // a vec2 the compiler must then refuse (§V13).
    expect(manifest.inputs[0]?.type).toEqual(PORT_TYPE_BY_KIND[kind]);
    expect(manifest.outputs[0]?.type).toEqual(PORT_TYPE_BY_KIND[kind]);
  });

  it.each(ALL_PORT_KINDS)(
    "save-selection turns a crossing %s edge into a boundary port of that kind",
    (kind) => {
      const system = probeSystem();
      const upstream = node("up", `probe.${kind}`);
      const middle = node("mid", `probe.${kind}`);
      const downstream = node("down", `probe.${kind}`);
      const graph = graphOf([upstream, middle, downstream], {
        e1: { id: "e1", source: { nodeId: "up", portId: "out" }, target: { nodeId: "mid", portId: "in" } },
        e2: { id: "e2", source: { nodeId: "mid", portId: "out" }, target: { nodeId: "down", portId: "in" } },
      });

      const built = buildComponentFromSelection({
        graph,
        nodeIds: ["mid"],
        componentId: `sel-${kind}`,
        name: `Sel ${kind}`,
        nodes: system.nodes,
      });

      expect(built.diagnostics).toEqual([]);
      expect(built.definition.inputs).toHaveLength(1);
      expect(built.definition.outputs).toHaveLength(1);
      // The rewiring is what makes "make this a component" non-destructive: the outer
      // ends must reconnect to the instance, whatever the kind.
      expect(built.inputWiring[0]?.outer).toEqual({ nodeId: "up", portId: "out" });
      expect(built.outputWiring[0]?.outer).toEqual({ nodeId: "down", portId: "in" });

      const manifest = componentNodeDefinition(built.definition, system.nodes);
      expect(manifest.inputs[0]?.type).toEqual(PORT_TYPE_BY_KIND[kind]);
      expect(manifest.outputs[0]?.type).toEqual(PORT_TYPE_BY_KIND[kind]);
    },
  );
});

describe("every parameter type can be published (T132, §V80, §V437)", () => {
  it.each(ALL_PARAMETER_TYPES)("publishes a %s onto the parameter page", (type) => {
    const system = probeSystem();
    const definition = {
      componentId: `publish-${type}`,
      version: 1,
      name: `Publish ${type}`,
      graph: graphOf([node("inner", `probe.param.${type}`)]),
      inputs: [],
      outputs: [],
      parameters: [
        {
          // RE-AUTHORED: a label the component's user reads, not the internal one (§V80).
          key: "knob",
          definition: { ...PARAMETER_BY_TYPE[type], label: "Knob" } as ParameterDefinition,
          targets: [{ nodeId: "inner", key: "value" }],
        },
      ],
    };

    expect(validateComponentDefinition(definition, system.nodes)).toEqual([]);
    system.components.register(definition);

    const manifest = componentNodeDefinition(definition, system.nodes);
    expect(manifest.parameters.knob?.type).toBe(type);
    expect(manifest.parameters.knob?.label).toBe("Knob");
    /*
     * A published knob a fresh instance cannot be given a value for is a knob that reads
     * as unset the moment it is placed.
     *
     * The KEY alone is not enough to assert, and finding that out is why this line reads
     * the way it does: `defaultValueOf` falls through to `definition.default` for most
     * types, and `asset` and `pulse` DECLARE NO `default` FIELD — they are special-cased.
     * Deleting those two cases left the key present with an `undefined` value, and an
     * assertion on `Object.keys` alone stayed green over it (§V461, §V500). So the value
     * has to be real, and it has to be a value the parameter would ACCEPT — checked
     * against the validator the store uses on the way in, not against `defaultValueOf`'s
     * own answer, which would only prove the function agrees with itself.
     */
    const defaults = defaultPublishedValues(definition);
    expect(Object.keys(defaults)).toEqual(["knob"]);
    const value = defaults.knob;
    expect(value, `${type} has no default value`).not.toBeUndefined();
    expect(
      validateParameterValue("knob", manifest.parameters.knob as ParameterDefinition, value as never),
    ).toBeNull();
  });
});
