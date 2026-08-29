import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, projectDocumentSchema } from "./schemas.ts";

const minimalProject = () => ({
  schemaVersion: SCHEMA_VERSION,
  projectId: "p1",
  name: "untitled",
  graph: { revision: 0, nodes: {}, edges: {}, groups: {} },
  settings: {
    outputResolution: { width: 1920, height: 1080 },
    workingFormat: "rgba16float" as const,
    randomSeed: 0,
    previewLongEdge: 192,
    previewFps: 20,
    limits: {
      maxResolution: 4096,
      maxDispatch: 65535,
      maxBufferBytes: 268_435_456,
      memoryBudgetBytes: 1_073_741_824,
    },
  },
  assets: [],
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
});

describe("projectDocumentSchema", () => {
  it("accepts a minimal valid project", () => {
    expect(projectDocumentSchema.safeParse(minimalProject()).success).toBe(true);
  });

  /** §V10: an unversioned document must not load silently. */
  it("rejects a document with no schemaVersion", () => {
    const { schemaVersion: _omitted, ...rest } = minimalProject();
    expect(projectDocumentSchema.safeParse(rest).success).toBe(false);
  });

  /** §V40: identities must be real, not empty strings standing in for one. */
  it("rejects an empty node id", () => {
    const doc = minimalProject();
    doc.graph.nodes = {
      "": { id: "", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    };
    expect(projectDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("rejects a texture format outside the supported set", () => {
    const doc = minimalProject();
    (doc.settings as { workingFormat: string }).workingFormat = "bgra8unorm";
    expect(projectDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("round-trips through JSON without semantic change", () => {
    const doc = minimalProject();
    const parsed = projectDocumentSchema.parse(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });
});
