import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { documentLiveness, opReferenceNames } from "./liveness.ts";

/**
 * §V173b: liveness has THREE sources — a data edge to a sink, a driven slot naming a
 * value node's channel, an op() reference in an expression — and every consumer reads
 * this one answer. These tests are the definition.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id: id as NodeId, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra };
}

function graphOf(nodes: GraphNode[], edges: Array<[string, string, string, string]> = []): GraphDocument {
  const edgeRecord: Record<string, unknown> = {};
  edges.forEach(([sn, sp, tn, tp], index) => {
    edgeRecord[`e${index}`] = { id: `e${index}`, source: { nodeId: sn, portId: sp }, target: { nodeId: tn, portId: tp } };
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edgeRecord,
    groups: {},
  } as unknown as GraphDocument;
}

const drivenBy = (channel: string) => ({
  mode: "driven",
  bindings: { driven: { kind: "driven", channel } },
});
const expressionOf = (source: string) => ({
  mode: "expression",
  bindings: { expression: { kind: "expression", source } },
});

describe("documentLiveness (T268, §V173b)", () => {
  it("source 1 — the edge walk: a sink keeps its chain, an orphan is dead", () => {
    const graph = graphOf(
      [node("gen", "solid"), node("sink", "output"), node("orphan", "solid")],
      [["gen", "out", "sink", "input"]],
    );
    const { alive, dead } = documentLiveness(graph, registry);
    expect([...alive].sort()).toEqual(["gen", "sink"]);
    expect(dead).toEqual(["orphan"]);
  });

  it("source 4 — a SOURCE REFERENCE keeps the chain that reaches a loop only by name (T350)", () => {
    /*
     * T388 found this. A simulation loop whose result reaches its Feedback ONLY through
     * the recorded name — no wire, because §V285 made the wire a name — had its entire
     * upstream chain reported DEAD while it was driving the picture. The compiler was
     * right (it walks the synthesized edge); this walk has no such edge and has to read
     * the reference, exactly as it already reads driven channels and op() references.
     */
    const graph = graphOf(
      [
        node("gen", "solid"),
        node("mix", "over", { label: "over1" }),
        node("loop", "feedback", { parameters: { source: "over1" } as GraphNode["parameters"] }),
        node("sink", "output"),
      ],
      [
        ["gen", "out", "mix", "in1"],
        ["loop", "out", "mix", "in2"],
        ["loop", "out", "sink", "input"],
      ],
    );
    const { alive, dead } = documentLiveness(graph, registry);
    expect(dead).toEqual([]);
    expect([...alive].sort()).toEqual(["gen", "loop", "mix", "sink"]);
  });

  it("source 4 — a source reference naming nothing confers no liveness", () => {
    const graph = graphOf(
      [
        node("orphan", "solid", { label: "solid1" }),
        node("loop", "feedback", { parameters: { source: "nosuchnode" } as GraphNode["parameters"] }),
        node("sink", "output"),
      ],
      [["loop", "out", "sink", "input"]],
    );
    expect(documentLiveness(graph, registry).dead).toEqual(["orphan"]);
  });

  it("source 2 — a driven slot on an ALIVE node keeps the value source alive", () => {
    const graph = graphOf(
      [
        node("gen", "blur", { parameters: { size: drivenBy("lfo1") } as GraphNode["parameters"] }),
        node("sink", "output"),
        { ...node("mod", "lfo"), label: "lfo1" },
        { ...node("idle", "lfo"), label: "lfo2" },
      ],
      [["gen", "out", "sink", "input"]],
    );
    const { alive, dead } = documentLiveness(graph, registry);
    expect(alive.has("mod" as NodeId)).toBe(true);
    // An unreferenced value source is neither alive nor dead — never a candidate.
    expect(alive.has("idle" as NodeId)).toBe(false);
    expect(dead).toEqual([]);
  });

  it("source 3 — an op() reference keeps the referenced node alive (§V154's bug, prevented)", () => {
    const graph = graphOf(
      [
        node("gen", "blur", {
          parameters: { size: expressionOf("op('backdrop').par.amount * 2") } as GraphNode["parameters"],
        }),
        node("sink", "output"),
        { ...node("referenced", "solid"), label: "backdrop" },
      ],
      [["gen", "out", "sink", "input"]],
    );
    const { alive, dead } = documentLiveness(graph, registry);
    expect(alive.has("referenced" as NodeId)).toBe(true);
    expect(dead).toEqual([]);
  });

  it("references on DEAD nodes confer nothing — liveness flows from sinks outward", () => {
    const graph = graphOf(
      [
        node("sink", "output"),
        node("island", "blur", { parameters: { size: drivenBy("lfo1") } as GraphNode["parameters"] }),
        { ...node("mod", "lfo"), label: "lfo1" },
      ],
      [],
    );
    const { alive, dead } = documentLiveness(graph, registry);
    expect(dead).toEqual(["island"]);
    expect(alive.has("mod" as NodeId)).toBe(false);
  });

  it("a driven slot naming an explicit CHANNEL keeps its value node alive (T248)", () => {
    // `mouse1:x` addresses one channel of a multi-channel source. Matching the WHOLE
    // address against node names found nothing, so a Mouse visibly moving the picture
    // read as DEAD — §V154's bug in the other binding mode.
    const graph = graphOf(
      [
        node("gen", "blur", { parameters: { size: drivenBy("mouse1:x") } as GraphNode["parameters"] }),
        node("sink", "output"),
        { ...node("pointer", "mouse"), label: "mouse1" },
      ],
      [["gen", "out", "sink", "input"]],
    );
    const { alive } = documentLiveness(graph, registry);
    expect(alive.has("pointer" as NodeId)).toBe(true);
  });

  it("chains: driven -> value source whose own slot references another value source", () => {
    const graph = graphOf(
      [
        node("gen", "blur", { parameters: { size: drivenBy("lfo1") } as GraphNode["parameters"] }),
        node("sink", "output"),
        {
          ...node("mod", "lfo"),
          label: "lfo1",
          parameters: { frequency: drivenBy("speed") } as GraphNode["parameters"],
        },
        { ...node("knob", "constant"), label: "speed" },
      ],
      [["gen", "out", "sink", "input"]],
    );
    const { alive } = documentLiveness(graph, registry);
    expect(alive.has("knob" as NodeId)).toBe(true);
  });
});

describe("opReferenceNames", () => {
  it("parses references out of a valid source, and scans them out of a legacy one", () => {
    expect(opReferenceNames("op('a').par.x + op(\"b\").par.y * 2")).toEqual(["a", "b"]);
    // Unparseable under the current grammar — the syntactic fallback still sees it.
    expect(opReferenceNames("legacy_fn(op('c').par.x)")).toEqual(["c"]);
    expect(opReferenceNames("time * 2")).toEqual([]);
  });
});
