import { document, edge, graph, node, settings } from "./builders.ts";

/** Technical loopbacks: the local reference is not a substitute for received video.
 * Source discovery is deliberately left to the user's machine, never saved as a fake ID. */
function loopback(number: number, transport: "syphon" | "ndi" | "spout", title: string) {
  return document(
    `e${number}-${transport}-loopback`,
    `E${number} ${title} Loopback${transport === "spout" ? " Preparation" : ""}`,
    settings({ randomSeed: number, outputResolution: { width: 1920, height: 1080 }, workingFormat: "rgba8unorm-srgb" }),
    graph([
      node("signal", "noise", [-600, -200], {
        type: "perlin4d", seed: number, speed: 0.35, t4d: 0.37, mono: false,
      }, { label: "signal1" }),
      node("send", `${transport}Out`, [-240, -200], {
        name: `Loom E${number} ${title}`, enabled: transport !== "spout",
      }, { label: "send1" }),
      node("out", "output", [120, -200], {}, { label: "reference1" }),
      node("receive", `${transport}In`, [-240, 140], { source: "" }, { label: "receive1" }),
      node("returnOut", "output", [120, 140], {}, { label: "returned1" }),
    ], [
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
