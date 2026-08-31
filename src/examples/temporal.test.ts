import { describe, expect, it } from "vitest";
import { sourceReferenceName } from "../domain/graph/source-references.ts";
import { compileGraph, diffPlans, feedbackToReset, swapPassId } from "../compiler/index.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import type { GraphDocument, ProjectDocument } from "../domain/types/graph.ts";
import { listExamples, type ExampleFile } from "./catalogue.ts";
import { TIER_B_CAPABILITIES, exampleRegistry, messagesOf, requireExample } from "./runner.ts";

/**
 * §V22 for every example that closes a loop (T153, T154).
 *
 * A feedback example is worth shipping only if the temporal machinery underneath it holds:
 * a STABLE ping-pong pair, a swap placed after every current-frame consumer, and history
 * that survives edits elsewhere in the graph. Each of those has a specific way of failing
 * silently — a pair reallocated per compile looks fine for one frame, a swap encoded too
 * early reads this frame's write half instead of last frame's, and a reset triggered by an
 * unrelated edit just makes live patching impossible without anyone being able to say why.
 *
 * Discovered, not listed: any example with a temporal output is covered here automatically.
 * The guard at the bottom is what stops that from silently becoming "no examples, all fine".
 */

const examples = listExamples();

interface TemporalExample {
  readonly file: ExampleFile;
  readonly document: ProjectDocument;
  readonly plan: CompiledGraph;
}

const temporalExamples: TemporalExample[] = examples.flatMap((file) => {
  const { document, plan } = requireExample(file);
  return plan.feedback.length === 0 ? [] : [{ file, document, plan }];
});

/**
 * An edit that is unrelated to the loop but REACHABLE from a sink.
 *
 * The reachability is the whole point. An added node nothing consumes is pruned before the
 * compiler ever allocates anything for it (§V25), so a plan diff over it proves only that
 * pruning works — it never exercises the "one new node must not wipe every feedback pair"
 * path at all. So this taps the existing sink's own source into a NEW Level feeding a NEW
 * Output: a second live branch, touching nothing inside the cycle.
 */
function withUnrelatedBranch(graph: GraphDocument): GraphDocument {
  const outputId = Object.keys(graph.nodes)
    .sort()
    .find((id) => graph.nodes[id]?.type === "output");
  if (outputId === undefined) throw new Error("example has no output node");

  const feeding = Object.keys(graph.edges)
    .sort()
    .map((id) => graph.edges[id])
    .find((edge) => edge?.target.nodeId === outputId);
  if (feeding === undefined) throw new Error("example's output has nothing connected");

  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      "probe-level": {
        id: "probe-level",
        type: "level",
        definitionVersion: 1,
        position: { x: 0, y: 600 },
        parameters: { contrast: 1.5 },
      },
      "probe-out": {
        id: "probe-out",
        type: "output",
        definitionVersion: 1,
        position: { x: 260, y: 600 },
        parameters: {},
      },
    },
    edges: {
      ...graph.edges,
      "probe-in": {
        id: "probe-in",
        source: { nodeId: feeding.source.nodeId, portId: feeding.source.portId },
        target: { nodeId: "probe-level", portId: "input" },
      },
      "probe-sink": {
        id: "probe-sink",
        source: { nodeId: "probe-level", portId: "out" },
        target: { nodeId: "probe-out", portId: "input" },
      },
    },
  };
}

function compile(document: ProjectDocument, graph: GraphDocument): CompiledGraph {
  return compileGraph({
    graph,
    settings: document.settings,
    registry: exampleRegistry(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

describe("examples with a temporal loop", () => {
  it("covers every example the spec builds on Feedback", () => {
    // Lexicographic, so E12 sorts between E1 and E2. E12 closes TWO loops in one file
    // (velocity and dye), which is why it is the one that would notice a swap ordered
    // per-plan rather than per-pair.
    expect(temporalExamples.map((entry) => entry.file.fileName)).toEqual([
      "E1-Feedback-Echo.loom.json",
      "E12-Fluid.loom.json",
      "E2-Reaction-Diffusion.loom.json",
      "E24-Audio-Reaction-Diffusion.loom.json",
      // T503: E29's whole picture IS its loop — nothing in it reads a clock, so the
      // corridor cannot snap at a timeline lap. That is the loop's third use in the set,
      // after a smear (E1) and a simulation (E2/E12/E24): a ZOOM.
      "E29-Descent.loom.json",
      // T538: the owner's own file. Its loop closes on the FINAL output (§V471.5), so the
      // trails carry the graded colour rather than a ghost of the raw render.
      "E31-Corona.loom.json",
      // T511: E9's loop is a SPARK STREAK. Two frames of an ember's own path, held so a
      // moving point reads as a moving point rather than a stipple — the loop's fourth
      // use in the set, after a smear, a simulation and a zoom. Its persistence is a
      // CONSTANT and nothing raises contrast inside it (§V481), and it closes on the
      // final output (§V471.5) so what smears is the picture with its glow already on.
      "E9-Ember.loom.json",
    ]);
  });
});

describe.each(temporalExamples)("$file.fileName temporal structure", ({ document, plan }) => {
  /**
   * §V4 → §V285: the LOOP is real, but since T350 the document no longer wires it —
   * Feedback NAMES its source, `edges` stays a DAG, and the compiler synthesizes the
   * closing edge. A legacy document may still wire it (the loader accepts both, never
   * both at once); either way the temporal node is fed and feeds the loop.
   */
  it("closes a real loop through the temporal node — by reference or legacy wire", () => {
    const edges = Object.values(document.graph.edges);
    const temporalNodes = new Set(plan.feedback.map((pair) => pair.nodeId));

    for (const nodeId of temporalNodes) {
      const node = document.graph.nodes[nodeId];
      const fedByReference =
        node !== undefined && sourceReferenceName(node.type, node.parameters) !== undefined;
      const fedByWire = edges.some((edge) => edge.target.nodeId === nodeId);
      expect(fedByReference || fedByWire, `${nodeId} must be fed`).toBe(true);
      // One loop, one truth: never both (the compiler refuses the ambiguity).
      expect(fedByReference && fedByWire).toBe(false);
      expect(edges.some((edge) => edge.source.nodeId === nodeId)).toBe(true);
    }
    expect(temporalNodes.size).toBeGreaterThan(0);
  });

  /** §V22: a ping-pong pair, declared in the plan as a pair rather than as two targets. */
  it("allocates a stable ping-pong pair for the temporal output", () => {
    for (const pair of plan.feedback) {
      const resource = plan.resources.find((entry) => entry.id === pair.resourceId);
      expect(resource?.kind, pair.resourceId).toBe("pingPong");
      expect(pair.resourceId).toBe(`pingpong:${pair.nodeId}:${pair.portId}`);
      // The output the graph sees is the pair, not a plain target.
      const output = plan.outputs.find(
        (entry) => entry.nodeId === pair.nodeId && entry.portId === pair.portId,
      );
      expect(output?.temporal, pair.resourceId).toBe(true);
    }
  });

  /**
   * §V22: the swap is encoded AFTER every current-frame consumer.
   *
   * Swapping early is the classic feedback bug and it does not look like a crash — it looks
   * like a loop that is one frame out, or that reads the half it is currently writing.
   */
  it("orders the swap after every pass that touches the pair", () => {
    for (const pair of plan.feedback) {
      const swapIndex = plan.passes.findIndex((pass) => pass.id === swapPassId(pair.resourceId));
      expect(swapIndex, `no swap pass for ${pair.resourceId}`).toBeGreaterThanOrEqual(0);

      const touches = plan.passes
        .map((pass, index) => ({ pass, index }))
        .filter(({ pass }) => {
          if (pass.kind !== "effect") return false;
          if (pass.target === pair.resourceId) return true;
          return (pass.textures ?? []).some((binding) => binding.resourceId === pair.resourceId);
        });

      expect(touches.length, `nothing uses ${pair.resourceId}`).toBeGreaterThan(0);
      for (const { pass, index } of touches) {
        expect(index, `${pass.id} is encoded after the swap`).toBeLessThan(swapIndex);
      }
    }
  });

  /**
   * §V22 / T143: history survives an unrelated structural edit.
   *
   * Rebuilding on a whole-plan hash would zero every feedback loop in the project whenever
   * anything at all was edited — which is the difference between a tool you can patch while
   * it runs and one you have to restart.
   */
  it("keeps the pair across an unrelated but reachable edit", () => {
    const edited = compile(document, withUnrelatedBranch(document.graph));

    // The edit has to actually be live, or this proves nothing: a pruned node never
    // reaches resource allocation, so the diff below would be trivially empty.
    expect(messagesOf(edited.diagnostics)).toEqual([]);
    expect(edited.pruned).toEqual([]);
    expect(edited.order).toContain("probe-level");
    expect(edited.order).toContain("probe-out");

    expect(feedbackToReset(plan, edited)).toEqual([]);
    for (const pair of plan.feedback) {
      const after = edited.feedback.find((entry) => entry.resourceId === pair.resourceId);
      expect(after?.resetSignature, pair.resourceId).toBe(pair.resetSignature);
      expect(diffPlans(plan, edited).resourcesToKeep).toContain(pair.resourceId);
    }
  });

  /**
   * The control case for the test above: a change the manifest DOES list in `resetOn`
   * really does reset. Without this, "nothing resets the pair" would also pass on a build
   * where resetting was simply broken.
   */
  it("does reset the pair when the resolution changes", () => {
    const resized = compileGraph({
      graph: document.graph,
      settings: {
        ...document.settings,
        outputResolution: {
          width: document.settings.outputResolution.width + 64,
          height: document.settings.outputResolution.height + 64,
        },
      },
      registry: exampleRegistry(),
      capabilities: TIER_B_CAPABILITIES,
    });

    const pairsThatMoved = plan.feedback.filter((pair) => {
      const after = resized.feedback.find((entry) => entry.resourceId === pair.resourceId);
      return after !== undefined && String(after.size) !== String(pair.size);
    });

    // An example may pin its pair to a fixed size (E2 does, deliberately), in which case a
    // project-resolution change legitimately leaves it alone. Only assert the reset for
    // pairs whose size actually followed the project.
    for (const pair of pairsThatMoved) {
      expect(feedbackToReset(plan, resized)).toContain(pair.resourceId);
    }
    expect(plan.feedback.length).toBeGreaterThan(0);
  });
});
