import { createGraphStore } from "@domain/graph/store.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { buildProjectFile } from "@domain/project/project-file.ts";
import { SCHEMA_VERSION } from "@domain/types/schemas.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ProjectDocument, ProjectSettings } from "@domain/types/graph.ts";

/**
 * The 200-node scaling fixture for T1235's scenario G, built through the COMMAND BUS
 * (`graph.applyPatch`) and serialised through the app's own save path
 * (`buildProjectFile`), so what the harness opens is a document the product itself
 * could have written — never a hand-shaped JSON.
 *
 * Shape: one noise generator, a trunk of `level` nodes (cheap 2D, one input one output),
 * and from every 10th trunk node a fan-out branch of `level` nodes, all ending in one
 * `output`. 1 + trunk + branches nodes; edges = nodes − 1. Laid out on a grid so the
 * canvas has the geometry a real patch has (edges of every length, nodes off-screen at
 * any zoom that shows a node legibly).
 */
export interface SyntheticChainOptions {
  readonly trunk: number;
  readonly branchEvery: number;
  readonly branchLength: number;
  readonly settings?: Partial<ProjectSettings>;
}

/** 1 + 126 + 12 × 6 + 1 = 200 nodes, 199 edges. */
export const CHAIN_200: SyntheticChainOptions = { trunk: 126, branchEvery: 10, branchLength: 6 };

const COLUMN = 360;
const ROW = 260;

export async function buildSyntheticChain(options: SyntheticChainOptions): Promise<{ text: string; nodeCount: number; edgeCount: number; knobNodeId: string; dragNodeId: string }> {
  const store = createGraphStore();
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const { bus } = createDomainBus({ store, registry });
  const context = { actor: { kind: "system" as const, id: "perf-harness" }, projectId: "perf", capabilities: [] };

  const operations: GraphPatchOperation[] = [];
  operations.push({ op: "addNode", ref: "$src", type: "noise", position: { x: 0, y: 0 }, label: "src" });
  let previous = "$src";
  for (let index = 0; index < options.trunk; index += 1) {
    const ref = `$t${index}` as const;
    operations.push({ op: "addNode", ref, type: "level", position: { x: (index + 1) * COLUMN, y: 0 }, label: `t${index}` });
    operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: ref, portId: "input" } });
    previous = ref;
    if ((index + 1) % options.branchEvery === 0) {
      let branchPrevious: string = ref;
      for (let depth = 0; depth < options.branchLength; depth += 1) {
        const branchRef = `$b${index}_${depth}` as const;
        operations.push({
          op: "addNode",
          ref: branchRef,
          type: "level",
          position: { x: (index + 1) * COLUMN, y: (depth + 1) * ROW },
          label: `b${index}_${depth}`,
        });
        operations.push({ op: "connect", source: { nodeId: branchPrevious, portId: "out" }, target: { nodeId: branchRef, portId: "input" } });
        branchPrevious = branchRef;
      }
    }
  }
  operations.push({ op: "addNode", ref: "$out", type: "output", position: { x: (options.trunk + 1) * COLUMN, y: 0 }, label: "out" });
  operations.push({ op: "connect", source: { nodeId: previous, portId: "out" }, target: { nodeId: "$out", portId: "input" } });

  const result = await bus.execute("graph.applyPatch", { baseRevision: store.view.getGraph().revision, operations, label: "perf chain" }, context);
  if (result.status !== "applied") throw new Error(`the synthetic chain did not apply: ${result.status} ${JSON.stringify(result.diagnostics)}`);
  const graph = store.view.getGraph();
  const settings: ProjectSettings = { ...store.view.getSettings(), ...options.settings };
  const now = "2026-09-08T00:00:00.000Z";
  const document: ProjectDocument = {
    schemaVersion: SCHEMA_VERSION,
    projectId: "perf-chain-200",
    name: "perf-chain-200",
    graph,
    settings,
    assets: [],
    createdAt: now,
    updatedAt: now,
  };
  const file = buildProjectFile({ document, now: () => now });
  const byLabel = (label: string): string => {
    const node = Object.values(graph.nodes).find((candidate) => candidate.label === label);
    if (node === undefined) throw new Error(`no node labelled ${label}`);
    return node.id;
  };
  return {
    text: file.text,
    nodeCount: Object.keys(graph.nodes).length,
    edgeCount: Object.keys(graph.edges).length,
    knobNodeId: byLabel("t5"),
    dragNodeId: byLabel("t60"),
  };
}
