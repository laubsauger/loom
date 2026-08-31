import type { NodeDefinition } from "../types/node-definition.ts";
import type { PortId } from "../types/ids.ts";

/**
 * What a BYPASSED node passes through (T250/B16, T356, T541) — ONE definition, for
 * every graph that honours the flag.
 *
 * TD's rule: bypass turns a node into a wire, first input straight to first output. Two
 * refinements this project has already paid for, both of them load-bearing:
 *
 *  - **Type coherence (T356).** A converter — `renderPoints`, pointset in / texture out —
 *    has no input a consumer of its output could bind. Splicing one handed downstream a
 *    pointset marker as a texture id and the plan exploded at build. So the passthrough
 *    is the first input whose port KIND matches the first output's, not simply `inputs[0]`.
 *  - **A SOURCE has nothing to pass (T250).** No coherent input means the node produces
 *    NOTHING while bypassed — its output reads disconnected, which is exactly what
 *    "temporarily off" means, and is what TD does with a bypassed generator. The caller
 *    turns that into its own flavour of silence (the compiler mutes it; the value graph
 *    publishes no bag).
 *
 * Returning `undefined` is therefore a real answer — "bypassing this node silences it" —
 * and not a failure. §V109's shape is why this lives here rather than twice: the texture
 * compiler and the value graph were asked the same question and must not grow two answers.
 */
export function bypassPassthroughPorts(
  definition: NodeDefinition,
): { readonly input: PortId; readonly output: PortId } | undefined {
  const output = definition.outputs[0];
  if (output === undefined) return undefined;
  const input = definition.inputs.find((port) => port.type.kind === output.type.kind);
  if (input === undefined) return undefined;
  return { input: input.id, output: output.id };
}
