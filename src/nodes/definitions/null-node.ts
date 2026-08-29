import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";

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
