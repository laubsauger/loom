import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import { formatTopology } from "../../points/topology.ts";
import { POINT_GENERATOR_WGSL } from "../shaders/point-generators.wgsl.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { pointPairId } from "./points.ts";

/**
 * The point generator family (T298): `pointGenerator` with a shape menu, plus the
 * named presets — grid, line, circle, sphere, tube, torus, box — that TD users reach
 * for by name. ONE implementation (V140's Composite/Over convention): the presets share
 * the generic node's compile with the shape forced and the irrelevant knobs hidden, so a
 * fix lands in all eight nodes at once and the plan never knows which spelling built
 * it. Shape reaches the KERNEL as a uniform — switching never swaps a pipeline (§V5)
 * — but the parameter is compileTime anyway, because shape also decides the published
 * topology string (T296) and an edge payload is structural for whoever consumes it
 * (T301's vertex count derives from it). The recompile is a V62b cache hit: same
 * module, same resources, new edge payload.
 *
 * A generator writes `position` — so it OWNS the position pair (§V197) — publishes the
 * T296 edge map, and emits `topology` for the surface renderer (T301): grid/tube/torus
 * carry their cols×rows connectivity analytically. Every OTHER shape publishes `points`,
 * and the box (T1057) is the shape that proves the vocabulary rather than stretching it
 * — six disjoint faces are not one cols×rows sheet, and claiming a grid would hand
 * `renderSurface` a vertex count addressing points that are not neighbours. It publishes
 * `points` and renderSurface refuses it BY NAME (§V288), which is the honest answer.
 *
 * The preset table is a `Record<GeneratorShape, …>` on purpose (§V316): a shape added to
 * `GENERATOR_SHAPES` without a node to spell it by name is a type error, not a gap
 * someone notices months later.
 */

/** §V831: APPEND only. A stored shape whose row disappeared silently resolves to the default. */
export const GENERATOR_SHAPES = ["line", "circle", "grid", "sphere", "tube", "torus", "box"] as const;
export type GeneratorShape = (typeof GENERATOR_SHAPES)[number];

const SHAPE_INDEX: Record<GeneratorShape, number> = {
  line: 0,
  circle: 1,
  grid: 2,
  sphere: 3,
  tube: 4,
  torus: 5,
  box: 6,
};

/** Which knobs each shape actually reads — the V146 applicability data, shared. */
const SHAPE_USES: Record<GeneratorShape, ReadonlyArray<string>> = {
  line: ["sizeX"],
  circle: ["radius"],
  grid: ["sizeX", "sizeY", "cols", "rows"],
  sphere: ["radius"],
  tube: ["radius", "sizeZ", "cols", "rows"],
  torus: ["radius", "radius2", "cols", "rows"],
  // The box is the only shape that reads all three extents, and no radius: it is the
  // reason sizeZ exists as a knob separate from sizeX/sizeY.
  box: ["sizeX", "sizeY", "sizeZ"],
};

function generatorParameters(fixedShape: GeneratorShape | null): ParameterSchema {
  const usedBy = (key: string) => (values: Readonly<Record<string, unknown>>): string | null => {
    const shape = (fixedShape ?? values["shape"]) as GeneratorShape;
    return SHAPE_USES[shape]?.includes(key) === true ? null : `The ${shape} shape does not read this.`;
  };
  return {
    ...(fixedShape !== null
      ? {}
      : {
          shape: {
            type: "enum" as const,
            label: "Shape",
            default: "grid",
            options: GENERATOR_SHAPES.map((value) => ({ value, label: value[0]?.toUpperCase() + value.slice(1) })),
            // Not for the kernel's sake (shape stays a uniform there) — shape decides
            // the PUBLISHED topology string on the edge (T296), and anything that feeds
            // an edge payload is structural: a consumer's vertex count derives from it.
            compileTime: true,
          },
        }),
    count: { type: "number", label: "Count", default: 4096, min: 1, max: 1_000_000, range: "bounded", step: 1, compileTime: true },
    cols: { type: "number", label: "Columns", default: 64, min: 1, max: 4096, range: "bounded", step: 1, compileTime: true, inactiveWhen: usedBy("cols") },
    rows: { type: "number", label: "Rows", default: 64, min: 1, max: 4096, range: "bounded", step: 1, compileTime: true, inactiveWhen: usedBy("rows") },
    sizeX: { type: "number", label: "Size X", default: 2, min: 0, range: "floor", inactiveWhen: usedBy("sizeX") },
    sizeY: { type: "number", label: "Size Y", default: 2, min: 0, range: "floor", inactiveWhen: usedBy("sizeY") },
    sizeZ: { type: "number", label: "Size Z", default: 2, min: 0, range: "floor", inactiveWhen: usedBy("sizeZ") },
    radius: { type: "number", label: "Radius", default: 1, min: 0, range: "floor", inactiveWhen: usedBy("radius") },
    radius2: { type: "number", label: "Minor Radius", default: 0.25, min: 0, range: "floor", inactiveWhen: usedBy("radius2") },
  };
}

function compileGenerator(fixedShape: GeneratorShape | null) {
  return (context: unknown): CompiledNodeDescription => {
    const { nodeId, parameters } = readCompileInputs(context as Parameters<typeof readCompileInputs>[0]);
    const capacity = Math.max(1, Math.round(readNumber(parameters, "count", 4096)));
    const shape = fixedShape ?? ((parameters["shape"] as GeneratorShape) || "grid");
    const cols = Math.max(1, Math.round(readNumber(parameters, "cols", 64)));
    const rows = Math.max(1, Math.round(readNumber(parameters, "rows", 64)));

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:generate`,
      shader: POINT_GENERATOR_WGSL,
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / 64), 1, 1],
      buffers: [{ binding: "out_position", resourceId: pointPairId(nodeId, "position"), half: "write" }],
      uniforms: {
        count: capacity,
        shape: SHAPE_INDEX[shape] ?? 2,
        cols,
        rows,
        sizeX: readNumber(parameters, "sizeX", 2),
        sizeY: readNumber(parameters, "sizeY", 2),
        sizeZ: readNumber(parameters, "sizeZ", 2),
        radius: readNumber(parameters, "radius", 1),
        radius2: readNumber(parameters, "radius2", 0.25),
      },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: "position", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity },
      ],
      pointsets: {
        out: {
          pairs: { position: { pair: pointPairId(nodeId, "position"), half: "write" as const, type: "vec3f" } },
          capacity,
          // T301's connectivity, in T302's vocabulary: a gridded shape publishes its
          // analytic topology, with the seams its parametrization actually closes.
          topology: formatTopology(
            shape === "grid" || shape === "tube" || shape === "torus"
              ? { kind: "grid", cols, rows, wrapU: shape !== "grid", wrapV: shape === "torus" }
              : { kind: "points" },
          ),
        },
      },
    };
  };
}

const POINT_OUT = {
  id: "out",
  label: "Out",
  type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
};

function generatorNode(type: string, title: string, shape: GeneratorShape | null, description: string): NodeDefinition {
  return {
    type,
    version: 1,
    title,
    category: "points",
    description,
    tags: ["points", "generator", ...(shape === null ? GENERATOR_SHAPES : [shape])],
    inputs: [],
    outputs: [POINT_OUT],
    parameters: generatorParameters(shape),
    compile: compileGenerator(shape),
  };
}

export const pointGeneratorNode = generatorNode(
  "pointGenerator",
  "Point Generator",
  null,
  "Analytic point layouts — line, circle, grid, sphere, tube, torus, box — from one deterministic kernel. Shape is a uniform: switching never recompiles.",
);

/**
 * One preset per shape, exhaustive by TYPE (§V316): shape #8 cannot land without the
 * node that spells it by name, because this record would stop compiling.
 */
const SHAPE_PRESETS: Record<GeneratorShape, NodeDefinition> = {
  grid: generatorNode("pointGrid", "Grid Points", "grid", "A cols×rows grid of points in the xy plane."),
  line: generatorNode("pointLine", "Line Points", "line", "Points along a line on x."),
  circle: generatorNode("pointCircle", "Circle Points", "circle", "Points around a circle in the xy plane."),
  sphere: generatorNode("pointSphere", "Sphere Points", "sphere", "A Fibonacci sphere — uniform coverage, no pole clustering."),
  tube: generatorNode("pointTube", "Tube Points", "tube", "A cols×rows tube along z."),
  torus: generatorNode("pointTorus", "Torus Points", "torus", "A cols×rows torus: major radius around y, minor radius2."),
  box: generatorNode("pointBox", "Box Points", "box", "The surface of a sizeX×sizeY×sizeZ box — six faces sharing the count by area, so a slim face gets few."),
};

export const pointGridNode = SHAPE_PRESETS.grid;
export const pointLineNode = SHAPE_PRESETS.line;
export const pointCircleNode = SHAPE_PRESETS.circle;
export const pointSphereNode = SHAPE_PRESETS.sphere;
export const pointTubeNode = SHAPE_PRESETS.tube;
export const pointTorusNode = SHAPE_PRESETS.torus;
export const pointBoxNode = SHAPE_PRESETS.box;

/**
 * Library order is the record's own declaration order — grid first, because it is the
 * one everybody places — and the record is exhaustive, so the list cannot go stale.
 */
export const pointGeneratorDefinitions: readonly NodeDefinition[] = [
  pointGeneratorNode,
  ...Object.values(SHAPE_PRESETS),
];
