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

/**
 * Is this SOURCE node off? (T555.)
 *
 * For a node with NO INPUTS the two flags collapse into one answer: muted is off, and
 * bypassed is off too, because the rule above says a node with nothing to pass through
 * produces nothing. So a caller that only ever sees sources — the audio capture chooser,
 * which picks between `audioFileIn` and `audioIn`, neither of which has an input — can
 * ask this one question without a registry in its hand.
 *
 * It is deliberately named for what it assumes. A node WITH an input needs
 * `bypassPassthroughPorts` and its actual wiring to answer, and the assumption is gated
 * by test rather than left as a comment: every audio capture candidate must declare zero
 * inputs, so giving one an input tomorrow reddens instead of silently making this lie.
 */
export function isSilencedSource(node: { readonly ui?: { muted?: boolean; bypassed?: boolean } }): boolean {
  return node.ui?.muted === true || node.ui?.bypassed === true;
}
