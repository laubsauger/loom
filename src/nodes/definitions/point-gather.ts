import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { ATTRIBUTE_STRIDES, COMPONENT_COUNTS, type PointAttributeType } from "../../points/attributes.ts";
import { pointGatherWgsl } from "../shaders/points.wgsl.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { pointPairId } from "./points.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * Gather (T1071) — A REDUCTION OVER AN ADJACENCY. The composition above `pointAt`.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT THIS EXISTS TO CLOSE, and it is the owner's own question: *we have rays and
 * proximity operators already — wouldn't it be possible to express this through those, as
 * adjacency, instead of mangling it all into a single kernel shader?* E54's Laplacian was a
 * full O(N²) scan in a point kernel — 480 points, ~230k pair evaluations a frame — WHILE
 * `pointProximity` had already computed and stored the K nearest. Two costs, and the second
 * is the worse one: the work is done twice, and **there were two definitions of who is a
 * neighbour** (proximity's K-nearest-within-radius against the kernel's inline predicate),
 * which is §V865's shape exactly — two answers to one question, drifting the moment either
 * is tuned. Worse still, the picture DREW proximity's links while the operator used its
 * own, so the filaments on screen were a parallel drawing of the edges rather than them.
 *
 * ⚠ THIS DOES NOT REPLACE `pointAt` (§T1070) AND MUST NOT BE READ AS DOING SO. `pointAt` is
 * §T117's promised primitive and the couplings that are NOT proximity-shaped genuinely need
 * it: an all-pairs Coulomb charge, a global centroid or deviation, a predicate over
 * identity rather than distance. What was missing was never the slot read — it was the
 * COMPOSITION above it. This node is that composition, and the two are complementary.
 *
 * ## What it takes and what it hands back
 *
 * TWO POINTSET INPUTS, which is new for this catalogue and was measured before it was
 * designed on: the compiler's input binding is per-EDGE and keyed by TARGET PORT, with the
 * pointset payload looked up by the SOURCE endpoint, so two pointset ports resolve
 * independently with no special casing anywhere (`compile.ts`'s binding loop). `docs/
 * pop-gap-analysis.md` lists "two point systems cannot be combined" as the #1 structural
 * hole; nothing enforced it, nothing had needed it.
 *
 * OUTPUT: THE SOURCE POINTSET, PLUS ONE ATTRIBUTE — never a bare aggregate on its own, and
 * that is §V883 taken literally. An aggregate is a DERIVED COMPANION of the points it was
 * measured over; hand it out alone and a caller can wire it beside a different population
 * of the same capacity and read a per-point value that belongs to someone else, silently.
 * Republishing the source by reference (§V197 copy-on-write — this node owns exactly one
 * fresh pair) makes the pair inseparable: whoever reads the aggregate is reading the points
 * it came from, because they arrived on one edge.
 *
 * ## Why there is no scan here, and why that is the finding rather than the shortcut
 *
 * §T1071 proposed the segmented-reduction machinery §T983 built for `pointRange`
 * (Hillis-Steele plus serial blocks). It is not needed, and the arithmetic says so:
 * `pointProximity` writes SOURCE-MAJOR at a FIXED STRIDE, so point `i`'s links are exactly
 * slots `i*K … i*K+K-1`. The segment boundary is MULTIPLICATION, not data. One thread per
 * point, K ≤ 8 serial steps, no atomics, no barrier, no scratch. O(N·K).
 *
 * ## The weighting, stated rather than assumed
 *
 * Proximity's `tint.a` is a FALLOFF-SHAPED strength: 1 at contact, 0 at the radius, curved
 * by its Falloff knob. That is the right weight for a diffusion or a graph Laplacian (near
 * neighbours pull harder) and the WRONG one for "the average colour of my neighbours",
 * where every neighbour counts once. Both are offered by name — `Strength` and `Uniform` —
 * because picking one silently is how a node ends up meaning two things. `Degree` is the
 * weight sum itself: the WEIGHTED DEGREE, which is what a hub has more of.
 *
 * ## Does it generalise past Proximity?
 *
 * YES, and deliberately: this node knows nothing about proximity. It requires a pointset
 * carrying `neighbor: u32` and `tint: vec4f` at a whole-number stride over the source, so
 * ANY operator emitting adjacency in that shape feeds it — a ray operator publishing hits,
 * a topology node publishing lattice edges, a future explicit edge list. The value of the
 * node is that it works over AN adjacency, never over proximity's.
 *
 * ⚠ THE ONE THING IT CANNOT CHECK (recorded, not hidden). The two inputs must be the SAME
 * POPULATION: link slots are addresses into the source (§V73), so pointing this at a
 * different pointset of the same capacity reads real numbers belonging to the wrong points.
 * The edge payload carries no producer identity, so the capacity relation below is the
 * strongest structural guard available and the residue is a caller obligation. That is
 * §V883's shape unresolved at the port level, and it is stated here rather than discovered.
 */

/** The reductions offered, and the shader has one branch per row. */
const GATHER_REDUCTIONS = ["sum", "mean", "min", "max", "degree"] as const;
type GatherReduction = (typeof GATHER_REDUCTIONS)[number];

/** Reductions that MULTIPLY the value by a weight, so an integer attribute is meaningless. */
const WEIGHTED_REDUCTIONS: ReadonlySet<GatherReduction> = new Set(["sum", "mean"]);

const FLOAT_ATTRIBUTE_TYPES: ReadonlySet<string> = new Set(["f32", "vec2f", "vec3f", "vec4f"]);

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const LINK_INPUT = {
  id: "links",
  label: "Links",
  type: {
    kind: "pointset" as const,
    requires: [
      { name: "tint", type: "vec4f" as const },
      { name: "neighbor", type: "u32" as const },
    ],
  },
  description:
    "An adjacency: one link per (point, neighbour) slot, source-major at a fixed stride, carrying the neighbour's SLOT in neighbor and the link's strength in tint.a. Proximity emits exactly this; any operator that emits the same shape works.",
};

const POINTS_INPUT = {
  id: "points",
  label: "Points",
  type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
  description:
    "The point set the link slots address — the SAME population the links were computed over. The gathered attribute is read from here and the whole set is republished with the aggregate added.",
};

export const pointGatherNode: NodeDefinition = {
  type: "pointGather",
  version: 1,
  title: "Gather",
  category: "points",
  description:
    "Reduces one attribute over each point's neighbours, following an adjacency. Wire Proximity's links in and every point gets the weighted mean of its neighbours' colour, its weighted degree, the smallest label around it — whatever the reduction says. The links you draw and the numbers you compute are then the same edges.",
  tags: ["points", "adjacency", "neighbours", "gather", "reduce", "graph", "laplacian", "degree"],
  inputs: [LINK_INPUT, POINTS_INPUT],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The incoming point set with the aggregate added as a new attribute. Capacity, topology and every other attribute pass through untouched — the aggregate travels with the points it was measured over (§V883).",
    },
  ],
  parameters: {
    attribute: {
      type: "string",
      label: "Attribute",
      /* "position" for the same reason Range defaults to it: the one attribute every
         pointset carries, so the node is valid the moment it is wired and the
         catalogue-chain gate has something real to compile. */
      default: "position",
      compileTime: true,
      description:
        "Which per-point attribute is gathered from each neighbour, by name. A name the points do not carry says so and lists what they do. Ignored by the Degree reduction, which measures the links themselves.",
    },
    reduce: {
      type: "enum",
      label: "Reduce",
      default: "mean",
      compileTime: true,
      options: [
        { value: "sum", label: "Sum" },
        { value: "mean", label: "Mean" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
        { value: "degree", label: "Degree" },
      ],
      description:
        "Sum and Mean multiply each neighbour's value by the link weight (Mean divides by the total weight) and refuse an integer attribute, because a weighted average of an identity is not a value. Min and Max are componentwise over the links that exist and ignore the weight. Degree ignores the attribute and returns the total weight — the weighted degree, which is what a hub has more of. A point with no links: Sum and Degree give exactly zero, Mean/Min/Max give the point's own value, because a point with no neighbours is its own neighbourhood.",
    },
    weight: {
      type: "enum",
      label: "Weight",
      default: "strength",
      compileTime: true,
      options: [
        { value: "strength", label: "Link strength" },
        { value: "uniform", label: "Uniform" },
      ],
      description:
        "Strength weights each neighbour by the link's own tint.a — Proximity's falloff curve, so near neighbours pull harder. That is what a diffusion or a graph Laplacian wants. Uniform counts every existing link once, which is what a plain neighbour average wants. Min and Max ignore this.",
    },
    output: {
      type: "string",
      label: "Output attribute",
      default: "gathered",
      compileTime: true,
      description:
        "Name the aggregate is published under. Reusing an incoming attribute's name REPLACES it — which is how you smooth an attribute over its own neighbourhood — as long as the type still matches; a name that would change an attribute's type is refused rather than swizzled wrong downstream.",
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);

    const refuse = (message: string, suggestion?: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.points.gather",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    });

    const linksInput = inputs["links"];
    if (linksInput === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "links"')] };
    }
    const pointsInput = inputs["points"];
    if (pointsInput === undefined) {
      return { passes: [], diagnostics: [missingCompileResource(nodeId, 'input port "points"')] };
    }
    const links = linksInput.pointset;
    const points = pointsInput.pointset;
    if (links === undefined || points === undefined) {
      return refuse("an incoming edge carries no resolved pointset payload (producer predates T296?).");
    }

    const neighbor = links.pairs["neighbor"];
    if (neighbor === undefined || neighbor.type !== "u32") {
      const carried = Object.keys(links.pairs).sort().join(", ");
      return refuse(
        `the links edge carries no "neighbor" slot attribute (it carries: ${carried || "nothing"}).`,
        "Wire a Proximity node's Links output — an adjacency has to say WHO each neighbour is, not only where.",
      );
    }
    const strength = links.pairs["tint"];
    if (strength === undefined || strength.type !== "vec4f") {
      return refuse(`the links edge carries no "tint" (vec4f) pair, so a link has no strength to weight by.`);
    }

    /* THE STRIDE, DERIVED RATHER THAN CONFIGURED. K is a fact about the link set (its
       capacity is points × K by construction), so asking the user for it would be a number
       that has to match another number — §T1053's definition of a control that is not one.
       A non-integer ratio means these two edges are not a link set and its source. */
    const count = points.capacity;
    if (count < 1 || links.capacity < 1 || links.capacity % count !== 0) {
      return refuse(
        `the links (capacity ${links.capacity}) are not a whole number of links per point over these points (capacity ${count}).`,
        "The Links and Points inputs must be one Proximity node's output and the very pointset it ran on.",
      );
    }
    const k = links.capacity / count;
    if (k > 8) {
      return refuse(`the links carry ${k} per point, beyond the 8 this reduction unrolls.`);
    }

    const reduceRaw = typeof parameters["reduce"] === "string" ? parameters["reduce"] : "mean";
    const reduce: GatherReduction = (GATHER_REDUCTIONS as ReadonlyArray<string>).includes(reduceRaw)
      ? (reduceRaw as GatherReduction)
      : "mean";
    const weighted = parameters["weight"] !== "uniform";

    const attributeName = typeof parameters["attribute"] === "string" ? parameters["attribute"].trim() : "position";
    const source = points.pairs[attributeName];
    let attributeType: PointAttributeType = "f32";
    if (reduce !== "degree") {
      if (source === undefined) {
        const available = Object.keys(points.pairs).sort();
        return refuse(
          `the gather reads "${attributeName}", which the incoming pointset does not carry.`,
          available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
        );
      }
      if (source.type === undefined) {
        return refuse(
          `the gather reads "${attributeName}", but the edge does not declare its type; the producer predates typed pairs.`,
        );
      }
      attributeType = source.type as PointAttributeType;
      if (COMPONENT_COUNTS[attributeType] === undefined) {
        return refuse(`"${attributeName}" is typed "${source.type}", which is not a point attribute type.`);
      }
      /* REFUSED RATHER THAN INVENTED (§V288). Multiplying an id or a packed word by a
         falloff weight and averaging produces a number that is not an id, not a word, and
         not anything else — the plausible-wrong answer this project refuses by name. Min
         and Max over integers ARE meaningful (label propagation is min-of-neighbour-label),
         so they stay open. */
      if (WEIGHTED_REDUCTIONS.has(reduce) && !FLOAT_ATTRIBUTE_TYPES.has(attributeType)) {
        return refuse(
          `"${reduce}" weights and averages values, and "${attributeName}" is ${attributeType} — a weighted average of an integer attribute is not a value of that attribute.`,
          "Use Min or Max for an integer attribute, or gather a float attribute instead.",
        );
      }
    }

    const outputName = typeof parameters["output"] === "string" ? parameters["output"].trim() : "gathered";
    if (!IDENTIFIER.test(outputName)) {
      return refuse(`the output attribute name "${outputName}" is not a valid WGSL identifier.`);
    }
    const outputType: PointAttributeType = reduce === "degree" ? "f32" : attributeType;
    const replaced = points.pairs[outputName];
    if (replaced !== undefined && replaced.type !== undefined && replaced.type !== outputType) {
      return refuse(
        `publishing "${outputName}" as ${outputType} would change the type of the "${outputName}" (${replaced.type}) these points already carry.`,
        "Name the output something else, or gather an attribute of the matching type.",
      );
    }

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      /* Every one of these changes the program's bindings or its arithmetic (§V62b): the
         reduction picks the accumulator, the weight decides whether the strength buffer is
         bound at all, the type is the buffer's element type, and K is the stride baked in. */
      id: `${nodeId}:gather:${reduce}:${weighted ? "w" : "u"}:${outputType}:k${k}`,
      shader: pointGatherWgsl({ attributeType, outputType, reduce, weighted, k }),
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        { binding: "in_link_neighbor", resourceId: neighbor.pair, half: neighbor.half },
        ...(weighted || reduce === "degree"
          ? [{ binding: "in_link_strength", resourceId: strength.pair, half: strength.half }]
          : []),
        ...(reduce === "degree" || source === undefined
          ? []
          : [{ binding: "in_attr", resourceId: source.pair, half: source.half }]),
        { binding: "out_value", resourceId: pointPairId(nodeId, outputName), half: "write" as const },
      ],
      uniforms: { count },
      uniformBinding: "params",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: outputName, kind: "bufferPair", stride: ATTRIBUTE_STRIDES[outputType], capacity: count },
      ],
      pointsets: {
        out: {
          /* §V883/§V197: the WHOLE source republished by reference with one fresh pair on
             top. The aggregate cannot be separated from the points it was measured over,
             and no unmodified attribute gets a per-node copy. */
          pairs: {
            ...points.pairs,
            [outputName]: { pair: pointPairId(nodeId, outputName), half: "write" as const, type: outputType },
          },
          capacity: count,
          // Measuring a neighbourhood moves no slot, so the connectivity claim survives.
          ...(points.topology === undefined ? {} : { topology: points.topology }),
          ...(points.count === undefined ? {} : { count: points.count }),
        },
      },
    };
  },
};
