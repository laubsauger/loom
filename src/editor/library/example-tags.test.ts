import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument, ProjectDocument } from "../../domain/types/graph.ts";
import { listExamples } from "../../examples/catalogue.ts";
import type { ExampleFile } from "../../examples/catalogue.ts";
import { TIER_B_CAPABILITIES, exampleRegistry, requireExample } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import {
  EXAMPLE_CAPABILITIES,
  categoryOf,
  listExampleProjects,
  tagsOf,
} from "./example-catalogue.ts";
import type { ExampleTag } from "./example-catalogue.ts";

/**
 * THE CAPABILITY TAGS ARE DERIVED, AND THIS IS WHAT KEEPS THEM THAT WAY (T1162).
 *
 * The tags exist because an AUTHORED list rots: E54 was rebuilt from a Laplacian into a
 * trail system and E56 from a position map into a rate drive inside one week, and a
 * hand-written tag would still be describing the file each of them used to be. So nothing
 * below names an example or lists its expected tags. Every assertion is derived from the
 * shipped directory or from the vocabulary table, which is §V453's shape: the gate has to
 * fail when example 58 lands, not stay green because nobody remembered to extend it.
 *
 * Four distinct failures are covered, and they are different animals:
 *
 *  1. AN EXAMPLE WITH NOTHING TO SAY. Every shipped file earns at least one tag — the card
 *     is not allowed to have an empty answer to "what does this demonstrate".
 *  2. A ROW THAT NAMES A NODE THAT NO LONGER EXISTS. The vocabulary is authored once per
 *     capability, and its only authored content is node TYPE names. A rename would empty a
 *     tag silently, so every name is checked against the registry.
 *  3. A TAG THAT DISAGREES WITH THE COMPILER. The card reads the file's JSON; the compiler
 *     reads the graph. For the two STRUCTURAL tags the compiler has its own answer, and it
 *     is the oracle — over all 57 shipped examples, plus a with/without pair so the
 *     agreement is not vacuous.
 *  4. A WORD IN THE VOCABULARY THAT DESCRIBES NOTHING. Ten tags is a vocabulary; thirty is
 *     noise, and a tag no file earns is how a vocabulary drifts towards thirty.
 */

const projects = listExampleProjects();
const files = new Map<string, ExampleFile>(listExamples().map((file) => [file.fileName, file]));

/** The five medium tags are the ones `categoryOf` projects from; the rest are technique. */
const MEDIUM_TAGS: ReadonlySet<ExampleTag> = new Set<ExampleTag>([
  "audio",
  "video",
  "3d",
  "points",
  "feedback",
  "image",
]);

function nodeTypesOf(graph: GraphDocument): readonly string[] {
  return Object.values(graph.nodes).map((node) => node.type);
}

/**
 * The same graph with every node of the given types removed, and every edge that touched
 * one. This is how the with/without pair is built: from a REAL shipped example rather than
 * a hand-built fixture, so the "without" case is the same file minus exactly the capability
 * under test and cannot drift away from what the corpus actually looks like (§V88's
 * argument, one level down).
 */
function withoutTypes(graph: GraphDocument, drop: ReadonlySet<string>): GraphDocument {
  const removed = new Set(
    Object.values(graph.nodes)
      .filter((node) => drop.has(node.type))
      .map((node) => node.id),
  );
  return {
    ...graph,
    nodes: Object.fromEntries(
      Object.entries(graph.nodes).filter(([id]) => !removed.has(id)),
    ) as GraphDocument["nodes"],
    edges: Object.fromEntries(
      Object.entries(graph.edges).filter(
        ([, edge]) => !removed.has(edge.source.nodeId) && !removed.has(edge.target.nodeId),
      ),
    ) as GraphDocument["edges"],
  };
}

function compile(document: ProjectDocument, graph: GraphDocument) {
  return compileGraph({
    graph,
    settings: document.settings,
    registry: exampleRegistry(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

describe("example capability tags (T1162)", () => {
  it("is reading the shipped directory, not an empty glob", () => {
    // §V739: say the floor out loud, or every assertion below is vacuously true when the
    // catalogue glob and the fs walk stop agreeing about what ships.
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.map((project) => project.fileName).sort()).toEqual([...files.keys()].sort());
  });

  it("gives every shipped example at least one tag", () => {
    const silent = projects.filter((project) => project.tags.length === 0);
    expect(silent.map((project) => project.fileName)).toEqual([]);
  });

  it("names only node types this build actually registers", () => {
    // The one authored thing in the vocabulary is a list of node type names. A node
    // renamed anywhere else in the tree empties a tag with no other symptom — the cards
    // just quietly stop saying it — so the names are anchored to the registry.
    const registered = new Set(allNodeDefinitions.map((definition) => definition.type));
    const unknown = EXAMPLE_CAPABILITIES.flatMap((capability) =>
      [...capability.nodeTypes]
        .filter((type) => !registered.has(type))
        .map((type) => `${capability.tag}: ${type}`),
    );
    expect(unknown).toEqual([]);
  });

  it("keeps the category as the first medium tag, for every shipped example", () => {
    // §V487/§V748: the category taxonomy and the tags are two readings of ONE table, and
    // this is the pin that says so. If someone reorders the medium rows or gives a tag a
    // set the category half does not have, every example whose bucket moved shows up here.
    const disagreed = projects
      .filter((project) => project.tags.find((tag) => MEDIUM_TAGS.has(tag)) !== project.category)
      .map((project) => `${project.fileName}: ${project.category} vs ${project.tags.join(",")}`);
    expect(disagreed).toEqual([]);
  });

  it("earns every word in the vocabulary at least once", () => {
    // A tag no shipped example earns is a word that describes nothing, and the honest fix
    // is to delete the word or ship the example — not to leave a filter that returns an
    // empty list. This reddens the day the last example carrying some capability is
    // rewritten away, which is exactly when someone should be told.
    const earned = new Set(projects.flatMap((project) => project.tags));
    const unearned = EXAMPLE_CAPABILITIES.map(({ tag }) => tag).filter((tag) => !earned.has(tag));
    expect(unearned).toEqual([]);
  });

  it("keeps every tag a FACET rather than a description of the whole catalogue", () => {
    // A tag on all 57 files filters nothing. Stated as a bound rather than as counts so it
    // survives the catalogue growing.
    const universal = EXAMPLE_CAPABILITIES.map(({ tag }) => tag).filter((tag) =>
      projects.every((project) => project.tags.includes(tag)),
    );
    expect(universal).toEqual([]);
  });

  /**
   * THE COMPILER IS THE ORACLE for the two tags that describe a STRUCTURE rather than a
   * node (§T1162: "plan.feedback.length > 0 is exactly how temporal.test.ts discovers its
   * own subject set, without a list").
   *
   * The card cannot compile — it reads the file's JSON in the browser at library-open time
   * — so the derivation is a predicate over node types, and these are what stop that cheap
   * predicate from disagreeing with the expensive truth. Over the whole corpus, both ways:
   * a file the compiler finds a loop in must carry the tag, AND a file carrying the tag
   * must be one the compiler finds a loop in.
   */
  describe("agrees with the compiler about the structural tags", () => {
    const compiled = [...files.values()].map((file) => ({
      fileName: file.fileName,
      ...requireExample(file),
    }));

    it("tags `feedback` exactly when the plan closes a temporal loop", () => {
      const byTag = compiled
        .filter(({ document }) => tagsOf(nodeTypesOf(document.graph)).includes("feedback"))
        .map(({ fileName }) => fileName);
      const byPlan = compiled
        .filter(({ plan }) => plan.feedback.length > 0)
        .map(({ fileName }) => fileName);
      expect(byTag).toEqual(byPlan);
      expect(byPlan.length).toBeGreaterThan(0);
    });

    it("tags `component` exactly when the plan flattened one", () => {
      const byTag = compiled
        .filter(({ document }) => tagsOf(nodeTypesOf(document.graph)).includes("component"))
        .map(({ fileName }) => fileName);
      // A NON-EMPTY `path`, not a non-empty `sources`. Every kept node gets a source row —
      // `CompiledGraph.sources` says "Empty for a project with no components", and that
      // sentence is false today: the list is populated for all 57. `path` is the field that
      // is genuinely "empty at the root", so it is the one that says a node came from
      // INSIDE an instance.
      const byPlan = compiled
        .filter(({ plan }) => plan.sources.some((source) => source.path.length > 0))
        .map(({ fileName }) => fileName);
      expect(byTag).toEqual(byPlan);
      expect(byPlan.length).toBeGreaterThan(0);
    });
  });

  /**
   * The with/without pair, and it is the assertion that makes the corpus-wide agreement
   * above mean something: a predicate that returned `true` for every document would satisfy
   * "tag ⟺ plan" only if every document had a loop, but a predicate that never fires would
   * satisfy it if none did. Cutting the capability out of a file that HAS it is what
   * separates those.
   *
   * The subject is DISCOVERED, not named: the first shipped example that earns the tag.
   */
  describe("a document that has the capability and the same document without it", () => {
    it("loses the `feedback` tag AND the plan's loop when the loop nodes are cut", () => {
      const subject = [...files.values()].find((file) =>
        tagsOf(nodeTypesOf(requireExample(file).document.graph)).includes("feedback"),
      );
      if (subject === undefined) throw new Error("no shipped example closes a temporal loop");

      const { document } = requireExample(subject);
      const cut = withoutTypes(document.graph, new Set(["feedback"]));

      expect(tagsOf(nodeTypesOf(document.graph))).toContain("feedback");
      expect(compile(document, document.graph).feedback.length).toBeGreaterThan(0);

      expect(tagsOf(nodeTypesOf(cut))).not.toContain("feedback");
      expect(compile(document, cut).feedback).toEqual([]);
    });

    it("loses the `wgsl` tag when the hand-written shaders are cut", () => {
      // No compiler oracle for this one and that is stated rather than faked: `customWgsl`
      // emits an ordinary effect pass, and the plan has no field that says "a person wrote
      // this shader". The pair still proves the predicate is not a constant.
      const subject = [...files.values()].find((file) =>
        tagsOf(nodeTypesOf(requireExample(file).document.graph)).includes("wgsl"),
      );
      if (subject === undefined) throw new Error("no shipped example carries hand-written WGSL");

      const { document } = requireExample(subject);
      expect(tagsOf(nodeTypesOf(document.graph))).toContain("wgsl");
      const cut = withoutTypes(document.graph, new Set(["customWgsl"]));
      expect(tagsOf(nodeTypesOf(cut))).not.toContain("wgsl");
    });
  });

  it("derives a tag for a capability the shipped corpus does not have yet", () => {
    // The vocabulary is not a description of today's 57 files. A graph is tagged by what it
    // exercises, so a document that uses a capability no example uses is still tagged —
    // which is the property that makes the tags survive example 58.
    expect(tagsOf(["midiIn", "level", "output"])).toEqual(["image", "device"]);
    expect(categoryOf(["midiIn", "level", "output"])).toBe("image");
  });
});
