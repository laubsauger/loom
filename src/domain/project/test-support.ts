import type { GraphDocument, ProjectDocument, ProjectSettings } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type { NodeDefinitionSource } from "../migrations/index.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";

/** Fixtures shared by the project tests. Not part of the shipped surface. */

export function testSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    outputResolution: { width: 1920, height: 1080 },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 30,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65_535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
    ...overrides,
  };
}

export function testDocument(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  const graph: GraphDocument = {
    revision: 3,
    nodes: {
      n1: {
        id: "n1",
        type: "gradient",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { angle: 45, tint: [1, 0, 0, 1] },
      },
      n2: {
        id: "n2",
        type: "output",
        definitionVersion: 1,
        position: { x: 240, y: 0 },
        parameters: {},
      },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "n1", portId: "out" }, target: { nodeId: "n2", portId: "in" } },
    },
    groups: {},
  };
  return {
    // The version this BUILD writes, never a literal: a fixture pinned to a number stops
    // round-tripping the moment a migration lands, and the migration is not what broke.
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-1",
    name: "Test Project",
    graph,
    settings: testSettings(),
    assets: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

/** A node manifest good enough for the loader; `compile` is never reached in these tests. */
export function testDefinition(overrides: Partial<NodeDefinition> & { type: string }): NodeDefinition {
  return {
    version: 1,
    title: overrides.type,
    category: "test",
    inputs: [],
    outputs: [],
    parameters: {},
    compile: () => ({ passes: [] }),
    ...overrides,
  };
}

export function definitionSource(definitions: readonly NodeDefinition[]): NodeDefinitionSource {
  const byType = new Map(definitions.map((definition) => [definition.type, definition]));
  return { get: (type) => byType.get(type) };
}
