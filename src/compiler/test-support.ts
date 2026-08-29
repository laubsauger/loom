import type { EdgeId, NodeId, PortId } from "../domain/types/ids.ts";
import type { GraphDocument, GraphEdge, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { NodeDefinition, TextureFormat } from "../domain/types/node-definition.ts";
import { TEXTURE_FORMATS } from "../domain/types/node-definition.ts";
import { createNodeRegistry, type NodeRegistry } from "../nodes/registry/registry.ts";
import { asCompilerContext, type CompilerNodeContext } from "./types.ts";

/**
 * Fixtures for the compiler tests.
 *
 * The registry's own `test-nodes.ts` manifests deliberately emit no passes, which is the
 * right shape for domain tests but tells us nothing about pass emission. These definitions
 * emit real `EffectPassDescriptor`s through the documented `asCompilerContext` seam, so the
 * compiler tests exercise the same integration a shipped node will.
 */

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

const number = (context: CompilerNodeContext, key: string, fallback: number): number => {
  const value = context.parameters[key];
  return typeof value === "number" ? value : fallback;
};

const textureOf = (context: CompilerNodeContext, portId: PortId): string | undefined =>
  context.inputs[portId]?.[0]?.resourceId;

export const GENERATOR_WGSL = `@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }`;

export const FILTER_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;

/** A source: no inputs, project-sized, project format. */
export const generatorNode: NodeDefinition = {
  type: "fx.generator",
  version: 1,
  title: "Generator",
  category: "generator",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: { amount: { type: "number", label: "Amount", default: 1 } },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile: (raw) => {
    const context = asCompilerContext(raw);
    return {
      passes: [
        {
          shader: GENERATOR_WGSL,
          uniformBinding: "params",
          uniforms: { amount: number(context, "amount", 1) },
        },
      ],
    };
  },
};

const filterCompile = (raw: Parameters<NodeDefinition["compile"]>[0]) => {
  const context = asCompilerContext(raw);
  const source = textureOf(context, "source");
  return {
    passes: [
      {
        shader: FILTER_WGSL,
        samplers: [{ binding: "inputSampler", resourceId: context.sampler }],
        textures: source === undefined ? [] : [{ binding: "inputTexture", resourceId: source }],
        uniformBinding: "params",
        uniforms: { radius: number(context, "radius", 1) },
      },
    ],
  };
};

/** Inherits size and format from its input — the ordinary filter shape. */
export const blurNode: NodeDefinition = {
  type: "fx.blur",
  version: 1,
  title: "Blur",
  category: "filter",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: { radius: { type: "number", label: "Radius", default: 4, min: 0, max: 64 } },
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "inherit", input: "source" },
  compile: filterCompile,
};

/** Half-resolution filter — the `scale` policy. */
export const halfNode: NodeDefinition = {
  type: "fx.half",
  version: 1,
  title: "Half",
  category: "filter",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: { radius: { type: "number", label: "Radius", default: 1 } },
  resolutionPolicy: { kind: "scale", input: "source", factor: 0.5 },
  formatPolicy: { kind: "inherit", input: "source" },
  compile: filterCompile,
};

/** A fixed-size, fixed-format generator. */
export const plateNode: NodeDefinition = {
  type: "fx.plate",
  version: 1,
  title: "Plate",
  category: "generator",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {},
  resolutionPolicy: { kind: "fixed", width: 256, height: 128 },
  formatPolicy: { kind: "fixed", format: "rgba16float" },
  compile: () => ({ passes: [{ shader: GENERATOR_WGSL }] }),
};

/** Variadic input (§V14) and a fan-in point for the §V6 reuse test. */
export const compositeNode: NodeDefinition = {
  type: "fx.composite",
  version: 1,
  title: "Composite",
  category: "composite",
  inputs: [{ id: "layers", label: "Layers", type: rgba, variadic: true }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {},
  resolutionPolicy: { kind: "inherit", input: "layers" },
  formatPolicy: { kind: "inherit", input: "layers" },
  compile: (raw) => {
    const context = asCompilerContext(raw);
    const layers = context.inputs["layers"] ?? [];
    return {
      passes: [
        {
          shader: FILTER_WGSL,
          samplers: [{ binding: "inputSampler", resourceId: context.sampler }],
          textures: layers.map((layer, index) => ({
            binding: `layer${index}`,
            resourceId: layer.resourceId,
          })),
        },
      ],
    };
  },
};

/**
 * The main output. It declares a sink AND an output port: the final image is a real
 * texture the preview and the export path read, so it materializes like any other output.
 */
export const outputNode: NodeDefinition = {
  type: "fx.output",
  version: 1,
  title: "Output",
  category: "output",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {},
  sink: true,
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile: filterCompile,
};

/**
 * A side-effect sink WITH an output port — the shape that proves sink-ness is declared
 * rather than inferred from "has no outputs" (§V25).
 */
export const readbackNode: NodeDefinition = {
  type: "fx.readback",
  version: 1,
  title: "Readback",
  category: "debug",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {},
  sink: true,
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "inherit", input: "source" },
  compile: filterCompile,
};

/** Temporal output: legalises a cycle (§V4) and compiles to a ping-pong pair (§V22). */
export const feedbackNode: NodeDefinition = {
  type: "fx.feedback",
  version: 1,
  title: "Feedback",
  category: "temporal",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: { decay: { type: "number", label: "Decay", default: 0.9, min: 0, max: 1 } },
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "inherit", input: "source" },
  temporal: { outputs: ["out"], resetOn: ["resolution", "format", "device", "load"] },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  compile: (raw) => {
    const context = asCompilerContext(raw);
    const source = textureOf(context, "source");
    const history = context.outputs["out"]?.resourceId;
    return {
      passes: [
        {
          shader: FILTER_WGSL,
          samplers: [{ binding: "inputSampler", resourceId: context.sampler }],
          textures: [
            ...(source === undefined ? [] : [{ binding: "sceneTexture", resourceId: source }]),
            ...(history === undefined ? [] : [{ binding: "historyTexture", resourceId: history }]),
          ],
          uniformBinding: "params",
          uniforms: { decay: number(context, "decay", 0.9) },
        },
      ],
    };
  },
};

/** Carries a `compileTime` parameter, for the recompile classifier. */
export const wgslNode: NodeDefinition = {
  type: "fx.wgsl",
  version: 1,
  title: "Custom WGSL",
  category: "shader",
  inputs: [{ id: "source", label: "Source", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    source: { type: "string", label: "Source", default: FILTER_WGSL, multiline: true, compileTime: true },
    gain: { type: "number", label: "Gain", default: 1 },
  },
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "inherit", input: "source" },
  compile: filterCompile,
};

/** Single-channel port type: a §V13 near miss against `rgba`. */
export const monoNode: NodeDefinition = {
  type: "fx.mono",
  version: 1,
  title: "Mono",
  category: "filter",
  inputs: [{ id: "source", label: "Source", type: { kind: "texture2d", sample: "float", channels: 1 } }],
  outputs: [{ id: "out", label: "Out", type: { kind: "texture2d", sample: "float", channels: 1 } }],
  parameters: {},
  compile: () => ({ passes: [] }),
};

export const compilerTestDefinitions: readonly NodeDefinition[] = [
  generatorNode,
  blurNode,
  halfNode,
  plateNode,
  compositeNode,
  outputNode,
  readbackNode,
  feedbackNode,
  wgslNode,
  monoNode,
];

export function createCompilerTestRegistry(extra: ReadonlyArray<NodeDefinition> = []): NodeRegistry {
  return createNodeRegistry([...compilerTestDefinitions, ...extra]);
}

export function testNode(id: NodeId, type: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...overrides,
  };
}

export function testEdge(
  id: EdgeId,
  source: readonly [NodeId, PortId],
  target: readonly [NodeId, PortId],
): GraphEdge {
  return {
    id,
    source: { nodeId: source[0], portId: source[1] },
    target: { nodeId: target[0], portId: target[1] },
  };
}

export function testGraph(
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge> = [],
): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges: Object.fromEntries(edges.map((edge) => [edge.id, edge])),
    groups: {},
  };
}

export function testSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    outputResolution: { width: 1920, height: 1080 },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
    ...overrides,
  };
}

export function testCapabilities(
  formats: ReadonlyArray<TextureFormat> = TEXTURE_FORMATS,
): BackendCapabilities {
  return {
    tier: "B",
    features: [],
    formats,
    timestampQuery: false,
    limits: { maxTextureDimension2D: 8192 },
  };
}
