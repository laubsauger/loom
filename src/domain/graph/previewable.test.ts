import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PREVIEWABLE_PORT_KINDS, previewablePort } from "./previewable.ts";
import { nodeHasPreview } from "./node-box.ts";
import { SCENE_PAYLOAD_KINDS } from "../types/scene.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { previewCandidates } from "../../app/use-node-previews.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";

/**
 * ONE LIST OF PREVIEWABLE KINDS, AND NOBODY KEEPS A PRIVATE COPY (T532, §V437).
 *
 * A preview needs four independent places to agree — the slot that renders it, the
 * candidate list that requests it, the compiler that draws it, and the layout model that
 * makes room for it. Each had its own enumeration of kinds, and the failure mode is not
 * a wrong picture, it is NO picture and no error:
 *
 *  - B65: T373 built the entire pointset splat path and it fed a slot `node-view.tsx`
 *    never created, because that copy of the list knew three kinds and a pointset was a
 *    fourth. Every suite in the chain was green; each had been handed the wiring it was
 *    testing.
 *  - T532: the same gap one kind further along. `scene` (a geometry) was missing from ALL
 *    FOUR, so writing the compiler's geometry variant alone would have changed nothing on
 *    screen — B65 verbatim, eighteen months later.
 *
 * So the assertions below are about the SOURCE as much as the behaviour: a site that
 * re-derives the kinds locally is the bug, whether or not today's list happens to match.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");
const registry = createNodeRegistry(allNodeDefinitions).view();

/** The three product sites that decide whether a node previews. */
const SITES = [
  "app/use-node-previews.ts",
  "editor/nodes/node-view.tsx",
  "domain/graph/node-box.ts",
] as const;

describe("every site reads the same previewable-kind list", () => {
  it("no site enumerates preview port kinds of its own", () => {
    // The kinds only a preview cares about. A site naming one of these in a port-kind
    // comparison is re-deriving the list — which is exactly how `scene` went missing from
    // four places at once. `texture2d` is deliberately absent: it is the ordinary port
    // kind and these files legitimately reason about textures for other reasons.
    const previewOnly = ["pointset", "camera", "light", '"scene"'] as const;
    const offenders: string[] = [];
    for (const site of SITES) {
      const source = readFileSync(resolve(SRC, site), "utf8");
      // Strip block comments: the files EXPLAIN the history above, and the explanation
      // naming a kind is the opposite of the defect.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const kind of previewOnly) {
        const token = kind.startsWith('"') ? kind : `"${kind}"`;
        if (code.includes(`type.kind === ${token}`) || code.includes(`kind === ${token}`)) {
          offenders.push(`${site} compares a port kind against ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // NOT VACUOUS: the scan reaches real files with real code in them.
    for (const site of SITES) {
      expect([site, readFileSync(resolve(SRC, site), "utf8").length > 1000]).toEqual([site, true]);
    }
  });

  it("the slot, the candidate list and the layout model agree on every shipped node", () => {
    const disagreements: string[] = [];
    for (const definition of allNodeDefinitions) {
      const node = {
        id: "n1",
        type: definition.type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      } as GraphNode;
      const graph: GraphDocument = { revision: 1, nodes: { n1: node }, edges: {}, groups: {} };
      const isCandidate = previewCandidates(graph, registry).some((entry) => entry.nodeId === "n1");
      const modelled = nodeHasPreview(node, definition);
      const fromPorts = previewablePort(definition.outputs) !== undefined;
      // A previewable OUTPUT must reach both the candidate list and the layout model.
      // (The converse does not hold: value nodes and declared sinks preview for reasons
      // that are not a port kind, and each is gated on its own declared capability.)
      if (fromPorts && !isCandidate) disagreements.push(`${definition.type}: previewable port, not a candidate`);
      if (fromPorts && !modelled) disagreements.push(`${definition.type}: previewable port, no modelled slot`);
    }
    expect(disagreements).toEqual([]);
  });
});

describe("every scene payload kind is previewable end to end (T532)", () => {
  /**
   * The bridge between the two enumerations. `SCENE_PAYLOAD_KINDS` says what a payload can
   * BE; `PREVIEWABLE_PORT_KINDS` says what the UI will show. A payload kind that the ports
   * carry and the UI ignores is a node with a picture nobody can see — which is what
   * `geometry` was.
   */
  it("a node exists for each payload kind, and its output port previews", () => {
    const missing: string[] = [];
    for (const kind of SCENE_PAYLOAD_KINDS) {
      // Geometry travels on the `scene` port kind; the other three are their own.
      const portKind = kind === "geometry" ? "scene" : kind;
      expect([kind, PREVIEWABLE_PORT_KINDS.has(portKind)]).toEqual([kind, true]);
      const producer = allNodeDefinitions.find((definition) =>
        definition.outputs.some((port) => port.type.kind === portKind),
      );
      if (producer === undefined) missing.push(kind);
    }
    expect(missing).toEqual([]);
  });
});
