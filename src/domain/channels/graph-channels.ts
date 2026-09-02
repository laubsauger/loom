import type { GraphDocument } from "../types/graph.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { ParameterValue } from "../types/parameters.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { ChannelResolver } from "../parameters/resolve.ts";
import { nodeByName } from "../graph/names.ts";
import { storedStaticValue } from "../parameters/slots.ts";
import { defaultParameterValue } from "../parameters/validate.ts";

/**
 * Graph-backed driven channels (T238-T240, §V143).
 *
 * The bridge between value-source NODES (LFO, Constant, Timer — anything declaring
 * `valueChannel`) and the parameter resolver's `driven` mode (T203): a parameter driven
 * by channel `lfo1` reads the value-source node NAMED `lfo1` (§V129 — names are
 * identifiers, which is what makes this addressing possible at all). Plug the result
 * into `ResolveParametersOptions.channels` and the reserved mode comes alive.
 *
 * Determinism (§V143, §V44, §V45): the value is a pure function of the source node's
 * parameter values and the frame — no wall clock anywhere — so offline render and live
 * playback agree frame for frame, and the same project at the same frame index is the
 * same picture on every machine.
 *
 * The SOURCE node's own parameters resolve as their static view here, deliberately: an
 * LFO whose frequency is itself driven would recurse through this resolver, and a
 * channel graph is exactly the kind of loop §V110 exists to prevent. Modulating an
 * LFO's frequency is real (TD does it) and arrives with channel-graph cycle detection,
 * not by accident.
 */
export function graphChannelResolver(
  graph: GraphDocument,
  registry: NodeRegistryView,
): ChannelResolver {
  return (channel, context) => {
    const nodeId = nodeByName(graph, channel);
    if (nodeId === undefined) return undefined;
    const node = graph.nodes[nodeId];
    if (node === undefined) return undefined;
    const definition = registry.get(node.type);
    if (definition?.valueChannel === undefined) return undefined;

    const values: Record<string, ParameterValue> = {};
    for (const [key, parameter] of Object.entries(definition.parameters)) {
      values[key] = storedStaticValue(node.parameters[key]) ?? defaultParameterValue(parameter);
    }
    const frame: FrameEvaluationInput = context.frame ?? ZERO_FRAME;
    const value = definition.valueChannel(values, frame);
    return Number.isFinite(value) ? value : undefined;
  };
}

/** §V44's deterministic zero frame: resolving outside a frame is t=0, not an error. */
const ZERO_FRAME: FrameEvaluationInput = {
  timeSeconds: 0,
  deltaSeconds: 0,
  frameIndex: 0,
  mode: "offline",
  randomSeed: 0,
};

/**
 * True when any parameter in the document animates per frame — an expression or driven
 * slot at any key. The frame loop uses this to decide whether values-only recompiles
 * run at frame rate at all; a static project pays nothing.
 */
export function hasAnimatedParameters(graph: GraphDocument): boolean {
  return Object.values(graph.nodes).some(nodeHasAnimatedParameters);
}

/**
 * The same question about ONE node, which is the unit the inspector asks about (T893).
 *
 * Extracted rather than copied: the panel decides whether to sample the live frame at all
 * from this, and a second predicate that drifted would mean the inspector going quiet for
 * exactly the parameters the frame loop is animating. Component keys (`color.g`) live in
 * the same record, so a compound with one driven channel counts.
 */
export function nodeHasAnimatedParameters(node: GraphDocument["nodes"][string]): boolean {
  for (const stored of Object.values(node.parameters)) {
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) continue;
    const mode = (stored as { mode?: unknown }).mode;
    if (mode === "expression" || mode === "driven" || mode === "bind") return true;
  }
  return false;
}
