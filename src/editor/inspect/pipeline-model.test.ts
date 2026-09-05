import { describe, expect, it } from "vitest";
import { compileGraph } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphDocument, ProjectSettings } from "@domain/types/graph.ts";
import { buildPipelineView } from "./pipeline-model.ts";
import type { PipelineFindingKind, PipelineView } from "./pipeline-model.ts";

/**
 * The pipeline inspector, against the REAL compiler and the REAL node definitions
 * (T1188, §B179, §V285).
 *
 * ## Why nothing here is a fixture plan
 *
 * A test that hands this model a hand-written plan and asserts the screen names its
 * passes proves that a loop renders. The claims worth making are about what the COMPILER
 * decides, and the only thing that knows those is the compiler: so every document below
 * is compiled for real, and each one is built so that ONE decision is known in advance —
 * a branch that must be pruned, a format that must change, a loop the compiler must close
 * itself — and the assertion is that the screen says so, in words.
 *
 * ## §B179's trap has its own document
 *
 * `plan.pruned` is `computeLiveness().dead`, which filters value sources out by
 * construction. So a document can report `pruned: []` while a node sits outside the
 * running plan, and reading that field as "nothing was pruned" cost this project a
 * session. `off-plan node with an empty plan.pruned` below asserts both halves at once:
 * the compiler really does report an empty `pruned`, AND the screen still says the node
 * is not running.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 256, height: 128 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function compile(graph: GraphDocument): CompiledGraph {
  return compileGraph({ graph, settings, registry, capabilities });
}

/** Compiles, installs, and builds the view — the normal, in-sync case. */
function viewOf(graph: GraphDocument): PipelineView {
  const plan = compile(graph);
  return buildPipelineView({ installed: plan, compiled: plan, graph, registry });
}

function finding(view: PipelineView, kind: PipelineFindingKind) {
  const found = view.findings.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} finding on the screen`);
  return found;
}

/** Every sentence the screen would show for one finding — headline first. */
function saidAbout(view: PipelineView, kind: PipelineFindingKind): string {
  const entry = finding(view, kind);
  return [entry.summary, ...entry.rows.map((row) => row.text)].join("\n");
}

/** Solid → Blur → Output. The chain every document below is built on. */
function chain(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "solid" },
      blur: { id: "blur", type: "blur", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {}, label: "blur" },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {}, label: "out" },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "blur", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "blur", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

describe("T1188 — the pipeline inspector describes the plan the backend INSTALLED", () => {
  /**
   * §B179 and §T1163 in one assertion. The app held a plan the backend never installed
   * while the frame counter advanced and nothing said so; a screen that read
   * `compile.compiled` would repeat that lie in the one situation it is opened in.
   */
  it("describes the installed plan and SAYS SO when the current graph does not compile", () => {
    const good = chain();
    const installed = compile(good);
    expect(installed.ok).toBe(true);

    // The edit that breaks it: Blur's required input disconnected, and a preview sink on
    // the now-dangling node — the shape §B179 measured.
    const broken: GraphDocument = { ...good, revision: 2, edges: { e2: good.edges["e2"]! } };
    const refused = compileGraph({
      graph: broken,
      settings,
      registry,
      capabilities,
      sinks: [{ nodeId: "blur", kind: "preview" }],
    });
    expect(refused.ok).toBe(false);

    const view = buildPipelineView({ installed, compiled: refused, graph: broken, registry });

    expect(view.install.kind).toBe("refused");
    expect(view.install.diverged).toBe(true);
    expect(view.install.headline).toBe("Running an older pipeline");
    expect(view.install.detail).toContain("NOT on screen");
    // And what it describes is the plan the GPU holds — the one with the blur pass in it.
    expect(view.stats?.signature).toBe(installed.signature);
    expect(view.passes.map((pass) => pass.nodeId)).toContain("blur");
  });

  it("says a newer clean plan has not landed yet, rather than describing it", () => {
    const first = chain();
    const installed = compile(first);
    const edited: GraphDocument = {
      ...first,
      revision: 2,
      nodes: {
        ...first.nodes,
        // STRUCTURAL, not a uniform value: §V5 keeps parameter VALUES out of the
        // signature entirely, so a radius drag would leave the two plans identical.
        blur: { ...first.nodes["blur"]!, resolution: { mode: "fixed", width: 64, height: 32 } },
      },
    };
    const next = compile(edited);
    expect(next.ok).toBe(true);
    expect(next.signature).not.toBe(installed.signature);

    const view = buildPipelineView({ installed, compiled: next, graph: edited, registry });
    expect(view.install.kind).toBe("waiting");
    expect(view.stats?.signature).toBe(installed.signature);
  });

  it("has nothing to describe when the backend holds no program, and says that too", () => {
    const graph = chain();
    const view = buildPipelineView({ installed: null, compiled: compile(graph), graph, registry });
    expect(view.install.kind).toBe("none");
    expect(view.stats).toBeNull();
    expect(view.passes).toEqual([]);
  });
});

describe("T1188 — reachability, and §B179's `pruned` trap", () => {
  it("names a branch no sink reaches as unreachable", () => {
    const graph = chain();
    graph.nodes["orphan"] = {
      id: "orphan",
      type: "noise",
      definitionVersion: 1,
      position: { x: 0, y: 200 },
      parameters: {},
      label: "orphan",
    };
    const plan = compile(graph);
    // The premise, asserted rather than assumed: the compiler really did call it dead.
    expect(plan.pruned).toContain("orphan");

    const view = buildPipelineView({ installed: plan, compiled: plan, graph, registry });
    const said = saidAbout(view, "reachability");
    expect(said).toContain("1 of 4 nodes are NOT in the running pipeline — 1 unreachable, 0 off-plan");
    expect(said).toContain("orphan — unreachable: no active sink reaches it");
    expect(finding(view, "reachability").rows).toHaveLength(1);
  });

  /**
   * THE ONE THIS FILE EXISTS FOR. `pruned` comes back EMPTY here — a value source is
   * filtered out of `computeLiveness().dead` by construction — while the node is not in
   * the plan at all. A screen that rendered `plan.pruned` would show an empty list and
   * an unqualified "nothing was pruned"; this one counts the rows it is about to draw.
   */
  it("reports an off-plan node even though the compiler's `pruned` list is EMPTY", () => {
    const graph = chain();
    graph.nodes["knob"] = {
      id: "knob",
      type: "constant",
      definitionVersion: 1,
      position: { x: 0, y: 300 },
      parameters: {},
      label: "knob",
    };
    const plan = compile(graph);
    // The trap, measured: the field a naive screen would read says nothing was pruned…
    expect(plan.pruned).toEqual([]);
    // …while the node is genuinely absent from what runs.
    expect(plan.order).not.toContain("knob");

    const view = buildPipelineView({ installed: plan, compiled: plan, graph, registry });
    const said = saidAbout(view, "reachability");
    expect(said).toContain("1 of 4 nodes are NOT in the running pipeline");
    expect(said).toContain("0 unreachable, 1 off-plan");
    expect(said).toContain("knob — off-plan by design: a value source feeds parameters");
  });

  it("says every node runs when every node runs", () => {
    const view = viewOf(chain());
    expect(finding(view, "reachability").summary).toBe("All 3 nodes are in the running pipeline.");
    expect(finding(view, "reachability").rows).toEqual([]);
  });
});

describe("T1188 — the decisions the compiler made", () => {
  it("names the pass where the pixel format changes mid-chain", () => {
    const graph = chain();
    // §V51: a per-node override beats the project's working format. The chain now goes
    // rgba16float → rgba8unorm → rgba16float, and both moves are real.
    graph.nodes["blur"] = { ...graph.nodes["blur"]!, format: { mode: "fixed", format: "rgba8unorm" } };
    const plan = compile(graph);
    expect(plan.outputs.find((output) => output.nodeId === "blur")?.format).toBe("rgba8unorm");

    const view = buildPipelineView({ installed: plan, compiled: plan, graph, registry });
    const said = saidAbout(view, "format");
    expect(said).toContain("change");
    expect(said).toContain("blur — reads rgba16float, writes rgba8unorm.");
  });

  it("says nothing changes format when nothing does", () => {
    const view = viewOf(chain());
    expect(finding(view, "format").summary).toBe("Every pass writes at the format it reads.");
  });

  it("names the pass where the resolution changes mid-chain", () => {
    const graph = chain();
    graph.nodes["blur"] = {
      ...graph.nodes["blur"]!,
      resolution: { mode: "fixed", width: 64, height: 32 },
    };
    const plan = compile(graph);
    expect(plan.outputs.find((output) => output.nodeId === "blur")?.size).toEqual([64, 32]);

    const view = buildPipelineView({ installed: plan, compiled: plan, graph, registry });
    const said = saidAbout(view, "resolution");
    expect(said).toContain("blur — reads 256x128, writes 64x32.");
    // And the way BACK up, which is the half a user notices as softness: Output
    // resamples the 64x32 blur to the project resolution.
    expect(said).toContain("out — reads 64x32, writes 256x128.");
  });

  /**
   * §V285 — the document keeps a DAG and the compiler synthesizes the closing edge, so
   * the graph that runs is genuinely not the graph on the canvas. Nothing else in the
   * product says this out loud, and it is the single most explanatory sentence this
   * screen can produce.
   */
  it("names the temporal loop the compiler closed, and that it closed it ITSELF", () => {
    const graph: GraphDocument = {
      revision: 1,
      nodes: {
        solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "solid" },
        mix: { id: "mix", type: "cross", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {}, label: "mix" },
        fb: {
          id: "fb",
          type: "feedback",
          definitionVersion: 1,
          position: { x: 200, y: 200 },
          parameters: { source: "mix" },
          label: "fb",
        },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {}, label: "out" },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "mix", portId: "in1" } },
        e2: { id: "e2", source: { nodeId: "fb", portId: "out" }, target: { nodeId: "mix", portId: "in2" } },
        e3: { id: "e3", source: { nodeId: "mix", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    };
    const plan = compile(graph);
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    // The premise: the compiler backed the feedback output with a ping-pong pair.
    expect(plan.feedback.map((pair) => pair.nodeId)).toEqual(["fb"]);
    // And the closing edge is NOT in the document — that is what §V285 means.
    expect(
      Object.values(graph.edges).some(
        (edge) => edge.source.nodeId === "mix" && edge.target.nodeId === "fb",
      ),
    ).toBe(false);

    const view = buildPipelineView({ installed: plan, compiled: plan, graph, registry });
    const said = saidAbout(view, "temporal");
    expect(said).toContain("the graph that runs is not the DAG on the canvas");
    expect(said).toContain("records mix");
    expect(said).toContain("the compiler SYNTHESIZED the closing edge");
    // The swap pass it names is a pass the encoder really runs.
    expect(view.passes.some((pass) => pass.kind === "swap")).toBe(true);
  });

  it("says no output carries a previous frame when none does", () => {
    const view = viewOf(chain());
    expect(finding(view, "temporal").summary).toBe(
      "No output in this plan carries a previous frame.",
    );
  });

  it("lists the flow in encode order, one row per pass", () => {
    const view = viewOf(chain());
    expect(view.passes.map((pass) => pass.step)).toEqual(
      view.passes.map((_pass, index) => index + 1),
    );
    expect(view.passes.map((pass) => pass.nodeId)).toContain("blur");
    expect(view.stats?.passes).toBe(view.passes.length);
  });
});
