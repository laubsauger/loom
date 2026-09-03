import { describe, expect, it } from "vitest";

import type { GraphComponentDefinition } from "../types/components.ts";
import type { MigrationResult } from "../types/node-definition.ts";
import { bloomComponent, blurKnob, createComponentHarness } from "../components/test-support.ts";
import { loadProject } from "./load.ts";
import { buildProjectFile, nextProjectFileName, projectFileName } from "./project-file.ts";
import { serializeProjectDocument } from "./serialize.ts";
import { definitionSource, testDefinition, testDocument } from "./test-support.ts";

/**
 * T43 — opening and saving a `.loom.json`.
 *
 * The claims under test are the ones a user notices: my file comes back exactly as I left
 * it; a node this build no longer has does not quietly disappear from my project; a node
 * that moved on a version tells me what it did to my parameters; and a broken file gives
 * me a sentence instead of a stack trace.
 */

describe("round trip", () => {
  it("writes and reads back the same document, byte for byte", () => {
    const document = testDocument();
    const file = buildProjectFile({ document, now: () => document.updatedAt });

    const loaded = loadProject(file.text, {
      nodes: definitionSource([testDefinition({ type: "gradient" }), testDefinition({ type: "output" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.document).toEqual(document);
    expect(loaded.changed).toBe(false);
    const rewritten = buildProjectFile({ document: loaded.document, now: () => document.updatedAt });
    expect(rewritten.text).toBe(file.text);
  });

  it("carries a node's stacking order across a save and an open (T1102)", () => {
    /*
     * The whole reason `ui.z` is DOCUMENT state and not view state: the owner asked to
     * "place nodes above others", and an arrangement that resets on reload is not a
     * placement. Asserted against the real save path rather than against the schema,
     * because the schema this build WRITES does not enumerate `ui.z` any more than it
     * enumerates `previewPinned` — the open path passes unknown `ui` keys through (§V68,
     * `forward-compat.ts`), and that is the property the field actually depends on.
     */
    const base = testDocument();
    const document = {
      ...base,
      graph: {
        ...base.graph,
        nodes: {
          ...base.graph.nodes,
          n1: { ...base.graph.nodes["n1"]!, ui: { z: 4 } },
        },
      },
    };
    const file = buildProjectFile({ document, now: () => document.updatedAt });

    const loaded = loadProject(file.text, {
      nodes: definitionSource([testDefinition({ type: "gradient" }), testDefinition({ type: "output" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.document.graph.nodes["n1"]?.ui?.z).toBe(4);
    // And the node nobody raised comes back with no stacking order at all, so an
    // untouched document is still an untouched document.
    expect(loaded.document.graph.nodes["n2"]?.ui).toBeUndefined();
  });

  it("names the file after the project", () => {
    expect(projectFileName("My Bloom Rig")).toBe("My-Bloom-Rig.loom.json");
    expect(projectFileName("  ")).toBe("untitled.loom.json");
    expect(projectFileName("../../etc/passwd")).toBe("etcpasswd.loom.json");
  });

  describe("the name a second save offers (T697)", () => {
    it("offers the same name again when this session has not written it", () => {
      // The default case and the important one: a name we have NOT written is offered as
      // it stands. A browser cannot read the directory, so anything else would be a guess
      // dressed as a fact — and "bloom-2" beside a bloom that does not exist is worse
      // than no suffix, because the user cannot tell which file is current.
      expect(nextProjectFileName("bloom.loom.json", new Set())).toBe("bloom.loom.json");
      expect(nextProjectFileName("bloom.loom.json", new Set(["other.loom.json"]))).toBe(
        "bloom.loom.json",
      );
    });

    it("counts up past the names this session has written", () => {
      const written = new Set(["bloom.loom.json"]);
      expect(nextProjectFileName("bloom.loom.json", written)).toBe("bloom-2.loom.json");
      written.add("bloom-2.loom.json");
      expect(nextProjectFileName("bloom.loom.json", written)).toBe("bloom-3.loom.json");
    });

    it("replaces a counter rather than stacking them", () => {
      // The suggestion feeds back in: after saving `bloom-2`, the next save starts from
      // `bloom-2` and must offer `bloom-3`, not `bloom-2-2`. Four saves in one session is
      // an ordinary afternoon, and `bloom-2-2-2-2` is the version of this feature that
      // gets turned off.
      const written = new Set(["bloom.loom.json", "bloom-2.loom.json"]);
      expect(nextProjectFileName("bloom-2.loom.json", written)).toBe("bloom-3.loom.json");
    });

    it("keeps the number in front of the extension, not after it", () => {
      // `bloom.loom.json-2` is not a project file: the picker filters on the extension
      // and the OS opens it with nothing. The whole double extension has to survive.
      expect(nextProjectFileName("bloom.loom.json", new Set(["bloom.loom.json"]))).toMatch(
        /\.loom\.json$/,
      );
    });
  });

  it("stamps updatedAt on every save so autosave and manual save agree", () => {
    const document = testDocument();
    const file = buildProjectFile({ document, now: () => "2026-09-01T12:00:00.000Z" });
    expect(file.document.updatedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(JSON.parse(file.text).updatedAt).toBe("2026-09-01T12:00:00.000Z");
  });
});

describe("§V10: an unknown node type becomes a placeholder, never a deletion", () => {
  it("keeps the node, its parameters and its edges", () => {
    const document = testDocument();
    document.graph.nodes["n1"] = {
      id: "n1",
      type: "future.plasma",
      definitionVersion: 4,
      position: { x: 0, y: 0 },
      parameters: { turbulence: 0.75, palette: "ember" },
      label: "Plasma",
    };
    const file = serializeProjectDocument(document);

    // This build has `output` but has never heard of `future.plasma`.
    const loaded = loadProject(file, { nodes: definitionSource([testDefinition({ type: "output" })]) });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(Object.keys(loaded.document.graph.nodes).sort()).toEqual(["n1", "n2"]);
    expect(loaded.document.graph.nodes["n1"]?.parameters).toEqual({
      turbulence: 0.75,
      palette: "ember",
    });
    expect(Object.keys(loaded.document.graph.edges)).toEqual(["e1"]);
    expect(serializeProjectDocument(loaded.document)).toBe(file);
  });

  it("describes the placeholder well enough to draw it, ports included", () => {
    const document = testDocument();
    document.graph.nodes["n1"] = {
      ...(document.graph.nodes["n1"] ?? { id: "n1", position: { x: 0, y: 0 }, parameters: {} }),
      id: "n1",
      type: "future.plasma",
      definitionVersion: 4,
      position: { x: 0, y: 0 },
      parameters: { turbulence: 0.75, palette: "ember" },
      label: "Plasma",
    };
    document.graph.edges["e2"] = {
      id: "e2",
      source: { nodeId: "n2", portId: "out" },
      target: { nodeId: "n1", portId: "source" },
    };

    const loaded = loadProject(serializeProjectDocument(document), {
      nodes: definitionSource([testDefinition({ type: "output" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.placeholders).toEqual([
      {
        nodeId: "n1",
        type: "future.plasma",
        definitionVersion: 4,
        label: "Plasma",
        // Recovered from the edges that touch it — the manifest that declared them is
        // not installed, so the edges are the only evidence the ports existed.
        inputs: ["source"],
        outputs: ["out"],
        parameterKeys: ["palette", "turbulence"],
      },
    ]);
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain("project.node.unknownType");
  });
});

describe("§V10: a stale definitionVersion runs the node's own migration", () => {
  const gradientV2 = testDefinition({
    type: "gradient",
    version: 2,
    migrate(oldVersion: number, data: unknown): MigrationResult {
      // v1 stored degrees; v2 stores turns.
      const parameters = { ...(data as Record<string, unknown>) };
      const angle = parameters["angle"];
      if (oldVersion < 2 && typeof angle === "number") parameters["turns"] = angle / 360;
      delete parameters["angle"];
      return { parameters };
    },
  });

  it("applies it, bumps the version and records exactly what changed", () => {
    const file = serializeProjectDocument(testDocument());
    const loaded = loadProject(file, {
      nodes: definitionSource([gradientV2, testDefinition({ type: "output" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    const node = loaded.document.graph.nodes["n1"];
    expect(node?.definitionVersion).toBe(2);
    expect(node?.parameters).toEqual({ turns: 0.125, tint: [1, 0, 0, 1] });
    expect(loaded.nodeMigrations).toEqual([
      {
        nodeId: "n1",
        type: "gradient",
        fromVersion: 1,
        toVersion: 2,
        added: ["turns"],
        removed: ["angle"],
        changed: [],
      },
    ]);
    // The in-memory document no longer matches the file, and the app must know that.
    expect(loaded.changed).toBe(true);
  });

  it("reports a definition that moved on without writing a migration, and changes nothing", () => {
    const loaded = loadProject(serializeProjectDocument(testDocument()), {
      nodes: definitionSource([
        testDefinition({ type: "gradient", version: 5 }),
        testDefinition({ type: "output" }),
      ]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    // Not bumped: recording a migration that never ran would be a lie about the document.
    expect(loaded.document.graph.nodes["n1"]?.definitionVersion).toBe(1);
    expect(loaded.document.graph.nodes["n1"]?.parameters).toEqual({ angle: 45, tint: [1, 0, 0, 1] });
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain("project.node.noMigration");
    expect(loaded.changed).toBe(false);
  });

  it("survives a migration that throws, leaving that node exactly as saved", () => {
    const loaded = loadProject(serializeProjectDocument(testDocument()), {
      nodes: definitionSource([
        testDefinition({
          type: "gradient",
          version: 2,
          migrate: () => {
            throw new Error("bad assumption about v1");
          },
        }),
        testDefinition({ type: "output" }),
      ]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.document.graph.nodes["n1"]?.parameters).toEqual({ angle: 45, tint: [1, 0, 0, 1] });
    const failure = loaded.diagnostics.find((d) => d.code === "project.node.migrationFailed");
    expect(failure?.severity).toBe("error");
    expect(failure?.message).toContain("bad assumption about v1");
  });

  it("leaves a node saved by a NEWER definition alone (§V68)", () => {
    const document = testDocument();
    const node = document.graph.nodes["n1"];
    if (node === undefined) throw new Error("fixture");
    node.definitionVersion = 9;
    const file = serializeProjectDocument(document);

    const loaded = loadProject(file, {
      nodes: definitionSource([gradientV2, testDefinition({ type: "output" })]),
    });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(serializeProjectDocument(loaded.document)).toBe(file);
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain("project.node.newerVersion");
  });
});

describe("a broken file produces a diagnostic, never a throw", () => {
  it("handles a truncated file", () => {
    const file = serializeProjectDocument(testDocument()).slice(0, 120);
    const loaded = loadProject(file);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.diagnostics[0]?.code).toBe("project.parse.invalidJson");
    expect(loaded.diagnostics[0]?.severity).toBe("error");
  });

  it("handles a file that is valid JSON but not a project", () => {
    const loaded = loadProject('{"hello":"world"}');
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toContain("schemaVersion");
  });

  it("handles an empty file", () => {
    expect(loadProject("").ok).toBe(false);
  });

  it("handles a document whose graph is the wrong shape", () => {
    const loaded = loadProject(JSON.stringify({ ...testDocument(), graph: [] }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.diagnostics.some((d) => d.code === "project.parse.invalidDocument")).toBe(true);
  });
});

describe("§V83: the component library round-trips and registers at load", () => {
  function componentProject(): { text: string; component: GraphComponentDefinition } {
    const component = bloomComponent("bloom", 1, [blurKnob]);
    const file = buildProjectFile({
      document: testDocument(),
      components: [component],
      now: () => "2026-08-29T00:00:00.000Z",
    });
    return { text: file.text, component };
  }

  it("installs the file's definitions into the catalogue", () => {
    const { text, component } = componentProject();
    const harness = createComponentHarness();

    const loaded = loadProject(text, { components: harness.components });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.components).toHaveLength(1);
    expect(harness.components.get("bloom", 1)).toEqual(component);
    // The library rides at the document root and is lifted back off, so the document the
    // store receives is a plain ProjectDocument.
    expect(Object.keys(loaded.document)).not.toContain("componentLibrary");
  });

  it("writes the same file back out from the loaded catalogue", () => {
    const { text } = componentProject();
    const harness = createComponentHarness();

    const loaded = loadProject(text, { components: harness.components });
    if (!loaded.ok) throw new Error(loaded.reason);

    const rewritten = buildProjectFile({
      document: loaded.document,
      components: loaded.components,
      now: () => loaded.document.updatedAt,
    });
    expect(rewritten.text).toBe(text);
  });

  it("reports a recursive definition instead of installing it, and opens the rest", () => {
    // A component whose internal graph instantiates itself — §V83's direct case. The file
    // is hand-built because nothing in the app would let a user create it.
    const recursive: GraphComponentDefinition = {
      ...bloomComponent("loop", 1),
      // No exposed ports: recursion must be the ONLY thing wrong with this definition,
      // or the test would pass on an unrelated validation error.
      inputs: [],
      outputs: [],
      graph: {
        revision: 0,
        nodes: {
          inner: {
            id: "inner",
            type: "component:loop@1",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {},
            state: { component: { componentId: "loop", version: 1, parameters: {} } },
          },
        },
        edges: {},
        groups: {},
      },
    };
    const text = buildProjectFile({
      document: testDocument(),
      components: [recursive],
      now: () => "2026-08-29T00:00:00.000Z",
    }).text;
    const harness = createComponentHarness();

    const loaded = loadProject(text, { components: harness.components });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.components).toHaveLength(0);
    expect(harness.components.has("loop")).toBe(false);
    const rejected = loaded.diagnostics.find((d) => d.code === "project.components.rejected");
    expect(rejected?.severity).toBe("error");
    expect(rejected?.message).toContain("Component recursion is not allowed: loop → loop");
    // The project still opened.
    expect(Object.keys(loaded.document.graph.nodes)).toHaveLength(2);
  });

  it("reports a corrupt library without failing the whole load", () => {
    const document = testDocument() as unknown as Record<string, unknown>;
    document["componentLibrary"] = { schemaVersion: 1, components: [{ nope: true }] };

    const loaded = loadProject(JSON.stringify(document), { components: createComponentHarness().components });
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.diagnostics.some((d) => d.code === "project.components.invalid")).toBe(true);
  });
});

describe("assets are referenced, and an unreachable one asks to be relinked", () => {
  it("flags a session-scoped object URL after a reload", () => {
    const document = testDocument({
      assets: [
        {
          assetId: "a1",
          kind: "image",
          name: "logo.png",
          source: { kind: "objectUrl", sessionId: "session-that-ended" },
        },
        {
          assetId: "a2",
          kind: "image",
          name: "backdrop.png",
          source: { kind: "project", relativePath: "media/backdrop.png" },
        },
      ],
    });

    const loaded = loadProject(serializeProjectDocument(document));
    if (!loaded.ok) throw new Error(loaded.reason);

    expect(loaded.assetsToRelink.map((asset) => asset.assetId)).toEqual(["a1"]);
    expect(loaded.diagnostics.some((d) => d.code === "project.asset.unresolved")).toBe(true);
    // The reference keeps its identity — relinking is a user action, not a deletion.
    expect(loaded.document.assets).toHaveLength(2);
  });
});
