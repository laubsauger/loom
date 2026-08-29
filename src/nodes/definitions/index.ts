import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { solidNode } from "./solid.ts";
import { customWgslNode } from "./custom-wgsl.ts";
import { outputNode } from "./output.ts";
import { noiseNode } from "./noise.ts";
import { generatorNodes } from "./generators.ts";
import { transformNodes } from "./transforms.ts";
import { colorNodes } from "./color.ts";
import { filterNodes } from "./filters.ts";
import { compositeNodes } from "./composite.ts";
import { temporalNodes } from "./feedback.ts";
import { pointNodeDefinitions } from "./points.ts";
import { nullNode } from "./null-node.ts";
import { valueNodeDefinitions } from "./values.ts";
import { analyzeNode } from "./analyze.ts";

export { solidNode } from "./solid.ts";
export { nullNode } from "./null-node.ts";
export { lfoNode, constantNode, timerNode, lfoValue, valueNodeDefinitions } from "./values.ts";
export { analyzeNode, ANALYZE_RESULT_KEY } from "./analyze.ts";
export { customWgslNode } from "./custom-wgsl.ts";
export { outputNode } from "./output.ts";
export { isSinkNode, SINK_TAG } from "./sink.ts";
export { RGBA_TEXTURE } from "./common-ports.ts";
export type { NodeCompileInputs } from "./compile-context.ts";
export { readCompileInputs, missingCompileResource } from "./compile-context.ts";

export { noiseNode } from "./noise.ts";
export { rampNode, uvNode, checkerNode, circleNode, generatorNodes } from "./generators.ts";
export { transformNode, cropNode, tileNode, transformNodes } from "./transforms.ts";
export { levelNode, hsvNode, thresholdNode, lookupNode, colorNodes } from "./color.ts";
export { blurNode, edgeNode, convolveNode, displaceNode, filterNodes } from "./filters.ts";
export {
  compositeNode,
  crossNode,
  overNode,
  addNode,
  multiplyNode,
  screenNode,
  differenceNode,
  maskNode,
  compositeNodes,
} from "./composite.ts";
export { feedbackNode, temporalNodes } from "./feedback.ts";
export {
  DEFAULT_POINT_ATTRIBUTES,
  pointKernelNode,
  pointKernelResources,
  pointNodeDefinitions,
  pointPairId,
  renderPointsNode,
} from "./points.ts";

/** The Phase 0 spike catalogue (T15). Kept as its own list so the spike's tests still mean what they meant. */
export const spikeNodeDefinitions: readonly NodeDefinition[] = [solidNode, customWgslNode, outputNode];

/**
 * The core catalogue (T70, T40), in TD TOP vocabulary.
 *
 * Grouped source -> geometry -> colour -> filter -> composite, which is the order a chain
 * is usually built in and the order the library pane reads best in.
 */
export const coreNodeDefinitions: readonly NodeDefinition[] = [
  noiseNode,
  ...generatorNodes,
  ...transformNodes,
  ...colorNodes,
  ...filterNodes,
  ...compositeNodes,
  ...temporalNodes,
  ...pointNodeDefinitions,
  nullNode,
  ...valueNodeDefinitions,
  analyzeNode,
];

/**
 * Everything a project can instantiate: the spike nodes plus the core catalogue.
 *
 * This is the list an application registry should be built from — `spikeNodeDefinitions`
 * alone is three nodes, which is a spike, not a tool. The composition root still imports
 * the spike list (it is outside this track's paths); switching it to this export is the
 * one change needed elsewhere to make the catalogue reachable from the UI.
 */
export const allNodeDefinitions: readonly NodeDefinition[] = [
  ...spikeNodeDefinitions,
  ...coreNodeDefinitions,
];
