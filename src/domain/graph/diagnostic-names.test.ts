import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { GraphDocument } from "../types/graph.ts";
import { humanizeDiagnosticText, humanizeDiagnostics, nodeDisplayName } from "./diagnostic-names.ts";

/**
 * T599 — a rendered diagnostic names nodes the way every other surface does.
 *
 * `Node "nd_708afe2424b91"` is a receipt: an id the user never typed, cannot search
 * for, and that no other surface shows — the header, the wires and the inspector all
 * say `blur1`. The fix is ONE boundary (`use-graph-compile` and the app's problems
 * assembly pass every UI-bound diagnostic through here), not a 90-site sweep the next
 * site un-does. The GATE at the bottom is the §V437 half: it drives the real compiler
 * over a graph with minted-style ids and asserts no quoted minted id survives into the
 * humanized list — the next diagnostic site that interpolates an id is covered on the
 * day it lands, because it lands inside the same boundary.
 */

const GRAPH = {
  revision: 1,
  nodes: {
    nd_708afe2424b91: {
      id: "nd_708afe2424b91",
      type: "blur",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {},
      label: "blur1",
    },
    nd_plain: {
      id: "nd_plain",
      type: "noise",
      definitionVersion: 1,
      position: { x: 0, y: 0 },
      parameters: {},
    },
  },
  edges: {},
  groups: {},
} as never as GraphDocument;

describe("diagnostic node names (T599)", () => {
  it("replaces a quoted node id with the node's label, and only quoted occurrences", () => {
    expect(humanizeDiagnosticText('Node "nd_708afe2424b91" emitted no passes.', GRAPH)).toBe(
      'Node "blur1" emitted no passes.',
    );
    // Unquoted: left alone — an id inside a resource path or code stays a receipt.
    expect(humanizeDiagnosticText("target:nd_708afe2424b91:out is unknown.", GRAPH)).toBe(
      "target:nd_708afe2424b91:out is unknown.",
    );
    // A node with no label has no better name to offer.
    expect(humanizeDiagnosticText('Node "nd_plain" is odd.', GRAPH)).toBe('Node "nd_plain" is odd.');
    // An id that names no node in this document is not rewritten.
    expect(humanizeDiagnosticText('Node "nd_gone" is odd.', GRAPH)).toBe('Node "nd_gone" is odd.');
  });

  it("display name is the label, else the id", () => {
    expect(nodeDisplayName(GRAPH, "nd_708afe2424b91" as never)).toBe("blur1");
    expect(nodeDisplayName(GRAPH, "nd_plain" as never)).toBe("nd_plain");
  });

  it("rewrites message AND suggestion, preserving identity when nothing changes", () => {
    const untouched = [
      { severity: "warning" as const, code: "x", message: "nothing quoted here" },
    ];
    expect(humanizeDiagnostics(untouched, GRAPH)).toBe(untouched);

    const rewritten = humanizeDiagnostics(
      [
        {
          severity: "error" as const,
          code: "x",
          message: 'Node "nd_708afe2424b91" broke.',
          suggestion: 'Check "nd_708afe2424b91" upstream.',
        },
      ],
      GRAPH,
    );
    expect(rewritten[0]?.message).toBe('Node "blur1" broke.');
    expect(rewritten[0]?.suggestion).toBe('Check "blur1" upstream.');
  });

  /**
   * THE GATE: real compiler, minted-style ids, labels present — after the boundary, no
   * quoted minted id of a LABELED node survives in any rendered message or suggestion.
   * The fixture provokes real diagnostics (a blur with its required input unwired), so
   * the assertion sweeps whatever the compiler says today and whatever it adds tomorrow.
   */
  it("no rendered diagnostic quotes a raw minted id when the node has a name", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const compiled = compileGraph({
      graph: GRAPH,
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
      sinks: [{ nodeId: "nd_708afe2424b91", portId: "out", kind: "preview" }],
    } as never);

    // Non-vacuous: the raw compile really does quote the minted id somewhere.
    const raw = compiled.diagnostics.map((entry) => `${entry.message} ${entry.suggestion ?? ""}`);
    expect(raw.some((text) => text.includes('"nd_708afe2424b91"'))).toBe(true);

    const humanized = humanizeDiagnostics(compiled.diagnostics, GRAPH);
    for (const entry of humanized) {
      const text = `${entry.message} ${entry.suggestion ?? ""}`;
      expect(text, text).not.toContain('"nd_708afe2424b91"');
    }
    expect(humanized.some((entry) => entry.message.includes('"blur1"'))).toBe(true);
  });
});
