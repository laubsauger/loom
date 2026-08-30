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
import { cacheNode } from "./cache.ts";
import { pointNodeDefinitions } from "./points.ts";
import { nullNode } from "./null-node.ts";
import { switchNode } from "./switch.ts";
import { valueNodeDefinitions } from "./values.ts";
import { analyzeNode } from "./analyze.ts";
import { mediaNodeDefinitions } from "./media.ts";
import { valueGraphNodeDefinitions } from "./value-graph-nodes.ts";
import { pointGeneratorDefinitions } from "./point-generators.ts";
import { renderInstancesNode } from "./render-instances.ts";
import { renderSurfaceNode } from "./render-surface.ts";
import { pointTopologyNode } from "./point-topology.ts";

export { solidNode } from "./solid.ts";
export { nullNode } from "./null-node.ts";
export { switchNode, resolveSwitchIndex } from "./switch.ts";
export { pointSetInfoFor } from "./points.ts";
export { lfoNode, constantNode, timerNode, lfoValue, valueNodeDefinitions } from "./values.ts";
export { analyzeNode, ANALYZE_RESULT_KEY } from "./analyze.ts";
export {
  pointGeneratorNode,
  pointGridNode,
  pointLineNode,
  pointCircleNode,
  pointSphereNode,
  pointTubeNode,
  pointTorusNode,
  pointGeneratorDefinitions,
} from "./point-generators.ts";
export { renderInstancesNode, INSTANCE_SHAPES } from "./render-instances.ts";
export { renderSurfaceNode } from "./render-surface.ts";
export { pointTopologyNode } from "./point-topology.ts";
export {
  movieFileInNode,
  webcamNode,
  textNode,
  mediaSourceIdFor,
  MEDIA_TEXTURE_KEY,
  mediaNodeDefinitions,
} from "./media.ts";
export {
  VALUE_PORT,
  mouseNode,
  valueMathNode,
  valueLimitNode,
  valueSlopeNode,
  valueTriggerNode,
  valueLagNode,
  valueFilterNode,
  valueGraphNodeDefinitions,
} from "./value-graph-nodes.ts";
export { customWgslNode } from "./custom-wgsl.ts";
export { outputNode } from "./output.ts";
export { isSinkNode, SINK_TAG } from "./sink.ts";
export { RGBA_TEXTURE, MAX_TEXTURE_INPUTS } from "./common-ports.ts";
export type { NodeCompileInputs } from "./compile-context.ts";
export { readCompileInputs, missingCompileResource } from "./compile-context.ts";

export { noiseNode } from "./noise.ts";
export {
  rampNode,
  uvNode,
  checkerNode,
  circleNode,
  rectangleNode,
  generatorNodes,
} from "./generators.ts";
export {
  transformNode,
  flipNode,
  mirrorNode,
  cropNode,
  tileNode,
  transformNodes,
} from "./transforms.ts";
export {
  levelNode,
  hsvNode,
  thresholdNode,
  limitNode,
  lookupNode,
  reorderNode,
  REORDER_SOURCE_OPTIONS,
  premultiplyNode,
  colorNodes,
} from "./color.ts";
export {
  blurNode,
  edgeNode,
  convolveNode,
  displaceNode,
  remapNode,
  slopeNode,
  filterNodes,
} from "./filters.ts";
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
export { cacheNode, CACHE_RING_KEY } from "./cache.ts";
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
  cacheNode,
  ...pointNodeDefinitions,
  nullNode,
  switchNode,
  ...valueNodeDefinitions,
  analyzeNode,
  ...mediaNodeDefinitions,
  ...valueGraphNodeDefinitions,
  ...pointGeneratorDefinitions,
  renderInstancesNode,
  renderSurfaceNode,
  pointTopologyNode,
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
