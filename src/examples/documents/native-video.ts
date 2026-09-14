import type { GraphEdge, GraphNode } from "@domain/types/graph.ts";
import { document, drivenSlot, edge, graph, node, settings } from "./builders.ts";

/**
 * THE REFERENCE CHART (T1332b) — what these examples send, and it is a chart rather than a
 * field of noise for a reason that is about the example rather than about a gate.
 *
 * All three loopbacks and the person-mask calibration used to send one `perlin4d` node on
 * its defaults. That failed §T521's contrast floor — 0.2646 to 0.2976 of luma span against
 * 0.30 — and turning the noise's gain up would have satisfied the number without satisfying
 * the complaint, which is *"too little to read as a picture"*. A loopback example exists so
 * that somebody can see a frame go out over Syphon, NDI or Spout and come back: put grey
 * mush on both sides and the two panes tell you NOTHING about whether the round trip kept
 * the orientation, the channel order, the scale or the timing. Every element here is one of
 * those questions:
 *
 *   the CHECKER  — full black-to-white contrast, and a scale reference: a transport that
 *                  resamples shows it as moire on these edges before anything else.
 *   the RAMP     — direction and colour. A mirrored frame or a swapped channel order is
 *                  obvious against a sweep and invisible against noise.
 *   the MARKER   — a dot crossing the frame on an LFO, so the picture is alive and a
 *                  DELAYED return reads as a displaced dot rather than as "looks the same".
 *
 * The multiply is what keeps the contrast: the checker's black squares stay black under any
 * tint, so the chart spans the full range wherever the ramp is bright.
 */
function referenceChart(dx = 0): { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] } {
  /* The offset exists because E73 has its own left-hand column: §V389 wants a readable
     gutter between every pair of nodes, and a chart pasted at one fixed origin lands on
     that example's Switch. */
  const at = (x: number, y: number): readonly [number, number] => [x + dx, y];
  return {
    nodes: [
      node("bars", "checker", at(-1320, -320), {
        size: [8, 5], offset: [0, 0], color1: [0, 0, 0, 1], color2: [1, 1, 1, 1],
      }, { label: "bars1" }),
      /* Four stops rather than two: a two-stop sweep is monotone in luma, so a 180-degree
         rotation looks like a slightly different gradient. Cyan, amber and magenta in that
         order cannot be confused with their own reverse. */
      node("tint", "ramp", at(-1320, -80), {
        type: "horizontal", interp: "linear", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.1, 0.85, 1, 1] },
          { position: 0.38, color: [1, 0.78, 0.15, 1] },
          { position: 0.72, color: [1, 0.2, 0.55, 1] },
          { position: 1, color: [1, 1, 1, 1] },
        ],
      }, { label: "tint1" }),
      node("chart", "multiply", at(-960, -200), { opacity: 1 }, { label: "chart1" }),
      /* The marker is the only moving thing, and it is deliberately small: a loopback's
         picture should be comparable frame to frame, which a whole-frame animation is not. */
      node("mark", "circle", at(-1320, 160), {
        mode: "fill", center: [0.5, 0.5], radius: [0.07, 0.07], softness: 0.01,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, { label: "mark1", parameters: { "center.x": drivenSlot("sweep1", 0.5) } }),
      /* §V914's shape: the retained 0.5 is a sane picture on its own, so the chart is
         correct in any host that never runs the value graph. */
      node("sweep", "lfo", at(-1320, 400), {
        shape: "triangle", frequency: 0.09, amplitude: 0.4, offset: 0.5, phase: 0,
      }, { label: "sweep1" }),
      node("signal", "over", at(-600, -200), { opacity: 1 }, { label: "signal1" }),
    ],
    edges: [
      edge("tint-chart", ["tint", "out"], ["chart", "in1"]),
      edge("bars-chart", ["bars", "out"], ["chart", "in2"]),
      edge("mark-signal", ["mark", "out"], ["signal", "in1"]),
      edge("chart-signal", ["chart", "out"], ["signal", "in2"]),
    ],
  };
}

/** Technical loopbacks: the local reference is not a substitute for received video.
 * Source discovery is deliberately left to the user's machine, never saved as a fake ID. */
function loopback(number: number, transport: "syphon" | "ndi" | "spout", title: string) {
  const chart = referenceChart();
  return document(
    `e${number}-${transport}-loopback`,
    `E${number} ${title} Loopback${transport === "spout" ? " Preparation" : ""}`,
    settings({ randomSeed: number, outputResolution: { width: 1920, height: 1080 }, workingFormat: "rgba8unorm-srgb" }),
    graph([
      ...chart.nodes,
      node("send", `${transport}Out`, [-240, -200], {
        name: `Loom E${number} ${title}`, enabled: transport !== "spout",
      }, { label: "send1" }),
      node("out", "output", [120, -200], {}, { label: "reference1" }),
      node("receive", `${transport}In`, [-240, 140], { source: "" }, { label: "receive1" }),
      node("returnOut", "output", [120, 140], {}, { label: "returned1" }),
    ], [
      ...chart.edges,
      edge("signal-send", ["signal", "out"], ["send", "input"]),
      edge("signal-reference", ["signal", "out"], ["out", "input"]),
      edge("receive-return", ["receive", "out"], ["returnOut", "input"]),
    ]),
  );
}

export const syphonLoopbackDocument = loopback(71, "syphon", "Syphon");
export const ndiLoopbackDocument = loopback(72, "ndi", "NDI");
/** Windows adapter is not implemented; this graph teaches contracts, not live sharing. */
export const spoutLoopbackDocument = loopback(74, "spout", "Spout");

/** E73's calibration source is the same chart: a chart with no person in it is exactly what
 * "a visible calibration source containing no person" means. */
export { referenceChart };
