import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { compileMedia } from "./media.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";

export const SYPHON_IN_TYPE = "syphonIn";
export const syphonInNode: NodeDefinition = {
  type: SYPHON_IN_TYPE, version: 1, title: "Syphon In", category: "input",
  description: "Live SDR video from a macOS Syphon publisher through the desktop app. Adopts source resolution. Select the exact source in the inspector; restarting a publisher requires re-selection. Disconnection holds the last image and reports it as stale. Live input is not deterministic replay.",
  tags: ["syphon", "native", "video", "live"],
  inputs: [], outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    source: { type: "string", label: "Source", default: "",
      description: "Exact Syphon discovery UUID, selected in the inspector. No automatic source substitution." },
  },
  // T1340b: the declaration of record. The example list and the node's own warning
  // both read THIS; neither carries a type switch of its own.
  requires: ["desktop", "macos"],
  resolutionPolicy: { kind: "project" }, compile: compileMedia,
};
