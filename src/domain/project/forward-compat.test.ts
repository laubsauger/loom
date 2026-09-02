import { describe, expect, it } from "vitest";

import { projectDocumentSchema } from "../types/schemas.ts";
import { openProjectDocumentSchema } from "./forward-compat.ts";
import { loadProject } from "./load.ts";
import { buildProjectFile } from "./project-file.ts";
import { parseProjectDocument, serializeProjectDocument } from "./serialize.ts";
import { definitionSource, testDefinition, testDocument } from "./test-support.ts";

/**
 * T91 / §V68 / §V69 — forward compatibility.
 *
 * Written the way it is actually used: the fixture below is a file a LATER build of
 * Loom produced. It is not a hypothetical — the `ParameterValue` envelope
 * (`{kind:"static", value}`) and its reserved bound kinds are locked and land next, and
 * `src/domain/types/schemas.ts` is a closed union today. If this suite passes, a user on
 * this build can open tomorrow's file, edit something unrelated, save it, and hand it back
 * without having silently amputated the half of it this build never understood.
 *
 * The strong form of that claim is byte identity, not "looks equivalent": the assertion is
 * that what comes out of the canonical serializer is character-for-character the file that
 * went in.
 */

/** A `.loom.json` as written by a build several versions ahead of this one. */
function futureVersionFile(): string {
  return serializeProjectDocument({
    ...testDocument(),
    // A field at the document root that this build has never heard of.
    lastOpenedBy: "shaderloom/9.2.0",
    graph: {
      revision: 12,
      nodes: {
        n1: {
          id: "n1",
          type: "gradient",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {
            // A value in the locked §V69 envelope form.
            angle: { kind: "static", value: 45 },
            // A bound kind that does not exist yet in any form.
            tint: { kind: "audioBand", band: 3, gain: 1.5, smoothing: 0.2 },
            // And an ordinary value of the kind this build does write.
            seed: 9,
          },
          // A resolution mode from the future, beside modes we do know.
          resolution: { mode: "aspect", ratio: "16:9", input: "in" },
          ui: { collapsed: false, glow: "aurora" },
        },
      },
      edges: {},
      groups: {},
      // A whole collection this build has no concept of.
      annotations: { a1: { text: "why is this node here", nodeId: "n1" } },
    },
    settings: {
      ...testDocument().settings,
      colorManagement: { view: "aces", exposure: 0.5 },
    },
  } as never);
}

describe("§V68: a document from a newer build survives a load → save round trip", () => {
  it("is byte-identical after parse and re-serialize", () => {
    const file = futureVersionFile();
    const parsed = parseProjectDocument(file);
    if (!parsed.ok) throw new Error(`expected the future file to load: ${parsed.reason}`);

    expect(serializeProjectDocument(parsed.document)).toBe(file);
  });

  it("keeps unknown parameter kinds instead of rejecting the document (§V69)", () => {
    const parsed = parseProjectDocument(futureVersionFile());
    if (!parsed.ok) throw new Error(parsed.reason);

    const parameters = parsed.document.graph.nodes["n1"]?.parameters;
    expect(parameters?.["angle"]).toEqual({ kind: "static", value: 45 });
    expect(parameters?.["tint"]).toEqual({ kind: "audioBand", band: 3, gain: 1.5, smoothing: 0.2 });
    // The value this build does understand is untouched and NOT reported as unknown.
    expect(parameters?.["seed"]).toBe(9);
  });

  it("reports which parameters it could not interpret, rather than staying silent", () => {
    const parsed = parseProjectDocument(futureVersionFile());
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.unknownParameters).toEqual([
      { nodeId: "n1", key: "angle", kind: "static" },
      { nodeId: "n1", key: "tint", kind: "audioBand" },
    ]);
    // The resolver (§V61) and the inspector need to know; the load itself is fine.
    expect(parsed.diagnostics.every((diagnostic) => diagnostic.severity !== "error")).toBe(true);
  });

  it("keeps unknown fields at every level: document, graph, node, ui, settings", () => {
    const parsed = parseProjectDocument(futureVersionFile());
    if (!parsed.ok) throw new Error(parsed.reason);

    const document = parsed.document as unknown as Record<string, unknown>;
    expect(document["lastOpenedBy"]).toBe("shaderloom/9.2.0");
    expect((parsed.document.graph as unknown as Record<string, unknown>)["annotations"]).toEqual({
      a1: { text: "why is this node here", nodeId: "n1" },
    });
    expect((parsed.document.settings as unknown as Record<string, unknown>)["colorManagement"]).toEqual({
      view: "aces",
      exposure: 0.5,
    });
    const node = parsed.document.graph.nodes["n1"];
    expect(node?.resolution).toEqual({ mode: "aspect", ratio: "16:9", input: "in" });
    expect(node?.ui).toEqual({ collapsed: false, glow: "aurora" });
  });

  it("warns that the file is from a newer schema without refusing it", () => {
    const file = serializeProjectDocument({ ...testDocument(), schemaVersion: 99 });
    const parsed = parseProjectDocument(file);
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.newerThanApp).toBe(true);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("project.schema.newer");
    expect(serializeProjectDocument(parsed.document)).toBe(file);
  });

  it("survives the full open → save path, not just the parser", () => {
    const file = futureVersionFile();
    const loaded = loadProject(file, {
      nodes: definitionSource([testDefinition({ type: "gradient" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    // Nothing migrated and nothing was over a cap, so the document still matches the file.
    expect(loaded.changed).toBe(false);
    const saved = buildProjectFile({ document: loaded.document, now: () => loaded.document.updatedAt });
    expect(saved.text).toBe(file);
  });
});

describe("the passthrough lane stays a lane, not a hole", () => {
  it("is load-bearing: the closed write schema rejects the very same file", () => {
    // This is the regression the lane exists for. `projectDocumentSchema` describes what
    // THIS build writes and is correct for validating a patch; pointed at a file it throws
    // the user's project away over one field. If someone ever "simplifies" the open schema
    // back to the closed one, this assertion is the explanation of what broke.
    const raw: unknown = JSON.parse(futureVersionFile());
    expect(projectDocumentSchema.safeParse(raw).success).toBe(false);
    expect(openProjectDocumentSchema.safeParse(raw).success).toBe(true);
  });

  it("still rejects a malformed value in a shape this build owns", () => {
    // `fixed` is a mode we DO know: a negative width is a bug in our own shape, not a
    // message from the future, and must not be waved through as an unknown mode.
    const document = testDocument();
    const node = document.graph.nodes["n1"];
    if (node === undefined) throw new Error("fixture");
    node.resolution = { mode: "fixed", width: -8, height: 1080 };

    const parsed = parseProjectDocument(serializeProjectDocument(document));
    expect(parsed.ok).toBe(false);
  });

  it("still rejects a document that is not a project at all", () => {
    const parsed = parseProjectDocument(JSON.stringify({ schemaVersion: 1, hello: "world" }));
    expect(parsed.ok).toBe(false);
  });
});
