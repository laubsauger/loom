import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, type NodeRegistry } from "./registry.ts";

/**
 * Test-support manifests. Not shipped in the node catalogue — the real nodes land in
 * `src/nodes/definitions/**` (T15, T40). These exist so the domain and bus tests can
 * exercise port typing, variadic inputs and stateful declarations without depending on
 * another track's work landing first.
 */

const noPasses = (): { passes: readonly unknown[] } => ({ passes: [] });

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

export const solidNode: NodeDefinition = {
  type: "test.solid",
  version: 1,
  title: "Solid",
  category: "generator",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    color: { type: "color", label: "Color", default: [0, 0, 0, 1], space: "display" },
    amount: { type: "number", label: "Amount", default: 0.5, min: 0, max: 1 },
    label: { type: "string", label: "Label", default: "" },
  },
  compile: noPasses,
};

export const blurNode: NodeDefinition = {
  type: "test.blur",
  version: 1,
  title: "Blur",
  category: "filter",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    radius: { type: "number", label: "Radius", default: 4, min: 0, max: 64 },
  },
  compile: noPasses,
};

/** Variadic input: the only shape allowed to accept more than one incoming edge (§V14). */
export const compositeNode: NodeDefinition = {
  type: "test.composite",
  version: 1,
  title: "Composite",
  category: "composite",
  inputs: [
    { id: "layers", label: "Layers", type: rgba, variadic: true },
    { id: "mask", label: "Mask", type: rgba, optional: true },
  ],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    mode: {
      type: "enum",
      label: "Mode",
      default: "over",
      options: [
        { value: "over", label: "Over" },
        { value: "add", label: "Add" },
      ],
    },
  },
  compile: noPasses,
};

/** Same kind and sample type as `rgba` but a different channel count — §V13 near-miss. */
export const monoNode: NodeDefinition = {
  type: "test.mono",
  version: 1,
  title: "Mono",
  category: "filter",
  inputs: [{ id: "source", label: "Source", type: { kind: "texture2d", sample: "float", channels: 1 } }],
  outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 1 } }],
  parameters: {},
  compile: noPasses,
};

export const depthNode: NodeDefinition = {
  type: "test.depth",
  version: 1,
  title: "Depth",
  category: "generator",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "depth", channels: 4 } }],
  parameters: {},
  compile: noPasses,
};

export const scalarF32Node: NodeDefinition = {
  type: "test.scalarF32",
  version: 1,
  title: "Scalar f32",
  category: "value",
  inputs: [{ id: "in", label: "In", type: { kind: "scalar", scalar: "f32" } }],
  outputs: [{ id: "out", label: "Out", type: { kind: "scalar", scalar: "f32" } }],
  parameters: {},
  compile: noPasses,
};

export const scalarI32Node: NodeDefinition = {
  type: "test.scalarI32",
  version: 1,
  title: "Scalar i32",
  category: "value",
  inputs: [{ id: "in", label: "In", type: { kind: "scalar", scalar: "i32" } }],
  outputs: [{ id: "out", label: "Out", type: { kind: "scalar", scalar: "i32" } }],
  parameters: {},
  compile: noPasses,
};

export const vec2Node: NodeDefinition = {
  type: "test.vec2",
  version: 1,
  title: "Vector 2",
  category: "value",
  inputs: [{ id: "in", label: "In", type: { kind: "vector", scalar: "f32", size: 2 } }],
  outputs: [{ id: "out", label: "Out", type: { kind: "vector", scalar: "f32", size: 2 } }],
  parameters: {},
  compile: noPasses,
};

export const vec3Node: NodeDefinition = {
  type: "test.vec3",
  version: 1,
  title: "Vector 3",
  category: "value",
  inputs: [{ id: "in", label: "In", type: { kind: "vector", scalar: "f32", size: 3 } }],
  outputs: [{ id: "out", label: "Out", type: { kind: "vector", scalar: "f32", size: 3 } }],
  parameters: {},
  compile: noPasses,
};

/** Shader-authorable node: carries the conventional `source` string parameter. */
export const customWgslNode: NodeDefinition = {
  type: "test.customWgsl",
  version: 1,
  title: "Custom WGSL",
  category: "shader",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    source: { type: "string", label: "Source", default: "", multiline: true, compileTime: true },
  },
  compile: noPasses,
};

/** Stateful/temporal node with the §V46 declaration present. */
export const feedbackNode: NodeDefinition = {
  type: "test.feedback",
  version: 1,
  title: "Feedback",
  category: "temporal",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    decay: { type: "number", label: "Decay", default: 0.9, min: 0, max: 1 },
    // §V123: a node declaring `stateful.reset` exposes a pulse to trigger it. The
    // fixture carries one so the mechanism is exercised against a manifest shaped
    // exactly like the shipped Feedback node's.
    reset: { type: "boolean", label: "Reset", default: false },
    resetPulse: {
      type: "pulse",
      label: "Reset Pulse",
      fires: "runtime.resetFeedback",
      input: { nodeIds: ["$node"] },
    },
  },
  temporal: { outputs: ["out"], resetOn: ["resolution", "format", "device", "load"] },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  compile: noPasses,
};

export const testNodeDefinitions: readonly NodeDefinition[] = [
  solidNode,
  blurNode,
  compositeNode,
  monoNode,
  depthNode,
  scalarF32Node,
  scalarI32Node,
  vec2Node,
  vec3Node,
  customWgslNode,
  feedbackNode,
];

export function createTestRegistry(): NodeRegistry {
  return createNodeRegistry(testNodeDefinitions);
}
