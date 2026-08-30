import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  parameterModeSchema,
  projectDocumentSchema,
  projectSettingsSchema,
  storedParameterSchema,
} from "./schemas.ts";
import { PARAMETER_MODES } from "../parameters/slots.ts";
import { DEFAULT_COLOR_POLICY } from "./graph.ts";

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

/**
 * T487/B92 — the file boundary knows EVERY binding kind the domain has.
 *
 * `map` existed in `ParameterBinding` and in `PARAMETER_MODES` (B45's pinned list) but
 * not in these schemas — so a document carrying a mapped parameter SAVED fine and then
 * never opened again: the loader's zod refused the slot. The mode list is now derived
 * with a two-direction compile-time pin; these tests are the runtime half.
 */
describe("map bindings cross the file boundary (T487, B92)", () => {
  const mapSlot = {
    mode: "map",
    bindings: {
      map: { kind: "map", attribute: "position", channel: "y" },
      static: { kind: "static", value: 0 },
    },
  };

  it("a map slot parses as a stored parameter", () => {
    expect(storedParameterSchema.safeParse(mapSlot).success).toBe(true);
    // The optional pieces stay optional: a bare attribute is a legal mapping.
    expect(
      storedParameterSchema.safeParse({
        mode: "map",
        bindings: { map: { kind: "map", attribute: "position" } },
      }).success,
    ).toBe(true);
  });

  it("a document holding a mapped parameter survives load", () => {
    const project = minimalProject() as ReturnType<typeof minimalProject> & {
      graph: { nodes: Record<string, unknown> };
    };
    project.graph.nodes["n1"] = {
      id: "n1",
      type: "renderPoints",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: { sizePixels: mapSlot },
    };
    expect(projectDocumentSchema.safeParse(project).success).toBe(true);
  });

  it("the schema's mode list IS the domain's mode list (§V316) — derived, both directions", () => {
    expect([...parameterModeSchema.options].sort()).toEqual([...PARAMETER_MODES].sort());
  });

  it("an unknown mode still refuses", () => {
    expect(storedParameterSchema.safeParse({ mode: "wat", bindings: {} }).success).toBe(false);
  });
});

describe("nodeResolutionOverride", () => {
  const withResolution = (resolution: unknown) => {
    const doc = minimalProject();
    doc.graph.nodes = {
      n1: {
        id: "n1",
        type: "blur",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        ...(resolution === undefined ? {} : { resolution }),
      },
    } as never;
    return projectDocumentSchema.safeParse(doc);
  };

  /** Absent override is the default: the node's own ResolutionPolicy applies (§V50). */
  it("accepts a node with no override", () => {
    expect(withResolution(undefined).success).toBe(true);
  });

  it("accepts each override mode", () => {
    expect(withResolution({ mode: "auto" }).success).toBe(true);
    expect(withResolution({ mode: "project" }).success).toBe(true);
    expect(withResolution({ mode: "input", input: "in" }).success).toBe(true);
    expect(withResolution({ mode: "scale", factor: 0.5 }).success).toBe(true);
    expect(withResolution({ mode: "fixed", width: 1920, height: 1080 }).success).toBe(true);
  });

  it("rejects a zero or negative scale factor", () => {
    expect(withResolution({ mode: "scale", factor: 0 }).success).toBe(false);
    expect(withResolution({ mode: "scale", factor: -2 }).success).toBe(false);
  });

  it("rejects a fractional or zero fixed resolution", () => {
    expect(withResolution({ mode: "fixed", width: 100.5, height: 100 }).success).toBe(false);
    expect(withResolution({ mode: "fixed", width: 0, height: 100 }).success).toBe(false);
  });

  it("rejects an unknown mode rather than ignoring it", () => {
    expect(withResolution({ mode: "quarter" }).success).toBe(false);
  });
});

describe("nodeFormatOverride", () => {
  const withFormat = (format: unknown) => {
    const doc = minimalProject();
    doc.graph.nodes = {
      n1: {
        id: "n1",
        type: "blur",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        ...(format === undefined ? {} : { format }),
      },
    } as never;
    return projectDocumentSchema.safeParse(doc);
  };

  /** Absent override is the default: the node's own FormatPolicy applies (§V51). */
  it("accepts a node with no override", () => {
    expect(withFormat(undefined).success).toBe(true);
  });

  it("accepts each override mode", () => {
    expect(withFormat({ mode: "auto" }).success).toBe(true);
    expect(withFormat({ mode: "project" }).success).toBe(true);
    expect(withFormat({ mode: "input", input: "in" }).success).toBe(true);
    expect(withFormat({ mode: "fixed", format: "rgba16float" }).success).toBe(true);
  });

  /** A depth format is not a selectable colour output (§V51). */
  it("rejects a depth format", () => {
    expect(withFormat({ mode: "fixed", format: "depth24plus" }).success).toBe(false);
  });

  it("rejects a format outside the supported set", () => {
    expect(withFormat({ mode: "fixed", format: "bgra8unorm" }).success).toBe(false);
  });

  it("carries resolution and format overrides independently", () => {
    const doc = minimalProject();
    doc.graph.nodes = {
      n1: {
        id: "n1",
        type: "blur",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        resolution: { mode: "scale", factor: 0.5 },
        format: { mode: "fixed", format: "rgba16float" },
      },
    } as never;
    const parsed = projectDocumentSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });
});

describe("colour policy (T84, §V56)", () => {
  const settings = {
    outputResolution: { width: 1280, height: 720 },
    workingFormat: "rgba16float",
    randomSeed: 1,
    previewLongEdge: 192,
    previewFps: 20,
    limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 1, memoryBudgetBytes: 1 },
  };

  it("parses with and without a colorPolicy — older documents stay valid", () => {
    expect(projectSettingsSchema.safeParse(settings).success).toBe(true);
    expect(
      projectSettingsSchema.safeParse({
        ...settings,
        colorPolicy: { workingSpace: "linear", displayTransform: "none" },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown display transform rather than guessing", () => {
    expect(
      projectSettingsSchema.safeParse({
        ...settings,
        colorPolicy: { workingSpace: "linear", displayTransform: "gamma1.8" },
      }).success,
    ).toBe(false);
  });

  it("the default policy is linear working space with an sRGB display transform", () => {
    expect(DEFAULT_COLOR_POLICY).toEqual({ workingSpace: "linear", displayTransform: "srgb" });
  });
});
