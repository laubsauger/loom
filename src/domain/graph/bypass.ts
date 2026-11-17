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
  const input = bypassPassthroughPairs(definition).get(output.id);
  return input === undefined ? undefined : { input, output: output.id };
}

/**
 * EVERY output of a bypassed node, and the input it passes (B301, §V1035) — the rule above,
 * said per PORT, because a component instance has as many outputs as its author gave it.
 *
 * A bypassed node is replaced by wires, and a wire joins two ports of one KIND (T356). So
 * the pairing is by position within a kind: the first texture output passes the first
 * texture input, the second the second, the first value output the first value input. An
 * output with no partner — more outputs of a kind than inputs, or no input of that kind at
 * all — passes nothing and reads disconnected, as a bypassed source does. An empty map is a
 * node that passes nothing anywhere: bypassing it silences it.
 *
 * For a node's FIRST output this is exactly `bypassPassthroughPorts`, the only question
 * there was while every node had one output. What it replaced for the others was no rule:
 * the texture compiler handed every further output the first output's input whatever its
 * kind (a pointset consumer was given a texture and the compile failed), and the value
 * graph, which keeps one bag per node, passed an un-inlined instance nothing at all.
 *
 * ONE definition, read by the compiler's splice and by the value graph's topology.
 */
export function bypassPassthroughPairs(definition: NodeDefinition): ReadonlyMap<PortId, PortId> {
  const pairs = new Map<PortId, PortId>();
  const taken = new Map<string, number>();
  for (const output of definition.outputs) {
    const kind = output.type.kind;
    const nth = taken.get(kind) ?? 0;
    taken.set(kind, nth + 1);
    const input = definition.inputs.filter((port) => port.type.kind === kind)[nth];
    if (input !== undefined) pairs.set(output.id, input.id);
  }
  return pairs;
}

/**
 * Does a bypassed node pass anything on an output of this kind? (T1779b.) What a surface
 * that shows ONE kind asks — a value plot, of a node or of an instance with outputs of
 * several kinds: bypassed and passing no value is silent, bypassed and passing one is live.
 */
export function bypassPassesKind(definition: NodeDefinition, kind: string): boolean {
  const pairs = bypassPassthroughPairs(definition);
  return definition.outputs.some((output) => output.type.kind === kind && pairs.has(output.id));
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
