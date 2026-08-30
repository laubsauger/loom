import { describe, expect, it } from "vitest";

import { flattenComponents } from "../compiler/flatten.ts";
import { componentNodeType, createComponentSystem } from "../domain/components/index.ts";
import { parameterDependencies } from "../domain/graph/parameter-dependencies.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { buildStarterComponents } from "./starter-components.ts";

/**
 * B41 (§V320, §V321): every shipped component, instantiated TWICE in one graph.
 *
 * Flattening copies internal labels into the flat graph verbatim, and name references —
 * op(), driven channels, source references — resolve on the flat graph globally, first
 * name wins. Before the fix, the second instance's references silently bound the FIRST
 * instance's nodes: FeedbackEcho's second copy echoed the first copy's `over1`. §V321's
 * point is that this gate is a property of the CATALOGUE, not of the one component that
 * happened to expose it — any component that gains an internal reference tomorrow walks
 * into the same trap, so every component walks through the same twice-instantiated check.
 */

const baseNodes = createNodeRegistry(allNodeDefinitions).view();

function instanceNode(id: string, componentId: string, version: number): GraphNode {
  return {
    id,
    type: componentNodeType(componentId, version),
    definitionVersion: version,
    position: { x: 0, y: 0 },
    parameters: {},
  } as GraphNode;
}

const built = await buildStarterComponents();

describe("every shipped component survives being instantiated twice (B41, §V321)", () => {
  for (const component of built) {
    const { componentId, name } = component.spec;
    const version = component.definition.version;

    it(`${name}: two instances flatten with disjoint names and intra-instance references`, () => {
      const graph: GraphDocument = {
        revision: 1,
        nodes: {
          c1: instanceNode("c1", componentId, version),
          c2: instanceNode("c2", componentId, version),
        },
        edges: {},
        groups: {},
      } as GraphDocument;
      const system = createComponentSystem(baseNodes, [component.definition]);
      const flat = flattenComponents({ graph, registry: system.nodes, components: system.components.view() });

      expect(flat.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

      // Names are identifiers (§V129): the flat graph may not hold one label twice —
      // a duplicate is exactly the first-wins misbind this gate exists to refuse.
      const labels = Object.values(flat.graph.nodes)
        .map((node) => node.label)
        .filter((label): label is string => label !== undefined);
      expect(new Set(labels).size).toBe(labels.length);

      // Every stored reference — all of §V128's kinds, via the one dependency walk —
      // must stay inside its own instance's subtree. `c1/…` never depends on `c2/…`.
      const within = new Map<string, number>([
        ["c1", 0],
        ["c2", 0],
      ]);
      for (const [from, dependencies] of parameterDependencies(flat.graph)) {
        const owner = from.split("/")[0] as string;
        if (!within.has(owner)) continue;
        for (const dependency of dependencies) {
          expect(dependency.to.startsWith(`${owner}/`)).toBe(true);
          within.set(owner, (within.get(owner) ?? 0) + 1);
        }
      }
      // Structural parity: the rename must not have DROPPED a reference either — a
      // rewritten name that dangles vanishes from the walk and would pass the check above.
      expect(within.get("c2")).toBe(within.get("c1"));
    });
  }

  it("the catalogue exercises the reference kinds — this gate is not vacuous", () => {
    const kinds = new Set<string>();
    for (const component of built) {
      for (const dependencies of parameterDependencies(component.definition.graph).values()) {
        for (const dependency of dependencies) kinds.add(dependency.kind);
      }
    }
    // FeedbackEcho ships an internal source reference today; if every referencing
    // component ever leaves the starter set, this gate stops testing anything and must
    // say so instead of passing quietly (§V266).
    expect(kinds.has("feedback")).toBe(true);
  });
});
