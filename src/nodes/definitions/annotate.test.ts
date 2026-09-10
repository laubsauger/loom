import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import { loadProject } from "../../domain/project/index.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { listExamples } from "../../examples/catalogue.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import {
  ANNOTATE_TYPE,
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  annotateNode,
  annotationColorOf,
} from "./annotate.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * T1262 — the annotation box is a node the COMPILER NEVER SEES.
 *
 * The design's whole bet is that a portless definition gets persistence, undo, selection
 * and the agent surface for free (§V29) while costing the render nothing. The second half
 * is a claim about `compileGraph`, so it is measured against a real shipped document —
 * E24, the capstone — the way the app compiles it (components flattened, T790): the plan
 * with one annotation dropped in must carry the same signature, the same passes and the
 * same outputs as the plan without it, and the compiler must say nothing about the box
 * beyond listing it as pruned.
 */

const E24 = "E24-Audio-Reaction-Diffusion.loom.json";

/** Tier B, the same capabilities the example runner compiles under. */
const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function loadE24(): { graph: GraphDocument; settings: Parameters<typeof compileGraph>[0]["settings"]; system: ReturnType<typeof createComponentSystem> } {
  const file = listExamples().find((example) => example.fileName === E24);
  if (file === undefined) throw new Error(`${E24} is not in the shipped examples`);
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const loaded = loadProject(file.text, { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`${E24} did not load: ${loaded.reason}`);
  for (const definition of loaded.components) system.components.register(definition);
  return { graph: loaded.document.graph, settings: loaded.document.settings, system };
}

function compileWith(graph: GraphDocument, loaded: ReturnType<typeof loadE24>) {
  return compileGraph({
    graph,
    settings: loaded.settings,
    registry: loaded.system.nodes,
    capabilities,
    components: loaded.system.components.view(),
  });
}

describe("annotate — a node outside the plan by construction (T1262)", () => {
  it("has no ports, no sink and no passes", () => {
    expect(annotateNode.inputs).toEqual([]);
    expect(annotateNode.outputs).toEqual([]);
    expect(annotateNode.sink).toBeUndefined();
    expect(annotateNode.compile({} as never)).toEqual({ passes: [] });
  });

  it("compiles E24 to the SAME plan with and without an annotation", () => {
    const loaded = loadE24();
    const bare = compileWith(loaded.graph, loaded);
    expect(bare.ok).toBe(true);

    const annotated: GraphDocument = {
      ...loaded.graph,
      nodes: {
        ...loaded.graph.nodes,
        note: {
          id: "note",
          type: ANNOTATE_TYPE,
          definitionVersion: annotateNode.version,
          position: { x: -400, y: -300 },
          size: { width: 900, height: 600 },
          parameters: { title: "Chemistry", body: "Gray-Scott plate\nseeded on onsets", color: "filter" },
        },
      },
    };
    const withNote = compileWith(annotated, loaded);

    // The consumer-facing plan: byte-identical. `signature` is what the renderer rebuilds
    // on, so equality here is "the GPU never learns the box exists".
    expect(withNote.signature).toBe(bare.signature);
    expect(withNote.passes).toEqual(bare.passes);
    expect(withNote.outputs).toEqual(bare.outputs);
    expect(withNote.order).toEqual(bare.order);
    expect(withNote.ok).toBe(true);

    // The compiler's ONLY word on it is the prune report — no diagnostic names the box.
    expect(withNote.pruned).toContain("note");
    expect(bare.pruned).not.toContain("note");
    const aboutNote = withNote.diagnostics.filter((d) => d.nodeId === "note");
    expect(aboutNote).toEqual([]);
    expect(withNote.diagnostics.map((d) => `${d.severity}:${d.code}`)).toEqual(
      bare.diagnostics.map((d) => `${d.severity}:${d.code}`),
    );
  });

  it("offers exactly the token palette, and falls back to the default for anything else", () => {
    const tokens = readFileSync(new URL("../../ui/tokens.css", import.meta.url), "utf8");
    const declared = new Set([...tokens.matchAll(/--category-([a-z]+):/g)].map((m) => m[1]));
    const offered = ANNOTATION_COLORS.map((option) => option.value);
    // Both directions: every option paints, and every hue the stylesheet names is offered.
    expect(new Set(offered)).toEqual(declared);
    expect(offered).toHaveLength(new Set(offered).size);
    expect(annotateNode.parameters["color"]).toMatchObject({
      type: "enum",
      default: DEFAULT_ANNOTATION_COLOR,
      options: ANNOTATION_COLORS,
    });
    expect(annotationColorOf("points")).toBe("points");
    expect(annotationColorOf("#ff0000")).toBe(DEFAULT_ANNOTATION_COLOR);
    expect(annotationColorOf(undefined)).toBe(DEFAULT_ANNOTATION_COLOR);
  });

  it("declares its body as the inspector's multiline string", () => {
    expect(annotateNode.parameters["body"]).toMatchObject({ type: "string", multiline: true });
    expect(annotateNode.parameters["title"]).toMatchObject({ type: "string" });
  });
});
