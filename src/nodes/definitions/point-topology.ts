import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { formatTopology, gridPointCount } from "../../points/topology.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";

/**
 * PointTopology (T302): the topology HALF of TD's kernel/topology split. TD deprecated
 * the combined Create POP because generation and connectivity are different authorship
 * — this node is where connectivity is authored SEPARATELY: it emits no pass, owns no
 * buffer, and republishes the upstream pairs with a different topology claim on the
 * T296 edge. Declaring a deformed point cloud to be a 128×64 grid, opening a torus's
 * seam, gridding a kernel's output so renderSurface will take it — all edge-payload
 * edits, all free at render time.
 *
 * Every parameter is compileTime BY DEFINITION: they exist only in the published edge
 * payload, and the classifier cannot see through an edge — a value-only cols edit
 * would leave every consumer's vertex count stale.
 *
 * The capacity check is the honesty line: a topology addressing more points than the
 * edge carries is refused HERE, where the claim is authored, with the same diagnostic
 * code consumers use — not downstream where the user would have to trace it back.
 */
export const pointTopologyNode: NodeDefinition = {
  type: "pointTopology",
  version: 1,
  title: "Topology",
  category: "points",
  description:
    "Authors the connectivity claim on a pointset edge — declare a grid, close or open wrap seams — without touching the points.",
  tags: ["points", "topology", "connectivity", "grid", "surface"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
  ],
  parameters: {
    connectivity: {
      type: "enum",
      label: "Connectivity",
      default: "grid",
      options: [
        { value: "points", label: "Points" },
        { value: "grid", label: "Grid" },
      ],
      compileTime: true,
    },
    cols: {
      type: "number",
      label: "Columns",
      default: 64,
      min: 1,
      max: 4096,
      step: 1,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no grid." : null),
    },
    rows: {
      type: "number",
      label: "Rows",
      default: 64,
      min: 1,
      max: 4096,
      step: 1,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no grid." : null),
    },
    wrapU: {
      type: "boolean",
      label: "Wrap U",
      default: false,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no seams." : null),
    },
    wrapV: {
      type: "boolean",
      label: "Wrap V",
      default: false,
      compileTime: true,
      inactiveWhen: (values) => (values["connectivity"] === "points" ? "Points connectivity has no seams." : null),
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const points = inputs["points"];
    if (points === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const pointset = points.pointset;
    if (pointset === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points input carries no edge payload; there is nothing to re-claim.`,
            nodeId,
          },
        ],
      };
    }

    const topology =
      parameters["connectivity"] === "points"
        ? ({ kind: "points" } as const)
        : ({
            kind: "grid",
            cols: Math.max(1, Math.round(readNumber(parameters, "cols", 64))),
            rows: Math.max(1, Math.round(readNumber(parameters, "rows", 64))),
            wrapU: readFlag(parameters, "wrapU", false) === 1,
            wrapV: readFlag(parameters, "wrapV", false) === 1,
          } as const);

    if (topology.kind === "grid" && gridPointCount(topology) > pointset.capacity) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.surface.topology",
            message: `Node "${nodeId}": topology "${formatTopology(topology)}" addresses ${gridPointCount(topology)} points but the edge carries ${pointset.capacity}.`,
            nodeId,
            suggestion: "Match cols x rows to the producer's point count.",
          },
        ],
      };
    }

    return {
      passes: [],
      // §V197: this node WRITES nothing, so it OWNS nothing — every pair passes
      // through by reference. Only the claim changes.
      pointsets: {
        out: {
          pairs: pointset.pairs,
          capacity: pointset.capacity,
          topology: formatTopology(topology),
        },
      },
    };
  },
};
