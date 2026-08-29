import { describe, expect, it } from "vitest";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/index.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import { SHADER_EDIT_LABEL, commitShaderSource, shaderSourcePatch } from "./commit-shader-source.ts";

const SHADER = "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }";

async function harnessWithShaderNode() {
  const { bus, store } = createHarness();
  const context = contextFor(alice);
  const created = await bus.execute(
    "graph.applyPatch",
    patch(store.view.getRevision(), [
      { op: "addNode", ref: "$shader", type: "test.customWgsl", position: { x: 0, y: 0 } },
    ]),
    context,
  );
  const nodeId = created.output.createdIds["$shader"];
  expect(nodeId).toBeDefined();
  return { bus, store, context, nodeId: nodeId ?? "" };
}

describe("V29 — a shader edit is a graph mutation, applied through the bus", () => {
  it("writes the node's source parameter and bumps the revision", async () => {
    const { bus, store, context, nodeId } = await harnessWithShaderNode();
    const before = store.view.getRevision();

    const result = await commitShaderSource({
      bus,
      context,
      nodeId,
      source: SHADER,
      baseRevision: before,
    });

    expect(result.status).toBe("applied");
    expect(store.view.getGraph().nodes[nodeId]?.parameters[SHADER_SOURCE_PARAMETER]).toBe(SHADER);
    expect(store.view.getRevision()).toBeGreaterThan(before);
  });

  it("is one undo group, so undo restores the previous shader (§V34, §V15)", async () => {
    const { bus, store, context, nodeId } = await harnessWithShaderNode();
    await commitShaderSource({
      bus,
      context,
      nodeId,
      source: SHADER,
      baseRevision: store.view.getRevision(),
    });

    await bus.execute("graph.undo", {}, context);

    expect(store.view.getGraph().nodes[nodeId]?.parameters[SHADER_SOURCE_PARAMETER]).toBe("");
  });

  it("reports a conflict on a stale base revision rather than rebasing silently (§V33)", async () => {
    const { bus, store, context, nodeId } = await harnessWithShaderNode();
    const stale = store.view.getRevision();
    await commitShaderSource({ bus, context, nodeId, source: SHADER, baseRevision: stale });

    const second = await commitShaderSource({
      bus,
      context,
      nodeId,
      source: "// different",
      baseRevision: stale,
    });

    expect(second.status).toBe("conflict");
    expect(store.view.getGraph().nodes[nodeId]?.parameters[SHADER_SOURCE_PARAMETER]).toBe(SHADER);
  });

  it("rejects a node that has no shader source parameter", async () => {
    const { bus, store } = createHarness();
    const context = contextFor(alice);
    const created = await bus.execute(
      "graph.applyPatch",
      patch(store.view.getRevision(), [
        { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 0, y: 0 } },
      ]),
      context,
    );
    const nodeId = created.output.createdIds["$blur"] ?? "";

    const result = await commitShaderSource({
      bus,
      context,
      nodeId,
      source: SHADER,
      baseRevision: store.view.getRevision(),
    });

    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "node.notShaderAuthorable")).toBe(true);
  });
});

describe("shaderSourcePatch", () => {
  it("builds a single setShaderSource operation with a labelled undo entry", () => {
    const built = shaderSourcePatch("node-1", SHADER, 4);
    expect(built).toEqual({
      baseRevision: 4,
      operations: [{ op: "setShaderSource", nodeId: "node-1", source: SHADER }],
      label: SHADER_EDIT_LABEL,
    });
  });
});
