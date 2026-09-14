import { document, edge, graph, node, settings } from "./builders.ts";
import { referenceChart } from "./native-video.ts";

/** Native Apple Vision recipe. Index 0 is a visible calibration source containing no
 * person, not a simulated detection. Select index 1 to request and segment a webcam.
 *
 * T1332b: the calibration source is the loopback examples' REFERENCE CHART rather than a
 * noise field — same reason, one step further. A calibration source is watched to find out
 * what the pipeline is doing to the picture, and noise answers none of those questions:
 * the chart's checker shows resampling, its ramp shows orientation and channel order, and
 * its marker shows that the graph is live. It is also what let this example clear §T521's
 * contrast floor, which the noise missed at 0.2976 of 0.30. */
const chart = referenceChart(-480);

export const nativePersonMaskDocument = document(
  "e73-native-person-mask",
  "E73 Native Person Mask",
  settings({ randomSeed: 73, workingFormat: "rgba8unorm-srgb" }),
  graph([
    ...chart.nodes,
    node("camera", "webcam", [-960, 140], {}, { label: "camera1" }),
    node("source", "switch", [-600, -200], { index: 0 }, { label: "source1" }),
    node("out", "output", [480, -200], {}, { label: "reference1" }),
    node("mask", "personMask", [-240, 140], {
      transport: "native", rateLimit: 0.1, invert: false,
    }, { label: "mask1", format: { mode: "fixed", format: "rgba16float" } }),
    node("key", "multiply", [120, 140], { opacity: 1 }, { label: "key1" }),
    node("resultOut", "output", [480, 140], {}, { label: "person1" }),
  ], [
    ...chart.edges,
    edge("calibration-source", ["signal", "out"], ["source", "inputs"], 0),
    edge("camera-source", ["camera", "out"], ["source", "inputs"], 1),
    edge("source-reference", ["source", "out"], ["out", "input"]),
    edge("source-mask", ["source", "out"], ["mask", "input"]),
    edge("source-key", ["source", "out"], ["key", "in1"]),
    edge("mask-key", ["mask", "out"], ["key", "in2"]),
    edge("key-result", ["key", "out"], ["resultOut", "input"]),
  ]),
);
