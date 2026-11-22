import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { PortType } from "../../domain/types/ports.ts";
import { RGBA_TEXTURE, VALUE_PORT } from "./common-ports.ts";

/**
 * Null — the standard bookmark (T223, §V130).
 *
 * TD's `null1` idiom: point everything at a null, then rewire upstream freely without
 * touching a single reference. It exists BECAUSE names are references (T221): the null
 * is the stable name a large patch converges on. One in, one out, and the compiler
 * splices it out entirely — no pass, no resource, zero render-time cost — while its
 * output stays previewable through the §V130 alias.
 *
 * `compile()` is never called for a spliced node; the empty description below keeps the
 * definition executable stand-alone (a bare registry test, a headless manifest sweep).
 */
export const nullNode: NodeDefinition = {
  type: "null",
  version: 1,
  title: "Null",
  category: "utility",
  description: "A wire with a name. Passes its input through at zero cost; the standard stable reference point.",
  inputs: [{ id: "in", label: "In", type: RGBA_TEXTURE, optional: true }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  resolutionPolicy: { kind: "inherit", input: "in" },
  formatPolicy: { kind: "inherit", input: "in" },
  compile(): CompiledNodeDescription {
    return { passes: [] };
  },
};

/**
 * T1822b — A NULL PER WIRED FAMILY, as TouchDesigner has one per operator family (Null TOP,
 * Null CHOP, Null POP). The texture Null above was the only one, so a points or a channel
 * chain had no stable name to converge on.
 *
 * One TYPE per family, under the family's own word and the same title, sharing the kind
 * `null` (`KIND_FAMILIES`): the convention `limit`/`valueLimit`, `switch`/`valueSwitch` and
 * `transform`/`pointTransform` already follow, and the one `component-io.ts` states for its
 * In and Out (§V349): a generic Null whose type follows its wire would need the port-type
 * union opened and the frozen `NodeDefinition` contract changed.
 *
 * Both are the same `passthrough` splice as the texture Null, so they cost nothing in the
 * plan. The points one previews through a splat of its OWN (`compile.ts`, the alias rows):
 * its producer's points, drawn under its own name. The value one also forwards its input bag
 * from `valueEvaluate`, exactly as `componentInValue` does and for the same reason: the value
 * graph evaluates nodes rather than splicing them, so that one line is what publishes the
 * channels under the Null's name for `op('null_x').chan.<channel>`. An unwired one publishes
 * nothing (an empty bag is silence, T541), as an unwired texture Null resolves to nothing.
 */
const POINTSET: PortType = { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] };

const noPasses = (): CompiledNodeDescription => ({ passes: [] });

export const pointNullNode: NodeDefinition = {
  type: "pointNull",
  version: 1,
  title: "Null",
  category: "points",
  description:
    "A points wire with a name. Passes its input points through at zero cost (no pass, no buffer): the stable reference point a points chain converges on, and a node the viewer and its tile can show.",
  tags: ["points", "null", "wire", "pop", "sop"],
  inputs: [{ id: "in", label: "In", type: POINTSET, optional: true }],
  outputs: [{ id: "out", label: "Out", type: POINTSET }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  compile: noPasses,
};

export const valueNullNode: NodeDefinition = {
  type: "valueNull",
  version: 1,
  title: "Null",
  category: "value",
  description:
    "A channel wire with a name. Passes its input channels through unchanged — values, names and order — so op('null_x').chan.<channel> reads them under this node's name. No parameters, nothing computed. CLOCKLESS (§V436): it reads no clock, so whatever its input does across a timeline loop, it does.",
  tags: ["value", "null", "wire", "chop"],
  inputs: [{ id: "in", label: "In", type: VALUE_PORT, optional: true }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {},
  passthrough: { input: "in", output: "out" },
  valueEvaluate: ({ inputs }) => inputs["in"] ?? {},
  /** A wire keeps each channel's own samples, so each channel's period passes through. */
  plotPeriodFollowsInputs: true,
  compile: noPasses,
};

/** The Null of every family the product wires by edge, texture first. */
export const nullNodes: readonly NodeDefinition[] = [nullNode, pointNullNode, valueNullNode];
