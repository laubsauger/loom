import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { solidNode } from "./solid.ts";
import { customWgslMultiNode, customWgslNode } from "./custom-wgsl.ts";
import { outputNode } from "./output.ts";
import { noiseNode } from "./noise.ts";
import { generatorNodes } from "./generators.ts";
import { transformNodes } from "./transforms.ts";
import { fitNodes } from "./fit.ts";
import { cornerPinNode } from "./corner-pin.ts";
import { gridWarpNode } from "./grid-warp.ts";
import { colorNodes } from "./color.ts";
import { filterNodes } from "./filters.ts";
import { opticsNodes } from "./optics.ts";
import { filmNodes } from "./film.ts";
import { cameraBlurNode } from "./camera-blur.ts";
import { echoNode } from "./echo.ts";
import { compositeNodes } from "./composite.ts";
import { layerNode } from "./layer.ts";
import { temporalNodes } from "./feedback.ts";
import { cacheNode } from "./cache.ts";
import { pointNodeDefinitions } from "./points.ts";
import { nullNodes } from "./null-node.ts";
import { componentIoDefinitions } from "./component-io.ts";
import { switchNode } from "./switch.ts";
import { valueNodeDefinitions } from "./values.ts";
import { analyzeNode } from "./analyze.ts";
import { depthNode } from "./depth.ts";
import { pointsFromTextureNode } from "./points-from-texture.ts";
import { poseNode } from "./pose.ts";
import { matteNode } from "./matte.ts";
import { personMaskNode } from "./person-mask.ts";
import { mediaNodeDefinitions } from "./media.ts";
import { floatMapInNode } from "./float-map-in.ts";
import { screenInNode } from "./screen-in.ts";
export { screenInNode, SCREEN_IN_TYPE } from "./screen-in.ts";
import { syphonInNode } from "./syphon-in.ts";
import { ndiInNode } from "./ndi-in.ts";
import { syphonOutNode } from "./syphon-out.ts";
import { windowOutNode } from "./window-out.ts";
import { ndiOutNode } from "./ndi-out.ts";
import { whipOutNode } from "./whip-out.ts";
import { spoutInNode, spoutOutNode } from "./spout.ts";
export { spoutInNode, spoutOutNode, SPOUT_IN_TYPE, SPOUT_OUT_TYPE } from "./spout.ts";
export { ndiOutNode, NDI_OUT_TYPE } from "./ndi-out.ts";
export { whipOutNode, WHIP_OUT_TYPE } from "./whip-out.ts";
export { syphonOutNode, SYPHON_OUT_TYPE } from "./syphon-out.ts";
export { windowOutNode, WINDOW_OUT_TYPE } from "./window-out.ts";
export { syphonInNode, SYPHON_IN_TYPE } from "./syphon-in.ts";
export { ndiInNode, NDI_IN_TYPE } from "./ndi-in.ts";
import { valueGraphNodeDefinitions } from "./value-graph-nodes.ts";
import { valueStructureNodeDefinitions } from "./value-structure-nodes.ts";
import { controlNodeDefinitions } from "./controls.ts";
import { presetsNode } from "./presets.ts";
import { cueListNode } from "./cue-list.ts";
import { automationNode } from "./automation.ts";
import { tempoNode } from "./tempo.ts";
export { audioFileInNode, audioInNode, audioPatternNode } from "./audio.ts";
export { cameraNode, geometryNode, lightNode, renderNode, sceneNodeDefinitions } from "./scene.ts";
import { audioFileInNode, audioInNode, audioPatternNode } from "./audio.ts";
import { audioChordNode, audioChromaNode, audioNotesNode, tonePatternNode } from "./audio-tonal.ts";
export { audioChordNode, audioChromaNode, audioNotesNode, tonePatternNode } from "./audio-tonal.ts";
import { harmonyNode, noteFieldNode } from "./harmony.ts";
export { harmonyNode, noteFieldNode } from "./harmony.ts";
import { sceneNodeDefinitions } from "./scene.ts";
import { pointGeneratorDefinitions } from "./point-generators.ts";
import { renderInstancesNode } from "./render-instances.ts";
import { renderSurfaceNode } from "./render-surface.ts";
import { pointTopologyNode } from "./point-topology.ts";
import { meshFileInNode } from "./mesh-file-in.ts";
import { materialWgslNode } from "./material-wgsl.ts";
import { pointGatherNode } from "./point-gather.ts";
import { pointProximityNode } from "./point-proximity.ts";
import { pointRangeNode } from "./point-range.ts";
import { pointTransformNode } from "./point-transform.ts";
import { pointCurveNode } from "./point-curve.ts";
import { pointCurveFramesNode } from "./point-curve-frames.ts";
import { pointResampleNode } from "./point-resample.ts";
import { pointSweepNode } from "./point-sweep.ts";
import { pointRopeNode } from "./point-rope.ts";
import { laserPathNode } from "./laser-path.ts";
import { laserOutNode } from "./laser-out.ts";
import { pointKernelAdvancedNode } from "./point-kernel-advanced.ts";
import { slitScanNode } from "./slit-scan.ts";
import { midiInNode } from "./midi.ts";
import { midiNotesNode } from "./midi-notes.ts";
export { midiNotesNode } from "./midi-notes.ts";
import { oscInNode, oscOutNode } from "./osc.ts";
import { annotateNode } from "./annotate.ts";

export { solidNode } from "./solid.ts";
export { nullNode, nullNodes, pointNullNode, valueNullNode } from "./null-node.ts";
export {
  boundaryTypeFor,
  componentInput,
  componentInputPoints,
  componentIoDefinitions,
  componentOutput,
  componentOutputPoints,
  isComponentBoundary,
  isComponentInputBoundary,
  isComponentOutputBoundary,
} from "./component-io.ts";
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
  pointBoxNode,
  pointGeneratorDefinitions,
} from "./point-generators.ts";
export { renderInstancesNode, INSTANCE_SHAPES } from "./render-instances.ts";
export { renderSurfaceNode } from "./render-surface.ts";
export { pointTopologyNode } from "./point-topology.ts";
export { meshFileInNode } from "./mesh-file-in.ts";
export { materialWgslNode } from "./material-wgsl.ts";
export { pointGatherNode } from "./point-gather.ts";
export { pointProximityNode } from "./point-proximity.ts";
export { pointRangeNode } from "./point-range.ts";
export { pointTransformNode } from "./point-transform.ts";
export { pointCurveNode, authoredCurve, curveAttributes } from "./point-curve.ts";
export { pointCurveFramesNode, curveFramesAttributes } from "./point-curve-frames.ts";
export { pointResampleNode, resampleAttributes } from "./point-resample.ts";
export { pointSweepNode, sweepAttributes } from "./point-sweep.ts";
export { pointRopeNode, ropeAttributes, ROPE_KEPT_KEY, ROPE_SOLVE_KEY } from "./point-rope.ts";
export { laserPathNode } from "./laser-path.ts";
export { laserOutNode, LASER_OUT_TYPE } from "./laser-out.ts";
export { pointKernelAdvancedNode, liveCountBufferId } from "./point-kernel-advanced.ts";
export { slitScanNode } from "./slit-scan.ts";
export { midiInNode } from "./midi.ts";
export { presetsNode } from "./presets.ts";
export { cueListNode } from "./cue-list.ts";
export { tempoNode } from "./tempo.ts";
export { automationNode, AUTOMATION_NODE_TYPE } from "./automation.ts";
export { oscInNode, oscOutNode } from "./osc.ts";
export {
  annotateNode,
  annotationColorOf,
  ANNOTATE_TYPE,
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
} from "./annotate.ts";
export {
  movieFileInNode,
  webcamNode,
  textNode,
  mediaSourceIdFor,
  MEDIA_TEXTURE_KEY,
  mediaNodeDefinitions,
  PHONE_CAMERA_DEVICE_PREFIX,
  phoneCameraName,
} from "./media.ts";
export {
  VALUE_PORT,
  mouseNode,
  valueMathNode,
  valueLimitNode,
  valueSelectNode,
  valueSlopeNode,
  valueTriggerNode,
  valueLagNode,
  valueFilterNode,
  valueSwitchNode,
  valueNormalizeNode,
  valueSpeedNode,
  valueRangeNode,
  valueTailNode,
  valueBeatNode,
  valueGraphNodeDefinitions,
} from "./value-graph-nodes.ts";
export { customWgslMultiNode, customWgslNode } from "./custom-wgsl.ts";
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
export { cornerPinNode } from "./corner-pin.ts";
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
export { streakNode, haloNode, lensNode, flareNode, opticsNodes } from "./optics.ts";
export { filmGradeNode, crtNode, crtTubeNode, filmNodes } from "./film.ts";
export { cameraBlurNode } from "./camera-blur.ts";
export { echoNode, ECHO_RING_KEY } from "./echo.ts";
export {
  depthNode,
  depthDescriptorFor,
  depthModelChoiceFor,
  depthPro2BoxKeyFor,
  depthProvidersFor,
  depthSettingsFor,
  isMetricDepthModel,
  DEPTH_INPUT_KEY,
  DEPTH_INPUT_SIDE,
  DEPTH_RESULT_KEY,
} from "./depth.ts";
export type { DepthNodeSettings } from "./depth.ts";
export { pointsFromTextureNode } from "./points-from-texture.ts";
export { poseNode, POSE_INPUT_KEY, POSE_RESULT_KEY } from "./pose.ts";
export {
  personMaskNode,
  PERSON_MASK_INPUT_KEY,
  PERSON_MASK_RESULT_KEY,
  PERSON_MASK_INPUT_SIDE,
} from "./person-mask.ts";
export {
  matteNode,
  matteDescriptorFor,
  matteInputSideFor,
  matteRatioFor,
  matteSmoothingFor,
  mattePostFor,
  MATTE_INPUT_KEY,
  MATTE_RESULT_KEY,
} from "./matte.ts";
export {
  DEFAULT_POINT_ATTRIBUTES,
  pointKernelNode,
  pointNodeDefinitions,
  pointBufferId,
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
  // T1824b/T1825b: TD's Fit and Resolution TOPs, sized by the Common page.
  ...fitNodes,
  // T1491b: the 2D projection-mapping warp, the stack's mapping stage.
  cornerPinNode,
  // T1509b: the grid warp, for curved and irregular surfaces.
  gridWarpNode,
  ...colorNodes,
  ...filterNodes,
  // T1402b: the look-building filters promoted from the On Nothing project's passes.
  ...opticsNodes,
  ...filmNodes,
  // T1421b: the camera path's motion blur.
  cameraBlurNode,
  ...compositeNodes,
  // T1498b: the performance stack's layer — bypass is off, opacity the fade.
  layerNode,
  ...temporalNodes,
  cacheNode,
  echoNode,
  ...pointNodeDefinitions,
  // T1822b: a Null per wired family — texture, points, value.
  ...nullNodes,
  ...componentIoDefinitions,
  switchNode,
  ...valueNodeDefinitions,
  analyzeNode,
  depthNode,
  poseNode,
  matteNode,
  personMaskNode,
  ...mediaNodeDefinitions,
  floatMapInNode,
  screenInNode,
  syphonInNode,
  ndiInNode,
  syphonOutNode,
  windowOutNode,
  ndiOutNode,
  whipOutNode,
  spoutInNode,
  spoutOutNode,
  ...valueGraphNodeDefinitions,
  ...valueStructureNodeDefinitions,
  ...controlNodeDefinitions,
  // T1496b: the preset bank — Store/Recall a set of nodes' parameters as one step.
  presetsNode,
  // T1500b: the cue list — GO / BACK through an ordered list of preset recalls.
  cueListNode,
  // T1787b: the project tempo as channels, Tap and Resync as pulses.
  tempoNode,
  // VN61: keyframed lanes over the playhead, each published as a channel.
  automationNode,
  audioInNode,
  audioFileInNode,
  audioPatternNode,
  // T1751b: the tonal projections of the same capture.
  audioChromaNode,
  audioChordNode,
  audioNotesNode,
  tonePatternNode,
  harmonyNode,
  noteFieldNode,
  // T942: the controller as channels — the value family's fourth input source, after
  // Mouse, the trio and the audio pair. Page-native, no helper, no bridge.
  midiInNode,
  // T1762b: the keyboard as voices, beside the learned-controls node.
  midiNotesNode,
  // T942 tier 3: OSC as channels, and OSC back OUT. Both need the local helper — a page
  // cannot speak UDP — and both degrade to their declared rests with none running.
  oscInNode,
  oscOutNode,
  ...sceneNodeDefinitions,
  materialWgslNode,
  ...pointGeneratorDefinitions,
  pointsFromTextureNode,
  renderInstancesNode,
  renderSurfaceNode,
  pointTopologyNode,
  meshFileInNode,
  pointGatherNode,
  pointProximityNode,
  pointRangeNode,
  pointTransformNode,
  // T1586b: the curve family — curves are strips of a pointset.
  pointCurveNode,
  pointCurveFramesNode,
  pointResampleNode,
  // T1587b: a profile swept along a strip into a grid the Render lights.
  pointSweepNode,
  // T1585b: strips simulated as ropes that keep their length.
  pointRopeNode,
  laserPathNode,
  laserOutNode,
  pointKernelAdvancedNode,
  slitScanNode,
  // T1262: the annotation box — portless, passless, pruned by construction. Last so the
  // library reads it after the working nodes.
  annotateNode,
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
  customWgslMultiNode,
  ...coreNodeDefinitions,
];
