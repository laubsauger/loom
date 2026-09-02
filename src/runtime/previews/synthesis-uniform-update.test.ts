import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { classifyGraphChange } from "../../app/classify-revision.ts";
import { isUniformOnlyChange } from "../../compiler/recompile.ts";
import { SCENE_PAYLOAD_KINDS } from "../../domain/types/scene.ts";
import type { PreviewPayloadKind } from "../../compiler/preview-orbit.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createPreviewSystem } from "./system.ts";
import { DEFAULT_PREVIEW_VIEW } from "./types.ts";
import type { PreviewFrameCommand, PreviewProgram, PreviewRequest, PreviewRuntimeHost } from "./types.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { UniformValues } from "../backend/plan.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * §B176 — A UNIFORM-ONLY EDIT REACHES A SYNTHESIZED PREVIEW, WITHOUT REBUILDING IT
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's report: "material preview is sometimes not updating after we changed the
 * colour — shows up in the render output but its preview can stay stale."
 *
 * MEASURED, before the fix, on the graph below (a materialPhong worn by a rendered
 * geometry and previewed on its own node), red → green:
 *
 *   classification      uniform-update            (correct — §V5, no rebuild)
 *   main plan baseColor [1,0,0,1] → [0,1,0,1]     (the render output updates)
 *   synthesis baseColor [1,0,0,1] → [0,1,0,1]     (the compiler DOES produce the new value)
 *   preview push        NOTHING                   (the tile draws the previous compile)
 *
 * Three correct halves and no path between them. §V521 gives a synthesized preview its OWN
 * passes with their OWN uniforms, which the main plan does not carry — so
 * `backend.updateUniforms`, which resolves against the main program, cannot reach them. And
 * `PreviewProgram.signature` excludes uniform values by construction (§V5), so a uniform-only
 * edit reinstalls nothing either. The value had no door.
 *
 * ## Why "sometimes"
 *
 * A STRUCTURAL edit changes the signature, reinstalls the program, and uploads the current
 * descriptors — silently repairing the tile. So the bug is invisible whenever the next edit
 * happens to be structural, and the owner meets it only when they change a colour twice in
 * a row. That is also why it survived: every manual check that involved rewiring anything
 * passed.
 *
 * ## What these gates pin
 *
 *   1. COVERAGE — every uniform block a synthesized preview's passes declare arrives on the
 *      push seam, for every kind. Driven by `SCENE_PAYLOAD_KINDS` + `pointset`, which the
 *      type system keeps exhaustive, so kind N+1 fails here (§V437).
 *   2. THE EDIT — a uniform-only parameter change reaches the tile, and the classification
 *      is still `uniform-update` and the program is still not rebuilt while it does. Both
 *      halves together: a fix that repaired the picture by rebuilding would trade a stale
 *      tile for §T924's recompile storm, and gate 2b is what forbids it.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

function node(id: string, type: string, parameters: Record<string, unknown>, label: string): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label } as never;
}

function graphOf(nodes: GraphNode[], edges: Record<string, unknown> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges,
    groups: {},
  } as never;
}

/**
 * The edit as the STORE makes it. Immer keeps every untouched node's object identity, and
 * `classify-revision.ts` diffs by reference — two graphs built from scratch would come back
 * `topology` and the classification half of this gate would be measuring the fixture.
 */
function edited(graph: GraphDocument, nodeId: string, parameters: Record<string, unknown>): GraphDocument {
  return {
    ...graph,
    nodes: { ...graph.nodes, [nodeId]: { ...(graph.nodes[nodeId] as GraphNode), parameters } },
  } as never;
}

const compile = (graph: GraphDocument, nodeId: string) =>
  compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: [{ nodeId, portId: "out", kind: "preview" as const }],
  } as never);

type Compiled = ReturnType<typeof compile>;

/**
 * One previewable node per kind, plus the uniform-only edit that must reach its tile.
 *
 * `satisfies Record<PreviewPayloadKind, …>` is the coverage proof: `PreviewPayloadKind` is
 * `ScenePayloadKind | "pointset"`, and `ScenePayloadKind` is kept exhaustive against the
 * payload union — so a seventh synthesized kind does not COMPILE until someone states its
 * fixture here (§V437, the same rule `preview-orbit.ts`'s table is built on).
 */
interface KindFixture {
  readonly graph: GraphDocument;
  readonly nodeId: string;
  /**
   * The uniform-only parameter edit, and the block key it must move. `null` says NO document
   * parameter reaches this kind's block today — a claim the last test below proves, so it
   * cannot rot into an untested exemption.
   */
  readonly edit: { readonly parameters: Record<string, unknown>; readonly key: string } | null;
}

const GRID = node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1");
const GRID_EDGE = {
  e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
};

const FIXTURES = {
  camera: {
    graph: graphOf([node("cam", "camera", { eye: [4, 2, 7] }, "cam1")]),
    nodeId: "cam",
    // A camera tile draws through the payload's OWN matrix (§T561: not orbitable), so its
    // eye is the one value the picture is entirely about.
    edit: { parameters: { eye: [6, 2, 7] }, key: "viewProjection" },
  },
  light: {
    graph: graphOf([node("sun", "light", { intensity: 2 }, "sun1")]),
    nodeId: "sun",
    edit: { parameters: { intensity: 5 }, key: "light0Meta" },
  },
  projector: {
    graph: graphOf([node("proj", "projector", { throwRatio: 1.5 }, "proj1")]),
    nodeId: "proj",
    edit: { parameters: { throwRatio: 3 }, key: "viewProjection" },
  },
  material: {
    graph: graphOf([node("skin", "materialPhong", { color: [1, 0, 0, 1] }, "skin1")]),
    nodeId: "skin",
    // THE OWNER'S OWN CASE, red → green.
    edit: { parameters: { color: [0, 1, 0, 1] }, key: "baseColor" },
  },
  geometry: {
    graph: graphOf([GRID, node("geo", "geometry", { mode: "surface", tint: [1, 0, 0, 1] }, "geo1")], GRID_EDGE),
    nodeId: "geo",
    edit: { parameters: { mode: "surface", tint: [0, 1, 0, 1] }, key: "baseColor" },
  },
  pointset: {
    graph: graphOf([node("torus", "pointTorus", { radius: 0.7 }, "torus1")]),
    nodeId: "torus",
    // MEASURED, not assumed: a splat's block is `viewProjection` + `pointSize`, and both are
    // owned by the RUNTIME — the stock rig (§T373) and the granted tile (§T952). No document
    // parameter reaches it, so there is no uniform-only edit to make. The claim is proved
    // below rather than left as a comment, because "this kind has no case" is exactly the
    // shape §T532 shipped for months.
    edit: null,
  },
} satisfies Record<PreviewPayloadKind, KindFixture>;

const ALL_KINDS: ReadonlyArray<PreviewPayloadKind> = [...SCENE_PAYLOAD_KINDS, "pointset"];
const EDITABLE_KINDS = ALL_KINDS.filter((kind) => FIXTURES[kind].edit !== null);

const SURFACE = { x: 0, y: 0, width: 800, height: 600 };
function frame(index: number): FrameEvaluationInput {
  return { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "realtime", randomSeed: 1 };
}

interface FakeHost extends PreviewRuntimeHost {
  readonly programs: PreviewProgram[];
  readonly commands: PreviewFrameCommand[];
}

function fakeHost(): FakeHost {
  const programs: PreviewProgram[] = [];
  const commands: PreviewFrameCommand[] = [];
  return {
    programs,
    commands,
    setPreviewProgram(program) {
      programs.push(program);
    },
    presentPreviews(command) {
      commands.push(command);
    },
  };
}

/** The synthesized output row this compile produced for the previewed node. */
function synthesizedRow(compiled: Compiled, nodeId: string) {
  const row = compiled.outputs.find((output) => output.nodeId === nodeId && output.synthesis !== undefined);
  if (row?.synthesis === undefined) throw new Error(`no synthesized preview row for "${nodeId}"`);
  return row;
}

function requestFor(compiled: Compiled, nodeId: string): PreviewRequest {
  const row = synthesizedRow(compiled, nodeId);
  return {
    ref: { nodeId, portId: "out" },
    source: {
      resourceId: row.resourceId,
      size: row.size as readonly [number, number],
      format: row.format as never,
      space: (row as { space?: string }).space as never,
    },
    rect: { x: 10, y: 10, width: 192, height: 108 },
    area: { width: 192, height: 108 },
    visible: true,
    pinned: false,
    collapsed: false,
    occluded: false,
    view: DEFAULT_PREVIEW_VIEW,
    synthesis: row.synthesis as never,
  } as PreviewRequest;
}

/** Runs the system over a sequence of requests, one display frame each. */
function drive(requests: ReadonlyArray<PreviewRequest>): FakeHost {
  const host = fakeHost();
  const system = createPreviewSystem({ host, capacity: 8 });
  requests.forEach((request, index) => {
    system.update({
      requests: [request],
      frame: frame(index),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
  });
  return host;
}

/** Every value pushed for `passId`, in command order. */
const pushesTo = (host: FakeHost, passId: string): UniformValues[] =>
  host.commands.flatMap((command) => (command.uniforms ?? []).filter((u) => u.passId === passId).map((u) => u.values));

describe("§B176 — a synthesized preview's own uniforms reach the GPU", () => {
  /**
   * GATE 1 — COVERAGE, over the exhaustive kind list.
   *
   * The claim is structural on purpose, and it is deliberately NOT "the pushed value equals
   * the descriptor value": recomputing the expected block here would just be a second copy
   * of `plan()`'s arithmetic agreeing with the first. What it asserts is that every block the
   * compiler declared has a DOOR — every synthesis pass carrying uniforms is pushed, and every
   * key of its block is in the push. Gate 2 is what proves the value tracks an edit.
   */
  it.each(ALL_KINDS)("%s — every synthesis uniform block reaches the push seam", (kind) => {
    const fixture = FIXTURES[kind];
    const compiled = compile(fixture.graph, fixture.nodeId);
    expect([kind, compiled.diagnostics.filter((entry) => entry.severity === "error")]).toEqual([kind, []]);

    const passes = synthesizedRow(compiled, fixture.nodeId).synthesis?.passes ?? [];
    const withUniforms = passes.filter((pass) => Object.keys(pass.uniforms ?? {}).length > 0);
    // NON-VACUITY: a kind whose passes declared no uniforms would satisfy the loop below by
    // having nothing to check, which is the one way a coverage gate can pass by being empty.
    expect([kind, withUniforms.length > 0]).toEqual([kind, true]);

    const host = drive([requestFor(compiled, fixture.nodeId)]);
    for (const pass of withUniforms) {
      const pushed = pushesTo(host, pass.id)[0];
      expect([kind, pass.id, pushed !== undefined]).toEqual([kind, pass.id, true]);
      const missing = Object.keys(pass.uniforms ?? {}).filter((key) => !(key in (pushed ?? {})));
      expect([kind, pass.id, missing]).toEqual([kind, pass.id, []]);
    }
  });

  /**
   * GATE 2a — THE EDIT ARRIVES. The bug itself, per kind.
   */
  it.each(EDITABLE_KINDS)("%s — a uniform-only edit reaches the tile", (kind) => {
    const fixture = FIXTURES[kind];
    const edit = fixture.edit;
    if (edit === null) throw new Error("EDITABLE_KINDS filtered this");

    const before = compile(fixture.graph, fixture.nodeId);
    const afterGraph = edited(fixture.graph, fixture.nodeId, edit.parameters);
    const after = compile(afterGraph, fixture.nodeId);

    const blockOf = (compiled: Compiled) => {
      const pass = (synthesizedRow(compiled, fixture.nodeId).synthesis?.passes ?? []).find(
        (entry) => edit.key in (entry.uniforms ?? {}),
      );
      if (pass === undefined) throw new Error(`no synthesis pass carries "${edit.key}" for ${kind}`);
      return { passId: pass.id, value: pass.uniforms?.[edit.key] };
    };
    const compiledBefore = blockOf(before);
    const compiledAfter = blockOf(after);
    // THE FIXTURE IS DISTINGUISHING (§V461): an edit the compiler ignores would make the
    // assertion below pass on the stale value, which is the bug reported as a fix.
    expect([kind, compiledBefore.value]).not.toEqual([kind, compiledAfter.value]);

    // Two ticks on the old value, then the edit lands. The second old tick matters: the push
    // is deduplicated, so a seam that only ever pushed on the FIRST tick of a program would
    // pass a one-tick fixture.
    const host = drive([
      requestFor(before, fixture.nodeId),
      requestFor(before, fixture.nodeId),
      requestFor(after, fixture.nodeId),
    ]);

    const pushed = pushesTo(host, compiledAfter.passId);
    expect([kind, pushed.at(-1)?.[edit.key]]).toEqual([kind, compiledAfter.value]);
    // And it refreshes THIS tick rather than waiting for the next due one — at 15 fps a
    // colour that repainted a tick later would read as a dead control (B118's argument).
    expect([kind, host.commands.at(-1)?.refresh.includes(compiledAfter.passId)]).toEqual([kind, true]);
  });

  /**
   * GATE 2b — AND IT IS STILL A UNIFORM UPDATE.
   *
   * The half that forbids the cheap wrong fix. Repainting the tile by forcing a rebuild on
   * every parameter edit would satisfy 2a and trade a stale picture for §T924's recompile
   * storm — 13 recompiles per pan, measured. So: the classifier still says `uniform-update`,
   * the two plans are still signature-identical, and the preview program is installed ONCE
   * across the edit.
   */
  it.each(EDITABLE_KINDS)("%s — and the edit is still uniform-update, with no rebuild (§V5, §T924)", (kind) => {
    const fixture = FIXTURES[kind];
    const edit = fixture.edit;
    if (edit === null) throw new Error("EDITABLE_KINDS filtered this");

    const afterGraph = edited(fixture.graph, fixture.nodeId, edit.parameters);
    const decision = classifyGraphChange(
      { identity: "doc", graph: fixture.graph },
      { identity: "doc", graph: afterGraph },
      registry,
    );
    expect([kind, decision.work]).toEqual([kind, "uniform-update"]);

    const before = compile(fixture.graph, fixture.nodeId);
    const after = compile(afterGraph, fixture.nodeId);
    expect([kind, isUniformOnlyChange(before as never, after as never)]).toEqual([kind, true]);

    const host = drive([
      requestFor(before, fixture.nodeId),
      requestFor(before, fixture.nodeId),
      requestFor(after, fixture.nodeId),
    ]);
    expect([kind, host.programs.length]).toEqual([kind, 1]);
  });

  /**
   * The pointset entry's `null` is a MEASUREMENT, and this is the measurement.
   *
   * A splat's block is exactly the two values the runtime owns — the stock rig's matrix
   * (§T373, moved by the inspection orbit, never by the document) and the disc restated
   * against the granted tile (§T952). The day a splat gains a parameter-fed uniform this
   * fails, and `FIXTURES.pointset.edit` has to stop being `null`.
   */
  it("pointset — the exemption is measured: its block is runtime-owned, not document-owned", () => {
    const fixture = FIXTURES.pointset;
    const compiled = compile(fixture.graph, fixture.nodeId);
    const passes = synthesizedRow(compiled, fixture.nodeId).synthesis?.passes ?? [];
    expect(passes.map((pass) => Object.keys(pass.uniforms ?? {}).sort())).toEqual([
      ["pointSize", "viewProjection"],
    ]);
  });

  /**
   * THE COMPONENT-INSTANCE BLIND SPOT, asked of THIS seam (§B177's question, §T903's family).
   *
   * Three defects in a row have been "a thing keyed on NODES does not see through the instance
   * boundary" — §T903 (a reflecting node inside a component lost its keys), §T969 (the layout
   * gate never iterated component internals), §B177 (an instance's point output previews as no
   * signal). The fair question is whether this fix is the fourth.
   *
   * It is not, and this proves it rather than arguing it. The push is keyed on the pass
   * descriptors the request carries and on the program built from them — it never reads a node
   * id, never splits one, and never consults the document. So a synthesized preview whose ids
   * are flatten's `${instance}/${inner}` shape is covered by the same code path, which is what
   * this drives: a REAL flattened component instance, through the real compiler.
   *
   * (§B177 itself lives upstream of here and is NOT fixed by this: measured on `depthPoints`,
   * a preview sink on the instance's Out boundary node `c1/out_out` compiles to a bare pointset
   * MARKER while the synthesis lands on `c1/paint` — the node that actually produces the
   * points. The request asks for the boundary node's row and finds nothing to draw. That is a
   * sink-resolution defect in the compiler and in §T601's `componentPreviewTarget`, not a
   * missing push.)
   */
  it("reaches a preview belonging to a COMPONENT INSTANCE — the ids are flatten's, not a node's", async () => {
    const { flattenComponents } = await import("../../compiler/flatten.ts");
    const { componentNodeType, createComponentSystem } = await import("../../domain/components/index.ts");
    const definition = {
      componentId: "b176Points",
      version: 1,
      name: "B176 Points",
      description: "A point generator behind a component boundary — the smallest instance that previews.",
      graph: {
        revision: 1,
        nodes: {
          grid: node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
          out_out: node("out_out", "componentOutPoints", {}, "out1"),
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "out_out", portId: "in" } },
        },
        groups: {},
      },
      inputs: [],
      outputs: [{ externalId: "out", label: "out", nodeId: "out_out", portId: "out" }],
      parameters: [],
    } as never;

    const system = createComponentSystem(registry, [definition]);
    const document = graphOf([
      node("c1", componentNodeType("b176Points", 1), {}, "c1") as never as GraphNode,
    ]);
    const flat = flattenComponents({
      graph: document,
      registry: system.nodes,
      components: system.components.view(),
    } as never);
    expect(flat.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    const compiled = compileGraph({
      graph: flat.graph,
      settings: SETTINGS,
      registry: system.nodes,
      capabilities: CAPABILITIES,
      // §T601: an instance has no row of its own, so its preview names an INNER flat node.
      sinks: [{ nodeId: "c1/grid", portId: "out", kind: "preview" as const }],
    } as never) as Compiled;
    expect(compiled.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    const row = synthesizedRow(compiled, "c1/grid");
    const passes = row.synthesis?.passes ?? [];
    // THE FIXTURE IS THE INSTANCE ONE (§V461): a pass id without the `c1/` prefix would be a
    // bare node's preview wearing this test's name, and would prove nothing about the boundary.
    expect(passes.map((pass) => pass.id)).toEqual(["c1/grid#pointsPreview:out"]);

    const host = drive([requestFor(compiled, "c1/grid")]);
    for (const pass of passes) {
      const pushed = pushesTo(host, pass.id)[0];
      const missing = Object.keys(pass.uniforms ?? {}).filter((key) => !(key in (pushed ?? {})));
      expect([pass.id, missing]).toEqual([pass.id, []]);
    }
  });
});
