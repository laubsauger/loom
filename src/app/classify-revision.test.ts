import { describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { EdgeId, NodeId, PortId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { classifyGraphChange, isValuesOnly } from "./classify-revision.ts";

/**
 * The rules behind T308's gate.
 *
 * The gate itself is proved at the backend seam in
 * `src/tests/integration/uniform-only-edit.test.tsx` — that a value edit avoids
 * `backend.compile` and writes uniforms instead. What is here is the classification, and
 * specifically the cases where being WRONG is expensive: an edit that looks cheap and is
 * not.
 *
 * Every document below comes out of the real store through the real patch command, so the
 * structural sharing this relies on is the store's own. Hand-built fixtures would share
 * nothing and the diff would report everything as changed, which is the one failure mode
 * that would make these tests pass while the product recompiled constantly.
 */

const registry = createTestRegistry().view();

function harness() {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    now: () => "2026-08-30T00:00:00.000Z",
  });
  const { bus } = createDomainBus({ store, registry });
  const context = { actor: { kind: "human" as const, id: "tester" }, projectId: "p", capabilities: [] };

  const apply = async (operations: GraphPatchOperation[]) =>
    bus.execute(
      "graph.applyPatch",
      { baseRevision: store.view.getRevision(), operations },
      context,
    );

  return { store, apply, graph: (): GraphDocument => store.view.getGraph() };
}

/** A seeded blur → output chain, and the document before/after a given edit. */
interface SeededIds {
  a: string;
  b: string;
}

async function afterEdit(operations: (ids: SeededIds) => GraphPatchOperation[]) {
  const { apply, graph } = harness();
  const seeded = await apply([
    { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$b", type: "test.blur", position: { x: 240, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$a", portId: "out" },
      target: { nodeId: "$b", portId: "source" },
    },
  ]);
  const ids: SeededIds = {
    a: seeded.output.createdIds["$a"] as string,
    b: seeded.output.createdIds["$b"] as string,
  };
  const previous = graph();
  await apply(operations(ids));
  return { previous, next: graph(), ids };
}

/**
 * Two revisions OF THE SAME DOCUMENT — which is what every test below except the last
 * group is about, and what makes those tests still mean what they meant (§V32's cheap
 * path has to survive this task, or a correctness fix has bought a performance bug).
 */
const SAME_DOCUMENT = "document-under-test";

const classify = (previous: GraphDocument, next: GraphDocument) =>
  classifyGraphChange(
    { identity: SAME_DOCUMENT, graph: previous },
    { identity: SAME_DOCUMENT, graph: next },
    registry,
  );

describe("classifying a revision (T308, §V5)", () => {
  it("calls an ordinary parameter edit values-only", async () => {
    const { previous, next, ids } = await afterEdit((id) => [
      { op: "setParameters", nodeId: id.b, parameters: { radius: 8 } },
    ]);
    const decision = classify(previous, next);
    expect(decision.work).toBe("uniform-update");
    expect(decision.nodes).toEqual([ids.b]);
    expect(isValuesOnly(decision)).toBe(true);
  });

  it("calls a move and a resize editor-only (§V190, §V116)", async () => {
    const { previous, next } = await afterEdit((id) => [
      { op: "moveNodes", positions: { [id.b]: { x: 500, y: 500 } } },
      { op: "setNodeSize", nodeId: id.b, size: { width: 300, height: 200 } },
    ]);
    expect(classify(previous, next).work).toBe("editor-only");
  });

  it("takes the MOST expensive edit in a batch, never the last one", async () => {
    // A patch is atomic and carries many operations (§V32). A batch that moves a node and
    // rewires it costs what the rewire costs — and the rewire is not last here, so a
    // reducer that kept the final answer instead of the strongest would call this cheap.
    const { previous, next } = await afterEdit((id) => [
      { op: "disconnect", edgeIds: Object.keys({}) },
      { op: "addNode", ref: "$c", type: "test.solid", position: { x: 0, y: 400 } },
      { op: "moveNodes", positions: { [id.b]: { x: 10, y: 10 } } },
    ]);
    expect(classify(previous, next).work).toBe("recompile-region");
  });

  it("refuses to call a compileTime parameter cheap (§V5's one exception)", async () => {
    // A Custom WGSL node's `source` is a `setParameters` like any other to a document
    // diff — same operation, same field, same shape as editing a radius. Only the
    // MANIFEST says it is `compileTime`, and only `classifyEdit` reads the manifest.
    // Getting this wrong leaves the old pipeline running against new shader source. With
    // the `radius` case above this is the pair that matters: the same kind of operation on
    // the same kind of field is cheap or expensive depending only on what the manifest says.
    const { apply, graph } = harness();
    const seeded = await apply([
      { op: "addNode", ref: "$w", type: "test.customWgsl", position: { x: 0, y: 0 } },
    ]);
    const wgsl = seeded.output.createdIds["$w"] as string;
    const previous = graph();
    const edited = await apply([
      { op: "setShaderSource", nodeId: wgsl, source: "// different" },
    ]);
    expect(edited.output.status).toBe("applied");

    const decision = classify(previous, graph());
    expect(decision.work).toBe("recompile-region");
    expect(isValuesOnly(decision)).toBe(false);
  });

  it("refuses to call bypass or mute cheap — they change what renders", async () => {
    const { previous, next } = await afterEdit((id) => [
      { op: "setNodeUi", nodeId: id.b, ui: { bypassed: true } },
    ]);
    expect(isValuesOnly(classify(previous, next))).toBe(false);
  });

  it("treats a rename as structural — a name is an identifier (§V128, §V129)", async () => {
    // Expressions reference nodes BY NAME, so renaming one can change what another node's
    // parameter resolves to. It looks like a label and it is a dependency edge.
    const { previous, next } = await afterEdit((id) => [
      { op: "setNodeLabel", nodeId: id.b, label: "softening" },
    ]);
    expect(isValuesOnly(classify(previous, next))).toBe(false);
  });

  it("treats a resolution override as a repropagation, not a value", async () => {
    const { previous, next } = await afterEdit((id) => [
      { op: "setNodeResolution", nodeId: id.b, resolution: { mode: "fixed", width: 512, height: 512 } },
    ]);
    expect(classify(previous, next).work).toBe("repropagate");
  });

  it("notices a rewire that changes no node and no edge COUNT (§V131, T225)", async () => {
    // Reordering a variadic port's edges adds and removes nothing: the node objects are
    // untouched and the edge ids are identical. Layer order IS the operation for a
    // composite, so a key-set comparison alone would call this "nothing happened".
    const { apply, graph } = harness();
    const seeded = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.solid", position: { x: 0, y: 200 } },
      { op: "addNode", ref: "$c", type: "test.composite", position: { x: 240, y: 0 } },
      {
        op: "connect",
        ref: "$e1",
        source: { nodeId: "$a", portId: "out" },
        target: { nodeId: "$c", portId: "layers" },
      },
      {
        op: "connect",
        ref: "$e2",
        source: { nodeId: "$b", portId: "out" },
        target: { nodeId: "$c", portId: "layers" },
      },
    ]);
    const composite = seeded.output.createdIds["$c"] as string;
    const e1 = seeded.output.createdIds["$e1"] as string;
    const e2 = seeded.output.createdIds["$e2"] as string;

    const previous = graph();
    const reordered = await apply([
      { op: "reorderEdges", nodeId: composite, portId: "layers", edgeIds: [e2, e1] },
    ]);
    // If the registry's composite has no variadic `layers` port this fixture is wrong
    // rather than the classifier — fail loudly instead of asserting on a no-op.
    expect(reordered.output.status).toBe("applied");
    expect(isValuesOnly(classify(previous, graph()))).toBe(false);
  });

  it("says nothing changed when nothing changed", async () => {
    const { graph } = harness();
    const document = graph();
    expect(classify(document, document).work).toBe("editor-only");
  });
});

/**
 * T519 / B106 — a LOAD is a discontinuity, not a diff.
 *
 * The owner: "if we're loading another loom or example and that happens to share the
 * same name with the prior rendered one, we need to manually kick the different nodes to
 * update and not show the prior rendered one's content". Two documents that share node
 * NAMES share node IDS, and every one of the shipped examples has a node called `out`.
 *
 * ## Why these fixtures and not two obviously-different documents
 *
 * §V461: a fixture must be CAPABLE of distinguishing what its test asserts. Two
 * documents that differ visibly diff as `topology` and would have passed before this
 * task existed — they prove nothing, because the bug only appears where the diff
 * BELIEVES nothing important happened. So both fixtures below are adversarial on
 * purpose: identical node ids, identical types, identical labels, identical edge ids.
 * `identicalExcept` differs in exactly one parameter that changes the picture and
 * nothing else; `sameContent` does not differ at all, which is the case the old code
 * answered `editor-only` for — "the document did not change" — and on which the caller
 * therefore reused the PREVIOUS DOCUMENT'S compiled plan wholesale.
 *
 * The discriminating assertion is `resetFeedback`. Before this, the strongest a load
 * could produce was `recompile-region` with `resetFeedback: false`, and a
 * `recompile-region` still permits the backend to carry resources over by RESOURCE ID —
 * which is how one project's feedback history ends up rendering in the next.
 */
describe("T519 — a load is a discontinuity, not a diff (B106)", () => {
  const NODE = (parameters: Record<string, number>): GraphDocument["nodes"] => ({
    // The names everyone gets. `out` is in every shipped example; E2 and E24 share
    // ELEVEN ids including the one holding the reaction-diffusion state.
    field: {
      id: "field" as NodeId,
      type: "test.solid",
      definitionVersion: 1,
      label: "solid1",
      position: { x: 0, y: 0 },
      parameters,
    },
    out: {
      id: "out" as NodeId,
      type: "test.blur",
      definitionVersion: 1,
      label: "blur1",
      position: { x: 240, y: 0 },
      parameters: {},
    },
  });

  const EDGES: GraphDocument["edges"] = {
    "e-field-out": {
      id: "e-field-out" as EdgeId,
      source: { nodeId: "field" as NodeId, portId: "out" as PortId },
      target: { nodeId: "out" as NodeId, portId: "source" as PortId },
    },
  };

  const documentWith = (parameters: Record<string, number>): GraphDocument => ({
    revision: 1,
    nodes: NODE(parameters),
    edges: EDGES,
    groups: {},
  });

  /** Two DIFFERENT documents. Same ids, same wiring; one parameter changes the image. */
  const documentA = documentWith({ amount: 0.1 });
  const documentB = documentWith({ amount: 0.9 });

  it("rebuilds everything when the DOCUMENT changed, however alike the two are", () => {
    const decision = classifyGraphChange(
      { identity: "project-a", graph: documentA },
      { identity: "project-b", graph: documentB },
      registry,
    );
    // The strongest work there is — not `recompile-region`, which would leave everything
    // outside the changed region reusable, and reuse is the bug.
    expect(decision.work).toBe("repropagate");
    expect(isValuesOnly(decision)).toBe(false);
    // The two flags the pixels actually depend on. `resetFeedback` is the one the old
    // code could not produce for a load at any strength.
    expect(decision.recreateTargets).toBe(true);
    expect(decision.resetFeedback).toBe(true);
    // T552: and the third flag, the one only a LOAD sets. `resetFeedback` alone is
    // what a resolution edit produces — textures reset, simulations keep running. A
    // document boundary additionally zeroes the point buffer pairs and lands the
    // transport on frame 0, so the loaded document opens byte-identical to a cold open.
    expect(decision.documentBoundary).toBe(true);
    // EVERY node, because there is nothing to diff against — not the subset some
    // id-comparison happened to notice.
    expect([...decision.nodes]).toEqual(["field", "out"]);
  });

  it("still rebuilds when the two documents are CONTENT-IDENTICAL", () => {
    // The purest form of the bug, and the sentence the old code answered it with: "The
    // document did not change." It had not — and it was a different document, whose
    // every node would have kept the other project's cached texture, temporal history
    // and compiled pass. A decision that depends on content coinciding is the defect.
    const decision = classifyGraphChange(
      { identity: "project-a", graph: documentA },
      { identity: "project-b", graph: documentA },
      registry,
    );
    expect(decision.work).toBe("repropagate");
    expect(decision.resetFeedback).toBe(true);
  });

  it("keeps the CHEAP path for an ordinary edit inside one document (§V5, §V32)", async () => {
    // The other direction, and it is not optional: if a load being expensive made every
    // revision expensive, this task would have traded a correctness bug for a
    // performance one. §V32's take-the-maximum rule exists so a batch costs what its
    // most expensive member costs — and a value edit's maximum is still a uniform write.
    const { previous, next, ids } = await afterEdit((id) => [
      { op: "setParameters", nodeId: id.b, parameters: { radius: 8 } },
    ]);
    const decision = classifyGraphChange(
      { identity: SAME_DOCUMENT, graph: previous },
      { identity: SAME_DOCUMENT, graph: next },
      registry,
    );
    expect(decision.work).toBe("uniform-update");
    expect(isValuesOnly(decision)).toBe(true);
    expect(decision.resetFeedback).toBe(false);
    expect([...decision.nodes]).toEqual([ids.b]);
  });

  it("does not treat a NEW identity as a reason to be expensive twice", () => {
    // The boundary is crossed ONCE. A second revision of the now-open document is an
    // ordinary edit again — the identity is what changed, not the fact of having loaded.
    const decision = classifyGraphChange(
      { identity: "project-b", graph: documentA },
      { identity: "project-b", graph: documentA },
      registry,
    );
    expect(decision.work).toBe("editor-only");
    expect(decision.resetFeedback).toBe(false);
  });
});
